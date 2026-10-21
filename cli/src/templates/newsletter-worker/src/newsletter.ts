/**
 * Mailing-list double opt-in, lead-magnet downloads and the cleanup of
 * never-confirmed subscribers, for a static site with no server of its
 * own. A port of the hatchkit starter's newsletter service
 * (packages/server/src/services/newsletter); keep the two in step.
 *
 *   POST /api/newsletter/subscribe  form post → confirmation mail → 303 /sub/check-email
 *   GET  /api/newsletter/confirm    signed link → list membership (+ download mail) → 303 /sub/confirmed
 *   GET  /api/newsletter/download   signed link → the lead-magnet file
 *   cron (daily)                    delete subscribers that never confirmed (30 days)
 *
 * Membership order matters (see "Double opt-in" in hatchkit's email docs):
 * the address exists as a Listmonk subscriber on NO list until the link
 * is clicked, then it joins the list as `confirmed`. Adding it earlier
 * would make Listmonk send its own shared-sender opt-in mail as well.
 *
 * Tokens are stateless: `<base64url payload>.<base64url HMAC-SHA256>`,
 * keyed by NEWSLETTER_TOKEN_SECRET. Confirm payload `{ e, x, m? }`
 * (email, expiry ms, magnet key); download payload `{ p: "dl", m, x }`.
 * Each verifier refuses the other kind. The tokens are the only place a
 * magnet key is kept: the Listmonk subscriber gets no attribs, so it
 * holds no record of which page or site the signup came from.
 *
 * Every response to the form is a redirect, so the form works without JS.
 * Valid addresses always land on the same "check your inbox" page, whether
 * or not they were already subscribed, so the form cannot be used to probe
 * who is on the list.
 */

import magnetsJson from "./magnets.json";

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The part of an R2 bucket binding this Worker uses. */
export interface MagnetBucket {
  get(key: string): Promise<{
    body: ReadableStream;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
}

export interface Env {
  LISTMONK_URL: string;
  LISTMONK_API_USER: string;
  LISTMONK_API_TOKEN: string;
  LISTMONK_TX_TEMPLATE_ID: string;
  LISTMONK_FROM: string;
  LISTMONK_LIST_ID: string;
  NEWSLETTER_TOKEN_SECRET: string;
  /** Origin of the static site that holds /sub/* pages. */
  SITE_URL: string;
  /** Origin this Worker answers on; the confirm and download links point here. */
  API_URL: string;
  SITE_NAME: string;
  SUBSCRIBE_LIMITER?: RateLimit;
  /** R2 bucket holding `object` magnets. Only needed when one exists. */
  MAGNETS?: MagnetBucket;
}

// 21 days, as in the starter: a mail that waits in a holiday inbox still
// works, an abandoned one stops being one click from a subscription.
export const CONFIRM_TOKEN_TTL_MS = 21 * 24 * 60 * 60 * 1000;
// The download link only hands out a free file. A reader whose link
// expired posts the form again and gets a new one.
export const DOWNLOAD_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const UNCONFIRMED_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const SUBSCRIBE_PATH = "/api/newsletter/subscribe";
const CONFIRM_PATH = "/api/newsletter/confirm";
const DOWNLOAD_PATH = "/api/newsletter/download";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === SUBSCRIBE_PATH) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return handleSubscribe(request, env);
  }
  if (url.pathname === CONFIRM_PATH || url.pathname === DOWNLOAD_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
    return url.pathname === CONFIRM_PATH ? handleConfirm(url, env) : handleDownload(url, env);
  }
  return new Response("Not found", { status: 404 });
}

/** Cron trigger (wrangler.jsonc `triggers.crons`). */
export async function handleScheduled(
  _controller: unknown,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  ctx.waitUntil(
    pruneUnconfirmed(env).catch((err: unknown) => {
      log("error", "prune", "failed", { message: (err as Error).message });
    }),
  );
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", { status: 405, headers: { Allow: allow } });
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, "");
}

function redirect(env: Env, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${trimSlash(env.SITE_URL)}${path}`, "Cache-Control": "no-store" },
  });
}

function log(level: "info" | "error", scope: string, event: string, extra: object = {}): void {
  const line = JSON.stringify({ scope: `newsletter.${scope}`, level, event, ...extra });
  if (level === "error") console.error(line);
  else console.info(line);
}

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (env.SUBSCRIBE_LIMITER) {
    const { success } = await env.SUBSCRIBE_LIMITER.limit({ key: ip });
    if (!success) {
      log("info", "subscribe", "rate_limited");
      return redirect(env, "/sub/error?reason=rate_limited");
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(env, "/sub/error?reason=invalid_email");
  }

  // Honeypot: hidden from people, filled by bots. Answer like a success
  // so a bot learns nothing about what tripped it.
  const website = form.get("website");
  if (typeof website === "string" && website.trim().length > 0) {
    log("info", "subscribe", "honeypot_triggered");
    return redirect(env, "/sub/check-email");
  }

  const email = normalizeEmail(form.get("email"));
  if (!email) return redirect(env, "/sub/error?reason=invalid_email");

  // A magnet is named by its key in magnets.json, never by a URL.
  const magnetField = form.get("magnet");
  let magnet: Magnet | undefined;
  if (typeof magnetField === "string" && magnetField !== "") {
    magnet = getMagnet(magnetField);
    if (!magnet) {
      log("error", "subscribe", "unknown_magnet", { magnet: magnetField.slice(0, 64) });
      return redirect(env, "/sub/error?reason=unknown_magnet");
    }
  }

  try {
    if (await isConfirmedOnList(env, email)) {
      log("info", "subscribe", "already_subscribed");
      // A confirmed member who asks for a download gets it at once; the
      // address is proven. Same page either way, so nothing is revealed.
      // A limiter key per address caps how often the form mails one inbox,
      // whatever IPs the posts come from.
      if (magnet) {
        if (env.SUBSCRIBE_LIMITER && !(await env.SUBSCRIBE_LIMITER.limit({ key: `mail:${email}` })).success) {
          log("info", "subscribe", "delivery_rate_limited", { magnet: magnet.key });
          return redirect(env, "/sub/check-email");
        }
        if (!(await deliverMagnet(env, email, magnet, "subscribe"))) {
          return redirect(env, "/sub/error?reason=send_failed");
        }
      }
      return redirect(env, "/sub/check-email");
    }
    const token = await mintConfirmToken(env.NEWSLETTER_TOKEN_SECRET, email, { magnet: magnet?.key });
    const confirmUrl = `${trimSlash(env.API_URL)}${CONFIRM_PATH}?token=${encodeURIComponent(token)}`;
    await ensureSubscriber(env, email);
    await sendTransactional(env, {
      to: email,
      subject: `Confirm your subscription · ${env.SITE_NAME}`,
      html: renderConfirmationHtml({ confirmUrl, siteName: env.SITE_NAME }),
    });
  } catch (err) {
    log("error", "subscribe", "send_confirmation_failed", { message: (err as Error).message });
    return redirect(env, "/sub/error?reason=send_failed");
  }

  log("info", "subscribe", "confirmation_sent", magnet ? { magnet: magnet.key } : {});
  return redirect(env, "/sub/check-email");
}

async function handleConfirm(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!token) return redirect(env, "/sub/error?reason=missing");

  const result = await verifyConfirmToken(env.NEWSLETTER_TOKEN_SECRET, token);
  if (!result.ok) {
    log("info", "confirm", "verify_failed", { reason: result.reason });
    return redirect(env, `/sub/error?reason=${result.reason}`);
  }

  let alreadyConfirmed: boolean;
  try {
    ({ alreadyConfirmed } = await confirmSubscription(env, result.email));
  } catch (err) {
    log("error", "confirm", "list_add_failed", { message: (err as Error).message });
    return redirect(env, "/sub/error?reason=list_add_failed");
  }

  // The membership is live whatever happens next, so a failed send never
  // bounces the reader to the error page. Only the first click sends the
  // download: mail scanners often open the link before the reader, and
  // the reader's own click must not send a second copy. The form sends
  // a fresh link.
  let delivery: "sent" | "failed" | undefined;
  if (result.magnet && !alreadyConfirmed) {
    const magnet = getMagnet(result.magnet);
    if (magnet) {
      delivery = (await deliverMagnet(env, result.email, magnet, "confirm")) ? "sent" : "failed";
    } else {
      log("error", "delivery", "delivery_failed", {
        magnet: result.magnet,
        via: "confirm",
        message: "magnet is no longer in magnets.json",
      });
      delivery = "failed";
    }
  }

  log("info", "confirm", "confirmed", delivery ? { delivery } : {});
  return redirect(env, `/sub/confirmed${delivery ? `?delivery=${delivery}` : ""}`);
}

async function handleDownload(url: URL, env: Env): Promise<Response> {
  const directKey = url.searchParams.get("key");
  if (directKey !== null && !getMagnet(directKey)) return new Response("Download unavailable", { status: 404 });
  const result = directKey !== null
    ? { ok: true as const, magnet: directKey }
    : await verifyDownloadToken(env.NEWSLETTER_TOKEN_SECRET, url.searchParams.get("token") ?? "");
  if (!result.ok) {
    log("info", "download", "verify_failed", { reason: result.reason });
    return redirect(env, `/sub/error?reason=${result.reason === "expired" ? "download_expired" : "download_invalid"}`);
  }

  const magnet = getMagnet(result.magnet);
  if (magnet?.url) {
    log("info", "download", "served", { magnet: magnet.key });
    return new Response(null, {
      status: 302,
      headers: { Location: magnet.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  const object = magnet?.object ? await env.MAGNETS?.get(magnet.object) : null;
  if (!magnet || !object) {
    log("error", "download", "unavailable", {
      magnet: result.magnet,
      message: !magnet ? "magnet is no longer in magnets.json" : env.MAGNETS ? "object missing from the bucket" : "no MAGNETS bucket binding",
    });
    return redirect(env, "/sub/error?reason=download_unavailable");
  }

  log("info", "download", "served", { magnet: magnet.key });
  const key = magnet.object as string;
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(object.size),
      "Content-Disposition": attachmentDisposition(magnet.filename ?? key.split("/").pop() ?? key),
      "Cache-Control": "private, no-store",
    },
  });
}

/** Send the download mail and log the outcome; never throws. `/api/tx`
 *  answers once Listmonk has queued the mail, before SMTP runs, so an SES
 *  rejection after that shows only in Listmonk → Settings → Logs. */
async function deliverMagnet(env: Env, to: string, magnet: Magnet, via: "confirm" | "subscribe"): Promise<boolean> {
  try {
    const token = await mintDownloadToken(env.NEWSLETTER_TOKEN_SECRET, magnet.key);
    const downloadUrl = `${trimSlash(env.API_URL)}${DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`;
    await sendTransactional(env, {
      to,
      subject: `Your download: ${magnet.title} · ${env.SITE_NAME}`,
      html: renderMagnetHtml({ title: magnet.title, downloadUrl, siteName: env.SITE_NAME }),
    });
  } catch (err) {
    log("error", "delivery", "delivery_failed", { magnet: magnet.key, via, message: (err as Error).message });
    return false;
  }
  log("info", "delivery", "delivery_sent", { magnet: magnet.key, via });
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Lead magnets (magnets.json — same shape as the starter's)
//
//   { "wallpapers": { "title": "Wallpaper pack", "object": "magnets/wallpapers.zip" },
//     "reading-list": { "title": "Reading list", "url": "https://example.com/list.pdf" } }
//
// `object` is a key in the R2 bucket bound as MAGNETS, streamed by the
// download route. `url` is an https URL it redirects to. `filename` is
// optional. Removing an entry stops every link already sent for it, until
// an entry with the same key is added again (tokens carry only the key).
// ─────────────────────────────────────────────────────────────────────

export type Magnet = { key: string; title: string; object?: string; url?: string; filename?: string };

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FILENAME_RE = /^[^/\\"\r\n]{1,200}$/;

/** Validate magnets.json. An invalid entry is left out and reported. */
export function parseMagnets(raw: unknown): { magnets: Map<string, Magnet>; problems: string[] } {
  const magnets = new Map<string, Magnet>();
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { magnets, problems: ["magnets.json must be a JSON object keyed by magnet key"] };
  }
  for (const [key, value] of Object.entries(raw)) {
    const e = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    let problem: string | null = null;
    let url: URL | null = null;
    try {
      url = e.url === undefined ? null : new URL(String(e.url));
    } catch {
      // reported below
    }
    if (!KEY_RE.test(key)) problem = "key must be lowercase letters, digits and dashes (max 48)";
    else if (typeof e.title !== "string" || e.title.trim() === "") problem = "needs a title";
    else if ((e.object === undefined) === (e.url === undefined)) problem = "needs exactly one of `object` or `url`";
    else if (
      e.object !== undefined &&
      (typeof e.object !== "string" || e.object === "" || e.object.startsWith("/") || e.object.split("/").includes(".."))
    )
      problem = "`object` must be a bucket key such as magnets/file.zip";
    else if (e.url !== undefined && url?.protocol !== "https:") problem = "`url` must be an https URL";
    else if (e.filename !== undefined && (typeof e.filename !== "string" || !FILENAME_RE.test(e.filename)))
      problem = "`filename` must be a plain file name";
    if (problem) {
      problems.push(`${key}: ${problem}`);
      continue;
    }
    magnets.set(key, {
      key,
      title: (e.title as string).trim(),
      ...(typeof e.object === "string" ? { object: e.object } : {}),
      ...(typeof e.url === "string" ? { url: e.url } : {}),
      ...(typeof e.filename === "string" ? { filename: e.filename } : {}),
    });
  }
  return { magnets, problems };
}

let magnetCache: Map<string, Magnet> | null = null;

function getMagnet(key: string): Magnet | undefined {
  if (!magnetCache) {
    const { magnets, problems } = parseMagnets(magnetsJson);
    if (problems.length) log("error", "magnets", "config_invalid", { problems });
    magnetCache = magnets;
  }
  return magnetCache.get(key);
}

/** Replace magnets.json for a test; `null` goes back to the file. */
export function _setMagnetsForTests(raw: unknown | null): void {
  magnetCache = raw === null ? null : parseMagnets(raw).magnets;
}

/** RFC 6266: an ASCII `filename` for old agents plus a UTF-8 `filename*`. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("Missing NEWSLETTER_TOKEN_SECRET");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

type TokenFailure = { ok: false; reason: "malformed" | "bad_signature" | "expired" };

async function signToken(secret: string, payload: object): Promise<string> {
  const payloadStr = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payloadStr));
  return `${payloadStr}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function openToken(
  secret: string,
  token: string,
  now: number,
): Promise<{ ok: true; payload: Record<string, unknown> } | TokenFailure> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadStr, sigStr] = parts;

  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlDecode(sigStr);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(payloadStr)))) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadStr)));
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

const optionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";

export async function mintConfirmToken(
  secret: string,
  email: string,
  opts: { magnet?: string } = {},
  now: number = Date.now(),
): Promise<string> {
  return signToken(secret, {
    e: email.toLowerCase(),
    x: now + CONFIRM_TOKEN_TTL_MS,
    ...(opts.magnet ? { m: opts.magnet } : {}),
  });
}

export type VerifyResult = { ok: true; email: string; magnet?: string } | TokenFailure;

export async function verifyConfirmToken(secret: string, token: string, now: number = Date.now()): Promise<VerifyResult> {
  const opened = await openToken(secret, token, now);
  if (!opened.ok) return opened;
  const { e, m, p } = opened.payload;
  if (typeof e !== "string" || p !== undefined || !optionalString(m)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, email: e, ...(m ? { magnet: m } : {}) };
}

export async function mintDownloadToken(secret: string, magnet: string, now: number = Date.now()): Promise<string> {
  return signToken(secret, { p: "dl", m: magnet, x: now + DOWNLOAD_TOKEN_TTL_MS });
}

export async function verifyDownloadToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<{ ok: true; magnet: string } | TokenFailure> {
  const opened = await openToken(secret, token, now);
  if (!opened.ok) return opened;
  const { p, m } = opened.payload;
  if (p !== "dl" || typeof m !== "string") return { ok: false, reason: "malformed" };
  return { ok: true, magnet: m };
}

// HTML5's good-enough check. The confirm click is the real proof of
// ownership; this only keeps obvious garbage out.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────
// Listmonk
// ─────────────────────────────────────────────────────────────────────

type ListmonkSubscriber = {
  id: number;
  email: string;
  status?: "enabled" | "disabled" | "blocklisted";
  created_at?: string;
  lists?: { id: number; subscription_status: "unconfirmed" | "confirmed" | "unsubscribed" }[];
};

async function listmonkFetch<T = unknown>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${trimSlash(env.LISTMONK_URL)}${path}`, {
    ...init,
    headers: {
      Authorization: `token ${env.LISTMONK_API_USER}:${env.LISTMONK_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Listmonk error bodies are short JSON messages; cap them anyway.
    throw new Error(`listmonk ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 200)}`);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function listId(env: Env): number {
  const n = Number(env.LISTMONK_LIST_ID);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid LISTMONK_LIST_ID: ${env.LISTMONK_LIST_ID}`);
  return n;
}

function escRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findSubscriber(env: Env, email: string): Promise<ListmonkSubscriber | null> {
  // `search` is a Postgres regex over name and email; anchor and quote it
  // so `a+b@x.com` matches itself, then keep only the exact email.
  const params = new URLSearchParams({ search: `^${escRegex(email)}$`, per_page: "all" });
  const res = await listmonkFetch<{ data: { results: ListmonkSubscriber[] } }>(env, `/api/subscribers?${params}`);
  return res.data.results.find((s) => s.email.toLowerCase() === email) ?? null;
}

async function isConfirmedOnList(env: Env, email: string): Promise<boolean> {
  const id = listId(env);
  const sub = await findSubscriber(env, email);
  return sub?.lists?.find((l) => l.id === id)?.subscription_status === "confirmed";
}

/** Writes no attribs. Never update an existing subscriber with
 *  `PUT /api/subscribers/:id`: it deletes every membership missing from
 *  its `lists`, i.e. every other project's. */
async function createSubscriber(env: Env, email: string, listIds: number[]): Promise<void> {
  await listmonkFetch(env, "/api/subscribers", {
    method: "POST",
    body: JSON.stringify({
      email,
      // Listmonk needs a non-empty name; the form asks only for the address.
      name: email,
      status: "enabled",
      lists: listIds,
      // Marks lists in `listIds` confirmed and suppresses Listmonk's own
      // opt-in mail, which would go out from the shared sender.
      preconfirm_subscriptions: true,
    }),
  });
}

/** Make sure the address exists as a subscriber, on no list. An existing
 *  subscriber stays untouched: it may be on other projects' lists, or
 *  unsubscribed from ours, and a repeat form post must not change that. */
async function ensureSubscriber(env: Env, email: string): Promise<void> {
  if (!(await findSubscriber(env, email))) await createSubscriber(env, email, []);
}

/** Add the address to the list as `confirmed`. Idempotent. A subscriber
 *  deleted since the token was issued is created again on the list. */
async function confirmSubscription(env: Env, email: string): Promise<{ alreadyConfirmed: boolean }> {
  const id = listId(env);
  const existing = await findSubscriber(env, email);
  if (!existing) {
    await createSubscriber(env, email, [id]);
    return { alreadyConfirmed: false };
  }
  const alreadyConfirmed = existing.lists?.find((l) => l.id === id)?.subscription_status === "confirmed";
  await listmonkFetch(env, "/api/subscribers/lists", {
    method: "PUT",
    body: JSON.stringify({ ids: [existing.id], action: "add", target_list_ids: [id], status: "confirmed" }),
  });
  return { alreadyConfirmed };
}

/** Send through Listmonk's passthrough tx template, which renders
 *  `{{ .Tx.Data.subject }}` and `{{ .Tx.Data.body | Safe }}`. `from_email`
 *  is what keeps this off Listmonk's shared default sender. */
async function sendTransactional(env: Env, params: { to: string; subject: string; html: string }): Promise<void> {
  await listmonkFetch(env, "/api/tx", {
    method: "POST",
    body: JSON.stringify({
      subscriber_email: params.to,
      template_id: Number(env.LISTMONK_TX_TEMPLATE_ID),
      from_email: env.LISTMONK_FROM,
      data: { subject: params.subject, body: params.html },
      content_type: "html",
      messenger: "email",
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup of never-confirmed subscribers (same rule as the starter's prune.ts)
//
// Deleted only when all hold: on no list (the form creates the
// subscriber there; only the confirm click adds one), status `enabled`
// (a blocklisted or disabled one must stay to keep its block), and
// Listmonk created it more than 30 days ago. Nothing on a subscriber
// says which form made it, so this covers the whole shared instance;
// every project's form follows the same rule. It also deletes an address
// whose only list was deleted or whose membership was removed by hand:
// there is no subscription left to keep it for.
//
// Guards: each candidate is read again just before the delete, so a
// confirm click in between keeps it; at most MAX_PRUNE_PER_RUN go per
// run; and nothing is deleted when more than half of the enabled
// subscribers look unconfirmed, which is what a Listmonk change that hid
// other projects' memberships from this API user would look like. It
// needs `subscribers:get_all` and `subscribers:manage`, which hatchkit's
// per-project API user has.
// ─────────────────────────────────────────────────────────────────────

const MAX_PRUNE_PER_RUN = 500;

function isUnconfirmed(s: ListmonkSubscriber, cutoff: number): boolean {
  if (s.status !== "enabled" || (s.lists?.length ?? 0) > 0) return false;
  const created = s.created_at ? Date.parse(s.created_at) : Number.NaN;
  return Number.isFinite(created) && created < cutoff;
}

export async function pruneUnconfirmed(
  env: Env,
  now: number = Date.now(),
): Promise<{ total: number; candidates: number; deleted: number; refused?: boolean }> {
  const cutoff = now - UNCONFIRMED_TTL_DAYS * DAY_MS;
  const res = await listmonkFetch<{ data: { results: ListmonkSubscriber[] } }>(env, "/api/subscribers?per_page=all");
  const all = res.data.results;
  const stale = all.filter((s) => isUnconfirmed(s, cutoff));
  const enabled = all.filter((s) => s.status === "enabled").length;
  if (stale.length > 10 && stale.length * 2 > enabled) {
    log("error", "prune", "refused", { total: all.length, candidates: stale.length });
    return { total: all.length, candidates: stale.length, deleted: 0, refused: true };
  }
  let deleted = 0;
  const batch = stale.slice(0, MAX_PRUNE_PER_RUN);
  for (let i = 0; i < batch.length; i += 100) {
    const ids: number[] = [];
    for (const s of batch.slice(i, i + 100)) {
      const fresh = await listmonkFetch<{ data: ListmonkSubscriber }>(env, `/api/subscribers/${s.id}`).catch(() => null);
      if (fresh && isUnconfirmed(fresh.data, cutoff)) ids.push(s.id);
    }
    if (ids.length === 0) continue;
    const params = new URLSearchParams(ids.map((id) => ["id", String(id)]));
    await listmonkFetch(env, `/api/subscribers?${params}`, { method: "DELETE" });
    deleted += ids.length;
  }
  log("info", "prune", "pruned", { total: all.length, candidates: stale.length, deleted });
  return { total: all.length, candidates: stale.length, deleted };
}

// ─────────────────────────────────────────────────────────────────────
// Email bodies. Plain HTML on purpose; edit the copy here.
// ─────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const WRAP = "font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#1a1a1a;max-width:560px;margin:0 auto;padding:32px 24px;";
const BUTTON = "display:inline-block;padding:12px 22px;background:#111;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;";

function renderConfirmationHtml(args: { confirmUrl: string; siteName: string }): string {
  const url = esc(args.confirmUrl);
  return `<div style="${WRAP}">
  <h1 style="font-size:22px;margin:0 0 16px 0;font-weight:600;">Confirm your subscription</h1>
  <p style="margin:0 0 16px 0;">You asked to join the <strong>${esc(args.siteName)}</strong> mailing list.</p>
  <p style="margin:0 0 24px 0;">Click the button to confirm this address. The link works for 21 days.</p>
  <p style="margin:24px 0;"><a href="${url}" style="${BUTTON}">Confirm my subscription</a></p>
  <p style="margin:24px 0 8px 0;font-size:13px;color:#555;">Or paste this URL into your browser:</p>
  <p style="margin:0 0 24px 0;font-size:13px;color:#555;word-break:break-all;">${url}</p>
  <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0;">
  <p style="margin:0;font-size:12px;color:#777;">If you did not sign up, ignore this email. You join the list only if you click the link.</p>
</div>`;
}

function renderMagnetHtml(args: { title: string; downloadUrl: string; siteName: string }): string {
  const url = esc(args.downloadUrl);
  return `<div style="${WRAP}">
  <h1 style="font-size:22px;margin:0 0 16px 0;font-weight:600;">${esc(args.title)}</h1>
  <p style="margin:0 0 24px 0;">Here is the download you asked for from <strong>${esc(args.siteName)}</strong>.</p>
  <p style="margin:24px 0;"><a href="${url}" style="${BUTTON}">Download</a></p>
  <p style="margin:24px 0 8px 0;font-size:13px;color:#555;">Or paste this URL into your browser:</p>
  <p style="margin:0 0 24px 0;font-size:13px;color:#555;word-break:break-all;">${url}</p>
  <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0;">
  <p style="margin:0;font-size:12px;color:#777;">The link works for 30 days. To get a new one, enter your address in the signup form again.</p>
</div>`;
}
