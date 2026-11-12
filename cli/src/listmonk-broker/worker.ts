/*
 * The Listmonk confirm broker (`hatchkit-listmonk-broker`), a Worker that
 * `hatchkit listmonk broker` deploys once per Listmonk instance.
 *
 * Why it exists: one email address is ONE Listmonk subscriber, shared by
 * every list on the instance. A project's own API user may change only a
 * subscriber that already holds one of its lists (Listmonk `hasSubPerm`
 * in cmd/subscribers.go), unless its role has a blanket
 * `lists:manage_all`. So a person already on project A's list who signs
 * up for project B can never confirm: B cannot create a second record
 * (409) and may not add its list to the existing one (403 "Permission
 * denied: subscriber"). Giving every project `lists:manage_all` would let
 * each project token change or delete every subscriber of every project.
 *
 * The broker holds one API user with `lists:manage_all` and does exactly
 * one thing for a caller: add an existing, enabled subscriber to a list
 * the caller itself manages, as `confirmed`. It never creates, deletes,
 * blocklists or unsubscribes, and never touches another list.
 *
 *   POST /confirm   Authorization: token <project user>:<project token>
 *                   body { "email": "...", "list_id": 21 }
 *     200 { ok: true, alreadyConfirmed }   added (or already confirmed)
 *     400 bad body · 401 caller token rejected by Listmonk
 *     403 the caller does not manage that list
 *     404 no subscriber with that email (the caller creates it itself)
 *     409 the subscriber is disabled or blocklisted
 *
 * The caller proves who it is with its own Listmonk credential: the
 * broker forwards it to `GET /api/profile` and reads the caller's
 * permissions from Listmonk, never from the request. Consent is the
 * caller's job, as it is for its own `PUT /api/subscribers/lists`: it
 * calls the broker only after verifying its confirm token, and only when
 * its own PUT answered 403.
 *
 * Zero imports: deploy uploads the compiled file as the Worker's only
 * module.
 */

export interface BrokerEnv {
  /** The Listmonk instance, fixed at deploy time. A caller never names it. */
  LISTMONK_URL: string;
  BROKER_API_USER: string;
  BROKER_API_TOKEN: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Profile = {
  username?: string;
  status?: string;
  user_role?: { permissions?: string[] };
  list_role?: { lists?: Array<{ id: number; permissions?: string[] }> } | null;
};

type Subscriber = {
  id: number;
  email: string;
  status: "enabled" | "disabled" | "blocklisted";
  lists?: Array<{ id: number; subscription_status: string }>;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function log(level: "info" | "error", event: string, extra: object = {}): void {
  // Never the address: the caller and the list are enough to trace a call.
  const line = JSON.stringify({ scope: "listmonk-broker", level, event, ...extra });
  if (level === "error") console.error(line);
  else console.info(line);
}

function base(env: BrokerEnv): string {
  return env.LISTMONK_URL.replace(/\/$/, "");
}

function escRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `token <user>:<token>`, the only scheme Listmonk API users have. */
function callerAuth(header: string | null): string | null {
  if (!header) return null;
  const m = /^token ([^\s:]+):(\S+)$/.exec(header.trim());
  return m ? `token ${m[1]}:${m[2]}` : null;
}

export async function handleBrokerRequest(
  request: Request,
  env: BrokerEnv,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/confirm") return json(404, { error: "not_found" });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

  const auth = callerAuth(request.headers.get("Authorization"));
  if (!auth) return json(401, { error: "unauthorized" });

  let body: { email?: unknown; list_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { error: "bad_request" });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const listId = body.list_id;
  if (!EMAIL_RE.test(email) || email.length > 254) return json(400, { error: "bad_request" });
  if (typeof listId !== "number" || !Number.isInteger(listId) || listId <= 0) {
    return json(400, { error: "bad_request" });
  }

  // 1. Who is calling, and may it manage this list? Listmonk answers.
  const profileRes = await fetchImpl(`${base(env)}/api/profile`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!profileRes.ok) {
    log("info", "caller_rejected", { status: profileRes.status });
    return json(401, { error: "unauthorized" });
  }
  const profile = ((await profileRes.json()) as { data?: Profile }).data ?? {};
  const caller = profile.username ?? "?";
  if (caller === env.BROKER_API_USER) return json(403, { error: "list_not_permitted" });
  const perms = profile.user_role?.permissions ?? [];
  const list = profile.list_role?.lists?.find((l) => l.id === listId);
  if (
    profile.status !== "enabled" ||
    !perms.includes("subscribers:manage") ||
    !list?.permissions?.includes("list:manage")
  ) {
    log("info", "list_not_permitted", { caller, list: listId });
    return json(403, { error: "list_not_permitted" });
  }

  // 2. The subscriber, read with the broker's own credential.
  const brokerAuth = `token ${env.BROKER_API_USER}:${env.BROKER_API_TOKEN}`;
  const params = new URLSearchParams({ search: `^${escRegex(email)}$`, per_page: "all" });
  const found = await fetchImpl(`${base(env)}/api/subscribers?${params}`, {
    headers: { Authorization: brokerAuth, Accept: "application/json" },
  });
  if (!found.ok) {
    log("error", "lookup_failed", { caller, list: listId, status: found.status });
    return json(502, { error: "listmonk_failed" });
  }
  const results =
    ((await found.json()) as { data?: { results?: Subscriber[] } }).data?.results ?? [];
  const sub = results.find((s) => s.email.toLowerCase() === email);
  if (!sub) return json(404, { error: "not_found" });
  if (sub.status !== "enabled") {
    log("info", "suppressed", { caller, list: listId });
    return json(409, { error: "suppressed" });
  }
  const alreadyConfirmed =
    sub.lists?.find((l) => l.id === listId)?.subscription_status === "confirmed";

  // 3. The one write: this list, as confirmed. No opt-in mail goes out on
  //    this path (`PUT /api/subscribers/lists`).
  const put = await fetchImpl(`${base(env)}/api/subscribers/lists`, {
    method: "PUT",
    headers: { Authorization: brokerAuth, "Content-Type": "application/json" },
    body: JSON.stringify({
      ids: [sub.id],
      action: "add",
      target_list_ids: [listId],
      status: "confirmed",
    }),
  });
  if (!put.ok) {
    log("error", "add_failed", { caller, list: listId, status: put.status });
    return json(502, { error: "listmonk_failed" });
  }
  log("info", "confirmed", { caller, list: listId, alreadyConfirmed });
  return json(200, { ok: true, alreadyConfirmed });
}

export default {
  fetch: (request: Request, env: BrokerEnv): Promise<Response> => handleBrokerRequest(request, env),
};
