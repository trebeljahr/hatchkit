/**
 * One Listmonk API user per project, against an in-memory Listmonk.
 *
 * Regression origin: `hatchkit add <project> listmonk-ses` wrote
 * hatchkit's own Listmonk API user and token into every project's env,
 * so collection-of-beauty, chemistry-sketcher and Coolify
 * `tracktime-server` all carried hatchkit's Admin-role token. Each
 * project now gets a user role, a list role and an API user of its own.
 *
 * The fake below enforces what these tests lean on, read from Listmonk
 * v6.0.0: route permissions (cmd/handlers.go), Super Admin role id 1
 * passing every check, the token returned once by `POST /api/users`,
 * `users.user_role_id … ON DELETE RESTRICT` and `list_role_id … ON
 * DELETE CASCADE` (schema.sql), and `PUT /api/roles/lists/:id`
 * replacing the whole list set (queries/roles.sql).
 *
 * What is pinned:
 *   1. First run creates exactly the three objects, with the permission
 *      set the starter needs (`subscribers:get_all`, not `:get`) and
 *      get + manage on the live and test lists only.
 *   2. The project token cannot read settings (403).
 *   3. A re-run with the stored token writes nothing.
 *   4. A re-run without a working token never deletes the user unless
 *      the caller says yes; with yes it recreates it and the old token
 *      dies.
 *   5. Roles with a missing permission or list get it added, and keep
 *      what else they hold.
 *   6. A login user or a reserved name (hatchkit's own user, the admin)
 *      is never replaced or deleted.
 *   7. Removal deletes user → user role → list role, and never a list
 *      role another user holds (that would delete the user too).
 *   8. The backfill helpers: list ids and tokens read from env files,
 *      SES_SMTP_* line removal.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// listmonk.js pulls in config.js, which opens the Conf store at import.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "hatchkit-lm-user-test-"));

const {
  PROJECT_USER_PERMISSIONS,
  checkListmonkAdmin,
  deleteListmonkApiUserIfNamed,
  deleteListmonkRoleIfUnheld,
  ensureListmonkProjectUser,
  inspectListmonkProjectUser,
  removeListmonkProjectUser,
  sharedListmonkUserWarning,
} = await import("./src/provision/listmonk-project-user.js");
const { getListmonkSettings, getListmonkProfile } = await import("./src/provision/listmonk.js");
const { decideListmonkRegenerate, listmonkListIdsFromEnv, projectTokenFromEnv, SES_SMTP_KEYS } =
  await import("./src/provision/listmonk-user-cli.js");
const { removeEnvKeys } = await import("./src/provision/write-env.js");

const failures: string[] = [];
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).stack ?? (err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ---------------------------------------------------------------------------
// fake Listmonk v6
// ---------------------------------------------------------------------------

const URL_BASE = "https://listmonk.test";

interface FUser {
  id: number;
  username: string;
  type: "user" | "api";
  status: string;
  token: string | null;
  userRoleId: number;
  listRoleId: number | null;
}
interface FUserRole {
  id: number;
  name: string;
  permissions: string[];
}
interface FListRole {
  id: number;
  name: string;
  lists: Array<{ id: number; permissions: string[] }>;
}

class FakeListmonk {
  nextId = 100;
  tokenSeq = 0;
  users: FUser[] = [];
  userRoles: FUserRole[] = [
    { id: 1, name: "Super Admin", permissions: [] },
    {
      id: 2,
      name: "Admin",
      permissions: [
        "lists:get_all",
        "lists:manage_all",
        "subscribers:get_all",
        "settings:get",
        "settings:manage",
      ],
    },
  ];
  listRoles: FListRole[] = [];
  lists = [
    { id: 7, name: "demo" },
    { id: 8, name: "demo-test" },
    { id: 9, name: "other" },
  ];
  /** Every call, `METHOD /path`. */
  calls: string[] = [];

  constructor() {
    this.users.push(
      {
        id: 1,
        username: "hatchkit-admin",
        type: "api",
        status: "enabled",
        token: "ADMINTOKEN",
        userRoleId: 1,
        listRoleId: null,
      },
      {
        id: 5,
        username: "hatchkit",
        type: "api",
        status: "enabled",
        token: "SHAREDTOKEN",
        userRoleId: 2,
        listRoleId: null,
      },
    );
  }

  writes(): string[] {
    return this.calls.filter((c) => !c.startsWith("GET "));
  }

  private newToken(): string {
    this.tokenSeq += 1;
    return `tok${String(this.tokenSeq).padStart(29, "0")}`;
  }

  private perms(u: FUser): Set<string> | "all" {
    if (u.userRoleId === 1) return "all";
    return new Set(this.userRoles.find((r) => r.id === u.userRoleId)?.permissions ?? []);
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private userJson(u: FUser) {
    const role = this.userRoles.find((r) => r.id === u.userRoleId);
    const lr = this.listRoles.find((r) => r.id === u.listRoleId);
    return {
      id: u.id,
      username: u.username,
      type: u.type,
      status: u.status,
      user_role_id: u.userRoleId,
      user_role: {
        id: role?.id ?? 0,
        name: role?.name ?? "",
        permissions: role?.permissions ?? [],
      },
      list_role: lr ? { id: lr.id, name: lr.name, lists: lr.lists } : null,
    };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    this.calls.push(`${method} ${path}`);
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const m = auth.match(/^token ([^:]+):(.+)$/);
    const caller = m
      ? this.users.find((u) => u.username === m[1] && u.token === m[2] && u.status === "enabled")
      : undefined;
    if (!caller) return this.json(403, { message: "invalid API credentials" });
    const perms = this.perms(caller);
    const need = (...any: string[]) => perms === "all" || any.some((p) => perms.has(p));
    const denied = () => this.json(403, { message: "permission denied" });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const idOf = (re: RegExp) => Number(path.match(re)?.[1]);

    if (method === "GET" && path === "/api/profile")
      return this.json(200, { data: this.userJson(caller) });
    if (method === "GET" && path === "/api/settings") {
      return need("settings:get") ? this.json(200, { data: { smtp: [] } }) : denied();
    }
    if (method === "GET" && path === "/api/lists") {
      return this.json(200, { data: { results: this.lists, total: this.lists.length } });
    }
    if (path === "/api/users" && method === "GET") {
      return need("users:get")
        ? this.json(200, { data: this.users.map((u) => this.userJson(u)) })
        : denied();
    }
    if (path === "/api/users" && method === "POST") {
      if (!need("users:manage")) return denied();
      if (this.users.some((u) => u.username === body.username)) {
        return this.json(500, { message: "Error creating user: duplicate key" });
      }
      const u: FUser = {
        id: this.nextId++,
        username: body.username,
        type: body.type,
        status: body.status,
        token: body.type === "api" ? this.newToken() : null,
        userRoleId: body.user_role_id,
        listRoleId: body.list_role_id ?? null,
      };
      this.users.push(u);
      return this.json(200, { data: { ...this.userJson(u), password: u.token } });
    }
    if (/^\/api\/users\/\d+$/.test(path) && method === "DELETE") {
      if (!need("users:manage")) return denied();
      this.users = this.users.filter((u) => u.id !== idOf(/(\d+)$/));
      return this.json(200, { data: true });
    }
    if (path === "/api/roles/users" && method === "GET") {
      return need("roles:get")
        ? this.json(200, { data: this.userRoles.map((r) => ({ ...r, type: "user", lists: [] })) })
        : denied();
    }
    if (path === "/api/roles/lists" && method === "GET") {
      return need("roles:get")
        ? this.json(200, {
            data: this.listRoles.map((r) => ({
              ...r,
              lists: r.lists.map((l) => ({
                ...l,
                name: this.lists.find((x) => x.id === l.id)?.name,
              })),
            })),
          })
        : denied();
    }
    if (path === "/api/roles/users" && method === "POST") {
      if (!need("roles:manage")) return denied();
      if (this.userRoles.some((r) => r.name === body.name))
        return this.json(500, { message: "duplicate" });
      const r = { id: this.nextId++, name: body.name, permissions: body.permissions };
      this.userRoles.push(r);
      return this.json(200, { data: { ...r, type: "user" } });
    }
    if (path === "/api/roles/lists" && method === "POST") {
      if (!need("roles:manage")) return denied();
      if (this.listRoles.some((r) => r.name === body.name))
        return this.json(500, { message: "duplicate" });
      const r = { id: this.nextId++, name: body.name, lists: body.lists };
      this.listRoles.push(r);
      return this.json(200, { data: { id: r.id, name: r.name, lists: [] } });
    }
    if (/^\/api\/roles\/users\/\d+$/.test(path) && method === "PUT") {
      if (!need("roles:manage")) return denied();
      const r = this.userRoles.find((x) => x.id === idOf(/(\d+)$/));
      if (!r) return this.json(404, { message: "not found" });
      r.name = body.name;
      r.permissions = body.permissions;
      return this.json(200, { data: r });
    }
    if (/^\/api\/roles\/lists\/\d+$/.test(path) && method === "PUT") {
      if (!need("roles:manage")) return denied();
      const r = this.listRoles.find((x) => x.id === idOf(/(\d+)$/));
      if (!r) return this.json(404, { message: "not found" });
      r.name = body.name;
      r.lists = body.lists; // replaces the set
      return this.json(200, { data: r });
    }
    if (/^\/api\/roles\/\d+$/.test(path) && method === "DELETE") {
      if (!need("roles:manage")) return denied();
      const id = idOf(/(\d+)$/);
      if (this.users.some((u) => u.userRoleId === id)) {
        return this.json(500, { message: "violates foreign key constraint (RESTRICT)" });
      }
      // list_role_id … ON DELETE CASCADE
      this.users = this.users.filter((u) => u.listRoleId !== id);
      this.userRoles = this.userRoles.filter((r) => r.id !== id);
      this.listRoles = this.listRoles.filter((r) => r.id !== id);
      return this.json(200, { data: true });
    }
    return this.json(404, { message: `no route ${method} ${path}` });
  };
}

const realFetch = globalThis.fetch;
let lm = new FakeListmonk();
function fresh(): FakeListmonk {
  lm = new FakeListmonk();
  globalThis.fetch = lm.fetch as typeof fetch;
  return lm;
}
const admin = { url: URL_BASE, apiUser: "hatchkit-admin", apiToken: "ADMINTOKEN" };
const reserved = ["hatchkit", "hatchkit-admin"];

// ---------------------------------------------------------------------------
// ensure
// ---------------------------------------------------------------------------

console.log("ensureListmonkProjectUser:");

await check("first run creates the user role, the list role and the API user", async () => {
  fresh();
  const events: string[] = [];
  let tokenSeenBeforeReturn = "";
  const res = await ensureListmonkProjectUser(
    { admin, name: "demo", listIds: [7, 8], reservedNames: reserved },
    {
      onRole: (e) => events.push(`role:${e.roleType}:${e.createdThisRun}`),
      onUser: (e) => events.push(`user:${e.createdThisRun}`),
      onToken: (e) => {
        tokenSeenBeforeReturn = e.token;
      },
    },
  );
  const role = lm.userRoles.find((r) => r.name === "demo");
  assert.deepEqual(role?.permissions, [...PROJECT_USER_PERMISSIONS]);
  assert.ok(role?.permissions.includes("subscribers:get_all"), "needs get_all, not get");
  assert.ok(!role?.permissions.includes("subscribers:get"));
  const listRole = lm.listRoles.find((r) => r.name === "demo");
  assert.deepEqual(listRole?.lists, [
    { id: 7, permissions: ["list:get", "list:manage"] },
    { id: 8, permissions: ["list:get", "list:manage"] },
  ]);
  const user = lm.users.find((u) => u.username === "demo");
  assert.equal(user?.type, "api");
  assert.equal(user?.userRoleId, role?.id);
  assert.equal(user?.listRoleId, listRole?.id);
  assert.equal(res.token, user?.token);
  assert.equal(tokenSeenBeforeReturn, res.token);
  assert.deepEqual(res.created, { userRole: true, listRole: true, user: true });
  assert.deepEqual(events, ["role:user:true", "role:list:true", "user:true"]);
  assert.deepEqual(lm.writes(), [
    "POST /api/roles/users",
    "POST /api/roles/lists",
    "POST /api/users",
  ]);
});

await check("the project token signs in, and cannot read settings (403)", async () => {
  fresh();
  const res = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  const auth = { url: URL_BASE, apiUser: "demo", apiToken: res.token };
  assert.equal((await getListmonkProfile(auth)).username, "demo");
  await assert.rejects(getListmonkSettings(auth), /HTTP 403/);
});

await check("a re-run with the stored token adopts all three and writes nothing", async () => {
  fresh();
  const first = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  lm.calls = [];
  const events: string[] = [];
  const again = await ensureListmonkProjectUser(
    { admin, name: "demo", listIds: [7, 8], cachedTokens: [first.token] },
    {
      onRole: (e) => events.push(`role:${e.roleType}:${e.createdThisRun}`),
      onUser: (e) => events.push(`user:${e.createdThisRun}`),
    },
  );
  assert.deepEqual(lm.writes(), []);
  assert.deepEqual(again.changes, []);
  assert.equal(again.token, first.token);
  assert.equal(again.userId, first.userId);
  assert.deepEqual(events, ["role:user:false", "role:list:false", "user:false"]);
});

await check("a dead cached token is skipped for a working one", async () => {
  fresh();
  const first = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  lm.calls = [];
  const again = await ensureListmonkProjectUser({
    admin,
    name: "demo",
    listIds: [7, 8],
    cachedTokens: ["deadtoken", first.token],
  });
  assert.equal(again.token, first.token);
  assert.deepEqual(lm.writes(), []);
});

await check("no working token and no yes: stops, deletes nothing", async () => {
  fresh();
  const first = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  lm.calls = [];
  let asked = 0;
  await assert.rejects(
    ensureListmonkProjectUser({
      admin,
      name: "demo",
      listIds: [7, 8],
      confirmRegenerate: async () => {
        asked += 1;
        return false;
      },
    }),
    /exists, but no token for it is stored[\s\S]*--regenerate-token/,
  );
  assert.equal(asked, 1);
  assert.deepEqual(lm.writes(), []);
  assert.equal(lm.users.find((u) => u.username === "demo")?.id, first.userId);
});

await check("no confirm callback at all counts as no", async () => {
  fresh();
  await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  lm.calls = [];
  await assert.rejects(
    ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] }),
    /exists/,
  );
  assert.deepEqual(lm.writes(), []);
});

await check("with yes: recreates the user; roles stay; the old token dies", async () => {
  fresh();
  const first = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  const again = await ensureListmonkProjectUser({
    admin,
    name: "demo",
    listIds: [7, 8],
    confirmRegenerate: async () => true,
  });
  assert.equal(again.regenerated, true);
  assert.notEqual(again.userId, first.userId);
  assert.notEqual(again.token, first.token);
  assert.equal(again.userRoleId, first.userRoleId);
  assert.equal(again.listRoleId, first.listRoleId);
  await assert.rejects(
    getListmonkProfile({ url: URL_BASE, apiUser: "demo", apiToken: first.token }),
    /HTTP 403/,
  );
  assert.equal(lm.users.filter((u) => u.username === "demo").length, 1);
});

await check("a user role missing a permission gets it added; extras are kept", async () => {
  fresh();
  lm.userRoles.push({ id: 50, name: "demo", permissions: ["tx:send", "templates:get"] });
  const res = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  const role = lm.userRoles.find((r) => r.id === 50);
  assert.equal(res.userRoleId, 50);
  assert.deepEqual(
    new Set(role?.permissions),
    new Set([...PROJECT_USER_PERMISSIONS, "templates:get"]),
  );
  assert.ok(
    res.changes.some((c) =>
      /add subscribers:get_all, subscribers:manage, campaigns:manage to user role demo/.test(c),
    ),
  );
  assert.ok(lm.writes().includes("PUT /api/roles/users/50"));
});

await check(
  "a list role missing a list gets it; other lists stay (PUT replaces the set)",
  async () => {
    fresh();
    lm.listRoles.push({
      id: 60,
      name: "demo",
      lists: [
        { id: 7, permissions: ["list:get"] },
        { id: 9, permissions: ["list:get"] },
      ],
    });
    await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
    const role = lm.listRoles.find((r) => r.id === 60);
    const byId = new Map(role?.lists.map((l) => [l.id, new Set(l.permissions)]));
    assert.deepEqual(byId.get(7), new Set(["list:get", "list:manage"]));
    assert.deepEqual(byId.get(8), new Set(["list:get", "list:manage"]));
    assert.deepEqual(byId.get(9), new Set(["list:get"]), "list 9 must survive the PUT");
  },
);

await check("a user holding other roles is recreated only with a yes", async () => {
  fresh();
  const first = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  const user = lm.users.find((u) => u.username === "demo");
  if (user) user.userRoleId = 2;
  lm.calls = [];
  await assert.rejects(
    ensureListmonkProjectUser({
      admin,
      name: "demo",
      listIds: [7, 8],
      cachedTokens: [first.token],
    }),
    /does not hold user role demo and list role demo/,
  );
  assert.deepEqual(lm.writes(), [], "no PUT /api/users — it would wipe the token");
});

await check("a login user with the project's name is never replaced", async () => {
  fresh();
  lm.users.push({
    id: 70,
    username: "demo",
    type: "user",
    status: "enabled",
    token: null,
    userRoleId: 2,
    listRoleId: null,
  });
  await assert.rejects(
    ensureListmonkProjectUser({
      admin,
      name: "demo",
      listIds: [7, 8],
      confirmRegenerate: async () => true,
    }),
    /login user/,
  );
  assert.ok(lm.users.some((u) => u.id === 70));
  assert.ok(!lm.writes().some((c) => c.startsWith("DELETE /api/users")));
});

await check(
  "reserved names (hatchkit's own user, the admin) are refused before any call",
  async () => {
    fresh();
    for (const name of reserved) {
      await assert.rejects(
        ensureListmonkProjectUser({
          admin,
          name,
          listIds: [7],
          reservedNames: reserved,
          confirmRegenerate: async () => true,
        }),
        /hatchkit's own credential/,
      );
    }
    assert.deepEqual(lm.calls, []);
  },
);

await check("names Listmonk cannot hold, and an empty list set, are refused", async () => {
  fresh();
  await assert.rejects(
    ensureListmonkProjectUser({ admin, name: "ab", listIds: [7] }),
    /cannot be a Listmonk username/,
  );
  await assert.rejects(
    ensureListmonkProjectUser({ admin, name: "demo", listIds: [] }),
    /grant nothing/,
  );
});

await check("dry run plans the three creates and writes nothing", async () => {
  fresh();
  const res = await ensureListmonkProjectUser({
    admin,
    name: "demo",
    listIds: [7, 8],
    dryRun: true,
  });
  assert.deepEqual(lm.writes(), []);
  assert.equal(res.token, "");
  assert.equal(res.changes.length, 3);
  assert.match(
    res.changes.join("\n"),
    /create user role demo[\s\S]*create list role demo[\s\S]*create API user demo/,
  );
});

// ---------------------------------------------------------------------------
// admin credential
// ---------------------------------------------------------------------------

console.log("\ncheckListmonkAdmin:");

await check("accepts a Super Admin API user", async () => {
  fresh();
  assert.equal((await checkListmonkAdmin(admin)).username, "hatchkit-admin");
});

await check("refuses hatchkit's own Admin-role user: no users:* / roles:*", async () => {
  fresh();
  await assert.rejects(
    checkListmonkAdmin({ url: URL_BASE, apiUser: "hatchkit", apiToken: "SHAREDTOKEN" }),
    /lacks users:get, users:manage, roles:get, roles:manage/,
  );
});

await check("a rejected token names the keychain entry to fix", async () => {
  fresh();
  await assert.rejects(
    checkListmonkAdmin({ ...admin, apiToken: "wrong" }),
    /listmonk:admin-api-token[\s\S]*security add-generic-password -U -s hatchkit -a listmonk:admin-api-token -w/,
  );
});

await check("the fallback warning names the shared user and the fix", () => {
  const text = sharedListmonkUserWarning("demo", "hatchkit").join("\n");
  assert.match(text, /demo gets hatchkit's own API user hatchkit/);
  assert.match(text, /hatchkit-admin/);
  assert.match(text, /hatchkit listmonk user demo/);
});

// ---------------------------------------------------------------------------
// inspect + decide (asked before any spinner)
// ---------------------------------------------------------------------------

console.log("\ninspect / decideListmonkRegenerate:");

await check(
  "inspect: null without a user, a reason without a token, null reason with one",
  async () => {
    fresh();
    assert.equal(await inspectListmonkProjectUser(admin, "demo", []), null);
    const first = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
    assert.match((await inspectListmonkProjectUser(admin, "demo", []))?.reason ?? "", /no token/);
    assert.equal((await inspectListmonkProjectUser(admin, "demo", [first.token]))?.reason, null);
  },
);

await check("decide: nothing to regenerate → false; allowed → true; else it throws", async () => {
  fresh();
  const base = {
    admin,
    name: "demo",
    cachedTokens: [] as string[],
    allow: false,
    interactive: false,
  };
  assert.equal(await decideListmonkRegenerate(base), false);
  await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  assert.equal(await decideListmonkRegenerate({ ...base, allow: true }), true);
  await assert.rejects(decideListmonkRegenerate(base), /--regenerate-token/);
  lm.calls = [];
  await assert.rejects(
    decideListmonkRegenerate({ ...base, name: "hatchkit", allow: true, reservedNames: reserved }),
    /hatchkit's own credential/,
  );
  assert.deepEqual(lm.calls, [], "refused before any Listmonk call");
  assert.ok(!lm.writes().some((c) => c.startsWith("DELETE")), "deciding never deletes");
});

// ---------------------------------------------------------------------------
// removal
// ---------------------------------------------------------------------------

console.log("\nremoveListmonkProjectUser:");

await check("deletes user, then user role, then list role", async () => {
  fresh();
  await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  lm.calls = [];
  const res = await removeListmonkProjectUser(admin, "demo", { reservedNames: reserved });
  assert.deepEqual([res.user, res.userRole, res.listRole], ["deleted", "deleted", "deleted"]);
  const deletes = lm.writes();
  assert.equal(deletes.length, 3);
  assert.match(deletes[0], /^DELETE \/api\/users\//);
  assert.ok(!lm.users.some((u) => u.username === "demo"));
  assert.ok(!lm.userRoles.some((r) => r.name === "demo"));
  assert.ok(!lm.listRoles.some((r) => r.name === "demo"));
  assert.ok(
    lm.users.some((u) => u.username === "hatchkit"),
    "other users survive",
  );
});

await check("keeps a list role another user holds (deleting it would delete them)", async () => {
  fresh();
  const res0 = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  lm.users.push({
    id: 80,
    username: "demo-ci",
    type: "api",
    status: "enabled",
    token: "x",
    userRoleId: 2,
    listRoleId: res0.listRoleId,
  });
  const res = await removeListmonkProjectUser(admin, "demo");
  assert.equal(res.listRole, "skipped");
  assert.match(res.notes.join("\n"), /demo-ci/);
  assert.ok(lm.users.some((u) => u.id === 80));
});

await check("never touches a login user or a reserved name", async () => {
  fresh();
  lm.users.push({
    id: 70,
    username: "demo",
    type: "user",
    status: "enabled",
    token: null,
    userRoleId: 2,
    listRoleId: null,
  });
  const res = await removeListmonkProjectUser(admin, "demo");
  assert.equal(res.user, "skipped");
  assert.ok(lm.users.some((u) => u.id === 70));
  const r2 = await removeListmonkProjectUser(admin, "hatchkit", { reservedNames: reserved });
  assert.equal(r2.user, "skipped");
  assert.ok(lm.users.some((u) => u.username === "hatchkit"));
});

await check("dry run deletes nothing", async () => {
  fresh();
  await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  lm.calls = [];
  const res = await removeListmonkProjectUser(admin, "demo", { dryRun: true });
  assert.equal(res.user, "deleted");
  assert.deepEqual(lm.writes(), []);
});

await check("ledger undo refuses a role a user still holds", async () => {
  fresh();
  const res = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
  await assert.rejects(
    deleteListmonkRoleIfUnheld(admin, "list", res.listRoleId),
    /still held by demo/,
  );
  assert.ok(lm.users.some((u) => u.username === "demo"));
  await removeListmonkProjectUser(admin, "demo");
  assert.equal(await deleteListmonkRoleIfUnheld(admin, "list", res.listRoleId), "not-found");
});

await check(
  "ledger undo deletes by id only while the id still carries the recorded name",
  async () => {
    fresh();
    const res = await ensureListmonkProjectUser({ admin, name: "demo", listIds: [7, 8] });
    await assert.rejects(
      deleteListmonkApiUserIfNamed(admin, res.userId, "someone-else"),
      /left alone/,
    );
    await assert.rejects(deleteListmonkApiUserIfNamed(admin, 5, "demo"), /now hatchkit/);
    assert.ok(lm.users.some((u) => u.username === "hatchkit"));
    assert.equal(await deleteListmonkApiUserIfNamed(admin, res.userId, "demo"), "deleted");
    assert.equal(await deleteListmonkApiUserIfNamed(admin, res.userId, "demo"), "not-found");
    await assert.rejects(
      deleteListmonkRoleIfUnheld(admin, "user", res.userRoleId, "other"),
      /left alone/,
    );
    assert.equal(
      await deleteListmonkRoleIfUnheld(admin, "user", res.userRoleId, "demo"),
      "deleted",
    );
  },
);

// ---------------------------------------------------------------------------
// backfill helpers
// ---------------------------------------------------------------------------

console.log("\nbackfill helpers:");

await check("list ids: LISTMONK_LIVE_LIST_ID, else the older LISTMONK_LIST_ID", () => {
  assert.deepEqual(
    listmonkListIdsFromEnv({ LISTMONK_LIVE_LIST_ID: "7", LISTMONK_TEST_LIST_ID: "8" }, {}),
    { live: 7, test: 8 },
  );
  // collection-of-beauty's shape: prod names only the live list the old way.
  assert.deepEqual(listmonkListIdsFromEnv({ LISTMONK_LIST_ID: "3" }, { LISTMONK_LIST_ID: "4" }), {
    live: 3,
    test: 4,
  });
  assert.deepEqual(listmonkListIdsFromEnv({ LISTMONK_LIST_ID: "x" }, {}), {
    live: undefined,
    test: undefined,
  });
});

await check("a token in the env counts only for the project's own user", () => {
  assert.equal(
    projectTokenFromEnv("demo", { LISTMONK_API_USER: "hatchkit", LISTMONK_API_TOKEN: "t1" }),
    undefined,
  );
  assert.equal(
    projectTokenFromEnv(
      "demo",
      { LISTMONK_API_USER: "hatchkit", LISTMONK_API_TOKEN: "t1" },
      { LISTMONK_API_USER: "demo", LISTMONK_API_TOKEN: "t2" },
    ),
    "t2",
  );
});

await check("removeEnvKeys drops the SES_SMTP_* lines and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-envkeys-"));
  const path = join(dir, ".env.production");
  const text = [
    "#/---- dotenvx header ----/",
    'DOTENV_PUBLIC_KEY_PRODUCTION="03abc"',
    'LISTMONK_URL="encrypted:AAA"',
    'SES_SMTP_HOST="encrypted:BBB"',
    'SES_SMTP_PORT="encrypted:CCC"',
    'SES_SMTP_USERNAME="encrypted:DDD"',
    'SES_SMTP_PASSWORD="encrypted:EEE"',
    'SES_FROM_EMAIL="encrypted:FFF"',
    "",
  ].join("\n");
  writeFileSync(path, text);
  assert.deepEqual(removeEnvKeys(path, SES_SMTP_KEYS), [...SES_SMTP_KEYS]);
  const after = readFileSync(path, "utf-8");
  assert.equal(
    after,
    [
      "#/---- dotenvx header ----/",
      'DOTENV_PUBLIC_KEY_PRODUCTION="03abc"',
      'LISTMONK_URL="encrypted:AAA"',
      'SES_FROM_EMAIL="encrypted:FFF"',
      "",
    ].join("\n"),
  );
  assert.deepEqual(removeEnvKeys(path, SES_SMTP_KEYS), [], "second run is a no-op");
});

globalThis.fetch = realFetch;

if (failures.length > 0) {
  console.error(
    `\n${failures.length} listmonk project-user test(s) failed:\n${failures.join("\n\n")}`,
  );
  process.exit(1);
}
console.log("\nAll listmonk project-user tests passed.");
