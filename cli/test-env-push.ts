/**
 * The production env push (deploy/env-push.ts), and the two commands
 * that run it.
 *
 * A fresh `hatchkit create` of a fullstack image-runtime project used to
 * fail its first deploy. Create wrote MONGODB_URI into
 * `packages/server/.env.production` after its initial commit, never
 * committed it, and set only a handful of baseline vars on the Coolify
 * apps. The image does not contain `.env.production`, so the server died
 * at boot with "Missing required environment variable: MONGODB_URI" and
 * the CI deploy gate failed. A manual `hatchkit sync` fixed it, but
 * `sync --deploy` after that env-only change triggered no redeploy, so
 * the container kept the old env.
 *
 * Locks in:
 *
 *   1. pushProductionEnv pushes the file's values, the baseline and each
 *      app's own PORT onto the server side, and reports which apps' env
 *      changed (key names only). A client app gets NODE_ENV, its PORT and
 *      the client package's own file, never the server's secrets; server
 *      keys an earlier push left on it are deleted (dry run: listed), a
 *      refused delete is an error naming them. A root env file is shared
 *      by every app, as before.
 *   2. Live env equal to the file → pushed, reported unchanged.
 *      Live values unreadable → counted as changed.
 *   3. Ciphertext the key can't open → nothing pushed, an error.
 *   4. `sync --deploy` redeploys an app whose env changed while its
 *      routing was already in sync; not when the env was equal; and
 *      without `--deploy` it says a redeploy is needed.
 *   5. commitDeployWiring commits what was written after the initial
 *      commit, and is a no-op on a clean tree.
 *   6. create pushes the env and commits the late writes after the
 *      database step and before the first `git push`.
 *   7. adopt pushes the env before its first push and again after
 *      provisioning, commits what it wrote after its first commit before
 *      pushing a brand-new repo, and commits + pushes the env files
 *      provisioning changed (pathspec-scoped: user WIP is refused).
 *
 * No test touches a real Coolify: `fetch` is replaced by a fake.
 *
 * Run: `node scripts/test.mjs test-env-push.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Conf from "conf";
import {
  type AdoptPlan,
  type DetectedState,
  commitAndPushScaffold,
  lateEnvCommitFiles,
  pushAdoptProductionEnv,
} from "./src/adopt.js";
import { type EnvPushApp, pushProductionEnv } from "./src/deploy/env-push.js";
import { commitDeployWiring } from "./src/deploy/github.js";
import { type SyncOptions, runSync } from "./src/deploy/sync.js";
import { CoolifyApi } from "./src/utils/coolify-api.js";
import { SECRET_KEYS, setSecret } from "./src/utils/secrets.js";

const failures: string[] = [];
async function expect(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Fake Coolify: applications with an env store
// ---------------------------------------------------------------------------

const COOLIFY_URL = "https://coolify.test.local";

interface FakeApp {
  uuid: string;
  name: string;
  build_pack: string;
  fqdn?: string | null;
  ports_exposes?: string;
  health_check_enabled?: boolean;
  health_check_path?: string;
  health_check_interval?: number;
  health_check_retries?: number;
}

interface EnvRow {
  key: string;
  value: string;
  is_preview: boolean;
  uuid?: string;
}

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** A Coolify that knows `apps`, keeps each app's env in `env`, and
 *  records every request. `hideValues` answers GET /envs without the
 *  `value` field, as Coolify does for a token lacking read:sensitive. */
function fakeCoolify(
  apps: FakeApp[],
  env: Record<string, EnvRow[]> = {},
  opts: { hideValues?: boolean; denyDelete?: boolean } = {},
): { fetch: typeof fetch; calls: Call[]; env: Record<string, EnvRow[]> } {
  const calls: Call[] = [];
  let rowSeq = 0;
  for (const rows of Object.values(env)) {
    for (const r of rows) r.uuid ??= `env-${++rowSeq}`;
  }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (method === "GET" && path === "/applications") {
      return json(apps.map((a) => ({ uuid: a.uuid, name: a.name })));
    }
    const one = path.match(/^\/applications\/([^/]+)$/);
    if (one) {
      const app = apps.find((a) => a.uuid === one[1]);
      if (!app) return json({ message: "Not found." }, 404);
      if (method === "GET") return json(app);
      if (method === "PATCH") return json({ uuid: app.uuid });
    }
    const envs = path.match(/^\/applications\/([^/]+)\/envs$/);
    if (envs && method === "GET") {
      const rows = env[envs[1]] ?? [];
      return json(
        rows.map((r) =>
          opts.hideValues
            ? { uuid: r.uuid, key: r.key, is_preview: r.is_preview }
            : { ...r, is_literal: true },
        ),
      );
    }
    const oneEnv = path.match(/^\/applications\/([^/]+)\/envs\/([^/]+)$/);
    if (oneEnv && method === "DELETE") {
      if (opts.denyDelete) return json({ message: "Missing required permissions: delete" }, 403);
      const rows = env[oneEnv[1]] ?? [];
      const at = rows.findIndex((r) => r.uuid === oneEnv[2]);
      if (at < 0) return json({ message: "Environment variable not found." }, 404);
      rows.splice(at, 1);
      return json({ message: "Environment variable deleted." });
    }
    const bulk = path.match(/^\/applications\/([^/]+)\/envs\/bulk$/);
    if (bulk && method === "PATCH") {
      if (!env[bulk[1]]) env[bulk[1]] = [];
      const rows = env[bulk[1]];
      for (const item of (body?.data ?? []) as Array<{ key: string; value: string }>) {
        const existing = rows.find((r) => r.key === item.key && !r.is_preview);
        if (existing) existing.value = item.value;
        else
          rows.push({
            key: item.key,
            value: item.value,
            is_preview: false,
            uuid: `env-${++rowSeq}`,
          });
      }
      return json({ message: "ok" });
    }
    const start = path.match(/^\/applications\/([^/]+)\/start$/);
    if (start) return json({ deployment_uuid: `deploy-${start[1]}` });
    if (method === "GET" && path === "/databases") return json([]);
    return json({ message: `fake Coolify: unhandled ${method} ${path}` }, 404);
  };
  return { fetch: impl as unknown as typeof fetch, calls, env };
}

/** Run `fn` with `fetch` faked and console.log captured. */
async function withCoolify<T>(
  fake: { fetch: typeof fetch },
  fn: () => Promise<T>,
): Promise<{ value: T; out: string }> {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines: string[] = [];
  globalThis.fetch = fake.fetch;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const value = await fn();
    return { value, out: lines.join("\n") };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

const api = new CoolifyApi({ url: COOLIFY_URL, token: "test-coolify-token" });
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const bulkBody = (calls: Call[], uuid: string): Record<string, string> => {
  const call = calls.find(
    (c) => c.method === "PATCH" && c.path === `/applications/${uuid}/envs/bulk`,
  );
  assert.ok(call, `no env PATCH for ${uuid}`);
  return Object.fromEntries(
    (call.body?.data as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
  );
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = [];

const MONGO_URL = "mongodb://db-test:27017/demo";

/** A project dir with `.hatchkit.json` and a plaintext server
 *  `.env.production` (resolveProductionEnv reads plaintext as-is). */
function projectDir(manifest: Record<string, unknown>, envProduction?: string): string {
  // realpath: macOS tmpdir is a symlink, and git reports the resolved
  // path, so relative paths computed from the two would disagree.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hk-env-push-")));
  dirs.push(dir);
  writeFileSync(join(dir, ".hatchkit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (envProduction !== undefined) {
    mkdirSync(join(dir, "packages/server"), { recursive: true });
    writeFileSync(join(dir, "packages/server/.env.production"), envProduction);
  }
  return dir;
}

const ENV_FILE = `MONGODB_URI=${MONGO_URL}\nBETTER_AUTH_SECRET=test-auth-secret\n`;

const PROJECT = { name: "demo-app", domain: "demo.example.com", surfaces: "fullstack" };

const PAIR: EnvPushApp[] = [
  { uuid: "client-uuid", name: "demo-app-client", role: "client", portsExposes: "3001" },
  { uuid: "server-uuid", name: "demo-app-server", role: "server", portsExposes: "3000" },
];

/** What the client app of PAIR holds after a push of ENV_FILE. */
function clientRows(port: string): EnvRow[] {
  return [
    { key: "NODE_ENV", value: "production", is_preview: false },
    { key: "PORT", value: port, is_preview: false },
  ];
}

/** What the server app of PAIR holds after a push of ENV_FILE, and what
 *  every app held after a push by an earlier release. */
function pushedRows(port: string): EnvRow[] {
  return Object.entries({
    NODE_ENV: "production",
    FRONTEND_URL: "https://demo.example.com",
    MONGODB_URI: MONGO_URL,
    BETTER_AUTH_SECRET: "test-auth-secret",
    PORT: port,
  }).map(([key, value]) => ({ key, value, is_preview: false }));
}

// ---------------------------------------------------------------------------
// 1–3. pushProductionEnv
// ---------------------------------------------------------------------------

console.log("\npushProductionEnv:");

await expect("pushes file values + baseline + each app's PORT, reports both changed", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  // What create's Coolify setup leaves on a fresh image pair.
  const fake = fakeCoolify([], {
    "client-uuid": [
      { key: "NODE_ENV", value: "production", is_preview: false },
      { key: "PORT", value: "3001", is_preview: false },
    ],
    "server-uuid": [
      { key: "NODE_ENV", value: "production", is_preview: false },
      { key: "PORT", value: "3000", is_preview: false },
      { key: "FRONTEND_URL", value: "https://demo.example.com", is_preview: false },
    ],
  });
  const { value: outcome, out } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
  );
  assert.ok(outcome);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.relPath, join("packages", "server", ".env.production"));
  assert.deepEqual(outcome.pushed, { "demo-app-client": 2, "demo-app-server": 5 });
  const server = bulkBody(fake.calls, "server-uuid");
  assert.equal(server.MONGODB_URI, MONGO_URL, "the database URL reaches the server");
  assert.equal(server.BETTER_AUTH_SECRET, "test-auth-secret");
  assert.equal(server.PORT, "3000");
  assert.equal(server.NODE_ENV, "production");
  assert.equal(server.FRONTEND_URL, "https://demo.example.com");
  assert.deepEqual(
    bulkBody(fake.calls, "client-uuid"),
    { NODE_ENV: "production", PORT: "3001" },
    "the client gets its own port and none of the server's secrets",
  );
  assert.deepEqual(
    outcome.changed.map((c) => [c.name, [...c.keys].sort(), c.unreadable]),
    [["demo-app-server", ["BETTER_AUTH_SECRET", "MONGODB_URI"], false]],
  );
  assert.deepEqual(outcome.removed, {});
  assert.ok(!out.includes(MONGO_URL), "a value was printed");
  assert.ok(!out.includes("test-auth-secret"), "a value was printed");
});

await expect("live env equal to the file → pushed, reported unchanged", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const fake = fakeCoolify([], {
    "client-uuid": clientRows("3001"),
    "server-uuid": pushedRows("3000"),
  });
  const { value: outcome } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
  );
  assert.ok(outcome);
  assert.deepEqual(outcome.changed, []);
  assert.equal(writes(fake.calls).length, 2, "still pushed to both apps");
});

await expect(
  "a preview row with the right value does not hide a missing production row",
  async () => {
    const dir = projectDir({ name: "demo-app" }, ENV_FILE);
    const rows = pushedRows("3000").filter((r) => r.key !== "MONGODB_URI");
    rows.push({ key: "MONGODB_URI", value: MONGO_URL, is_preview: true });
    const fake = fakeCoolify([], { "server-uuid": rows });
    const { value: outcome } = await withCoolify(fake, () =>
      pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: [PAIR[1]!] }),
    );
    assert.deepEqual(
      outcome?.changed.map((c) => c.keys),
      [["MONGODB_URI"]],
    );
  },
);

await expect("live values unreadable → counted as changed", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const fake = fakeCoolify([], { "server-uuid": pushedRows("3000") }, { hideValues: true });
  const { value: outcome } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: [PAIR[1]!] }),
  );
  assert.deepEqual(
    outcome?.changed.map((c) => [c.name, c.keys, c.unreadable]),
    [["demo-app-server", [], true]],
  );
});

await expect("a compose app keeps the PORT its compose file pins", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const fake = fakeCoolify([]);
  await withCoolify(fake, () =>
    pushProductionEnv({
      api,
      projectDir: dir,
      project: PROJECT,
      apps: [{ uuid: "compose-uuid", name: "demo-app", role: "compose", portsExposes: "3001" }],
    }),
  );
  const body = bulkBody(fake.calls, "compose-uuid");
  assert.equal(body.PORT, undefined);
  assert.equal(body.MONGODB_URI, MONGO_URL);
});

await expect("ciphertext the key can't open → nothing pushed, the fix named", async () => {
  const dir = projectDir(
    { name: "demo-app" },
    'MONGODB_URI="encrypted:BCtSlYNoXhJmFd8bjBAAApD9wRkNOMNj"\nNODE_ENV=production\n',
  );
  const fake = fakeCoolify([]);
  const { value: outcome } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
  );
  assert.ok(outcome);
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0]!, /MONGODB_URI/);
  assert.match(outcome.errors[0]!, /hatchkit keys show demo-app/);
  assert.deepEqual(writes(fake.calls), [], "no half-resolved env reaches Coolify");
});

await expect("no .env.production → null, no request", async () => {
  const dir = projectDir({ name: "demo-app" });
  const fake = fakeCoolify([]);
  const { value: outcome } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
  );
  assert.equal(outcome, null);
  assert.deepEqual(fake.calls, []);
});

await expect("dry run → counts only, no write, nothing reported changed", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const fake = fakeCoolify([]);
  const { value: outcome, out } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR, dryRun: true }),
  );
  assert.deepEqual(outcome?.pushed, { "demo-app-client": 2, "demo-app-server": 5 });
  assert.deepEqual(outcome?.changed, []);
  assert.deepEqual(writes(fake.calls), []);
  assert.match(out, /would push 5 var\(s\)/);
});

await expect("server keys an earlier push left on a client app are deleted", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const client = [
    ...pushedRows("3001"),
    { key: "DOTENV_PRIVATE_KEY_PRODUCTION", value: "test-private-key", is_preview: false },
    // Set by hand in the dashboard: not the server's, so it stays.
    { key: "CLIENT_ONLY_FLAG", value: "on", is_preview: false },
    // Preview rows are not production env and are never touched.
    { key: "MONGODB_URI", value: MONGO_URL, is_preview: true },
  ];
  const fake = fakeCoolify([], { "client-uuid": client, "server-uuid": pushedRows("3000") });
  const { value: outcome, out } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
  );
  assert.ok(outcome);
  assert.deepEqual(outcome.errors, []);
  const removed = ["BETTER_AUTH_SECRET", "DOTENV_PRIVATE_KEY_PRODUCTION", "MONGODB_URI"];
  assert.deepEqual([...(outcome.removed["demo-app-client"] ?? [])].sort(), removed);
  assert.deepEqual(
    fake.env["client-uuid"]!.map((r) => `${r.key}${r.is_preview ? " (preview)" : ""}`).sort(),
    ["CLIENT_ONLY_FLAG", "FRONTEND_URL", "MONGODB_URI (preview)", "NODE_ENV", "PORT"],
    "FRONTEND_URL is a baseline, not a secret of the server file",
  );
  assert.equal(
    fake.calls.filter((c) => c.method === "DELETE").length,
    3,
    "one DELETE per server key, by row uuid",
  );
  assert.deepEqual(
    outcome.changed.map((c) => [c.name, [...c.removed].sort()]),
    [["demo-app-client", removed]],
    "a removal is a change: the container keeps the old env until redeployed",
  );
  assert.ok(!fake.calls.some((c) => c.method === "DELETE" && c.path.includes("server-uuid")));
  assert.ok(!out.includes(MONGO_URL), "a value was printed");
  assert.ok(!out.includes("test-private-key"), "a value was printed");
});

await expect("dry run lists the server keys it would delete, deletes nothing", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const fake = fakeCoolify([], { "client-uuid": pushedRows("3001") });
  const { value: outcome, out } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR, dryRun: true }),
  );
  assert.deepEqual(writes(fake.calls), []);
  assert.deepEqual([...(outcome?.removed["demo-app-client"] ?? [])].sort(), [
    "BETTER_AUTH_SECRET",
    "MONGODB_URI",
  ]);
  assert.match(out, /would remove 2 server key\(s\): .*MONGODB_URI/);
});

await expect("a delete Coolify refuses → an error naming the keys and the fix", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const fake = fakeCoolify([], { "client-uuid": pushedRows("3001") }, { denyDelete: true });
  const { value: outcome } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
  );
  assert.ok(outcome);
  assert.equal(outcome.errors.length, 1, outcome.errors.join("\n"));
  assert.match(outcome.errors[0]!, /demo-app-client: still holds server key\(s\) /);
  assert.match(outcome.errors[0]!, /MONGODB_URI/);
  assert.match(outcome.errors[0]!, /Environment Variables/);
  assert.deepEqual(outcome.removed, {});
  assert.equal(
    bulkBody(fake.calls, "server-uuid").MONGODB_URI,
    MONGO_URL,
    "the server still got its env",
  );
});

await expect("the client package's own .env.production reaches the client app", async () => {
  const dir = projectDir(
    { name: "demo-app" },
    `${ENV_FILE}SENTRY_DSN=https://server-dsn@example.com/1\n`,
  );
  mkdirSync(join(dir, "packages/client"), { recursive: true });
  writeFileSync(
    join(dir, "packages/client/.env.production"),
    "NEXT_PUBLIC_SENTRY_DSN=https://client-dsn@example.com/2\nSENTRY_DSN=https://client-dsn@example.com/2\n" +
      'LOCKED="encrypted:BCtSlYNoXhJmFd8bjBAAApD9wRkNOMNj"\n',
  );
  const fake = fakeCoolify([], {
    "client-uuid": [...pushedRows("3001"), { key: "LOCKED", value: "x", is_preview: false }],
  });
  const { value: outcome, out } = await withCoolify(fake, () =>
    pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
  );
  assert.ok(outcome);
  assert.deepEqual(outcome.errors, [], "an undecryptable client value blocks nothing");
  assert.deepEqual(bulkBody(fake.calls, "client-uuid"), {
    NODE_ENV: "production",
    NEXT_PUBLIC_SENTRY_DSN: "https://client-dsn@example.com/2",
    SENTRY_DSN: "https://client-dsn@example.com/2",
    PORT: "3001",
  });
  assert.deepEqual(
    [...(outcome.removed["demo-app-client"] ?? [])].sort(),
    ["BETTER_AUTH_SECRET", "MONGODB_URI"],
    "a key the client file declares stays, even one the server file has too",
  );
  assert.ok(
    fake.env["client-uuid"]!.some((r) => r.key === "LOCKED"),
    "its own key is kept",
  );
  assert.match(out, /LOCKED/);
  assert.equal(bulkBody(fake.calls, "server-uuid").SENTRY_DSN, "https://server-dsn@example.com/1");
});

await expect(
  "a root .env.production is shared: every app gets all of it, nothing removed",
  async () => {
    const dir = projectDir({ name: "demo-app" });
    writeFileSync(join(dir, ".env.production"), ENV_FILE);
    const fake = fakeCoolify([], { "client-uuid": pushedRows("3001") });
    const { value: outcome } = await withCoolify(fake, () =>
      pushProductionEnv({ api, projectDir: dir, project: PROJECT, apps: PAIR }),
    );
    assert.ok(outcome);
    assert.equal(bulkBody(fake.calls, "client-uuid").MONGODB_URI, MONGO_URL);
    assert.deepEqual(outcome.removed, {});
    assert.ok(!fake.calls.some((c) => c.method === "DELETE"));
  },
);

// ---------------------------------------------------------------------------
// 4. sync --deploy redeploys an app whose env changed
// ---------------------------------------------------------------------------

console.log("\nsync --deploy:");

// Coolify config for runSync, in the isolated config dir test.mjs set up.
new Conf({ projectName: "hatchkit", cwd: process.env.HATCHKIT_CONF_DIR }).set("providers.coolify", {
  status: "configured",
  url: COOLIFY_URL,
});
await setSecret(SECRET_KEYS.coolifyToken, "test-coolify-token");

const APP_UUID = "demo-app-uuid";

/** One image app named after the project, its routing already what the
 *  manifest asks for. */
const IMAGE_MANIFEST = {
  version: 5,
  name: "demo-app",
  domain: "demo.example.com",
  deploymentMode: "coolify",
  ports: { server: 3000, client: 3001 },
  surfaces: "fullstack",
  publicService: "client",
  coolifyRuntime: "image",
  containerPorts: { app: 3000 },
  topology: "single-origin",
};

function inSyncApp(): FakeApp {
  return {
    uuid: APP_UUID,
    name: "demo-app",
    build_pack: "dockerimage",
    fqdn: "https://demo.example.com",
    ports_exposes: "3000",
    health_check_enabled: true,
    health_check_path: "/",
    health_check_interval: 4,
    health_check_retries: 3,
  };
}

/** Env, routing and deploy passes only: DNS, secrets, preflight and
 *  origins have their own tests. */
const ENV_AND_DEPLOY: Omit<SyncOptions, "projectDir"> = {
  dns: false,
  secrets: false,
  preflight: false,
  nativeOrigins: false,
};

const starts = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && /\/start$/.test(c.path)).map((c) => c.path);

await expect("env-only change, routing in sync → redeployed", async () => {
  const dir = projectDir(IMAGE_MANIFEST, ENV_FILE);
  // Live env without MONGODB_URI: the state a fresh create left behind.
  const live = pushedRows("3000").filter((r) => r.key !== "MONGODB_URI");
  const fake = fakeCoolify([inSyncApp()], { [APP_UUID]: live });
  const { value: result, out } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, deploy: true, ...ENV_AND_DEPLOY }),
  );
  assert.equal(result.ok, true, result.error ?? out);
  assert.deepEqual(
    result.apps.map((a) => [a.name, a.changed]),
    [["demo-app", false]],
    `routing should already be in sync:\n${out}`,
  );
  assert.ok(
    !fake.calls.some((c) => c.method === "PATCH" && c.path === `/applications/${APP_UUID}`),
    "no routing PATCH",
  );
  assert.equal(bulkBody(fake.calls, APP_UUID).MONGODB_URI, MONGO_URL);
  assert.deepEqual(result.envChanged, ["demo-app"]);
  assert.deepEqual(starts(fake.calls), [`/applications/${APP_UUID}/start`]);
  assert.deepEqual(result.deployed, ["demo-app"]);
});

await expect("env equal to the file → no redeploy", async () => {
  const dir = projectDir(IMAGE_MANIFEST, ENV_FILE);
  const fake = fakeCoolify([inSyncApp()], { [APP_UUID]: pushedRows("3000") });
  const { value: result, out } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, deploy: true, ...ENV_AND_DEPLOY }),
  );
  assert.equal(result.ok, true, result.error ?? out);
  assert.deepEqual(result.envChanged, []);
  assert.deepEqual(starts(fake.calls), []);
  assert.deepEqual(result.deployed, []);
});

await expect("env changed without --deploy → no redeploy, says one is needed", async () => {
  const dir = projectDir(IMAGE_MANIFEST, ENV_FILE);
  const fake = fakeCoolify([inSyncApp()], { [APP_UUID]: [] });
  const { value: result, out } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, ...ENV_AND_DEPLOY }),
  );
  assert.equal(result.ok, true, result.error ?? out);
  assert.deepEqual(result.envChanged, ["demo-app"]);
  assert.deepEqual(starts(fake.calls), []);
  assert.match(out, /Env changed on "demo-app"/);
  assert.match(out, /--deploy/);
});

await expect("--no-env → env untouched, nothing to redeploy", async () => {
  const dir = projectDir(IMAGE_MANIFEST, ENV_FILE);
  const fake = fakeCoolify([inSyncApp()], { [APP_UUID]: [] });
  const { value: result } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, deploy: true, env: false, ...ENV_AND_DEPLOY }),
  );
  assert.deepEqual(result.envChanged, []);
  assert.deepEqual(writes(fake.calls), []);
});

/** The two Docker Image apps of an image-runtime `single-origin` project. */
function imagePair(): FakeApp[] {
  return [
    {
      uuid: "client-uuid",
      name: "demo-app-client",
      build_pack: "dockerimage",
      fqdn: "https://demo.example.com",
      ports_exposes: "3000",
    },
    {
      uuid: "server-uuid",
      name: "demo-app-server",
      build_pack: "dockerimage",
      fqdn: "https://demo.example.com/api",
      ports_exposes: "3000",
    },
  ];
}

await expect(
  "sync: an image pair's client loses the server keys; --deploy redeploys it",
  async () => {
    const dir = projectDir(IMAGE_MANIFEST, ENV_FILE);
    const fake = fakeCoolify(imagePair(), {
      "client-uuid": pushedRows("3000"),
      "server-uuid": pushedRows("3000"),
    });
    const { value: result, out } = await withCoolify(fake, () =>
      runSync({ projectDir: dir, deploy: true, ...ENV_AND_DEPLOY }),
    );
    assert.equal(result.ok, true, result.error ?? out);
    assert.deepEqual(
      Object.fromEntries(Object.entries(result.envRemoved).map(([k, v]) => [k, [...v].sort()])),
      { "demo-app-client": ["BETTER_AUTH_SECRET", "MONGODB_URI"] },
    );
    assert.ok(!fake.env["client-uuid"]!.some((r) => r.key === "MONGODB_URI"));
    assert.ok(fake.env["server-uuid"]!.some((r) => r.key === "MONGODB_URI"));
    assert.ok(result.envChanged.includes("demo-app-client"));
    assert.ok(starts(fake.calls).includes("/applications/client-uuid/start"), out);
  },
);

await expect("sync --dry-run: names the client's server keys, deletes nothing", async () => {
  const dir = projectDir(IMAGE_MANIFEST, ENV_FILE);
  const fake = fakeCoolify(imagePair(), { "client-uuid": pushedRows("3000") });
  const { value: result, out } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, dryRun: true, ...ENV_AND_DEPLOY }),
  );
  assert.ok(!fake.calls.some((c) => c.method === "DELETE"), out);
  assert.deepEqual([...(result.envRemoved["demo-app-client"] ?? [])].sort(), [
    "BETTER_AUTH_SECRET",
    "MONGODB_URI",
  ]);
  assert.match(out, /demo-app-client: would remove 2 server key\(s\)/);
});

// ---------------------------------------------------------------------------
// 5. commitDeployWiring
// ---------------------------------------------------------------------------

console.log("\ncommitDeployWiring:");

/** The starter's env lines: ignore the keys, and re-include the
 *  committed env files a global ignore rule may list. */
const STARTER_GITIGNORE = ".env.keys\n.env.*.local\n!.env.development\n!.env.production\n";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
Object.assign(process.env, GIT_ENV);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...GIT_ENV } }).trim();

await expect("commits what was written after the initial commit; clean tree → no-op", async () => {
  const dir = projectDir({ name: "demo-app" }, 'BETTER_AUTH_SECRET="encrypted:BAAAinitial"\n');
  writeFileSync(join(dir, ".gitignore"), STARTER_GITIGNORE);
  writeFileSync(join(dir, "packages/server/.env.keys"), "DOTENV_PRIVATE_KEY_PRODUCTION=abc\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial scaffold");

  // What the Coolify database step does after that commit.
  writeFileSync(
    join(dir, "packages/server/.env.production"),
    'BETTER_AUTH_SECRET="encrypted:BAAAinitial"\nMONGODB_URI="encrypted:BAAAlate"\n',
  );
  writeFileSync(join(dir, ".hatchkit.json"), `${JSON.stringify({ name: "demo-app", v: 2 })}\n`);

  const files = await commitDeployWiring(dir, "demo-app");
  assert.deepEqual([...files].sort(), [".hatchkit.json", "packages/server/.env.production"]);
  assert.equal(git(dir, "status", "--porcelain"), "", "tree clean after the commit");
  assert.equal(git(dir, "rev-list", "--count", "HEAD"), "2");
  assert.match(git(dir, "log", "-1", "--format=%B"), /packages\/server\/\.env\.production/);
  assert.match(git(dir, "show", "HEAD:packages/server/.env.production"), /MONGODB_URI=/);
  assert.throws(() => git(dir, "show", "HEAD:packages/server/.env.keys"), "the key stays out");

  assert.deepEqual(await commitDeployWiring(dir, "demo-app"), []);
  assert.equal(git(dir, "rev-list", "--count", "HEAD"), "2", "no empty commit");
});

// ---------------------------------------------------------------------------
// 6. create: env push + commit after the database step, before the push
// ---------------------------------------------------------------------------

console.log("\ncreate ordering:");

await expect("create pushes env and commits late writes before pushInitialBranch", () => {
  const src = readFileSync(new URL("./src/index.ts", import.meta.url), "utf-8");
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.notEqual(i, -1, `index.ts no longer contains ${needle}`);
    return i;
  };
  const mongo = at("await provisionCoolifyMongo(config");
  const postgres = at("await provisionCoolifyPostgres(config");
  const redis = at("await provisionCoolifyRedis(config");
  const glitchtip = at("await deliverProvisionedDsn(");
  const commit = at("await commitDeployWiring(appDir");
  const envPush = at("await pushProductionEnv(");
  const push = at("await pushInitialBranch(appDir");
  for (const [name, writer] of [
    ["MongoDB", mongo],
    ["Postgres", postgres],
    ["Redis", redis],
    ["GlitchTip DSN", glitchtip],
  ] as const) {
    assert.ok(writer < commit, `${name} writes after the late commit`);
    assert.ok(writer < envPush, `${name} writes after the env push`);
  }
  assert.ok(commit < push, "late writes committed before the push");
  assert.ok(envPush < push, "env pushed before the push");
});

// ---------------------------------------------------------------------------
// 7. adopt
// ---------------------------------------------------------------------------

console.log("\nadopt:");

await expect("adopt: env push and late commits sit around its pushes", () => {
  const src = readFileSync(new URL("./src/adopt.ts", import.meta.url), "utf-8");
  const start = src.indexOf("async function executePlan(");
  const body = src.slice(start, src.indexOf("\nasync function ", start + 1));
  const at = (needle: string, from = 0) => {
    const i = body.indexOf(needle, from);
    assert.notEqual(i, -1, `executePlan no longer contains ${needle}`);
    return i;
  };
  const scaffold = at("await scaffoldBuildPipelineNow(");
  const wire = at("coolifyResult = await wireProjectIntoCoolify(");
  const firstEnv = at("await pushAdoptProductionEnv(");
  const lateCommit = at("await commitDeployWiring(state.repoRoot");
  const initialPush = at("await pushInitialBranch(state.repoRoot)");
  const scaffoldPush = at("await commitAndPushScaffold(state, plan.name, {");
  const provision = at("await runProvision(");
  const stripe = at("// Step 4c: Stripe");
  const secondEnv = at("await pushAdoptProductionEnv(", provision);
  const envCommit = at("record the provisioned production env");
  const keyPush = at("// Step 5: push key to Coolify");
  assert.ok(wire < firstEnv, "env pushed once the apps exist");
  assert.ok(firstEnv < initialPush && firstEnv < scaffoldPush, "env pushed before the first push");
  assert.ok(
    scaffold < lateCommit && lateCommit < initialPush,
    "scaffold committed before the push",
  );
  assert.ok(provision < secondEnv && stripe < secondEnv, "second env push after provisioning");
  assert.ok(secondEnv < envCommit && envCommit < keyPush, "env files committed after the push");
});

/** A repo with one commit, pushed to a bare `origin`. */
function repoWithOrigin(): { dir: string; origin: string } {
  const dir = projectDir({ name: "demo-app" }, 'BETTER_AUTH_SECRET="encrypted:BAAAinitial"\n');
  const origin = realpathSync(mkdtempSync(join(tmpdir(), "hk-env-push-origin-")));
  dirs.push(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), STARTER_GITIGNORE);
  writeFileSync(join(dir, "README.md"), "demo\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Adopt under hatchkit management");
  git(dir, "push", "-q", "origin", "main");
  return { dir, origin };
}

function adoptState(dir: string): DetectedState {
  return { projectDir: dir, repoRoot: dir } as DetectedState;
}

function lateEnvPaths(dir: string) {
  const envDir = join(dir, "packages/server");
  return {
    scaffoldedAbsPaths: [],
    overwrittenAbsPaths: [".env.production", ".env.development", ".env.example"].map((n) =>
      join(envDir, n),
    ),
    manifestPath: join(dir, ".hatchkit.json"),
  };
}

const RECORD_MESSAGE = "chore(hatchkit): record the provisioned production env";

await expect("adopt: provisioned env files committed and pushed", async () => {
  const { dir, origin } = repoWithOrigin();
  // What Step 4 writes after the Step 3d push.
  writeFileSync(
    join(dir, "packages/server/.env.production"),
    'BETTER_AUTH_SECRET="encrypted:BAAAinitial"\nS3_SECRET_KEY="encrypted:BAAAlate"\n',
  );
  writeFileSync(join(dir, ".hatchkit.json"), `${JSON.stringify({ name: "demo-app", v: 2 })}\n`);
  const { value: result } = await withCoolify(fakeCoolify([]), () =>
    commitAndPushScaffold(adoptState(dir), "demo-app", lateEnvPaths(dir), {
      message: RECORD_MESSAGE,
    }),
  );
  assert.deepEqual(result, { pushed: true });
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), RECORD_MESSAGE);
  assert.match(git(origin, "show", "main:packages/server/.env.production"), /S3_SECRET_KEY=/);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

await expect("adopt: nothing changed → no commit, no push", async () => {
  const { dir, origin } = repoWithOrigin();
  const before = git(origin, "rev-parse", "main");
  const { value: result } = await withCoolify(fakeCoolify([]), () =>
    commitAndPushScaffold(adoptState(dir), "demo-app", lateEnvPaths(dir), {
      message: RECORD_MESSAGE,
    }),
  );
  assert.deepEqual(result, { pushed: false });
  assert.equal(git(origin, "rev-parse", "main"), before);
});

await expect("adopt: user WIP elsewhere → refused with a caveat, nothing pushed", async () => {
  const { dir, origin } = repoWithOrigin();
  const before = git(origin, "rev-parse", "main");
  writeFileSync(
    join(dir, "packages/server/.env.production"),
    'BETTER_AUTH_SECRET="encrypted:BAAAinitial"\nS3_SECRET_KEY="encrypted:BAAAlate"\n',
  );
  writeFileSync(join(dir, "README.md"), "demo, edited by hand\n");
  const { value: result } = await withCoolify(fakeCoolify([]), () =>
    commitAndPushScaffold(adoptState(dir), "demo-app", lateEnvPaths(dir), {
      message: RECORD_MESSAGE,
    }),
  );
  assert.equal(result.pushed, false);
  assert.match(result.caveat?.title ?? "", /unrelated changes/);
  assert.ok(result.caveat?.recovery.some((line) => line.includes("README.md")));
  assert.equal(git(origin, "rev-parse", "main"), before);
});

await expect(
  "adopt: ignored encrypted .env.production force-added, local dev env left out",
  async () => {
    const { dir, origin } = repoWithOrigin();
    const serverDir = join(dir, "packages/server");
    // A repo whose own ignore rules list the env files, as a global one
    // often does.
    writeFileSync(join(dir, ".gitignore"), ".env.keys\n.env.production\n.env.development\n");
    writeFileSync(join(serverDir, ".env.example"), "S3_SECRET_KEY=\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ignore env files");
    git(dir, "push", "-q", "origin", "main");
    writeFileSync(
      join(serverDir, ".env.production"),
      'DOTENV_PUBLIC_KEY_PRODUCTION="02abc"\nS3_SECRET_KEY="encrypted:BAAAlate"\n',
    );
    writeFileSync(join(serverDir, ".env.development"), "S3_SECRET_KEY=local-dev-value\n");
    writeFileSync(join(serverDir, ".env.example"), "S3_SECRET_KEY=\nS3_BUCKET=\n");

    const files = await lateEnvCommitFiles(
      { projectDir: dir },
      { serverDir, clientDir: undefined },
    );
    assert.deepEqual(files.forceAdd, [join(serverDir, ".env.production")]);
    assert.deepEqual(files.paths, [
      join(serverDir, ".env.production"),
      join(serverDir, ".env.example"),
    ]);

    const { value: result } = await withCoolify(fakeCoolify([]), () =>
      commitAndPushScaffold(
        adoptState(dir),
        "demo-app",
        {
          scaffoldedAbsPaths: [],
          overwrittenAbsPaths: files.paths,
          manifestPath: join(dir, ".hatchkit.json"),
        },
        { message: RECORD_MESSAGE, forceAdd: files.forceAdd },
      ),
    );
    assert.deepEqual(result, { pushed: true });
    assert.match(git(origin, "show", "main:packages/server/.env.production"), /S3_SECRET_KEY=/);
    assert.match(git(origin, "show", "main:packages/server/.env.example"), /S3_BUCKET=/);
    assert.throws(() => git(origin, "show", "main:packages/server/.env.development"));
  },
);

await expect("adopt: env push failure is one caveat; a later success clears it", async () => {
  const plan = {
    name: "demo-app",
    domain: "demo.example.com",
    surfaces: "fullstack",
    deploymentMode: "coolify",
  } as AdoptPlan;
  const apps: EnvPushApp[] = [
    { uuid: "adopt-uuid", name: "demo-app", role: "compose", portsExposes: "3000" },
  ];
  const caveats: Parameters<typeof pushAdoptProductionEnv>[3] = [];
  const broken = projectDir({ name: "demo-app" }, 'MONGODB_URI="encrypted:BCtSlYNoXhJm"\n');
  const fake = fakeCoolify([]);
  await withCoolify(fake, () => pushAdoptProductionEnv(adoptState(broken), plan, apps, caveats));
  await withCoolify(fake, () => pushAdoptProductionEnv(adoptState(broken), plan, apps, caveats));
  assert.equal(caveats.length, 1, "the second failure replaced the first");
  assert.match(caveats[0]!.reason, /MONGODB_URI/);
  assert.match(caveats[0]!.recovery[0]!, /hatchkit sync --deploy/);
  assert.deepEqual(writes(fake.calls), []);

  const fixed = projectDir({ name: "demo-app" }, ENV_FILE);
  await withCoolify(fake, () => pushAdoptProductionEnv(adoptState(fixed), plan, apps, caveats));
  assert.deepEqual(caveats, []);
  assert.equal(bulkBody(fake.calls, "adopt-uuid").MONGODB_URI, MONGO_URL);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll env-push tests passed.");
