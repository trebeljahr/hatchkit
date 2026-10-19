/**
 * `hatchkit create` and `hatchkit adopt` deliver the GlitchTip DSN to
 * production the way `hatchkit add … glitchtip` does: Coolify SENTRY_DSN
 * on the server app, and the NEXT_PUBLIC_SENTRY_DSN repo variable.
 * Before this, both flows dropped `runProvision`'s DSNs, so a new or
 * adopted project kept the EMPTY Coolify SENTRY_DSN its compose file
 * creates and had no repo variable.
 *
 * The properties these lock in:
 *   1. Order. create delivers after the GitHub repo and the Coolify apps
 *      exist and before the first push; adopt after its own Coolify
 *      wiring, inside its provisioning step.
 *   2. A create-shaped run fills the compose-created empty SENTRY_DSN and
 *      sets the repo variable, both read back, and does not tell the user
 *      to redeploy an app that has never booted. An adopt-shaped run does.
 *   3. A target left without the DSN becomes one follow-up whose command
 *      is `hatchkit add <project> glitchtip --adopt` and whose reason
 *      never holds the DSN (create persists it in .hatchkit.json). A
 *      later delivery that leaves nothing open clears it.
 *   4. A project deployed from a repo subdir is found through the
 *      manifest at the repo root; a parent manifest for another project
 *      is not used.
 *   5. Nothing throws out of the flow's delivery call, because a throw
 *      there reaches create's or adopt's rollback prompt.
 *
 * No real host is contacted: Coolify goes through a `fetch` override that
 * throws on anything unexpected, `gh` through a fake binary first on PATH.
 *
 * Run: `node scripts/test.mjs test-glitchtip-create-adopt.ts`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-glitchtip-create-adopt-${process.pid}`;

const { getStore } = await import("./src/config.js");
const { setSecret, clearAllSecrets, SECRET_KEYS } = await import("./src/utils/secrets.js");
const {
  DSN_DELIVERY_STEP_KEY,
  deliverProvisionedDsn,
  dsnDeliveryFollowUp,
  readGlitchtipDsnFromEnv,
} = await import("./src/provision/glitchtip-delivery.js");
const { writeProdEnv } = await import("./src/provision/write-env.js");
const { deferralForStep, persistDeferredSteps, readDeferredSteps } = await import(
  "./src/provision/deferrals.js"
);
const { writeManifest, MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const GT = "https://glitchtip.test";
const DSN = "https://newkey@glitchtip.test/8";
const CLIENT_DSN = "https://clientkey@glitchtip.test/9";
const COOLIFY = "https://coolify.test/api/v1";

getStore().set("providers.glitchtip", {
  status: "configured",
  url: GT,
  organizationSlug: "org",
  teamSlug: "team",
});
await setSecret(SECRET_KEYS.glitchtipToken, "gt-token-test");
getStore().set("providers.coolify", { status: "configured", url: "https://coolify.test" });
await setSecret(SECRET_KEYS.coolifyToken, "coolify-token-test");

// ── fetch: a Coolify with named apps and one env map per app ─────────

/** app name → env rows. A `null` value is a row the token can't read. */
let coolifyApps: Record<string, Record<string, string | null>> = {};
const coolifyWrites: Array<{ method: string; path: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (!url.startsWith(COOLIFY)) throw new Error(`test fetch: unexpected ${method} ${url}`);
  const path = url.slice(COOLIFY.length);
  if (method === "GET" && path === "/applications") {
    return json(Object.keys(coolifyApps).map((name) => ({ uuid: `uuid-${name}`, name })));
  }
  const m = /^\/applications\/uuid-([^/]+)\/envs(\/bulk)?$/.exec(path);
  const env = m ? coolifyApps[m[1]] : undefined;
  if (m && env) {
    if (method === "GET" && !m[2]) {
      return json(
        Object.entries(env).map(([key, value]) => ({
          key,
          ...(value === null ? {} : { value }),
          is_preview: false,
        })),
      );
    }
    if (method === "PATCH" && m[2]) {
      coolifyWrites.push({ method, path });
      for (const row of (body as { data: Array<{ key: string; value: string }> }).data) {
        env[row.key] = row.value;
      }
      return json({ ok: true });
    }
    if (method === "POST" && !m[2]) {
      coolifyWrites.push({ method, path });
      const row = body as { key: string; value: string };
      env[row.key] = row.value;
      return json({ uuid: "env-1" }, 201);
    }
  }
  throw new Error(`test fetch: unexpected ${method} ${url}`);
}) as typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── fake gh, first on PATH ───────────────────────────────────────────

const ghDir = mkdtempSync(join(tmpdir(), "fake-gh-create-adopt-"));
const ghLog = join(ghDir, "log");
const ghVars = join(ghDir, "vars.json");
const ghFailSet = join(ghDir, "fail-set");
writeFileSync(
  join(ghDir, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const vars = fs.existsSync(${JSON.stringify(ghVars)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(ghVars)}, "utf8")) : {};
fs.appendFileSync(${JSON.stringify(ghLog)}, "ARGV " + args.join(" ") + "\\n");
if (args[0] === "api") {
  const name = args[1].split("/").pop();
  if (!(name in vars)) { process.stderr.write("HTTP 404: Not Found"); process.exit(1); }
  process.stdout.write(JSON.stringify({ name, value: vars[name] }));
  process.exit(0);
}
if (args[0] === "variable" && args[1] === "set") {
  if (fs.existsSync(${JSON.stringify(ghFailSet)})) {
    process.stderr.write("HTTP 403: Resource not accessible by integration");
    process.exit(1);
  }
  vars[args[2]] = args[args.indexOf("--body") + 1];
  fs.writeFileSync(${JSON.stringify(ghVars)}, JSON.stringify(vars));
  process.exit(0);
}
process.stderr.write("fake gh: unexpected " + args.join(" "));
process.exit(2);
`,
);
chmodSync(join(ghDir, "gh"), 0o755);
const origPath = process.env.PATH;
process.env.PATH = `${ghDir}:${origPath ?? ""}`;

function resetGh(opts: { failSet?: boolean } = {}): void {
  writeFileSync(ghVars, "{}");
  if (existsSync(ghLog)) rmSync(ghLog);
  if (opts.failSet) writeFileSync(ghFailSet, "");
  else if (existsSync(ghFailSet)) rmSync(ghFailSet);
}
function ghVar(name: string): string | undefined {
  return (JSON.parse(readFileSync(ghVars, "utf-8")) as Record<string, string>)[name];
}

// ── project fixtures ─────────────────────────────────────────────────

const tmpDirs: string[] = [];

function writeProjectManifest(dir: string, name: string, extra: Record<string, unknown> = {}) {
  writeManifest(dir, {
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: new Date().toISOString(),
    name,
    domain: `${name}.example.com`,
    features: [],
    mlServices: [],
    s3Provider: "existing",
    deployTarget: "existing",
    deploymentMode: "coolify",
    surfaces: "fullstack",
    ports: { server: 3001, client: 3000 },
    ...extra,
  } as Parameters<typeof writeManifest>[1]);
}

/** A scaffolded project: manifest, a workflow that passes the repo
 *  variable into the build, and a git `origin` on GitHub. */
function makeProject(name: string, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `glitchtip-create-adopt-${name}-`));
  tmpDirs.push(dir);
  writeProjectManifest(dir, name, extra);
  writeWorkflow(dir, true);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/owner/${name}.git`);
  return dir;
}

function writeWorkflow(dir: string, readsVariable: boolean): void {
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "workflows", "build-and-deploy.yml"),
    readsVariable
      ? "env:\n  NEXT_PUBLIC_SENTRY_DSN: ${{ vars.NEXT_PUBLIC_SENTRY_DSN }}\n"
      : "on: push\n",
  );
}

async function deliver(
  projectDir: string,
  project: string,
  opts: { firstDeployPending?: boolean; client?: string | null } = {},
) {
  const lines: string[] = [];
  const result = await deliverProvisionedDsn({
    project,
    projectDir,
    server: DSN,
    client: opts.client === null ? undefined : (opts.client ?? DSN),
    write: true,
    firstDeployPending: opts.firstDeployPending,
    log: (l) => lines.push(l),
  });
  return { ...result, log: lines.join("\n") };
}

// ── 1. order in the flows ────────────────────────────────────────────

console.log("\n── 1. where create and adopt deliver ──");

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf("\nasync function ", start + signature.length);
  return source.slice(start, end < 0 ? undefined : end);
}

function assertOrder(body: string, needles: string[]): void {
  let last = -1;
  for (const needle of needles) {
    const at = body.indexOf(needle);
    assert.ok(at >= 0, `missing: ${needle}`);
    assert.ok(at > last, `out of order: ${needle}`);
    last = at;
  }
}

await check("create: after the repo and the Coolify apps, before the first push", () => {
  const body = bodyOf(
    readFileSync(join(HERE, "src/index.ts"), "utf-8"),
    "async function handleCreate(",
  );
  assertOrder(body, [
    "provisionedGlitchtip = provisionResult.glitchtip",
    "await setupGitHub(config, appDir)",
    "await runCoolifySetup(",
    "await setCoolifyDeploySecrets(",
    "await runCloudflareSetupProgrammatic(",
    "await deliverProvisionedDsn(",
    "await pushInitialBranch(appDir)",
  ]);
  assert.match(body, /firstDeployPending: true/);
  assert.match(body, /deferredSteps\.push\(deferralForStep\(followUp\)\)/);
});

await check("adopt: after its repo, Coolify wiring and provisioning", () => {
  const body = bodyOf(
    readFileSync(join(HERE, "src/adopt.ts"), "utf-8"),
    "async function executePlan(",
  );
  assertOrder(body, [
    "await setupGitHubRemote(state, plan)",
    "coolifyResult = await wireProjectIntoCoolify(",
    "const provisionResult = await runProvision(",
    "await deliverProvisionedDsn(",
  ]);
  assert.match(body, /caveats\.push\(\{\s*title: "GlitchTip DSN not delivered to production"/);
});

await check(
  "adopt --resume: a skipped GlitchTip is read from the env files, then delivered",
  () => {
    const body = bodyOf(
      readFileSync(join(HERE, "src/adopt.ts"), "utf-8"),
      "async function executePlan(",
    );
    assertOrder(body, [
      "const resumeServices = filterServicesForResume(",
      "if (resumeServices.length > 0) {",
      "provisionedGlitchtip = provisionResult.glitchtip;",
      '!resumeServices.includes("glitchtip")',
      "await readGlitchtipDsnFromEnv(",
      "await deliverProvisionedDsn(",
    ]);
    // Delivery sits after the block that only runs when something is left
    // to provision, so a resume that provisions nothing still delivers.
    const block = body.slice(body.indexOf("if (resumeServices.length > 0) {"));
    const closing = block.indexOf("provisionedGlitchtip = provisionResult.glitchtip;\n    }");
    assert.ok(closing > 0 && closing < block.indexOf("await deliverProvisionedDsn("));
  },
);

await check("add, create and adopt share the delivery call", () => {
  const index = readFileSync(join(HERE, "src/index.ts"), "utf-8");
  assert.match(bodyOf(index, "async function handleAdd("), /await deliverProvisionedDsn\(/);
  assert.doesNotMatch(index, /deliverGlitchtipDsn\(/);
});

// ── 2. a create-shaped and an adopt-shaped run ───────────────────────

console.log("\n── 2. delivery ──");

await check(
  "create: the compose-created empty SENTRY_DSN is filled, no redeploy line",
  async () => {
    const dir = makeProject("newapp");
    coolifyApps = { newapp: { SENTRY_DSN: "", PORT: "3001" } };
    coolifyWrites.length = 0;
    resetGh();
    const r = await deliver(dir, "newapp", { firstDeployPending: true });
    assert.equal(r.followUp, null);
    assert.deepEqual(
      r.outcomes.map((o) => `${o.target}:${o.where}:${o.status}`),
      ["coolify:newapp:updated", "gh-variable:owner/newapp:created"],
    );
    assert.equal(coolifyApps.newapp.SENTRY_DSN, DSN);
    assert.equal(coolifyApps.newapp.PORT, "3001");
    assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), DSN);
    assert.doesNotMatch(r.log, /redeploy/);
    assert.doesNotMatch(r.log, /No workflow in/);
    assert.ok(!r.log.includes(DSN), "the DSN is never logged");
  },
);

await check("adopt: the app has booted, so the user is told to redeploy", async () => {
  const dir = makeProject("oldapp");
  coolifyApps = { oldapp: { SENTRY_DSN: "" } };
  resetGh();
  const r = await deliver(dir, "oldapp");
  assert.equal(r.followUp, null);
  assert.match(r.log, /redeploy "oldapp"/);
});

// create's default runtime is `image`: one Coolify app per side, and the
// server is `<name>-server`, not the compose app `<name>`.
await check("image runtime: the -server app gets SENTRY_DSN, the -client app nothing", async () => {
  const dir = makeProject("imgapp", { coolifyRuntime: "image" });
  coolifyApps = { "imgapp-client": { PORT: "3000" }, "imgapp-server": { SENTRY_DSN: "" } };
  resetGh();
  const r = await deliver(dir, "imgapp", { firstDeployPending: true });
  assert.equal(r.followUp, null);
  assert.equal(coolifyApps["imgapp-server"].SENTRY_DSN, DSN);
  assert.equal(coolifyApps["imgapp-client"].SENTRY_DSN, undefined);
  assert.deepEqual(
    r.outcomes.filter((o) => o.target === "coolify").map((o) => o.where),
    ["imgapp-server"],
  );
});

await check("split: each side gets its own DSN", async () => {
  const dir = makeProject("twoapp");
  coolifyApps = { twoapp: {} };
  resetGh();
  const r = await deliver(dir, "twoapp", { client: CLIENT_DSN, firstDeployPending: true });
  assert.equal(r.followUp, null);
  assert.equal(coolifyApps.twoapp.SENTRY_DSN, DSN);
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), CLIENT_DSN);
});

// ── 3. what's left becomes one follow-up ─────────────────────────────

console.log("\n── 3. follow-up ──");

await check(
  "create --no-deploy: no server app yet → one skipped step, repo variable still set",
  async () => {
    const dir = makeProject("nodeploy");
    coolifyApps = {};
    resetGh();
    const r = await deliver(dir, "nodeploy", { firstDeployPending: true });
    assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), DSN);
    assert.ok(r.followUp);
    assert.equal(r.followUp.key, DSN_DELIVERY_STEP_KEY);
    assert.equal(r.followUp.kind, "declined");
    assert.equal(r.followUp.command, "hatchkit add nodeploy glitchtip --adopt");
    assert.equal(r.followUp.reason, 'Coolify SENTRY_DSN: no Coolify server app for "nodeploy" yet');
  },
);

await check("the persisted step holds no DSN; a later full delivery clears it", async () => {
  const dir = makeProject("repair");
  coolifyApps = {};
  resetGh({ failSet: true });
  const first = await deliver(dir, "repair", { firstDeployPending: true });
  assert.ok(first.followUp);
  assert.equal(first.followUp.kind, "failed");
  assert.match(first.followUp.reason, /^Coolify SENTRY_DSN: no Coolify server app/);
  assert.match(
    first.followUp.reason,
    /NEXT_PUBLIC_SENTRY_DSN repo variable: NEXT_PUBLIC_SENTRY_DSN on owner\/repair not confirmed: HTTP 403/,
  );
  // What create's end-of-run summary does with it.
  persistDeferredSteps(dir, [deferralForStep(first.followUp)]);
  const manifestText = readFileSync(join(dir, ".hatchkit.json"), "utf-8");
  assert.ok(manifestText.includes(DSN_DELIVERY_STEP_KEY));
  assert.ok(!manifestText.includes(DSN), "no DSN in .hatchkit.json");

  // `hatchkit add repair glitchtip --adopt`, once the app exists.
  coolifyApps = { repair: { SENTRY_DSN: "" } };
  resetGh();
  const second = await deliver(dir, "repair");
  assert.equal(second.followUp, null);
  assert.deepEqual(
    readDeferredSteps(dir).map((s) => s.key),
    [],
  );
});

await check("an unreadable Coolify value is a skipped step, not a write", async () => {
  const dir = makeProject("hidden");
  coolifyApps = { hidden: { SENTRY_DSN: null } };
  coolifyWrites.length = 0;
  resetGh();
  const r = await deliver(dir, "hidden", { client: null });
  assert.equal(coolifyWrites.length, 0);
  assert.equal(r.followUp?.kind, "declined");
  assert.match(r.followUp?.reason ?? "", /read:sensitive/);
});

await check("another tracker's DSN is kept and leaves nothing open", () => {
  assert.equal(
    dsnDeliveryFollowUp("p", [
      { target: "coolify", where: "p", key: "SENTRY_DSN", status: "kept" },
      { target: "gh-variable", where: "o/p", key: "NEXT_PUBLIC_SENTRY_DSN", status: "in-sync" },
    ]),
    null,
  );
});

await check("a delivery that throws is folded into a failed step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "glitchtip-create-adopt-broken-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, ".hatchkit.json"), "{ not json");
  const r = await deliver(dir, "broken");
  assert.deepEqual(r.outcomes, []);
  assert.equal(r.followUp?.kind, "failed");
  assert.match(r.followUp?.reason ?? "", /not valid JSON/);
  assert.equal(r.followUp?.command, "hatchkit add broken glitchtip --adopt");
});

// ── 4. a project deployed from a repo subdir ─────────────────────────

console.log("\n── 4. subdir projects ──");

await check("the manifest at the repo root is found from the subdir", async () => {
  const root = makeProject("mono", { projectSubdir: "site" });
  const site = join(root, "site");
  mkdirSync(site, { recursive: true });
  // The workflow that reads the variable is at the root; the subdir's
  // own one does not, and must not be what the check looks at.
  writeWorkflow(site, false);
  coolifyApps = { mono: { SENTRY_DSN: "" } };
  resetGh();
  const r = await deliver(site, "mono", { firstDeployPending: true });
  assert.equal(r.followUp, null);
  assert.equal(coolifyApps.mono.SENTRY_DSN, DSN);
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), DSN);
  assert.doesNotMatch(r.log, /No workflow in/);
});

await check("another project's manifest further up is not used", async () => {
  const root = makeProject("parent");
  const child = join(root, "child");
  mkdirSync(child, { recursive: true });
  coolifyApps = { parent: { SENTRY_DSN: "" } };
  coolifyWrites.length = 0;
  resetGh();
  const r = await deliver(child, "child", { client: null });
  assert.equal(coolifyWrites.length, 0);
  assert.equal(coolifyApps.parent.SENTRY_DSN, "");
  assert.match(r.followUp?.reason ?? "", /no \.hatchkit\.json to find the server app from/);
});

// ── 5. adopt --resume reads the DSN from .env.production ─────────────

console.log("\n── 5. adopt --resume ──");

const WRONG_HOST = "https://oldkey@glitchtip.example.com/8";
const SENTRY_IO = "https://abc@o1.ingest.sentry.io/42";

/** An adopted project whose GlitchTip names are already in its
 *  encrypted .env.production (so the resume filter skipped GlitchTip). */
function adoptedProject(name: string, env: Record<string, string>): string {
  const dir = makeProject(name);
  writeProdEnv(
    join(dir, ".env.production"),
    Object.entries(env).map(([key, value]) => ({ key, value })),
  );
  return dir;
}

function readEnvDsn(dir: string, name: string, extra: Record<string, unknown> = {}) {
  return readGlitchtipDsnFromEnv({
    project: name,
    projectDir: dir,
    serverEnvPath: join(dir, ".env.production"),
    clientEnvPath: join(dir, ".env.production"),
    glitchtipUrl: GT,
    ...extra,
  });
}

await check("the 2026-10-19 shape: SENTRY_DSN wins over an example.com GLITCHTIP_DSN", async () => {
  const dir = adoptedProject("resumed", {
    GLITCHTIP_DSN: WRONG_HOST,
    SENTRY_DSN: DSN,
    PUBLIC_GLITCHTIP_DSN: CLIENT_DSN,
  });
  const fromEnv = await readEnvDsn(dir, "resumed");
  assert.deepEqual(fromEnv, { server: DSN, client: CLIENT_DSN, problems: [] });
  // What adopt then does with it.
  coolifyApps = { resumed: { SENTRY_DSN: "" } };
  resetGh();
  const r = await deliverProvisionedDsn({
    project: "resumed",
    projectDir: dir,
    ...fromEnv,
    write: true,
    log: () => {},
  });
  assert.equal(r.followUp, null);
  assert.equal(coolifyApps.resumed.SENTRY_DSN, DSN);
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), CLIENT_DSN);
});

await check("two DSNs on this GlitchTip: the one the server reads wins", async () => {
  const dir = adoptedProject("tie", {
    GLITCHTIP_DSN: "https://oldkey@glitchtip.test/8",
    SENTRY_DSN: DSN,
  });
  const fromEnv = await readEnvDsn(dir, "tie", { clientEnvPath: null });
  assert.deepEqual(fromEnv, { server: DSN, problems: [] });
});

await check("only wrong-host DSNs: nothing to deliver, the problem names hosts only", async () => {
  const dir = adoptedProject("wronghost", {
    GLITCHTIP_DSN: WRONG_HOST,
    PUBLIC_GLITCHTIP_DSN: WRONG_HOST,
  });
  const fromEnv = await readEnvDsn(dir, "wronghost");
  assert.equal(fromEnv.server, undefined);
  assert.equal(fromEnv.client, undefined);
  assert.equal(fromEnv.problems.length, 2);
  assert.match(
    fromEnv.problems[0],
    /^GLITCHTIP_DSN in \.env\.production points at glitchtip\.example\.com, not glitchtip\.test/,
  );
  assert.ok(!fromEnv.problems.join(" ").includes("oldkey"), "no DSN in the problem");
});

await check("without a configured GlitchTip only hatchkit's own name counts", async () => {
  const dir = adoptedProject("nourl", { SENTRY_DSN: SENTRY_IO, GLITCHTIP_DSN: DSN });
  const fromEnv = await readEnvDsn(dir, "nourl", { glitchtipUrl: null, clientEnvPath: null });
  assert.deepEqual(fromEnv, { server: DSN, problems: [] });
});

await check("no .env.keys: the key comes from the keychain", async () => {
  const dir = adoptedProject("keychain", { GLITCHTIP_DSN: DSN });
  const keys = readFileSync(join(dir, ".env.keys"), "utf-8");
  const key = /DOTENV_PRIVATE_KEY_PRODUCTION="?([0-9a-f]+)/.exec(keys)?.[1];
  assert.ok(key);
  rmSync(join(dir, ".env.keys"));
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("keychain"), key);
  const fromEnv = await readEnvDsn(dir, "keychain", { clientEnvPath: null });
  assert.deepEqual(fromEnv, { server: DSN, problems: [] });
});

await check("no key anywhere: a problem, never the ciphertext", async () => {
  const dir = adoptedProject("nokey", { GLITCHTIP_DSN: DSN });
  rmSync(join(dir, ".env.keys"));
  const fromEnv = await readEnvDsn(dir, "nokey", { clientEnvPath: null });
  assert.equal(fromEnv.server, undefined);
  assert.deepEqual(fromEnv.problems, [
    "couldn't decrypt .env.production: no DOTENV_PRIVATE_KEY_PRODUCTION in .env.keys or the keychain",
  ]);
});

await check("a side without an env file is skipped quietly", async () => {
  const dir = makeProject("nofile");
  const fromEnv = await readEnvDsn(dir, "nofile");
  assert.deepEqual(fromEnv, { problems: [] });
});

// ── teardown ─────────────────────────────────────────────────────────

globalThis.fetch = realFetch;
process.env.PATH = origPath;
rmSync(ghDir, { recursive: true, force: true });
for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
await clearAllSecrets();

if (failures.length > 0) {
  console.log(`\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nAll GlitchTip create/adopt delivery checks passed.");
