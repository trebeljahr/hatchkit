/*
 * AWS SES (Simple Email Service) provisioning — verifies sending
 * identities (typically a project-scoped `mail.<projectDomain>`
 * subdomain), retrieves the DKIM tokens we need to publish into DNS,
 * and derives the SMTP relay credentials a downstream Listmonk (or any
 * other SMTP client) plugs in to send through SES.
 *
 * API surface intentionally uses `@aws-sdk/client-sesv2` rather than
 * hand-rolling SigV4 against fetch:
 *   - SESv2 is the current API (v1 is legacy, missing features).
 *   - Credential resolution + SigV4 signing + retry/backoff are
 *     already correct in the SDK.
 *
 * Sandbox mode is the default for every new SES account: it can only
 * send to verified recipient addresses until you submit the
 * production-access form in the AWS console (web UI only, ~24h Amazon
 * review). Callers should surface this fact — this module does not
 * gate sends, but the upstream user-facing flow does.
 */

import { createHmac } from "node:crypto";
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  PutEmailIdentityFeedbackAttributesCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import { ensureSes } from "../config.js";

export interface SesAuth {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function makeClient(auth: SesAuth): SESv2Client {
  return new SESv2Client({
    region: auth.region,
    credentials: {
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// SMTP credential derivation
//
// AWS deprecated the original (Sig V2) "HMAC over the literal string
// `SendRawEmail`" algorithm in 2018. Modern SES SMTP credentials are
// derived from an IAM secret access key using the same Sig V4
// derivation as REST API requests, with a fixed date / service /
// terminal / message. The result is a 49-byte string: one version byte
// (0x04) prefix + the 32-byte HMAC, base64-encoded.
//
// Reference: https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html
//   "Obtain Amazon SES SMTP credentials by converting existing AWS
//    credentials" → "Sig V4" algorithm.
// ────────────────────────────────────────────────────────────────────────────

const SMTP_DERIVE_DATE = "11111111";
const SMTP_DERIVE_SERVICE = "ses";
const SMTP_DERIVE_TERMINAL = "aws4_request";
const SMTP_DERIVE_MESSAGE = "SendRawEmail";
const SMTP_DERIVE_VERSION = 0x04;

/** Every SES region that hosts an SMTP endpoint. Mirrors the list in
 *  AWS's Sig V4 reference implementation — calling the derivation with
 *  a region not in this list usually means the user picked an SES
 *  region that doesn't expose SMTP (e.g. some opt-in regions), and the
 *  resulting credentials would silently fail when used. */
export const SES_SMTP_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "sa-east-1",
  "us-gov-west-1",
] as const;

export type SesSmtpRegion = (typeof SES_SMTP_REGIONS)[number];

function hmacSha256(key: Buffer | string, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/**
 * Derive the SES SMTP password from an IAM secret access key + region.
 * Exported so the test suite can golden-test it without hitting AWS.
 *
 * Throws on a region that has no SES SMTP endpoint — letting an
 * unsupported region through produces a credential that fails only at
 * the moment of the first send, which is a terrible time to discover
 * the problem.
 */
export function deriveSesSmtpPassword(secretAccessKey: string, region: string): string {
  if (!(SES_SMTP_REGIONS as readonly string[]).includes(region)) {
    throw new Error(
      `SES region ${region} has no SMTP endpoint. Valid regions: ${SES_SMTP_REGIONS.join(", ")}.`,
    );
  }
  let signature = hmacSha256(`AWS4${secretAccessKey}`, SMTP_DERIVE_DATE);
  signature = hmacSha256(signature, region);
  signature = hmacSha256(signature, SMTP_DERIVE_SERVICE);
  signature = hmacSha256(signature, SMTP_DERIVE_TERMINAL);
  signature = hmacSha256(signature, SMTP_DERIVE_MESSAGE);
  const versionedSignature = Buffer.concat([Buffer.from([SMTP_DERIVE_VERSION]), signature]);
  return versionedSignature.toString("base64");
}

/** The full SMTP-relay coordinate quartet a Listmonk (or any SMTP
 *  client) needs. `username` is the IAM access key id itself — no
 *  derivation involved. `password` is the Sig V4-derived string above. */
export interface SesSmtpCredentials {
  host: string;
  port: 587;
  username: string;
  password: string;
}

export function sesSmtpCredentials(auth: SesAuth): SesSmtpCredentials {
  return {
    host: `email-smtp.${auth.region}.amazonaws.com`,
    port: 587,
    username: auth.accessKeyId,
    password: deriveSesSmtpPassword(auth.secretAccessKey, auth.region),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Identity (sending domain) management
// ────────────────────────────────────────────────────────────────────────────

export interface SesDnsRecord {
  type: "CNAME";
  name: string;
  value: string;
}

export interface SesIdentity {
  name: string;
  verifiedForSendingStatus?: boolean;
  /** The 3 DKIM CNAMEs SES requires the user to publish at
   *  `<token>._domainkey.<domain>` → `<token>.dkim.amazonses.com`. */
  dkimRecords: SesDnsRecord[];
}

function dkimRecordsFromTokens(domain: string, tokens: string[] | undefined): SesDnsRecord[] {
  return (tokens ?? []).map((token) => ({
    type: "CNAME" as const,
    name: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
  }));
}

/**
 * Create a new SES email identity for `domain` (typically a sending
 * subdomain like `mail.<projectDomain>`). Idempotent: when the
 * identity already exists, falls through to GetEmailIdentity so the
 * caller still receives the DKIM tokens.
 *
 * SES returns DKIM tokens only at create-time on the first call.
 * Subsequent GetEmailIdentity calls return the same tokens unchanged
 * for the lifetime of the identity.
 */
export async function createSesDomain(
  domain: string,
  authOverride?: SesAuth,
): Promise<SesIdentity> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  try {
    const res = await client.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
    return {
      name: domain,
      verifiedForSendingStatus: res.VerifiedForSendingStatus ?? false,
      dkimRecords: dkimRecordsFromTokens(domain, res.DkimAttributes?.Tokens),
    };
  } catch (err) {
    // AlreadyExistsException → fetch the existing identity instead.
    const name = (err as { name?: string }).name;
    if (name === "AlreadyExistsException") {
      return getSesDomain(domain, auth);
    }
    throw err;
  }
}

export async function getSesDomain(domain: string, authOverride?: SesAuth): Promise<SesIdentity> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  const res = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  return {
    name: domain,
    verifiedForSendingStatus: res.VerifiedForSendingStatus ?? false,
    dkimRecords: dkimRecordsFromTokens(domain, res.DkimAttributes?.Tokens),
  };
}

export async function listSesDomains(authOverride?: SesAuth): Promise<string[]> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListEmailIdentitiesCommand({ NextToken: token, PageSize: 100 }),
    );
    for (const id of res.EmailIdentities ?? []) {
      if (id.IdentityName) out.push(id.IdentityName);
    }
    token = res.NextToken;
  } while (token);
  return out;
}

export type DeleteResult = "deleted" | "not-found";

/** 404-tolerant DELETE for the SES identity rollback path. */
export async function deleteSesDomain(
  domain: string,
  authOverride?: SesAuth,
): Promise<DeleteResult> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  try {
    await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    return "deleted";
  } catch (err) {
    if ((err as { name?: string }).name === "NotFoundException") return "not-found";
    throw err;
  }
}

/**
 * Enable SNS feedback notifications on a verified identity. Required
 * for the Listmonk bounces webhook flow (Phase 5) — SES routes
 * Bounce + Complaint events to the configured SNS topic, which in turn
 * POSTs to Listmonk's webhook. Standalone-callable for users who
 * already have an SNS topic and want to attach it after-the-fact.
 */
export async function enableSesFeedbackNotifications(
  domain: string,
  authOverride?: SesAuth,
): Promise<void> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  await client.send(
    new PutEmailIdentityFeedbackAttributesCommand({
      EmailIdentity: domain,
      EmailForwardingEnabled: true,
    }),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Optional test send — used by `hatchkit config add ses` to verify the
// IAM user can actually send, not just call ListEmailIdentities.
// ────────────────────────────────────────────────────────────────────────────

export async function sendSesEmail(
  params: {
    from: string;
    to: string;
    subject: string;
    text: string;
  },
  authOverride?: SesAuth,
): Promise<{ messageId: string }> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  const res = await client.send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      Content: {
        Simple: {
          Subject: { Data: params.subject, Charset: "UTF-8" },
          Body: { Text: { Data: params.text, Charset: "UTF-8" } },
        },
      },
    }),
  );
  return { messageId: res.MessageId ?? "" };
}

/** Hit ListEmailIdentities to confirm the IAM credentials work + are
 *  scoped correctly. Returns the count so the caller can echo
 *  "✓ SES: <region>, N identity/ies visible". */
export async function probeSes(auth: SesAuth): Promise<{ identityCount: number }> {
  const domains = await listSesDomains(auth);
  return { identityCount: domains.length };
}

// ────────────────────────────────────────────────────────────────────────────
// Email-address identities (for sandbox-mode test recipients)
//
// SES's sandbox restriction: outbound can only reach addresses you've
// verified ahead of time. Domain identities (mail.<projectDomain>) only
// cover *outbound*; receiving test sends to your personal inbox needs
// the recipient email itself registered as an EMAIL_ADDRESS identity.
// AWS then mails a one-time confirm link; clicking flips it to
// VerifiedForSendingStatus=true on the SES side.
// ────────────────────────────────────────────────────────────────────────────

export interface SesEmailIdentity {
  email: string;
  verified: boolean;
}

/** Register `email` as an EMAIL_ADDRESS identity. SES auto-sends the
 *  verification link to the address — the user must click before sends
 *  to it are allowed (while the account is in sandbox).
 *
 *  Idempotent: AlreadyExistsException falls through to a status fetch
 *  so re-runs don't re-trigger the verification email if one is
 *  already pending. */
export async function verifySesEmailAddress(
  email: string,
  authOverride?: SesAuth,
): Promise<SesEmailIdentity> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  try {
    const res = await client.send(new CreateEmailIdentityCommand({ EmailIdentity: email }));
    return { email, verified: res.VerifiedForSendingStatus ?? false };
  } catch (err) {
    if ((err as { name?: string }).name === "AlreadyExistsException") {
      return getSesEmailIdentity(email, auth);
    }
    throw err;
  }
}

export async function getSesEmailIdentity(
  email: string,
  authOverride?: SesAuth,
): Promise<SesEmailIdentity> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  const res = await client.send(new GetEmailIdentityCommand({ EmailIdentity: email }));
  return { email, verified: res.VerifiedForSendingStatus ?? false };
}

/** 404-tolerant delete of an email-address identity. Used by
 *  `hatchkit ses unverify <email>`. */
export async function deleteSesEmailAddress(
  email: string,
  authOverride?: SesAuth,
): Promise<DeleteResult> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  try {
    await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: email }));
    return "deleted";
  } catch (err) {
    if ((err as { name?: string }).name === "NotFoundException") return "not-found";
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Account info — sandbox detection + sending stats
// ────────────────────────────────────────────────────────────────────────────

export interface SesAccountInfo {
  /** True when AWS has approved production access. False = sandbox. */
  productionAccessEnabled: boolean;
  /** Whether outbound is currently allowed at all. Drops to false on
   *  bounce-rate suspension; useful in `hatchkit doctor` output. */
  sendingEnabled: boolean;
  /** Daily send cap. -1 when uncapped (production-access accounts after
   *  some history). */
  max24HourSend?: number;
  /** Per-second send rate cap. */
  maxSendRate?: number;
  /** AWS's view of what's still pending before production-access can
   *  be requested or re-enabled. Empty when nothing's wrong. */
  enforcementStatus?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Custom MAIL FROM domain
//
// SES defaults the SMTP envelope sender (Return-Path / MAIL FROM) to a
// subdomain of amazonses.com, which surfaces in Gmail as
// `mailed-by: <region>.amazonses.com` and also defeats SPF alignment for
// DMARC. Setting a Custom MAIL FROM domain (typically a subdomain of the
// sending domain, e.g. `bounce.mail.<projectDomain>`) hides the AWS
// infrastructure name and makes SPF alignment possible.
//
// Two DNS records are required at the chosen subdomain — an MX pointing
// to `feedback-smtp.<region>.amazonses.com` priority 10, plus a TXT with
// `v=spf1 include:amazonses.com ~all`. Hatchkit publishes both through
// the existing Cloudflare DNS helper; this module owns only the SES-side
// attribute toggle + status read.
// ────────────────────────────────────────────────────────────────────────────

/** PascalCase form Hatchkit uses everywhere (manifest, env, public API).
 *  Translated to/from AWS's SCREAMING_SNAKE form at the SDK boundary. */
export type SesMailFromBehaviorOnMxFailure = "UseDefaultValue" | "RejectMessage";

export type SesMailFromStatus = "SUCCESS" | "PENDING" | "FAILED" | "TEMPORARY_FAILURE";

export interface SesMailFromState {
  identity: string;
  /** Active custom MAIL FROM domain. Null when the identity is using the
   *  AWS default (`<region>.amazonses.com`). */
  mailFromDomain: string | null;
  behaviorOnMxFailure: SesMailFromBehaviorOnMxFailure | null;
  /** SES's view of MX-record verification. Null when no custom MAIL FROM
   *  is configured. `SUCCESS` means SES has detected the required MX. */
  status: SesMailFromStatus | null;
}

/** Compute the conventional MAIL FROM subdomain Hatchkit publishes for a
 *  sending domain. Default label `bounce` → `bounce.<sendingDomain>`.
 *  Kept as a named pure helper so destroy/inventory derive the same name
 *  from a manifest without depending on the orchestrator. */
export function sesMailFromSubdomain(sendingDomain: string, label = "bounce"): string {
  const trimmed = label.trim().replace(/^\.+|\.+$/g, "");
  if (!trimmed) throw new Error("MAIL FROM label cannot be empty.");
  return `${trimmed}.${sendingDomain}`;
}

/** Compute the MX target for the chosen MAIL FROM subdomain in a given
 *  SES region. The format is fixed by AWS — see SES Custom MAIL FROM
 *  documentation. */
export function sesMailFromMxTarget(region: string): string {
  return `feedback-smtp.${region}.amazonses.com`;
}

/** The TXT SPF value SES requires at the MAIL FROM subdomain. The
 *  include is what makes SPF align with the From: domain. */
export const SES_MAIL_FROM_SPF = "v=spf1 include:amazonses.com ~all";

export interface MailFromPlan {
  /** The MAIL FROM domain to apply (or assert). May be the computed
   *  default OR an adopted user-set value. */
  mailFromDomain: string;
  /** True when SES already has a user-set value different from what
   *  Hatchkit would compute. Adopt path: never overwrite. */
  adoptedExisting: boolean;
  /** The behavior to apply (or assert). On the adopt path, falls back
   *  to the existing value when SES has one. */
  behaviorOnMxFailure: SesMailFromBehaviorOnMxFailure;
  /** Whether the orchestrator should issue
   *  `PutEmailIdentityMailFromAttributes`. Skipped when the SES side
   *  already matches what we'd set AND status is SUCCESS — avoids a
   *  pointless quota-counted call on healthy re-runs. */
  needsSet: boolean;
}

/**
 * Pure helper — decides what the MAIL FROM step should DO given the
 * current SES state + caller intent. Extracted so the decision table
 * can be unit-tested without mocking the SES client.
 *
 *   · `currentState`        — read from `getSesMailFromDomain`.
 *   · `computedMailFrom`    — what Hatchkit would compute from the
 *                             sending domain + chosen label.
 *   · `desiredBehavior`     — caller intent (`UseDefaultValue` default).
 */
export function decideMailFromPlan(
  currentState: SesMailFromState,
  computedMailFrom: string,
  desiredBehavior: SesMailFromBehaviorOnMxFailure,
): MailFromPlan {
  const adoptedExisting =
    !!currentState.mailFromDomain && currentState.mailFromDomain !== computedMailFrom;
  const mailFromDomain = currentState.mailFromDomain ?? computedMailFrom;
  const behaviorOnMxFailure: SesMailFromBehaviorOnMxFailure = adoptedExisting
    ? (currentState.behaviorOnMxFailure ?? desiredBehavior)
    : desiredBehavior;
  // Skip the SET call only when SES already holds exactly what we'd
  // write (same name + same behavior) AND the verification is in a
  // good state. Any drift along any axis → re-apply.
  const needsSet =
    currentState.mailFromDomain !== mailFromDomain ||
    currentState.behaviorOnMxFailure !== behaviorOnMxFailure ||
    currentState.status !== "SUCCESS";
  return { mailFromDomain, adoptedExisting, behaviorOnMxFailure, needsSet };
}

function fromAwsBehavior(b: string | undefined): SesMailFromBehaviorOnMxFailure | null {
  if (b === "USE_DEFAULT_VALUE") return "UseDefaultValue";
  if (b === "REJECT_MESSAGE") return "RejectMessage";
  return null;
}

function toAwsBehavior(b: SesMailFromBehaviorOnMxFailure): "USE_DEFAULT_VALUE" | "REJECT_MESSAGE" {
  return b === "UseDefaultValue" ? "USE_DEFAULT_VALUE" : "REJECT_MESSAGE";
}

function fromAwsStatus(s: string | undefined): SesMailFromStatus | null {
  if (s === "SUCCESS" || s === "PENDING" || s === "FAILED" || s === "TEMPORARY_FAILURE") return s;
  return null;
}

/**
 * Set (or update) the custom MAIL FROM domain on a SES identity. Pass
 * `behaviorOnMxFailure="UseDefaultValue"` so a misconfigured DNS state
 * degrades to `amazonses.com` instead of bouncing mail outright; switch
 * to `RejectMessage` only for strict-alignment deployments that prefer a
 * hard fail over a silent default.
 *
 * Returns the SES-reported state at the moment of the call. Status will
 * usually be `PENDING` immediately after the first set — SES polls the
 * MX record and flips to `SUCCESS` within minutes once DNS propagates.
 */
export async function setSesMailFromDomain(
  identity: string,
  mailFromDomain: string,
  behaviorOnMxFailure: SesMailFromBehaviorOnMxFailure = "UseDefaultValue",
  authOverride?: SesAuth,
): Promise<SesMailFromState> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  await client.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: identity,
      MailFromDomain: mailFromDomain,
      BehaviorOnMxFailure: toAwsBehavior(behaviorOnMxFailure),
    }),
  );
  return getSesMailFromDomain(identity, auth);
}

/**
 * Read the current MAIL FROM state for a SES identity. Uses
 * `GetEmailIdentity` (SESv2) which inlines `MailFromAttributes` —
 * cheaper than the legacy v1 `GetIdentityMailFromDomainAttributes` call.
 *
 * Returns `mailFromDomain: null` when no custom MAIL FROM is configured.
 */
export async function getSesMailFromDomain(
  identity: string,
  authOverride?: SesAuth,
): Promise<SesMailFromState> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  const res = await client.send(new GetEmailIdentityCommand({ EmailIdentity: identity }));
  const attrs = res.MailFromAttributes;
  const domain = attrs?.MailFromDomain?.trim();
  if (!domain) {
    return { identity, mailFromDomain: null, behaviorOnMxFailure: null, status: null };
  }
  return {
    identity,
    mailFromDomain: domain,
    behaviorOnMxFailure: fromAwsBehavior(attrs?.BehaviorOnMxFailure),
    status: fromAwsStatus(attrs?.MailFromDomainStatus),
  };
}

/**
 * Clear the custom MAIL FROM domain from a SES identity, reverting it
 * to the AWS default. Idempotent: clearing an already-cleared identity
 * is a no-op.
 *
 * Note: AWS clears MAIL FROM when the call omits `MailFromDomain`.
 * `BehaviorOnMxFailure` must still be supplied; the value is irrelevant
 * once no domain is set, but the SDK requires the field.
 */
export async function clearSesMailFromDomain(
  identity: string,
  authOverride?: SesAuth,
): Promise<void> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  await client.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: identity,
      MailFromDomain: undefined,
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    }),
  );
}

export async function getSesAccountInfo(authOverride?: SesAuth): Promise<SesAccountInfo> {
  const auth = authOverride ?? (await ensureSes());
  const client = makeClient(auth);
  const res = await client.send(new GetAccountCommand({}));
  return {
    productionAccessEnabled: res.ProductionAccessEnabled ?? false,
    sendingEnabled: res.SendingEnabled ?? true,
    max24HourSend: res.SendQuota?.Max24HourSend ?? undefined,
    maxSendRate: res.SendQuota?.MaxSendRate ?? undefined,
    enforcementStatus: res.EnforcementStatus ?? undefined,
  };
}
