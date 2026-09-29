/*
 * SES bounce + complaint feedback into Listmonk.
 *
 * Every Hatchkit project sends through one Listmonk over SES SMTP, and
 * they share one feedback path:
 *
 *   SES identity ──Bounce/Complaint──▶ SNS topic `ses-feedback-listmonk`
 *                                        │ HTTPS subscription
 *                                        ▼
 *                     <listmonk>/webhooks/service/ses ──▶ Listmonk blocklist
 *
 * Four pieces, each ensured idempotently (read first, write only what is
 * missing, so a second run makes no writes):
 *
 *   1. Listmonk settings `bounce.enabled`, `bounce.webhooks_enabled` and
 *      `bounce.ses_enabled`. First, because Listmonk confirms the SNS
 *      subscription by itself only once `bounce.ses_enabled` is on. Each
 *      key goes through the per-key `PUT /api/settings/<key>`: a full
 *      `PUT /api/settings` round-trips the masked SMTP passwords. Every
 *      PUT reloads Listmonk, so a key that is already true is not PUT.
 *   2. The SNS topic (CreateTopic is idempotent by name) and its
 *      subscription to the Listmonk SES webhook.
 *   3. The identity's Bounce + Complaint notification topics. That is
 *      the SES v1 API (`SetIdentityNotificationTopic`); SESv2 routes
 *      notifications through configuration sets instead. A topic someone
 *      else set on the identity is reported and left alone.
 *   4. Account-level suppression of BOUNCE + COMPLAINT addresses.
 *
 * The topic, its subscription, the account suppression and the Listmonk
 * settings are SHARED by every project. Undo therefore only ever clears
 * the notification topics of one identity (`clearSesFeedbackTopics`),
 * and only the types that still point at the recorded topic.
 *
 * AWS and Listmonk sit behind two small port interfaces so the test
 * suite can drive every path with in-memory stubs. A missing IAM
 * permission degrades to a warning that names the action. When the
 * missing action is `ses:SetIdentityNotificationTopic`, the result also
 * carries the exact `aws ses set-identity-notification-topic` commands,
 * so the operator can set the topics with a profile that may.
 *
 * `migrate-domain` also uses `copyIdentityNotificationTopics`: the new
 * identity gets the old identity's topics, whatever they are, before
 * `ensureSesFeedback` fills in the types the old one did not route.
 *
 * Basic auth on the SNS endpoint: with `webhookCredentials`, the
 * subscription URL carries a user and password
 * (`https://<user>:<password>@<host>/webhooks/service/ses`), and a
 * reverse proxy in front of Listmonk can require them on
 * `/webhooks/service` (`hatchkit ses webhook-auth` prints the Traefik
 * labels). Without such a proxy Listmonk takes the request as before, so
 * the endpoint works either way. Once the credentialed
 * subscription is confirmed, an older subscription of the same webhook
 * is removed, so Listmonk does not get each notification twice. Output
 * never shows the password: `webhookUrl` is always redacted.
 */

import { randomBytes } from "node:crypto";
import {
  GetIdentityNotificationAttributesCommand,
  SESClient,
  SetIdentityNotificationTopicCommand,
} from "@aws-sdk/client-ses";
import {
  GetAccountCommand,
  ListEmailIdentitiesCommand,
  PutAccountSuppressionAttributesCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import {
  CreateTopicCommand,
  ListSubscriptionsByTopicCommand,
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
} from "@aws-sdk/client-sns";
import bcrypt from "bcryptjs";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";
import {
  type ListmonkAuth,
  getListmonkSettings,
  normalizeListmonkUrl,
  putListmonkSetting,
  waitForListmonk,
} from "./listmonk.js";
import type { SesAuth } from "./ses.js";

/** Name of the shared SNS topic. Not a config field: SES provider config
 *  holds only the region, and every project must land on the same topic
 *  for the shared subscription to cover it. */
export const SES_FEEDBACK_TOPIC_NAME = "ses-feedback-listmonk";

/** The Listmonk settings that must be true for SES bounces to count. */
export const LISTMONK_BOUNCE_SETTING_KEYS = [
  "bounce.enabled",
  "bounce.webhooks_enabled",
  "bounce.ses_enabled",
] as const;

/** The account-level suppression reasons Hatchkit requires. */
export const SES_SUPPRESSED_REASONS = ["BOUNCE", "COMPLAINT"] as const;

export type SesFeedbackType = "Bounce" | "Complaint";
export const SES_FEEDBACK_TYPES: readonly SesFeedbackType[] = ["Bounce", "Complaint"];

/** Every IAM action this module calls, for docs and hints. */
export const SES_FEEDBACK_IAM_ACTIONS = [
  "ses:SetIdentityNotificationTopic",
  "ses:GetIdentityNotificationAttributes",
  "ses:PutAccountSuppressionAttributes",
  "ses:GetAccount",
  "sns:CreateTopic",
  "sns:Subscribe",
  "sns:ListSubscriptionsByTopic",
  "sns:Unsubscribe",
] as const;

/** Basic-auth credentials for the SNS endpoint. Both are hex, so
 *  nothing needs escaping in a URL, an htpasswd entry or a label. */
export interface WebhookCredentials {
  user: string;
  password: string;
}

export function generateWebhookCredentials(): WebhookCredentials {
  return { user: randomBytes(12).toString("hex"), password: randomBytes(32).toString("hex") };
}

/** The stored credentials, or null when this machine has none yet.
 *  Read-only, for doctor. */
export async function loadWebhookCredentials(): Promise<WebhookCredentials | null> {
  const user = (await getSecret(SECRET_KEYS.sesFeedbackWebhookUser))?.trim();
  const password = (await getSecret(SECRET_KEYS.sesFeedbackWebhookPassword))?.trim();
  return user && password ? { user, password } : null;
}

/** The stored credentials, generated and stored on first use. They are
 *  never rotated here: the proxy's hash must match what SNS sends. */
export async function ensureWebhookCredentials(): Promise<{
  credentials: WebhookCredentials;
  created: boolean;
}> {
  const existing = await loadWebhookCredentials();
  if (existing) return { credentials: existing, created: false };
  const credentials = generateWebhookCredentials();
  await setSecret(SECRET_KEYS.sesFeedbackWebhookUser, credentials.user);
  await setSecret(SECRET_KEYS.sesFeedbackWebhookPassword, credentials.password);
  return { credentials, created: true };
}

/** Listmonk's SES webhook for a stored Listmonk URL, with the basic-auth
 *  credentials in it when given. The result then holds the password:
 *  pass it only to SNS, and print `redactEndpoint` of it. */
export function listmonkSesWebhookUrl(
  listmonkUrl: string,
  credentials?: WebhookCredentials | null,
): string {
  const url = `${normalizeListmonkUrl(listmonkUrl)}/webhooks/service/ses`;
  if (!credentials) return url;
  return url.replace(/^(https?:\/\/)/, `$1${credentials.user}:${credentials.password}@`);
}

const USERINFO = /^(https?:\/\/)([^@/]*)@/;

/** The endpoint with its password replaced by `****`. */
export function redactEndpoint(endpoint: string): string {
  return endpoint.replace(USERINFO, (_m, scheme: string, info: string) => {
    const colon = info.indexOf(":");
    return colon < 0 ? `${scheme}${info}@` : `${scheme}${info.slice(0, colon)}:****@`;
  });
}

/** The endpoint without user or password. */
function stripUserinfo(endpoint: string): string {
  return endpoint.replace(USERINFO, "$1");
}

/** Whether an endpoint as SNS lists it is `endpoint`. SNS may list the
 *  password masked, so the password is not compared. The user is, and it
 *  is random per install. */
export function sameEndpoint(listed: string, endpoint: string): boolean {
  return redactEndpoint(listed) === redactEndpoint(endpoint);
}

/** Confirmed subscriptions of the same webhook under other credentials
 *  (or none), such as the plain one from before basic auth. SNS delivers
 *  to each, so Listmonk would count every notification twice. A pending
 *  subscription has no ARN to remove and expires after three days. */
export function supersededSubscriptions(
  subs: SnsSubscription[],
  endpoint: string,
): SnsSubscription[] {
  const webhook = stripUserinfo(endpoint);
  return subs.filter(
    (s) =>
      s.subscriptionArn.startsWith("arn:") &&
      stripUserinfo(s.endpoint) === webhook &&
      !sameEndpoint(s.endpoint, endpoint),
  );
}

/** The AWS CLI command that removes one subscription. The region is
 *  the one in the ARN (`arn:aws:sns:<region>:…`). */
export function unsubscribeCommand(subscriptionArn: string): string {
  const region = subscriptionArn.split(":")[3];
  return [
    `aws sns unsubscribe --subscription-arn ${subscriptionArn}`,
    ...(region ? [`--region ${region}`] : []),
  ].join(" ");
}

/** SNS protocol for an endpoint URL: `https` unless the URL is plain http. */
export function snsProtocolFor(endpoint: string): "http" | "https" {
  return endpoint.startsWith("http://") ? "http" : "https";
}

/** The topic name in an SNS topic ARN (`arn:aws:sns:<region>:<acct>:<name>`). */
export function topicNameFromArn(arn: string): string {
  return arn.slice(arn.lastIndexOf(":") + 1);
}

// ────────────────────────────────────────────────────────────────────────────
// Ports
// ────────────────────────────────────────────────────────────────────────────

export interface SnsSubscription {
  /** `PendingConfirmation` until the endpoint confirms, then an ARN. */
  subscriptionArn: string;
  protocol: string;
  endpoint: string;
}

export interface IdentityNotificationTopics {
  bounceTopic: string | null;
  complaintTopic: string | null;
}

export interface SesFeedbackAws {
  /** sns:CreateTopic. Idempotent by name; returns the ARN. */
  createTopic(name: string): Promise<string>;
  /** sns:ListSubscriptionsByTopic, all pages. Throws `NotFound` when the
   *  topic doesn't exist. */
  listSubscriptions(topicArn: string): Promise<SnsSubscription[]>;
  /** sns:Subscribe. */
  subscribe(topicArn: string, protocol: "http" | "https", endpoint: string): Promise<void>;
  /** sns:Unsubscribe. */
  unsubscribe(subscriptionArn: string): Promise<void>;
  /** ses:GetIdentityNotificationAttributes. Identities SES doesn't know
   *  are absent from the result. */
  getNotificationTopics(identities: string[]): Promise<Map<string, IdentityNotificationTopics>>;
  /** ses:SetIdentityNotificationTopic. `null` clears the topic. */
  setNotificationTopic(
    identity: string,
    type: SesFeedbackType,
    topicArn: string | null,
  ): Promise<void>;
  /** ses:GetAccount (SESv2) → SuppressionAttributes.SuppressedReasons. */
  getSuppressedReasons(): Promise<string[]>;
  /** ses:PutAccountSuppressionAttributes (SESv2). */
  putSuppressedReasons(reasons: string[]): Promise<void>;
  /** ses:ListEmailIdentities (SESv2), only those SES has verified. */
  listVerifiedIdentities(): Promise<string[]>;
}

export interface SesFeedbackListmonk {
  getSettings(): Promise<Record<string, unknown>>;
  /** Write one key. Listmonk reloads after it; the adapter waits for it
   *  to answer again before returning. */
  putSetting(key: string, value: unknown): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

/** True for an AWS error that means the caller's IAM policy lacks the
 *  action. SES says `AccessDenied(Exception)`, SNS `AuthorizationError`. */
export function isAccessDenied(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  if (
    /^(AccessDenied|AccessDeniedException|AuthorizationError|AuthorizationErrorException)$/.test(
      name,
    )
  ) {
    return true;
  }
  return /not authorized to perform/i.test((err as Error)?.message ?? "");
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return name === "NotFound" || name === "NotFoundException";
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0];
}

/** One-line reason for a failed call, naming the IAM action when the
 *  error is a permission gap. */
export function describeFeedbackError(err: unknown, action: string): string {
  if (isAccessDenied(err)) return `missing IAM permission ${action}`;
  return `${action} failed: ${firstLine(err)}`;
}

/** A notification topic a run meant to set but could not, because the
 *  IAM user lacks `ses:SetIdentityNotificationTopic` (or could not read
 *  the identity to see what was set). */
export interface ManualNotificationTopic {
  identity: string;
  type: SesFeedbackType;
  topicArn: string;
}

/** The AWS CLI command that sets one notification topic. */
export function setNotificationTopicCommand(t: ManualNotificationTopic, region?: string): string {
  return [
    "aws ses set-identity-notification-topic",
    `--identity ${t.identity}`,
    `--notification-type ${t.type}`,
    `--sns-topic ${t.topicArn}`,
    ...(region ? [`--region ${region}`] : []),
  ].join(" ");
}

/** The AWS CLI command that reads identities' notification topics. */
export function getNotificationAttributesCommand(identities: string[], region?: string): string {
  return [
    "aws ses get-identity-notification-attributes",
    `--identities ${identities.join(" ")}`,
    ...(region ? [`--region ${region}`] : []),
  ].join(" ");
}

/** Hint lines for a permission gap. */
export function feedbackIamHint(): string[] {
  return [
    "The SES IAM user needs these actions for bounce feedback:",
    `  ${SES_FEEDBACK_IAM_ACTIONS.join(", ")}`,
    "Add them to its policy in the IAM console, then re-run.",
  ];
}

function listmonkSettingsError(err: unknown): string {
  const msg = firstLine(err);
  if (/HTTP 403|permission denied/i.test(msg)) {
    return "Listmonk API user lacks `Settings: All` — widen its role in Listmonk → Admin → Users";
  }
  if (/HTTP (404|405)/.test(msg)) {
    return "Listmonk has no per-key settings endpoint (needs v6+) — enable Settings → Bounces → SES by hand";
  }
  return `Listmonk settings: ${msg}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Ensure steps
// ────────────────────────────────────────────────────────────────────────────

/** The bounce settings that are not `true` yet. */
export function listmonkBounceSettingsOff(settings: Record<string, unknown>): string[] {
  return LISTMONK_BOUNCE_SETTING_KEYS.filter((k) => settings[k] !== true);
}

/** PUT each bounce key that isn't `true`. Returns the keys written. */
export async function ensureListmonkBounceSettings(
  listmonk: SesFeedbackListmonk,
): Promise<string[]> {
  const off = listmonkBounceSettingsOff(await listmonk.getSettings());
  for (const key of off) await listmonk.putSetting(key, true);
  return off;
}

/** The required suppression reasons missing from `current`. */
export function missingSuppressedReasons(current: string[]): string[] {
  return SES_SUPPRESSED_REASONS.filter((r) => !current.includes(r));
}

/** Add BOUNCE + COMPLAINT to the account suppression list, keeping any
 *  reason already there. Returns the reasons added. */
export async function ensureAccountSuppression(aws: SesFeedbackAws): Promise<string[]> {
  const current = await aws.getSuppressedReasons();
  const missing = missingSuppressedReasons(current);
  if (missing.length > 0) await aws.putSuppressedReasons([...current, ...missing]);
  return missing;
}

export type SubscriptionState = "confirmed" | "pending" | "missing";

/** State of the subscription for `endpoint` on a topic. */
export function subscriptionState(subs: SnsSubscription[], endpoint: string): SubscriptionState {
  const mine = subs.filter((s) => sameEndpoint(s.endpoint, endpoint));
  if (mine.some((s) => s.subscriptionArn.startsWith("arn:"))) return "confirmed";
  return mine.length > 0 ? "pending" : "missing";
}

/**
 * Make sure `endpoint` is subscribed to the topic. A confirmed
 * subscription is left alone. A missing one is created. A pending one is
 * subscribed again, which makes SNS resend the confirmation request (the
 * first may have arrived before `bounce.ses_enabled` was on). A topic
 * that was deleted is created again under its name first; SNS gives it
 * the same ARN, so identities that point at it start working again.
 * Then polls for Listmonk's confirmation up to `confirmTimeoutMs`.
 */
export async function ensureFeedbackSubscription(
  aws: SesFeedbackAws,
  topicArn: string,
  endpoint: string,
  opts: { confirmTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<{
  state: SubscriptionState;
  subscribed: boolean;
  topicArn: string;
  /** The topic's subscriptions as last listed. */
  subscriptions: SnsSubscription[];
}> {
  let arn = topicArn;
  let subs: SnsSubscription[];
  try {
    subs = await aws.listSubscriptions(arn);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    arn = await aws.createTopic(topicNameFromArn(arn));
    subs = [];
  }
  let state = subscriptionState(subs, endpoint);
  if (state === "confirmed") {
    return { state, subscribed: false, topicArn: arn, subscriptions: subs };
  }
  await aws.subscribe(arn, snsProtocolFor(endpoint), endpoint);
  const deadline = Date.now() + (opts.confirmTimeoutMs ?? 20_000);
  for (;;) {
    subs = await aws.listSubscriptions(arn);
    state = subscriptionState(subs, endpoint);
    if (state === "confirmed" || Date.now() >= deadline) break;
    await sleep(opts.pollIntervalMs ?? 2_000);
  }
  return {
    state: state === "missing" ? "pending" : state,
    subscribed: true,
    topicArn: arn,
    subscriptions: subs,
  };
}

/** Remove superseded subscriptions, one at a time. Stops at the first
 *  failure; what is left comes back in `left` with the error. Call only
 *  once the replacement is confirmed, or Listmonk gets nothing. */
export async function removeSupersededSubscriptions(
  aws: SesFeedbackAws,
  superseded: SnsSubscription[],
): Promise<{ removed: SnsSubscription[]; left: SnsSubscription[]; error: unknown }> {
  const removed: SnsSubscription[] = [];
  for (const [i, s] of superseded.entries()) {
    try {
      await aws.unsubscribe(s.subscriptionArn);
      removed.push(s);
    } catch (error) {
      return { removed, left: superseded.slice(i), error };
    }
  }
  return { removed, left: [], error: null };
}

export interface IdentityTopicsOutcome {
  /** Types this call pointed at the topic. */
  set: SesFeedbackType[];
  /** Types already pointing at another topic; left alone. */
  foreign: Array<{ type: SesFeedbackType; topicArn: string }>;
}

function topicOf(t: IdentityNotificationTopics | undefined, type: SesFeedbackType): string | null {
  if (!t) return null;
  return type === "Bounce" ? t.bounceTopic : t.complaintTopic;
}

/** The ARN of a topic named `topicName` that `t` already routes to. */
function routedTopicArn(
  t: IdentityNotificationTopics | undefined,
  topicName: string,
): string | null {
  for (const type of SES_FEEDBACK_TYPES) {
    const arn = topicOf(t, type);
    if (arn && topicNameFromArn(arn) === topicName) return arn;
  }
  return null;
}

/** Point the identity's unset Bounce/Complaint topics at `topicArn`.
 *  Pass `current` when the caller already read the attributes. */
export async function ensureIdentityNotificationTopics(
  aws: SesFeedbackAws,
  identity: string,
  topicArn: string,
  known?: IdentityNotificationTopics,
): Promise<IdentityTopicsOutcome> {
  const current = known ?? (await aws.getNotificationTopics([identity])).get(identity);
  const out: IdentityTopicsOutcome = { set: [], foreign: [] };
  for (const type of SES_FEEDBACK_TYPES) {
    const existing = topicOf(current, type);
    if (existing === topicArn) continue;
    if (existing) {
      out.foreign.push({ type, topicArn: existing });
      continue;
    }
    await aws.setNotificationTopic(identity, type, topicArn);
    out.set.push(type);
  }
  return out;
}

export interface EnsureSesFeedbackOptions {
  /** The SES identity to route (e.g. `mail.<projectDomain>`). */
  identity: string;
  /** Stored Listmonk URL; the webhook URL is derived from it. */
  listmonkUrl: string;
  /** Basic-auth credentials for the SNS endpoint. Without them the
   *  plain webhook URL is subscribed. */
  webhookCredentials?: WebhookCredentials | null;
  aws: SesFeedbackAws;
  listmonk: SesFeedbackListmonk;
  /** SES region, for the `--region` of printed AWS CLI commands. */
  region?: string;
  topicName?: string;
  /** How long to wait for Listmonk to confirm a new subscription. */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface SesFeedbackResult {
  identity: string;
  /** The subscribed endpoint, password redacted. */
  webhookUrl: string;
  /** Whether the endpoint carries basic-auth credentials. */
  credentialed: boolean;
  /** Null when the topic could not be created or found. */
  topicArn: string | null;
  subscription: SubscriptionState | null;
  /** Whether this run called sns:Subscribe. */
  subscribedThisRun: boolean;
  /** Notification types this run set on the identity. The ledger undoes
   *  exactly these. */
  typesSetThisRun: SesFeedbackType[];
  foreignTopics: IdentityTopicsOutcome["foreign"];
  /** Topics IAM kept this run from setting. `renderSesFeedbackLines`
   *  prints the command for each. */
  manualTopics: ManualNotificationTopic[];
  suppressionAdded: string[];
  listmonkSettingsWritten: string[];
  /** Older subscriptions of the same webhook this run removed, and the
   *  ones it could not (password redacted in both). */
  supersededRemoved: string[];
  supersededLeft: Array<{ subscriptionArn: string; endpoint: string }>;
  /** One line per step that failed. Provisioning continues past them. */
  warnings: string[];
  /** True when any warning was an IAM permission gap. */
  iamGap: boolean;
  region?: string;
}

/**
 * Wire one identity into the shared feedback path. Every step reads
 * before it writes, so a run over a healthy setup makes no write at all:
 * the topic ARN comes from the identity's own notification attributes
 * when an earlier run set them, and CreateTopic runs only when it
 * doesn't. A failed step becomes a warning instead of stopping the
 * others (a topic that can't be created still leaves the account
 * suppression worth setting).
 */
export async function ensureSesFeedback(
  opts: EnsureSesFeedbackOptions,
): Promise<SesFeedbackResult> {
  const { aws, listmonk, identity } = opts;
  const endpoint = listmonkSesWebhookUrl(opts.listmonkUrl, opts.webhookCredentials);
  const result: SesFeedbackResult = {
    identity,
    webhookUrl: redactEndpoint(endpoint),
    credentialed: Boolean(opts.webhookCredentials),
    topicArn: null,
    subscription: null,
    subscribedThisRun: false,
    typesSetThisRun: [],
    foreignTopics: [],
    manualTopics: [],
    suppressionAdded: [],
    listmonkSettingsWritten: [],
    supersededRemoved: [],
    supersededLeft: [],
    warnings: [],
    iamGap: false,
    region: opts.region,
  };
  const warn = (err: unknown, action: string) => {
    if (isAccessDenied(err)) result.iamGap = true;
    result.warnings.push(describeFeedbackError(err, action));
  };

  try {
    result.listmonkSettingsWritten = await ensureListmonkBounceSettings(listmonk);
  } catch (err) {
    result.warnings.push(listmonkSettingsError(err));
  }

  const topicName = opts.topicName ?? SES_FEEDBACK_TOPIC_NAME;
  let current: IdentityNotificationTopics | undefined;
  let identityReadable = true;
  let identityReadDenied = false;
  try {
    current = (await aws.getNotificationTopics([identity])).get(identity);
  } catch (err) {
    identityReadable = false;
    identityReadDenied = isAccessDenied(err);
    warn(err, "ses:GetIdentityNotificationAttributes");
  }

  try {
    result.topicArn = routedTopicArn(current, topicName) ?? (await aws.createTopic(topicName));
  } catch (err) {
    warn(err, "sns:CreateTopic");
  }

  if (result.topicArn) {
    let superseded: SnsSubscription[] = [];
    try {
      const sub = await ensureFeedbackSubscription(aws, result.topicArn, endpoint, opts);
      result.topicArn = sub.topicArn;
      result.subscription = sub.state;
      result.subscribedThisRun = sub.subscribed;
      if (sub.state === "confirmed") {
        superseded = supersededSubscriptions(sub.subscriptions, endpoint);
      }
    } catch (err) {
      warn(err, "sns:ListSubscriptionsByTopic / sns:Subscribe");
    }
    if (superseded.length > 0) {
      const out = await removeSupersededSubscriptions(aws, superseded);
      result.supersededRemoved = out.removed.map((s) => redactEndpoint(s.endpoint));
      result.supersededLeft = out.left.map((s) => ({
        subscriptionArn: s.subscriptionArn,
        endpoint: redactEndpoint(s.endpoint),
      }));
      if (out.error) warn(out.error, "sns:Unsubscribe");
    }
  }

  if (result.topicArn && identityReadable) {
    const topicArn = result.topicArn;
    try {
      const topics = await ensureIdentityNotificationTopics(aws, identity, topicArn, current);
      result.typesSetThisRun = topics.set;
      result.foreignTopics = topics.foreign;
    } catch (err) {
      warn(err, "ses:SetIdentityNotificationTopic");
      // The unset types are exactly what the call was going to set.
      if (isAccessDenied(err)) {
        result.manualTopics = SES_FEEDBACK_TYPES.filter((type) => !topicOf(current, type)).map(
          (type) => ({ identity, type, topicArn }),
        );
      }
    }
  } else if (result.topicArn && identityReadDenied) {
    // Can't see what is set; both commands are the ones to run.
    const topicArn = result.topicArn;
    result.manualTopics = SES_FEEDBACK_TYPES.map((type) => ({ identity, type, topicArn }));
  }

  try {
    result.suppressionAdded = await ensureAccountSuppression(aws);
  } catch (err) {
    warn(err, "ses:GetAccount / ses:PutAccountSuppressionAttributes");
  }

  return result;
}

/** Status lines for a feedback run, shared by `hatchkit add` and
 *  `migrate-domain`. The caller picks the colour from `level`. */
export function renderSesFeedbackLines(
  r: SesFeedbackResult,
): Array<{ level: "ok" | "info" | "warn"; text: string }> {
  const out: Array<{ level: "ok" | "info" | "warn"; text: string }> = [];
  const topicName = r.topicArn ? topicNameFromArn(r.topicArn) : SES_FEEDBACK_TOPIC_NAME;
  if (r.topicArn && r.subscription === "confirmed" && r.warnings.length === 0) {
    out.push({
      level: "ok",
      text: `✓ SES bounce feedback: ${r.identity} → SNS ${topicName} → ${r.webhookUrl}`,
    });
  }
  if (r.typesSetThisRun.length > 0) {
    out.push({
      level: "info",
      text: `· ${r.typesSetThisRun.join(" + ")} notifications of ${r.identity} now go to ${topicName}`,
    });
  }
  if (r.listmonkSettingsWritten.length > 0) {
    out.push({
      level: "info",
      text: `· Listmonk: turned on ${r.listmonkSettingsWritten.join(", ")}`,
    });
  }
  if (r.suppressionAdded.length > 0) {
    out.push({
      level: "info",
      text: `· SES account suppression list now includes ${r.suppressionAdded.join(" + ")}`,
    });
  }
  for (const e of r.supersededRemoved) {
    out.push({ level: "info", text: `· SNS: removed the older subscription ${e}` });
  }
  if (r.subscribedThisRun && r.credentialed) {
    out.push({
      level: "info",
      text: "· The SNS endpoint carries basic-auth credentials. `hatchkit ses webhook-auth` prints the Traefik labels that require them.",
    });
  }
  for (const s of r.supersededLeft) {
    out.push({
      level: "warn",
      text: `SNS also delivers to ${s.endpoint}, so Listmonk gets each notification twice. Remove it: ${unsubscribeCommand(s.subscriptionArn)}`,
    });
  }
  if (r.subscription === "pending") {
    out.push({
      level: "warn",
      text: `SNS subscription to ${r.webhookUrl} is not confirmed yet. Listmonk confirms it by itself once \`bounce.ses_enabled\` is on and the URL is reachable from AWS. Check later with \`hatchkit doctor\`.`,
    });
  }
  for (const f of r.foreignTopics) {
    out.push({
      level: "warn",
      text: `${r.identity} sends ${f.type} notifications to ${f.topicArn}, not ${topicName}. Left unchanged.`,
    });
  }
  for (const w of r.warnings) out.push({ level: "warn", text: `SES bounce feedback: ${w}` });
  if (r.iamGap) {
    for (const line of feedbackIamHint()) out.push({ level: "warn", text: `  ${line}` });
  }
  out.push(...renderManualTopicLines(r.manualTopics, r.region));
  return out;
}

/** The commands for topics IAM kept a run from setting, one per line. */
export function renderManualTopicLines(
  topics: ManualNotificationTopic[],
  region?: string,
): Array<{ level: "warn"; text: string }> {
  if (topics.length === 0) return [];
  return [
    {
      level: "warn",
      text: "  Or set the notification topics with an AWS profile that has ses:SetIdentityNotificationTopic:",
    },
    ...topics.map((t) => ({
      level: "warn" as const,
      text: `    ${setNotificationTopicCommand(t, region)}`,
    })),
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// Copy (migrate-domain)
// ────────────────────────────────────────────────────────────────────────────

export interface CopyNotificationTopicsResult {
  from: string;
  to: string;
  /** False when SES does not know `from`, or it could not be read. */
  sourceFound: boolean;
  /** The read of both identities failed on IAM. */
  readDenied: boolean;
  /** Types this call set on `to`, with the topic each got. */
  copied: Array<{ type: SesFeedbackType; topicArn: string }>;
  /** Types `to` already routes to the same topic as `from`. */
  unchanged: SesFeedbackType[];
  /** Types `from` routes nowhere: nothing to copy. */
  unrouted: SesFeedbackType[];
  /** Types `to` already routes to another topic. Left alone. */
  conflicts: Array<{ type: SesFeedbackType; topicArn: string; sourceTopicArn: string }>;
  manualTopics: ManualNotificationTopic[];
  warnings: string[];
  iamGap: boolean;
}

/**
 * Give identity `to` the Bounce and Complaint topics of identity `from`.
 * One read covers both identities. A type `to` already routes somewhere
 * else is reported and left alone, like `ensureIdentityNotificationTopics`
 * does. A set that IAM refuses lands in `manualTopics` and the other type
 * is still tried. Never throws.
 */
export async function copyIdentityNotificationTopics(
  aws: SesFeedbackAws,
  from: string,
  to: string,
): Promise<CopyNotificationTopicsResult> {
  const result: CopyNotificationTopicsResult = {
    from,
    to,
    sourceFound: false,
    readDenied: false,
    copied: [],
    unchanged: [],
    unrouted: [],
    conflicts: [],
    manualTopics: [],
    warnings: [],
    iamGap: false,
  };
  const warn = (err: unknown, action: string) => {
    if (isAccessDenied(err)) result.iamGap = true;
    const line = describeFeedbackError(err, action);
    if (!result.warnings.includes(line)) result.warnings.push(line);
  };

  let attrs: Map<string, IdentityNotificationTopics>;
  try {
    attrs = await aws.getNotificationTopics([from, to]);
  } catch (err) {
    result.readDenied = isAccessDenied(err);
    warn(err, "ses:GetIdentityNotificationAttributes");
    return result;
  }
  const source = attrs.get(from);
  if (!source) return result;
  result.sourceFound = true;
  const target = attrs.get(to);

  for (const type of SES_FEEDBACK_TYPES) {
    const sourceTopicArn = topicOf(source, type);
    if (!sourceTopicArn) {
      result.unrouted.push(type);
      continue;
    }
    const existing = topicOf(target, type);
    if (existing === sourceTopicArn) {
      result.unchanged.push(type);
      continue;
    }
    if (existing) {
      result.conflicts.push({ type, topicArn: existing, sourceTopicArn });
      continue;
    }
    try {
      await aws.setNotificationTopic(to, type, sourceTopicArn);
      result.copied.push({ type, topicArn: sourceTopicArn });
    } catch (err) {
      warn(err, "ses:SetIdentityNotificationTopic");
      if (isAccessDenied(err)) {
        result.manualTopics.push({ identity: to, type, topicArn: sourceTopicArn });
      }
    }
  }
  return result;
}

/** Status lines for a copy. Leaves the commands for `manualTopics` to
 *  the caller, which may merge them with another run's. */
export function renderCopyTopicsLines(
  r: CopyNotificationTopicsResult,
): Array<{ level: "ok" | "info" | "warn"; text: string }> {
  const out: Array<{ level: "ok" | "info" | "warn"; text: string }> = [];
  const name = (arn: string) => topicNameFromArn(arn);
  if (r.copied.length > 0) {
    out.push({
      level: "info",
      text: `· copied from ${r.from}: ${r.copied.map((c) => `${c.type} → ${name(c.topicArn)}`).join(", ")}`,
    });
  }
  if (r.unchanged.length > 0 && r.copied.length === 0 && r.manualTopics.length === 0) {
    out.push({
      level: "ok",
      text: `✓ ${r.to} already has ${r.from}'s ${r.unchanged.join(" + ")} topic${r.unchanged.length === 1 ? "" : "s"}`,
    });
  }
  if (!r.sourceFound && r.warnings.length === 0) {
    out.push({
      level: "info",
      text: `· ${r.from} is not an SES identity (any more), so there are no topics to copy`,
    });
  }
  if (r.unrouted.length > 0) {
    out.push({
      level: "info",
      text: `· ${r.from} routes no ${r.unrouted.join(" or ")} notifications, so there is nothing to copy for ${r.unrouted.length === 1 ? "it" : "them"}`,
    });
  }
  for (const c of r.conflicts) {
    out.push({
      level: "warn",
      text: `${r.to} sends ${c.type} notifications to ${c.topicArn}, ${r.from} to ${c.sourceTopicArn}. Left unchanged.`,
    });
  }
  for (const w of r.warnings) {
    out.push({ level: "warn", text: `copying ${r.from}'s notification topics: ${w}` });
  }
  return out;
}

/**
 * Undo for one identity: clear the given notification types, but only
 * those that still point at `topicArn` (someone may have re-pointed them
 * since). Never touches the topic, its subscription, the account
 * suppression or Listmonk — other projects share all four.
 */
export async function clearSesFeedbackTopics(
  aws: SesFeedbackAws,
  identity: string,
  topicArn: string,
  types: SesFeedbackType[],
): Promise<"cleared" | "not-found"> {
  const current = (await aws.getNotificationTopics([identity])).get(identity);
  if (!current) return "not-found";
  let cleared = 0;
  for (const type of types) {
    if (topicOf(current, type) !== topicArn) continue;
    await aws.setNotificationTopic(identity, type, null);
    cleared += 1;
  }
  return cleared > 0 ? "cleared" : "not-found";
}

// ────────────────────────────────────────────────────────────────────────────
// Inspect (read-only, for `hatchkit doctor`)
// ────────────────────────────────────────────────────────────────────────────

type Probe<T> = { ok: true; value: T } | { ok: false; error: string; iamGap: boolean };

async function probe<T>(action: string, fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: describeFeedbackError(err, action), iamGap: isAccessDenied(err) };
  }
}

export interface SesFeedbackInspection {
  topicName: string;
  webhookUrl: string;
  identities: Probe<{
    verified: string[];
    /** Verified identities with at least one type unset. */
    missing: Array<{ identity: string; types: SesFeedbackType[] }>;
    /** Types routed to a topic with another name. */
    foreign: Array<{ identity: string; type: SesFeedbackType; topicArn: string }>;
  }>;
  /** The shared topic's ARN, as found on an identity's notification
   *  attributes. Null when no identity routes to it: doctor can't look it
   *  up without `sns:ListTopics`, and CreateTopic would be a write. */
  topicArn: string | null;
  /** Null when `topicArn` is null. `topic-missing` when SNS says the
   *  topic no longer exists. */
  subscription: Probe<SubscriptionState | "topic-missing"> | null;
  /** Confirmed subscriptions of the same webhook under other
   *  credentials, from the same read. Their endpoints are redacted. */
  superseded: SnsSubscription[];
  suppression: Probe<string[]>;
  listmonkSettings: Probe<string[]>;
}

/** Read the whole feedback path without writing anything. */
export async function inspectSesFeedback(opts: {
  aws: SesFeedbackAws;
  listmonk: SesFeedbackListmonk;
  listmonkUrl: string;
  webhookCredentials?: WebhookCredentials | null;
  topicName?: string;
}): Promise<SesFeedbackInspection> {
  const { aws, listmonk } = opts;
  const topicName = opts.topicName ?? SES_FEEDBACK_TOPIC_NAME;
  const endpoint = listmonkSesWebhookUrl(opts.listmonkUrl, opts.webhookCredentials);
  const webhookUrl = redactEndpoint(endpoint);

  // Assigned inside the probe callback; the cast keeps TS from
  // narrowing it to `null` for the rest of the function.
  let topicArn = null as string | null;
  const identities = await probe(
    "ses:ListEmailIdentities / ses:GetIdentityNotificationAttributes",
    async () => {
      const verified = await aws.listVerifiedIdentities();
      const attrs = await aws.getNotificationTopics(verified);
      const missing: Array<{ identity: string; types: SesFeedbackType[] }> = [];
      const foreign: Array<{ identity: string; type: SesFeedbackType; topicArn: string }> = [];
      for (const identity of verified) {
        const current = attrs.get(identity);
        const types: SesFeedbackType[] = [];
        for (const type of SES_FEEDBACK_TYPES) {
          const arn = topicOf(current, type);
          if (!arn) types.push(type);
          else if (topicNameFromArn(arn) === topicName) topicArn ??= arn;
          else foreign.push({ identity, type, topicArn: arn });
        }
        if (types.length > 0) missing.push({ identity, types });
      }
      return { verified, missing, foreign };
    },
  );

  let subscription: SesFeedbackInspection["subscription"] = null;
  let superseded: SnsSubscription[] = [];
  if (topicArn) {
    const arn = topicArn;
    subscription = await probe("sns:ListSubscriptionsByTopic", async () => {
      try {
        const subs = await aws.listSubscriptions(arn);
        superseded = supersededSubscriptions(subs, endpoint).map((s) => ({
          ...s,
          endpoint: redactEndpoint(s.endpoint),
        }));
        return subscriptionState(subs, endpoint);
      } catch (err) {
        if (isNotFound(err)) return "topic-missing" as const;
        throw err;
      }
    });
  }

  const suppression = await probe("ses:GetAccount", async () =>
    missingSuppressedReasons(await aws.getSuppressedReasons()),
  );

  let listmonkSettings: Probe<string[]>;
  try {
    listmonkSettings = { ok: true, value: listmonkBounceSettingsOff(await listmonk.getSettings()) };
  } catch (err) {
    listmonkSettings = { ok: false, error: listmonkSettingsError(err), iamGap: false };
  }

  return {
    topicName,
    webhookUrl,
    identities,
    topicArn,
    subscription,
    superseded,
    suppression,
    listmonkSettings,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Traefik basic auth (for `hatchkit ses webhook-auth`)
// ────────────────────────────────────────────────────────────────────────────

export interface TraefikBasicAuthOptions {
  /** Listmonk's public hostname. */
  host: string;
  credentials: WebhookCredentials;
  /** The Traefik service to route to. Optional when Traefik can infer
   *  the container's only service. Required with multiple services. */
  service?: string;
  /** Same as Listmonk's own HTTPS router. Coolify uses `letsencrypt`. */
  certResolver?: string;
  httpsEntryPoint?: string;
  httpEntryPoint?: string;
  /** Prefix for the router and middleware names. */
  name?: string;
  /** Above Listmonk's own routers. Traefik's default priority is the
   *  rule's length, well below this. */
  priority?: number;
  /** Double every `$` for a docker-compose file, which would otherwise
   *  read the bcrypt hash as variables. Off by default: Coolify doubles
   *  them itself while "Escape special characters in labels" is on. */
  escapeDollars?: boolean;
  /** A precomputed htpasswd hash; tests pass one. */
  hash?: string;
}

/** htpasswd bcrypt hash of the password. `$2y$` is the prefix Apache's
 *  `htpasswd -B` writes; the algorithm is the same as `$2b$`. */
export function htpasswdBcrypt(password: string): string {
  return bcrypt.hashSync(password, 10).replace(/^\$2[ab]\$/, "$2y$");
}

/**
 * Docker labels that put `/webhooks/service` on Listmonk's host behind
 * basic auth: one router per entry point with an explicit priority and a
 * `basicAuth` middleware. The middleware drops the Authorization header
 * before the request reaches Listmonk. Every other path still goes
 * through Listmonk's own routers.
 */
export function traefikBasicAuthLabels(o: TraefikBasicAuthOptions): string[] {
  const name = o.name ?? "listmonk-sns";
  const middleware = `${name}-auth`;
  const priority = o.priority ?? 1000;
  const hash = o.hash ?? htpasswdBcrypt(o.credentials.password);
  const rule = `Host(\`${o.host}\`) && PathPrefix(\`/webhooks/service\`)`;
  const router = (suffix: string, entryPoint: string, tls: string[]) => {
    const r = `traefik.http.routers.${name}-${suffix}`;
    return [
      `${r}.rule=${rule}`,
      `${r}.entryPoints=${entryPoint}`,
      `${r}.priority=${priority}`,
      ...tls.map((t) => `${r}.${t}`),
      `${r}.middlewares=${middleware}`,
      ...(o.service ? [`${r}.service=${o.service}`] : []),
    ];
  };
  const labels = [
    `traefik.http.middlewares.${middleware}.basicauth.users=${o.credentials.user}:${hash}`,
    `traefik.http.middlewares.${middleware}.basicauth.removeheader=true`,
    ...router("https", o.httpsEntryPoint ?? "https", [
      "tls=true",
      `tls.certresolver=${o.certResolver ?? "letsencrypt"}`,
    ]),
    ...router("http", o.httpEntryPoint ?? "http", []),
  ];
  return o.escapeDollars ? labels.map((l) => l.replaceAll("$", "$$$$")) : labels;
}

// ────────────────────────────────────────────────────────────────────────────
// Real adapters
// ────────────────────────────────────────────────────────────────────────────

function awsClientConfig(auth: SesAuth) {
  return {
    region: auth.region,
    credentials: { accessKeyId: auth.accessKeyId, secretAccessKey: auth.secretAccessKey },
  };
}

/** SES v1 allows one SetIdentityNotificationTopic per second. */
const SET_TOPIC_INTERVAL_MS = 1_100;

export function createSesFeedbackAws(auth: SesAuth): SesFeedbackAws {
  const ses = new SESClient(awsClientConfig(auth));
  const sesv2 = new SESv2Client(awsClientConfig(auth));
  const sns = new SNSClient(awsClientConfig(auth));
  let lastSetAt = 0;
  return {
    async createTopic(name) {
      const res = await sns.send(new CreateTopicCommand({ Name: name }));
      if (!res.TopicArn) throw new Error(`sns:CreateTopic returned no ARN for ${name}`);
      return res.TopicArn;
    },
    async listSubscriptions(topicArn) {
      const out: SnsSubscription[] = [];
      let token: string | undefined;
      do {
        const res = await sns.send(
          new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: token }),
        );
        for (const s of res.Subscriptions ?? []) {
          out.push({
            subscriptionArn: s.SubscriptionArn ?? "",
            protocol: s.Protocol ?? "",
            endpoint: s.Endpoint ?? "",
          });
        }
        token = res.NextToken;
      } while (token);
      return out;
    },
    async subscribe(topicArn, protocol, endpoint) {
      await sns.send(
        new SubscribeCommand({ TopicArn: topicArn, Protocol: protocol, Endpoint: endpoint }),
      );
    },
    async unsubscribe(subscriptionArn) {
      await sns.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
    },
    async getNotificationTopics(identities) {
      const out = new Map<string, IdentityNotificationTopics>();
      // The API takes at most 100 identities per call.
      for (let i = 0; i < identities.length; i += 100) {
        const res = await ses.send(
          new GetIdentityNotificationAttributesCommand({
            Identities: identities.slice(i, i + 100),
          }),
        );
        for (const [identity, a] of Object.entries(res.NotificationAttributes ?? {})) {
          out.set(identity, {
            bounceTopic: a.BounceTopic || null,
            complaintTopic: a.ComplaintTopic || null,
          });
        }
      }
      return out;
    },
    async setNotificationTopic(identity, type, topicArn) {
      const wait = lastSetAt + SET_TOPIC_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastSetAt = Date.now();
      await ses.send(
        new SetIdentityNotificationTopicCommand({
          Identity: identity,
          NotificationType: type,
          SnsTopic: topicArn ?? undefined,
        }),
      );
    },
    async getSuppressedReasons() {
      const res = await sesv2.send(new GetAccountCommand({}));
      return [...(res.SuppressionAttributes?.SuppressedReasons ?? [])];
    },
    async putSuppressedReasons(reasons) {
      await sesv2.send(
        new PutAccountSuppressionAttributesCommand({
          SuppressedReasons: reasons as Array<"BOUNCE" | "COMPLAINT">,
        }),
      );
    },
    async listVerifiedIdentities() {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const res = await sesv2.send(
          new ListEmailIdentitiesCommand({ NextToken: token, PageSize: 100 }),
        );
        for (const id of res.EmailIdentities ?? []) {
          if (id.IdentityName && id.VerificationStatus === "SUCCESS") out.push(id.IdentityName);
        }
        token = res.NextToken;
      } while (token);
      return out;
    },
  };
}

export function createSesFeedbackListmonk(
  auth: ListmonkAuth,
  opts: { settleBeforeRead?: boolean } = {},
): SesFeedbackListmonk {
  return {
    async getSettings() {
      // A settings write earlier in the run (SMTP apply) may still be
      // reloading Listmonk.
      if (opts.settleBeforeRead !== false) await waitForListmonk(auth);
      return getListmonkSettings(auth);
    },
    async putSetting(key, value) {
      await putListmonkSetting(key, value, auth);
      await waitForListmonk(auth, { initialDelayMs: 500 });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
