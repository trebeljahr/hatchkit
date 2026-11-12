/**
 * The Listmonk confirm broker (src/listmonk-broker): the Worker and its
 * deploy. Listmonk and Cloudflare are in-memory fakes.
 *
 * Pinned here:
 *   1. The broker adds an existing, enabled subscriber to a list the
 *      caller manages, as confirmed, and nothing else.
 *   2. The caller's rights come from Listmonk's /api/profile with the
 *      caller's own token: a bad token is 401, a list the caller does not
 *      manage is 403, the broker's own user is refused.
 *   3. Missing subscriber 404, disabled or blocklisted 409, bad body 400.
 *   4. Deploy creates the least-privilege role and API user once, keeps
 *      the token in the keychain before anything else, uploads the Worker
 *      with LISTMONK_URL fixed, and refuses a user whose token is lost.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  BROKER_NAME,
  BROKER_PERMISSIONS,
  BROKER_TOKEN_SECRET,
  deployListmonkBroker,
} from "./src/listmonk-broker/deploy.ts";
import { type BrokerEnv, handleBrokerRequest } from "./src/listmonk-broker/worker.ts";

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

const LM = "https://listmonk.test";
const env: BrokerEnv = {
  LISTMONK_URL: LM,
  BROKER_API_USER: BROKER_NAME,
  BROKER_API_TOKEN: "broker-tok",
};

type Sub = {
  id: number;
  email: string;
  status: string;
  lists: { id: number; subscription_status: string }[];
};

function fakeListmonk(subs: Sub[]) {
  const users: Record<
    string,
    { username: string; status: string; perms: string[]; lists: number[] }
  > = {
    "token mesozoic:meso-tok": {
      username: "mesozoic",
      status: "enabled",
      perms: ["subscribers:manage"],
      lists: [21, 22],
    },
    "token reader:read-tok": {
      username: "reader",
      status: "enabled",
      perms: ["subscribers:get_all"],
      lists: [21],
    },
    [`token ${BROKER_NAME}:broker-tok`]: {
      username: BROKER_NAME,
      status: "enabled",
      perms: [...BROKER_PERMISSIONS],
      lists: [],
    },
  };
  const writes: { path: string; auth: string; body: any }[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? "");
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (url.pathname === "/api/profile") {
      const u = users[auth];
      if (!u) return new Response("{}", { status: 403 });
      return ok({
        username: u.username,
        status: u.status,
        user_role: { permissions: u.perms },
        list_role: {
          lists: u.lists.map((id) => ({ id, permissions: ["list:get", "list:manage"] })),
        },
      });
    }
    assert.equal(
      auth,
      `token ${BROKER_NAME}:broker-tok`,
      "subscriber calls use the broker credential",
    );
    if (url.pathname === "/api/subscribers" && (init.method ?? "GET") === "GET") {
      const re = new RegExp(url.searchParams.get("search") ?? "", "i");
      return ok({ results: subs.filter((s) => re.test(s.email)) });
    }
    if (url.pathname === "/api/subscribers/lists" && init.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path: url.pathname, auth, body });
      for (const s of subs.filter((x) => body.ids.includes(x.id))) {
        s.lists = s.lists.filter((l) => !body.target_list_ids.includes(l.id));
        for (const id of body.target_list_ids)
          s.lists.push({ id, subscription_status: body.status });
      }
      return ok(true);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, writes, subs };
}

function call(
  body: unknown,
  auth = "token mesozoic:meso-tok",
  path = "/confirm",
  method = "POST",
): Request {
  return new Request(`https://broker.test${path}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [i, e] = [console.info, console.error];
  console.info = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.info = i;
    console.error = e;
  }
};

await test("adds a subscriber on another project's list to the caller's list, and nothing else", async () => {
  const lm = fakeListmonk([
    {
      id: 7,
      email: "a+b@example.com",
      status: "enabled",
      lists: [{ id: 3, subscription_status: "confirmed" }],
    },
  ]);
  const res = await quiet(() =>
    handleBrokerRequest(call({ email: "A+B@example.com", list_id: 21 }), env, lm.fetchImpl),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, alreadyConfirmed: false });
  assert.deepEqual(
    lm.writes.map((w) => w.body),
    [{ ids: [7], action: "add", target_list_ids: [21], status: "confirmed" }],
  );
  assert.deepEqual(lm.subs[0].lists, [
    { id: 3, subscription_status: "confirmed" },
    { id: 21, subscription_status: "confirmed" },
  ]);
});

await test("reports an existing confirmation", async () => {
  const lm = fakeListmonk([
    {
      id: 7,
      email: "a@example.com",
      status: "enabled",
      lists: [{ id: 21, subscription_status: "confirmed" }],
    },
  ]);
  const res = await quiet(() =>
    handleBrokerRequest(call({ email: "a@example.com", list_id: 21 }), env, lm.fetchImpl),
  );
  assert.deepEqual(await res.json(), { ok: true, alreadyConfirmed: true });
});

await test("the caller's rights come from Listmonk, never from the request", async () => {
  const lm = fakeListmonk([
    {
      id: 7,
      email: "a@example.com",
      status: "enabled",
      lists: [{ id: 3, subscription_status: "confirmed" }],
    },
  ]);
  const run = (body: unknown, auth?: string) =>
    quiet(() => handleBrokerRequest(call(body, auth), env, lm.fetchImpl));
  assert.equal(
    (await run({ email: "a@example.com", list_id: 21 }, "token mesozoic:wrong")).status,
    401,
  );
  assert.equal((await run({ email: "a@example.com", list_id: 21 }, "Bearer x")).status, 401);
  // A list the caller does not manage (Cob's list 3).
  assert.equal((await run({ email: "a@example.com", list_id: 3 })).status, 403);
  // A caller without subscribers:manage.
  assert.equal(
    (await run({ email: "a@example.com", list_id: 21 }, "token reader:read-tok")).status,
    403,
  );
  // The broker's own credential is refused (it manages every list).
  assert.equal(
    (await run({ email: "a@example.com", list_id: 21 }, `token ${BROKER_NAME}:broker-tok`)).status,
    403,
  );
  assert.deepEqual(lm.writes, []);
});

await test("404 for no subscriber, 409 for a suppressed one, 400 for a bad body, 404/405 elsewhere", async () => {
  const lm = fakeListmonk([
    {
      id: 8,
      email: "block@example.com",
      status: "blocklisted",
      lists: [{ id: 3, subscription_status: "unsubscribed" }],
    },
  ]);
  const run = (req: Request) => quiet(() => handleBrokerRequest(req, env, lm.fetchImpl));
  assert.equal((await run(call({ email: "none@example.com", list_id: 21 }))).status, 404);
  assert.equal((await run(call({ email: "block@example.com", list_id: 21 }))).status, 409);
  assert.equal((await run(call({ email: "nope", list_id: 21 }))).status, 400);
  assert.equal((await run(call({ email: "a@example.com", list_id: "21" }))).status, 400);
  assert.equal((await run(call("{"))).status, 400);
  assert.equal((await run(call({}, undefined, "/other"))).status, 404);
  assert.equal((await run(call({}, undefined, "/confirm", "GET"))).status, 405);
  assert.deepEqual(lm.writes, []);
});

function fakeDeploy(opts: { roles?: any[]; users?: any[]; token?: string | null } = {}) {
  const roles = [...(opts.roles ?? [])];
  const users = [...(opts.users ?? [])];
  const secrets = new Map<string, string>();
  if (opts.token) secrets.set(BROKER_TOKEN_SECRET, opts.token);
  const order: string[] = [];
  const cfCalls: { method: string; path: string; body: unknown }[] = [];
  let saved: string | undefined;
  const deps = {
    listmonkUrl: LM,
    cloudflare: { token: "cf", accountId: "acc" },
    readModule: () => "export default {}",
    getSecret: async (k: string) => secrets.get(k) ?? null,
    setSecret: async (k: string, v: string) => {
      order.push(`keychain ${k}`);
      secrets.set(k, v);
    },
    saveBrokerUrl: (u: string) => {
      saved = u;
    },
    listmonk: {
      listUserRoles: async () => roles,
      createUserRole: async (name: string, permissions: string[]) => {
        order.push("create role");
        roles.push({ id: 9, name, permissions });
        return { id: 9 };
      },
      updateUserRole: async (id: number, _n: string, permissions: string[]) => {
        order.push("update role");
        roles.find((r) => r.id === id).permissions = permissions;
      },
      listUsers: async () => users,
      createApiUser: async (username: string, userRoleId: number) => {
        order.push("create user");
        users.push({ id: 5, username, userRoleId });
        return { token: "new-token" };
      },
    },
    fetch: async (input: string, init: RequestInit = {}) => {
      const path = input.replace("https://api.cloudflare.com/client/v4", "");
      order.push(`cf ${init.method} ${path}`);
      cfCalls.push({ method: String(init.method), path, body: init.body });
      const result = path.endsWith("/workers/subdomain") ? { subdomain: "acct" } : {};
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    },
  };
  return { deps, roles, users, secrets, order, cfCalls, saved: () => saved };
}

await test("deploy: least-privilege role + user once, token kept first, Worker uploaded", async () => {
  const f = fakeDeploy();
  const dry = await deployListmonkBroker({ ...f.deps, dryRun: true });
  assert.equal(dry.url, null);
  assert.deepEqual(f.order, []);

  const res = await deployListmonkBroker(f.deps);
  assert.equal(res.url, "https://hatchkit-listmonk-broker.acct.workers.dev");
  assert.equal(f.saved(), res.url);
  assert.deepEqual(f.roles[0].permissions, [...BROKER_PERMISSIONS]);
  assert.equal(f.secrets.get(BROKER_TOKEN_SECRET), "new-token");
  assert.deepEqual(f.order.slice(0, 3), [
    "create role",
    "create user",
    `keychain ${BROKER_TOKEN_SECRET}`,
  ]);
  const upload = f.cfCalls.find(
    (c) =>
      c.method === "PUT" && c.path === "/accounts/acc/workers/scripts/hatchkit-listmonk-broker",
  );
  const meta = JSON.parse(await ((upload?.body as FormData).get("metadata") as Blob).text());
  assert.deepEqual(meta.bindings, [
    { type: "plain_text", name: "LISTMONK_URL", text: LM },
    { type: "plain_text", name: "BROKER_API_USER", text: BROKER_NAME },
  ]);
  const secret = f.cfCalls.find((c) => c.path.endsWith("/secrets"));
  assert.deepEqual(JSON.parse(String(secret?.body)), {
    name: "BROKER_API_TOKEN",
    text: "new-token",
    type: "secret_text",
  });

  // Re-run: nothing new in Listmonk.
  f.order.length = 0;
  await deployListmonkBroker(f.deps);
  assert.equal(
    f.order.some((o) => !o.startsWith("cf ")),
    false,
  );
});

await test("deploy: resets drifted role permissions; refuses a user whose token is gone", async () => {
  const drifted = fakeDeploy({
    roles: [{ id: 9, name: BROKER_NAME, permissions: ["subscribers:get_all", "settings:manage"] }],
    users: [{ id: 5, username: BROKER_NAME, userRoleId: 9 }],
    token: "kept",
  });
  await deployListmonkBroker(drifted.deps);
  assert.deepEqual(drifted.roles[0].permissions, [...BROKER_PERMISSIONS]);

  const lost = fakeDeploy({
    roles: [{ id: 9, name: BROKER_NAME, permissions: [...BROKER_PERMISSIONS] }],
    users: [{ id: 5, username: BROKER_NAME, userRoleId: 9 }],
    token: null,
  });
  await assert.rejects(() => deployListmonkBroker(lost.deps), /no token for it/);
  assert.deepEqual(lost.cfCalls, []);
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nlistmonk-broker: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
