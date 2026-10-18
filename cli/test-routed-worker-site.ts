/**
 * A site with no server on an assets-only Worker attached by Workers routes
 * (`deploymentMode` and `clientHost` both `"cloudflare"`), released by the
 * repo's own CI (`clientRelease: "repo"`). hydroxyl-app's shape since its
 * Coolify app retired on 2026-10-18.
 *
 * Pinned here:
 *
 *   1. The plan: `<host>/*` → the Worker for every host, no `/api` route,
 *      no ACME route; the Worker name from the manifest, then wrangler.jsonc.
 *   2. doctor: per-zone reads (the hosts span two zones), leftover ACME
 *      routes as a warning, no Coolify and no `/api/health`.
 *   3. Every command that reads the manifest leaves Coolify, DNS, the
 *      routes and the repo's Worker files alone: sync, regen-infra,
 *      dns publish, rename-domain, `hatchkit cloudflare` setup and undo.
 *   4. `status --json` and `explain` describe it.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const {
  checkRoutedWorkerSite,
  clientWorkerName,
  cloudflareSetupRefusal,
  isRoutedWorkerSite,
  leftoverAcmeRoutes,
  repoOwnsWorkerFiles,
  resolveEdgeZones,
  routedWorkerSiteEdge,
} = await import("./src/deploy/routed-worker-site.js");
type CfWorkerRoute = import("./src/utils/cloudflare-api.js").CfWorkerRoute;
type CfRuleset = import("./src/utils/cloudflare-api.js").CfRuleset;
type CloudflareApi = import("./src/utils/cloudflare-api.js").CloudflareApi;

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

const HOSTS = ["hydroxyl.app", "www.hydroxyl.app", "chemistry.trebeljahr.com"];
const WORKER = "chemistry-sketcher-client";

/** hydroxyl-app's manifest after its Coolify app is gone. */
const SITE = {
  version: 5,
  name: "chemistry-sketcher",
  domain: "hydroxyl.app",
  aliases: ["www.hydroxyl.app", "chemistry.trebeljahr.com"],
  features: ["analytics"],
  mlServices: [],
  deploymentMode: "cloudflare",
  surfaces: "static",
  clientHost: "cloudflare",
  clientWorker: WORKER,
  clientRelease: "repo",
  ports: { server: 3000, client: 3001 },
};

const WRANGLER = `// assets-only
{
  "name": "${WORKER}",
  "compatibility_date": "2026-10-01",
  "workers_dev": false,
  "assets": { "directory": "./packages/client/out", "not_found_handling": "404-page" }
}
`;
const HEADERS = "/version.json\n  Cache-Control: no-store\n";
const WORKFLOW = "name: Build & Release\non: push\njobs: {}\n";
const NEXT_CONFIG = "export default { trailingSlash: true };\n";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "routed-site-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function siteProject(manifest: Record<string, unknown> = SITE): string {
  return project({
    ".hatchkit.json": JSON.stringify(manifest, null, 2),
    "wrangler.jsonc": WRANGLER,
    "packages/client/cloudflare/_headers": HEADERS,
    "packages/client/next.config.ts": NEXT_CONFIG,
    ".github/workflows/deploy.yml": WORKFLOW,
  });
}

/** Two zones, the routes hydroxyl's cutover made, one HTTPS rule each. */
function fakeZones(init: {
  routes?: Record<string, CfWorkerRoute[]>;
  httpsHosts?: Record<string, string[]>;
  deployed?: boolean;
}) {
  const routes: Record<string, CfWorkerRoute[]> = init.routes ?? {
    hydroxyl: [
      { id: "1", pattern: "hydroxyl.app/*", script: WORKER },
      { id: "2", pattern: "www.hydroxyl.app/*", script: WORKER },
    ],
    trebeljahr: [{ id: "3", pattern: "chemistry.trebeljahr.com/*", script: WORKER }],
  };
  const https = init.httpsHosts ?? {
    hydroxyl: ["hydroxyl.app", "www.hydroxyl.app"],
    trebeljahr: ["chemistry.trebeljahr.com", "names.trebeljahr.com"],
  };
  const writes: string[] = [];
  const api = {
    async resolveZoneForName(name: string) {
      const id = name.endsWith("hydroxyl.app") ? "hydroxyl" : "trebeljahr";
      return { id, name: id === "hydroxyl" ? "hydroxyl.app" : "trebeljahr.com", name_servers: [] };
    },
    async listWorkerRoutes(zone: string) {
      return (routes[zone] ?? []).map((r) => ({ ...r }));
    },
    async findRecordsByName(_z: string, name: string) {
      return [{ id: "d", type: "A", name, content: "1.2.3.4", proxied: true }];
    },
    async getWorker(_a: string, name: string) {
      return name === WORKER ? { id: "w", name } : null;
    },
    async listWorkerDeployments() {
      return init.deployed === false
        ? []
        : [
            {
              id: "dep",
              created_on: "2026-10-18",
              versions: [{ version_id: "v9", percentage: 100 }],
            },
          ];
    },
    async getRedirectRuleset(zone: string): Promise<CfRuleset | null> {
      const hosts = https[zone];
      if (!hosts) return null;
      const { renderHttpsRedirectRule } = await import("./src/deploy/client-host.js");
      return { id: `rs-${zone}`, rules: [{ ...renderHttpsRedirectRule(hosts), id: `r-${zone}` }] };
    },
    async createWorkerRoute() {
      writes.push("createWorkerRoute");
      throw new Error("doctor must not write");
    },
    async deleteWorkerRoute() {
      writes.push("deleteWorkerRoute");
      throw new Error("doctor must not write");
    },
  };
  return {
    api: api as unknown as CloudflareApi,
    writes,
    cloudflare: { api: api as unknown as CloudflareApi, accountId: "acct" },
  };
}

function okFetch(statusFor: (url: string) => number = () => 200) {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(String(url));
    return new Response("<html></html>", { status: statusFor(String(url)) });
  }) as unknown as typeof fetch;
  return { fn, urls };
}

// ---------------------------------------------------------------------------
// 1. The plan
// ---------------------------------------------------------------------------

await test("shape: both cloudflare words, and only both", () => {
  assert.equal(isRoutedWorkerSite(SITE as never), true);
  assert.equal(isRoutedWorkerSite({ deploymentMode: "cloudflare" }), false, "Custom Domain site");
  assert.equal(
    isRoutedWorkerSite({ deploymentMode: "coolify", clientHost: "cloudflare" }),
    false,
    "fullstack client moved by migrate-client",
  );
  assert.equal(isRoutedWorkerSite({ clientHost: "cloudflare" }), false, "absent mode is coolify");
  assert.equal(repoOwnsWorkerFiles({ clientRelease: "repo" }), true);
  assert.equal(repoOwnsWorkerFiles({}), false);
});

await test("plan: <host>/* → the Worker on every host, no /api, no ACME", () => {
  const dir = siteProject();
  const edge = routedWorkerSiteEdge(SITE as never, dir);
  assert.equal(edge.worker, WORKER);
  assert.deepEqual(edge.hosts, HOSTS);
  assert.deepEqual(
    edge.routes.map((r) => [r.pattern, r.script, r.purpose]),
    HOSTS.map((h) => [`${h}/*`, WORKER, "client"]),
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("plan: an originPaths entry the manifest names becomes a no-Worker route first", () => {
  const edge = routedWorkerSiteEdge({ ...SITE, originPaths: ["/feed"] } as never, "/nonexistent");
  assert.deepEqual(edge.routes[0], {
    pattern: "hydroxyl.app/feed/*",
    host: "hydroxyl.app",
    script: null,
    purpose: "origin",
  });
  assert.equal(edge.routes.length, 4);
});

await test("Worker name: clientWorker, then wrangler.jsonc, then <name>-client", () => {
  const dir = project({ "wrangler.jsonc": '{\n  "name": "from-wrangler"\n}\n' });
  assert.equal(clientWorkerName({ name: "x", clientWorker: "explicit" }, dir), "explicit");
  assert.equal(clientWorkerName({ name: "x" }, dir), "from-wrangler");
  assert.equal(clientWorkerName({ name: "x" }, "/nonexistent"), "x-client");
  rmSync(dir, { recursive: true, force: true });
});

await test("zones: hosts split by zone, each with its own routes", async () => {
  const edge = routedWorkerSiteEdge(SITE as never, "/nonexistent");
  const zones = await resolveEdgeZones(fakeZones({}).api, "acct", edge);
  assert.deepEqual(
    zones.map((z) => [z.ctx.zoneName, z.edge.hosts, z.edge.routes.map((r) => r.pattern)]),
    [
      [
        "hydroxyl.app",
        ["hydroxyl.app", "www.hydroxyl.app"],
        ["hydroxyl.app/*", "www.hydroxyl.app/*"],
      ],
      ["trebeljahr.com", ["chemistry.trebeljahr.com"], ["chemistry.trebeljahr.com/*"]],
    ],
  );
});

await test("leftover ACME routes: no-Worker, on a site host, not planned", () => {
  const edge = routedWorkerSiteEdge(SITE as never, "/nonexistent");
  const zone: CfWorkerRoute[] = [
    { id: "1", pattern: "hydroxyl.app/*", script: WORKER },
    { id: "a", pattern: "hydroxyl.app/.well-known/acme-challenge/*", script: null },
    { id: "b", pattern: "www.hydroxyl.app/.well-known/acme-challenge/*", script: "" },
    { id: "c", pattern: "chemistry.trebeljahr.com/.well-known/acme-challenge/*", script: "x" },
    { id: "d", pattern: "other.trebeljahr.com/.well-known/acme-challenge/*", script: null },
  ];
  assert.deepEqual(
    leftoverAcmeRoutes(edge, zone).map((r) => r.id),
    ["a", "b"],
  );
});

// ---------------------------------------------------------------------------
// 2. doctor
// ---------------------------------------------------------------------------

await test("doctor: routes on two zones and live hosts are ok; nothing written", async () => {
  const dir = siteProject();
  const cf = fakeZones({});
  const fetcher = okFetch();
  const checks = await checkRoutedWorkerSite(dir, SITE as never, {
    cloudflare: cf.cloudflare,
    fetch: fetcher.fn,
  });
  assert.deepEqual(
    checks.map((c) => [c.name.split(": ")[1], c.status]),
    [
      ["routes", "ok"],
      ["live", "ok"],
    ],
  );
  assert.match(
    checks[0].detail ?? "",
    /hydroxyl\.app, trebeljahr\.com, Worker chemistry-sketcher-client live \(v9\)/,
  );
  assert.deepEqual(cf.writes, []);
  assert.deepEqual(
    fetcher.urls.map((u) => new URL(u).host),
    HOSTS,
    "one homepage per host, no /api/health",
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("doctor: leftover ACME routes warn, they are not foreign", async () => {
  const cf = fakeZones({
    routes: {
      hydroxyl: [
        { id: "a", pattern: "hydroxyl.app/.well-known/acme-challenge/*", script: null },
        { id: "1", pattern: "hydroxyl.app/*", script: WORKER },
        { id: "2", pattern: "www.hydroxyl.app/*", script: WORKER },
      ],
      trebeljahr: [
        { id: "c", pattern: "chemistry.trebeljahr.com/.well-known/acme-challenge/*", script: null },
        { id: "3", pattern: "chemistry.trebeljahr.com/*", script: WORKER },
      ],
    },
  });
  const [routes] = await checkRoutedWorkerSite("/nonexistent", SITE as never, {
    cloudflare: cf.cloudflare,
    fetch: okFetch().fn,
  });
  assert.equal(routes.status, "warn");
  assert.equal(routes.hint?.length, 3);
  assert.match(
    routes.hint?.[0] ?? "",
    /delete hydroxyl\.app\/\.well-known\/acme-challenge\/\* \(a\) on hydroxyl\.app/,
  );
});

await test("doctor: missing, foreign and wrong-Worker routes, HTTPS gaps and an empty Worker fail", async () => {
  const run = async (init: Parameters<typeof fakeZones>[0]) =>
    (
      await checkRoutedWorkerSite("/nonexistent", SITE as never, {
        cloudflare: fakeZones(init).cloudflare,
        fetch: okFetch().fn,
      })
    )[0];
  const missing = await run({
    routes: { hydroxyl: [{ id: "1", pattern: "hydroxyl.app/*", script: WORKER }], trebeljahr: [] },
  });
  assert.equal(missing.status, "fail");
  assert.ok(
    missing.hint?.some((h) =>
      /www\.hydroxyl\.app\/\* → chemistry-sketcher-client is missing/.test(h),
    ),
  );
  assert.ok(missing.hint?.some((h) => /fix them in the dashboard/.test(h)));

  const foreign = await run({
    routes: {
      hydroxyl: [
        { id: "1", pattern: "hydroxyl.app/*", script: WORKER },
        { id: "2", pattern: "www.hydroxyl.app/*", script: WORKER },
        { id: "9", pattern: "hydroxyl.app/api/*", script: null },
      ],
      trebeljahr: [{ id: "3", pattern: "chemistry.trebeljahr.com/*", script: "old-worker" }],
    },
  });
  assert.equal(foreign.status, "fail");
  assert.ok(foreign.hint?.some((h) => /Foreign Workers route hydroxyl\.app\/api\/\*/.test(h)));
  assert.ok(
    foreign.hint?.some((h) => /sends to old-worker, expected chemistry-sketcher-client/.test(h)),
  );

  const https = await run({ httpsHosts: { hydroxyl: ["hydroxyl.app"] } });
  assert.equal(https.status, "fail");
  assert.ok(
    https.hint?.some((h) =>
      /on hydroxyl\.app does not cover www\.hydroxyl\.app: `hatchkit cloudflare https add www\.hydroxyl\.app`/.test(
        h,
      ),
    ),
  );
  assert.ok(
    https.hint?.some((h) => /on trebeljahr\.com does not cover chemistry\.trebeljahr\.com/.test(h)),
  );

  const empty = await run({ deployed: false });
  assert.equal(empty.status, "fail");
  assert.equal(
    empty.hint?.filter((h) => /no deployed version/.test(h)).length,
    1,
    "one line, not one per zone",
  );
});

await test("doctor: no provisioner skips the zones; a down host fails, no network warns", async () => {
  const [skipped, live] = await checkRoutedWorkerSite("/nonexistent", SITE as never, {
    cloudflare: null,
    fetch: okFetch((u) => (u.includes("www.") ? 522 : 200)).fn,
  });
  assert.equal(skipped.status, "skip");
  assert.equal(live.status, "fail");
  assert.match(live.detail ?? "", /https:\/\/www\.hydroxyl\.app\/ answered 522/);

  const offline = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as unknown as typeof fetch;
  const [, unreachable] = await checkRoutedWorkerSite("/nonexistent", SITE as never, {
    cloudflare: null,
    fetch: offline,
  });
  assert.equal(unreachable.status, "warn");
});

await test("doctor: the client-host check takes the routed branch, never /api/health", async () => {
  const { checkProjectClientHostState } = await import("./src/doctor.js");
  const dir = siteProject();
  const fetcher = okFetch();
  const checks = await checkProjectClientHostState(dir, { fetch: fetcher.fn });
  assert.deepEqual(
    checks.map((c) => [c.name.split(": ")[1], c.status]),
    [
      ["config", "ok"],
      ["routes", "skip"],
      ["live", "ok"],
    ],
  );
  assert.ok(!fetcher.urls.some((u) => u.includes("/api/")));
  rmSync(dir, { recursive: true, force: true });
});

await test("doctor: a clientWorker that disagrees with wrangler.jsonc fails the config check", async () => {
  const { checkProjectClientHostState } = await import("./src/doctor.js");
  const dir = siteProject({ ...SITE, clientWorker: "renamed" });
  const [config] = await checkProjectClientHostState(dir, { fetch: okFetch().fn });
  assert.equal(config.status, "fail");
  assert.match(
    config.detail ?? "",
    /names Worker renamed, wrangler\.jsonc deploys chemistry-sketcher-client/,
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("doctor: no Coolify routing line for a Workers site", async () => {
  const { checkProjectRoutingState } = await import("./src/doctor.js");
  const dir = siteProject();
  assert.deepEqual(await checkProjectRoutingState(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. Commands leave it alone
// ---------------------------------------------------------------------------

/** Every file the site's repo owns, byte for byte. */
function snapshot(dir: string): Record<string, string> {
  const files = [
    ".hatchkit.json",
    "wrangler.jsonc",
    "packages/client/cloudflare/_headers",
    "packages/client/next.config.ts",
    ".github/workflows/deploy.yml",
  ];
  return Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf-8")]));
}

await test("sync: nothing on Coolify, no routes written", async () => {
  const { runSync } = await import("./src/deploy/sync.js");
  const dir = siteProject();
  const before = snapshot(dir);
  const res = await runSync({ projectDir: dir, json: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.created, []);
  assert.deepEqual(res.apps, []);
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

await test("regen-infra and dns publish: no Coolify infra, no DNS", async () => {
  const { runRegenInfra } = await import("./src/deploy/regen-infra.js");
  const { runDnsPublish } = await import("./src/dns.js");
  const dir = siteProject();
  const before = snapshot(dir);
  const monorepo = mkdtempSync(join(tmpdir(), "routed-site-mono-"));
  await runRegenInfra({ projectDir: dir, monorepoRoot: monorepo, dryRun: false } as never);
  assert.ok(!existsSync(join(monorepo, "infra")), "no infra/ written");
  await assert.rejects(
    runDnsPublish({ projectDir: dir, dryRun: true } as never),
    /no Coolify server/,
  );
  assert.deepEqual(snapshot(dir), before);
  for (const d of [dir, monorepo]) rmSync(d, { recursive: true, force: true });
});

await test("rename-domain: refuses with the by-hand steps, not migrate-client", async () => {
  const { runRenameDomain } = await import("./src/deploy/rename-domain.js");
  const dir = siteProject();
  await assert.rejects(
    runRenameDomain({ projectDir: dir, monorepoRoot: dir, newDomain: "hydroxyl.dev" } as never),
    (err: Error) =>
      /Worker chemistry-sketcher-client through Workers routes on hydroxyl\.app, www\.hydroxyl\.app, chemistry\.trebeljahr\.com/.test(
        err.message,
      ) &&
      /hatchkit cloudflare https add <new-host>/.test(err.message) &&
      !/migrate-client/.test(err.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("hatchkit cloudflare: setup and undo refuse before touching anything", async () => {
  const { runCloudflareSetup, runCloudflareSetupProgrammatic, runCloudflareUndo } = await import(
    "./src/deploy/cloudflare.js"
  );
  const dir = siteProject();
  const before = snapshot(dir);
  await assert.rejects(
    runCloudflareSetup(dir),
    /Workers routes .* does not run here\. Still available: `hatchkit cloudflare token`/,
  );
  await assert.rejects(
    runCloudflareSetupProgrammatic(dir, { domain: "hydroxyl.app" }),
    /does not run here/,
  );
  await assert.rejects(
    runCloudflareUndo(dir, { yes: true }),
    /--undo` deletes wrangler\.jsonc .* Delete the routes in the dashboard/,
  );
  assert.deepEqual(snapshot(dir), before);
  assert.ok(!existsSync(join(dir, "packages/client/public/_headers")), "no second _headers");
  assert.ok(!existsSync(join(dir, "scripts/carry-static.mjs")), "no carry script copy");
  rmSync(dir, { recursive: true, force: true });
});

await test("hatchkit cloudflare: a fullstack client on routes is refused too, with its own undo", () => {
  const mood = {
    name: "mood",
    domain: "mood.example.com",
    deploymentMode: "coolify" as const,
    clientHost: "cloudflare" as const,
  };
  assert.match(cloudflareSetupRefusal(mood, "/nonexistent", "setup") ?? "", /Worker mood-client/);
  assert.match(
    cloudflareSetupRefusal(mood, "/nonexistent", "undo") ?? "",
    /hatchkit migrate-client --rollback/,
  );
  assert.equal(
    cloudflareSetupRefusal(
      { name: "s", domain: "s.example.com", deploymentMode: "cloudflare" },
      "/x",
      "setup",
    ),
    null,
    "a Custom Domain site still runs",
  );
  assert.equal(
    cloudflareSetupRefusal(null, "/x", "setup"),
    null,
    "a repo with no manifest still runs",
  );
});

// ---------------------------------------------------------------------------
// 4. status and explain
// ---------------------------------------------------------------------------

await test("status --json: project.deployment says what serves it and who releases it", async () => {
  const { collectStatus, renderStatusHuman } = await import("./src/status.js");
  const dir = siteProject();
  const status = collectStatus(dir);
  assert.deepEqual(status.project?.deployment, {
    mode: "cloudflare",
    clientHost: "cloudflare",
    worker: WORKER,
    hosts: HOSTS,
    clientRelease: "repo",
  });
  assert.match(
    renderStatusHuman(status),
    /Deploy: {3}no server, Worker chemistry-sketcher-client on Workers routes \(hydroxyl\.app, www\.hydroxyl\.app, chemistry\.trebeljahr\.com\), released by the repo's CI/,
  );

  const coolify = project({
    ".hatchkit.json": JSON.stringify({
      version: 5,
      name: "raptor",
      domain: "raptor.example.com",
      features: [],
      mlServices: [],
    }),
  });
  assert.deepEqual(collectStatus(coolify).project?.deployment, {
    mode: "coolify",
    clientHost: null,
    hosts: ["raptor.example.com"],
    clientRelease: "hatchkit",
  });
  // A manifest with no domain keeps its project block.
  const bare = project({
    ".hatchkit.json": JSON.stringify({ version: 2, name: "demo", features: [] }),
  });
  assert.deepEqual(collectStatus(bare).project?.deployment.hosts, []);
  for (const d of [dir, coolify, bare]) rmSync(d, { recursive: true, force: true });
});

await test("explain: names the shape and the fields", async () => {
  const { renderExplain } = await import("./src/explain.js");
  const model = JSON.parse(renderExplain({ json: true })) as {
    concepts: Array<{ name: string; description: string }>;
  };
  const concept = model.concepts.find((c) => c.name === "Where a project runs");
  assert.ok(concept);
  for (const word of [
    "clientHost",
    "clientRelease",
    "clientWorker",
    "project.deployment",
    "routes",
  ]) {
    assert.ok(concept.description.includes(word), word);
  }
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nrouted-worker-site: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
