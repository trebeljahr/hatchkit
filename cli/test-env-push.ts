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
 *      app's own PORT onto every app, and reports which apps' env
 *      changed (key names only).
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
 *
 * No test touches a real Coolify: `fetch` is replaced by a fake.
 *
 * Run: `node scripts/test.mjs test-env-push.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Conf from "conf";
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
  opts: { hideValues?: boolean } = {},
): { fetch: typeof fetch; calls: Call[]; env: Record<string, EnvRow[]> } {
  const calls: Call[] = [];
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
          opts.hideValues ? { key: r.key, is_preview: r.is_preview } : { ...r, is_literal: true },
        ),
      );
    }
    const bulk = path.match(/^\/applications\/([^/]+)\/envs\/bulk$/);
    if (bulk && method === "PATCH") {
      if (!env[bulk[1]]) env[bulk[1]] = [];
      const rows = env[bulk[1]];
      for (const item of (body?.data ?? []) as Array<{ key: string; value: string }>) {
        const existing = rows.find((r) => r.key === item.key && !r.is_preview);
        if (existing) existing.value = item.value;
        else rows.push({ key: item.key, value: item.value, is_preview: false });
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
  const dir = mkdtempSync(join(tmpdir(), "hk-env-push-"));
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

/** What each app of PAIR holds after a push of ENV_FILE. */
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
  assert.deepEqual(outcome.pushed, { "demo-app-client": 5, "demo-app-server": 5 });
  const server = bulkBody(fake.calls, "server-uuid");
  assert.equal(server.MONGODB_URI, MONGO_URL, "the database URL reaches the server");
  assert.equal(server.BETTER_AUTH_SECRET, "test-auth-secret");
  assert.equal(server.PORT, "3000");
  assert.equal(server.NODE_ENV, "production");
  assert.equal(server.FRONTEND_URL, "https://demo.example.com");
  assert.equal(bulkBody(fake.calls, "client-uuid").PORT, "3001", "each half keeps its own port");
  assert.deepEqual(
    outcome.changed.map((c) => [c.name, [...c.keys].sort(), c.unreadable]),
    [
      ["demo-app-client", ["BETTER_AUTH_SECRET", "FRONTEND_URL", "MONGODB_URI"], false],
      ["demo-app-server", ["BETTER_AUTH_SECRET", "MONGODB_URI"], false],
    ],
  );
  assert.ok(!out.includes(MONGO_URL), "a value was printed");
  assert.ok(!out.includes("test-auth-secret"), "a value was printed");
});

await expect("live env equal to the file → pushed, reported unchanged", async () => {
  const dir = projectDir({ name: "demo-app" }, ENV_FILE);
  const fake = fakeCoolify([], {
    "client-uuid": pushedRows("3001"),
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
  assert.deepEqual(outcome?.pushed, { "demo-app-client": 5, "demo-app-server": 5 });
  assert.deepEqual(outcome?.changed, []);
  assert.deepEqual(writes(fake.calls), []);
  assert.match(out, /would push 5 var\(s\)/);
});

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

// ---------------------------------------------------------------------------
// 5. commitDeployWiring
// ---------------------------------------------------------------------------

console.log("\ncommitDeployWiring:");

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
  writeFileSync(join(dir, ".gitignore"), ".env.keys\n");
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

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll env-push tests passed.");
