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
 * permission degrades to a warning that names the action.
 */

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
} from "@aws-sdk/client-sns";
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
] as const;

/** Listmonk's SES webhook for a stored Listmonk URL. */
export function listmonkSesWebhookUrl(listmonkUrl: string): string {
  return `${normalizeListmonkUrl(listmonkUrl)}/webhooks/service/ses`;
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
  const mine = subs.filter((s) => s.endpoint === endpoint);
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
): Promise<{ state: SubscriptionState; subscribed: boolean; topicArn: string }> {
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
  if (state === "confirmed") return { state, subscribed: false, topicArn: arn };
  await aws.subscribe(arn, snsProtocolFor(endpoint), endpoint);
  const deadline = Date.now() + (opts.confirmTimeoutMs ?? 20_000);
  for (;;) {
    state = subscriptionState(await aws.listSubscriptions(arn), endpoint);
    if (state === "confirmed" || Date.now() >= deadline) break;
    await sleep(opts.pollIntervalMs ?? 2_000);
  }
  return { state: state === "missing" ? "pending" : state, subscribed: true, topicArn: arn };
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
  aws: SesFeedbackAws;
  listmonk: SesFeedbackListmonk;
  topicName?: string;
  /** How long to wait for Listmonk to confirm a new subscription. */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface SesFeedbackResult {
  identity: string;
  webhookUrl: string;
  /** Null when the topic could not be created or found. */
  topicArn: string | null;
  subscription: SubscriptionState | null;
  /** Whether this run called sns:Subscribe. */
  subscribedThisRun: boolean;
  /** Notification types this run set on the identity. The ledger undoes
   *  exactly these. */
  typesSetThisRun: SesFeedbackType[];
  foreignTopics: IdentityTopicsOutcome["foreign"];
  suppressionAdded: string[];
  listmonkSettingsWritten: string[];
  /** One line per step that failed. Provisioning continues past them. */
  warnings: string[];
  /** True when any warning was an IAM permission gap. */
  iamGap: boolean;
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
  const webhookUrl = listmonkSesWebhookUrl(opts.listmonkUrl);
  const result: SesFeedbackResult = {
    identity,
    webhookUrl,
    topicArn: null,
    subscription: null,
    subscribedThisRun: false,
    typesSetThisRun: [],
    foreignTopics: [],
    suppressionAdded: [],
    listmonkSettingsWritten: [],
    warnings: [],
    iamGap: false,
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
  try {
    current = (await aws.getNotificationTopics([identity])).get(identity);
  } catch (err) {
    identityReadable = false;
    warn(err, "ses:GetIdentityNotificationAttributes");
  }

  try {
    result.topicArn = routedTopicArn(current, topicName) ?? (await aws.createTopic(topicName));
  } catch (err) {
    warn(err, "sns:CreateTopic");
  }

  if (result.topicArn) {
    try {
      const sub = await ensureFeedbackSubscription(aws, result.topicArn, webhookUrl, opts);
      result.topicArn = sub.topicArn;
      result.subscription = sub.state;
      result.subscribedThisRun = sub.subscribed;
    } catch (err) {
      warn(err, "sns:ListSubscriptionsByTopic / sns:Subscribe");
    }
  }

  if (result.topicArn && identityReadable) {
    try {
      const topics = await ensureIdentityNotificationTopics(
        aws,
        identity,
        result.topicArn,
        current,
      );
      result.typesSetThisRun = topics.set;
      result.foreignTopics = topics.foreign;
    } catch (err) {
      warn(err, "ses:SetIdentityNotificationTopic");
    }
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
  suppression: Probe<string[]>;
  listmonkSettings: Probe<string[]>;
}

/** Read the whole feedback path without writing anything. */
export async function inspectSesFeedback(opts: {
  aws: SesFeedbackAws;
  listmonk: SesFeedbackListmonk;
  listmonkUrl: string;
  topicName?: string;
}): Promise<SesFeedbackInspection> {
  const { aws, listmonk } = opts;
  const topicName = opts.topicName ?? SES_FEEDBACK_TOPIC_NAME;
  const webhookUrl = listmonkSesWebhookUrl(opts.listmonkUrl);

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
  if (topicArn) {
    const arn = topicArn;
    subscription = await probe("sns:ListSubscriptionsByTopic", async () => {
      try {
        return subscriptionState(await aws.listSubscriptions(arn), webhookUrl);
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
    suppression,
    listmonkSettings,
  };
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
