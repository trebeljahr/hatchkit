/*
 * Paid unlock: a buyer pays through Stripe Checkout and gets a page, a
 * download or an email. One core for both runtimes: the Cloudflare Worker
 * (workers/unlock) and the Express server (services/unlock). It uses only
 * fetch, URL, Request/Response and WebCrypto, so it runs unchanged in both.
 *
 * Copied from hatchkit (cli/src/paid-unlock/core.ts).
 * `hatchkit add <project> paid-unlock` refreshes the copy and reports a
 * conflict, instead of overwriting, when the copy was edited.
 *
 * The model:
 *
 *   · Record: the paid Stripe Checkout Session, tagged with
 *     metadata.hatchkit_project and metadata.hatchkit_unlock. There is no
 *     buyer database. Stripe keeps the email and the payment anyway.
 *   · Proof: an HMAC-signed token {k: unlock key, s: session id}. It sits
 *     in an HttpOnly cookie per product, and in the link the purchase email
 *     carries. Links are checked against Stripe on every use; a cookie once
 *     every 24 hours. A full refund, an open dispute or a subscription that
 *     is no longer active ends access.
 *   · The webhook sends the purchase email once, and marks the
 *     PaymentIntent (or Subscription) metadata so a Stripe retry does not
 *     mail twice.
 *
 * Routes (all under /api/unlock, plus the page prefix, default /paid):
 *
 *   POST /api/unlock/checkout            form: product → 303 to Stripe Checkout
 *   GET  /api/unlock/return?session_id=  after Checkout → cookie → 303 to the product
 *   GET  /api/unlock/claim?t=            link from the email → cookie → 303
 *   GET  /api/unlock/files/<key>         file list of a download product
 *   GET  /api/unlock/download/<key>/<n>  one file (cookie or ?t=)
 *   GET  /api/unlock/sent/<key>          "sent to your email" for an email product
 *   GET  /api/unlock/status/<key>        {"unlocked": bool} for the site's own UI
 *   GET|POST /api/unlock/restore         form: email → mails fresh links
 *   POST /api/unlock/manage              form: product → Stripe customer portal
 *   POST /api/unlock/webhook             Stripe events
 *   GET  <pagePrefix>/<key>/...          page product, gated
 */

export const STRIPE_API_VERSION = "2025-03-31.basil";
export const API_PREFIX = "/api/unlock";
export const DEFAULT_PAGE_PREFIX = "/paid";
/** A cookie older than this is checked against Stripe again. */
export const COOKIE_RECHECK_MS = 24 * 60 * 60 * 1000;
/** The Checkout return URL works this long after the session was created.
 *  After that, the buyer uses the link in the purchase email. */
export const RETURN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Stripe's signature timestamp tolerance. */
export const WEBHOOK_TOLERANCE_S = 300;
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
/** Most purchases one restore email lists. */
const RESTORE_MAX = 20;

export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FILENAME_RE = /^[^/\\"\r\n]{1,200}$/;
const EMAIL_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,99}\.html$/;
const TAX_CODE_RE = /^txcd_\d{8}$/;
const PAGE_PREFIX_RE = /^\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

/* ================================================================== */
/* Config (unlocks.json)                                              */
/* ================================================================== */

export type UnlockKind = "page" | "download" | "email";
export const UNLOCK_KINDS: readonly UnlockKind[] = ["page", "download", "email"];

/** A fixed price in the smallest currency unit (cents), or pay what you
 *  want: Stripe's custom_unit_amount with a minimum and a suggested amount. */
export type UnlockPrice = number | { min: number; preset?: number; max?: number };

export interface UnlockFile {
  /** Key in the private bucket (Worker: R2 binding FILES; server: S3
   *  bucket, or unlock-private/files/ without one). */
  object: string;
  /** Name the browser saves it as. Defaults to the object's last segment. */
  filename?: string;
}

export interface UnlockProduct {
  name: string;
  description?: string;
  kind: UnlockKind;
  price: UnlockPrice;
  /** Present: a subscription. Access lasts while it is active. */
  interval?: "month" | "year";
  /** download: the files. */
  files?: UnlockFile[];
  /** email: file name in the private folder's emails/ directory. */
  email?: string;
  /** email: subject line. Defaults to the product name. */
  subject?: string;
  /** Stripe Tax product code, used when automaticTax is on. */
  taxCode?: string;
  /** false: no new sales. Buyers keep access. */
  active?: boolean;
}

export interface UnlockConfig {
  /** hatchkit project slug. Tags every Stripe object, so one project
   *  ignores another's events in a shared account. */
  project: string;
  /** ISO currency, lowercase. */
  currency: string;
  /** Stripe Tax on the Checkout Session. Needs registrations in Stripe. */
  automaticTax?: boolean;
  /** One line shown above Stripe's pay button and in every purchase email. */
  refundPolicy?: string;
  /** URL prefix of page products. Default /paid. */
  pagePrefix?: string;
  products: Record<string, UnlockProduct>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Every problem in one product entry, phrased for a person. */
export function unlockProductProblems(key: string, raw: unknown): string[] {
  const out: string[] = [];
  const at = `products.${key}`;
  if (!KEY_RE.test(key))
    out.push(`${at}: the key must be lowercase letters, digits and dashes (max 48)`);
  if (!isRecord(raw)) return [...out, `${at} must be an object`];
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 120)
    out.push(`${at}.name must be 1 to 120 characters`);
  if (
    raw.description !== undefined &&
    (typeof raw.description !== "string" || raw.description.length > 500)
  )
    out.push(`${at}.description must be at most 500 characters`);
  if (!UNLOCK_KINDS.includes(raw.kind as UnlockKind))
    out.push(`${at}.kind must be one of ${UNLOCK_KINDS.join(", ")}`);
  if (raw.interval !== undefined && raw.interval !== "month" && raw.interval !== "year")
    out.push(`${at}.interval must be "month" or "year"`);
  const price = raw.price;
  if (isAmount(price)) {
    if (price < 1) out.push(`${at}.price must be at least 1 (smallest currency unit)`);
  } else if (isRecord(price)) {
    if (raw.interval !== undefined)
      out.push(`${at}: Stripe has no pay-what-you-want for subscriptions; give a fixed price`);
    if (!isAmount(price.min))
      out.push(`${at}.price.min must be a whole amount in the smallest unit`);
    if (
      price.preset !== undefined &&
      (!isAmount(price.preset) || (isAmount(price.min) && price.preset < price.min))
    )
      out.push(`${at}.price.preset must be a whole amount, at least price.min`);
    if (
      price.max !== undefined &&
      (!isAmount(price.max) || (isAmount(price.min) && price.max < price.min))
    )
      out.push(`${at}.price.max must be a whole amount, at least price.min`);
    for (const extra of Object.keys(price))
      if (!["min", "preset", "max"].includes(extra))
        out.push(`${at}.price has an unknown field "${extra}"`);
  } else {
    out.push(
      `${at}.price must be an amount in the smallest unit (900 = 9.00) or {"min": …, "preset": …}`,
    );
  }
  if (raw.kind === "download") {
    if (!Array.isArray(raw.files) || raw.files.length === 0) {
      out.push(`${at}.files must list at least one file`);
    } else {
      raw.files.forEach((file, i) => {
        if (!isRecord(file) || typeof file.object !== "string") {
          out.push(`${at}.files[${i}].object must be a bucket key`);
          return;
        }
        if (!file.object || file.object.startsWith("/") || file.object.split("/").includes(".."))
          out.push(`${at}.files[${i}].object must be a bucket key such as paid/file.zip`);
        if (
          file.filename !== undefined &&
          (typeof file.filename !== "string" || !FILENAME_RE.test(file.filename))
        )
          out.push(`${at}.files[${i}].filename must be a plain file name`);
      });
    }
  } else if (raw.files !== undefined) {
    out.push(`${at}.files belongs only to a download product`);
  }
  if (raw.kind === "email") {
    if (typeof raw.email !== "string" || !EMAIL_FILE_RE.test(raw.email))
      out.push(
        `${at}.email must name an .html file in the private emails/ folder, e.g. "letters.html"`,
      );
    if (
      raw.subject !== undefined &&
      (typeof raw.subject !== "string" || !raw.subject.trim() || raw.subject.length > 200)
    )
      out.push(`${at}.subject must be 1 to 200 characters`);
  } else if (raw.email !== undefined || raw.subject !== undefined) {
    out.push(`${at}.email and .subject belong only to an email product`);
  }
  if (
    raw.taxCode !== undefined &&
    (typeof raw.taxCode !== "string" || !TAX_CODE_RE.test(raw.taxCode))
  )
    out.push(`${at}.taxCode must look like txcd_10000000`);
  if (raw.active !== undefined && typeof raw.active !== "boolean")
    out.push(`${at}.active must be true or false`);
  const known = [
    "name",
    "description",
    "kind",
    "price",
    "interval",
    "files",
    "email",
    "subject",
    "taxCode",
    "active",
  ];
  for (const extra of Object.keys(raw))
    if (!known.includes(extra)) out.push(`${at} has an unknown field "${extra}"`);
  return out;
}

/** Every problem in unlocks.json. Empty means valid. */
export function unlockConfigProblems(raw: unknown): string[] {
  if (!isRecord(raw)) return ["unlocks.json must be a JSON object"];
  const out: string[] = [];
  if (typeof raw.project !== "string" || !KEY_RE.test(raw.project))
    out.push('"project" must be the hatchkit project slug (lowercase letters, digits, dashes)');
  if (typeof raw.currency !== "string" || !/^[a-z]{3}$/.test(raw.currency))
    out.push('"currency" must be a lowercase ISO code such as "eur"');
  if (raw.automaticTax !== undefined && typeof raw.automaticTax !== "boolean")
    out.push('"automaticTax" must be true or false');
  if (
    raw.refundPolicy !== undefined &&
    (typeof raw.refundPolicy !== "string" || raw.refundPolicy.length > 500)
  )
    out.push('"refundPolicy" must be one line of at most 500 characters');
  if (raw.pagePrefix !== undefined) {
    if (typeof raw.pagePrefix !== "string" || !PAGE_PREFIX_RE.test(raw.pagePrefix))
      out.push('"pagePrefix" must be a path such as "/paid" (no trailing slash)');
    else if (raw.pagePrefix === API_PREFIX || raw.pagePrefix.startsWith(`${API_PREFIX}/`))
      out.push(`"pagePrefix" must not be inside ${API_PREFIX}`);
  }
  if (!isRecord(raw.products)) out.push('"products" must be an object keyed by product key');
  else
    for (const [key, product] of Object.entries(raw.products))
      out.push(...unlockProductProblems(key, product));
  const known = [
    "$schema",
    "project",
    "currency",
    "automaticTax",
    "refundPolicy",
    "pagePrefix",
    "products",
  ];
  for (const extra of Object.keys(raw))
    if (!known.includes(extra)) out.push(`unknown field "${extra}"`);
  return out;
}

/** Parse unlocks.json, or throw with every problem listed. */
export function parseUnlockConfig(raw: unknown): UnlockConfig {
  const problems = unlockConfigProblems(raw);
  if (problems.length) throw new Error(`unlocks.json is not valid: ${problems.join("; ")}`);
  return raw as unknown as UnlockConfig;
}

/** Stripe product id. Custom ids are allowed and must be unique per account. */
export function stripeProductId(project: string, key: string): string {
  return `hk_${project}_${key}`;
}

/** Lookup key of the product's current Price. Stays the same across test
 *  and live, and across price changes (sync moves it to the new Price). */
export function stripeLookupKey(project: string, key: string): string {
  return `hatchkit:${project}:${key}`;
}

export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** "€9.00", "€5.00 / month" or "Pay what you want (from €3.00)". */
export function priceLabel(product: UnlockProduct, currency: string): string {
  if (typeof product.price === "number") {
    const amount = formatAmount(product.price, currency);
    return product.interval ? `${amount} / ${product.interval}` : amount;
  }
  return product.price.min > 0
    ? `Pay what you want (from ${formatAmount(product.price.min, currency)})`
    : "Pay what you want";
}

/* ================================================================== */
/* Tokens                                                             */
/* ================================================================== */

/** `c`: the cookie, with the time it was last checked against Stripe.
 *  `l`: the link in an email; checked against Stripe on every use. */
export type UnlockToken =
  | { p: "c"; k: string; s: string; c: number }
  | { p: "l"; k: string; s: string };

const encoder = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(
      text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4),
    );
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** `<b64url(JSON)>.<b64url(HMAC-SHA256 over the first part)>`. */
export async function signToken(secret: string, payload: UnlockToken): Promise<string> {
  const body = toB64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${toB64url(await hmacSha256(secret, body))}`;
}

export async function openToken(
  secret: string,
  token: string | null | undefined,
): Promise<UnlockToken | null> {
  if (!token || token.length > 2000) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const given = fromB64url(mac);
  if (!given || !sameBytes(given, await hmacSha256(secret, body))) return null;
  const raw = fromB64url(body);
  if (!raw) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    if (typeof value.k !== "string" || typeof value.s !== "string") return null;
    if (value.p === "c" && typeof value.c === "number")
      return { p: "c", k: value.k, s: value.s, c: value.c };
    if (value.p === "l") return { p: "l", k: value.k, s: value.s };
    return null;
  } catch {
    return null;
  }
}

/* ================================================================== */
/* Stripe REST                                                        */
/* ================================================================== */

export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export interface StripeClient {
  secretKey: string;
  fetch?: typeof fetch;
  /** Stripe-Context header: the target account for an organization key. */
  context?: string;
  apiVersion?: string;
}

/** Stripe's form encoding: nested objects as a[b], arrays as a[0]. */
export function encodeForm(
  params: Record<string, unknown>,
  out = new URLSearchParams(),
  prefix = "",
): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (isRecord(item)) encodeForm(item, out, `${name}[${i}]`);
        else out.append(`${name}[${i}]`, String(item));
      });
    } else if (isRecord(value)) {
      encodeForm(value, out, name);
    } else {
      out.append(name, value === null ? "" : String(value));
    }
  }
  return out;
}

export async function stripeRequest<T>(
  client: StripeClient,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const form = encodeForm(params).toString();
  const url = `https://api.stripe.com${path}${method === "POST" || !form ? "" : `?${form}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${client.secretKey}`,
    "Stripe-Version": client.apiVersion ?? STRIPE_API_VERSION,
  };
  if (client.context) headers["Stripe-Context"] = client.context;
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  const res = await (client.fetch ?? fetch)(url, {
    method,
    headers,
    body: method === "POST" ? form : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const error = isRecord(data) && isRecord(data.error) ? data.error : {};
    throw new StripeError(
      res.status,
      `Stripe ${method} ${path}: HTTP ${res.status}${typeof error.message === "string" ? ` ${error.message}` : ""}`,
      typeof error.code === "string" ? error.code : undefined,
    );
  }
  return data as T;
}

/** Check a `Stripe-Signature` header: `t=<unix>,v1=<hex hmac>[,v1=…]`. */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number,
): Promise<boolean> {
  if (!header) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [name, value] = part.split("=", 2);
    if (name === "t") timestamp = value ?? "";
    else if (name === "v1" && value) signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = await hmacSha256(secret, `${timestamp}.${payload}`);
  for (const signature of signatures) {
    if (!/^[0-9a-f]{64}$/.test(signature)) continue;
    const given = new Uint8Array(32);
    for (let i = 0; i < 32; i++) given[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
    if (sameBytes(given, expected)) return true;
  }
  return false;
}

/** Sign a payload the way Stripe does. For tests and local tooling. */
export async function stripeSignatureHeader(
  payload: string,
  secret: string,
  nowMs: number,
): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  const mac = await hmacSha256(secret, `${t}.${payload}`);
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface StripeCharge {
  id: string;
  refunded?: boolean;
  disputed?: boolean;
}

interface StripePaymentIntent {
  id: string;
  metadata?: Record<string, string> | null;
  latest_charge?: string | StripeCharge | null;
}

interface StripeSubscription {
  id: string;
  status: string;
  metadata?: Record<string, string> | null;
}

export interface StripeCheckoutSession {
  id: string;
  status: "open" | "complete" | "expired" | null;
  mode: "payment" | "subscription" | "setup";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  created: number;
  url?: string | null;
  metadata?: Record<string, string> | null;
  customer?: string | { id: string } | null;
  customer_details?: { email?: string | null } | null;
  payment_intent?: string | StripePaymentIntent | null;
  subscription?: string | StripeSubscription | null;
}

/* ================================================================== */
/* Runtime dependencies                                               */
/* ================================================================== */

/** A response body. Spelled this way because Node's types (the starter
 *  compiles with lib ES2022 only) have no global BodyInit. */
export type UnlockBody = NonNullable<ConstructorParameters<typeof Response>[0]>;

export type StoredFile =
  | { body: UnlockBody; size?: number; contentType?: string }
  | { redirect: string };

/** Download objects (Worker: R2; server: presigned S3 or a local folder). */
export interface FileStore {
  get(object: string, filename: string): Promise<StoredFile | null>;
}

/** The private folder: `paid/<key>/…` pages and `emails/<file>.html`. */
export interface PrivateAssets {
  get(path: string): Promise<{ body: UnlockBody; contentType: string } | null>;
}

export interface Mailer {
  send(message: { to: string; subject: string; html: string }): Promise<void>;
}

export interface UnlockDeps {
  config: UnlockConfig;
  /** Public origin of the site, e.g. https://example.com. Links and the
   *  Checkout return URL are built on it. */
  siteUrl: string;
  /** Display name in emails. Defaults to the site's host. */
  siteName?: string;
  stripeSecretKey: string;
  webhookSecret: string;
  tokenSecret: string;
  files: FileStore;
  assets: PrivateAssets;
  /** Without a mailer nothing is emailed; access still works by cookie. */
  mailer?: Mailer | null;
  /** Return false to refuse (rate limit). Called with a key per client. */
  limit?: (key: string) => Promise<boolean>;
  fetch?: typeof fetch;
  /** Stripe-Version to send. Defaults to STRIPE_API_VERSION. */
  stripeApiVersion?: string;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface RequestContext {
  clientIp?: string | null;
}

/** Listmonk transactional mail to any address (`subscriber_mode:
 *  external`): the buyer is never added to Listmonk's subscriber table.
 *  The template is the project's passthrough tx template
 *  ({{ .Tx.Data.subject }} / {{ .Tx.Data.body | Safe }}). */
export function listmonkMailer(options: {
  url: string;
  user: string;
  token: string;
  templateId: number;
  from?: string;
  fetch?: typeof fetch;
}): Mailer {
  return {
    async send({ to, subject, html }) {
      const res = await (options.fetch ?? fetch)(`${options.url.replace(/\/+$/, "")}/api/tx`, {
        method: "POST",
        headers: {
          Authorization: `token ${options.user}:${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subscriber_mode: "external",
          subscriber_emails: [to],
          template_id: options.templateId,
          ...(options.from ? { from_email: options.from } : {}),
          data: { subject, body: html },
          content_type: "html",
          messenger: "email",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Listmonk /api/tx: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
    },
  };
}

/* ================================================================== */
/* Entitlement                                                        */
/* ================================================================== */

export type EntitlementFailure =
  | "not-found"
  | "foreign"
  | "unknown-product"
  | "open"
  | "pending"
  | "refunded"
  | "disputed"
  | "inactive";

export type Entitlement =
  | {
      ok: true;
      key: string;
      product: UnlockProduct;
      email: string | null;
      session: StripeCheckoutSession;
    }
  | { ok: false; reason: EntitlementFailure; key?: string; session?: StripeCheckoutSession };

const ACTIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due"]);

function stripeOf(deps: UnlockDeps): StripeClient {
  return { secretKey: deps.stripeSecretKey, fetch: deps.fetch, apiVersion: deps.stripeApiVersion };
}

function nowOf(deps: UnlockDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** Ask Stripe whether this Checkout Session still grants its unlock. */
export async function checkEntitlement(deps: UnlockDeps, sessionId: string): Promise<Entitlement> {
  let session: StripeCheckoutSession;
  try {
    session = await stripeRequest<StripeCheckoutSession>(
      stripeOf(deps),
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { expand: ["payment_intent.latest_charge", "subscription"] },
    );
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return { ok: false, reason: "not-found" };
    throw err;
  }
  if (session.metadata?.hatchkit_project !== deps.config.project)
    return { ok: false, reason: "foreign", session };
  const key = session.metadata?.hatchkit_unlock ?? "";
  const product = deps.config.products[key];
  if (!product) return { ok: false, reason: "unknown-product", key, session };
  if (session.status !== "complete") return { ok: false, reason: "open", key, session };
  if (session.mode === "subscription") {
    const sub = session.subscription;
    if (!sub || typeof sub === "string" || !ACTIVE_SUBSCRIPTION.has(sub.status))
      return { ok: false, reason: "inactive", key, session };
  } else {
    if (session.payment_status === "unpaid") return { ok: false, reason: "pending", key, session };
    const pi = session.payment_intent;
    const charge = pi && typeof pi !== "string" ? pi.latest_charge : null;
    if (charge && typeof charge !== "string") {
      if (charge.refunded) return { ok: false, reason: "refunded", key, session };
      if (charge.disputed) return { ok: false, reason: "disputed", key, session };
    }
  }
  return { ok: true, key, product, email: session.customer_details?.email ?? null, session };
}

/* ================================================================== */
/* HTTP                                                               */
/* ================================================================== */

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; " +
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com; base-uri 'none'; frame-ancestors 'none'";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function noStore(headers: Record<string, string> = {}): Headers {
  const h = new Headers(headers);
  h.set("Cache-Control", "private, no-store");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Robots-Tag", "noindex");
  return h;
}

function htmlPage(title: string, body: string, status = 200, cookies: string[] = []): Response {
  const headers = noStore({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}` +
    `button{font:inherit;padding:.4rem .9rem}input{font:inherit;padding:.3rem}</style>` +
    `</head><body>${body}</body></html>`;
  return new Response(html, { status, headers });
}

function redirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = noStore({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: noStore({ "Content-Type": "application/json" }),
  });
}

function cookieName(key: string): string {
  return `hk_unlock_${key}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function secureFlag(deps: UnlockDeps): string {
  return deps.siteUrl.startsWith("https:") ? "; Secure" : "";
}

async function grantCookie(deps: UnlockDeps, key: string, sessionId: string): Promise<string> {
  const token = await signToken(deps.tokenSecret, { p: "c", k: key, s: sessionId, c: nowOf(deps) });
  return `${cookieName(key)}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secureFlag(deps)}`;
}

function clearCookie(deps: UnlockDeps, key: string): string {
  return `${cookieName(key)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag(deps)}`;
}

function log(deps: UnlockDeps, entry: Record<string, unknown>): void {
  if (deps.log) deps.log(entry);
  else console.log(JSON.stringify({ scope: "unlock", ...entry }));
}

function site(deps: UnlockDeps): string {
  return deps.siteUrl.replace(/\/+$/, "");
}

function pagePrefix(config: UnlockConfig): string {
  return config.pagePrefix ?? DEFAULT_PAGE_PREFIX;
}

/** Where the buyer lands once unlocked. */
export function landingPath(config: UnlockConfig, key: string): string {
  const product = config.products[key];
  if (product?.kind === "download") return `${API_PREFIX}/files/${key}`;
  if (product?.kind === "email") return `${API_PREFIX}/sent/${key}`;
  return `${pagePrefix(config)}/${key}/`;
}

/** True for every path this core answers. Adapters pass everything else on. */
export function isUnlockPath(pathname: string, config: UnlockConfig): boolean {
  const prefix = pagePrefix(config);
  return (
    pathname === API_PREFIX ||
    pathname.startsWith(`${API_PREFIX}/`) ||
    pathname === prefix ||
    pathname.startsWith(`${prefix}/`)
  );
}

type CookieCheck =
  | { ok: true; sessionId: string; cookies: string[] }
  | { ok: false; cookies: string[] };

/** The buyer's cookie for `key`, re-checked against Stripe once a day. A
 *  Stripe outage during that re-check keeps access (the buyer paid); a
 *  definite answer (refunded, disputed, ended) removes it. */
async function cookieAccess(deps: UnlockDeps, request: Request, key: string): Promise<CookieCheck> {
  const token = await openToken(deps.tokenSecret, readCookie(request, cookieName(key)));
  if (!token || token.p !== "c" || token.k !== key) return { ok: false, cookies: [] };
  if (nowOf(deps) - token.c < COOKIE_RECHECK_MS)
    return { ok: true, sessionId: token.s, cookies: [] };
  let entitlement: Entitlement;
  try {
    entitlement = await checkEntitlement(deps, token.s);
  } catch (err) {
    log(deps, { event: "recheck_failed", key, message: (err as Error).message });
    return { ok: true, sessionId: token.s, cookies: [] };
  }
  if (entitlement.ok && entitlement.key === key)
    return { ok: true, sessionId: token.s, cookies: [await grantCookie(deps, key, token.s)] };
  log(deps, {
    event: "access_ended",
    key,
    reason: entitlement.ok ? "key-mismatch" : entitlement.reason,
  });
  return { ok: false, cookies: [clearCookie(deps, key)] };
}

/** Cookie first, then a `t` link token from an email (checked live). */
async function anyAccess(
  deps: UnlockDeps,
  request: Request,
  url: URL,
  key: string,
): Promise<CookieCheck> {
  const viaCookie = await cookieAccess(deps, request, key);
  if (viaCookie.ok) return viaCookie;
  const link = await openToken(deps.tokenSecret, url.searchParams.get("t"));
  if (!link || link.p !== "l" || link.k !== key) return viaCookie;
  const entitlement = await checkEntitlement(deps, link.s);
  if (!entitlement.ok || entitlement.key !== key) return viaCookie;
  return { ok: true, sessionId: link.s, cookies: [await grantCookie(deps, key, link.s)] };
}

function lockedPage(deps: UnlockDeps, key: string, status = 402, cookies: string[] = []): Response {
  const product = deps.config.products[key];
  const name = escapeHtml(product.name);
  const buy =
    product.active === false
      ? ""
      : `<form method="post" action="${API_PREFIX}/checkout"><input type="hidden" name="product" value="${key}">` +
        `<button>Buy · ${escapeHtml(priceLabel(product, deps.config.currency))}</button></form>`;
  const description = product.description ? `<p>${escapeHtml(product.description)}</p>` : "";
  return htmlPage(
    product.name,
    `<h1>${name}</h1>${description}${buy}<p><a href="${API_PREFIX}/restore">Already bought it?</a></p>`,
    status,
    cookies,
  );
}

function manageForm(key: string, product: UnlockProduct): string {
  if (!product.interval) return "";
  return (
    `<form method="post" action="${API_PREFIX}/manage"><input type="hidden" name="product" value="${key}">` +
    `<button>Manage subscription</button></form>`
  );
}

function messagePage(title: string, text: string, status = 200): Response {
  return htmlPage(title, `<h1>${escapeHtml(title)}</h1><p>${text}</p>`, status);
}

async function formOf(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded")) return new URLSearchParams();
  const text = await request.text();
  return new URLSearchParams(text.length > 10_000 ? "" : text);
}

/* ---------------------------------------------------------------- */
/* Checkout                                                         */
/* ---------------------------------------------------------------- */

interface PriceCacheEntry {
  id: string;
  at: number;
}
const priceCache = new Map<string, PriceCacheEntry>();
const PRICE_CACHE_MS = 5 * 60 * 1000;

/** The active Price for a product, found by lookup key (cached 5 min). */
async function priceIdFor(deps: UnlockDeps, key: string): Promise<string | null> {
  const lookup = stripeLookupKey(deps.config.project, key);
  const cacheKey = `${deps.stripeSecretKey.slice(0, 12)}:${lookup}`;
  const cached = priceCache.get(cacheKey);
  if (cached && nowOf(deps) - cached.at < PRICE_CACHE_MS) return cached.id;
  const list = await stripeRequest<{ data: Array<{ id: string }> }>(
    stripeOf(deps),
    "GET",
    "/v1/prices",
    {
      lookup_keys: [lookup],
      active: "true",
      limit: 1,
    },
  );
  const id = list.data[0]?.id ?? null;
  if (id) priceCache.set(cacheKey, { id, at: nowOf(deps) });
  return id;
}

/** Forget cached price ids (tests). */
export function _clearPriceCache(): void {
  priceCache.clear();
}

function sameOriginReferer(deps: UnlockDeps, request: Request): string | null {
  const referer = request.headers.get("Referer");
  if (!referer) return null;
  try {
    const ref = new URL(referer);
    return ref.origin === new URL(deps.siteUrl).origin ? ref.toString() : null;
  } catch {
    return null;
  }
}

async function handleCheckout(deps: UnlockDeps, request: Request): Promise<Response> {
  const form = await formOf(request);
  const key = form.get("product") ?? "";
  const product = KEY_RE.test(key) ? deps.config.products[key] : undefined;
  if (!product || product.active === false)
    return messagePage("Not for sale", "This product is not for sale.", 404);
  const price = await priceIdFor(deps, key);
  if (!price) {
    log(deps, { event: "checkout_failed", key, reason: "no-price" });
    return messagePage("Not available yet", "This product is not set up in Stripe yet.", 503);
  }
  const metadata = { hatchkit_project: deps.config.project, hatchkit_unlock: key };
  const subscription = Boolean(product.interval);
  const session = await stripeRequest<StripeCheckoutSession>(
    stripeOf(deps),
    "POST",
    "/v1/checkout/sessions",
    {
      mode: subscription ? "subscription" : "payment",
      line_items: [{ price, quantity: 1 }],
      success_url: `${site(deps)}${API_PREFIX}/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: sameOriginReferer(deps, request) ?? `${site(deps)}/`,
      metadata,
      ...(subscription
        ? { subscription_data: { metadata } }
        : { payment_intent_data: { metadata } }),
      ...(deps.config.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      ...(deps.config.refundPolicy
        ? { custom_text: { submit: { message: deps.config.refundPolicy } } }
        : {}),
    },
  );
  log(deps, { event: "checkout", key });
  if (!session.url)
    return messagePage("Checkout failed", "Stripe did not return a checkout page.", 502);
  return redirect(session.url);
}

/* ---------------------------------------------------------------- */
/* Return, claim, manage                                            */
/* ---------------------------------------------------------------- */

const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

async function handleReturn(deps: UnlockDeps, url: URL): Promise<Response> {
  const id = url.searchParams.get("session_id") ?? "";
  if (!SESSION_ID_RE.test(id))
    return messagePage("Link not valid", "This return link is not valid.", 400);
  const entitlement = await checkEntitlement(deps, id);
  if (!entitlement.ok) {
    log(deps, { event: "return", outcome: entitlement.reason, key: entitlement.key });
    if (entitlement.reason === "pending")
      return messagePage(
        "Payment processing",
        "Your payment is processing. You get an email when it clears.",
      );
    return messagePage(
      "No access",
      `This purchase does not unlock anything here. <a href="${API_PREFIX}/restore">Send my purchases again</a>`,
      403,
    );
  }
  if (nowOf(deps) - entitlement.session.created * 1000 > RETURN_WINDOW_MS)
    return messagePage(
      "Link expired",
      `Use the link in your purchase email, or <a href="${API_PREFIX}/restore">send it again</a>.`,
      410,
    );
  log(deps, { event: "return", outcome: "unlocked", key: entitlement.key });
  return redirect(landingPath(deps.config, entitlement.key), [
    await grantCookie(deps, entitlement.key, id),
  ]);
}

async function handleClaim(deps: UnlockDeps, url: URL): Promise<Response> {
  const token = await openToken(deps.tokenSecret, url.searchParams.get("t"));
  if (!token || token.p !== "l")
    return messagePage("Link not valid", "This link is not valid.", 400);
  const entitlement = await checkEntitlement(deps, token.s);
  if (!entitlement.ok || entitlement.key !== token.k) {
    log(deps, {
      event: "claim",
      outcome: entitlement.ok ? "key-mismatch" : entitlement.reason,
      key: token.k,
    });
    return messagePage("Link no longer works", "This purchase no longer unlocks anything.", 410);
  }
  const cookie = await grantCookie(deps, token.k, token.s);
  log(deps, { event: "claim", outcome: "unlocked", key: token.k });
  if (url.searchParams.get("next") === "manage" && entitlement.product.interval) {
    const portal = await portalUrl(deps, entitlement.session);
    if (portal) return redirect(portal, [cookie]);
  }
  return redirect(landingPath(deps.config, token.k), [cookie]);
}

async function portalUrl(deps: UnlockDeps, session: StripeCheckoutSession): Promise<string | null> {
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!customer) return null;
  const portal = await stripeRequest<{ url: string }>(
    stripeOf(deps),
    "POST",
    "/v1/billing_portal/sessions",
    {
      customer,
      return_url: `${site(deps)}/`,
    },
  );
  return portal.url;
}

async function handleManage(deps: UnlockDeps, request: Request): Promise<Response> {
  const form = await formOf(request);
  const key = form.get("product") ?? "";
  const product = KEY_RE.test(key) ? deps.config.products[key] : undefined;
  if (!product?.interval)
    return messagePage("Not a subscription", "There is nothing to manage here.", 404);
  const access = await cookieAccess(deps, request, key);
  if (!access.ok) return lockedPage(deps, key, 402, access.cookies);
  const entitlement = await checkEntitlement(deps, access.sessionId);
  if (!entitlement.ok) return lockedPage(deps, key, 402, [clearCookie(deps, key)]);
  const portal = await portalUrl(deps, entitlement.session);
  if (!portal)
    return messagePage("Not available", "This subscription has no customer record.", 409);
  return redirect(portal, access.cookies);
}

/* ---------------------------------------------------------------- */
/* Pages, files, downloads                                          */
/* ---------------------------------------------------------------- */

/** `<prefix>/<key>/<rest>` → `paid/<key>/<rest>`, or null for anything
 *  that could climb out of the product's folder. */
function pageAssetPath(key: string, rest: string): string[] | null {
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "." || segment === ".." || /[\\/\0]/.test(segment)) return null;
    segments.push(segment);
  }
  const base = `paid/${key}/${segments.join("/")}`.replace(/\/+$/, "");
  if (rest === "" || rest.endsWith("/")) return [`${base}/index.html`];
  const last = segments[segments.length - 1] ?? "";
  return last.includes(".") ? [base] : [base, `${base}.html`, `${base}/index.html`];
}

async function handlePage(
  deps: UnlockDeps,
  request: Request,
  url: URL,
  prefix: string,
): Promise<Response> {
  const tail = url.pathname.slice(prefix.length + 1);
  const slash = tail.indexOf("/");
  const key = slash === -1 ? tail : tail.slice(0, slash);
  const product = deps.config.products[key];
  if (!KEY_RE.test(key) || !product || product.kind !== "page")
    return messagePage("Not found", "Nothing here.", 404);
  if (slash === -1) return redirect(`${prefix}/${key}/${url.search}`, [], 308);
  const candidates = pageAssetPath(key, tail.slice(slash + 1));
  if (!candidates) return messagePage("Not found", "Nothing here.", 404);
  const access = await anyAccess(deps, request, url, key);
  if (!access.ok) return lockedPage(deps, key, 402, access.cookies);
  for (const path of candidates) {
    const asset = await deps.assets.get(path);
    if (!asset) continue;
    const headers = noStore({ "Content-Type": asset.contentType });
    for (const cookie of access.cookies) headers.append("Set-Cookie", cookie);
    return new Response(request.method === "HEAD" ? null : asset.body, { status: 200, headers });
  }
  return messagePage("Not found", "This page does not exist.", 404);
}

function downloadName(file: UnlockFile): string {
  return file.filename ?? file.object.split("/").pop() ?? "download";
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function handleFiles(
  deps: UnlockDeps,
  request: Request,
  url: URL,
  key: string,
): Promise<Response> {
  const product = deps.config.products[key];
  if (!product || product.kind !== "download")
    return messagePage("Not found", "Nothing here.", 404);
  const access = await anyAccess(deps, request, url, key);
  if (!access.ok) return lockedPage(deps, key, 402, access.cookies);
  const items = (product.files ?? [])
    .map(
      (file, i) =>
        `<li><a href="${API_PREFIX}/download/${key}/${i}">${escapeHtml(downloadName(file))}</a></li>`,
    )
    .join("");
  return htmlPage(
    product.name,
    `<h1>${escapeHtml(product.name)}</h1><ul>${items}</ul>${manageForm(key, product)}`,
    200,
    access.cookies,
  );
}

async function handleDownload(
  deps: UnlockDeps,
  request: Request,
  url: URL,
  key: string,
  index: string,
): Promise<Response> {
  const product = deps.config.products[key];
  const file =
    product?.kind === "download" && /^\d{1,3}$/.test(index)
      ? product.files?.[Number(index)]
      : undefined;
  if (!product || !file) return messagePage("Not found", "Nothing here.", 404);
  const access = await anyAccess(deps, request, url, key);
  if (!access.ok) return lockedPage(deps, key, 402, access.cookies);
  const filename = downloadName(file);
  const stored = await deps.files.get(file.object, filename);
  if (!stored) {
    log(deps, { event: "download_failed", key, reason: "object-missing" });
    return messagePage(
      "File missing",
      "This file is missing. Please reply to your purchase email.",
      404,
    );
  }
  log(deps, { event: "download", key });
  if ("redirect" in stored) return redirect(stored.redirect, access.cookies, 302);
  const headers = noStore({
    "Content-Type": stored.contentType ?? "application/octet-stream",
    "Content-Disposition": contentDisposition(filename),
  });
  if (stored.size !== undefined) headers.set("Content-Length", String(stored.size));
  for (const cookie of access.cookies) headers.append("Set-Cookie", cookie);
  return new Response(request.method === "HEAD" ? null : stored.body, { status: 200, headers });
}

async function handleSent(deps: UnlockDeps, request: Request, key: string): Promise<Response> {
  const product = deps.config.products[key];
  if (!product || product.kind !== "email") return messagePage("Not found", "Nothing here.", 404);
  const access = await cookieAccess(deps, request, key);
  if (!access.ok) return lockedPage(deps, key, 402, access.cookies);
  return htmlPage(
    product.name,
    `<h1>${escapeHtml(product.name)}</h1><p>Sent to the address you paid with.</p>` +
      `<p><a href="${API_PREFIX}/restore">Send it again</a></p>${manageForm(key, product)}`,
    200,
    access.cookies,
  );
}

async function handleStatus(deps: UnlockDeps, request: Request, key: string): Promise<Response> {
  if (!deps.config.products[key]) return json({ error: "unknown product" }, 404);
  const access = await cookieAccess(deps, request, key);
  const res = json({ unlocked: access.ok });
  for (const cookie of access.cookies) res.headers.append("Set-Cookie", cookie);
  return res;
}

/* ---------------------------------------------------------------- */
/* Emails                                                           */
/* ---------------------------------------------------------------- */

function siteName(deps: UnlockDeps): string {
  return deps.siteName ?? new URL(deps.siteUrl).host;
}

async function claimUrl(
  deps: UnlockDeps,
  key: string,
  sessionId: string,
  next?: "manage",
): Promise<string> {
  const token = await signToken(deps.tokenSecret, { p: "l", k: key, s: sessionId });
  return `${site(deps)}${API_PREFIX}/claim?t=${token}${next ? `&next=${next}` : ""}`;
}

function refundLine(deps: UnlockDeps): string {
  return deps.config.refundPolicy ? `<p>${escapeHtml(deps.config.refundPolicy)}</p>` : "";
}

async function readEmailBody(deps: UnlockDeps, product: UnlockProduct): Promise<string> {
  if (product.kind !== "email" || !product.email) return "";
  const asset = await deps.assets.get(`emails/${product.email}`);
  if (!asset) throw new Error(`emails/${product.email} is missing from the private folder`);
  return await new Response(asset.body).text();
}

/** The one email a purchase sends: the goods (email product) or a link
 *  that opens them on any device, plus the refund line. */
export async function purchaseEmail(
  deps: UnlockDeps,
  entitlement: Extract<Entitlement, { ok: true }>,
): Promise<{ subject: string; html: string }> {
  const { key, product, session } = entitlement;
  const parts: string[] = [];
  if (product.kind === "email") {
    parts.push(await readEmailBody(deps, product));
  } else {
    parts.push(
      `<p>Thank you for buying ${escapeHtml(product.name)}.</p>`,
      `<p><a href="${await claimUrl(deps, key, session.id)}">Open ${escapeHtml(product.name)}</a></p>`,
      "<p>The link works on any device. Keep this email to get back in.</p>",
    );
  }
  if (product.interval)
    parts.push(
      `<p><a href="${await claimUrl(deps, key, session.id, "manage")}">Manage or cancel the subscription</a></p>`,
    );
  parts.push(refundLine(deps));
  return {
    subject:
      product.kind === "email"
        ? (product.subject ?? product.name)
        : `Your purchase: ${product.name}`,
    html: parts.join("\n"),
  };
}

type MarkerTarget = { path: string; metadata: Record<string, string> };

function markerTarget(session: StripeCheckoutSession): MarkerTarget | null {
  const pi = session.payment_intent;
  if (pi && typeof pi !== "string")
    return { path: `/v1/payment_intents/${pi.id}`, metadata: pi.metadata ?? {} };
  const sub = session.subscription;
  if (sub && typeof sub !== "string")
    return { path: `/v1/subscriptions/${sub.id}`, metadata: sub.metadata ?? {} };
  return null;
}

/** Send the purchase email once per purchase. Throws when the mail could
 *  not be sent, so the webhook answers 500 and Stripe retries. */
export async function deliverPurchase(
  deps: UnlockDeps,
  sessionId: string,
): Promise<"sent" | "already" | "skipped"> {
  const entitlement = await checkEntitlement(deps, sessionId);
  if (!entitlement.ok) {
    log(deps, { event: "delivery", outcome: entitlement.reason, key: entitlement.key });
    return "skipped";
  }
  const marker = markerTarget(entitlement.session);
  if (marker?.metadata.hatchkit_mailed_at) return "already";
  if (!deps.mailer || !entitlement.email) {
    log(deps, {
      event: "delivery",
      outcome: deps.mailer ? "no-email" : "no-mailer",
      key: entitlement.key,
    });
    return "skipped";
  }
  const message = await purchaseEmail(deps, entitlement);
  await deps.mailer.send({ to: entitlement.email, ...message });
  log(deps, { event: "delivery", outcome: "sent", key: entitlement.key });
  if (marker) {
    try {
      await stripeRequest(stripeOf(deps), "POST", marker.path, {
        metadata: { hatchkit_mailed_at: new Date(nowOf(deps)).toISOString() },
      });
    } catch (err) {
      // Mail is out; a retry would only send it twice. Log and move on.
      log(deps, {
        event: "delivery_mark_failed",
        key: entitlement.key,
        message: (err as Error).message,
      });
    }
  }
  return "sent";
}

/* ---------------------------------------------------------------- */
/* Restore                                                          */
/* ---------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,63}$/;

async function handleRestorePost(
  deps: UnlockDeps,
  request: Request,
  ctx: RequestContext,
): Promise<Response> {
  const form = await formOf(request);
  const email = (form.get("email") ?? "").trim();
  const sentPage = redirect(`${API_PREFIX}/restore?sent=1`);
  if (!EMAIL_RE.test(email))
    return messagePage("Check the address", "That does not look like an email address.", 400);
  if (deps.limit) {
    const allowed =
      (await deps.limit(`restore-ip:${ctx.clientIp ?? "unknown"}`)) &&
      (await deps.limit(`restore-email:${email.toLowerCase()}`));
    if (!allowed) return messagePage("Too many requests", "Please try again in a minute.", 429);
  }
  if (!deps.mailer) {
    log(deps, { event: "restore", outcome: "no-mailer" });
    return sentPage;
  }
  const sessions = await stripeRequest<{ data: StripeCheckoutSession[] }>(
    stripeOf(deps),
    "GET",
    "/v1/checkout/sessions",
    {
      customer_details: { email },
      status: "complete",
      limit: 100,
    },
  );
  const links: string[] = [];
  const seen = new Set<string>();
  for (const candidate of sessions.data) {
    if (links.length >= RESTORE_MAX) break;
    const key = candidate.metadata?.hatchkit_unlock;
    if (candidate.metadata?.hatchkit_project !== deps.config.project || !key || seen.has(key))
      continue;
    const entitlement = await checkEntitlement(deps, candidate.id);
    if (!entitlement.ok) continue;
    seen.add(key);
    links.push(
      `<li><a href="${await claimUrl(deps, key, candidate.id)}">${escapeHtml(entitlement.product.name)}</a></li>`,
    );
  }
  log(deps, { event: "restore", outcome: links.length ? "sent" : "none" });
  if (links.length) {
    await deps.mailer.send({
      to: email,
      subject: `Your purchases at ${siteName(deps)}`,
      html: `<p>Links to what you bought:</p><ul>${links.join("")}</ul>${refundLine(deps)}`,
    });
  }
  return sentPage;
}

function restoreForm(url: URL): Response {
  if (url.searchParams.get("sent") === "1")
    return messagePage(
      "Check your email",
      "If this address bought something here, an email with links is on its way.",
    );
  return htmlPage(
    "Send my purchases again",
    `<h1>Send my purchases again</h1><form method="post" action="${API_PREFIX}/restore">` +
      `<label>Email <input type="email" name="email" required autocomplete="email"></label> ` +
      "<button>Send</button></form>",
  );
}

/* ---------------------------------------------------------------- */
/* Webhook                                                          */
/* ---------------------------------------------------------------- */

const DELIVERY_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

async function handleWebhook(deps: UnlockDeps, request: Request): Promise<Response> {
  const payload = await request.text();
  if (
    !(await verifyStripeSignature(
      payload,
      request.headers.get("Stripe-Signature"),
      deps.webhookSecret,
      nowOf(deps),
    ))
  )
    return json({ error: "invalid signature" }, 400);
  let event: { type?: string; data?: { object?: StripeCheckoutSession } };
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const session = event.data?.object;
  if (!event.type || !DELIVERY_EVENTS.has(event.type) || !session?.id)
    return json({ received: true });
  if (session.metadata?.hatchkit_project !== deps.config.project) return json({ received: true });
  if (event.type === "checkout.session.completed" && session.payment_status === "unpaid")
    return json({ received: true });
  try {
    const outcome = await deliverPurchase(deps, session.id);
    return json({ received: true, outcome });
  } catch (err) {
    log(deps, {
      event: "delivery_failed",
      key: session.metadata?.hatchkit_unlock,
      message: (err as Error).message,
    });
    return json({ error: "delivery failed" }, 500);
  }
}

/* ---------------------------------------------------------------- */
/* Router                                                           */
/* ---------------------------------------------------------------- */

/** Answer one request, or return null when the path is not ours. */
export async function handleUnlockRequest(
  request: Request,
  deps: UnlockDeps,
  ctx: RequestContext = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isUnlockPath(path, deps.config)) return null;
  const method = request.method === "HEAD" ? "GET" : request.method;
  try {
    const prefix = pagePrefix(deps.config);
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (method !== "GET") return messagePage("Not allowed", "Method not allowed.", 405);
      return await handlePage(deps, request, url, prefix);
    }
    const route = path.slice(API_PREFIX.length).replace(/\/+$/, "");
    const [, name = "", key = "", extra = "", more] = route.split("/");
    if (more !== undefined) return messagePage("Not found", "Nothing here.", 404);
    if (method === "POST") {
      if (route === "/checkout") return await handleCheckout(deps, request);
      if (route === "/webhook") return await handleWebhook(deps, request);
      if (route === "/restore") return await handleRestorePost(deps, request, ctx);
      if (route === "/manage") return await handleManage(deps, request);
      return messagePage("Not found", "Nothing here.", 404);
    }
    if (method !== "GET") return messagePage("Not allowed", "Method not allowed.", 405);
    if (route === "/return") return await handleReturn(deps, url);
    if (route === "/claim") return await handleClaim(deps, url);
    if (route === "/restore") return restoreForm(url);
    if (KEY_RE.test(key)) {
      if (name === "files" && !extra) return await handleFiles(deps, request, url, key);
      if (name === "download" && extra) return await handleDownload(deps, request, url, key, extra);
      if (name === "sent" && !extra) return await handleSent(deps, request, key);
      if (name === "status" && !extra) return await handleStatus(deps, request, key);
    }
    return messagePage("Not found", "Nothing here.", 404);
  } catch (err) {
    log(deps, {
      event: "error",
      path: path.startsWith(API_PREFIX) ? path.split("/").slice(0, 4).join("/") : "page",
      message: (err as Error).message,
    });
    return messagePage("Something went wrong", "Please try again in a minute.", 502);
  }
}
