/**
 * `hatchkit sync` on a project served by ONE Coolify app named after
 * the project itself.
 *
 * `migrate-runtime` turns a compose app that ran one service into one
 * Docker Image app that keeps the project's name. chemistry-sketcher is
 * that shape: manifest `fullstack` + `coolifyRuntime: "image"` +
 * `topology: "single-origin"`, one image app `chemistry-sketcher`. The
 * image routing plan for that manifest names `<name>-client` +
 * `<name>-server`, and sync used to look only for those: a dry run
 * printed "no app named …-client" and "Would create: + …-client
 * + …-server", and a real run would have created both.
 *
 * Locks in:
 *
 *   1. The project-named image app is found first and reconciled alone:
 *      the flat `domains` PATCH carries primary + aliases, comma-joined,
 *      and nothing is created — dry run and real run.
 *   2. The dry run prints the exact `domains` value it would PATCH.
 *   3. The compose `<name>-client` / `<name>-server` path and the image
 *      per-role path are unchanged.
 *   4. A compose app named after the project under an image manifest is
 *      a mismatch: nothing created, nothing patched.
 *   5. A uuid recorded in `coolifyApps` wins over the app's name.
 *   6. `migrate-runtime` records the one-app shape (runtime, port, uuid)
 *      instead of leaving the manifest on compose.
 *
 * No test touches a real Coolify: `fetch` is replaced by a fake.
 *
 * Run: `node scripts/test.mjs test-sync-project-app.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Conf from "conf";
import { setManifestRuntime, updateManifestIfComplete } from "./src/deploy/migrate-runtime.js";
import { computeRoutingPlan, projectImageApp } from "./src/deploy/routing.js";
import { type SyncOptions, locateSyncApps, runSync } from "./src/deploy/sync.js";
import type { CoolifyApplication } from "./src/utils/coolify-api.js";
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
// Fixtures
// ---------------------------------------------------------------------------

const UUID = "zs9m5lti6vevcu7tanvsenl8";
const DOMAINS = "https://hydroxyl.app,https://chemistry.trebeljahr.com";

/** chemistry-sketcher's manifest, as far as sync reads it. */
const CHEMISTRY = {
  version: 5,
  name: "chemistry-sketcher",
  domain: "hydroxyl.app",
  deploymentMode: "coolify",
  ports: { server: 3000, client: 3001 },
  surfaces: "fullstack",
  publicService: "client",
  coolifyRuntime: "image",
  containerPorts: { app: 6337 },
  topology: "single-origin",
  aliases: ["chemistry.trebeljahr.com"],
};

/** A Coolify application record as `GET /applications/{uuid}` returns it. */
interface FakeApp {
  uuid: string;
  name: string;
  build_pack: string;
  fqdn?: string | null;
  docker_compose_domains?: string;
  ports_exposes?: string;
  health_check_enabled?: boolean;
  health_check_path?: string;
}

function chemistryApp(overrides: Partial<FakeApp> = {}): FakeApp {
  return {
    uuid: UUID,
    name: "chemistry-sketcher",
    build_pack: "dockerimage",
    fqdn: "https://chemistry.trebeljahr.com",
    ports_exposes: "6337",
    health_check_enabled: true,
    health_check_path: "/",
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** A Coolify that knows `apps` and records every request. */
function fakeCoolify(apps: FakeApp[]): { fetch: typeof fetch; calls: Call[] } {
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
    if (method === "GET" && /^\/applications\/[^/]+\/envs$/.test(path)) return json([]);
    if (method === "GET" && path === "/databases") return json([]);
    return json({ message: `fake Coolify: unhandled ${method} ${path}` }, 404);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
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

function projectDir(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "hk-sync-project-app-"));
  writeFileSync(join(dir, ".hatchkit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/** Only the routing pass: env, DNS, secrets, preflight and origins each
 *  have their own tests, and every one of them would need more fakes. */
const ROUTING_ONLY: Omit<SyncOptions, "projectDir"> = {
  env: false,
  dns: false,
  secrets: false,
  preflight: false,
  nativeOrigins: false,
};

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

// Coolify config for runSync, in the isolated config dir test.mjs set up.
new Conf({ projectName: "hatchkit", cwd: process.env.HATCHKIT_CONF_DIR }).set("providers.coolify", {
  status: "configured",
  url: "https://coolify.test.local",
});
await setSecret(SECRET_KEYS.coolifyToken, "test-coolify-token");

const dirs: string[] = [];

// ---------------------------------------------------------------------------
// 1. Routing: the one-app shape
// ---------------------------------------------------------------------------

console.log("\nprojectImageApp:");

await expect("carries primary + aliases, the app's own port, no /api route", () => {
  const app = projectImageApp({
    name: "chemistry-sketcher",
    domain: "hydroxyl.app",
    hostnameAliases: ["chemistry.trebeljahr.com"],
    topology: "single-origin",
    surfaces: "fullstack",
    runtime: "image",
    containerPorts: { app: 6337 },
  });
  assert.equal(app.appName, "chemistry-sketcher");
  assert.equal(app.role, "app");
  assert.equal(app.runtime, "image");
  assert.deepEqual(app.flatDomains, ["https://hydroxyl.app", "https://chemistry.trebeljahr.com"]);
  assert.equal(app.portsExposes, "6337");
  assert.equal(app.stripPrefix, undefined);
});

await expect("static and backend image plans are still exactly that one app", () => {
  for (const surfaces of ["static", "backend"] as const) {
    for (const topology of ["single-origin", "split"] as const) {
      const input = {
        name: "site",
        domain: "site.example",
        hostnameAliases: ["www.site.example"],
        topology,
        surfaces,
        runtime: "image" as const,
        containerPorts: { app: 80 },
      };
      assert.deepEqual(computeRoutingPlan(input).apps, [projectImageApp(input)]);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Locate: project-named image app first
// ---------------------------------------------------------------------------

console.log("\nlocateSyncApps:");

/** An api double over a fixed app list, recording name lookups. */
function apiOver(apps: FakeApp[]) {
  const lookedUp: string[] = [];
  const api = {
    async findApplicationByName(name: string) {
      lookedUp.push(name);
      const hit = apps.find((a) => a.name === name);
      return hit ? { uuid: hit.uuid, name: hit.name } : null;
    },
    async getApplication(uuid: string) {
      const hit = apps.find((a) => a.uuid === uuid);
      if (!hit) throw new Error("404");
      return {
        uuid: hit.uuid,
        name: hit.name,
        buildPack: hit.build_pack,
        portsExposes: hit.ports_exposes,
      } as unknown as CoolifyApplication;
    },
  };
  return { api, lookedUp };
}

function chemistryRouting() {
  const input = {
    name: "chemistry-sketcher",
    domain: "hydroxyl.app",
    hostnameAliases: ["chemistry.trebeljahr.com"],
    topology: "single-origin" as const,
    surfaces: "fullstack" as const,
    runtime: "image" as const,
    containerPorts: { app: 6337 },
  };
  return { routing: computeRoutingPlan(input), projectApp: projectImageApp(input) };
}

await expect("image app named after the project → reconciled alone, nothing missing", async () => {
  const { api, lookedUp } = apiOver([chemistryApp()]);
  const { routing, projectApp } = chemistryRouting();
  // The bug's precondition: the plan itself names the per-role pair.
  assert.deepEqual(
    routing.apps.map((a) => a.appName),
    ["chemistry-sketcher-client", "chemistry-sketcher-server"],
  );
  const located = await locateSyncApps({
    api,
    projectName: "chemistry-sketcher",
    topology: "single-origin",
    runtime: "image",
    routing,
    projectApp,
    json: true,
  });
  assert.deepEqual(
    located.apps.map((a) => [a.appName, a.role]),
    [["chemistry-sketcher", "app"]],
  );
  assert.deepEqual(located.locations.get("chemistry-sketcher"), {
    uuid: UUID,
    name: "chemistry-sketcher",
  });
  assert.equal(located.noCreate, undefined);
  assert.deepEqual(lookedUp, ["chemistry-sketcher"], "never went looking for -client/-server");
});

await expect("no project-named app → the per-role image lookup is unchanged", async () => {
  const { api, lookedUp } = apiOver([
    chemistryApp({ uuid: "c1", name: "chemistry-sketcher-client" }),
    chemistryApp({ uuid: "s1", name: "chemistry-sketcher-server" }),
  ]);
  const { routing, projectApp } = chemistryRouting();
  const located = await locateSyncApps({
    api,
    projectName: "chemistry-sketcher",
    topology: "single-origin",
    runtime: "image",
    routing,
    projectApp,
    json: true,
  });
  assert.equal(located.apps, routing.apps);
  assert.equal(located.locations.get("chemistry-sketcher-client")?.uuid, "c1");
  assert.equal(located.locations.get("chemistry-sketcher-server")?.uuid, "s1");
  assert.deepEqual(lookedUp, [
    "chemistry-sketcher",
    "chemistry-sketcher-client",
    "chemistry-sketcher-server",
  ]);
});

await expect("split compose: <name>-client / <name>-server located as before", async () => {
  const { api, lookedUp } = apiOver([
    { uuid: "legacy", name: "raptor", build_pack: "dockercompose" },
    { uuid: "c1", name: "raptor-client", build_pack: "dockercompose" },
    { uuid: "s1", name: "raptor-backend", build_pack: "dockercompose" },
  ]);
  const input = {
    name: "raptor",
    domain: "raptor.example.com",
    topology: "split" as const,
    surfaces: "fullstack" as const,
  };
  const routing = computeRoutingPlan(input);
  const located = await locateSyncApps({
    api,
    projectName: "raptor",
    topology: "split",
    runtime: "compose",
    routing,
    projectApp: projectImageApp(input),
    json: true,
  });
  assert.equal(located.apps, routing.apps);
  assert.equal(located.locations.get("raptor-client")?.uuid, "c1");
  assert.equal(located.locations.get("raptor-server")?.uuid, "s1", "alias still accepted");
  assert.ok(!lookedUp.includes("raptor"), "split never treats <name> as the project app");
});

await expect("single-origin compose: <name> is the compose app, plan unchanged", async () => {
  const { api } = apiOver([{ uuid: "u1", name: "raptor", build_pack: "dockercompose" }]);
  const input = {
    name: "raptor",
    domain: "raptor.example.com",
    topology: "single-origin" as const,
    surfaces: "fullstack" as const,
  };
  const routing = computeRoutingPlan(input);
  const located = await locateSyncApps({
    api,
    projectName: "raptor",
    topology: "single-origin",
    runtime: "compose",
    routing,
    projectApp: projectImageApp(input),
    json: true,
  });
  assert.equal(located.apps, routing.apps);
  assert.equal(located.apps[0]?.role, "compose");
  assert.equal(located.locations.get("raptor")?.uuid, "u1");
  assert.equal(located.noCreate, undefined);
});

await expect("recorded uuid wins over the name (app renamed in the dashboard)", async () => {
  const { api, lookedUp } = apiOver([chemistryApp({ name: "hydroxyl" })]);
  const { routing, projectApp } = chemistryRouting();
  const located = await locateSyncApps({
    api,
    projectName: "chemistry-sketcher",
    topology: "single-origin",
    runtime: "image",
    routing,
    projectApp,
    recorded: { app: UUID },
    json: true,
  });
  assert.deepEqual(located.locations.get("chemistry-sketcher"), { uuid: UUID, name: "hydroxyl" });
  assert.deepEqual(
    located.apps.map((a) => a.appName),
    ["chemistry-sketcher"],
  );
  assert.deepEqual(lookedUp, [], "no name lookup needed");
});

await expect("recorded uuid gone → falls back to the name", async () => {
  const { api } = apiOver([chemistryApp()]);
  const { routing, projectApp } = chemistryRouting();
  const located = await locateSyncApps({
    api,
    projectName: "chemistry-sketcher",
    topology: "single-origin",
    runtime: "image",
    routing,
    projectApp,
    recorded: { app: "deleted0000000000000000" },
    json: true,
  });
  assert.equal(located.locations.get("chemistry-sketcher")?.uuid, UUID);
});

// ---------------------------------------------------------------------------
// 3. runSync end to end against a fake Coolify
// ---------------------------------------------------------------------------

console.log("\nrunSync (fake Coolify):");

await expect(
  "dry run: plans the domains PATCH, prints its exact value, creates nothing",
  async () => {
    const dir = projectDir(CHEMISTRY);
    dirs.push(dir);
    const fake = fakeCoolify([chemistryApp()]);
    const { value: result, out } = await withCoolify(fake, () =>
      runSync({ projectDir: dir, dryRun: true, ...ROUTING_ONLY }),
    );
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.created, []);
    assert.deepEqual(
      result.apps.map((a) => [a.name, a.uuid, a.role]),
      [["chemistry-sketcher", UUID, "app"]],
    );
    const plan = result.apps[0]!;
    assert.deepEqual(plan.desiredDomains, [
      "https://hydroxyl.app",
      "https://chemistry.trebeljahr.com",
    ]);
    assert.equal(plan.desiredDockerComposeDomains, undefined);
    assert.equal(plan.changed, true);
    assert.deepEqual(writes(fake.calls), [], "a dry run writes nothing");
    assert.ok(!/Would create/.test(out), `planned a create:\n${out}`);
    assert.ok(out.includes(`would PATCH domains="${DOMAINS}"`), `no exact domains value:\n${out}`);
  },
);

await expect("dry run: already in sync prints the exact value too", async () => {
  const dir = projectDir(CHEMISTRY);
  dirs.push(dir);
  const fake = fakeCoolify([chemistryApp({ fqdn: DOMAINS })]);
  const { value: result, out } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, dryRun: true, ...ROUTING_ONLY }),
  );
  assert.equal(result.ok, true, result.error);
  assert.ok(out.includes(`domains: in sync (${DOMAINS})`), out);
});

await expect("real run: one PATCH of flat `domains` onto the existing app, no create", async () => {
  const dir = projectDir(CHEMISTRY);
  dirs.push(dir);
  const fake = fakeCoolify([chemistryApp()]);
  const { value: result } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, ...ROUTING_ONLY }),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.created, []);
  const w = writes(fake.calls);
  assert.deepEqual(
    w.map((c) => `${c.method} ${c.path}`),
    [`PATCH /applications/${UUID}`],
  );
  const body = w[0]!.body!;
  assert.equal(body.domains, DOMAINS);
  assert.ok(!("docker_compose_domains" in body), "never the compose field on an image app");
  assert.ok(!("ports_exposes" in body), "an image app's port is its own");
});

await expect("image per-role apps absent and no project app → still plans to create", async () => {
  const dir = projectDir(CHEMISTRY);
  dirs.push(dir);
  const fake = fakeCoolify([]);
  const { value: result, out } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, dryRun: true, ...ROUTING_ONLY }),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(out, /Would create:/);
  assert.match(out, /\+ chemistry-sketcher-client/);
  assert.match(out, /\+ chemistry-sketcher-server/);
  assert.match(out, /domains: https:\/\/hydroxyl\.app,https:\/\/chemistry\.trebeljahr\.com/);
});

await expect("split compose dry run: per-service compose domains as before", async () => {
  const dir = projectDir({
    version: 5,
    name: "raptor",
    domain: "raptor.example.com",
    deploymentMode: "coolify",
    surfaces: "fullstack",
    topology: "split",
  });
  dirs.push(dir);
  const fake = fakeCoolify([
    { uuid: "c1", name: "raptor-client", build_pack: "dockercompose", fqdn: null },
    { uuid: "s1", name: "raptor-server", build_pack: "dockercompose", fqdn: null },
  ]);
  const { value: result } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, dryRun: true, ...ROUTING_ONLY }),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.created, []);
  const byName = Object.fromEntries(result.apps.map((a) => [a.name, a]));
  assert.deepEqual(byName["raptor-client"]?.desiredDockerComposeDomains, [
    { name: "client", domain: "https://raptor.example.com" },
  ]);
  assert.deepEqual(byName["raptor-server"]?.desiredDockerComposeDomains, [
    { name: "server", domain: "https://api.raptor.example.com" },
  ]);
});

await expect(
  "image manifest, compose app named after the project → no create, no PATCH",
  async () => {
    const dir = projectDir(CHEMISTRY);
    dirs.push(dir);
    const fake = fakeCoolify([
      chemistryApp({ build_pack: "dockercompose", fqdn: null, docker_compose_domains: "[]" }),
    ]);
    const { value: result } = await withCoolify(fake, () =>
      runSync({ projectDir: dir, ...ROUTING_ONLY }),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.created, []);
    assert.deepEqual(writes(fake.calls), []);
    assert.match(result.error ?? "", /migrate-runtime/);
  },
);

await expect("image static plan onto a compose app is blocked, not emptied", async () => {
  const dir = projectDir({ ...CHEMISTRY, surfaces: "static", containerPorts: { app: 80 } });
  dirs.push(dir);
  const fake = fakeCoolify([
    chemistryApp({
      build_pack: "dockercompose",
      fqdn: null,
      docker_compose_domains: JSON.stringify({ client: { domain: "https://hydroxyl.app" } }),
    }),
  ]);
  const { value: result } = await withCoolify(fake, () =>
    runSync({ projectDir: dir, ...ROUTING_ONLY }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.apps[0]?.blocked, "plan is blocked");
  assert.deepEqual(writes(fake.calls), [], "docker_compose_domains left alone");
});

// ---------------------------------------------------------------------------
// 4. migrate-runtime records the one-app shape
// ---------------------------------------------------------------------------

console.log("\nmigrate-runtime manifest:");

await expect("one-service move: runtime, port and uuid recorded", async () => {
  const dir = projectDir({ ...CHEMISTRY, coolifyRuntime: undefined, containerPorts: undefined });
  dirs.push(dir);
  const { api } = apiOver([chemistryApp()]);
  await withCoolify(fakeCoolify([]), () =>
    updateManifestIfComplete(dir, {
      listApplications: async () => [{ uuid: UUID, name: "chemistry-sketcher" }],
      getApplication: api.getApplication,
    }),
  );
  const m = JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8"));
  assert.equal(m.coolifyRuntime, "image");
  assert.deepEqual(m.containerPorts, { app: 6337 });
  assert.deepEqual(m.coolifyApps, { app: UUID });
});

await expect("per-role move: client + server uuids recorded", async () => {
  const dir = projectDir({ ...CHEMISTRY, coolifyRuntime: undefined, containerPorts: undefined });
  dirs.push(dir);
  const apps = [
    chemistryApp({ uuid: "c1", name: "chemistry-sketcher-client", ports_exposes: "80" }),
    chemistryApp({ uuid: "s1", name: "chemistry-sketcher-server", ports_exposes: "3000" }),
  ];
  const { api } = apiOver(apps);
  await withCoolify(fakeCoolify([]), () =>
    updateManifestIfComplete(dir, {
      listApplications: async () => apps.map((a) => ({ uuid: a.uuid, name: a.name })),
      getApplication: api.getApplication,
    }),
  );
  const m = JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8"));
  assert.equal(m.coolifyRuntime, "image");
  assert.deepEqual(m.coolifyApps, { client: "c1", server: "s1" });
  assert.deepEqual(m.containerPorts, { client: 80 });
});

await expect("back to compose drops the recorded uuids", () => {
  const dir = projectDir({ ...CHEMISTRY, coolifyApps: { app: UUID } });
  dirs.push(dir);
  assert.equal(setManifestRuntime(dir, "compose"), true);
  const m = JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8"));
  assert.equal(m.coolifyRuntime, "compose");
  assert.ok(!("coolifyApps" in m));
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} sync-project-app test(s) failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nAll sync-project-app tests passed.");
