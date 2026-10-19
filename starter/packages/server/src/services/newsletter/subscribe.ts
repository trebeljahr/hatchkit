/**
 * Double-opt-in subscribe pipeline.
 *
 * The flow:
 *   1. Form POSTs to /api/newsletter/subscribe (handled in routes.ts).
 *   2. Server makes sure the address exists as a Listmonk subscriber
 *      on no list, mints an HMAC-signed token, and emails it via
 *      Listmonk's transactional template.
 *   3. User clicks the link, which GETs /api/newsletter/confirm. The
 *      handler verifies the token, adds the address to the list as
 *      `confirmed`, and redirects to /sub/confirmed.
 *
 * Nothing before step 3 touches list membership. See "Double opt-in
 * and list membership" in listmonk.ts for why.
 *
 * Tokens are stateless — no DB row, no Redis key. Validity is encoded
 * in the payload (`x` = expiry) and protected by `NEWSLETTER_TOKEN_SECRET`
 * via HMAC-SHA256. Compact format: `<base64url-payload>.<base64url-sig>`.
 *
 * Two kinds share the secret:
 *   confirm   `{ e: email, x, m?: magnet key }`
 *   download  `{ p: "dl", m: magnet key, x }` — the link in the lead-magnet
 *             email (see magnets.ts). Each verifier refuses the other
 *             kind's payload, so neither link works as the other.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ensureSubscriber,
  isConfirmedOnList,
  confirmSubscription as listmonkConfirm,
  sendTransactional,
} from "./listmonk.js";

// 21 days is the sweet spot: long enough that an email sitting in a
// vacation inbox still works on return, short enough that truly
// abandoned tokens stop being one click from a live subscription.
export const CONFIRM_TOKEN_TTL_MS = 21 * 24 * 60 * 60 * 1000;

// The download link only hands out a free file, so it can outlive the
// confirm link. A reader whose link expired enters the address in the
// form again and gets a new one.
export const DOWNLOAD_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function tokenSecret(): string {
  const explicit = process.env.NEWSLETTER_TOKEN_SECRET;
  if (explicit) return explicit;
  // Fall back to CRON_SECRET — common starter env that's already a
  // long random value. Keep this fallback documented in .env.example
  // so dev / first-time deploy works without a brand-new secret.
  const fallback = process.env.CRON_SECRET;
  if (fallback) return fallback;
  throw new Error("Missing NEWSLETTER_TOKEN_SECRET (or CRON_SECRET fallback)");
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

type TokenFailure = { ok: false; reason: "malformed" | "bad_signature" | "expired" };

function signToken(payload: object): string {
  const payloadStr = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64urlEncode(createHmac("sha256", tokenSecret()).update(payloadStr).digest());
  return `${payloadStr}.${sig}`;
}

/** Check the signature and expiry, and return the payload for the
 *  caller to check its shape. */
function openToken(
  token: string,
  now: number,
): { ok: true; payload: Record<string, unknown> } | TokenFailure {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadStr, sig] = parts;

  const expected = createHmac("sha256", tokenSecret()).update(payloadStr).digest();
  const provided = b64urlDecode(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(payloadStr).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null || typeof (payload as { x?: unknown }).x !== "number") {
    return { ok: false, reason: "malformed" };
  }
  const record = payload as Record<string, unknown>;
  if ((record.x as number) < now) return { ok: false, reason: "expired" };
  return { ok: true, payload: record };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** `magnet` is the lead magnet the reader asked for; the confirm route
 *  mails its download. The token is the only place it is kept. */
export function mintConfirmToken(
  email: string,
  opts: { magnet?: string } = {},
  now: number = Date.now(),
): string {
  return signToken({
    e: email.toLowerCase(),
    x: now + CONFIRM_TOKEN_TTL_MS,
    ...(opts.magnet ? { m: opts.magnet } : {}),
  });
}

export type VerifyResult = { ok: true; email: string; magnet?: string } | TokenFailure;

export function verifyConfirmToken(token: string, now: number = Date.now()): VerifyResult {
  const opened = openToken(token, now);
  if (!opened.ok) return opened;
  const { e, m, p } = opened.payload;
  if (typeof e !== "string" || p !== undefined || !optionalString(m)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, email: e, ...(m ? { magnet: m } : {}) };
}

export function mintDownloadToken(magnet: string, now: number = Date.now()): string {
  return signToken({ p: "dl", m: magnet, x: now + DOWNLOAD_TOKEN_TTL_MS });
}

export type DownloadVerifyResult = { ok: true; magnet: string } | TokenFailure;

export function verifyDownloadToken(token: string, now: number = Date.now()): DownloadVerifyResult {
  const opened = openToken(token, now);
  if (!opened.ok) return opened;
  const { p, m } = opened.payload;
  if (p !== "dl" || typeof m !== "string") return { ok: false, reason: "malformed" };
  return { ok: true, magnet: m };
}

// HTML5's good-enough check. The confirmation step is the actual proof
// of ownership, so this just keeps obvious garbage out.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

/** True when the address is already a confirmed member of the
 *  env-resolved list. Used by the subscribe route to short-circuit
 *  and skip the confirmation send for repeat signups. */
export async function isAlreadySubscribed(email: string): Promise<boolean> {
  try {
    return await isConfirmedOnList(email);
  } catch {
    // Listmonk hiccup → fall through to normal send path rather than
    // 500ing the public form.
    return false;
  }
}

export type SendConfirmationEmailParams = {
  to: string;
  /** Fully-qualified confirmation URL the recipient should click. */
  confirmUrl: string;
  /** Display name of the site/newsletter — shown in the email body
   *  and the call-to-action. Falls back to "this newsletter". */
  siteName?: string;
};

/** Render + send the double-opt-in confirmation email. Customise the
 *  HTML by editing `renderConfirmationHtml` below — the template is
 *  intentionally plain so projects can adapt it without dragging in
 *  react-email or a templating dependency. */
export async function sendConfirmationEmail(params: SendConfirmationEmailParams): Promise<void> {
  // The recipient must exist as a Listmonk subscriber before /api/tx
  // accepts the send. It stays off the list until the link is clicked
  // (see "Double opt-in and list membership" in listmonk.ts).
  await ensureSubscriber(params.to);
  const siteName = params.siteName ?? "this newsletter";
  await sendTransactional({
    to: params.to,
    subject: `Confirm your subscription · ${siteName}`,
    html: renderConfirmationHtml({ confirmUrl: params.confirmUrl, siteName }),
  });
}

function renderConfirmationHtml(args: { confirmUrl: string; siteName: string }): string {
  // Plain HTML on purpose — no react-email, no templating engine.
  // Adjust styling / branding by editing this function.
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="font-family:system-ui,sans-serif;line-height:1.55;color:#1a1a1a;max-width:560px;margin:0 auto;padding:32px 24px;">
    <h1 style="font-size:22px;margin:0 0 16px 0;font-weight:600;">Confirm your subscription</h1>
    <p style="margin:0 0 16px 0;">You're one click away from <strong>${esc(args.siteName)}</strong>.</p>
    <p style="margin:0 0 24px 0;">Tap the button below to verify this address and finish signing up. The link is good for 21 days.</p>
    <p style="margin:24px 0;">
      <a href="${esc(args.confirmUrl)}" style="display:inline-block;padding:12px 22px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">
        Confirm my subscription
      </a>
    </p>
    <p style="margin:24px 0 8px 0;font-size:13px;color:#555;">Or paste this URL into your browser:</p>
    <p style="margin:0 0 24px 0;font-size:13px;color:#555;word-break:break-all;">${esc(args.confirmUrl)}</p>
    <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0;">
    <p style="margin:0;font-size:12px;color:#777;">
      If you didn't sign up, ignore this email — no list membership is created until you click. The link expires in 21 days.
    </p>
  </body>
</html>`;
}

/** Thin re-export so route code can stay close to its previous shape. */
export { listmonkConfirm as confirmSubscription };

// Process-local fixed window: five requests per minute, with bounded storage.
// Workers and restarts have separate budgets; fleet-wide limits need a shared store.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 5;
const RATE_MAX_BUCKETS = 10_000;
const ipBuckets = new Map<string, { count: number; resetAt: number }>();
let nextSweepAt = 0;

export function checkRateLimit(ip: string, now: number = Date.now()): boolean {
  // Bound both retained identities and cleanup work (at most one sweep/second).
  if (now >= nextSweepAt) {
    for (const [key, bucket] of ipBuckets) {
      if (bucket.resetAt <= now) ipBuckets.delete(key);
    }
    nextSweepAt = now + 1_000;
  }
  let bucket = ipBuckets.get(ip);
  if (bucket && bucket.resetAt <= now) {
    ipBuckets.delete(ip);
    bucket = undefined;
  }
  if (!bucket) {
    // Never evict active budgets: churn must not reset an existing allowance.
    if (ipBuckets.size >= RATE_MAX_BUCKETS) return false;
    ipBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_MAX_PER_WINDOW) return false;
  bucket.count += 1;
  return true;
}

// The subscribe form mails a confirmed subscriber's download without a
// confirm step, so cap it per address as well as per IP: one email per
// address and magnet per 15 minutes, whatever IPs the posts come from.
// Process-local and bounded, like the IP limit above.
const DELIVERY_COOLDOWN_MS = 15 * 60_000;
const recentDeliveries = new Map<string, number>();

export function checkDeliveryCooldown(email: string, magnet: string, now: number = Date.now()): boolean {
  if (recentDeliveries.size >= RATE_MAX_BUCKETS) {
    for (const [key, until] of recentDeliveries) if (until <= now) recentDeliveries.delete(key);
    if (recentDeliveries.size >= RATE_MAX_BUCKETS) return false;
  }
  const key = `${email} ${magnet}`;
  if ((recentDeliveries.get(key) ?? 0) > now) return false;
  recentDeliveries.set(key, now + DELIVERY_COOLDOWN_MS);
  return true;
}

export function _resetRateLimit(): void {
  ipBuckets.clear();
  recentDeliveries.clear();
  nextSweepAt = 0;
}
