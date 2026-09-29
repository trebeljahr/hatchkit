/*
 * Listmonk provisioning — create lists + transactional subscribers via
 * the Listmonk API on a hatchkit-managed (or user-managed) Listmonk
 * instance.
 *
 * Auth: `Authorization: token <api_user>:<token>`. Listmonk also accepts
 * BasicAuth, but the token form is what its docs lead with and what
 * `Admin → Users → New API user` produces in the UI. There is NO API for
 * bootstrapping the first admin account or the first API user — those
 * must be created in the admin UI before hatchkit can connect.
 *
 * API: https://listmonk.app/docs/apis/
 *   POST /api/lists
 *   GET  /api/lists
 *   DELETE /api/lists/{id}
 *   POST /api/subscribers
 *   POST /api/tx
 *   GET  /api/templates
 *   GET  /api/templates/{id}
 *   POST /api/templates
 *   PUT  /api/templates/{id}
 *   DELETE /api/templates/{id}
 *   GET  /api/settings
 *   PUT  /api/settings/{key}
 *   GET  /api/health
 */

import { randomUUID } from "node:crypto";
import { ensureListmonk } from "../config.js";

export interface ListmonkAuth {
  url: string;
  apiUser: string;
  apiToken: string;
}

/** Format the `Authorization` header value for a Listmonk API call.
 *  Exported so the test suite can golden-test it without needing keychain
 *  access. */
export function listmonkAuthHeader(auth: { apiUser: string; apiToken: string }): string {
  return `token ${auth.apiUser}:${auth.apiToken}`;
}

/** Normalize a Listmonk base URL to drop any trailing slash so that
 *  `${base}/api/lists` always produces a single-slash path. */
export function normalizeListmonkUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function authHeaders(auth: { apiUser: string; apiToken: string }): Record<string, string> {
  return {
    Authorization: listmonkAuthHeader(auth),
    "Content-Type": "application/json",
  };
}

async function listmonkFetch<T>(
  auth: ListmonkAuth,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${normalizeListmonkUrl(auth.url)}${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(auth),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Listmonk ${method} ${path} failed: HTTP ${res.status} ${detail}`);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

// ────────────────────────────────────────────────────────────────────────────
// Lists
// ────────────────────────────────────────────────────────────────────────────

export interface ListmonkList {
  id: number;
  name: string;
  type: "public" | "private";
  optin: "single" | "double";
  tags?: string[];
}

interface ListmonkListsResponse {
  results: ListmonkList[];
  total: number;
}

export async function listListmonkLists(authOverride?: ListmonkAuth): Promise<ListmonkList[]> {
  const auth = authOverride ?? (await ensureListmonk());
  const data = await listmonkFetch<ListmonkListsResponse>(auth, "GET", "/api/lists?per_page=all");
  return data.results ?? [];
}

/** Create a list. `optin` defaults to `"double"`: Listmonk sends a
 *  campaign on a single-opt-in list to every member not `unsubscribed`,
 *  `unconfirmed` included, so a signup form that adds the address
 *  before the confirm click would mail it every issue. On a double
 *  list campaigns reach `confirmed` members only. */
export async function createListmonkList(
  name: string,
  opts: {
    type?: "public" | "private";
    optin?: "single" | "double";
    tags?: string[];
    auth?: ListmonkAuth;
  } = {},
): Promise<ListmonkList> {
  const auth = opts.auth ?? (await ensureListmonk());
  return listmonkFetch<ListmonkList>(auth, "POST", "/api/lists", {
    name,
    type: opts.type ?? "private",
    optin: opts.optin ?? "double",
    tags: opts.tags ?? [],
  });
}

export type DeleteResult = "deleted" | "not-found";

/** Delete every list whose name matches `name`. Same shape as Resend's
 *  `deleteResendClient`: by-name lookup (the create response gives the
 *  id but the ledger may have been pruned), 0-match → not-found, 1+-match →
 *  delete all so undo is total. */
export async function deleteListmonkList(
  name: string,
  authOverride?: ListmonkAuth,
): Promise<DeleteResult> {
  const auth = authOverride ?? (await ensureListmonk());
  const matches = (await listListmonkLists(auth)).filter((l) => l.name === name);
  if (matches.length === 0) return "not-found";
  for (const list of matches) {
    const url = `${normalizeListmonkUrl(auth.url)}/api/lists/${list.id}`;
    const res = await fetch(url, { method: "DELETE", headers: authHeaders(auth) });
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new Error(
        `Listmonk delete list ${list.id} failed: HTTP ${res.status} ${await res.text()}`,
      );
    }
  }
  return "deleted";
}

/** Delete a single list by id. 404-tolerant. Used by the ledger rollback
 *  path where we have the exact id from create-time. */
export async function deleteListmonkListById(
  id: number,
  authOverride?: ListmonkAuth,
): Promise<DeleteResult> {
  const auth = authOverride ?? (await ensureListmonk());
  const url = `${normalizeListmonkUrl(auth.url)}/api/lists/${id}`;
  const res = await fetch(url, { method: "DELETE", headers: authHeaders(auth) });
  if (res.status === 404) return "not-found";
  if (!res.ok) {
    throw new Error(`Listmonk delete list ${id} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return "deleted";
}

// ────────────────────────────────────────────────────────────────────────────
// Templates — passthrough templates for transactional + campaign sends.
//
// The runtime needs two templates configured in Listmonk:
//   · tx template: subject `{{ .Tx.Data.subject }}`, body renders
//     `{{ .Tx.Data.body | Safe }}` so the calling app can pass
//     pre-rendered subject + HTML through `POST /api/tx`. Listmonk
//     parses a tx body with Go's `html/template`, which escapes a bare
//     `{{ .Tx.Data.body }}` into visible markup; `Safe` is the helper
//     it registers to mark a string as trusted HTML (`safeHTML` is not
//     registered). The subject uses `text/template`, so it needs no
//     pipe. The calling app owns the HTML it sends.
//   · campaign template: a passthrough wrapper `{{ template "content" . }}`
//     so the digest HTML the app already composed is broadcast verbatim
//     with Listmonk's per-recipient `{{ UnsubscribeURL }}` substitution.
//
// Both are minimal HTML scaffolds — the calling app supplies the real
// markup. We seed them on first provision and reuse them on re-runs.
// ────────────────────────────────────────────────────────────────────────────

export interface ListmonkTemplate {
  id: number;
  name: string;
  type: "campaign" | "tx" | "campaign_visual";
  subject?: string;
  body?: string;
}

export async function listListmonkTemplates(
  authOverride?: ListmonkAuth,
): Promise<ListmonkTemplate[]> {
  const auth = authOverride ?? (await ensureListmonk());
  return listmonkFetch<ListmonkTemplate[]>(auth, "GET", "/api/templates");
}

export async function getListmonkTemplate(
  id: number,
  authOverride?: ListmonkAuth,
): Promise<ListmonkTemplate> {
  const auth = authOverride ?? (await ensureListmonk());
  return listmonkFetch<ListmonkTemplate>(auth, "GET", `/api/templates/${id}`);
}

export async function createListmonkTemplate(params: {
  name: string;
  type: "campaign" | "tx";
  subject?: string;
  body: string;
  auth?: ListmonkAuth;
}): Promise<ListmonkTemplate> {
  const auth = params.auth ?? (await ensureListmonk());
  return listmonkFetch<ListmonkTemplate>(auth, "POST", "/api/templates", {
    name: params.name,
    type: params.type,
    subject: params.subject ?? "",
    body: params.body,
  });
}

/** Replace a template's name, subject and body. Listmonk's PUT takes the
 *  whole template and recompiles it, so a body that doesn't compile
 *  comes back as HTTP 400 and the stored template is left as it was. */
export async function updateListmonkTemplate(
  id: number,
  params: {
    name: string;
    type: "campaign" | "tx";
    subject?: string;
    body: string;
    auth?: ListmonkAuth;
  },
): Promise<ListmonkTemplate> {
  const auth = params.auth ?? (await ensureListmonk());
  return listmonkFetch<ListmonkTemplate>(auth, "PUT", `/api/templates/${id}`, {
    name: params.name,
    type: params.type,
    subject: params.subject ?? "",
    body: params.body,
  });
}

/** Delete a single template by id. 404-tolerant. Used by ledger rollback. */
export async function deleteListmonkTemplateById(
  id: number,
  authOverride?: ListmonkAuth,
): Promise<DeleteResult> {
  const auth = authOverride ?? (await ensureListmonk());
  const url = `${normalizeListmonkUrl(auth.url)}/api/templates/${id}`;
  const res = await fetch(url, { method: "DELETE", headers: authHeaders(auth) });
  if (res.status === 404) return "not-found";
  if (!res.ok) {
    throw new Error(
      `Listmonk delete template ${id} failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  return "deleted";
}

// ────────────────────────────────────────────────────────────────────────────
// Subscribers
// ────────────────────────────────────────────────────────────────────────────

export interface ListmonkSubscriber {
  id: number;
  email: string;
  name: string;
  status: "enabled" | "blocklisted";
  lists?: ListmonkList[];
}

/** Create or fetch a subscriber. `preconfirm` skips Listmonk's own
 *  opt-in email — set true when the calling app already runs its own
 *  HMAC-token confirmation flow and wants Listmonk to record the
 *  subscriber as already-confirmed. */
export async function createListmonkSubscriber(
  params: {
    email: string;
    name?: string;
    status?: "enabled" | "blocklisted";
    listIds: number[];
    preconfirm?: boolean;
    attribs?: Record<string, unknown>;
  },
  authOverride?: ListmonkAuth,
): Promise<ListmonkSubscriber> {
  const auth = authOverride ?? (await ensureListmonk());
  return listmonkFetch<ListmonkSubscriber>(auth, "POST", "/api/subscribers", {
    email: params.email,
    name: params.name ?? params.email,
    status: params.status ?? "enabled",
    lists: params.listIds,
    preconfirm_subscriptions: params.preconfirm ?? false,
    attribs: params.attribs ?? {},
  });
}

/** The `search` value that matches exactly `email`. Listmonk matches
 *  `search` as a case-insensitive Postgres regex against name and email
 *  (`email ~* $search`), so the address is anchored and its regex
 *  characters quoted: unquoted, the `+` in `a+b@x.com` is a quantifier
 *  and a plus-address never finds itself. */
export function listmonkEmailSearch(email: string): string {
  const quoted = email.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${quoted}$`;
}

/** Look up a subscriber by exact email. Returns `null` on no match.
 *  Uses `search`, not `query`: the `query` param needs the
 *  `subscribers:sql_query` permission, which Listmonk's role form
 *  leaves out by default. `search` also matches the name column, so
 *  the results are filtered to the exact email. */
export async function findListmonkSubscriberByEmail(
  email: string,
  authOverride?: ListmonkAuth,
): Promise<ListmonkSubscriber | null> {
  const auth = authOverride ?? (await ensureListmonk());
  const normalized = email.toLowerCase();
  const params = new URLSearchParams({ search: listmonkEmailSearch(email), per_page: "all" });
  const res = await listmonkFetch<{ results: ListmonkSubscriber[] }>(
    auth,
    "GET",
    `/api/subscribers?${params}`,
  );
  return res.results.find((sub) => sub.email.toLowerCase() === normalized) ?? null;
}

/** Add an address to one list as a confirmed subscriber, idempotently.
 *  Used by the listmonk-ses provisioner to seed the user's own
 *  forwarding email into the project's `-test` list so the first
 *  `pnpm newsletter:verify` run lands a real email in their inbox
 *  without any manual setup.
 *
 *  Two paths:
 *    · subscriber doesn't exist yet → POST /api/subscribers with
 *      `preconfirm_subscriptions: true` so they land as `confirmed`
 *      on the target list immediately (Listmonk skips its own opt-in
 *      mailer).
 *    · subscriber exists → PUT /api/subscribers/lists with
 *      `action: "add"` + `status: "confirmed"`. The Listmonk PUT is a
 *      no-op when membership already matches, so re-runs stay quiet.
 *  Returns the subscriber id + whether the row was created this run
 *  (the ledger uses the flag to decide whether destroy should clean
 *  it up). */
export async function addListmonkSubscriberToList(params: {
  email: string;
  listId: number;
  name?: string;
  auth?: ListmonkAuth;
}): Promise<{ subscriberId: number; createdThisRun: boolean }> {
  const auth = params.auth ?? (await ensureListmonk());
  const existing = await findListmonkSubscriberByEmail(params.email, auth);
  if (existing) {
    await listmonkFetch<boolean>(auth, "PUT", "/api/subscribers/lists", {
      ids: [existing.id],
      action: "add",
      target_list_ids: [params.listId],
      status: "confirmed",
    });
    return { subscriberId: existing.id, createdThisRun: false };
  }
  const created = await listmonkFetch<ListmonkSubscriber>(auth, "POST", "/api/subscribers", {
    email: params.email.toLowerCase(),
    name: params.name ?? params.email.toLowerCase(),
    status: "enabled",
    lists: [params.listId],
    preconfirm_subscriptions: true,
  });
  return { subscriberId: created.id, createdThisRun: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Settings (singleton runtime config, stored in Listmonk's `settings` table)
//
// Listmonk's GET /api/settings drives the values the admin UI's
// Settings → General / Settings → SMTP pages edit. Hatchkit consumes
// this endpoint to:
//   1. Read app.root_url / app.admin_url / smtp and detect drift.
//   2. Push the SES SMTP relay credentials we already derived, so the
//      manual "paste SES creds into Listmonk → Settings → SMTP" step
//      drops out of the per-project walkthrough.
//
// Writes go through the per-key `PUT /api/settings/<key>` only. The
// whole-document PUT would send back every secret GET masked (SMTP and
// bounce-mailbox passwords, S3 and OIDC secrets) as a row of `•`.
//
// One Listmonk serves every project, so these settings belong to none
// of them. Write a value only when it is unset or provably Hatchkit's.
//
// Auth: requires the API user to have `Settings: All` permission.
// Without it, calls 403 with `permission denied: settings:get` /
// `settings:manage`. Hatchkit surfaces a useful error in that case so
// the user knows to widen the role.
// ────────────────────────────────────────────────────────────────────────────

/** Shape of one entry in Listmonk's `settings.smtp[]` array. Mirrors the
 *  schema the admin UI's Settings → SMTP form posts. GET leaves out
 *  `password` when it is empty and masks it otherwise. The sample
 *  servers a fresh install ships have no `name` or `uuid`. */
export interface ListmonkSmtpEntry {
  name: string;
  uuid: string;
  enabled: boolean;
  host: string;
  hello_hostname: string;
  port: number;
  auth_protocol: "login" | "cram" | "plain" | "none";
  username: string;
  password?: string;
  email_headers: Array<Record<string, string>>;
  max_conns: number;
  max_msg_retries: number;
  msg_retry_delay?: string;
  idle_timeout: string;
  wait_timeout: string;
  tls_type: "STARTTLS" | "TLS" | "none";
  tls_skip_verify: boolean;
  from_addresses?: string[];
}

export async function getListmonkSettings(
  authOverride?: ListmonkAuth,
): Promise<Record<string, unknown> & { smtp: ListmonkSmtpEntry[] }> {
  const auth = authOverride ?? (await ensureListmonk());
  return listmonkFetch<Record<string, unknown> & { smtp: ListmonkSmtpEntry[] }>(
    auth,
    "GET",
    "/api/settings",
  );
}

/** Write one settings key with Listmonk v6's `PUT /api/settings/<key>`,
 *  the raw JSON value as the body. Unlike the whole-object PUT it never
 *  round-trips the masked SMTP passwords. Listmonk stores the value as
 *  sent: no password merge, no UUID, no validation.
 *
 *  Listmonk reloads 500 ms after it answers, so call `waitForListmonk`
 *  before the next request. While a campaign runs it does not reload:
 *  it saves the value, answers `needs_restart`, and loads it on the
 *  next restart. */
export async function putListmonkSetting(
  key: string,
  value: unknown,
  authOverride?: ListmonkAuth,
): Promise<{ needsRestart: boolean }> {
  const auth = authOverride ?? (await ensureListmonk());
  const data = await listmonkFetch<boolean | { needs_restart?: boolean } | null>(
    auth,
    "PUT",
    `/api/settings/${encodeURIComponent(key)}`,
    value,
  );
  return { needsRestart: typeof data === "object" && data?.needs_restart === true };
}

/** Poll `GET /api/health` until Listmonk answers, the way its admin UI
 *  does after a settings save: the reload briefly takes the HTTP server
 *  down. Any answer below 500 counts as up; a proxy in front of a
 *  reloading Listmonk answers 502/503, and a dropped connection throws.
 *  Throws after `timeoutMs`. */
export async function waitForListmonk(
  auth: ListmonkAuth,
  opts: { initialDelayMs?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  if (opts.initialDelayMs) await sleep(opts.initialDelayMs);
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let lastError = "";
  for (;;) {
    try {
      const res = await fetch(`${normalizeListmonkUrl(auth.url)}/api/health`, {
        headers: authHeaders(auth),
      });
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message.split("\n")[0];
    }
    if (Date.now() >= deadline) {
      throw new Error(`Listmonk did not come back after a settings reload: ${lastError}`);
    }
    await sleep(opts.intervalMs ?? 500);
  }
}

/** GET /api/settings replaces each secret with one `•` per character. */
const LISTMONK_SECRET_MASK = /^•+$/;

/** SES's SMTP endpoints, `email-smtp.<region>.amazonaws.com`. */
const SES_SMTP_HOST = /^email-smtp(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/i;

/** The two sample servers a fresh Listmonk ships in `smtp`. Their
 *  password is the literal "password", so dropping them loses nothing. */
function isListmonkSampleSmtp(entry: ListmonkSmtpEntry): boolean {
  return (
    entry.host === "smtp.yoursite.com" ||
    (entry.host === "smtp.gmail.com" && entry.username === "username@gmail.com")
  );
}

/** `app.from_email` counts as unset when it is blank or still the
 *  install default, `listmonk <noreply@listmonk.yoursite.com>`, which
 *  no project sends from. Any other value is some project's sender. */
export function listmonkFromEmailUnset(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return true;
  return /@listmonk\.yoursite\.com>?$/i.test(value.trim());
}

/** Whether a stored SMTP password is `password`. GET masks it, so a
 *  masked value can only be checked for length. SES derives the SMTP
 *  password from the IAM secret behind `username` and the region in
 *  `host`, so the caller's host + username check does the rest. */
function smtpPasswordMatches(stored: string | undefined, password: string): boolean {
  if (!stored) return password === "";
  if (LISTMONK_SECRET_MASK.test(stored)) return [...stored].length === [...password].length;
  return stored === password;
}

export interface SesSmtpRelay {
  host: string;
  port: number;
  username: string;
  password: string;
}

type SesSmtpPlan =
  | { kind: "in-place" }
  | { kind: "write"; smtp: ListmonkSmtpEntry[] }
  | { kind: "blocked"; reason: string };

/** The `smtp` list with the SES relay in it, or why it can't be written.
 *
 *  The per-key PUT replaces the whole list, and Listmonk stores it as
 *  sent, so every entry must go back with its real password. Only the
 *  SES entry's is known. Another server with a (masked) password would
 *  come back with `•••` as its password, so the plan refuses instead.
 *  Listmonk's install samples are dropped. */
function planSesSmtp(
  current: ListmonkSmtpEntry[],
  ses: SesSmtpRelay,
  helloHostname: string,
): SesSmtpPlan {
  const sesEntries = current.filter((e) => SES_SMTP_HOST.test(e.host ?? ""));
  const existing =
    sesEntries.find((e) => e.host === ses.host && e.username === ses.username) ?? sesEntries[0];
  if (
    existing?.enabled === true &&
    existing.host === ses.host &&
    existing.port === ses.port &&
    existing.username === ses.username &&
    smtpPasswordMatches(existing.password, ses.password)
  ) {
    return { kind: "in-place" };
  }

  const others = current.filter((e) => e !== existing && !isListmonkSampleSmtp(e));
  const masked = others.filter((e) => e.password && LISTMONK_SECRET_MASK.test(e.password));
  if (masked.length > 0) {
    const names = masked.map((e) => e.name || e.host).join(", ");
    return {
      kind: "blocked",
      reason:
        `Listmonk has other SMTP servers (${names}) and the API masks their passwords. ` +
        "Writing the SMTP list would replace those passwords with the mask. " +
        "Add the SES server in Listmonk → Settings → SMTP by hand, with SES_SMTP_HOST, " +
        "SES_SMTP_USERNAME and SES_SMTP_PASSWORD from .env.production.",
    };
  }

  const defaults = {
    name: "email-ses",
    hello_hostname: helloHostname,
    email_headers: [],
    max_conns: 10,
    max_msg_retries: 2,
    msg_retry_delay: "10ms",
    idle_timeout: "15s",
    wait_timeout: "5s",
    tls_skip_verify: false,
    from_addresses: [],
  };
  const entry: ListmonkSmtpEntry = {
    ...defaults,
    ...existing,
    // The whole-document PUT assigned the UUID; the per-key PUT won't.
    uuid: existing?.uuid || randomUUID(),
    enabled: true,
    host: ses.host,
    port: ses.port,
    auth_protocol: "login",
    username: ses.username,
    password: ses.password,
    tls_type: "STARTTLS",
  };
  if (!entry.name) entry.name = "email-ses";

  const smtp = existing
    ? current.filter((e) => !isListmonkSampleSmtp(e)).map((e) => (e === existing ? entry : e))
    : [entry, ...others];
  return { kind: "write", smtp };
}

export interface ApplySesSmtpResult {
  /** The SMTP list was written this run. */
  written: boolean;
  /** Why not: "already in place", or what stopped the write. */
  reason?: string;
  /** Listmonk's instance-wide default sender after this run. */
  fromEmail?: { value: string; written: boolean };
  /** A campaign was running, so Listmonk saved the write but loads it
   *  only on its next restart. */
  needsRestart?: boolean;
}

/** Put the SES SMTP relay into Listmonk, and set its default sender
 *  when it has none.
 *
 *  The relay is written with the per-key `PUT /api/settings/smtp`, and
 *  only when host, port, username or password differ (first
 *  provisioning, or a rotated IAM key). An existing SES entry keeps its
 *  name, UUID and tuning; only the connection fields change.
 *
 *  `app.from_email` is shared by every project on the instance: it sends
 *  Listmonk's own mail (opt-in confirmations, notifications) and any
 *  campaign or tx call that names no sender. Apps from the starter pass
 *  `from_email` (LISTMONK_FROM) on every call, so they never need it.
 *  It is written only when unset (`listmonkFromEmailUnset`), never over
 *  another project's sender.
 *
 *  Throws when the API user lacks `Settings: All` or Listmonk predates
 *  the per-key endpoint; the caller downgrades that to a warning plus
 *  the manual-paste fallback. */
export async function applySesSmtpToListmonk(
  ses: SesSmtpRelay & {
    fromEmail: string;
    fromName?: string;
  },
  authOverride?: ListmonkAuth,
  opts: { reloadDelayMs?: number } = {},
): Promise<ApplySesSmtpResult> {
  const auth = authOverride ?? (await ensureListmonk());
  const settings = await getListmonkSettings(auth);
  let needsRestart = false;

  const write = async (key: string, value: unknown, byHand: string) => {
    try {
      const res = await putListmonkSetting(key, value, auth);
      needsRestart ||= res.needsRestart;
      if (res.needsRestart) return;
    } catch (err) {
      if (/HTTP (404|405)/.test((err as Error).message)) {
        throw new Error(`Listmonk has no per-key settings endpoint (needs v6+). ${byHand}`);
      }
      throw err;
    }
    // Listmonk reloads 500 ms after it answers; a health check sent
    // sooner can land before the reload and let the next write hit it.
    await waitForListmonk(auth, { initialDelayMs: opts.reloadDelayMs ?? 1_500 });
  };

  const plan = planSesSmtp(settings.smtp ?? [], ses, new URL(auth.url).hostname);
  if (plan.kind === "write") {
    await write("smtp", plan.smtp, "Paste the SES SMTP credentials into Settings → SMTP by hand.");
  }

  const currentFrom = settings["app.from_email"];
  let fromEmail: ApplySesSmtpResult["fromEmail"];
  if (listmonkFromEmailUnset(currentFrom)) {
    const display = ses.fromName ? `${ses.fromName} <${ses.fromEmail}>` : ses.fromEmail;
    await write(
      "app.from_email",
      display,
      `Set Settings → General → Default 'from' email to "${display}" by hand.`,
    );
    fromEmail = { value: display, written: true };
  } else {
    fromEmail = { value: String(currentFrom), written: false };
  }

  return {
    written: plan.kind === "write",
    ...(plan.kind === "in-place" ? { reason: "already in place" } : {}),
    ...(plan.kind === "blocked" ? { reason: plan.reason } : {}),
    fromEmail,
    ...(needsRestart ? { needsRestart } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Auth probe
// ────────────────────────────────────────────────────────────────────────────

/** Hit GET /api/lists to confirm the auth pair works. Returns the number
 *  of visible lists so the caller can echo "✓ Listmonk: 4 list(s) visible"
 *  without a second round-trip. */
export async function probeListmonk(auth: ListmonkAuth): Promise<{ listCount: number }> {
  const lists = await listListmonkLists(auth);
  return { listCount: lists.length };
}

// ────────────────────────────────────────────────────────────────────────────
// Users (Listmonk v4+) — used by `hatchkit secrets rotate --global listmonk`
//
// Listmonk mints an API user's token once, in the `POST /api/users`
// response (`data.password`), and has no endpoint that regenerates it
// (checked against v6.0.0: `UpdateUser` keeps an API user's stored token
// hash). Rotation therefore creates a replacement user with the same
// role, then renames it to the old name once the old user is deleted —
// the rename keeps the token (`update-user` only rewrites the password
// column for non-API users).
//
// `users:get` / `users:manage` are needed for everything but
// `/api/profile`, which any user may read about itself.
// ────────────────────────────────────────────────────────────────────────────

export interface ListmonkProfile {
  id: number;
  username: string;
  name: string;
  type: string;
  status: string;
  userRoleId: number;
  userRoleName: string;
  permissions: string[];
  listRoleId: number | null;
}

/** `GET /api/profile` — the user the auth pair belongs to. */
export async function getListmonkProfile(auth: ListmonkAuth): Promise<ListmonkProfile> {
  const d = await listmonkFetch<{
    id: number;
    username: string;
    name?: string;
    type: string;
    status: string;
    user_role?: { id: number; name: string; permissions?: string[] };
    list_role?: { id: number } | null;
  }>(auth, "GET", "/api/profile");
  return {
    id: d.id,
    username: d.username,
    name: d.name ?? d.username,
    type: d.type,
    status: d.status,
    userRoleId: d.user_role?.id ?? 0,
    userRoleName: d.user_role?.name ?? "",
    permissions: d.user_role?.permissions ?? [],
    listRoleId: d.list_role?.id ?? null,
  };
}

/** Create an API user. Returns its id and the token, which Listmonk
 *  shows exactly once. The caller must persist the token before doing
 *  anything else that can fail. */
export async function createListmonkApiUser(
  auth: ListmonkAuth,
  params: { username: string; name: string; userRoleId: number; listRoleId: number | null },
): Promise<{ id: number; username: string; token: string }> {
  const d = await listmonkFetch<{ id: number; username: string; password?: string }>(
    auth,
    "POST",
    "/api/users",
    {
      username: params.username,
      name: params.name,
      type: "api",
      status: "enabled",
      password_login: false,
      user_role_id: params.userRoleId,
      ...(params.listRoleId ? { list_role_id: params.listRoleId } : {}),
    },
  );
  if (!d.password) {
    throw new Error("Listmonk created the API user but returned no token");
  }
  return { id: d.id, username: d.username, token: d.password };
}

/** Rename an API user, keeping its role and its token. */
export async function renameListmonkApiUser(
  auth: ListmonkAuth,
  id: number,
  params: { username: string; name: string; userRoleId: number; listRoleId: number | null },
): Promise<void> {
  await listmonkFetch<unknown>(auth, "PUT", `/api/users/${id}`, {
    username: params.username,
    name: params.name,
    type: "api",
    status: "enabled",
    password_login: false,
    user_role_id: params.userRoleId,
    ...(params.listRoleId ? { list_role_id: params.listRoleId } : {}),
  });
}

/** Delete a user by id. Idempotent: a missing user is "not-found". */
export async function deleteListmonkUser(
  auth: ListmonkAuth,
  id: number,
): Promise<"deleted" | "not-found"> {
  try {
    await listmonkFetch<boolean>(auth, "DELETE", `/api/users/${id}`);
    return "deleted";
  } catch (err) {
    if (/HTTP 404\b/.test((err as Error).message)) return "not-found";
    throw err;
  }
}

/**
 * Swap the SMTP login on the settings entries that use `oldUsername`,
 * keeping every other field and every other SMTP server as they are.
 *
 * `applySesSmtpToListmonk` above is the provisioning path: it picks the
 * SES entry by the NEW username (falling back to the first SES entry)
 * and may write `app.from_email`. A key rotation matches on the OLD IAM
 * access key id instead and never touches the from-address. It writes
 * the same way — the per-key `PUT /api/settings/smtp`, which stores the
 * list as sent — so it inherits the same limit: another server whose
 * password GET masks would be written back as bullets, so the swap
 * refuses and says what to paste by hand.
 */
export async function swapListmonkSmtpCredentials(
  swap: { oldUsername: string; username: string; password: string },
  authOverride?: ListmonkAuth,
  opts: { reloadDelayMs?: number } = {},
): Promise<{ written: boolean; matched: number; reason?: string; needsRestart?: boolean }> {
  const auth = authOverride ?? (await ensureListmonk());
  const settings = await getListmonkSettings(auth);
  const current = settings.smtp ?? [];
  const plan = planSmtpSwap(current, swap.oldUsername);
  if (plan.matched === 0) return { written: false, matched: 0 };
  if (plan.blocked) return { written: false, matched: plan.matched, reason: plan.blocked };

  const smtp = current
    .filter((e) => !isListmonkSampleSmtp(e))
    .map((e) =>
      e.username === swap.oldUsername
        ? { ...e, uuid: e.uuid || randomUUID(), username: swap.username, password: swap.password }
        : e,
    );
  let res: { needsRestart: boolean };
  try {
    res = await putListmonkSetting("smtp", smtp, auth);
  } catch (err) {
    if (/HTTP (404|405)/.test((err as Error).message)) {
      throw new Error(
        "Listmonk has no per-key settings endpoint (needs v6+). Set the SES server's SMTP username and password in Settings → SMTP by hand.",
      );
    }
    throw err;
  }
  if (!res.needsRestart) {
    await waitForListmonk(auth, { initialDelayMs: opts.reloadDelayMs ?? 1_500 });
  }
  return {
    written: true,
    matched: plan.matched,
    ...(res.needsRestart ? { needsRestart: true } : {}),
  };
}

/** Which SMTP entries log in as `oldUsername`, and why the list can't
 *  be written back (another server's password is masked). Pure. */
function planSmtpSwap(
  current: ListmonkSmtpEntry[],
  oldUsername: string,
): { matched: number; blocked?: string } {
  const matched = current.filter((e) => e.username === oldUsername).length;
  const masked = current.filter(
    (e) =>
      e.username !== oldUsername &&
      !isListmonkSampleSmtp(e) &&
      e.password &&
      LISTMONK_SECRET_MASK.test(e.password),
  );
  if (matched === 0 || masked.length === 0) return { matched };
  const names = masked.map((e) => e.name || e.host).join(", ");
  return {
    matched,
    blocked:
      `Listmonk has other SMTP servers (${names}) and the API masks their passwords, so writing the SMTP list would replace them with the mask. ` +
      "In Listmonk → Settings → SMTP, set the SES server's username and password to SES_SMTP_USERNAME and SES_SMTP_PASSWORD from a rotated .env.production.",
  };
}

/** Read-only plan for `swapListmonkSmtpCredentials`. */
export async function planListmonkSmtpSwap(
  oldUsername: string,
  authOverride?: ListmonkAuth,
): Promise<{ matched: number; blocked?: string }> {
  const auth = authOverride ?? (await ensureListmonk());
  const settings = await getListmonkSettings(auth);
  return planSmtpSwap(settings.smtp ?? [], oldUsername);
}
