/**
 * Double-opt-in subscribe pipeline.
 *
 * The flow:
 *   1. Form POSTs to /api/newsletter/subscribe (handled in routes.ts).
 *   2. Server upserts the address as `unconfirmed` on the Listmonk
 *      list, mints an HMAC-signed token, and emails it via Listmonk's
 *      transactional template.
 *   3. User clicks the link, which GETs /api/newsletter/confirm. The
 *      handler verifies the token, promotes the subscription to
 *      `confirmed`, and redirects to /sub/confirmed.
 *
 * Tokens are stateless — no DB row, no Redis key. Validity is encoded
 * in the payload (`x` = expiry) and protected by `NEWSLETTER_TOKEN_SECRET`
 * via HMAC-SHA256. Compact format: `<base64url-payload>.<base64url-sig>`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isConfirmedOnList,
  confirmSubscription as listmonkConfirm,
  sendTransactional,
  upsertSubscriber,
} from "./listmonk.js";

// 21 days is the sweet spot: long enough that an email sitting in a
// vacation inbox still works on return, short enough that truly
// abandoned tokens stop being one click from a live subscription.
export const CONFIRM_TOKEN_TTL_MS = 21 * 24 * 60 * 60 * 1000;

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

type TokenPayload = { e: string; x: number };

export function mintConfirmToken(email: string, now: number = Date.now()): string {
  const payload: TokenPayload = { e: email.toLowerCase(), x: now + CONFIRM_TOKEN_TTL_MS };
  const payloadStr = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64urlEncode(createHmac("sha256", tokenSecret()).update(payloadStr).digest());
  return `${payloadStr}.${sig}`;
}

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyConfirmToken(token: string, now: number = Date.now()): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadStr, sig] = parts;

  const expected = createHmac("sha256", tokenSecret()).update(payloadStr).digest();
  const provided = b64urlDecode(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadStr).toString("utf8")) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.e !== "string" || typeof payload.x !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.x < now) return { ok: false, reason: "expired" };
  return { ok: true, email: payload.e };
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
  // accepts the send. Create them as `unconfirmed` so they show up in
  // the admin UI even if they never click the confirmation link.
  await upsertSubscriber(params.to, "unconfirmed");
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

// ─────────────────────────────────────────────────────────────────────
// Rate limiter — per-IP, sliding window, in-memory.
//
// Resets on container restart. Subscribe is a low-volume endpoint
// (~one POST per legitimate user, ever) and the worst-case after a
// restart is a small spam burst that ends at the Listmonk dedupe
// layer anyway. A real shared store would be overkill.
// ─────────────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 5;
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(ip: string, now: number = Date.now()): boolean {
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_MAX_PER_WINDOW) return false;
  bucket.count += 1;
  return true;
}

export function _resetRateLimit(): void {
  ipBuckets.clear();
}
