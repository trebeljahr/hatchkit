/**
 * Does a `client-core` scaffold's server actually IMPORT `@starter/shared`?
 *
 * Every other client-core test asserts on file contents: which files survived,
 * which markers were stripped, whether a strip/add round-trip is byte-identical.
 * None of them runs a line of the generated project, and that is how v0.2.18
 * shipped a client-core scaffold whose server test suite could not start:
 *
 *     SyntaxError: The requested module '@starter/shared' does not provide
 *     an export named 'API_LEVEL_HEADER'
 *
 * `packages/shared` has no `"type": "module"` and emits CommonJS — a constraint
 * `packages/shared/package.json` documents, because the Next client resolves it
 * as ["node", "require"]. So whether a named ESM import off it links at all
 * depends on WHICH file the import resolves to, and that is decided by config no
 * presence check reads: the generated server ran under `tsx`, `tsx` honours
 * tsconfig `paths` at runtime, and a `paths` entry pointed `@starter/shared` at
 * `packages/shared/src/index.ts`. That file is TypeScript in a CommonJS package
 * whose body is nothing but `export *` re-exports, which survive the transpile
 * as `require()` calls no named-export detector sees through — so Node offered
 * `default` and `module.exports` and nothing else.
 *
 * The check here is therefore a real import, executed, and it is deliberately
 * cheap enough to live in `pnpm test`: it scaffolds, makes the one workspace
 * symlink pnpm would have made, compiles `packages/shared` with this repo's own
 * `tsc`, and imports named symbols off `@starter/shared` under this repo's own
 * `tsx`. Nothing is installed and nothing is fetched.
 *
 * What it therefore does NOT cover is the generated suite itself — those tests
 * need express, trpc, better-auth and mongoose. That runs in CI instead, as the
 * `client-core` preset of the `stamp-build` matrix in `.github/workflows/ci.yml`,
 * which installs a stamped project and runs its `pnpm run test:unit`.
 *
 * Run: pnpm test
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolate from the real user environment BEFORE the scaffolder loads: ESM
// hoists static imports above statements, so config.ts would otherwise read
// the real preferences dir. Same reasoning as the header of test-scaffold.ts.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "shared-exports-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "shared-exports-dev-"));

const { scaffoldApp } = await import("./src/scaffold/app.js");
type Feature = import("./src/prompts.js").Feature;
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

const CLI = import.meta.dirname;
const STARTER = resolve(join(CLI, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

const TSC = resolve(join(CLI, "node_modules/.bin/tsc"));
const TSX_LOADER = resolve(join(CLI, "node_modules/tsx/dist/loader.mjs"));

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cfg(name: string, features: Feature[]): ProjectConfig {
  return {
    name,
    domain: `${name}.example.com`,
    baseDomain: "example.com",
    subdomain: name,
    surfaces: "fullstack",
    deployTarget: "existing",
    serverId: 1,
    serverIp: "1.2.3.4",
    features,
    provisionServices: [],
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
  } as ProjectConfig;
}

/**
 * A scaffolded project with `packages/shared` built and the workspace link in
 * place — the minimum state in which `import ... from "@starter/shared"` inside
 * `packages/server` means anything.
 *
 * `tsc`'s exit code is ignored on purpose. Nothing is installed here, so
 * `packages/shared/src/schemas.ts` cannot resolve `zod` and tsc reports TS2307
 * — but type errors do not stop emit (`noEmitOnError` is off), and emit is the
 * whole point: what this file tests is how Node reads the EMITTED CommonJS, not
 * whether the starter typechecks. `packages/shared/tsconfig.json` having
 * produced `dist/index.js` is asserted instead, so a tsc that genuinely emitted
 * nothing still fails rather than passing vacuously.
 */
async function preparedProject(prefix: string, features: Feature[]): Promise<string> {
  const dir = join(tempDir(prefix), "project");
  mkdirSync(dir, { recursive: true });
  await scaffoldApp(cfg("handshake-app", features), dir);

  const scope = join(dir, "packages/server/node_modules/@starter");
  mkdirSync(scope, { recursive: true });
  symlinkSync(resolve(join(dir, "packages/shared")), join(scope, "shared"), "dir");

  try {
    execFileSync(TSC, ["-p", join(dir, "packages/shared/tsconfig.json")], { stdio: "pipe" });
  } catch {
    // Type errors are expected without an install; see the doc comment above.
  }
  return dir;
}

/**
 * Import `names` off `@starter/shared` from inside the generated server, under
 * `tsx` — the loader the generated `dev`, `test` and `contract:emit` scripts all
 * use. Returns null on success, or the linker error.
 *
 * The probe is `.mjs` rather than `.ts` so a failure can only be about
 * `@starter/shared`: `packages/server` declares `"type": "module"`, so its own
 * `.ts` files load as ESM either way, but an explicit extension keeps the test
 * from depending on that.
 */
function namedImportError(projectDir: string, names: readonly string[]): string | null {
  const serverDir = join(projectDir, "packages/server");
  const probe = join(serverDir, "src", "__shared-exports-probe.mjs");
  writeFileSync(
    probe,
    [
      `import { ${names.join(", ")} } from "@starter/shared";`,
      // Reference every binding, so a live TDZ or a missing value is a failure
      // too rather than an import that links and resolves to undefined.
      `for (const [name, value] of Object.entries({ ${names.join(", ")} })) {`,
      `  if (value === undefined) { console.error(\`undefined export: \${name}\`); process.exit(1); }`,
      `}`,
      `process.stdout.write("ok");`,
    ].join("\n"),
  );
  try {
    execFileSync(process.execPath, ["--import", TSX_LOADER, probe], {
      stdio: "pipe",
      cwd: serverDir,
    });
    return null;
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    const named = stderr.split("\n").find((line) => /Error|undefined export/.test(line));
    return named?.trim() ?? (stderr.trim() || "probe failed with no output");
  } finally {
    rmSync(probe, { force: true });
  }
}

/** Every `tsconfig*.json` under `dir`, as project-relative paths. */
function tsconfigs(dir: string): string[] {
  const hits: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^tsconfig.*\.json$/.test(entry.name)) hits.push(path.slice(dir.length + 1));
    }
  };
  walk(dir);
  return hits;
}

const results: Record<string, boolean> = {};

function group(name: string, run: () => Array<[string, boolean]>): void {
  console.log(`\n=== ${name} ===`);
  let checks: Array<[string, boolean]>;
  try {
    checks = run();
  } catch (error) {
    console.log(`  ✗ threw: ${error instanceof Error ? error.message : String(error)}`);
    results[name] = false;
    return;
  }
  let ok = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "✓" : "✗"} ${label}`);
    if (!passed) ok = false;
  }
  results[name] = ok;
}

// The value exports the generated server imports by name off `@starter/shared`,
// grouped by the module inside the package that defines them. The grouping is
// the point: `index.ts` re-exports each module with its own `export *`, and it
// is one of those re-exports going invisible that the bug was — so a probe that
// touched a single module could pass while the next one over was unreachable.
//
// Types are no use here. A named import of a type erases, so it links whatever
// Node can see; only a value import fails. In a client-core-only scaffold that
// rules out `protocol.ts` and `types.ts`, which export nothing but types, and
// `schemas.ts`, whose exports are zod values and so need the install this test
// deliberately skips.
const API_LEVEL_EXPORTS = [
  "API_LEVEL",
  "API_LEVEL_CHANGES",
  "API_LEVEL_HEADER",
  "CLIENT_VERSION_HEADER",
  "CLIENT_ID_HEADER",
  "CLIENT_TOO_OLD",
  "SERVER_TOO_OLD",
  "MIN_CLIENT_API_LEVEL",
  "VERSION_REFUSAL_HTTP_STATUS",
  "compareVersions",
  "parseApiLevel",
  "parseClientVersion",
  "serverSupports",
  "versionHeaders",
] as const;
const SYNC_PROTOCOL_EXPORTS = [
  "SYNC_EVENT_KINDS",
  "SYNC_EVENT_KIND_SET",
  "SYNC_PATH",
  "SESSION_REVOKED_CLOSE_CODE",
  "isSyncMessage",
] as const;

const clientCore = await preparedProject("client-core-exports-", ["client-core"]);

group("a client-core scaffold's server can import @starter/shared by name", () => {
  const checks: Array<[string, boolean]> = [];
  const groups: Array<[string, readonly string[]]> = [
    ["api-level.ts", API_LEVEL_EXPORTS],
    ["sync-protocol.ts", SYNC_PROTOCOL_EXPORTS],
  ];
  for (const [label, names] of groups) {
    const error = namedImportError(clientCore, names);
    if (error) console.log(`      ${error}`);
    checks.push([`named imports from ${label} link under tsx`, error === null]);
  }
  // One import of the whole set together, which is the shape the generated
  // sources actually use.
  const all = [...API_LEVEL_EXPORTS, ...SYNC_PROTOCOL_EXPORTS];
  const error = namedImportError(clientCore, all);
  if (error) console.log(`      ${error}`);
  checks.push(["all of them in one import statement", error === null]);
  return checks;
});

group("the emitted shared package is the CommonJS the exports map promises", () => {
  const pkg = JSON.parse(readFileSync(join(clientCore, "packages/shared/package.json"), "utf-8"));
  const index = readFileSync(join(clientCore, "packages/shared/dist/index.js"), "utf-8");
  return [
    // The two halves of the constraint the fix has to respect. If either flips,
    // the probe above may go green for a reason that breaks the Next client
    // instead — it resolves this package as ["node", "require"].
    ['no "type": "module" (the client resolves this package as require)', pkg.type === undefined],
    [
      'the "." condition resolves under require as well as import',
      pkg.exports?.["."]?.default === "./dist/index.js" && pkg.exports["."].import === undefined,
    ],
    ["dist/index.js is CommonJS", index.includes("__exportStar(require(")],
    ["dist/index.js re-exports api-level", index.includes('require("./api-level.js")')],
  ];
});

group("no generated tsconfig sends a tsx-run import into packages/shared/src", () => {
  // The regression itself, as config rather than as behaviour — so the reason
  // the probe above passes is recorded somewhere a reader can find it, and so
  // re-adding the mapping fails here too with a message that says why.
  //
  // Only packages whose code RUNS under tsx are checked. packages/client keeps
  // its own mapping on purpose: Next and Vitest resolve it with their own
  // bundler, which reads TypeScript as ESM whatever the package's `type` says,
  // so source-resolution there is a convenience and not a trap.
  const TSX_RUN = ["packages/server/tsconfig.json"];
  const checks: Array<[string, boolean]> = [];
  for (const relative of TSX_RUN) {
    const raw = readFileSync(join(clientCore, relative), "utf-8");
    const intoSharedSrc = /"@starter\/shared(?:\/\*)?"\s*:\s*\[[^\]]*shared\/src/.test(raw);
    checks.push([`${relative} has no "@starter/shared" paths entry into shared/src`, !intoSharedSrc]);
  }
  // A mapping anywhere else is not a failure, but it should be a deliberate
  // one, so list what exists rather than asserting a count.
  const mapped = tsconfigs(clientCore).filter((relative) =>
    /"@starter\/shared(?:\/\*)?"\s*:\s*\[[^\]]*shared\/src/.test(
      readFileSync(join(clientCore, relative), "utf-8"),
    ),
  );
  console.log(`      maps @starter/shared to source: ${mapped.join(", ") || "(none)"}`);
  return checks;
});

group("the probe is not vacuous: the old mapping still breaks it", () => {
  // Without this, the check above degrades silently the day tsx stops honouring
  // `paths`, or the day `preparedProject` stops producing a runnable tree: the
  // probe would pass for a reason that has nothing to do with the fix.
  const tsconfigPath = join(clientCore, "packages/server/tsconfig.json");
  const asShipped = readFileSync(tsconfigPath, "utf-8");
  try {
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          extends: "../../tsconfig.base.json",
          compilerOptions: {
            rootDir: "./src",
            outDir: "./dist",
            declaration: false,
            declarationMap: false,
            paths: {
              "@starter/shared": ["../shared/src/index.ts"],
              "@starter/shared/*": ["../shared/src/*"],
            },
          },
          include: ["src"],
          references: [{ path: "../shared" }],
        },
        null,
        2,
      ),
    );
    const error = namedImportError(clientCore, ["API_LEVEL_HEADER"]);
    return [
      [
        "a paths entry into shared/src makes the named import fail again",
        error !== null && /does not provide an export named/.test(error),
      ],
    ];
  } finally {
    writeFileSync(tsconfigPath, asShipped);
  }
});

{
  const { clearAllSecrets } = await import("./src/utils/secrets.js");
  await clearAllSecrets();
}
for (const dir of temps) rmSync(dir, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_CONF_DIR, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_DEV_CONFIG_DIR, { recursive: true, force: true });

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
