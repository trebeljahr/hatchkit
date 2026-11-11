/**
 * Which Coolify apps belong to a project (`findCoolifyAppsForProject`),
 * and the callers that act on them.
 *
 * An image-runtime project with a client and a server runs them as two
 * Docker Image apps, `<name>-client` + `<name>-server`, even under
 * `single-origin`. The lookup went by topology alone and returned only
 * the server for `single-origin`, so the client got no deploy hook
 * (its first deploy timed out and the site served 503), no doctor check
 * and no isolation audit. It now reads the routing plan for the
 * project's runtime.
 *
 * Locks in:
 *
 *   1. The match: an image pair → both apps with roles; the one image app
 *      `migrate-runtime` makes → that app alone; compose single-origin →
 *      `<name>`; split aliases; a Worker client → the server; recorded
 *      uuids win over names; a bare topology still means compose.
 *   2. doctor's deploy-hook check and the isolation audit read both
 *      apps of an image pair.
 *   3. `keys push` writes the dotenvx key to the server app, never to a
 *      client app.
 *
 * No test touches a real Coolify: `fetch` is replaced by a fake.
 *
 * Run: `node scripts/test.mjs test-project-coolify-apps.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Conf from "conf";
import { findCoolifyAppsForProject, matchProjectCoolifyApps } from "./src/deploy/coolify-app.js";
import { pushProjectKeyToCoolify } from "./src/deploy/keys.js";
import { checkProjectCoolifyAutoDeployState } from "./src/doctor.js";
import { auditProjectIsolation } from "./src/secrets/isolation.js";
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
// Fake Coolify
// ---------------------------------------------------------------------------

const COOLIFY_URL = "https://coolify.test.local";

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function fakeCoolify(
  apps: Array<{ uuid: string; name: string; build_pack?: string }>,
  env: Record<string, Array<{ key: string; value: string }>> = {},
): { fetch: typeof fetch; calls: Call[] } {
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
    if (one && method === "GET") {
      const app = apps.find((a) => a.uuid === one[1]);
      return app
        ? json({ ...app, build_pack: app.build_pack ?? "dockerimage" })
        : json({ message: "Not found." }, 404);
    }
    const envs = path.match(/^\/applications\/([^/]+)\/envs$/);
    if (envs && method === "GET") {
      return json(
        (env[envs[1]] ?? []).map((r, i) => ({ uuid: `env-${i}`, ...r, is_preview: false })),
      );
    }
    const bulk = path.match(/^\/applications\/([^/]+)\/envs\/bulk$/);
    if (bulk && method === "PATCH") return json({ message: "ok" });
    return json({ message: `fake Coolify: unhandled ${method} ${path}` }, 404);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

async function withFetch<T>(fake: { fetch: typeof fetch }, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = fake.fetch;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

// Coolify config in the isolated config dir test.mjs set up.
new Conf({ projectName: "hatchkit", cwd: process.env.HATCHKIT_CONF_DIR }).set("providers.coolify", {
  status: "configured",
  url: COOLIFY_URL,
});
await setSecret(SECRET_KEYS.coolifyToken, "test-coolify-token");

const dirs: string[] = [];
function projectDir(manifest?: Record<string, unknown>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hk-project-apps-")));
  dirs.push(dir);
  if (manifest)
    writeFileSync(join(dir, ".hatchkit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const IMAGE_MANIFEST = {
  version: 5,
  name: "demo-app",
  domain: "demo.example.com",
  deploymentMode: "coolify",
  surfaces: "fullstack",
  coolifyRuntime: "image",
  topology: "single-origin",
} as const;

const PAIR = [
  { uuid: "client-uuid", name: "demo-app-client" },
  { uuid: "server-uuid", name: "demo-app-server" },
];

// ---------------------------------------------------------------------------
// 1. The match
// ---------------------------------------------------------------------------

console.log("\nmatchProjectCoolifyApps:");

await expect("image single-origin pair → both apps, each with its role", () => {
  assert.deepEqual(matchProjectCoolifyApps(PAIR, "demo-app", IMAGE_MANIFEST), [
    { uuid: "client-uuid", role: "client" },
    { uuid: "server-uuid", role: "server" },
  ]);
});

await expect("the one image app migrate-runtime makes → that app, no role", () => {
  assert.deepEqual(
    matchProjectCoolifyApps([{ uuid: "one", name: "demo-app" }], "demo-app", IMAGE_MANIFEST),
    [{ uuid: "one" }],
  );
});

await expect("compose single-origin → the app named after the project", () => {
  const apps = [{ uuid: "one", name: "demo-app" }, ...PAIR];
  assert.deepEqual(matchProjectCoolifyApps(apps, "demo-app", { topology: "single-origin" }), [
    { uuid: "one" },
  ]);
});

await expect("a bare shape still means compose: the legacy single-app names", () => {
  assert.deepEqual(matchProjectCoolifyApps(PAIR, "demo-app"), [{ uuid: "server-uuid" }]);
});

await expect("split finds a hand-rolled -frontend / -backend pair", () => {
  const apps = [
    { uuid: "f", name: "demo-app-frontend" },
    { uuid: "b", name: "demo-app-backend" },
  ];
  assert.deepEqual(matchProjectCoolifyApps(apps, "demo-app", { topology: "split" }), [
    { uuid: "f", role: "client" },
    { uuid: "b", role: "server" },
  ]);
});

await expect("a client on Workers → the server app only", () => {
  assert.deepEqual(
    matchProjectCoolifyApps(PAIR, "demo-app", { ...IMAGE_MANIFEST, clientHost: "cloudflare" }),
    [{ uuid: "server-uuid", role: "server" }],
  );
});

await expect("recorded uuids win over names; a deleted one falls back to names", () => {
  const apps = [...PAIR, { uuid: "renamed", name: "something-else" }];
  assert.deepEqual(
    matchProjectCoolifyApps(apps, "demo-app", {
      ...IMAGE_MANIFEST,
      coolifyApps: { server: "renamed", client: "gone" },
    }),
    [
      { uuid: "client-uuid", role: "client" },
      { uuid: "renamed", role: "server" },
    ],
  );
});

await expect("an image static site → its one app", () => {
  assert.deepEqual(
    matchProjectCoolifyApps([{ uuid: "s", name: "demo-app" }], "demo-app", {
      ...IMAGE_MANIFEST,
      surfaces: "static",
    }),
    [{ uuid: "s" }],
  );
});

await expect("nothing named after the project → empty", () => {
  assert.deepEqual(
    matchProjectCoolifyApps([{ uuid: "x", name: "other" }], "demo-app", IMAGE_MANIFEST),
    [],
  );
});

await expect("findCoolifyAppsForProject reads the live list", async () => {
  const fake = fakeCoolify(PAIR);
  const apps = await withFetch(fake, () => findCoolifyAppsForProject("demo-app", IMAGE_MANIFEST));
  assert.deepEqual(
    apps.map((a) => a.role),
    ["client", "server"],
  );
});

// ---------------------------------------------------------------------------
// 2. Callers that must see both apps
// ---------------------------------------------------------------------------

console.log("\ncallers:");

await expect("doctor's deploy-hook check reads the client and the server", async () => {
  const dir = projectDir(IMAGE_MANIFEST);
  const fake = fakeCoolify(PAIR);
  const results = await withFetch(fake, () => checkProjectCoolifyAutoDeployState(dir));
  const hook = results.find((r) => r.name.includes("deploy hooks"));
  assert.ok(hook, JSON.stringify(results));
  const hint = (hook.hint ?? []).join("\n");
  assert.match(hint, /^client: /m);
  assert.match(hint, /^server: /m);
});

await expect("the isolation audit scans the client app's env too", async () => {
  const dir = projectDir(IMAGE_MANIFEST);
  const fake = fakeCoolify(PAIR, {
    "client-uuid": [{ key: "COOLIFY_TOKEN", value: "test-operator-token" }],
  });
  const audit = await withFetch(fake, () =>
    auditProjectIsolation(dir, {
      provisioners: [
        {
          provider: "coolify",
          label: "Coolify token",
          value: "test-operator-token",
          severity: "fail",
        },
      ],
      envFiles: false,
      github: false,
      cloudflare: false,
    }),
  );
  assert.ok(
    audit.findings.some((f) => f.where === "coolify:client-uuid"),
    JSON.stringify(audit.findings),
  );
});

// ---------------------------------------------------------------------------
// 3. keys push
// ---------------------------------------------------------------------------

console.log("\nkeys push:");

await setSecret(SECRET_KEYS.dotenvxPrivateKey("demo-app"), "test-dotenvx-private-key");
const keyWrites = (calls: Call[]) =>
  calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/envs/bulk")).map((c) => c.path);

await expect("an image pair → the key goes to the server app only", async () => {
  const dir = projectDir(IMAGE_MANIFEST);
  const fake = fakeCoolify([...PAIR].reverse());
  const pushed = await withFetch(fake, () =>
    pushProjectKeyToCoolify("demo-app", { projectDir: dir }),
  );
  assert.deepEqual(pushed, { uuid: "server-uuid" });
  assert.deepEqual(keyWrites(fake.calls), ["/applications/server-uuid/envs/bulk"]);
});

await expect("an aliased -backend is found through the manifest", async () => {
  const dir = projectDir(IMAGE_MANIFEST);
  const fake = fakeCoolify([
    { uuid: "client-uuid", name: "demo-app-client" },
    { uuid: "backend-uuid", name: "demo-app-backend" },
  ]);
  const pushed = await withFetch(fake, () =>
    pushProjectKeyToCoolify("demo-app", { projectDir: dir }),
  );
  assert.deepEqual(pushed, { uuid: "backend-uuid" });
});

await expect("only a client app → not found, nothing written", async () => {
  const dir = projectDir();
  const fake = fakeCoolify([{ uuid: "client-uuid", name: "demo-app-client" }]);
  await assert.rejects(
    () => withFetch(fake, () => pushProjectKeyToCoolify("demo-app", { projectDir: dir })),
    /Coolify app not found/,
  );
  assert.deepEqual(keyWrites(fake.calls), []);
});

await expect("a manifest of another project is not used", async () => {
  const dir = projectDir({ ...IMAGE_MANIFEST, name: "other-app" });
  const fake = fakeCoolify([{ uuid: "one", name: "demo-app" }]);
  const pushed = await withFetch(fake, () =>
    pushProjectKeyToCoolify("demo-app", { projectDir: dir }),
  );
  assert.deepEqual(pushed, { uuid: "one" });
});

await expect("create pushes the key to every app it made except a client half", () => {
  const src = readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
  const loop = src.match(
    /for \(const app of coolifyResult\.apps\) \{([\s\S]*?)pushProjectKeyToCoolify\(config\.name/,
  );
  assert.ok(loop, "create's key-push loop moved; update this test");
  assert.match(loop[1]!, /if \(app\.role === "client"\) continue;/);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll project-coolify-apps tests passed.");
