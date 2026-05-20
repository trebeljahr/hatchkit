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
