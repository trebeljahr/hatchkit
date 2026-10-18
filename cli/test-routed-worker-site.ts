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
 *   5. Several Workers (`clientWorkers`, mesozoic-protocol's live zone
 *      read on 2026-10-19): a Worker per host, extra routes to API
 *      Workers, hosts only hatchkit's redirect rules answer.
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
  edgeByWorker,
  isRoutedWorkerSite,
  leftoverAcmeRoutes,
  redirectedSiteHosts,
  repoOwnsWorkerFiles,
  resolveEdgeZones,
  routedWorkerSiteEdge,
  siteWorkers,
} = await import("./src/deploy/routed-worker-site.js");
const { renderHostRedirectRule, renderHttpsRedirectRule } = await import(
  "./src/deploy/client-host.js"
);
type CfRedirectRule = import("./src/utils/cloudflare-api.js").CfRedirectRule;
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
  const bare = routedWorkerSiteEdge({ ...SITE, originPaths: ["/trpc*"] } as never, "/x");
  assert.equal(bare.routes[0].pattern, "hydroxyl.app/trpc*", "same pattern rule as migrate-client");
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

// ---------------------------------------------------------------------------
// 5. Several Workers: mesozoic-protocol
// ---------------------------------------------------------------------------

const APEX = "mesozoicprotocol.com";
const PLAY = "play.mesozoicprotocol.com";
const WWW = "www.mesozoicprotocol.com";
const OLD = "protocol.trebeljahr.com";
const SITE_W = "mesozoic-protocol-site";
const PLAY_W = "mesozoic-protocol-play";
const NEWS_W = "mesozoic-protocol-newsletter";
const FEED_W = "mesozoic-protocol-feedback";

/** mesozoic-protocol's manifest with the map its live zone needs. */
const MESOZOIC = {
  version: 4,
  name: "mesozoic-protocol",
  domain: APEX,
  aliases: [PLAY, WWW, OLD],
  features: [],
  mlServices: [],
  ports: { server: 3000, client: 3001 },
  surfaces: "static",
  deploymentMode: "cloudflare",
  clientHost: "cloudflare",
  clientWorker: SITE_W,
  clientWorkers: {
    [PLAY]: PLAY_W,
    [WWW]: null,
    [OLD]: null,
    [`${APEX}/api/newsletter/*`]: NEWS_W,
    [`${PLAY}/api/feedback*`]: FEED_W,
  },
  clientRelease: "repo",
};

/** The two zones as read on 2026-10-19: four routes on
 *  mesozoicprotocol.com, none for protocol. on trebeljahr.com (which
 *  carries other projects' routes), hatchkit's HTTPS rule and one host
 *  redirect rule on each. */
function fakeMesozoic(
  init: {
    routes?: Record<string, CfWorkerRoute[]>;
    rules?: Record<string, CfRedirectRule[]>;
    undeployed?: string[];
    dnsOnly?: string[];
  } = {},
) {
  const routes = init.routes ?? {
    meso: [
      { id: "f", pattern: `${PLAY}/api/feedback*`, script: FEED_W },
      { id: "p", pattern: `${PLAY}/*`, script: PLAY_W },
      { id: "s", pattern: `${APEX}/*`, script: SITE_W },
      { id: "n", pattern: `${APEX}/api/newsletter/*`, script: NEWS_W },
    ],
    treb: [{ id: "c", pattern: "chemistry.trebeljahr.com/*", script: WORKER }],
  };
  const rules = init.rules ?? {
    meso: [
      renderHttpsRedirectRule([APEX, PLAY]),
      renderHostRedirectRule(WWW, `https://${APEX}`, 301),
    ],
    treb: [
      renderHttpsRedirectRule(["chemistry.trebeljahr.com", "names.trebeljahr.com"]),
      renderHostRedirectRule(OLD, `https://${PLAY}`, 301),
    ],
  };
  const workers = [SITE_W, PLAY_W, NEWS_W, FEED_W];
  const writes: string[] = [];
  const api = {
    async resolveZoneForName(name: string) {
      const id = name.endsWith(APEX) ? "meso" : "treb";
      return { id, name: id === "meso" ? APEX : "trebeljahr.com", name_servers: [] };
    },
    async listWorkerRoutes(zone: string) {
      return (routes[zone] ?? []).map((r) => ({ ...r }));
    },
    async findRecordsByName(_z: string, name: string) {
      const proxied = !(init.dnsOnly ?? []).includes(name);
      return [{ id: "d", type: "A", name, content: "1.2.3.4", proxied }];
    },
    async getWorker(_a: string, name: string) {
      return workers.includes(name) ? { id: name, name } : null;
    },
    async listWorkerDeployments(_a: string, name: string) {
      return (init.undeployed ?? []).includes(name)
        ? []
        : [
            {
              id: "dep",
              created_on: "2026-10-18",
              versions: [{ version_id: `v-${name.split("-").pop()}`, percentage: 100 }],
            },
          ];
    },
    async getRedirectRuleset(zone: string): Promise<CfRuleset | null> {
      const list = rules[zone];
      return list
        ? { id: `rs-${zone}`, rules: list.map((r, i) => ({ ...r, id: `${zone}-${i}` })) }
        : null;
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
  return { writes, cloudflare: { api: api as unknown as CloudflareApi, accountId: "acct" } };
}

async function mesozoicRoutes(
  init: Parameters<typeof fakeMesozoic>[0] = {},
  manifest: Record<string, unknown> = MESOZOIC,
) {
  const cf = fakeMesozoic(init);
  const [routes] = await checkRoutedWorkerSite("/nonexistent", manifest as never, {
    cloudflare: cf.cloudflare,
    fetch: okFetch().fn,
  });
  return { routes, writes: cf.writes };
}

await test("several Workers: each host's Worker, the API routes first, redirected hosts left out", () => {
  const edge = routedWorkerSiteEdge(MESOZOIC as never, "/nonexistent");
  assert.equal(edge.worker, SITE_W, "clientWorker stays the default");
  assert.deepEqual(edge.hosts, [APEX, PLAY]);
  assert.deepEqual(
    edge.routes.map((r) => [r.pattern, r.script, r.purpose]),
    [
      [`${APEX}/api/newsletter/*`, NEWS_W, "worker"],
      [`${PLAY}/api/feedback*`, FEED_W, "worker"],
      [`${APEX}/*`, SITE_W, "client"],
      [`${PLAY}/*`, PLAY_W, "client"],
    ],
  );
  assert.deepEqual(siteWorkers(edge), [SITE_W, PLAY_W]);
  assert.deepEqual(redirectedSiteHosts(MESOZOIC as never), [WWW, OLD]);

  // Without the map every host is on the one Worker, as before.
  const single = routedWorkerSiteEdge({ ...MESOZOIC, clientWorkers: undefined } as never, "/x");
  assert.deepEqual(single.hosts, [APEX, PLAY, WWW, OLD]);
  assert.ok(single.routes.every((r) => r.script === SITE_W));
});

await test("several Workers: one plan per Worker, each seeing its hosts' other routes as planned", () => {
  const parts = edgeByWorker(routedWorkerSiteEdge(MESOZOIC as never, "/nonexistent"));
  assert.deepEqual(
    parts.map((p) => [p.worker, p.hosts, p.routes.length]),
    [
      [SITE_W, [APEX], 2],
      [PLAY_W, [PLAY], 2],
      [NEWS_W, [APEX], 2],
      [FEED_W, [PLAY], 2],
    ],
  );
  const hydroxyl = edgeByWorker(routedWorkerSiteEdge(SITE as never, "/nonexistent"));
  assert.equal(hydroxyl.length, 1, "one Worker: the plan unchanged");
  assert.deepEqual(hydroxyl[0].hosts, HOSTS);
});

await test("several Workers: a map entry that does not fit the hosts is refused, naming it", () => {
  const plan = (clientWorkers: Record<string, unknown>) => () =>
    routedWorkerSiteEdge({ ...MESOZOIC, clientWorkers } as never, "/nonexistent");
  assert.throws(
    plan({ "pay.mesozoicprotocol.com": PLAY_W }),
    /"pay\.mesozoicprotocol\.com": pay\.mesozoicprotocol\.com is not the domain or an alias/,
  );
  assert.throws(plan({ "api.example.com/x*": NEWS_W }), /is not the domain or an alias/);
  assert.throws(plan({ [`${APEX}/api/*`]: null }), /a route needs a Worker/);
  assert.throws(plan({ [`${PLAY}/*`]: PLAY_W }), /name the host \("play\.mesozoicprotocol\.com"\)/);
  assert.throws(plan({ [WWW]: null, [`${WWW}/x*`]: NEWS_W }), /redirected by the zone \(null\)/);
  assert.throws(
    plan({ [APEX]: null, [PLAY]: null, [WWW]: null, [OLD]: null }),
    /redirects every host/,
  );
  assert.throws(plan({ [PLAY]: 7 }), /the value is a Worker name, or null/);
  assert.throws(
    () =>
      routedWorkerSiteEdge(
        { ...MESOZOIC, clientWorkers: { [APEX]: null }, originPaths: ["/feed"] } as never,
        "/x",
      ),
    /originPaths are on the domain, which clientWorkers redirects/,
  );
});

await test("doctor: mesozoic's live zone is ok with the map; nothing written; every host fetched", async () => {
  const cf = fakeMesozoic();
  const fetcher = okFetch();
  const checks = await checkRoutedWorkerSite("/nonexistent", MESOZOIC as never, {
    cloudflare: cf.cloudflare,
    fetch: fetcher.fn,
  });
  assert.deepEqual(
    checks.map((c) => [c.name.split(": ")[1], c.status]),
    [
      ["routes", "ok"],
      ["live", "ok"],
    ],
    checks[0].hint?.join("\n"),
  );
  assert.equal(
    checks[0].detail,
    `4 route(s) on ${APEX}, trebeljahr.com, Worker ${SITE_W} live (v-site), Worker ${PLAY_W} live (v-play), ` +
      `Worker ${NEWS_W} live (v-newsletter), Worker ${FEED_W} live (v-feedback); ${WWW}, ${OLD} redirected by the zone`,
  );
  assert.deepEqual(cf.writes, []);
  assert.deepEqual(
    fetcher.urls.map((u) => new URL(u).host),
    [APEX, PLAY, WWW, OLD],
  );
});

await test("doctor: one clientWorker cannot describe mesozoic (why the map exists)", async () => {
  const { routes } = await mesozoicRoutes({}, { ...MESOZOIC, clientWorkers: undefined });
  assert.equal(routes.status, "fail");
  const hints = routes.hint ?? [];
  assert.ok(hints.some((h) => h.includes(`${PLAY}/* sends to ${PLAY_W}, expected ${SITE_W}`)));
  assert.ok(hints.some((h) => h.includes(`Foreign Workers route ${APEX}/api/newsletter/*`)));
  assert.ok(hints.some((h) => h.includes(`route ${WWW}/* → ${SITE_W} is missing`)));
});

await test("doctor: with the map, a wrong Worker, an empty API Worker and redirect gaps fail", async () => {
  const wrong = await mesozoicRoutes({
    routes: {
      meso: [
        { id: "f", pattern: `${PLAY}/api/feedback*`, script: FEED_W },
        { id: "p", pattern: `${PLAY}/*`, script: SITE_W },
        { id: "s", pattern: `${APEX}/*`, script: SITE_W },
        { id: "n", pattern: `${APEX}/api/newsletter/*`, script: NEWS_W },
      ],
    },
  });
  assert.equal(wrong.routes.status, "fail");
  assert.equal(
    wrong.routes.hint?.filter((h) => h.includes(`${PLAY}/* sends to ${SITE_W}, expected ${PLAY_W}`))
      .length,
    1,
    "one line although two Workers share the host",
  );

  const missingApi = await mesozoicRoutes({
    routes: {
      meso: [
        { id: "p", pattern: `${PLAY}/*`, script: PLAY_W },
        { id: "s", pattern: `${APEX}/*`, script: SITE_W },
        { id: "n", pattern: `${APEX}/api/newsletter/*`, script: NEWS_W },
      ],
    },
  });
  assert.ok(
    missingApi.routes.hint?.some((h) => h === `route ${PLAY}/api/feedback* → ${FEED_W} is missing`),
  );

  const empty = await mesozoicRoutes({ undeployed: [NEWS_W] });
  assert.equal(empty.routes.status, "fail");
  assert.match(
    empty.routes.detail ?? "",
    /Worker mesozoic-protocol-newsletter has no deployed version/,
  );

  const noRule = await mesozoicRoutes({
    rules: { meso: [renderHttpsRedirectRule([APEX, PLAY])], treb: [] },
  });
  assert.equal(noRule.routes.status, "fail");
  for (const [host, zone] of [
    [WWW, APEX],
    [OLD, "trebeljahr.com"],
  ]) {
    assert.ok(
      noRule.routes.hint?.some(
        (h) =>
          h ===
          `${host} has no hatchkit redirect rule on ${zone}: \`hatchkit cloudflare redirect add ${host} <https-origin>\``,
      ),
      host,
    );
  }

  const noHttps = await mesozoicRoutes({
    rules: {
      meso: [renderHostRedirectRule(WWW, `https://${APEX}`, 301)],
      treb: [renderHostRedirectRule(OLD, `https://${PLAY}`, 301)],
    },
  });
  assert.deepEqual(
    noHttps.routes.hint?.filter((h) => h.startsWith("HTTPS redirect")),
    [
      `HTTPS redirect on ${APEX} does not cover ${APEX}, ${PLAY}: \`hatchkit cloudflare https add ${APEX} ${PLAY}\``,
    ],
    "one line per zone, not one per Worker; redirected hosts need no HTTPS rule",
  );

  const disabled = await mesozoicRoutes({
    rules: {
      meso: [
        renderHttpsRedirectRule([APEX, PLAY]),
        { ...renderHostRedirectRule(WWW, `https://${APEX}`, 301), enabled: false },
      ],
      treb: [renderHostRedirectRule(OLD, `https://${PLAY}`, 301)],
    },
  });
  assert.match(
    disabled.routes.detail ?? "",
    /redirect rule for www\.mesozoicprotocol\.com .* is disabled/,
  );

  const routed = await mesozoicRoutes({
    routes: {
      meso: [
        { id: "f", pattern: `${PLAY}/api/feedback*`, script: FEED_W },
        { id: "p", pattern: `${PLAY}/*`, script: PLAY_W },
        { id: "s", pattern: `${APEX}/*`, script: SITE_W },
        { id: "n", pattern: `${APEX}/api/newsletter/*`, script: NEWS_W },
        { id: "w", pattern: `${WWW}/*`, script: SITE_W },
      ],
      treb: [{ id: "x", pattern: "*.trebeljahr.com/*", script: "catch-all" }],
    },
    dnsOnly: [OLD],
  });
  const hints = routed.routes.hint ?? [];
  assert.ok(
    hints.some((h) =>
      h.startsWith(`Route ${WWW}/* → ${SITE_W} (w) is on a host clientWorkers marks as redirected`),
    ),
  );
  assert.ok(
    hints.some((h) => h.startsWith("Route *.trebeljahr.com/* → catch-all (x) is on a host")),
  );
  assert.ok(
    hints.includes(`${OLD} has a DNS-only record; redirect rules run only on proxied records.`),
  );
});

await test("doctor: clientWorkers outside a site with no server, and a bad map, fail without a crash", async () => {
  const { checkProjectClientHostState } = await import("./src/doctor.js");
  const coolify = siteProject({
    ...SITE,
    deploymentMode: "coolify",
    clientWorkers: { "www.hydroxyl.app": "x" },
  });
  const [config] = await checkProjectClientHostState(coolify, { fetch: okFetch().fn });
  assert.equal(config.status, "fail");
  assert.match(config.detail ?? "", /clientWorkers is read only for a site with no server/);

  const bad = siteProject({ ...SITE, clientWorkers: { "nope.hydroxyl.app": "x" } });
  const checks = await checkProjectClientHostState(bad, { fetch: okFetch().fn });
  assert.deepEqual(
    checks.map((c) => [c.name.split(": ")[1], c.status]),
    [
      ["config", "ok"],
      ["routes", "fail"],
    ],
  );
  assert.match(checks[1].detail ?? "", /clientWorkers "nope\.hydroxyl\.app"/);

  // A wrangler.jsonc that deploys one of the map's Workers agrees with it.
  const named = siteProject({
    ...SITE,
    clientWorker: "other",
    clientWorkers: { "www.hydroxyl.app": WORKER },
  });
  const [agrees] = await checkProjectClientHostState(named, { fetch: okFetch().fn });
  assert.equal(agrees.status, "ok", agrees.detail);
  for (const d of [coolify, bad, named]) rmSync(d, { recursive: true, force: true });
});

await test("status, sync, rename-domain and `hatchkit cloudflare` name every Worker", async () => {
  const { collectStatus, renderStatusHuman } = await import("./src/status.js");
  const { runRenameDomain } = await import("./src/deploy/rename-domain.js");
  const dir = project({ ".hatchkit.json": JSON.stringify(MESOZOIC, null, 2) });
  const status = collectStatus(dir);
  assert.deepEqual(status.project?.deployment, {
    mode: "cloudflare",
    clientHost: "cloudflare",
    worker: SITE_W,
    workers: {
      [APEX]: SITE_W,
      [PLAY]: PLAY_W,
      [WWW]: null,
      [OLD]: null,
      [`${APEX}/api/newsletter/*`]: NEWS_W,
      [`${PLAY}/api/feedback*`]: FEED_W,
    },
    hosts: [APEX, PLAY, WWW, OLD],
    clientRelease: "repo",
  });
  assert.ok(
    renderStatusHuman(status).includes(
      `Deploy:   no server, Workers on Workers routes (${APEX} → ${SITE_W}, ${PLAY} → ${PLAY_W}, ${WWW} redirected, ${OLD} redirected, ${APEX}/api/newsletter/* → ${NEWS_W}, ${PLAY}/api/feedback* → ${FEED_W}), released by the repo's CI`,
    ),
  );
  const badMap = project({
    ".hatchkit.json": JSON.stringify({ ...MESOZOIC, clientWorkers: { "x.example.com": "y" } }),
  });
  assert.equal(collectStatus(badMap).project?.deployment.workers, undefined, "status never throws");

  assert.match(
    cloudflareSetupRefusal(MESOZOIC as never, dir, "setup") ?? "",
    /served by Workers mesozoic-protocol-site, mesozoic-protocol-play through Workers routes/,
  );
  await assert.rejects(
    runRenameDomain({ projectDir: dir, monorepoRoot: dir, newDomain: "mesozoic.dev" } as never),
    (err: Error) =>
      err.message.includes(
        `Workers ${SITE_W}, ${PLAY_W} through Workers routes on ${APEX}, ${PLAY}`,
      ) && err.message.includes("<new-host>/* → the host's Worker"),
  );
  for (const d of [dir, badMap]) rmSync(d, { recursive: true, force: true });
});

await test("explain: names clientWorkers", async () => {
  const { renderExplain } = await import("./src/explain.js");
  const model = JSON.parse(renderExplain({ json: true })) as {
    concepts: Array<{ name: string; description: string }>;
  };
  const concept = model.concepts.find((c) => c.name === "Where a project runs");
  assert.ok(concept?.description.includes("clientWorkers"));
  assert.ok(concept?.description.includes("project.deployment.workers"));
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nrouted-worker-site: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
