/**
 * Feature COMBINATION matrix.
 *
 * test-scaffold.ts asserts what each feature writes. This file asserts
 * that the combinations compose — that turning a feature off leaves a
 * coherent project rather than a project missing the file some surviving
 * file still points at.
 *
 * The bug class it exists to catch is always the same shape: a feature
 * is stripped, and something that referenced it is not. Concretely, on
 * main before this file existed:
 *
 *   · `hatchkit update` installed `icons:desktop` without copying
 *     `scripts/icons-desktop.mjs` that it runs.
 *   · a `static` surface with `websocket` selected seeded `REDIS_URL`
 *     into the env model for a Redis service `infra.ts` never wrote.
 *
 * Both are mechanically detectable and neither was detected.
 *
 * ── Which combinations ───────────────────────────────────────────────
 * Chosen by which features touch the SAME files, because that is where
 * composition breaks:
 *
 *   bare              — nothing selected. The strip path at full depth;
 *                       every conditional branch takes its "remove" arm.
 *   <each> alone      — one feature's files kept, every other stripped.
 *   full              — every feature at once; almost no strip runs.
 *   ws+stripe         — both strip call sites out of the SAME two server
 *                       files (src/index.ts, src/app.ts).
 *   desktop+mobile    — both flip next.config to `output: "export"`,
 *                       both claim the nativeHmr port, both feed
 *                       TRUSTED_ORIGINS.
 *   s3+analytics      — both extend the env model and the Terraform vars.
 *   client-core+ws    — both run a WebSocket server in packages/server, and
 *                       each authenticates its own upgrade.
 *   static+analytics  — the surface prune and a feature that must
 *                       survive it (client-side SDKs, no server).
 *
 * That is 11 scaffolds, no installs and no builds, so it runs inside
 * `pnpm test`. Compiling each result is the job of the `stamp-build` CI
 * matrix in .github/workflows/ci.yml, which installs and builds a
 * representative subset — the two are complementary, and neither is a
 * substitute for the other.
 *
 * Run: pnpm test
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Same isolation contract as test-scaffold.ts: a throwaway config dir, a
// throwaway keytar service (every scaffold mints a dotenvx key) and a
// throwaway local-dev root, all removed at the end.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "matrix-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "matrix-devdir-"));

const { scaffoldApp } = await import("./src/scaffold/app.js");
const { KNOWN_FEATURES } = await import("./src/utils/flags.js");
const { SUPPORTED_ADDITIONS } = await import("./src/scaffold/update.js");
type Feature = import("./src/prompts.js").Feature;
type Surface = import("./src/prompts.js").Surface;
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  process.exit(0);
}

function cfg(name: string, features: Feature[], surfaces: Surface): ProjectConfig {
  return {
    name,
    domain: `${name}.example.com`,
    baseDomain: "example.com",
    subdomain: name,
    surfaces,
    deployTarget: "existing",
    serverId: 1,
    serverIp: "1.2.3.4",
    features,
    provisionServices: [],
    s3Provider: features.includes("s3") ? "hetzner" : "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Coherence checks — each returns the problems it found, empty when clean.
// ---------------------------------------------------------------------------

function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...walkFiles(p, ext));
    } else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Relative import specifiers that don't resolve — the direct signature
 *  of a feature file removed without its call sites. */
function danglingImports(root: string): string[] {
  const bad: string[] = [];
  for (const dir of ["packages/server/src", "packages/client/src", "packages/shared/src"]) {
    const srcDir = join(root, dir);
    if (!existsSync(srcDir)) continue;
    for (const file of [...walkFiles(srcDir, ".ts"), ...walkFiles(srcDir, ".tsx")]) {
      const content = readFileSync(file, "utf-8");
      for (const m of content.matchAll(/\bfrom\s+"(\.[^"]*)"/g)) {
        const spec = m[1];
        const base = resolve(dirname(file), spec.replace(/\.js$/, ""));
        const resolves = [
          `${base}.ts`,
          `${base}.tsx`,
          join(base, "index.ts"),
          join(base, "index.tsx"),
          base,
        ].some((c) => existsSync(c));
        if (!resolves) bad.push(`${file.slice(root.length + 1)} → ${spec}`);
      }
    }
  }
  return bad;
}

/** Local files a package.json script invokes that were not scaffolded.
 *
 *  Catches exactly the `icons:desktop` class: the script
 *  survives the strip, its input does not. Only inspects arguments that
 *  look like in-repo paths — a bare binary name (`cap`, `electron`) comes
 *  from node_modules, which this test never installs. */
function scriptsReferencingMissingFiles(root: string): string[] {
  const problems: string[] = [];
  for (const pkgRel of packageJsonPaths(root)) {
    const pkgPath = join(root, pkgRel);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const base = dirname(pkgPath);
    for (const [name, raw] of Object.entries((pkg.scripts ?? {}) as Record<string, string>)) {
      // A script that delegates into another workspace package resolves
      // its paths in THAT package's directory, not this one — e.g.
      // `pnpm --filter @starter/server exec tsx src/contract/emit.ts`
      // runs against packages/server. Resolving those here reports a
      // miss for a file that is present where it is actually used, so
      // skip a delegating script rather than guess at the target dir.
      if (/pnpm\s+(--filter|-F|-C|--dir)\b/.test(raw)) continue;
      for (const token of raw.split(/\s+/)) {
        // An in-repo SOURCE path: has a directory separator and a file
        // extension, and is not a flag, a URL, a glob, or a build
        // output. `dist/index.js` and `src/tests/*.test.ts` are both
        // legitimate — the first is produced by `build`, the second is
        // expanded by the test runner — so neither is evidence of a
        // missed strip.
        if (token.startsWith("-") || token.includes("://")) continue;
        if (token.includes("*") || token.startsWith("dist/") || token.includes("/dist/")) continue;
        if (!token.includes("/") || !/\.(mjs|cjs|js|ts|tsx|json|png|sh|yml)$/.test(token)) continue;
        const target = join(base, token);
        if (!existsSync(target)) {
          problems.push(`${pkgRel} "${name}" → ${token}`);
        }
      }
    }
  }
  return problems;
}

function packageJsonPaths(root: string): string[] {
  const out: string[] = [];
  if (existsSync(join(root, "package.json"))) out.push("package.json");
  const pkgDir = join(root, "packages");
  if (existsSync(pkgDir)) {
    for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = join("packages", entry.name, "package.json");
      if (existsSync(join(root, rel))) out.push(rel);
    }
  }
  return out;
}

/** Release workflows present for a shell the project doesn't have, or
 *  missing for one it does. */
function workflowMismatches(root: string, features: Feature[]): string[] {
  const owner: Record<string, Feature> = {
    "desktop-release.yml": "desktop",
    "mobile-release.yml": "mobile",
  };
  const problems: string[] = [];
  for (const [file, feature] of Object.entries(owner)) {
    const present = existsSync(join(root, ".github/workflows", file));
    const wanted = features.includes(feature);
    if (present && !wanted) problems.push(`${file} present without "${feature}"`);
    if (!present && wanted) problems.push(`${file} missing despite "${feature}"`);
  }
  return problems;
}

/** Env vars documented in the production env model for a service the
 *  scaffold did not write. The keys are the ones a feature owns; each
 *  must appear only when its owner is both selected AND scaffoldable on
 *  this surface. */
function envMismatches(root: string, features: Feature[], surfaces: Surface): string[] {
  const envPath = join(root, ".env.production");
  if (!existsSync(envPath)) return [];
  const content = readFileSync(envPath, "utf-8");
  const hasKey = (k: string) => new RegExp(`^${k}=`, "m").test(content);
  const problems: string[] = [];

  const expectations: Array<[key: string, wanted: boolean, why: string]> = [
    // Redis is only wired into compose off a static surface.
    ["REDIS_URL", features.includes("websocket") && surfaces !== "static", "websocket + a server"],
    ["S3_BUCKET_NAME", features.includes("s3"), "s3"],
    ["AWS_ACCESS_KEY_ID", features.includes("s3"), "s3"],
    ["SENTRY_DSN", features.includes("analytics"), "analytics"],
  ];
  for (const [key, wanted, why] of expectations) {
    if (hasKey(key) && !wanted) problems.push(`${key} documented without ${why}`);
    if (!hasKey(key) && wanted) problems.push(`${key} missing despite ${why}`);
  }
  return problems;
}

/** The compose file naming a service no other file provides, and the
 *  inverse for Redis specifically — the one service a feature owns. */
function composeMismatches(root: string, features: Feature[], surfaces: Surface): string[] {
  const composePath = join(root, "docker-compose.yml");
  if (!existsSync(composePath)) return [];
  const content = readFileSync(composePath, "utf-8");
  const hasRedis = /^\s{2}redis:/m.test(content);
  const wantRedis = features.includes("websocket") && surfaces !== "static";
  if (hasRedis && !wantRedis) return ["compose declares redis without websocket + a server"];
  if (!hasRedis && wantRedis) return ["compose has no redis despite websocket"];
  return [];
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

interface Combo {
  label: string;
  features: Feature[];
  surfaces: Surface;
}

const COMBOS: Combo[] = [
  { label: "bare", features: [], surfaces: "fullstack" },
  ...KNOWN_FEATURES.map((f) => ({
    label: `only-${f}`,
    features: [f],
    surfaces: "fullstack" as Surface,
  })),
  { label: "full", features: [...KNOWN_FEATURES], surfaces: "fullstack" },
  { label: "ws+stripe", features: ["websocket", "stripe"], surfaces: "fullstack" },
  { label: "desktop+mobile", features: ["desktop", "mobile"], surfaces: "fullstack" },
  { label: "s3+analytics", features: ["s3", "analytics"], surfaces: "fullstack" },
  // Both put a WebSocket server in packages/server, and each resolves an
  // upgrade's session itself — `sync/` deliberately does not import `ws/`,
  // because the two features are selected independently and an import across
  // that line is a TS2307 for whoever picks one without the other
  // (`only-client-core` is the combination that catches it). With both ON the
  // two upgrade listeners have to coexist on one HTTP server.
  { label: "client-core+websocket", features: ["client-core", "websocket"], surfaces: "fullstack" },
  { label: "static+analytics", features: ["analytics"], surfaces: "static" },
];

const results: Record<string, boolean> = {};

// ---------------------------------------------------------------------------
// Every feature is reachable on every surface that names features.
//
// `KNOWN_FEATURES` is what `--features` accepts and what `create --help`
// prints. `SUPPORTED_ADDITIONS` is what `hatchkit update` offers. A
// feature in the second and not the first is describable to `update` and
// rejected by `create` — which is exactly what happened to
// `auth-account-security`: it reached the `Feature` union and the update
// picker, and `hatchkit create --features auth-account-security` failed
// as an unknown value. Nobody noticed, because nothing compared the two
// lists.
// ---------------------------------------------------------------------------
{
  console.log("\n── every feature is reachable on every surface ───────");
  const missing = SUPPORTED_ADDITIONS.filter((f) => !KNOWN_FEATURES.includes(f));
  if (missing.length > 0) {
    console.log(
      `  ✗ in SUPPORTED_ADDITIONS but not KNOWN_FEATURES: ${missing.join(", ")}\n` +
        "      `hatchkit update` offers these; `hatchkit create --features` rejects them.\n" +
        "      Add them to KNOWN_FEATURES in cli/src/utils/flags.ts.",
    );
  } else {
    console.log("  ✓ every addable feature is accepted by --features");
  }
  results["feature reachability"] = missing.length === 0;
}

for (const combo of COMBOS) {
  const dir = mkdtempSync(join(tmpdir(), `matrix-${combo.label.replace(/\+/g, "-")}-`));
  try {
    console.log(`\n── ${combo.label} (${combo.surfaces}) ─────────────────────────────`);
    console.log(`   features: ${combo.features.join(", ") || "(none)"}`);
    await scaffoldApp(cfg(`mx-${combo.label.replace(/\+/g, "-")}`, combo.features, combo.surfaces), dir);

    const checks: Array<[string, string[]]> = [
      ["no dangling relative imports", danglingImports(dir)],
      ["no script points at a file that wasn't scaffolded", scriptsReferencingMissingFiles(dir)],
      ["release workflows match the selected shells", workflowMismatches(dir, combo.features)],
      ["env model matches the scaffolded services", envMismatches(dir, combo.features, combo.surfaces)],
      ["compose matches the scaffolded services", composeMismatches(dir, combo.features, combo.surfaces)],
      // The starter's snapshot records the starter's router. Unselected, the
      // strip removes it; selected, the scaffold does, and `create` writes the
      // project's own after `pnpm install` (features/client-core/snapshot.ts).
      [
        "no contract snapshot of the starter's router",
        existsSync(join(dir, "packages/server/contract")) ? ["packages/server/contract"] : [],
      ],
    ];

    let ok = true;
    for (const [name, problems] of checks) {
      console.log(`  ${problems.length === 0 ? "✓" : "✗"} ${name}`);
      for (const p of problems.slice(0, 8)) console.log(`      ${p}`);
      if (problems.length > 8) console.log(`      … and ${problems.length - 8} more`);
      if (problems.length > 0) ok = false;
    }
    results[combo.label] = ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

{
  const { clearAllSecrets } = await import("./src/utils/secrets.js");
  await clearAllSecrets();
}
rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_DEV_CONFIG_DIR!, { recursive: true, force: true });

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
