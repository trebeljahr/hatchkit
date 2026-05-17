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
  const data = await listmonkFetch<ListmonkListsResponse>(
    auth,
    "GET",
    "/api/lists?per_page=all",
  );
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
