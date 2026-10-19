/**
 * GlitchTip DSNs reaching the app that reads them — the gaps found while
 * wiring six projects on 2026-10-19, every one of which had to bypass
 * `hatchkit add glitchtip`.
 *
 * The properties these lock in:
 *   1. `add` writes the names the starter reads: SENTRY_DSN on the server,
 *      NEXT_PUBLIC_SENTRY_DSN on the client, beside the GLITCHTIP_* names.
 *   2. A DSN whose host is not the configured GlitchTip URL is refused
 *      (the server's GLITCHTIP_DOMAIN was https://glitchtip.example.com).
 *   3. Delivery: Coolify SENTRY_DSN is created, or replaced when empty, a
 *      placeholder or a superseded GlitchTip DSN, and read back. Another
 *      tracker's DSN and an unreadable value are left alone. The repo
 *      variable is set with `gh variable set`; `--no-write` prints the
 *      exact command and changes nothing.
 *   4. Rotation covers SENTRY_DSN, a Coolify SENTRY_DSN and the repo
 *      variable, and never touches a SENTRY_DSN that isn't GlitchTip's.
 *   5. doctor fails when the DSN host differs from the configured URL,
 *      and warns about Coolify apps whose SENTRY_DSN is set but empty.
 *
 * No real host is contacted: GlitchTip and Coolify go through a `fetch`
 * override that throws on anything unexpected, `gh` through a fake binary
 * first on PATH.
 *
 * Run: `node scripts/test.mjs test-glitchtip-env.ts`.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-glitchtip-env-${process.pid}`;

const { getStore } = await import("./src/config.js");
const { setSecret, clearAllSecrets, SECRET_KEYS } = await import("./src/utils/secrets.js");
const {
  GLITCHTIP_CLIENT_ENV_KEYS,
  GLITCHTIP_SERVER_ENV_KEYS,
  adoptGlitchtipClient,
  dsnHostMismatch,
  glitchtipPlatformFor,
  packageUsesNext,
  provisionGlitchtipClient,
  renderGlitchtipEnv,
} = await import("./src/provision/glitchtip.js");
const { decideDsnWrite, deliverGlitchtipDsn, ghVariableSetCommand } = await import(
  "./src/provision/glitchtip-delivery.js"
);
const { ERROR_REPORTING_DSN_VAR } = await import("./src/features/error-reporting/render.js");
const { checkCoolifyEmptySentryDsn, checkGlitchtipWith } = await import("./src/doctor.js");
const { runSecretsRotate } = await import("./src/secrets/orchestrator.js");
const { writeManifest, MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");
const { writeProdEnv } = await import("./src/provision/write-env.js");
const { loadProjectEnv } = await import("./src/assets/env.js");

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
const OLD_DSN = "https://oldkey@glitchtip.test/8";
const NEW_DSN = "https://newkey@glitchtip.test/8";
const WRONG_DSN = "https://oldkey@glitchtip.example.com/8";
const SENTRY_IO = "https://abc@o1.ingest.sentry.io/42";

getStore().set("providers.glitchtip", {
  status: "configured",
  url: GT,
  organizationSlug: "org",
  teamSlug: "team",
});
await setSecret(SECRET_KEYS.glitchtipToken, "gt-token-test");
const glitchtipCfg = {
  status: "configured" as const,
  url: GT,
  organizationSlug: "org",
  teamSlug: "team",
  token: "t",
};

// ── fetch: GlitchTip + Coolify fakes, nothing else ───────────────────

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
const calls: Call[] = [];
type Route = (method: string, url: string, body: unknown) => Response | undefined;
let route: Route = () => undefined;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const res = route(method, url, body);
  if (!res) throw new Error(`test fetch: unexpected ${method} ${url}`);
  return res;
}) as typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── fake gh, first on PATH ───────────────────────────────────────────

const ghDir = mkdtempSync(join(tmpdir(), "fake-gh-glitchtip-"));
const ghLog = join(ghDir, "log");
const ghVars = join(ghDir, "vars.json");
writeFileSync(
  join(ghDir, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const vars = fs.existsSync(${JSON.stringify(ghVars)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(ghVars)}, "utf8")) : {};
const save = () => fs.writeFileSync(${JSON.stringify(ghVars)}, JSON.stringify(vars));
const stdin = process.stdin.isTTY ? "" : (() => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } })();
fs.appendFileSync(${JSON.stringify(ghLog)}, "ARGV " + args.join(" ") + (stdin ? " STDIN " + stdin : "") + "\\n");
if (args[0] === "api") {
  const name = args[1].split("/").pop();
  if (!(name in vars)) { process.stderr.write("HTTP 404: Not Found"); process.exit(1); }
  process.stdout.write(JSON.stringify({ name, value: vars[name] }));
  process.exit(0);
}
if (args[0] === "variable" && args[1] === "list") {
  process.stdout.write(JSON.stringify(Object.entries(vars).map(([name, value]) => ({ name, value }))));
  process.exit(0);
}
if (args[0] === "variable" && args[1] === "set") {
  const i = args.indexOf("--body");
  vars[args[2]] = i >= 0 ? args[i + 1] : stdin;
  save();
  process.exit(0);
}
if (args[0] === "secret" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }
process.stderr.write("fake gh: unexpected " + args.join(" "));
process.exit(2);
`,
);
chmodSync(join(ghDir, "gh"), 0o755);
const origPath = process.env.PATH;
process.env.PATH = `${ghDir}:${origPath ?? ""}`;

function resetGh(vars: Record<string, string> = {}): void {
  writeFileSync(ghVars, JSON.stringify(vars));
  if (existsSync(ghLog)) rmSync(ghLog);
}
function ghLines(): string[] {
  return existsSync(ghLog) ? readFileSync(ghLog, "utf-8").trim().split("\n") : [];
}
function ghVar(name: string): string | undefined {
  return (JSON.parse(readFileSync(ghVars, "utf-8")) as Record<string, string>)[name];
}

// ── project fixtures ─────────────────────────────────────────────────

function makeProject(
  name: string,
  env: Record<string, string>,
  extra: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), `glitchtip-env-${name}-`));
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
    ports: { server: 3001, client: 3000 },
    ...extra,
  } as Parameters<typeof writeManifest>[1]);
  if (Object.keys(env).length > 0) {
    writeProdEnv(
      join(dir, ".env.production"),
      Object.entries(env).map(([key, value]) => ({ key, value })),
    );
  }
  return dir;
}

/** A Coolify API stand-in holding one env map per app uuid. */
function fakeCoolify(initial: Record<string, string | null | undefined> = {}) {
  const env = new Map<string, string | undefined>(
    Object.entries(initial).map(([k, v]) => [k, v ?? undefined]),
  );
  const writes: Array<Record<string, string>> = [];
  let bulkCreates = true;
  return {
    env,
    writes,
    dropBulkCreates() {
      bulkCreates = false;
    },
    api: {
      findApplicationByName: async (name: string) => ({ uuid: "srv-uuid", name }),
      listAppEnvRows: async () =>
        [...env.entries()].map(([key, value]) => ({ key, value, isPreview: false })),
      setAppEnv: async (_uuid: string, envs: Record<string, string>) => {
        writes.push(envs);
        for (const [k, v] of Object.entries(envs)) {
          if (env.has(k) || bulkCreates) env.set(k, v);
        }
      },
      createAppEnv: async (_uuid: string, key: string, value: string) => {
        writes.push({ [key]: value });
        env.set(key, value);
      },
    },
  };
}

const quiet = () => {};

// ── 1. names ─────────────────────────────────────────────────────────

console.log("\n── 1. env names ──");
await check("server lines carry GLITCHTIP_DSN and SENTRY_DSN", () => {
  assert.deepEqual(renderGlitchtipEnv({ projectSlug: "p", dsn: NEW_DSN }, false), [
    `GLITCHTIP_DSN=${NEW_DSN}`,
    `SENTRY_DSN=${NEW_DSN}`,
  ]);
});
await check("client lines carry PUBLIC_GLITCHTIP_DSN and NEXT_PUBLIC_SENTRY_DSN", () => {
  assert.deepEqual(renderGlitchtipEnv({ projectSlug: "p", dsn: NEW_DSN }, true), [
    `PUBLIC_GLITCHTIP_DSN=${NEW_DSN}`,
    `NEXT_PUBLIC_SENTRY_DSN=${NEW_DSN}`,
  ]);
});
await check("the starter's server reads a name add writes", () => {
  const envTs = readFileSync(join(HERE, "../starter/packages/server/src/config/env.ts"), "utf-8");
  const instrument = readFileSync(
    join(HERE, "../starter/packages/server/src/instrument.ts"),
    "utf-8",
  );
  const read = GLITCHTIP_SERVER_ENV_KEYS.filter(
    (k) => envTs.includes(`"${k}"`) && instrument.includes(`process.env.${k}`),
  );
  assert.deepEqual(read, ["SENTRY_DSN"]);
});
await check("the client build variable is among the client names", () => {
  assert.ok((GLITCHTIP_CLIENT_ENV_KEYS as readonly string[]).includes(ERROR_REPORTING_DSN_VAR));
  const workflow = readFileSync(
    join(HERE, "../starter/.github/workflows/build-and-deploy.yml"),
    "utf-8",
  );
  assert.match(workflow, new RegExp(`vars\\.${ERROR_REPORTING_DSN_VAR}`));
});

// ── 2. DSN host ──────────────────────────────────────────────────────

console.log("\n── 2. DSN host ──");
await check("same host is no mismatch", () => {
  assert.equal(dsnHostMismatch(NEW_DSN, `${GT}/`), undefined);
  assert.equal(dsnHostMismatch("https://k@GlitchTip.Test/3", GT), undefined);
});
await check("the 2026-10-19 example.com DSN is a mismatch", () => {
  assert.deepEqual(dsnHostMismatch(WRONG_DSN, GT), {
    dsnHost: "glitchtip.example.com",
    configuredHost: "glitchtip.test",
  });
});
await check("a different port is a mismatch; garbage is not judged", () => {
  assert.ok(dsnHostMismatch("https://k@glitchtip.test:8443/1", GT));
  assert.equal(dsnHostMismatch("not a url", GT), undefined);
});

function glitchtipRoutes(keyDsn: string): Route {
  return (method, url) => {
    if (method === "POST" && url === `${GT}/api/0/teams/org/team/projects/`) {
      return json({ slug: "newproj" }, 201);
    }
    if (method === "GET" && /\/api\/0\/projects\/org\/[^/]+\/keys\/$/.test(url)) {
      return json([{ id: "k1", public: "oldkey", dsn: { public: keyDsn } }]);
    }
    return undefined;
  };
}

await check("provisionGlitchtipClient refuses a DSN on another host", async () => {
  route = glitchtipRoutes(WRONG_DSN);
  await assert.rejects(provisionGlitchtipClient("newproj"), (err: Error) => {
    assert.match(err.message, /GLITCHTIP_DOMAIN=https:\/\/glitchtip\.test/);
    assert.match(err.message, /glitchtip\.example\.com/);
    assert.match(err.message, /--adopt \(project 'newproj' exists\)/);
    return true;
  });
});
await check("adoptGlitchtipClient refuses it too", async () => {
  route = glitchtipRoutes(WRONG_DSN);
  await assert.rejects(adoptGlitchtipClient("oldproj"), /GLITCHTIP_DOMAIN/);
});
await check("a DSN on the configured host passes", async () => {
  route = glitchtipRoutes(NEW_DSN);
  assert.deepEqual(await provisionGlitchtipClient("newproj"), {
    projectSlug: "newproj",
    dsn: NEW_DSN,
  });
});

// conv3d (browser-only) was created as javascript-node like every project.
console.log("\n── 2b. project platform ──");
await check("javascript-node only where a server reports", () => {
  assert.equal(glitchtipPlatformFor("server", true), "javascript-node");
  assert.equal(glitchtipPlatformFor("shared", true), "javascript-node");
  assert.equal(glitchtipPlatformFor("client", true), "javascript-nextjs");
  assert.equal(glitchtipPlatformFor("client", false), "javascript-browser");
});
await check("the create call carries the platform it was given", async () => {
  route = glitchtipRoutes(NEW_DSN);
  calls.length = 0;
  await provisionGlitchtipClient("newproj", "javascript-browser");
  const create = calls.find((c) => c.method === "POST");
  assert.equal((create?.body as { platform?: string })?.platform, "javascript-browser");
});
await check("packageUsesNext reads the first package.json found", () => {
  const next = mkdtempSync(join(tmpdir(), "pkg-next-"));
  const vite = mkdtempSync(join(tmpdir(), "pkg-vite-"));
  writeFileSync(join(next, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  writeFileSync(join(vite, "package.json"), JSON.stringify({ devDependencies: { vite: "7" } }));
  assert.equal(packageUsesNext([undefined, join(next, "missing"), next]), true);
  assert.equal(packageUsesNext([vite, next]), false);
  assert.equal(packageUsesNext([]), false);
  rmSync(next, { recursive: true, force: true });
  rmSync(vite, { recursive: true, force: true });
});

// ── 3. delivery ──────────────────────────────────────────────────────

console.log("\n── 3. delivery ──");
await check("decideDsnWrite", () => {
  assert.equal(decideDsnWrite({ kind: "absent" }, NEW_DSN, GT), "create");
  assert.equal(decideDsnWrite({ kind: "hidden" }, NEW_DSN, GT), "unreadable");
  assert.equal(decideDsnWrite({ kind: "value", value: NEW_DSN }, NEW_DSN, GT), "in-sync");
  assert.equal(decideDsnWrite({ kind: "value", value: " " }, NEW_DSN, GT), "replace");
  assert.equal(
    decideDsnWrite({ kind: "value", value: "CHANGE_ME_SENTRY_DSN" }, NEW_DSN, GT),
    "replace",
  );
  assert.equal(decideDsnWrite({ kind: "value", value: OLD_DSN }, NEW_DSN, GT), "replace");
  assert.equal(decideDsnWrite({ kind: "value", value: SENTRY_IO }, NEW_DSN, GT), "keep");
  assert.equal(decideDsnWrite({ kind: "value", value: WRONG_DSN }, NEW_DSN, GT), "keep");
  // The same key, rendered while GLITCHTIP_DOMAIN was example.com.
  assert.equal(decideDsnWrite({ kind: "value", value: WRONG_DSN }, OLD_DSN, GT), "replace");
  assert.equal(decideDsnWrite({ kind: "value", value: OLD_DSN }, NEW_DSN), "keep");
});

const fullstack = makeProject("deliverproj", {});

async function deliverServer(coolify: ReturnType<typeof fakeCoolify>, write = true) {
  const lines: string[] = [];
  const out = await deliverGlitchtipDsn({
    projectDir: fullstack,
    server: NEW_DSN,
    write,
    api: coolify.api,
    glitchtipUrl: GT,
    log: (l) => lines.push(l),
  });
  return { out, lines: lines.join("\n") };
}

await check("absent SENTRY_DSN is created and read back", async () => {
  const c = fakeCoolify({ PORT: "3001" });
  const { out } = await deliverServer(c);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "created");
  assert.equal(c.env.get("SENTRY_DSN"), NEW_DSN);
});
await check("the compose-created empty SENTRY_DSN is replaced", async () => {
  const c = fakeCoolify({ SENTRY_DSN: "" });
  const { out, lines } = await deliverServer(c);
  assert.equal(out[0].status, "updated");
  assert.equal(c.env.get("SENTRY_DSN"), NEW_DSN);
  assert.match(lines, /redeploy/);
  assert.ok(!lines.includes(NEW_DSN), "the DSN is never logged");
});
await check("a superseded DSN on the same GlitchTip is replaced", async () => {
  const c = fakeCoolify({ SENTRY_DSN: OLD_DSN });
  assert.equal((await deliverServer(c)).out[0].status, "updated");
});
await check("an equal value is left alone", async () => {
  const c = fakeCoolify({ SENTRY_DSN: NEW_DSN });
  assert.equal((await deliverServer(c)).out[0].status, "in-sync");
  assert.equal(c.writes.length, 0);
});
await check("another tracker's DSN is kept", async () => {
  const c = fakeCoolify({ SENTRY_DSN: SENTRY_IO });
  const { out } = await deliverServer(c);
  assert.equal(out[0].status, "kept");
  assert.match(out[0].detail ?? "", /sentry\.io/);
  assert.equal(c.env.get("SENTRY_DSN"), SENTRY_IO);
  assert.equal(c.writes.length, 0);
});
await check("a value the token can't read is not overwritten", async () => {
  const c = fakeCoolify({ SENTRY_DSN: undefined });
  const { out } = await deliverServer(c);
  assert.equal(out[0].status, "unreadable");
  assert.equal(c.writes.length, 0);
});
await check("a bulk PATCH that created nothing falls back to POST", async () => {
  const c = fakeCoolify({});
  c.dropBulkCreates();
  assert.equal((await deliverServer(c)).out[0].status, "created");
  assert.equal(c.env.get("SENTRY_DSN"), NEW_DSN);
  assert.equal(c.writes.length, 2);
});
await check("--no-write writes nothing to Coolify", async () => {
  const c = fakeCoolify({ SENTRY_DSN: "" });
  const { out } = await deliverServer(c, false);
  assert.equal(out[0].status, "would-write");
  assert.equal(c.env.get("SENTRY_DSN"), "");
});
await check("a static project has no server app to write", async () => {
  const dir = makeProject("staticproj", {}, { surfaces: "static" });
  const c = fakeCoolify({});
  const out = await deliverGlitchtipDsn({
    projectDir: dir,
    server: NEW_DSN,
    write: true,
    api: c.api,
    glitchtipUrl: GT,
    log: quiet,
  });
  assert.deepEqual(out, []);
  rmSync(dir, { recursive: true, force: true });
});

async function deliverClient(write: boolean, repoSlug: string | null = "owner/repo") {
  const lines: string[] = [];
  const out = await deliverGlitchtipDsn({
    projectDir: fullstack,
    client: NEW_DSN,
    write,
    api: null,
    glitchtipUrl: GT,
    repoSlug,
    log: (l) => lines.push(l),
  });
  return { out: out[0], lines: lines.join("\n") };
}

await check("the repo variable is set with gh variable set and read back", async () => {
  resetGh();
  const { out } = await deliverClient(true);
  assert.equal(out.status, "created");
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), NEW_DSN);
  assert.ok(
    ghLines().some((l) =>
      l.startsWith(`ARGV variable set NEXT_PUBLIC_SENTRY_DSN --repo owner/repo --body ${NEW_DSN}`),
    ),
  );
});
await check("--no-write prints the exact command and sets nothing", async () => {
  resetGh();
  const { out, lines } = await deliverClient(false);
  assert.equal(out.status, "would-write");
  assert.equal(
    out.command,
    `gh variable set NEXT_PUBLIC_SENTRY_DSN --repo owner/repo --body ${NEW_DSN}`,
  );
  assert.ok(lines.includes(out.command as string));
  assert.ok(!ghLines().some((l) => l.includes("variable set")));
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), undefined);
});
await check("no GitHub remote: the command names the repo to fill in", async () => {
  resetGh();
  const { out, lines } = await deliverClient(true, null);
  assert.equal(out.status, "skipped");
  assert.match(lines, /--repo <owner\/name>/);
  assert.equal(ghLines().length, 0);
});
await check("a repo variable for another tracker is kept", async () => {
  resetGh({ NEXT_PUBLIC_SENTRY_DSN: SENTRY_IO });
  const { out } = await deliverClient(true);
  assert.equal(out.status, "kept");
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), SENTRY_IO);
});
await check("a backend project gets no client variable", async () => {
  const dir = makeProject("backendproj", {}, { surfaces: "backend" });
  resetGh();
  const out = await deliverGlitchtipDsn({
    projectDir: dir,
    client: NEW_DSN,
    write: true,
    api: null,
    glitchtipUrl: GT,
    repoSlug: "owner/repo",
    log: quiet,
  });
  assert.deepEqual(out, []);
  assert.equal(ghLines().length, 0);
  rmSync(dir, { recursive: true, force: true });
});
await check("shell quoting in the printed command", () => {
  assert.equal(
    ghVariableSetCommand(undefined, "a b'c"),
    `gh variable set NEXT_PUBLIC_SENTRY_DSN --repo <owner/name> --body 'a b'\\''c'`,
  );
});

// ── 4. rotation ──────────────────────────────────────────────────────

console.log("\n── 4. rotation ──");
getStore().set("providers.coolify", { status: "configured", url: "https://coolify.test" });
await setSecret(SECRET_KEYS.coolifyToken, "coolify-token-test");

let coolifyRows: Record<string, string> = {};
const keysDeleted: string[] = [];
function rotationRoutes(): Route {
  return (method, url, body) => {
    if (url.startsWith(`${GT}/api/0/projects/org/`)) {
      if (method === "GET" && url.endsWith("/keys/")) {
        return json([{ id: "old-id", public: "oldkey", dsn: { public: OLD_DSN } }]);
      }
      if (method === "POST" && url.endsWith("/keys/")) {
        return json({ id: "new-id", public: "newkey", dsn: { public: NEW_DSN } }, 201);
      }
      if (method === "DELETE") {
        keysDeleted.push(url);
        return json({});
      }
    }
    if (method === "POST" && url === `${GT}/api/8/store/`) return json({ id: "evt" });
    if (url.startsWith("https://coolify.test/api/v1")) {
      const path = url.slice("https://coolify.test/api/v1".length);
      if (method === "GET" && path === "/applications") {
        return json([{ uuid: "app-1", name: "rotproj" }]);
      }
      if (method === "GET" && path === "/applications/app-1/envs") {
        return json(
          Object.entries(coolifyRows).map(([key, value]) => ({ key, value, is_preview: false })),
        );
      }
      if (method === "PATCH" && path === "/applications/app-1/envs/bulk") {
        for (const row of (body as { data: Array<{ key: string; value: string }> }).data) {
          coolifyRows[row.key] = row.value;
        }
        return json({ ok: true });
      }
    }
    return undefined;
  };
}

async function rotate(dir: string, name: string, dryRun = false) {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await runSecretsRotate({
      projectName: name,
      projectDir: dir,
      only: ["glitchtip"],
      pushTargets: ["coolify", "gh"],
      ghRepo: "owner/repo",
      json: true,
      dryRun,
    });
  } finally {
    process.stdout.write = original;
  }
}

await check("a SENTRY_DSN-only project (the 2026-10-19 shape) rotates everywhere", async () => {
  route = rotationRoutes();
  keysDeleted.length = 0;
  coolifyRows = { SENTRY_DSN: OLD_DSN, PORT: "3001" };
  resetGh({ NEXT_PUBLIC_SENTRY_DSN: OLD_DSN, UNRELATED: "x" });
  const dir = makeProject("rotproj", { SENTRY_DSN: OLD_DSN, OTHER: "keep" });
  const audit = await rotate(dir, "rotproj");
  const entry = audit.adapters[0];
  const env = loadProjectEnv({ projectDir: dir, mode: "prod" });
  assert.equal(entry.provider, "glitchtip");
  assert.deepEqual(entry.envKeysChanged, ["SENTRY_DSN"]);
  assert.equal(env.SENTRY_DSN, NEW_DSN);
  assert.equal(env.OTHER, "keep");
  assert.equal(coolifyRows.SENTRY_DSN, NEW_DSN, "Coolify SENTRY_DSN follows");
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), NEW_DSN, "repo variable follows");
  assert.ok(
    ghLines().some(
      (l) => l === `ARGV variable set NEXT_PUBLIC_SENTRY_DSN --repo owner/repo STDIN ${NEW_DSN}`,
    ),
    "value on stdin, not argv",
  );
  assert.deepEqual([...entry.deployTargetsUpdated].sort(), ["coolify", "gh"]);
  assert.equal(entry.verificationResult, "ok");
  assert.equal(entry.oldRevoked, true);
  assert.equal(keysDeleted.length, 1, "the shared old key is deleted once");
  rmSync(dir, { recursive: true, force: true });
});

await check("a deploy-only name holding something else is not touched", async () => {
  route = rotationRoutes();
  coolifyRows = { SENTRY_DSN: OLD_DSN, PUBLIC_GLITCHTIP_DSN: "manual" };
  resetGh({ NEXT_PUBLIC_SENTRY_DSN: SENTRY_IO });
  const dir = makeProject("rotproj", { GLITCHTIP_DSN: OLD_DSN });
  await rotate(dir, "rotproj");
  assert.equal(ghVar("NEXT_PUBLIC_SENTRY_DSN"), SENTRY_IO);
  assert.equal(coolifyRows.PUBLIC_GLITCHTIP_DSN, "manual");
  assert.equal(coolifyRows.SENTRY_DSN, NEW_DSN, "deploy-only SENTRY_DSN held the old DSN");
  rmSync(dir, { recursive: true, force: true });
});

await check("the scaffold's CHANGE_ME_ SENTRY_DSN beside GLITCHTIP_DSN is filled", async () => {
  route = rotationRoutes();
  coolifyRows = { SENTRY_DSN: "" };
  resetGh();
  const dir = makeProject("rotproj", {
    GLITCHTIP_DSN: OLD_DSN,
    SENTRY_DSN: "CHANGE_ME_SENTRY_DSN",
  });
  const audit = await rotate(dir, "rotproj");
  const env = loadProjectEnv({ projectDir: dir, mode: "prod" });
  assert.deepEqual(audit.adapters[0].envKeysChanged.sort(), ["GLITCHTIP_DSN", "SENTRY_DSN"]);
  assert.equal(env.SENTRY_DSN, NEW_DSN);
  assert.equal(coolifyRows.SENTRY_DSN, NEW_DSN, "the empty Coolify value no longer hides it");
  rmSync(dir, { recursive: true, force: true });
});

await check("a sentry.io SENTRY_DSN or a lone placeholder is not GlitchTip's", async () => {
  calls.length = 0;
  for (const env of [{ SENTRY_DSN: SENTRY_IO }, { SENTRY_DSN: "CHANGE_ME_SENTRY_DSN" }]) {
    const dir = makeProject("notours", env);
    const audit = await rotate(dir, "notours", true);
    assert.equal(audit.adapters[0].skipReason, "adapter-not-detected", JSON.stringify(env));
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(calls.length, 0, "no provider call");
});

await check("beside GLITCHTIP_DSN, a sentry.io SENTRY_DSN stays", async () => {
  route = rotationRoutes();
  coolifyRows = {};
  resetGh();
  const dir = makeProject("rotproj", { GLITCHTIP_DSN: OLD_DSN, SENTRY_DSN: SENTRY_IO });
  const audit = await rotate(dir, "rotproj");
  const env = loadProjectEnv({ projectDir: dir, mode: "prod" });
  assert.deepEqual(audit.adapters[0].envKeysChanged, ["GLITCHTIP_DSN"]);
  assert.equal(env.SENTRY_DSN, SENTRY_IO);
  rmSync(dir, { recursive: true, force: true });
});

await check("dry run lists file names and names the deploy-only ones", async () => {
  const dir = makeProject("rotproj", { SENTRY_DSN: OLD_DSN });
  const audit = await rotate(dir, "rotproj", true);
  const entry = audit.adapters[0];
  assert.deepEqual(entry.envKeysChanged, ["SENTRY_DSN"]);
  assert.match((entry.sideEffects ?? []).join("\n"), /NEXT_PUBLIC_SENTRY_DSN/);
  rmSync(dir, { recursive: true, force: true });
});

await check("a new key on the wrong host is refused before any write", async () => {
  const wrongNew = "https://newkey@glitchtip.example.com/8";
  const base = rotationRoutes();
  route = (method, url, body) =>
    method === "POST" && url.endsWith("/keys/")
      ? json({ id: "new-id", public: "newkey", dsn: { public: wrongNew } }, 201)
      : base(method, url, body);
  const dir = makeProject("rotproj", { SENTRY_DSN: OLD_DSN });
  await assert.rejects(rotate(dir, "rotproj"), /GLITCHTIP_DOMAIN/);
  assert.equal(loadProjectEnv({ projectDir: dir, mode: "prod" }).SENTRY_DSN, OLD_DSN);
  rmSync(dir, { recursive: true, force: true });
});

// ── 5. doctor ────────────────────────────────────────────────────────

console.log("\n── 5. doctor ──");
function doctorRoutes(keyDsn: string | null): Route {
  return (method, url) => {
    if (method !== "GET") return undefined;
    if (url === `${GT}/api/0/organizations/org/`) return json({ slug: "org" });
    if (url === `${GT}/api/0/organizations/org/projects/`) {
      return json(keyDsn === null ? [] : [{ slug: "empty" }, { slug: "tracktime" }]);
    }
    if (url === `${GT}/api/0/projects/org/empty/keys/`) return json([]);
    if (url === `${GT}/api/0/projects/org/tracktime/keys/`) {
      return json([{ dsn: { public: keyDsn } }]);
    }
    return undefined;
  };
}

await check("GlitchTip row fails when DSNs point at another host", async () => {
  route = doctorRoutes(WRONG_DSN);
  const row = await checkGlitchtipWith(glitchtipCfg);
  assert.equal(row.status, "fail");
  assert.match(
    row.detail ?? "",
    /glitchtip\.example\.com, not glitchtip\.test \(project tracktime\)/,
  );
  assert.ok((row.hint ?? []).some((h) => h.includes("GLITCHTIP_DOMAIN=https://glitchtip.test")));
});
await check("GlitchTip row is ok when they match", async () => {
  route = doctorRoutes(NEW_DSN);
  const row = await checkGlitchtipWith(glitchtipCfg);
  assert.equal(row.status, "ok");
  assert.match(row.detail ?? "", /DSNs point at glitchtip\.test/);
});
await check("GlitchTip row is ok with no project to sample", async () => {
  route = doctorRoutes(null);
  const row = await checkGlitchtipWith(glitchtipCfg);
  assert.equal(row.status, "ok");
  assert.match(row.detail ?? "", /no project with a DSN/);
});
await check("an org failure still reports the token, not the DSN", async () => {
  route = (_method, url) =>
    url === `${GT}/api/0/organizations/org/` ? json({ detail: "no" }, 401) : undefined;
  const row = await checkGlitchtipWith(glitchtipCfg);
  assert.equal(row.status, "fail");
  assert.match((row.hint ?? []).join("\n"), /auth-tokens/);
});

function envApi(rows: Record<string, Record<string, string | undefined>>) {
  return {
    listApplications: async () => Object.keys(rows).map((name) => ({ uuid: name, name })),
    listAppEnvRows: async (uuid: string) =>
      Object.entries(rows[uuid]).map(([key, value]) => ({ key, value, isPreview: false })),
  };
}

await check("Coolify apps with an empty SENTRY_DSN are listed, values never", async () => {
  const rows = await checkCoolifyEmptySentryDsn({
    api: envApi({
      broadcastdock: { SENTRY_DSN: "" },
      streaks: { SENTRY_DSN: NEW_DSN },
      tracktime: { SENTRY_DSN: undefined },
      other: { PORT: "3000" },
    }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "warn");
  assert.match(rows[0].detail ?? "", /empty on broadcastdock \(1 not readable: tracktime\)/);
  assert.ok(!JSON.stringify(rows).includes(NEW_DSN));
});
await check("no empty SENTRY_DSN is ok; no SENTRY_DSN at all is no row", async () => {
  const ok = await checkCoolifyEmptySentryDsn({ api: envApi({ a: { SENTRY_DSN: NEW_DSN } }) });
  assert.equal(ok[0].status, "ok");
  assert.deepEqual(await checkCoolifyEmptySentryDsn({ api: envApi({ a: { PORT: "1" } }) }), []);
});

// ── teardown ─────────────────────────────────────────────────────────

globalThis.fetch = realFetch;
process.env.PATH = origPath;
rmSync(ghDir, { recursive: true, force: true });
rmSync(fullstack, { recursive: true, force: true });
await clearAllSecrets();

if (failures.length > 0) {
  console.log(`\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nAll GlitchTip env checks passed.");
