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
 *   POST /api/templates
 *   DELETE /api/templates/{id}
 */

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
    optin: opts.optin ?? "single",
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
//     `{{ .Tx.Data.body }}` raw so the calling app can pass
//     pre-rendered subject + HTML through `POST /api/tx`. Tx templates
//     use Go's `text/template` (no auto-escape, and `safeHTML` is not
//     registered there) — the calling app owns the HTML it sends.
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

/** SQL-string query against `subscribers.email`. Listmonk supports
 *  `?query=<sql-fragment>` over `GET /api/subscribers`; the inner
 *  string is interpolated raw, so single quotes in the email get
 *  doubled to escape. Returns `null` on no match. */
export async function findListmonkSubscriberByEmail(
  email: string,
  authOverride?: ListmonkAuth,
): Promise<ListmonkSubscriber | null> {
  const auth = authOverride ?? (await ensureListmonk());
  const escaped = email.toLowerCase().replace(/'/g, "''");
  const q = encodeURIComponent(`subscribers.email = '${escaped}'`);
  const res = await listmonkFetch<{ results: ListmonkSubscriber[] }>(
    auth,
    "GET",
    `/api/subscribers?query=${q}&per_page=1`,
  );
  return res.results[0] ?? null;
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
// Listmonk's GET/PUT /api/settings drives the values the admin UI's
// Settings → General / Settings → SMTP pages edit. Hatchkit consumes
// this endpoint to:
//   1. Read app.root_url / app.admin_url / smtp[0] and detect drift.
//   2. Push the SES SMTP relay credentials we already derived, so the
//      manual "paste SES creds into Listmonk → Settings → SMTP" step
//      drops out of the per-project walkthrough.
//
// Auth: requires the API user to have `Settings: All` permission.
// Without it, calls 403 with `permission denied: settings:get` /
// `settings:manage`. Hatchkit surfaces a useful error in that case so
// the user knows to widen the role.
// ────────────────────────────────────────────────────────────────────────────

/** Shape of one entry in Listmonk's `settings.smtp[]` array. Mirrors the
 *  schema the admin UI's Settings → SMTP form posts. We only set the
 *  fields needed for a typical relay; the rest get sensible defaults
 *  from Listmonk if omitted (it round-trips by-uuid and replaces). */
export interface ListmonkSmtpEntry {
  name: string;
  uuid: string;
  enabled: boolean;
  host: string;
  hello_hostname: string;
  port: number;
  auth_protocol: "login" | "cram" | "plain" | "none";
  username: string;
  password: string;
  email_headers: Array<{ key: string; value: string }>;
  max_conns: number;
  max_msg_retries: number;
  idle_timeout: string;
  wait_timeout: string;
  tls_type: "STARTTLS" | "TLS" | "none";
  tls_skip_verify: boolean;
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

/** Replace Listmonk's entire settings document. The API is whole-object
 *  PUT, not patch — caller must read first, mutate, then push. The
 *  returned `data` is `true` on success. */
export async function putListmonkSettings(
  settings: Record<string, unknown>,
  authOverride?: ListmonkAuth,
): Promise<void> {
  const auth = authOverride ?? (await ensureListmonk());
  await listmonkFetch<boolean>(auth, "PUT", "/api/settings", settings);
}

/** Common-case helper: patch only the SES SMTP relay + the from-email
 *  display name on an existing settings document. Reads current
 *  settings, mutates in memory, PUTs back. Idempotent on re-run
 *  (compares by host+username+password and skips the PUT when already
 *  in place). Returns whether a write was performed.
 *
 *  Best-effort: when the calling API user lacks Settings: All the
 *  function throws a descriptive error the caller can downgrade to a
 *  warning + the manual-paste fallback. */
export async function applySesSmtpToListmonk(
  ses: {
    host: string;
    port: number;
    username: string;
    password: string;
    fromEmail: string;
    fromName?: string;
  },
  authOverride?: ListmonkAuth,
): Promise<{ written: boolean; reason?: string }> {
  const auth = authOverride ?? (await ensureListmonk());
  const settings = await getListmonkSettings(auth);

  const current = settings.smtp?.[0];
  const alreadyMatches =
    current?.host === ses.host &&
    current?.port === ses.port &&
    current?.username === ses.username &&
    current?.password === ses.password &&
    current?.enabled === true;
  if (alreadyMatches) return { written: false, reason: "already in place" };

  settings.smtp = [
    {
      name: "SES",
      uuid: current?.uuid ?? "",
      enabled: true,
      host: ses.host,
      hello_hostname: new URL(auth.url).hostname,
      port: ses.port,
      auth_protocol: "login",
      username: ses.username,
      password: ses.password,
      email_headers: [],
      max_conns: 10,
      max_msg_retries: 2,
      idle_timeout: "15s",
      wait_timeout: "5s",
      tls_type: "STARTTLS",
      tls_skip_verify: false,
    },
  ];

  const display = ses.fromName ? `${ses.fromName} <${ses.fromEmail}>` : ses.fromEmail;
  settings["app.from_email"] = display;

  await putListmonkSettings(settings, auth);
  return { written: true };
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
