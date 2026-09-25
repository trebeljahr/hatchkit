#!/usr/bin/env node
// Builds the Capacitor mobile bundle. THE ONLY SUPPORTED ENTRY POINT.
//
// Usage:
//   node scripts/build-mobile.mjs                 build every buildable platform
//   node scripts/build-mobile.mjs ios             demand iOS (error if it cannot)
//   node scripts/build-mobile.mjs ios android     demand both
//   node scripts/build-mobile.mjs --dry-run       plan + preflight, build nothing
//   node scripts/build-mobile.mjs --no-sync       build + verify, skip `cap sync`
//   node scripts/build-mobile.mjs --skip-build    reuse an existing out-mobile
//
// Do not run `cap sync` or `cap run ios` directly. Bare Capacitor commands
// copy whatever is currently sitting in the export directory, with whatever
// API URL happens to be baked into it, against whatever bundle identifier the
// native tree was generated with years ago. Every check in this file exists
// because one of those produced an app that built green and was broken on a
// device. The checks are the point; the two spawn calls are incidental.
//
// See scripts/lib/mobile-build.mjs for the testable logic.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MOBILE_OUT_DIR,
  MOBILE_PLATFORMS,
  assertApiUrlInChunks,
  assertNoRelativeAssetPrefix,
  checkIdentityDrift,
  devServerOwnsBuildDir,
  isExecutable,
  isLoopbackHost,
  parseCapacitorConfig,
  parseMobileArgs,
  planPlatforms,
  readNativeIdentity,
  validateApiUrl,
} from "./lib/mobile-build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = join(ROOT, "packages", "client");
const OUT_DIR = join(CLIENT_DIR, MOBILE_OUT_DIR);
const OUT_DIR_REL = relative(ROOT, OUT_DIR);
const EXPECTED_WEB_DIR = `packages/client/${MOBILE_OUT_DIR}`;

// ── output ────────────────────────────────────────────────

function fail(headline, detail) {
  const lines = Array.isArray(detail) ? detail : String(detail).split("\n");
  console.error(`\n  ✗ ${headline}\n`);
  for (const line of lines) console.error(line === "" ? "" : `    ${line}`);
  console.error("");
}

function die(headline, detail) {
  fail(headline, detail);
  process.exit(1);
}

const ok = (msg) => console.log(`  ✓ ${msg}`);
const note = (msg) => console.log(`  · ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);

// ── process helpers ───────────────────────────────────────

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function runInherit(cmd, args, env, cwd = ROOT) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd, env });
  return !res.error && res.status === 0;
}

// ── toolchain probes ──────────────────────────────────────
//
// These shell out, so they live here and not in the lib: planPlatforms takes
// their results as plain data so the planning matrix stays unit-testable.

function probeIosToolchain() {
  const reasons = [];

  if (process.platform !== "darwin") {
    reasons.push(
      `this host runs ${process.platform}; an iOS build needs macOS with Xcode`,
    );
  } else {
    const developerDir = capture("xcode-select", ["-p"]);
    if (!developerDir.ok || !existsSync(developerDir.out.trim())) {
      reasons.push(
        "`xcode-select -p` did not resolve to an installed developer directory — " +
          "install Xcode, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`",
      );
    } else {
      // The Command Line Tools alone satisfy xcode-select but ship no
      // simulator runtime, and the resulting failure comes out of xcodebuild
      // as an unrelated destination error.
      const sims = capture("xcrun", ["simctl", "list", "devices", "available"]);
      if (!sims.ok || !/\biPhone\b/.test(sims.out)) {
        reasons.push(
          "`xcrun simctl list devices available` lists no iPhone — " +
            "download a simulator runtime in Xcode > Settings > Components",
        );
      }
    }
  }

  if (!existsSync(join(ROOT, "ios", "App", "App.xcodeproj"))) {
    reasons.push("ios/App/App.xcodeproj is missing — the iOS tree is half-generated");
  }

  return { ok: reasons.length === 0, reasons };
}

function probeAndroidToolchain() {
  const reasons = [];

  // `java -version` writes to stderr and exits 0; we only care about the exit.
  if (!capture("java", ["-version"]).ok) {
    reasons.push("`java -version` failed — install a JDK (17 or newer) and put it on PATH");
  }

  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) {
    reasons.push(
      "neither ANDROID_HOME nor ANDROID_SDK_ROOT is set — point one at the Android SDK " +
        "(Android Studio > Settings > Languages & Frameworks > Android SDK shows the path)",
    );
  } else if (!existsSync(sdk)) {
    reasons.push(`ANDROID_HOME/ANDROID_SDK_ROOT points at ${sdk}, which does not exist`);
  }

  const gradlew = join(ROOT, "android", "gradlew");
  if (!existsSync(gradlew)) {
    reasons.push("android/gradlew is missing — the Android tree is half-generated");
  } else if (!isExecutable(gradlew)) {
    reasons.push(
      "android/gradlew is not executable — `chmod +x android/gradlew` " +
        "(the mode bit is lost on checkouts made on a filesystem without it)",
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Ask the Capacitor CLI to load capacitor.config.ts.
 *
 * Warning, not an error: on a machine where the CLI binary itself cannot be
 * resolved this tells us nothing about the config, and a config the CLI really
 * cannot load fails loudly in `cap sync` a few seconds later anyway. The value
 * here is seeing it before a five-minute Next build, not blocking on it.
 */
function probeCapacitorCli() {
  const res = capture("npx", ["--no-install", "cap", "ls"], { cwd: ROOT });
  return { ok: res.ok, out: res.out.trim() };
}

/**
 * Check every Capacitor plugin in the dependency set ships a Package.swift.
 *
 * Capacitor 6+ resolves iOS plugins through Swift Package Manager. A plugin
 * published before the SPM migration has only a .podspec, and the failure
 * surfaces much later as an SPM resolution error naming a checkout path rather
 * than the package — at which point it looks like a corrupt Xcode cache.
 *
 * A package is a plugin when its own package.json carries a `capacitor` field
 * with an `ios` section. The runtime packages are excluded by name: they are
 * dependencies of every plugin, not plugins themselves.
 */
const NON_PLUGIN_CAPACITOR_PACKAGES = new Set([
  "@capacitor/core",
  "@capacitor/cli",
  "@capacitor/ios",
  "@capacitor/android",
  "@capacitor/assets",
]);

function probePluginSpmSupport(pkg) {
  const modules = join(ROOT, "node_modules");
  if (!existsSync(modules)) {
    return { ran: false, checked: [], missing: [] };
  }

  const names = Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  });

  const checked = [];
  const missing = [];
  for (const name of names) {
    if (NON_PLUGIN_CAPACITOR_PACKAGES.has(name)) continue;
    const dir = join(modules, ...name.split("/"));
    const metaPath = join(dir, "package.json");
    if (!existsSync(metaPath)) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      continue;
    }
    if (!meta.capacitor?.ios) continue;
    checked.push(name);
    if (!existsSync(join(dir, "Package.swift"))) missing.push(name);
  }

  return { ran: true, checked, missing };
}

// ── loopback reachability ─────────────────────────────────

function probeListening(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

// ── main ──────────────────────────────────────────────────

const args = parseMobileArgs(process.argv.slice(2));

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n")
    .slice(1, 19)
    .map((line) => line.replace(/^\/\/ ?/, "  "))
    .join("\n"));
  process.exit(0);
}

if (args.errors.length > 0) {
  die("Bad arguments", args.errors);
}

console.log(`\n  Mobile build${args.dryRun ? " (dry run)" : ""}`);
console.log(`  Requested: ${args.platforms.length > 0 ? args.platforms.join(", ") : "auto-detect"}\n`);

// 1. NEXT_PUBLIC_API_URL ------------------------------------------------------
//
// Refuse before anything expensive. Next inlines NEXT_PUBLIC_* at build time,
// so this value is not configurable after the fact: it is compiled into the
// binary the user installs.
const apiUrlRaw = process.env.NEXT_PUBLIC_API_URL;
const apiUrlCheck = validateApiUrl(apiUrlRaw);
if (!apiUrlCheck.ok) {
  die("NEXT_PUBLIC_API_URL is not usable for a mobile build", [
    apiUrlRaw === undefined
      ? "It is not set."
      : `It is set to "${apiUrlRaw}" — ${apiUrlCheck.error}.`,
    "",
    "Next.js inlines NEXT_PUBLIC_* into the bundle during `next build`. There is",
    "no runtime environment in a mobile app to fix it in afterwards.",
    "",
    "Without an absolute URL, every fetch resolves against the app's own document",
    "origin — capacitor://localhost on iOS, https://localhost on Android. The build",
    "succeeds, the app installs, and every request 404s on a device with no visible",
    "error. This is the single most common way a mobile release ships dead.",
    "",
    "Set it to the deployed API origin, for example:",
    "",
    "  NEXT_PUBLIC_API_URL=https://api.example.com pnpm build:mobile",
  ]);
}
const apiUrl = apiUrlRaw;
ok(`NEXT_PUBLIC_API_URL = ${apiUrl}`);

// 2. dev server owning .next --------------------------------------------------
//
// Under output: "export" Next treats a custom distDir as the OUT directory and
// forces the build directory back to .next, so the export cannot be given a
// build dir of its own. With --skip-build we never touch .next, so a running
// dev server is harmless there and the check is downgraded to a note.
const devServer = devServerOwnsBuildDir(CLIENT_DIR);
if (devServer.owned) {
  if (args.skipBuild) {
    note("a dev server appears to own packages/client/.next (not building, so ignoring)");
  } else {
    die("A dev server owns packages/client/.next", [
      "Evidence:",
      ...devServer.evidence.map((line) => `  - ${line}`),
      "",
      "A static export cannot use its own build directory: with output: \"export\"",
      "Next treats distDir as the OUT dir and writes the build to .next regardless.",
      "Running both at once races the manifests — the build fails on a chunk the dev",
      "server just rewrote, or worse, succeeds against a half-written manifest.",
      "",
      "Stop the dev server (Ctrl-C in the `pnpm dev` terminal), or give dev its own",
      "checkout, then re-run this command.",
    ]);
  }
}

// 3. toolchain preflight + platform plan --------------------------------------
const present = {
  ios: existsSync(join(ROOT, "ios")),
  android: existsSync(join(ROOT, "android")),
};
const toolchain = {
  ios: present.ios || args.platforms.includes("ios")
    ? probeIosToolchain()
    : { ok: false, reasons: ["no ios/ tree in this repo"] },
  android: present.android || args.platforms.includes("android")
    ? probeAndroidToolchain()
    : { ok: false, reasons: ["no android/ tree in this repo"] },
};

const plan = planPlatforms({ requested: args.platforms, present, toolchain });

if (plan.errors.length > 0) {
  die("Cannot build the platforms you asked for", plan.errors.join("\n").split("\n"));
}

if (plan.build.length === 0) {
  die("No platform is buildable here", [
    ...(plan.skipped.length > 0
      ? [
          ...plan.skipped.flatMap(({ platform, reasons }) => [
            `${platform}:`,
            ...reasons.map((r) => `  - ${r}`),
          ]),
          "",
          "Install a missing toolchain listed above, or build on a machine that has one.",
        ]
      : [
          "Neither ios/ nor android/ exists in this repo.",
          "",
          "Run `pnpm cap:add:ios` or `pnpm cap:add:android` once and commit the tree.",
        ]),
  ]);
}

ok(`platforms to build: ${plan.build.join(", ")}`);
for (const { platform, reasons } of plan.skipped) {
  warn(`skipping ${platform} (not asked for, toolchain unavailable)`);
  for (const reason of reasons) note(`  ${reason}`);
}

const capCli = probeCapacitorCli();
if (capCli.ok) {
  ok("capacitor.config.ts loads (`npx cap ls`)");
} else {
  warn("`npx cap ls` did not succeed — `cap sync` may fail for the same reason");
  for (const line of capCli.out.split("\n").filter(Boolean).slice(0, 6)) {
    note(`  ${line}`);
  }
}

// 4. config + version, and the identity drift assertion -----------------------
const capConfigPath = join(ROOT, "capacitor.config.ts");
if (!existsSync(capConfigPath)) {
  die("capacitor.config.ts is missing", [
    "This repo cannot build a mobile app without it. Restore it from git.",
  ]);
}
const capConfig = parseCapacitorConfig(readFileSync(capConfigPath, "utf8"));
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// The export directory is per-target for a reason (see MOBILE_OUT_DIR). If
// webDir still points at the shared `out`, `cap sync` would package whatever a
// web build or a Playwright run last left there — a green build shipping the
// wrong bundle, which is the exact failure the split directory prevents.
const webDir = (capConfig.webDir ?? "").replace(/\/+$/, "");
if (webDir !== EXPECTED_WEB_DIR) {
  die("capacitor.config.ts webDir does not point at the mobile export", [
    `webDir is "${capConfig.webDir}", but this script exports to "${EXPECTED_WEB_DIR}".`,
    "",
    "`cap sync` copies webDir verbatim. Pointed at packages/client/out it would",
    "package whatever the web build or the last Playwright run left behind —",
    "a mobile app built from a test fixture, with no error anywhere.",
    "",
    `Set webDir: "${EXPECTED_WEB_DIR}" in capacitor.config.ts.`,
  ]);
}
ok(`webDir = ${webDir}`);

const native = readNativeIdentity({ projectDir: ROOT, platforms: plan.build });
const drift = checkIdentityDrift({
  config: capConfig,
  pkgVersion: rootPkg.version,
  native,
});
if (drift.length > 0) {
  die("Native app identity has drifted from capacitor.config.ts / package.json", [
    ...drift.map((problem) => `- ${problem}`),
    "",
    "@capacitor/cli writes these values into the native trees exactly once, during",
    "`cap add`. `cap sync` never revisits them — it only copies web assets and",
    "refreshes the plugin list. So a later edit to appId, appName, or the package",
    "version reaches nothing native, and the app ships under the old identifier:",
    "a different app to App Store Connect, and a rejected (or misfiled) upload on",
    "Play.",
    "",
    "Fix each file above by hand, or regenerate the tree with `pnpm cap:add:<platform>`",
    "and commit the result. Then re-run this command.",
  ]);
}
ok(`identity matches: appId ${capConfig.appId}, appName ${capConfig.appName}, version ${rootPkg.version}`);

const spm = probePluginSpmSupport(rootPkg);
if (!spm.ran) {
  note("node_modules is absent — skipped the Capacitor plugin SPM check");
} else if (spm.missing.length > 0) {
  warn(`Capacitor plugins without a Package.swift: ${spm.missing.join(", ")}`);
  note("  iOS resolves plugins through SwiftPM; these will fail during SPM resolution");
  note("  with an error naming a checkout path rather than the package. Upgrade them");
  note("  to a Capacitor 6+ release, or remove them.");
} else if (spm.checked.length > 0) {
  ok(`${spm.checked.length} Capacitor plugin(s) ship a Package.swift`);
}

if (args.dryRun) {
  console.log("");
  note("--dry-run: stopping before the build");
  printSummary({ exportNote: "not built (--dry-run)", synced: [] });
  process.exit(0);
}

// 5. build --------------------------------------------------------------------
if (args.skipBuild) {
  if (!existsSync(OUT_DIR)) {
    die("--skip-build was given but there is no export to reuse", [
      `${OUT_DIR_REL} does not exist.`,
      "",
      "Run `pnpm build:mobile` first, then re-run with --skip-build.",
    ]);
  }
  note(`--skip-build: reusing ${OUT_DIR_REL}`);
} else {
  const buildEnv = { ...process.env };
  buildEnv.NEXT_FILE_EXPORT = "1";
  buildEnv.NEXT_EXPORT_DIR = MOBILE_OUT_DIR;
  buildEnv.NEXT_PUBLIC_API_URL = apiUrl;
  // Let Next set NODE_ENV. An inherited NODE_ENV=development turns the export
  // into a development bundle — unminified, React in dev mode, and with the
  // export branch of next.config.ts skipped entirely.
  delete buildEnv.NODE_ENV;
  // Never let a dev-server URL leak into a bundle build (see the sync step).
  delete buildEnv.CAP_DEV_URL;

  // @starter/shared resolves through package.json `exports` to dist/, so a
  // fresh checkout has to build it before the client can compile. Same reason
  // scripts/dev.mjs does it.
  if (existsSync(join(ROOT, "packages", "shared"))) {
    console.log("\n  Building @starter/shared...");
    if (!runInherit("pnpm", ["--filter", "@starter/shared", "run", "build"], buildEnv)) {
      die("Building @starter/shared failed", ["See the output above."]);
    }
  }

  console.log(`\n  Exporting packages/client to ${MOBILE_OUT_DIR}/...\n`);
  if (!runInherit("pnpm", ["--filter", "@starter/client", "run", "build"], buildEnv)) {
    die("`next build` failed", ["See the output above."]);
  }
}

if (!existsSync(OUT_DIR)) {
  die("The export directory was not produced", [
    `Expected ${OUT_DIR_REL} after the build, and it is not there.`,
    "",
    "next.config.ts must honour NEXT_EXPORT_DIR under NEXT_FILE_EXPORT=1 —",
    "with output: \"export\", Next treats distDir as the OUT directory.",
  ]);
}

// 6. verify the export --------------------------------------------------------
const urlCheck = assertApiUrlInChunks({ outDir: OUT_DIR, apiUrl });
if (!urlCheck.ok) {
  die("The API URL never reached the bundle", [
    `Scanned ${urlCheck.scanned} JS file(s) under ${OUT_DIR_REL}/_next and found no`,
    `occurrence of "${apiUrl}".`,
    "",
    "Next inlines NEXT_PUBLIC_* at build time, so the literal must be in an emitted",
    "chunk. Its absence means the value never reached the compiler — a shadowing",
    ".env file, a different variable name in the client code, or an env that got",
    "dropped on the way into the child process.",
    "",
    "Shipping this bundle produces an app that resolves every request against its",
    "own document origin and fails on every device.",
  ]);
}
ok(`API URL is inlined (${urlCheck.scanned} chunk(s) scanned)`);

const prefixCheck = assertNoRelativeAssetPrefix({ outDir: OUT_DIR });
if (!prefixCheck.ok) {
  die("The export uses a relative assetPrefix", [
    `${prefixCheck.offenders.length} of ${prefixCheck.scanned} HTML file(s) reference "./_next".`,
    ...prefixCheck.offenders.slice(0, 5).map((f) => `  - ${relative(ROOT, f)}`),
    ...(prefixCheck.offenders.length > 5 ? [`  ... and ${prefixCheck.offenders.length - 5} more`] : []),
    "",
    "assetPrefix: \"./\" is correct for Electron, which loads the export over file://",
    "from a real directory tree. It is wrong for Capacitor: the WebView serves from",
    "capacitor://localhost/ with trailingSlash routing, so /settings/index.html",
    "resolves ./_next/... to /settings/_next/..., which does not exist. The root",
    "route renders and every nested route is a blank screen.",
    "",
    "Drop assetPrefix for the mobile export in packages/client/next.config.ts",
    "(NEXT_EXPORT_DIR is set to " + MOBILE_OUT_DIR + " for this build).",
  ]);
}
ok(`no relative assetPrefix (${prefixCheck.scanned} HTML file(s) scanned)`);

// 7. cap sync -----------------------------------------------------------------
const synced = [];
if (args.noSync) {
  note("--no-sync: leaving the native trees untouched");
} else {
  for (const platform of plan.build) {
    const syncEnv = { ...process.env };
    syncEnv.NEXT_PUBLIC_API_URL = apiUrl;
    // capacitor.config.ts adds `server.url` when CAP_DEV_URL is set, so a
    // stale value left over from `pnpm dev:ios` in the same shell would bake a
    // dev-server URL into a release bundle: an app that works perfectly on the
    // machine that built it and shows a blank WebView everywhere else. Delete
    // it rather than trusting the shell.
    delete syncEnv.CAP_DEV_URL;

    console.log(`\n  cap sync ${platform}...\n`);
    if (!runInherit("npx", ["cap", "sync", platform], syncEnv)) {
      die(`\`cap sync ${platform}\` failed`, ["See the output above."]);
    }
    synced.push(platform);
  }
}

// 8. reachability warning -----------------------------------------------------
//
// Warn only. A loopback API URL is legitimate for a Simulator build against a
// local server, and the server may simply not be running right now.
const { url } = validateApiUrl(apiUrl);
if (isLoopbackHost(url.hostname)) {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const listening = await probeListening(url.hostname, port);
  if (!listening) {
    warn(`nothing is listening on ${url.hostname}:${port}`);
    note("  the API URL baked into this bundle is a loopback address, and nothing");
    note("  answers it right now. A physical device resolves loopback to itself, so");
    note("  this build can only ever work on a simulator or emulator sharing this host.");
  }
}

printSummary({
  exportNote: args.skipBuild ? "reused (--skip-build)" : "built",
  synced,
});

function printSummary({ exportNote, synced }) {
  console.log("\n  Summary");
  console.log(`    platforms:         ${plan.build.join(", ") || "none"}`);
  if (plan.skipped.length > 0) {
    for (const { platform, reasons } of plan.skipped) {
      console.log(`    skipped ${platform}: ${reasons[0] ?? "toolchain unavailable"}`);
    }
  }
  console.log(`    export:            ${OUT_DIR_REL} (${exportNote})`);
  console.log(`    cap sync:          ${synced.length > 0 ? synced.join(", ") : "not run"}`);
  console.log(`    API URL:           ${apiUrl}\n`);
}
