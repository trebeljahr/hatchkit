#!/usr/bin/env node
/*
 * Build the Electron app: the desktop static export, the bundled main and
 * preload, and — with --package — the electron-builder output. One script, so
 * no half of it can be run against the wrong other half.
 *
 *   NEXT_PUBLIC_API_URL=http://localhost:5000 node scripts/build-desktop.mjs
 *   node scripts/build-desktop.mjs --electron-only        # bundle main/preload only
 *   node scripts/build-desktop.mjs --package --dir        # + unpacked app (electron:preview)
 *   node scripts/build-desktop.mjs --package --mac dmg zip --arm64 --x64
 *   node scripts/build-desktop.mjs --package --win --x64
 *   node scripts/build-desktop.mjs --package --linux AppImage deb
 *   node scripts/build-desktop.mjs --open --package --dir # + launch it (for people, never agents)
 *
 * Everything after `--package` is handed to electron-builder unchanged, so
 * `--dir`, `--mac`, `--win`, `--linux`, `--arm64` and `--x64` are its own
 * flags and stay documented by `electron-builder --help`. The flags before
 * `--package` belong to this script.
 *
 * Why each check exists:
 *
 *   1. Its own export directory, `packages/client/out-desktop`. `out/` is
 *      written by the web build and by the mobile build, which bake a
 *      different API URL — packaging whatever sits there ships an app bound to
 *      the wrong server, or to a dead local port.
 *
 *   2. `NEXT_PUBLIC_API_URL` is required and searched for in the emitted
 *      chunks. Next inlines it at build time; unset, every request resolves
 *      against `app://-` and the build stays green.
 *
 *   3. No emitted HTML may reference "./_next". The app is served from the
 *      privileged app:// scheme, which has a root; a relative asset prefix
 *      404s every chunk on every route but `/`.
 *
 *   4. A dev server of this checkout owns `packages/client/.next`, which a
 *      production export also builds in (with `output: "export"` a custom
 *      distDir only moves the export). Building beside it corrupts one of them.
 *
 *   5. After packaging, the asar is listed and must contain only the bundle,
 *      the export and package.json — in particular no `@capacitor/*`, which
 *      the root `dependencies` would otherwise pull in.
 *
 *   6. Every packed package.json must report the root package.json's version.
 *      A release named 0.2.0 that reports 0.1.0 would never be offered its own
 *      update.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// @electron/asar is CommonJS; the default import is its module.exports, which
// is the one form Node's named-export detection cannot get wrong.
import asar from "@electron/asar";
import { build as esbuild } from "esbuild";

import { builderEnvFor, resolveSigning } from "./lib/desktop-release.mjs";
import { ensureElectron } from "./ensure-electron.mjs";

const { extractFile, listPackage } = asar;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const require = createRequire(join(repoRoot, "package.json"));

/** The desktop export's own directory, never the web/mobile `out`. */
export const DESKTOP_OUT_DIR = "out-desktop";
const outPath = resolve(repoRoot, "packages/client", DESKTOP_OUT_DIR);
const electronDist = resolve(repoRoot, "electron/dist");
const trayIcons = resolve(repoRoot, "electron/assets/tray");

const args = process.argv.slice(2);
const packageIndex = args.indexOf("--package");
const shouldPackage = packageIndex !== -1;
const ownArgs = shouldPackage ? args.slice(0, packageIndex) : args;
const builderArgs = shouldPackage ? args.slice(packageIndex + 1) : [];
const electronOnly = ownArgs.includes("--electron-only");
// Launch the unpacked app this run built. For a person trying a build by
// hand: it shows and focuses a real window, so tests and agents never pass it.
const openAfter = ownArgs.includes("--open");

const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const rootVersion = rootPackage.version;

function fail(message) {
  console.error(`\n  build:desktop — ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n  ${message}`);
}

/** The last non-empty stderr lines, repeated under the failure instead of far up the scrollback. */
function stderrTail(stderr, limit = 20) {
  if (typeof stderr !== "string" || stderr.trim() === "") return "";
  return stderr
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "")
    .slice(-limit)
    .join("\n");
}

function run(command, cmdArgs, env = {}) {
  const result = spawnSync(command, cmdArgs, {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  const stderr = `${result.stderr ?? ""}${result.error ? result.error.message : ""}`;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    // `exited with 1` reads identically whether the code does not compile or
    // the machine ran out of file handles, and the difference decides whether
    // you debug or run it again. Say which, and repeat the tail.
    const how =
      result.signal != null
        ? `was killed by ${result.signal}`
        : result.status == null
          ? "exited without a status"
          : `exited with ${result.status}`;
    const tail = stderrTail(stderr);
    fail(`\`${[command, ...cmdArgs].join(" ")}\` ${how}.${tail === "" ? "" : `\n\n${tail}`}`);
  }
}

function walk(dir, predicate, hits = []) {
  if (!existsSync(dir)) return hits;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, predicate, hits);
    else if (predicate(full)) hits.push(full);
  }
  return hits;
}

/**
 * Which platform this run packages for. Taken from electron-builder's own
 * flags, and from the host platform when none is passed — which is what
 * electron-builder itself defaults to.
 */
function packagingChannel() {
  if (builderArgs.includes("--mac")) return "mac";
  if (builderArgs.includes("--win")) return "win";
  if (builderArgs.includes("--linux")) return "linux";
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

/**
 * The environment electron-builder runs in: `DESKTOP_TARGET`, which decides
 * both the update feed and the `-unsigned` suffix in every artifact name
 * (`scripts/lib/desktop-release.mjs`), and the signing credentials — removed
 * for an unsigned build, so a half-configured runner cannot sign one file and
 * not the next.
 *
 * `run` merges an overlay over `process.env`, so a removal has to come back as
 * `undefined`: Node drops an undefined value from the child's environment
 * instead of passing it as the string "undefined".
 */
function builderOverlay(channel, signing) {
  const full = builderEnvFor(channel, process.env, signing);
  const overlay = {};
  for (const [name, value] of Object.entries(full)) {
    if (value !== process.env[name]) overlay[name] = value;
  }
  for (const name of Object.keys(process.env)) {
    if (!(name in full)) overlay[name] = undefined;
  }
  return overlay;
}

if (openAfter && !builderArgs.includes("--dir")) {
  fail("--open launches the unpacked app, so it needs --package --dir.");
}

/*
 * Resolved before anything is built. A half-set credential set — a certificate
 * with no password, an Apple key with no issuer — would otherwise surface as a
 * signing failure at the end of a ten-minute build, or, worse, as an artifact
 * named like a signed one that nothing signed.
 */
let signing = null;
if (shouldPackage) {
  try {
    signing = resolveSigning(packagingChannel(), process.env);
  } catch (error) {
    fail(error.message);
  }
}

// ── 1. Export ────────────────────────────────────────────────────────

if (!electronOnly) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!apiUrl) {
    fail(
      "NEXT_PUBLIC_API_URL is not set.\n" +
        "  It is baked into the bundle at build time — unset, the app resolves every\n" +
        "  request against app://- and fails with a green build.\n\n" +
        "  Against a local API:\n" +
        "    NEXT_PUBLIC_API_URL=http://localhost:5000 pnpm electron:preview\n" +
        "  Against the deployed API:\n" +
        "    NEXT_PUBLIC_API_URL=https://api.example.com pnpm electron:build",
    );
  }
  let apiOrigin;
  try {
    apiOrigin = new URL(apiUrl);
  } catch {
    fail(`NEXT_PUBLIC_API_URL is not a valid URL: ${apiUrl}`);
  }
  if (apiOrigin.pathname !== "/" || apiOrigin.search || apiOrigin.hash) {
    fail(
      `NEXT_PUBLIC_API_URL must be an origin with no path — got ${apiUrl}.\n` +
        "  The clients append /api/... themselves.",
    );
  }

  step("Preflight");
  const devLock = resolve(repoRoot, "packages/client/.next/dev/lock");
  if (existsSync(devLock)) {
    let pid = NaN;
    try {
      pid = Number(JSON.parse(readFileSync(devLock, "utf8"))?.pid);
    } catch {
      pid = NaN;
    }
    let running = false;
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        running = false; // stale lock
      }
    }
    if (running) {
      fail(
        `A Next dev server for this checkout is running (PID ${pid}) and owns\n` +
          "  packages/client/.next, which this build also needs.\n\n" +
          `  Stop it:  kill ${pid}`,
      );
    }
  }
  console.log("    no dev server owns packages/client/.next");

  step(`Building the desktop export against ${apiUrl}`);
  // Stale files from an earlier export would survive into the package.
  rmSync(outPath, { recursive: true, force: true });
  run("pnpm", ["build:client"], {
    // Set, never inherited. NEXT_FILE_EXPORT switches next.config.ts to
    // `output: "export"`; NEXT_EXPORT_DIR puts that export in its own
    // directory instead of the shared `out`, which the web build and
    // Playwright write — the same variable scripts/build-mobile.mjs uses for
    // out-mobile, so one rule in next.config.ts serves both shells.
    NEXT_FILE_EXPORT: "1",
    NEXT_EXPORT_DIR: DESKTOP_OUT_DIR,
    NEXT_PUBLIC_API_URL: apiUrl,
  });

  step("Verifying the export");
  for (const required of ["index.html", "404.html"]) {
    if (!existsSync(join(outPath, required))) {
      fail(`No ${required} in ${outPath} — the export did not land where expected.`);
    }
  }
  const htmlFiles = walk(outPath, (f) => f.endsWith(".html"));
  const relativeRefs = htmlFiles.filter((f) => readFileSync(f, "utf8").includes('"./_next'));
  if (relativeRefs.length) {
    fail(
      'Emitted HTML references "./_next". app://- has a root, and a relative prefix\n' +
        "  404s every chunk on every route but /. Did an assetPrefix get into\n" +
        "  packages/client/next.config.ts?\n" +
        relativeRefs
          .slice(0, 5)
          .map((f) => `    ${relative(repoRoot, f)}`)
          .join("\n"),
    );
  }
  console.log(`    ${htmlFiles.length} HTML files, all root-absolute`);

  const chunkDir = join(outPath, "_next/static/chunks");
  const chunks = walk(chunkDir, (f) => f.endsWith(".js"));
  if (!chunks.some((f) => readFileSync(f, "utf8").includes(apiUrl))) {
    fail(
      `The literal ${apiUrl} does not appear in any emitted chunk.\n` +
        "  NEXT_PUBLIC_API_URL did not reach the client bundle, so the packaged app\n" +
        "  would point at nothing. A build that succeeds here is a binary that fails\n" +
        "  on first use.",
    );
  }
  console.log(`    ${apiUrl} is baked into the bundle`);

  // What this export was built against, for anyone holding the directory later.
  writeFileSync(
    join(outPath, ".build-target.json"),
    `${JSON.stringify({ apiUrl, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

// ── 2. Main and preload ──────────────────────────────────────────────

step("Bundling electron/src → electron/dist");
rmSync(electronDist, { recursive: true, force: true });
const electronPackage = readFileSync(require.resolve("electron/package.json"), "utf8");
const electronVersion = JSON.parse(electronPackage).version;
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  // Electron 42 ships Node 24.
  target: "node24",
  external: ["electron"],
  sourcemap: false,
  logLevel: "warning",
  absWorkingDir: repoRoot,
};
await esbuild({
  ...common,
  entryPoints: ["electron/src/main.ts"],
  outfile: "electron/dist/main.js",
});
// The preload runs sandboxed, where `require` knows only Electron's renderer
// modules — so everything else has to be inlined, and it is.
await esbuild({
  ...common,
  entryPoints: ["electron/src/preload.ts"],
  outfile: "electron/dist/preload.js",
});

// The tray icons sit beside the bundle, where electron/src/tray.ts looks for
// them in both a packaged and an unpackaged run. `files` in the builder config
// packs electron/dist/**, so copying them here is what ships them.
if (!existsSync(join(trayIcons, "trayTemplate.png"))) {
  step("Generating tray icons (build/icon.png → electron/assets/tray)");
  run("node", ["scripts/icons-desktop.mjs"]);
}
if (!existsSync(join(trayIcons, "trayTemplate.png"))) {
  fail("No tray icons in electron/assets/tray after running scripts/icons-desktop.mjs.");
}
cpSync(trayIcons, join(electronDist, "tray"), { recursive: true });
console.log(
  `    electron/dist/main.js, electron/dist/preload.js, electron/dist/tray/` +
    ` (Electron ${electronVersion})`,
);

// ── 3. Package ───────────────────────────────────────────────────────

if (shouldPackage) {
  if (electronOnly) fail("--package needs the export; drop --electron-only.");

  // electron-builder downloads its own Electron zip, but dev:desktop and the
  // e2e harness run node_modules/electron — make sure it is really there.
  ensureElectron();

  const icons =
    process.platform === "win32"
      ? ["build/icon.ico"]
      : process.platform === "darwin"
        ? ["build/icon.icns"]
        : [];
  if (icons.some((icon) => !existsSync(resolve(repoRoot, icon)))) {
    step("Generating desktop icons (build/icon.png → icns/ico)");
    run("node", ["scripts/icons-desktop.mjs"]);
  }

  step(`electron-builder ${builderArgs.join(" ")}`.trim());
  // release/ keeps whatever earlier runs left (another platform's unpacked
  // app, an old dmg). Only what this run wrote is checked: a stale folder must
  // neither pass for this build nor fail it.
  const packagedSince = Date.now() - 2000;
  run(
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.config.mjs",
      "--publish",
      "never",
      ...builderArgs,
    ],
    // Read by electron-builder.config.mjs for the update feed and the artifact
    // names. Set here rather than guessed there, because the config cannot see
    // the flags and cannot tell a stripped credential from an absent one.
    builderOverlay(packagingChannel(), signing),
  );

  step("Verifying the asar");
  const releaseDir = resolve(repoRoot, "release");
  const fresh = (file) => statSync(file).mtimeMs >= packagedSince;
  const asars = walk(releaseDir, (f) => f.endsWith(`${sep}app.asar`) && fresh(f));
  if (!asars.length) fail(`No app.asar written under ${releaseDir} by this run.`);
  const allowed = ["/package.json", "/electron/dist/", "/packages/client/out-desktop/"];
  for (const asar of asars) {
    const entries = listPackage(asar, { isPack: false }).map((e) => e.split(sep).join("/"));
    const unexpected = entries.filter(
      (e) =>
        !allowed.some(
          (a) => e === a.replace(/\/$/, "") || e.startsWith(a) || a.startsWith(`${e}/`),
        ),
    );
    const capacitor = entries.filter((e) => e.includes("@capacitor") || e.includes("capacitor"));
    if (capacitor.length) {
      fail(
        `${relative(repoRoot, asar)} contains Capacitor:\n` +
          `    ${capacitor.slice(0, 5).join("\n    ")}\n` +
          "  electron-builder adds the root production dependencies whatever `files`\n" +
          "  lists. `!node_modules/**` in electron-builder.config.mjs keeps them out.",
      );
    }
    if (unexpected.length) {
      fail(
        `${relative(repoRoot, asar)} contains unexpected entries:\n` +
          `    ${unexpected.slice(0, 10).join("\n    ")}`,
      );
    }
    const bytes = statSync(asar).size;
    const packedVersion = JSON.parse(extractFile(asar, "package.json").toString("utf8")).version;
    if (packedVersion !== rootVersion) {
      fail(
        `${relative(repoRoot, asar)} reports version ${packedVersion}; ` +
          `package.json says ${rootVersion}.`,
      );
    }
    console.log(
      `    ${relative(repoRoot, asar)}: ${entries.length} entries, ` +
        `${(bytes / 1e6).toFixed(1)} MB, ` +
        `no node_modules, version ${packedVersion}`,
    );
  }
}

console.log("\n  Desktop build ready.\n");

if (openAfter) {
  const releaseDir = resolve(repoRoot, "release");
  // electron-builder's unpacked folders: mac(-arm64)/, win-unpacked/, linux-unpacked/.
  const target = readdirSync(releaseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const dir = join(releaseDir, d.name);
      if (process.platform === "darwin") {
        return readdirSync(dir)
          .filter((n) => n.endsWith(".app"))
          .map((n) => join(dir, n));
      }
      if (process.platform === "win32") {
        return readdirSync(dir)
          .filter((n) => n.endsWith(".exe"))
          .map((n) => join(dir, n));
      }
      return d.name === "linux-unpacked" ? [join(dir, "{{projectSlug}}")] : [];
    })
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!target) fail(`No unpacked app for ${process.platform} under ${releaseDir}.`);
  console.log(`  Opening ${relative(repoRoot, target)}\n`);
  if (process.platform === "darwin") {
    spawnSync("open", [target], { stdio: "inherit" });
  } else {
    spawn(target, [], { detached: true, stdio: "ignore" }).unref();
  }
}
