// Signing an outgoing webhook so the receiver can prove it came from here.
//
// The scheme is the industry-standard one: HMAC-SHA256 over
// `${timestamp}.${rawBody}`, hex, sent as `v1=<hex>`. The timestamp is INSIDE
// the signed string rather than merely alongside it, so a captured delivery
// cannot be replayed hours later with the timestamp header rewritten.
//
// Generic header names, not `X-__HATCHKIT_PROJECT_NAME__-*`: a project name
// can carry spaces, dots or non-ASCII, and none of those are legal in an HTTP
// field name. A receiver reads these from documentation either way.
import { createHmac, randomBytes } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADERS = {
  event: "X-Webhook-Event",
  delivery: "X-Webhook-Delivery",
  timestamp: "X-Webhook-Timestamp",
  signature: "X-Webhook-Signature",
} as const;

/** The version prefix on the signature header value. */
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/**
 * Sign one request body.
 *
 * `rawBody` MUST be the exact string that is then handed to `fetch` as `body`.
 * Re-serializing the envelope between signing and sending is the one failure
 * mode this signature has: `JSON.stringify` makes no ordering guarantee across
 * object identities, and a single reordered key produces a body the receiver
 * computes a different HMAC over and rejects as forged. Every delivery would
 * fail, and it would fail only against receivers that verify — that is, only
 * against the ones doing their job. Compute the string ONCE, sign that string,
 * send that string. `delivery.ts` has exactly one `JSON.stringify` for this
 * reason.
 */
export function signWebhookBody(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
}

/** A fresh subscription secret. 32 bytes of CSPRNG, shown once. */
export function mintWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}
