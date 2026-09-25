/**
 * The `desktop` (Electron) feature, end to end through the scaffolder.
 *
 * The shell it generates is a pile of rules that fail QUIETLY when they are
 * broken — the app still builds, still launches, and still looks right on the
 * machine that built it. Each one below is here because getting it wrong
 * produces a green build and a broken install:
 *
 *   1. A `file://` shell. The origin is the string "null", so sign-in is
 *      refused by any trust list and every route but the first blanks. The
 *      app must serve its export from a privileged custom scheme, and that
 *      scheme and host are permanent once shipped.
 *   2. A build with no API URL. Next inlines NEXT_PUBLIC_* at build time and
 *      a static export has no runtime env, so the binary installs fine and
 *      fails on its first request.
 *   3. A packaged archive carrying the root `dependencies`. electron-builder
 *      adds them whatever the `files` list says.
 *   4. An update feed left undefined, which electron-builder fills in by
 *      guessing GitHub from a token every CI runner has.
 *   5. A restart the person did not ask for.
 *   6. A test run that shows a window, takes focus, writes a real keychain
 *      item or touches the installed app's profile.
 *
 * So this suite asserts two things: that the feature's file list is complete
 * and survives both `hatchkit create` and `hatchkit update`, and that the
 * rules above are still present IN THE GENERATED PROJECT — not merely in the
 * starter, which a prune step could have half-removed.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Keep the real user config, keychain and Caddy directory out of reach. ESM
// hoists static imports above assignments, so every hatchkit module below is
// imported dynamically, after these are set.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "desktop-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "desktop-devdir-"));

const {
  DESKTOP_DEV_DEPS,
  DESKTOP_FILES,
  DESKTOP_SCRIPTS,
  DESKTOP_SCRIPTS_TO_STRIP,
  substituteDesktopFiles,
  unresolvedDesktopTokens,
} = await import("./src/scaffold/desktop.js");
const { resolveIdentifiers } = await import("./src/scaffold/identifiers.js");
const { scaffoldApp } = await import("./src/scaffold/app.js");
const { runUpdate } = await import("./src/scaffold/update.js");
const { nativeClientOrigins } = await import("./src/scaffold/native-origins.js");
const { clearAllSecrets } = await import("./src/utils/secrets.js");

type Feature = import("./src/prompts.js").Feature;
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}\n`);
  process.exit(0);
}

const failures: string[] = [];
const tempDirs: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${(err as Error).message.split("\n")[0]}`);
    failures.push(name);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────`);
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
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
    scaffoldRepo: false,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
  } as ProjectConfig;
}

/** Every file under a directory, relative to it. */
function walk(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** Source text with comments removed, so an explanation of a rule can neither
 *  satisfy it nor break it. The starter's own headless.test.ts does the same;
 *  without it, a sentence naming `shell.openExternal` reads as a call to it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every desktop source file in a generated project, as comment-free text.
 *  Used for the rules that are "this must appear somewhere" or "this must
 *  appear exactly once across the shell". */
function desktopSources(dir: string): { path: string; text: string }[] {
  const roots = ["electron/src", "scripts", "electron-builder.config.mjs"];
  const files: { path: string; text: string }[] = [];
  for (const root of roots) {
    const full = join(dir, root);
    if (!existsSync(full)) continue;
    const rels = statSync(full).isDirectory() ? walk(full).map((r) => `${root}/${r}`) : [root];
    for (const rel of rels) {
      if (!/\.(ts|mjs|js)$/.test(rel)) continue;
      files.push({ path: rel, text: stripComments(readFileSync(join(dir, rel), "utf-8")) });
    }
  }
  return files;
}

// ── 1. The feature list is real ──────────────────────────────────────
//
// `hatchkit update` copies exactly DESKTOP_FILES out of the starter. An entry
// that names nothing is copied silently and the project is missing a piece of
// the shell — which is how the list and the starter drifted apart before.

section("feature file list");

check("every DESKTOP_FILES entry exists in starter/", () => {
  const missing = DESKTOP_FILES.filter((rel) => !existsSync(join(STARTER, rel)));
  assert.deepEqual(missing, [], `missing from starter/: ${missing.join(", ")}`);
});

check("every DESKTOP_SCRIPTS entry exists in the starter's package.json", () => {
  const pkg = JSON.parse(readFileSync(join(STARTER, "package.json"), "utf-8"));
  const missing = DESKTOP_SCRIPTS.filter((name) => !pkg.scripts?.[name]);
  assert.deepEqual(missing, [], `no such script in starter/package.json: ${missing.join(", ")}`);
});

check("every DESKTOP_DEV_DEPS entry is a starter devDependency", () => {
  const pkg = JSON.parse(readFileSync(join(STARTER, "package.json"), "utf-8"));
  const missing = DESKTOP_DEV_DEPS.filter((name) => !pkg.devDependencies?.[name]);
  assert.deepEqual(missing, [], `not in starter devDependencies: ${missing.join(", ")}`);
});

check("DESKTOP_SCRIPTS_TO_STRIP is a superset of DESKTOP_SCRIPTS", () => {
  const strip = new Set(DESKTOP_SCRIPTS_TO_STRIP);
  const missing = DESKTOP_SCRIPTS.filter((n) => !strip.has(n));
  assert.deepEqual(missing, []);
});

// ── 2. Identifiers ───────────────────────────────────────────────────
//
// The profile directory and the env prefix are permanent once a version has
// shipped. They must be derived the same way on every machine and every run,
// and they must never come out empty — an empty profile name resolves to the
// OS app-data root itself.

section("identifiers");

check("the desktop names come from the shared resolver, not a second rule", () => {
  // They used to be re-derived here. Two rules for one permanent name is how a
  // signing step ends up offering a bundle id that disagrees with the one
  // already written into the project's own files.
  const ids = resolveIdentifiers({ name: "my-app" });
  assert.equal(ids.slug, "my-app");
  // Hyphen-free: a reverse-DNS segment, an env-var prefix and a database
  // name each reject or mangle a hyphen.
  assert.equal(ids.envPrefix, "MYAPP");
  assert.equal(ids.bundleId, "com.example.myapp");
  assert.equal(`${ids.desktopOrigin.scheme}://${ids.desktopOrigin.host}`, "app://-");
});

check("substitution is idempotent and leaves nothing behind", () => {
  const dir = temp("desktop-subst-");
  mkdirSync(join(dir, "electron/src"), { recursive: true });
  writeFileSync(
    join(dir, "electron/src/headless.ts"),
    'export const HEADLESS_ENV = "{{envPrefix}}_HEADLESS";\n',
    "utf-8",
  );
  const ids = resolveIdentifiers({ name: "my-app" });
  substituteDesktopFiles(dir, ids);
  substituteDesktopFiles(dir, ids);
  assert.equal(
    readFileSync(join(dir, "electron/src/headless.ts"), "utf-8"),
    'export const HEADLESS_ENV = "MYAPP_HEADLESS";\n',
  );
  assert.deepEqual(unresolvedDesktopTokens(dir), []);
});

// ── 3. A scaffold WITH desktop ───────────────────────────────────────

section("hatchkit create --features desktop");

const withDesktop = temp("desktop-with-");
await scaffoldApp(cfg("my-app", ["desktop"]), withDesktop);
const withPkg = JSON.parse(readFileSync(join(withDesktop, "package.json"), "utf-8"));

check("every desktop file is present", () => {
  const missing = DESKTOP_FILES.filter((rel) => !existsSync(join(withDesktop, rel)));
  assert.deepEqual(missing, []);
});

check("no placeholder survives into the generated project", () => {
  // A surviving `{{envPrefix}}` is not cosmetic: it becomes an environment
  // variable name no shell can set, so the headless contract never engages
  // and a test run opens windows on the person's screen.
  assert.deepEqual(unresolvedDesktopTokens(withDesktop), []);
});

check("the profile is pinned by name, not derived from package.json", () => {
  const profile = readFileSync(join(withDesktop, "electron/src/profile.ts"), "utf-8");
  assert.match(profile, /PACKAGED_PROFILE_NAME\s*=\s*"my-app"/);
  assert.match(profile, /UNPACKAGED_PROFILE_NAME\s*=\s*"my-app-dev"/);
});

check("the headless switch is the project's own env var", () => {
  const headless = readFileSync(join(withDesktop, "electron/src/headless.ts"), "utf-8");
  assert.match(headless, /HEADLESS_ENV\s*=\s*"MYAPP_HEADLESS"/);
});

check("the app is served from app://-, never file://", () => {
  const bridge = readFileSync(
    join(withDesktop, "packages/shared/src/desktop-bridge.ts"),
    "utf-8",
  );
  assert.match(bridge, /DESKTOP_APP_SCHEME\s*=\s*"app"/);
  assert.match(bridge, /DESKTOP_APP_HOST\s*=\s*"-"/);
  const main = join(withDesktop, "electron/src/main.ts");
  assert.ok(existsSync(main), "electron/src/main.ts is missing");
  assert.ok(
    !/loadFile\(/.test(readFileSync(main, "utf-8")),
    "main.ts still calls loadFile — that is a file:// document, whose origin is null",
  );
});

check("the old flat electron/main.ts scaffold is gone", () => {
  assert.ok(!existsSync(join(withDesktop, "electron/main.ts")));
  assert.ok(!existsSync(join(withDesktop, "electron/preload.ts")));
});

check("app://- is in the server's TRUSTED_ORIGINS", () => {
  const env = readFileSync(join(withDesktop, "packages/server/.env.example"), "utf-8");
  const line = /^TRUSTED_ORIGINS=(.*)$/m.exec(env);
  assert.ok(line, "no TRUSTED_ORIGINS line");
  assert.ok(line[1].split(",").includes("app://-"), line[1]);
  assert.deepEqual(nativeClientOrigins(["desktop"]), ["app://-"]);
});

check("the client export has no relative asset prefix", () => {
  // A relative prefix resolves against the current directory, so a nested
  // route looks for its chunks under that route's folder and renders blank.
  const next = readFileSync(join(withDesktop, "packages/client/next.config.ts"), "utf-8");
  assert.ok(!/assetPrefix\s*:/.test(next), "next.config.ts still sets assetPrefix");
});

check("the desktop export has its own directory", () => {
  const next = readFileSync(join(withDesktop, "packages/client/next.config.ts"), "utf-8");
  // One variable for both shells: build-mobile.mjs sets it to out-mobile.
  assert.match(next, /NEXT_EXPORT_DIR/);
  const build = readFileSync(join(withDesktop, "scripts/build-desktop.mjs"), "utf-8");
  assert.match(build, /out-desktop/);
});

check("the build refuses an unset or unreached API URL", () => {
  const build = readFileSync(join(withDesktop, "scripts/build-desktop.mjs"), "utf-8");
  assert.match(build, /NEXT_PUBLIC_API_URL/);
  assert.match(build, /"\.\/_next/, "the build does not check for a relative asset prefix");
});

check("the packaged file list excludes node_modules", () => {
  const cfgText = readFileSync(join(withDesktop, "electron-builder.config.mjs"), "utf-8");
  assert.match(cfgText, /!node_modules\/\*\*/);
  assert.match(cfgText, /electron\/dist\/\*\*/);
  assert.match(cfgText, /packages\/client\/out-desktop\/\*\*/);
});

check("the runtime fuses are set", () => {
  const cfgText = readFileSync(join(withDesktop, "electron-builder.config.mjs"), "utf-8");
  for (const fuse of ["runAsNode", "enableNodeCliInspectArguments", "onlyLoadAppFromAsar"]) {
    assert.match(cfgText, new RegExp(fuse), `fuse ${fuse} is not configured`);
  }
});

check("the update feed is explicitly null where there is none", () => {
  // Left undefined, electron-builder guesses a GitHub feed from GH_TOKEN,
  // which every CI runner has.
  const release = readFileSync(join(withDesktop, "scripts/lib/desktop-release.mjs"), "utf-8");
  assert.match(release, /updateFeedFor/);
  assert.match(release, /null/);
  const cfgText = readFileSync(join(withDesktop, "electron-builder.config.mjs"), "utf-8");
  assert.match(cfgText, /updateFeedFor/);
});

check("quitAndInstall has exactly one call site in the shell", () => {
  // A restart nobody asked for loses whatever they were typing.
  const calls = desktopSources(withDesktop)
    .filter((f) => !f.path.endsWith(".test.ts") && !f.path.endsWith(".test.mjs"))
    .flatMap((f) =>
      [...f.text.matchAll(/\.quitAndInstall\s*\(/g)].map(() => f.path),
    );
  assert.equal(calls.length, 1, `call sites: ${calls.join(", ") || "none"}`);
});

check("shell.openExternal is only reached through external.ts", () => {
  // Headless runs record URLs instead of opening them; a direct call bypasses
  // that and takes focus from whoever is using the machine.
  const offenders = desktopSources(withDesktop)
    .filter((f) => f.path.startsWith("electron/src/"))
    .filter((f) => f.path !== "electron/src/external.ts")
    .filter((f) => /shell\.openExternal/.test(f.text))
    .map((f) => f.path);
  assert.deepEqual(offenders, []);
});

check("the package.json carries the desktop scripts and dev dependencies", () => {
  const missingScripts = DESKTOP_SCRIPTS.filter((n) => !withPkg.scripts?.[n]);
  assert.deepEqual(missingScripts, []);
  const missingDeps = DESKTOP_DEV_DEPS.filter((n) => !withPkg.devDependencies?.[n]);
  assert.deepEqual(missingDeps, []);
});

check("the desktop unit suites run as part of `pnpm test`", () => {
  // Nothing ran electron/src/*.test.ts before this was chained in, so every
  // rule those tests pin was unenforced in the generated project.
  assert.match(withPkg.scripts["test:unit"], /test:electron/);
  assert.match(withPkg.scripts["test:unit"], /test:desktop:release/);
});

check("electron-updater is a dev dependency, never a runtime one", () => {
  // esbuild bundles it into main.js; a runtime dependency would be packed
  // into the asar by electron-builder and loaded twice.
  assert.ok(withPkg.devDependencies?.["electron-updater"]);
  assert.ok(!withPkg.dependencies?.["electron-updater"]);
});

// ── 4. A scaffold WITHOUT desktop ────────────────────────────────────

section("hatchkit create (no desktop)");

const noDesktop = temp("desktop-without-");
await scaffoldApp(cfg("plain-app", []), noDesktop);
const plainPkg = JSON.parse(readFileSync(join(noDesktop, "package.json"), "utf-8"));

check("no desktop file survives", () => {
  const left = DESKTOP_FILES.filter((rel) => existsSync(join(noDesktop, rel)));
  assert.deepEqual(left, []);
});

check("no desktop script or dependency survives", () => {
  const scripts = DESKTOP_SCRIPTS_TO_STRIP.filter((n) => plainPkg.scripts?.[n]);
  assert.deepEqual(scripts, []);
  const deps = DESKTOP_DEV_DEPS.filter((n) => plainPkg.devDependencies?.[n]);
  assert.deepEqual(deps, []);
});

check("the electron-builder block is gone", () => {
  assert.equal(plainPkg.build, undefined);
});

check("test:unit no longer chains the deleted desktop suites", () => {
  // `pnpm run test:electron` against a script that does not exist exits
  // non-zero, so a stale chain turns `pnpm test` red on a project that has no
  // desktop at all.
  const unit = plainPkg.scripts?.["test:unit"] ?? "";
  assert.ok(!unit.includes("test:electron"), unit);
  assert.ok(!unit.includes("test:desktop:release"), unit);
});

check("no TRUSTED_ORIGINS entry is invented", () => {
  assert.deepEqual(nativeClientOrigins([]), []);
});

// ── 5. hatchkit update adds it to an existing project ────────────────

section("hatchkit update → add desktop");

const updated = temp("desktop-update-");
await scaffoldApp(cfg("later-app", []), updated);
await runUpdate(updated, {
  presets: {
    desiredFeatures: ["desktop"],
    confirmAddFeatures: true,
    enableLocalDev: false,
    pushNativeOrigins: false,
  },
});
const updatedPkg = JSON.parse(readFileSync(join(updated, "package.json"), "utf-8"));

check("every desktop file arrived", () => {
  const missing = DESKTOP_FILES.filter((rel) => !existsSync(join(updated, rel)));
  assert.deepEqual(missing, []);
});

check("placeholders were filled with this project's identifiers", () => {
  assert.deepEqual(unresolvedDesktopTokens(updated), []);
  const profile = readFileSync(join(updated, "electron/src/profile.ts"), "utf-8");
  assert.match(profile, /PACKAGED_PROFILE_NAME\s*=\s*"later-app"/);
  const headless = readFileSync(join(updated, "electron/src/headless.ts"), "utf-8");
  assert.match(headless, /"LATERAPP_HEADLESS"/);
});

check("the scripts and dev dependencies were merged in", () => {
  const missingScripts = DESKTOP_SCRIPTS.filter((n) => !updatedPkg.scripts?.[n]);
  assert.deepEqual(missingScripts, []);
  const missingDeps = DESKTOP_DEV_DEPS.filter((n) => !updatedPkg.devDependencies?.[n]);
  assert.deepEqual(missingDeps, []);
});

check("the manifest records the feature", () => {
  const manifest = JSON.parse(readFileSync(join(updated, ".hatchkit.json"), "utf-8"));
  assert.ok(manifest.features.includes("desktop"));
});

// `update` is the retrofit path, so it runs against repos people have edited.
// A re-run that overwrote a customised electron/ would delete that work.
const marker = "// customised by the project owner\n";
appendFileSync(join(updated, "electron/src/profile.ts"), marker, "utf-8");
await runUpdate(updated, {
  presets: {
    desiredFeatures: ["desktop"],
    confirmAddFeatures: true,
    enableLocalDev: false,
    pushNativeOrigins: false,
  },
});
check("a second update run clobbers no user edit", () => {
  const after = readFileSync(join(updated, "electron/src/profile.ts"), "utf-8");
  assert.ok(after.endsWith(marker), "the second run overwrote a customised file");
});

// ── done ─────────────────────────────────────────────────────────────

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_CONF_DIR as string, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_DEV_CONFIG_DIR as string, { recursive: true, force: true });
try {
  await clearAllSecrets();
} catch {
  /* the throwaway keychain service may not exist */
}

console.log();
if (failures.length > 0) {
  console.log(`✗ ${failures.length} desktop check(s) failed:`);
  for (const f of failures) console.log(`    ${f}`);
  process.exit(1);
}
console.log("✓ desktop shell checks passed");
