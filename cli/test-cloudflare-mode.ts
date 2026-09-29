/**
 * The `cloudflare` deployment mode.
 *
 * Three things, in the order they'd break:
 *
 *   1. Scaffolding — a real `scaffoldApp` run with the mode set has to
 *      produce the four files the deploy needs, with the contents the
 *      fractal.garden migration proved necessary. Asserted against a
 *      scaffolded project, never against `starter/`: create SUBTRACTS
 *      from the starter, so only the output tells you what shipped.
 *   2. Config plumbing — the mode has to reach the manifest, be
 *      rejected on a non-static surface, and neuter the Coolify-shaped
 *      fields the way gh-pages does.
 *   3. The permission probe — doctor's verdict is only useful if a
 *      missing grant is distinguished from an empty-but-readable
 *      resource. A 404 must not read as a missing permission.
 *
 * Requires the `starter/` submodule. Exits 0 with a skip message when
 * it's missing, matching test-scaffold.ts.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "cf-mode-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
const DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cf-mode-dev-"));
process.env.HATCHKIT_DEV_CONFIG_DIR = DEV_CONFIG_DIR;

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

const { scaffoldApp } = await import("./src/scaffold/app.js");
const { applyCloudflareMode, renderDeployWorkflow } = await import(
  "./src/scaffold/cloudflare-mode.js"
);
const { isStaticHostMode } = await import("./src/prompts.js");
const { collectProjectConfig } = await import("./src/prompts.js");
const { readWorkerName } = await import("./src/deploy/cloudflare.js");
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

const results: Record<string, boolean> = {};

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      results[name] = true;
    } catch (err) {
      results[name] = false;
      console.log(`\n  x ${name}\n    ${(err as Error).message}\n`);
    }
  })();
}

function cfg(name: string, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name,
    domain: `${name}.example.com`,
    baseDomain: "example.com",
    subdomain: name,
    surfaces: "static",
    deploymentMode: "cloudflare",
    deployTarget: "existing",
    serverId: 1,
    serverIp: "1.2.3.4",
    features: [],
    provisionServices: [],
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
    mongodbProvider: "external",
    ...overrides,
  } as unknown as ProjectConfig;
}

// ---------------------------------------------------------------------------
// 1. Scaffolding — against a real scaffolded project
// ---------------------------------------------------------------------------

const scaffoldDir = mkdtempSync(join(tmpdir(), "cf-mode-scaffold-"));
await scaffoldApp(cfg("cf-static"), scaffoldDir);
const read = (rel: string) => readFileSync(join(scaffoldDir, rel), "utf-8");

await test("wrangler.jsonc points assets at the client's export dir", () => {
  const w = read("wrangler.jsonc");
  assert.match(w, /"name":\s*"cf-static"/);
  assert.match(w, /"directory":\s*"\.\/packages\/client\/out"/);
});

await test("wrangler.jsonc sets not_found_handling to 404-page", () => {
  // An SPA fallback would serve index.html with a 200 for every unknown
  // path, which makes every typo look like a real page to crawlers.
  assert.match(read("wrangler.jsonc"), /"not_found_handling":\s*"404-page"/);
});

await test("wrangler.jsonc sets workers_dev explicitly", () => {
  // The trap from the migration: adding a `routes` entry later silently
  // disables the *.workers.dev preview URL unless this is present, and
  // nothing in the deploy output says so.
  assert.match(read("wrangler.jsonc"), /"workers_dev":\s*true/);
});

await test(".node-version is written", () => {
  assert.match(read(".node-version"), /^\d+\s*$/);
});

await test("_headers caches hashed build output immutably", () => {
  const h = read("packages/client/public/_headers");
  assert.match(h, /\/_next\/static\/\*/);
  assert.match(h, /max-age=31536000, immutable/);
});

await test("deploy workflow uses wrangler-action and reads the secrets", () => {
  const wf = read(".github/workflows/deploy.yml");
  assert.match(wf, /cloudflare\/wrangler-action@v4/);
  assert.match(wf, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(wf, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
});

await test("deploy workflow clones full history", () => {
  // Shallow clones stamp every file's mtime with the checkout time,
  // which silently breaks mtime-derived sitemap lastmod values.
  assert.match(read(".github/workflows/deploy.yml"), /fetch-depth:\s*0/);
});

await test("deploy workflow pins node from .node-version", () => {
  assert.match(read(".github/workflows/deploy.yml"), /node-version-file:\s*\.node-version/);
});

await test("next.config static-exports without an assetPrefix", () => {
  // A relative assetPrefix resolves /_next/* against the current path,
  // so every nested route 404s its own chunks over HTTP. Matched as a
  // property, not a substring — the surrounding comment says the word.
  const nc = read("packages/client/next.config.ts");
  assert.match(nc, /output:\s*"export"/);
  assert.ok(!/^\s*assetPrefix\s*:/m.test(nc), "expected no assetPrefix property");
});

await test("next.config carries no NEXT_PUBLIC_API_URL guard", () => {
  // There is no API in this mode. The native-shell config's guard would
  // fail every build instead of catching a real misconfiguration.
  assert.ok(
    !/process\.env\.NEXT_PUBLIC_API_URL/.test(read("packages/client/next.config.ts")),
    "expected the API-URL guard to be absent for a serverless static site",
  );
});

await test("_headers keeps version.json uncacheable", () => {
  // next.config's headers() block is ignored under `output: "export"`,
  // so the rule has to live here or a tab that outlived a deploy gets a
  // cached version.json naming the commit it already has.
  const h = read("packages/client/public/_headers");
  assert.match(h, /\/version\.json/);
  assert.match(h, /no-store, must-revalidate/);
});

await test("the Coolify image workflow is removed", () => {
  // It builds a Docker image nothing consumes, from a server package the
  // static prune already deleted — it would fail on every push.
  assert.ok(!existsSync(join(scaffoldDir, ".github/workflows/build-and-deploy.yml")));
});

await test("manifest records deploymentMode=cloudflare", () => {
  const m = JSON.parse(read(".hatchkit.json"));
  assert.equal(m.deploymentMode, "cloudflare");
  assert.equal(m.surfaces, "static");
});

await test("readWorkerName round-trips the scaffolded wrangler.jsonc", () => {
  assert.equal(readWorkerName(scaffoldDir), "cf-static");
});

await test("applyCloudflareMode is idempotent", () => {
  // `hatchkit cloudflare` re-runs it against an already-converted repo.
  const before = read("wrangler.jsonc");
  const mods: string[] = [];
  applyCloudflareMode(scaffoldDir, { workerName: "renamed-by-mistake" }, mods);
  assert.equal(read("wrangler.jsonc"), before, "a re-run must not rewrite wrangler.jsonc");
});

rmSync(scaffoldDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 2. Config plumbing
// ---------------------------------------------------------------------------

await test("cloudflare counts as a static-host mode", () => {
  assert.equal(isStaticHostMode("cloudflare"), true);
  assert.equal(isStaticHostMode("gh-pages"), true);
  assert.equal(isStaticHostMode("coolify"), false);
  assert.equal(isStaticHostMode("scaffold-only"), false);
});

await test("cloudflare on a non-static surface is rejected", async () => {
  let message: string | undefined;
  try {
    await collectProjectConfig({
      presets: {
        name: "api",
        domain: "api.example.com",
        surfaces: "fullstack" as const,
        deploymentMode: "cloudflare" as const,
      },
      nonInteractive: true,
      dryRun: true,
    });
  } catch (err) {
    message = (err as Error).message;
  }
  assert.ok(message !== undefined, "expected a rejection");
  assert.match(message, /requires --surfaces static/);
});

await test("a static cloudflare plan drops the server-only email providers", async () => {
  const config = await collectProjectConfig({
    presets: {
      name: "cf-plan",
      domain: "cf-plan.example.com",
      surfaces: "static" as const,
      deploymentMode: "cloudflare" as const,
    },
    nonInteractive: true,
    dryRun: true,
  });
  assert.equal(config.deploymentMode, "cloudflare");
  assert.ok(!config.provisionServices.includes("listmonk-ses"));
  assert.equal(config.dbProvider, "external");
});

await test("the workflow renderer honours a non-main default branch", () => {
  assert.match(renderDeployWorkflow("trunk"), /branches: \[trunk\]/);
});

// ---------------------------------------------------------------------------
// 3. Permission probe
// ---------------------------------------------------------------------------

const { CloudflareApi } = await import("./src/utils/cloudflare-api.js");

/** Drive `probeProvisionerPermissions` against a stubbed fetch so the
 *  pass/fail classification is testable without a live token. */
async function probeWith(
  responder: (url: string) => { status: number; body: unknown },
): Promise<Array<{ permission: string; ok: boolean }>> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = responder(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    const api = new CloudflareApi({ token: "t", accountId: "acct" });
    return await api.probeProvisionerPermissions({ accountId: "acct", zoneId: "zone" });
  } finally {
    globalThis.fetch = realFetch;
  }
}

const OK = { status: 200, body: { success: true, errors: [], messages: [], result: [] } };
const DENIED = {
  status: 403,
  body: {
    success: false,
    errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
    messages: [],
    result: null,
  },
};
const ABSENT = {
  status: 404,
  body: {
    success: false,
    errors: [{ code: 1001, message: "not found" }],
    messages: [],
    result: null,
  },
};

await test("probe reports all four permissions when a zone is known", async () => {
  const probes = await probeWith(() => OK);
  assert.equal(probes.length, 4);
  assert.ok(probes.every((p) => p.ok));
  assert.deepEqual(
    probes.map((p) => p.permission),
    [
      "Account → Account API Tokens → Edit",
      "Account → Workers → Admin (read preflight)",
      "Zone → Workers Routes → Edit",
      "Zone → DNS → Edit",
    ],
  );
});

await test("probe flags a denied permission", async () => {
  const probes = await probeWith((url) => (url.includes("dns_records") ? DENIED : OK));
  const failed = probes.filter((p) => !p.ok).map((p) => p.permission);
  assert.deepEqual(failed, ["Zone → DNS → Edit"]);
});

await test("probe reports every missing grant, not just the first", async () => {
  const probes = await probeWith((url) =>
    url.includes("dns_records") || url.includes("workers/routes") ? DENIED : OK,
  );
  assert.equal(probes.filter((p) => !p.ok).length, 2);
});

await test("a 404 is a pass, not a missing permission", async () => {
  // An account without a workers.dev subdomain may return 404.
  const probes = await probeWith((url) =>
    url.includes("workers/subdomain") ? ABSENT : OK,
  );
  assert.ok(probes.every((p) => p.ok));
});

await test("probe skips the zone-scoped grants when no zone is known", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(OK.body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  try {
    const api = new CloudflareApi({ token: "t", accountId: "acct" });
    const probes = await api.probeProvisionerPermissions({ accountId: "acct" });
    assert.equal(probes.length, 2);
    assert.equal(probes[0].permission, "Account → Account API Tokens → Edit");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------

{
  const { clearAllSecrets } = await import("./src/utils/secrets.js");
  await clearAllSecrets();
}
rmSync(process.env.HATCHKIT_CONF_DIR, { recursive: true, force: true });
rmSync(DEV_CONFIG_DIR, { recursive: true, force: true });

console.log("\n=== SUMMARY (cloudflare mode) ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
