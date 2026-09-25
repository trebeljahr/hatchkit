#!/usr/bin/env node
// scripts/cap-add.mjs — `pnpm cap:add:ios` / `pnpm cap:add:android`.
//
// Usage:
//   node scripts/cap-add.mjs ios
//   node scripts/cap-add.mjs android
//   node scripts/cap-add.mjs ios --overlay-only    Skip `cap add`, re-apply
//                                                  the overlay only
//   node scripts/cap-add.mjs android --dry-run     Report, write nothing
//
// `npx cap add <platform>` generates a stock native project. A stock native
// project is not the one this repo needs: it cannot reach a local http API,
// rotates freely, and reports version 1.0 forever. The missing settings have
// no home in capacitor.config.ts - they exist only inside the generated tree.
//
// So the tree is COMMITTED, and this script is the only supported way to
// produce or repair it: run `cap add` when the tree is absent, then apply
// scripts/lib/native-overlay.mjs on top, idempotently, and say exactly which
// files changed. Re-running it on an existing tree is safe and is the
// documented repair path after a Capacitor upgrade.
//
// Exit 0 on success, 1 on any error.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OVERLAY_FILES,
  addAtsLocalhostException,
  addDebugNetworkSecurityConfigToManifest,
  androidNetworkSecurityConfigXml,
  debugManifestStub,
  installGradleSigningConfig,
  setCurrentProjectVersion,
  setGradleVersionCode,
  setGradleVersionName,
  setMarketingVersion,
  setSupportedOrientations,
} from "./lib/native-overlay.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORMS = ["ios", "android"];
const KNOWN_FLAGS = ["--overlay-only", "--dry-run"];

// The web export `cap add` copies in. Read from capacitor.config.ts rather
// than hardcoded, so this check cannot drift away from what Capacitor
// actually reads.
const FALLBACK_WEB_DIR = "packages/client/out-mobile";

// --- argv -------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("-"));
const positional = argv.filter((a) => !a.startsWith("-"));
const platform = positional[0];
const overlayOnly = flags.includes("--overlay-only");
const dryRun = flags.includes("--dry-run");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

for (const flag of flags) {
  if (!KNOWN_FLAGS.includes(flag)) {
    fail(`unknown flag ${flag}\n  known flags: ${KNOWN_FLAGS.join(", ")}`);
  }
}

// Refuse without a platform. Defaulting to one of them would, on the wrong
// machine, start a multi-minute Xcode or Gradle bootstrap nobody asked for.
if (!platform) {
  fail(
    "no platform given\n" +
      `  usage: node scripts/cap-add.mjs <${PLATFORMS.join("|")}> [--overlay-only] [--dry-run]`,
  );
}
if (!PLATFORMS.includes(platform)) {
  fail(`unknown platform "${platform}" - expected one of: ${PLATFORMS.join(", ")}`);
}

// --- reporting --------------------------------------------------------

const results = [];

// changed/created -> ✓, already applied -> ·, missing -> ✗.
function record(status, relPath, note) {
  results.push({ status, relPath, note });
}

const STATUS_LABEL = {
  changed: ["✓", dryRun ? "would change   " : "changed        "],
  created: ["✓", dryRun ? "would create   " : "created        "],
  applied: ["·", "already applied"],
  missing: ["✗", "missing        "],
};

function printReport() {
  console.log("");
  for (const { status, relPath, note } of results) {
    const [mark, label] = STATUS_LABEL[status];
    console.log(`  ${mark} ${label}  ${relPath}${note ? `  (${note})` : ""}`);
  }
}

// --- file helpers -----------------------------------------------------

// Read → transform → compare → write. The compare is what makes a re-run
// report "already applied" instead of rewriting a committed file with
// identical bytes and leaving a confusing dirty tree behind.
function editFile(relPath, transform, note) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    record("missing", relPath, note);
    return;
  }
  const before = readFileSync(abs, "utf8");
  const after = transform(before);
  if (after === before) {
    record("applied", relPath, note);
    return;
  }
  if (!dryRun) writeFileSync(abs, after, "utf8");
  record("changed", relPath, note);
}

// Create a file when absent, patch it when present, and report exactly one
// line either way. An existing file is never replaced wholesale: it may carry
// rules someone added on purpose, and silently overwriting them is the kind
// of loss that is only noticed weeks later.
function ensureFile(relPath, stub, transform, note) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    if (!dryRun) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, stub, "utf8");
    }
    record("created", relPath, note);
    return;
  }
  editFile(relPath, transform, note);
}

// --- project facts ----------------------------------------------------

function readJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
}

function readCapacitorConfigText() {
  const abs = join(ROOT, "capacitor.config.ts");
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

// Textual reads, not an import: capacitor.config.ts is TypeScript and
// evaluating it here would need a loader and would run its CAP_DEV_URL
// branch. Nothing below rewrites these values - `cap add` sets appId and
// appName correctly once, and drift between config and native tree is
// asserted by scripts/build-mobile.mjs, which is the one place that check
// belongs.
function readConfigString(configText, key, fallback) {
  const match = configText.match(new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
  return match ? match[1] : fallback;
}

// --- overlays ---------------------------------------------------------

function applyIosOverlay(version) {
  editFile(
    "ios/App/App/Info.plist",
    (source) => setSupportedOrientations(addAtsLocalhostException(source)),
    "ATS localhost exception + supported orientations",
  );

  editFile(
    "ios/App/App.xcodeproj/project.pbxproj",
    (source) => {
      const marketing = setMarketingVersion(source, version);
      // CURRENT_PROJECT_VERSION (CFBundleVersion) is only touched when the
      // caller supplies one. Writing a default here would reset a build
      // number that CI already incremented, and App Store Connect then
      // rejects the upload as a duplicate.
      const build = process.env.IOS_BUILD_NUMBER;
      if (!build) return marketing.source;
      return setCurrentProjectVersion(marketing.source, build).source;
    },
    process.env.IOS_BUILD_NUMBER
      ? `MARKETING_VERSION=${version}, CURRENT_PROJECT_VERSION=${process.env.IOS_BUILD_NUMBER}`
      : `MARKETING_VERSION=${version}; set IOS_BUILD_NUMBER to also wire the build number`,
  );
}

function applyAndroidOverlay(version) {
  editFile(
    "android/app/build.gradle",
    (source) => {
      const signed = installGradleSigningConfig(source);
      const named = setGradleVersionName(signed, version);
      const coded = setGradleVersionCode(named.source, 1);
      return coded.source;
    },
    `optional release signing + versionName=${version} + versionCode`,
  );

  // Both files belong to the DEBUG source set. The manifest merger overlays
  // them onto app/src/main for debug builds only, so the cleartext exception
  // cannot reach a release build.
  ensureFile(
    "android/app/src/debug/res/xml/network_security_config.xml",
    androidNetworkSecurityConfigXml(),
    // An existing config is left exactly as it is. Its host list is a
    // security decision, not something this script should quietly widen.
    (source) => source,
    "debug-only cleartext for localhost / 127.0.0.1 / 10.0.2.2",
  );
  ensureFile(
    "android/app/src/debug/AndroidManifest.xml",
    debugManifestStub(),
    // A debug manifest that already exists (previous run, or hand-written for
    // something else) still needs the attribute, or the xml file above is
    // never read and the cleartext block returns without explanation.
    addDebugNetworkSecurityConfigToManifest,
    "debug source set <application> override",
  );
}

// --- closing note -----------------------------------------------------

// Driven entirely off OVERLAY_FILES so this message can never drift from the
// manifest the library documents.
function printClosingNote() {
  const files = OVERLAY_FILES[platform];
  const root = `${platform}/`;
  const list = (paths) => paths.map((p) => `      ${root}${p}`).join("\n");

  console.log(`
  Commit the whole ${root} tree. A fresh checkout must be able to build the
  real app without re-running this script.

  Tracked but regenerated - expect these to change on any \`cap sync\` or
  asset regeneration, and commit the result:
${list(files.generatedTracked)}

  Regenerated and NOT committed - a checkout that has never run the mobile
  build does not have them, and Xcode / Gradle then fail with a missing-file
  error that reads like a corrupt project. Build first, open second:
${list(files.generatedUntracked)}
`);

  if (platform === "ios") {
    console.log(
      "  Note: App/CapApp-SPM/Package.swift hardcodes the package manager's\n" +
        "  content-addressed store paths. Any lockfile refresh renames those\n" +
        "  directories and the committed file then points at paths that no longer\n" +
        "  exist. Re-run the mobile build after any install, before opening the\n" +
        "  iOS project directly.\n",
    );
  }
}

// --- main -------------------------------------------------------------

function main() {
  const pkg = readJson("package.json");
  const version = pkg.version;
  if (!version) fail("package.json has no `version` - nothing to wire the native version to");

  const configText = readCapacitorConfigText();
  const appId = readConfigString(configText, "appId", "(unset)");
  const appName = readConfigString(configText, "appName", "(unset)");
  const webDir = readConfigString(configText, "webDir", FALLBACK_WEB_DIR);

  console.log(`\n  Platform: ${platform}`);
  console.log(`  appId:    ${appId}`);
  console.log(`  appName:  ${appName}`);
  console.log(`  version:  ${version}`);
  if (dryRun) console.log("  Mode:     dry run - nothing is written");

  const platformDir = join(ROOT, platform);
  const platformExists = existsSync(platformDir);

  if (overlayOnly) {
    console.log("  Step:     --overlay-only, skipping `cap add`");
  } else if (platformExists) {
    // Never re-extract over a committed tree. `cap add` on an existing
    // directory either refuses or overwrites, and overwriting throws away
    // every overlay edit plus anything else that was committed with it.
    console.log(`  Step:     ${platform}/ already exists - skipping \`cap add\``);
  } else if (dryRun) {
    console.log(`  Step:     would run \`npx cap add ${platform}\``);
  } else {
    // `cap add` copies the web export into the native tree. With no export it
    // produces an app that opens to a blank screen and reports no error, so
    // stop here with the command that fixes it.
    if (!existsSync(join(ROOT, webDir))) {
      fail(
        `web dir not found: ${webDir}\n` +
          "  `cap add` copies the web build into the native tree; without it the\n" +
          "  generated app opens to a blank screen and says nothing about why.\n" +
          "  Run this first:  pnpm build:mobile --no-sync",
      );
    }
    console.log(`  Step:     npx cap add ${platform}\n`);
    execFileSync("npx", ["cap", "add", platform], { cwd: ROOT, stdio: "inherit" });
  }

  if (!existsSync(platformDir)) {
    // Only reachable under --overlay-only or --dry-run; the overlay still
    // runs so the report lists every target as missing rather than pretending
    // there was nothing to do.
    console.log(`\n  ${platform}/ is not present - the overlay has no files to edit.`);
  }

  if (platform === "ios") applyIosOverlay(version);
  else applyAndroidOverlay(version);

  printReport();

  const missing = results.filter((r) => r.status === "missing");
  if (missing.length > 0) {
    console.log(
      `\n  ${missing.length} target file(s) missing - the ${platform}/ tree is not\n` +
        `  generated. Run: node scripts/cap-add.mjs ${platform}`,
    );
  }

  printClosingNote();
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
