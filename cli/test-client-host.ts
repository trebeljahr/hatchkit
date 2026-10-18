/**
 * Client on Cloudflare Workers, API on Coolify (`clientHost: "cloudflare"`).
 *
 * What the live canary test (2026-10-12) proved, pinned here so it cannot
 * drift:
 *
 *   1. The routing plan: no client app; `/api/*` and the ACME path go to
 *      the origin by no-Worker routes made BEFORE `<domain>/*`, and come
 *      off AFTER it.
 *   2. The zone diff and the writes against a fake Cloudflare API: order,
 *      ledger, foreign routes refused and never deleted.
 *   3. The HTTPS rule: one hatchkit rule per zone, `/.well-known/`
 *      excluded, other rules untouched.
 *   4. The workflow rewrite: upload in the build job, server first, then
 *      the Worker switch, and a summary that says which half is live.
 *   5. The client scan and the repo files, including the `_redirects`
 *      conversion with a query-string target.
 *   6. The cutover comparison that decides whether the route stays.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const { computeRoutingPlan, edgeRemovalOrder, normaliseOriginPaths } = await import(
  "./src/deploy/routing.js"
);
const {
  addHttpsRedirectHosts,
  applyEdgeRoutes,
  diffEdge,
  parseHttpsRuleHosts,
  preflightEdge,
  removeEdgeRoutes,
  removeHttpsRedirectHosts,
  renderHttpsRedirectRule,
  routeHostMatches,
} = await import("./src/deploy/client-host.js");
const { listJobs, rewriteWorkflowForWorkerClient } = await import(
  "./src/deploy/client-host-workflow.js"
);
const { convertNextRedirects, scanClientProject, workerConfigFindings, writeClientRepoFiles } =
  await import("./src/deploy/client-host-repo.js");
const { compareCutover, parseMigrateClientArgs, planClientMigration } = await import(
  "./src/deploy/migrate-client.js"
);
const { findImmutable404Rules, findWranglerBillingKeys } = await import(
  "./src/scaffold/worker-assets.js"
);
const { locateSyncApps } = await import("./src/deploy/sync.js");
type RoutingInput = import("./src/deploy/routing.js").RoutingInput;
type CfWorkerRoute = import("./src/utils/cloudflare-api.js").CfWorkerRoute;
type CfRuleset = import("./src/utils/cloudflare-api.js").CfRuleset;
type CfRedirectRule = import("./src/utils/cloudflare-api.js").CfRedirectRule;
type LedgerStep = import("./src/utils/run-ledger.js").LedgerStep;

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

const base: RoutingInput = {
  name: "mood",
  domain: "mood.example.com",
  topology: "single-origin",
  surfaces: "fullstack",
  runtime: "image",
  clientHost: "cloudflare",
  images: { client: "ghcr.io/o/mood-client:live", server: "ghcr.io/o/mood-server:live" },
};

// ---------------------------------------------------------------------------
// 1. Routing plan
// ---------------------------------------------------------------------------

await test("single-origin: no client app, server keeps <domain>/api", () => {
  const plan = computeRoutingPlan(base);
  assert.deepEqual(
    plan.apps.map((a) => a.appName),
    ["mood-server"],
  );
  assert.deepEqual(plan.apps[0].flatDomains, ["https://mood.example.com/api"]);
  assert.equal(plan.apps[0].stripPrefix, false);
});

await test("single-origin: no-Worker routes first, <domain>/* last", () => {
  const edge = computeRoutingPlan(base).edge;
  assert.ok(edge);
  assert.equal(edge.worker, "mood-client");
  assert.deepEqual(
    edge.routes.map((r) => [r.pattern, r.script, r.purpose]),
    [
      ["mood.example.com/api/*", null, "origin"],
      ["mood.example.com/.well-known/acme-challenge/*", null, "acme"],
      ["mood.example.com/*", "mood-client", "client"],
    ],
  );
});

await test("removal order: Worker routes first, then the no-Worker ones", () => {
  const edge = computeRoutingPlan({ ...base, hostnameAliases: ["www.mood.example.com"] }).edge;
  assert.ok(edge);
  assert.deepEqual(
    edgeRemovalOrder(edge).map((r) => r.pattern),
    [
      "www.mood.example.com/*",
      "mood.example.com/*",
      "mood.example.com/.well-known/acme-challenge/*",
      "mood.example.com/api/*",
    ],
  );
});

await test("aliases get a Worker route but no API or ACME route", () => {
  // Only the primary host keeps a Coolify router (the server's /api), so
  // only it keeps a Traefik certificate to renew.
  const edge = computeRoutingPlan({ ...base, hostnameAliases: ["www.mood.example.com"] }).edge;
  assert.ok(edge);
  assert.deepEqual(edge.hosts, ["mood.example.com", "www.mood.example.com"]);
  assert.ok(!edge.routes.some((r) => r.host === "www.mood.example.com" && r.script === null));
});

await test("split: no origin routes, no ACME route, API host never on the Worker", () => {
  const plan = computeRoutingPlan({
    ...base,
    topology: "split",
    hostnameAliases: ["api.mood.example.com"],
  });
  assert.deepEqual(plan.apps[0].flatDomains, ["https://api.mood.example.com"]);
  assert.deepEqual(
    plan.edge?.routes.map((r) => r.pattern),
    ["mood.example.com/*"],
  );
  assert.deepEqual(plan.edge?.hosts, ["mood.example.com"]);
});

await test("originPaths and the Worker name come from the input", () => {
  const edge = computeRoutingPlan({
    ...base,
    originPaths: ["/trpc", "/socket.io/"],
    clientWorker: "chess-web",
  }).edge;
  assert.ok(edge);
  assert.deepEqual(
    edge.routes.filter((r) => r.purpose === "origin").map((r) => r.pattern),
    ["mood.example.com/trpc/*", "mood.example.com/socket.io/*"],
  );
  assert.equal(edge.routes.at(-1)?.script, "chess-web");
});

await test("originPaths: path prefixes only", () => {
  assert.deepEqual(normaliseOriginPaths(["/api", "/api/", "/ws"]), ["/api", "/ws"]);
  for (const bad of ["/", "api", "/api*", "/a?b", "/a b", "//x"]) {
    assert.throws(() => normaliseOriginPaths([bad]), /path prefix/, bad);
  }
});

await test("refuses a compose runtime, a static site and a backend", () => {
  assert.throws(() => computeRoutingPlan({ ...base, runtime: "compose" }), /migrate-runtime/);
  assert.throws(() => computeRoutingPlan({ ...base, surfaces: "static" }), /hatchkit cloudflare/);
  assert.throws(() => computeRoutingPlan({ ...base, surfaces: "backend" }), /client and a server/);
});

await test("clientHost coolify leaves the plan exactly as before", () => {
  const withField = computeRoutingPlan({ ...base, clientHost: "coolify" });
  const { clientHost: _c, ...without } = base;
  assert.deepEqual(withField, computeRoutingPlan(without));
  assert.equal(withField.edge, undefined);
});

// ---------------------------------------------------------------------------
// 2. Zone diff and writes
// ---------------------------------------------------------------------------

const edge = computeRoutingPlan(base).edge;
assert.ok(edge);

await test("route host patterns with wildcards", () => {
  assert.ok(routeHostMatches("*.example.com", "mood.example.com"));
  assert.ok(routeHostMatches("*example.com", "mood.example.com"));
  assert.ok(!routeHostMatches("*.example.com", "example.com"));
  assert.ok(!routeHostMatches("other.example.com", "mood.example.com"));
});

await test("diff: present, missing, wrong Worker, foreign", () => {
  const zone: CfWorkerRoute[] = [
    { id: "1", pattern: "mood.example.com/api/*", script: null },
    { id: "2", pattern: "mood.example.com/*", script: "someone-else" },
    { id: "3", pattern: "*.example.com/*", script: "catch-all" },
    { id: "4", pattern: "other.example.com/*", script: "x" },
  ];
  const diff = diffEdge(edge, zone);
  assert.deepEqual(
    diff.present.map((p) => p.want.pattern),
    ["mood.example.com/api/*"],
  );
  assert.deepEqual(
    diff.missing.map((r) => r.pattern),
    ["mood.example.com/.well-known/acme-challenge/*"],
  );
  assert.deepEqual(
    diff.wrongScript.map((w) => w.have.id),
    ["2"],
  );
  assert.deepEqual(
    diff.foreign.map((r) => r.id),
    ["3"],
  );
});

/** In-memory Cloudflare: routes, one redirect ruleset, DNS, a Worker. */
function fakeCloudflare(init: {
  routes?: CfWorkerRoute[];
  ruleset?: CfRuleset | null;
  proxied?: boolean;
  deployed?: boolean;
}) {
  const calls: string[] = [];
  let routes = [...(init.routes ?? [])];
  let ruleset = init.ruleset === undefined ? null : init.ruleset;
  let next = 100;
  const api = {
    async listWorkerRoutes() {
      return routes.map((r) => ({ ...r }));
    },
    async createWorkerRoute(_z: string, pattern: string, script?: string | null) {
      calls.push(`create ${pattern} ${script ?? "-"}`);
      const route = { id: String(next++), pattern, script: script ?? null };
      routes.push(route);
      return route;
    },
    async deleteWorkerRoute(_z: string, id: string) {
      const hit = routes.find((r) => r.id === id);
      calls.push(`delete ${hit?.pattern}`);
      routes = routes.filter((r) => r.id !== id);
      return hit ? ("deleted" as const) : ("not-found" as const);
    },
    async getRedirectRuleset() {
      return ruleset ? structuredClone(ruleset) : null;
    },
    async addRedirectRule(_z: string, rule: CfRedirectRule) {
      calls.push("add rule");
      ruleset = ruleset ?? { id: "rs", rules: [] };
      ruleset.rules = [...(ruleset.rules ?? []), { ...rule, id: `r${next++}` }];
      return ruleset;
    },
    async updateRedirectRule(_z: string, _rs: string, id: string, rule: CfRedirectRule) {
      calls.push(`update rule ${id}`);
      if (ruleset?.rules)
        ruleset.rules = ruleset.rules.map((r) => (r.id === id ? { ...rule, id } : r));
      return ruleset as CfRuleset;
    },
    async deleteRedirectRule(_z: string, _rs: string, id: string) {
      calls.push(`delete rule ${id}`);
      if (ruleset?.rules) ruleset.rules = ruleset.rules.filter((r) => r.id !== id);
      return "deleted" as const;
    },
    async findRecordsByName(_z: string, name: string) {
      return [{ id: "d", type: "A", name, content: "1.2.3.4", proxied: init.proxied ?? true }];
    },
    async getWorker(_a: string, name: string) {
      return { id: "w", name };
    },
    async listWorkerDeployments() {
      return init.deployed === false
        ? []
        : [
            {
              id: "dep",
              created_on: "2026-10-15",
              versions: [{ version_id: "v1", percentage: 100 }],
            },
          ];
    },
  };
  return {
    api,
    calls,
    routes: () => routes,
    ruleset: () => ruleset,
    ctx: {
      api: api as unknown as import("./src/utils/cloudflare-api.js").CloudflareApi,
      accountId: "acct",
      zoneId: "zone",
      zoneName: "example.com",
    },
  };
}

function fakeLedger() {
  const steps: LedgerStep[] = [];
  return { steps, ledger: { record: (s: LedgerStep) => steps.push(s) } as never };
}

await test("apply: creation order, ledger per route, re-run creates nothing", async () => {
  const cf = fakeCloudflare({});
  const { steps, ledger } = fakeLedger();
  await applyEdgeRoutes(cf.ctx, edge, { ledger });
  assert.deepEqual(cf.calls, [
    "create mood.example.com/api/* -",
    "create mood.example.com/.well-known/acme-challenge/* -",
    "create mood.example.com/* mood-client",
  ]);
  assert.deepEqual(
    steps.map((s) => (s.kind === "cloudflareWorkerRoute" ? s.pattern : s.kind)),
    edge.routes.map((r) => r.pattern),
  );
  const again = await applyEdgeRoutes(cf.ctx, edge, {});
  assert.equal(again.length, 0);
});

await test("apply: originRoutesOnly stops before the cutover route", async () => {
  const cf = fakeCloudflare({});
  await applyEdgeRoutes(cf.ctx, edge, { originRoutesOnly: true });
  assert.ok(!cf.routes().some((r) => r.script));
  assert.equal(cf.routes().length, 2);
});

await test("apply refuses while a foreign route sits on the host, and deletes nothing", async () => {
  const cf = fakeCloudflare({ routes: [{ id: "9", pattern: "*.example.com/*", script: "x" }] });
  await assert.rejects(applyEdgeRoutes(cf.ctx, edge, {}), /did not plan/);
  assert.deepEqual(cf.calls, []);
});

await test("remove: Worker route first, only routes the plan names", async () => {
  const cf = fakeCloudflare({
    routes: [{ id: "9", pattern: "unrelated.example.com/*", script: "x" }],
  });
  await applyEdgeRoutes(cf.ctx, edge, {});
  cf.calls.length = 0;
  await removeEdgeRoutes(cf.ctx, edge);
  assert.deepEqual(cf.calls, [
    "delete mood.example.com/*",
    "delete mood.example.com/.well-known/acme-challenge/*",
    "delete mood.example.com/api/*",
  ]);
  assert.deepEqual(
    cf.routes().map((r) => r.id),
    ["9"],
  );
});

await test("remove clientOnly keeps the inert no-Worker routes", async () => {
  const cf = fakeCloudflare({});
  await applyEdgeRoutes(cf.ctx, edge, {});
  await removeEdgeRoutes(cf.ctx, edge, { clientOnly: true });
  assert.deepEqual(
    cf.routes().map((r) => r.pattern),
    ["mood.example.com/api/*", "mood.example.com/.well-known/acme-challenge/*"],
  );
});

await test("remove leaves a same-pattern route that points at another Worker", async () => {
  const cf = fakeCloudflare({
    routes: [{ id: "7", pattern: "mood.example.com/*", script: "other" }],
  });
  await removeEdgeRoutes(cf.ctx, edge);
  assert.deepEqual(cf.calls, []);
});

await test("preflight blocks DNS-only hosts, a Worker with no version and foreign routes", async () => {
  const dnsOnly = await preflightEdge(fakeCloudflare({ proxied: false }).ctx, edge);
  assert.ok(dnsOnly.blocking.some((b) => /DNS-only/.test(b)));
  const empty = await preflightEdge(fakeCloudflare({ deployed: false }).ctx, edge);
  assert.ok(empty.blocking.some((b) => /no deployed version/.test(b)));
  const foreign = await preflightEdge(
    fakeCloudflare({ routes: [{ id: "3", pattern: "*.example.com/*", script: "x" }] }).ctx,
    edge,
  );
  assert.ok(foreign.blocking.some((b) => /Foreign Workers route \*\.example\.com/.test(b)));
  // DNS reads go through the DNS token when the provisioner cannot read DNS.
  const noDns = fakeCloudflare({});
  noDns.api.findRecordsByName = async () => {
    throw Object.assign(new Error("10000: Authentication error"), { status: 403 });
  };
  const viaDnsToken = await preflightEdge(
    { ...noDns.ctx, dnsApi: fakeCloudflare({}).api as never },
    edge,
  );
  assert.deepEqual(viaDnsToken.blocking, []);
  const clean = await preflightEdge(fakeCloudflare({}).ctx, edge);
  assert.deepEqual(clean.blocking, []);
  assert.deepEqual(clean.liveVersions, ["v1"]);
  assert.deepEqual(clean.httpsMissing, ["mood.example.com"]);
});

// ---------------------------------------------------------------------------
// 3. HTTPS rule
// ---------------------------------------------------------------------------

await test("HTTPS rule: http only, host set, /.well-known/ excluded, 301 keeping path and query", () => {
  const rule = renderHttpsRedirectRule(["b.example.com", "a.example.com", "a.example.com"]);
  assert.equal(
    rule.expression,
    '(not ssl and http.host in {"a.example.com" "b.example.com"} and not starts_with(http.request.uri.path, "/.well-known/"))',
  );
  assert.equal(rule.action_parameters.from_value.status_code, 301);
  assert.equal(rule.action_parameters.from_value.preserve_query_string, true);
  assert.match(
    rule.action_parameters.from_value.target_url.expression ?? "",
    /http\.request\.uri\.path/,
  );
  assert.deepEqual(parseHttpsRuleHosts(rule), ["a.example.com", "b.example.com"]);
  assert.equal(parseHttpsRuleHosts({ expression: `${rule.expression} or true` }), null);
  // The form trackyourtime made in the dashboard (no ref) is hatchkit's.
  assert.deepEqual(
    parseHttpsRuleHosts({
      expression:
        '(not ssl and http.host in {"trackyourtime.dev"} and not starts_with(http.request.uri.path, "/.well-known/"))',
    }),
    ["trackyourtime.dev"],
  );
  assert.throws(() => renderHttpsRedirectRule(['x" or true or "']), /Not a hostname/);
});

const raptor: CfRedirectRule = {
  id: "raptor",
  description: "Raptor Runner canonical domain",
  expression: '(http.host eq "raptor.example.com")',
  action: "redirect",
  action_parameters: { from_value: { status_code: 301, target_url: { value: "https://x" } } },
};

await test("HTTPS hosts: add creates the rule beside others, merges, removes, deletes when empty", async () => {
  const cf = fakeCloudflare({ ruleset: { id: "rs", rules: [raptor] } });
  const { steps, ledger } = fakeLedger();
  const first = await addHttpsRedirectHosts(cf.ctx, ["mood.example.com"], ledger);
  assert.deepEqual(first.added, ["mood.example.com"]);
  assert.deepEqual(steps, [
    { kind: "cloudflareRedirectHosts", zoneId: "zone", hosts: ["mood.example.com"] },
  ]);
  await addHttpsRedirectHosts(cf.ctx, ["streaks.example.com", "mood.example.com"]);
  const rules = cf.ruleset()?.rules ?? [];
  assert.equal(rules.length, 2, "one hatchkit rule beside raptor's");
  assert.deepEqual(parseHttpsRuleHosts(rules[1]), ["mood.example.com", "streaks.example.com"]);
  assert.equal(
    await removeHttpsRedirectHosts(cf.api as never, "zone", ["mood.example.com"]),
    "updated",
  );
  assert.equal(
    await removeHttpsRedirectHosts(cf.api as never, "zone", ["streaks.example.com"]),
    "deleted",
  );
  assert.deepEqual(
    (cf.ruleset()?.rules ?? []).map((r) => r.id),
    ["raptor"],
  );
});

await test("HTTPS hosts: a zone with no redirect ruleset gets one", async () => {
  const cf = fakeCloudflare({ ruleset: null });
  await addHttpsRedirectHosts(cf.ctx, ["mood.example.com"]);
  assert.deepEqual(cf.calls, ["add rule"]);
  const again = await addHttpsRedirectHosts(cf.ctx, ["mood.example.com"]);
  assert.deepEqual(again.added, []);
});

await test("host redirect: path and query kept, /.well-known/ on the origin, upsert idempotent", async () => {
  const { renderHostRedirectRule, upsertHostRedirect, removeHostRedirect } = await import(
    "./src/deploy/client-host.js"
  );
  const rule = renderHostRedirectRule("protocol.example.com", "https://play.mesozoic.example", 301);
  assert.equal(
    rule.expression,
    '(http.host eq "protocol.example.com" and not starts_with(http.request.uri.path, "/.well-known/"))',
  );
  assert.equal(
    rule.action_parameters.from_value.target_url.expression,
    'concat("https://play.mesozoic.example", http.request.uri.path)',
  );
  assert.equal(rule.action_parameters.from_value.preserve_query_string, true);
  assert.throws(
    () => renderHostRedirectRule("a.example.com", "https://b.example/path", 301),
    /bare https origin/,
  );
  assert.throws(
    () => renderHostRedirectRule("a.example.com", "http://b.example", 301),
    /bare https origin/,
  );
  assert.throws(
    () => renderHostRedirectRule("a.example.com", "https://a.example.com", 301),
    /itself/,
  );

  const cf = fakeCloudflare({ ruleset: { id: "rs", rules: [raptor] } });
  const { steps, ledger } = fakeLedger();
  assert.equal(
    await upsertHostRedirect(cf.ctx, "beauty.example.com", "https://cob.example", 308, ledger),
    "created",
  );
  assert.deepEqual(steps, [
    { kind: "cloudflareHostRedirect", zoneId: "zone", host: "beauty.example.com" },
  ]);
  assert.equal(
    await upsertHostRedirect(cf.ctx, "beauty.example.com", "https://cob.example", 308),
    "unchanged",
  );
  assert.equal(
    await upsertHostRedirect(cf.ctx, "beauty.example.com", "https://cob.example", 301),
    "updated",
  );
  await assert.rejects(
    upsertHostRedirect(cf.ctx, "raptor.example.com", "https://x.example", 301),
    /already matches raptor\.example\.com/,
  );
  assert.equal(await removeHostRedirect(cf.api as never, "zone", "beauty.example.com"), "deleted");
  // A rule made in the dashboard from hatchkit's values has no ref.
  const dash = fakeCloudflare({
    ruleset: {
      id: "rs",
      rules: [
        {
          ...renderHostRedirectRule("p.example.com", "https://q.example", 301),
          ref: undefined,
          id: "d1",
        },
      ],
    },
  });
  assert.equal(
    await upsertHostRedirect(dash.ctx, "p.example.com", "https://q.example", 301),
    "unchanged",
  );
  assert.equal(await removeHostRedirect(dash.api as never, "zone", "p.example.com"), "deleted");
  assert.deepEqual(
    (cf.ruleset()?.rules ?? []).map((r) => r.id),
    ["raptor"],
  );
});

// ---------------------------------------------------------------------------
// 4. Workflow rewrite
// ---------------------------------------------------------------------------

const STARTER_WORKFLOW = readFileSync(
  resolve(import.meta.dirname, "..", "starter", ".github", "workflows", "build-and-deploy.yml"),
  "utf-8",
);
const wfInput = {
  worker: "mood-client",
  siteUrl: "https://mood.example.com",
  apiUrl: "https://mood.example.com",
  buildCommands: ["pnpm --filter @mood/shared run build", "pnpm --filter @mood/client run build"],
  exportDir: "packages/client/out",
  nodeVersionFile: ".nvmrc",
};

await test("workflow: build-client uploads a version, nothing activates there", () => {
  const { text } = rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput);
  const lines = text.split("\n");
  const job = listJobs(lines).find((j) => j.name === "build-client");
  assert.ok(job);
  const body = lines.slice(job.start, job.end).join("\n");
  assert.match(body, /needs: \[verify, e2e\]/, "keeps the original needs");
  assert.match(body, /version_id: \$\{\{ steps\.upload\.outputs\.version_id \}\}/);
  assert.match(body, /NEXT_FILE_EXPORT: "1"/);
  assert.match(
    body,
    /NEXT_PUBLIC_API_URL: "\$\{\{ vars\.NEXT_PUBLIC_API_URL \}\}"/,
    "build args carried as env",
  );
  assert.match(
    body,
    /node scripts\/carry-static\.mjs --site "\$SITE_URL" --out packages\/client\/out/,
  );
  assert.match(body, /versions upload --tag "\$GITHUB_SHA"/);
  assert.ok(!/versions deploy/.test(body), "no activation in the build job");
  assert.ok(!/docker\/build-push-action/.test(body));
  assert.ok(body.indexOf("carry-static") < body.indexOf("versions upload"));
});

await test("workflow: server first, then the Worker switch, then /version.json", () => {
  const { text } = rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput);
  const lines = text.split("\n");
  const jobs = listJobs(lines);
  const deploy = jobs.find((j) => j.name === "deploy");
  const client = jobs.find((j) => j.name === "deploy-client");
  assert.ok(deploy && client);
  const deployBody = lines.slice(deploy.start, deploy.end).join("\n");
  assert.ok(!/deploy client COOLIFY_CLIENT_/.test(deployBody), "client webhook call removed");
  assert.match(deployBody, /HATCHKIT_WEB_URL: "" # client: checked by deploy-client/);
  assert.match(
    deployBody,
    /server_deployed: \$\{\{ steps\.server-deployed\.outputs\.deployed \}\}/,
  );
  // The step's `if:` sees only its own env, so it must carry the
  // COOLIFY_BASE_URL its gate reads (mood-magic's first run, 2026-10-18).
  assert.match(
    deployBody,
    /id: server-deployed\n {8}env:\n {10}COOLIFY_BASE_URL: \$\{\{ secrets\.COOLIFY_BASE_URL \}\}\n {8}if: env\.COOLIFY_BASE_URL != ''/,
  );
  const clientBody = lines.slice(client.start, client.end).join("\n");
  assert.match(clientBody, /needs: \[build-client, deploy\]/);
  assert.match(clientBody, /if: needs\.deploy\.outputs\.server_deployed == 'true'/);
  const wait = clientBody.indexOf("Wait for the server");
  const sw = clientBody.indexOf("versions deploy");
  const verify = clientBody.indexOf("/version.json");
  assert.ok(wait > 0 && sw > wait && verify > sw);
  assert.match(clientBody, /--name mood-client/);
});

await test("workflow: release-summary always runs and names the live half", () => {
  const { text } = rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput);
  const lines = text.split("\n");
  const job = listJobs(lines).find((j) => j.name === "release-summary");
  assert.ok(job);
  const body = lines.slice(job.start, job.end).join("\n");
  assert.match(body, /if: always\(\)/);
  assert.match(body, /needs: \[build-server, build-client, deploy, deploy-client\]/);
  assert.match(body, /Server \$GITHUB_SHA is LIVE\. The client is NOT/);
  assert.match(body, /The client was NOT switched: the previous Worker version still serves/);
});

await test("workflow: a rewrite from before the env fix is repaired in place", async () => {
  const { fixRecordStepEnv } = await import("./src/deploy/client-host-workflow.js");
  const good = rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput).text;
  const broken = good.replace(
    /(id: server-deployed\n) {8}env:\n {10}COOLIFY_BASE_URL: [^\n]+\n/,
    "$1",
  );
  assert.notEqual(broken, good);
  assert.equal(fixRecordStepEnv(broken), good);
  assert.equal(rewriteWorkflowForWorkerClient(broken, wfInput).text, good);
});

await test("workflow: second run is a no-op; a foreign workflow is refused", () => {
  const once = rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput).text;
  assert.equal(rewriteWorkflowForWorkerClient(once, wfInput).text, once);
  assert.throws(
    () =>
      rewriteWorkflowForWorkerClient(
        "name: x\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
        wfInput,
      ),
    /no `build-client` and `deploy` jobs/,
  );
});

await test("workflow: a literal API URL that disagrees with the manifest is refused", () => {
  const literal = STARTER_WORKFLOW.replace(
    "NEXT_PUBLIC_API_URL=${{ vars.NEXT_PUBLIC_API_URL }}",
    "NEXT_PUBLIC_API_URL=https://api.mood.example.com",
  );
  assert.throws(() => rewriteWorkflowForWorkerClient(literal, wfInput), /manifest's API origin/);
});

await test("workflow: actionlint accepts the rewrite", () => {
  const which = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.log("    (actionlint not installed — skipped)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "client-host-wf-"));
  const file = join(dir, "wf.yml");
  writeFileSync(file, rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput).text);
  const lint = spawnSync("actionlint", ["-shellcheck=", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});

// ---------------------------------------------------------------------------
// 5. Client scan and repo files
// ---------------------------------------------------------------------------

await test("redirects(): query-string target, trailing-slash source and target, 308", () => {
  // mood-magic's one redirect. Workers static assets' _redirects accepts
  // a query string in the target (checked in wrangler dev, 2026-10-15).
  assert.deepEqual(
    convertNextRedirects(
      '[{ source: "/ritual/:id", destination: "/ritual?id=:id", permanent: true }]',
      true,
    ),
    ["/ritual/:id/ /ritual/?id=:id 308", "/ritual/:id /ritual/?id=:id 308"],
  );
  assert.deepEqual(
    convertNextRedirects(
      '[{ source: "/old/:path*", destination: "/new/:path*", permanent: false }]',
      true,
    ),
    ["/old/* /new/:splat 307"],
  );
  assert.equal(
    convertNextRedirects('[{ source: "/a", destination: "/b", permanent: true, has: [] }]', true),
    null,
  );
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "client-host-proj-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const MOOD_NEXT_CONFIG = `const isExport = process.env.NEXT_FILE_EXPORT === "1";
const nextConfig = {
  ...(isExport ? { output: "export" as const } : { output: "standalone" as const }),
  ...(!isExport ? {
    async redirects() {
      return [{ source: "/ritual/:id", destination: "/ritual?id=:id", permanent: true }];
    },
  } : {}),
  trailingSlash: true,
};
export default nextConfig;
`;
const MOOD_DOCKERFILE = `FROM node:24 AS build
RUN pnpm --filter @mood/shared run build
RUN pnpm --filter @mood/client run build
`;

await test("scan: a mood-magic-shaped client exports cleanly", () => {
  const dir = project({
    ".nvmrc": "24\n",
    "packages/client/next.config.ts": MOOD_NEXT_CONFIG,
    "packages/client/Dockerfile": MOOD_DOCKERFILE,
    "packages/client/src/app/page.tsx": "export default function P() { return null; }",
    "packages/client/src/app/ritual/page.tsx": "export default function P() { return null; }",
  });
  const scan = scanClientProject(dir);
  assert.deepEqual(scan.blocking, []);
  assert.deepEqual(scan.buildCommands, [
    "pnpm --filter @mood/shared run build",
    "pnpm --filter @mood/client run build",
  ]);
  assert.equal(scan.nodeVersionFile, ".nvmrc");
  assert.deepEqual(scan.redirects, [
    "/ritual/:id/ /ritual/?id=:id 308",
    "/ritual/:id /ritual/?id=:id 308",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

await test("scan: what a static export cannot serve is named by file", () => {
  const dir = project({
    "packages/client/next.config.ts": `export default { output: "export", assetPrefix: "./", trailingSlash: true,
      async rewrites() { return [{ source: "/kestrel/k", destination: "https://plausible/api/event" }]; } };`,
    "packages/client/src/middleware.ts": "export function middleware() {}",
    "packages/client/src/app/kestrel/k/route.ts": "export async function POST() {}",
    "packages/client/src/app/feed.xml/route.ts":
      'export const dynamic = "force-static"; export function GET() {}',
    "packages/client/src/app/game/[id]/page.tsx": "export default function P() { return null; }",
  });
  const blocking = scanClientProject(dir).blocking.join("\n");
  assert.match(blocking, /middleware\.ts/);
  assert.match(blocking, /kestrel\/k\/route\.ts: a route handler/);
  assert.ok(!/feed\.xml/.test(blocking), "force-static route handlers export");
  assert.match(blocking, /game\/\[id\]\/page\.tsx: a dynamic segment/);
  assert.match(blocking, /relative assetPrefix/);
  assert.match(blocking, /rewrites\(\) \(\/kestrel\/k\)/);
  rmSync(dir, { recursive: true, force: true });
});

await test("scan: the starter's dev-only /api rewrite is fine", () => {
  const dir = project({
    "packages/client/next.config.ts": `export default { output: "export", trailingSlash: true,
      async rewrites() { return [{ source: "/api/:path*", destination: "http://127.0.0.1:5000/api/:path*" }]; } };`,
  });
  assert.ok(!scanClientProject(dir).blocking.some((b) => /rewrites/.test(b)));
  rmSync(dir, { recursive: true, force: true });
});

await test("repo files: wrangler, _headers, _redirects, carry script, workflow; idempotent", () => {
  const dir = project({
    ".nvmrc": "24\n",
    "packages/client/next.config.ts": MOOD_NEXT_CONFIG,
    "packages/client/Dockerfile": MOOD_DOCKERFILE,
    ".github/workflows/build-and-deploy.yml": STARTER_WORKFLOW,
  });
  const scan = scanClientProject(dir);
  const input = {
    worker: "mood-client",
    siteUrl: "https://mood.example.com",
    apiUrl: "https://mood.example.com",
    compatibilityDate: "2026-10-15",
  };
  const changes = writeClientRepoFiles(dir, input, scan);
  assert.equal(changes.length, 5, changes.join("\n"));
  const wrangler = readFileSync(join(dir, "wrangler.jsonc"), "utf-8");
  assert.match(wrangler, /"name": "mood-client"/);
  assert.match(wrangler, /"directory": "\.\/packages\/client\/out"/);
  assert.match(wrangler, /"not_found_handling": "404-page"/);
  assert.match(wrangler, /"workers_dev": false/);
  assert.deepEqual(
    findWranglerBillingKeys(wrangler),
    [],
    "comments mention the keys; no key is set",
  );
  const headers = readFileSync(join(dir, "packages/client/public/_headers"), "utf-8");
  assert.deepEqual(findImmutable404Rules(headers), []);
  assert.match(headers, /\/version\.json\n {2}Cache-Control: no-store/);
  assert.match(
    readFileSync(join(dir, "packages/client/public/_redirects"), "utf-8"),
    /^\/ritual\/:id \/ritual\/\?id=:id 308$/m,
  );
  assert.match(
    readFileSync(join(dir, "scripts/carry-static.mjs"), "utf-8"),
    /release-assets\.json/,
  );
  assert.match(
    readFileSync(join(dir, ".github/workflows/build-and-deploy.yml"), "utf-8"),
    /deploy-client:/,
  );
  assert.deepEqual(writeClientRepoFiles(dir, input, scan), []);
  assert.deepEqual(workerConfigFindings(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

await test("a new Worker's compatibility_date is two weeks back, not today", async () => {
  // wrangler 4.148's workerd refused a date two days newer than its own.
  const { defaultCompatibilityDate } = await import("./src/scaffold/worker-assets.js");
  assert.equal(defaultCompatibilityDate(new Date("2026-10-18T12:00:00Z")), "2026-10-04");
});

await test("config findings: billing keys and immutable 404 rules", () => {
  assert.deepEqual(
    findWranglerBillingKeys(
      '{ "main": "x.js", "assets": { "run_worker_first": true }, "cache": { "enabled": true }, "routes": [] }',
    ),
    ["main", "run_worker_first", "cache", "routes"],
  );
  assert.deepEqual(findWranglerBillingKeys('{ "name": "x" // "main": "y"\n}'), []);
  assert.deepEqual(
    findImmutable404Rules(
      "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n/images/*\n  Cache-Control: public, max-age=31536000\n",
    ),
    [{ pattern: "/_next/static/*", line: 1 }],
  );
  assert.deepEqual(findImmutable404Rules("/assets/*\n  Cache-Control: public, max-age=86400\n"), [
    { pattern: "/assets/*", line: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// 6. Cutover comparison, plan, CLI, sync
// ---------------------------------------------------------------------------

const before = {
  healthStatus: 200,
  healthVersion: "abc",
  signInStatus: 401,
  ws: "dropped",
  notFoundStatus: 404,
  notFoundPoweredBy: "Next.js",
  httpStatus: 302,
  httpLocation: "https://mood.example.com/",
};
const good = {
  ...before,
  notFoundPoweredBy: undefined,
  httpStatus: 301,
  versionCommit: "c0ffee",
  versionApiUrl: "https://mood.example.com",
};
const expectation = {
  commit: "c0ffee",
  apiUrl: "https://mood.example.com",
  siteUrl: "https://mood.example.com",
};

await test("cutover: passes when the API paths answer as before and the rest is the Worker", () => {
  assert.deepEqual(compareCutover(before, good, expectation), []);
});

await test("cutover: each regression is named", () => {
  const cases: Array<[Partial<typeof good>, RegExp]> = [
    [{ healthStatus: 404 }, /\/api\/health answered 404/],
    [{ signInStatus: 404 }, /sign-in origin probe answered 404/],
    [{ ws: "http 404" }, /\/api\/ws upgrade answered "http 404"/],
    [{ versionCommit: "old" }, /\/version\.json says old/],
    [{ versionApiUrl: "http://localhost:5000" }, /built against http:\/\/localhost:5000/],
    [{ notFoundStatus: 200 }, /unknown page answered 200/],
    [{ notFoundPoweredBy: "Next.js" }, /still came from Next\.js/],
    [{ httpStatus: 200, httpLocation: undefined }, /http:\/\/ answered 200/],
  ];
  for (const [change, pattern] of cases) {
    const failures = compareCutover(before, { ...good, ...change }, expectation);
    assert.equal(failures.length, 1, JSON.stringify(change));
    assert.match(failures[0], pattern);
  }
});

await test("plan: refuses a compose runtime and a static site, picks the Worker name", () => {
  const manifest = (extra: Record<string, unknown>) =>
    project({
      ".hatchkit.json": JSON.stringify({
        version: 5,
        name: "mood",
        domain: "mood.example.com",
        surfaces: "fullstack",
        deploymentMode: "coolify",
        topology: "single-origin",
        coolifyRuntime: "image",
        features: [],
        ...extra,
      }),
      "packages/client/next.config.ts": MOOD_NEXT_CONFIG,
    });
  const ok = manifest({});
  const plan = planClientMigration(ok);
  assert.deepEqual(plan.blocking, []);
  assert.equal(plan.worker, "mood-client");
  assert.equal(plan.apiUrl, "https://mood.example.com");
  writeFileSync(join(ok, "wrangler.jsonc"), '{\n  "name": "mood-web"\n}\n');
  assert.equal(planClientMigration(ok).worker, "mood-web", "wrangler.jsonc name wins");
  const compose = manifest({ coolifyRuntime: "compose" });
  // Reported, not thrown: --dry-run still prints the whole plan.
  assert.ok(planClientMigration(compose).blocking.some((b) => /migrate-runtime/.test(b)));
  const staticSite = manifest({ surfaces: "static" });
  assert.ok(planClientMigration(staticSite).blocking.some((b) => /hatchkit cloudflare/.test(b)));
  rmSync(staticSite, { recursive: true, force: true });
  for (const dir of [ok, compose]) rmSync(dir, { recursive: true, force: true });
});

await test("cleanup: deletes only what the guards cleared", async () => {
  const { planClientCleanup } = await import("./src/deploy/migrate-client.js");
  const base = {
    domain: "mood.example.com",
    worker: "mood-client",
    packageName: "mood-client",
    cutOverAt: "2026-10-18T11:18:00Z",
    now: new Date("2026-10-26T00:00:00Z"),
    secrets: ["COOLIFY_CLIENT_RESOURCE_UUID"],
    facts: {
      versionCommit: "542399b",
      manifestNewest: "542399bc4828",
      clientRoute: "mood-client",
      app: {
        uuid: "u1",
        name: "mood-client",
        fqdn: "https://mood.example.com",
        buildPack: "dockerimage",
      },
      packageExists: true,
    },
  };
  const ok = planClientCleanup(base);
  assert.deepEqual(ok.blocking, []);
  assert.deepEqual(ok.deleteApp, { uuid: "u1", name: "mood-client" });
  assert.equal(ok.deletePackage, "mood-client");
  assert.equal(planClientCleanup({ ...base, keepPackage: true }).deletePackage, undefined);

  const early = planClientCleanup({ ...base, now: new Date("2026-10-20T00:00:00Z") });
  assert.match(early.blocking.join(), /soak runs until 2026-10-25/);
  assert.deepEqual(
    planClientCleanup({ ...base, now: new Date("2026-10-20T00:00:00Z"), skipSoak: true }).blocking,
    [],
  );

  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ manifestNewest: "36d57b4" }, /not answered by the Worker/],
    [{ manifestNewest: undefined }, /not answered by the Worker/],
    [{ poweredBy: "Next.js" }, /still answered by Next\.js/],
    [{ clientRoute: undefined }, /points at nothing/],
    [{ clientRoute: "someone-else" }, /points at someone-else/],
    [
      {
        app: { uuid: "u1", name: "x", fqdn: "https://other.example.com", buildPack: "dockerimage" },
      },
      /no longer looks like this project's client/,
    ],
    [
      {
        app: {
          uuid: "u1",
          name: "x",
          fqdn: "https://mood.example.com/api",
          buildPack: "dockercompose",
        },
      },
      /no longer looks like/,
    ],
  ];
  for (const [change, pattern] of cases) {
    const plan = planClientCleanup({ ...base, facts: { ...base.facts, ...change } });
    assert.match(plan.blocking.join(" "), pattern, JSON.stringify(change));
  }
  // Already gone: nothing to delete there, and not a blocker.
  const gone = planClientCleanup({
    ...base,
    facts: { ...base.facts, app: null, packageExists: false },
  });
  assert.deepEqual(gone.blocking, []);
  assert.equal(gone.deleteApp, undefined);
  assert.equal(gone.deletePackage, undefined);
});

await test("CLI flags", () => {
  assert.deepEqual(
    parseMigrateClientArgs(
      ["--dry-run", "--origin-path", "/trpc", "--origin-path", "/socket.io"],
      "/p",
    ),
    {
      projectDir: "/p",
      action: "migrate",
      dryRun: true,
      repoOnly: false,
      yes: false,
      originPaths: ["/trpc", "/socket.io"],
    },
  );
  assert.equal(parseMigrateClientArgs(["--rollback"], "/p").action, "rollback");
  const c = parseMigrateClientArgs(
    ["--cleanup", "--skip-soak", "--keep-package", "--dry-run"],
    "/p",
  );
  assert.equal(c.action, "cleanup");
  assert.equal(c.skipSoak, true);
  assert.equal(c.keepPackage, true);
  assert.throws(() => parseMigrateClientArgs(["--rollback", "--cleanup"], "/p"), /separate/);
  assert.throws(() => parseMigrateClientArgs(["--force"], "/p"), /Unknown option --force/);
});

await test("cloudflare token: flags", async () => {
  const { parseCloudflareTokenArgs } = await import("./src/deploy/cloudflare.js");
  assert.deepEqual(parseCloudflareTokenArgs(["--worker", "conv3d-docs", "--dry-run"]), {
    worker: "conv3d-docs",
    createWorker: false,
    rotate: false,
    dryRun: true,
  });
  assert.throws(() => parseCloudflareTokenArgs(["--worker"]), /takes a Worker name/);
  assert.throws(() => parseCloudflareTokenArgs(["--yes"]), /Unknown argument --yes/);
});

await test("cloudflare https add: merges, reads back, and catches a lost host", async () => {
  const { getStore } = await import("./src/config.js");
  const { setSecret } = await import("./src/utils/secrets.js");
  const { runCloudflareHttps } = await import("./src/deploy/cloudflare.js");
  getStore().set("providers.cloudflareWorkers", { status: "configured", accountId: "acct" });
  await setSecret("cloudflare:provisioner", "fixture-token");
  let rules: CfRedirectRule[] = [
    { ...renderHttpsRedirectRule(["names.example.com"]), id: "h1" },
    { ...raptor },
  ];
  /** Simulates another session writing between our write and read-back. */
  let racer: (() => void) | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200,
      });
    if (url.pathname.endsWith("/zones") && method === "GET") {
      return ok(
        url.searchParams.get("name") === "example.com" ? [{ id: "zone", name: "example.com" }] : [],
      );
    }
    if (url.pathname.endsWith("/http_request_dynamic_redirect/entrypoint") && method === "GET") {
      return ok({ id: "rs", rules: structuredClone(rules) });
    }
    if (url.pathname.includes("/rulesets/rs/rules/") && method === "PATCH") {
      const id = url.pathname.split("/").pop();
      const body = JSON.parse(String(init?.body)) as CfRedirectRule;
      rules = rules.map((r) => (r.id === id ? { ...body, id } : r));
      racer?.();
      return ok({ id: "rs", rules });
    }
    return new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 0, message: `unexpected ${method} ${url.pathname}` }],
      }),
      { status: 500 },
    );
  }) as typeof globalThis.fetch;
  try {
    assert.equal(
      await runCloudflareHttps("add", ["sprites.example.com", "gamedev.example.com"], {
        dryRun: true,
      }),
      true,
    );
    assert.deepEqual(
      parseHttpsRuleHosts(rules[0]),
      ["names.example.com"],
      "dry run writes nothing",
    );
    assert.equal(
      await runCloudflareHttps("add", ["sprites.example.com", "gamedev.example.com"], {
        dryRun: false,
      }),
      true,
    );
    assert.deepEqual(parseHttpsRuleHosts(rules[0]), [
      "gamedev.example.com",
      "names.example.com",
      "sprites.example.com",
    ]);
    assert.equal(rules[1].id, "raptor", "the other rule is untouched");
    // Another session writes its own host list over ours right after our write.
    racer = () => {
      rules = rules.map((r) =>
        r.id === "h1"
          ? { ...renderHttpsRedirectRule(["names.example.com", "conv3d.example.com"]), id: "h1" }
          : r,
      );
      racer = null;
    };
    assert.equal(
      await runCloudflareHttps("add", ["chess.example.com"], { dryRun: false }),
      false,
      "lost hosts are reported",
    );
    assert.equal(
      await runCloudflareHttps("remove", ["conv3d.example.com"], { dryRun: false }),
      true,
    );
    assert.deepEqual(parseHttpsRuleHosts(rules[0]), ["names.example.com"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("sync: a project Coolify does not run is left alone", async () => {
  const { runSync } = await import("./src/deploy/sync.js");
  const dir = project({
    ".hatchkit.json": JSON.stringify({
      version: 5,
      name: "labs",
      domain: "labs.example.com",
      surfaces: "static",
      deploymentMode: "cloudflare",
      features: [],
    }),
  });
  const res = await runSync({ projectDir: dir, json: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.created, []);
  assert.deepEqual(res.apps, []);
  rmSync(dir, { recursive: true, force: true });
});

await test("dns publish: refuses a project Coolify does not run, before any network", async () => {
  const { runDnsPublish } = await import("./src/dns.js");
  const dir = project({
    ".hatchkit.json": JSON.stringify({
      version: 5,
      name: "labs",
      domain: "labs.example.com",
      surfaces: "static",
      deploymentMode: "cloudflare",
      features: [],
    }),
  });
  await assert.rejects(
    runDnsPublish({ projectDir: dir, dryRun: true } as never),
    /no Coolify server/,
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("sync: a client on Workers never adopts the project-named image app", async () => {
  const plan = computeRoutingPlan(base);
  const api = {
    async findApplicationByName(name: string) {
      return name === "mood" || name === "mood-server" ? { uuid: `u-${name}`, name } : null;
    },
    async getApplication(uuid: string) {
      return { uuid, buildPack: "dockerimage", portsExposes: "3000" } as never;
    },
  };
  const located = await locateSyncApps({
    api: api as never,
    projectName: "mood",
    topology: "single-origin",
    runtime: "image",
    routing: plan,
    projectApp: { appName: "mood" } as never,
    json: true,
  });
  assert.deepEqual(
    located.apps.map((a) => a.appName),
    ["mood-server"],
  );
  assert.equal(located.locations.get("mood-server")?.uuid, "u-mood-server");
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nclient-host: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
