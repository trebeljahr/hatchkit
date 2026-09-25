/**
 * Mobile build-script unit tests.
 *
 * `starter/scripts/build-mobile.mjs` is the only supported entry point for
 * a mobile build, and every guard it performs exists because the failure
 * it prevents produces a WORKING-LOOKING app that is quietly wrong:
 *
 *   · an unset NEXT_PUBLIC_API_URL ships a bundle that resolves every
 *     request against its own document origin, fails on device, and
 *     builds green;
 *   · an identifier changed in capacitor.config.ts never reaches the
 *     native trees, because `cap add` writes them once and `cap sync`
 *     never revisits them — so the app ships under the old bundle id;
 *   · a relative asset prefix loads fine at `/` and breaks every nested
 *     route;
 *   · a named platform whose toolchain is missing must be an error while
 *     an auto-detected one must be a skip, or a Mac with no Android SDK
 *     cannot run a bare `pnpm build:mobile` at all.
 *
 * The logic lives in `starter/scripts/lib/mobile-build.mjs`, which imports
 * only node: builtins precisely so this file can import it straight out of
 * the template with no install step.
 *
 * Run: pnpm --filter hatchkit test:mobile-build
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
const LIB = join(STARTER, "scripts/lib/mobile-build.mjs");
if (!existsSync(LIB)) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

/* The surface this file drives. The lib is plain ESM inside the template
 * (no build step, node: builtins only), so it is imported by path and the
 * shape is declared here rather than inferred — which also keeps this test
 * honest about what the build script is actually contracted to expose. */
interface Probe {
  ok: boolean;
  reasons: string[];
}
interface MobileBuildLib {
  parseMobileArgs(argv: string[]): { platforms: string[]; noSync: boolean };
  validateApiUrl(value: string): { ok: boolean };
  isLoopbackHost(hostname: string): boolean;
  planPlatforms(input: {
    requested?: string[];
    present?: Record<string, boolean>;
    toolchain?: Record<string, Probe>;
  }): { build: string[]; skipped: { platform: string; reasons: string[] }[]; errors: string[] };
  checkIdentityDrift(input: {
    config: { appId?: string; appName?: string };
    pkgVersion?: string;
    native: Record<string, unknown>;
  }): string[];
  parseCapacitorConfig(source: string): { appId?: string; appName?: string; webDir?: string };
  parsePbxproj(source: string): { bundleIds: string[]; marketingVersions: string[] };
  parseAppBuildGradle(source: string): {
    namespace?: string;
    applicationId?: string;
    versionName?: string;
    versionCode?: string;
  };
  parseStringsXml(source: string): Record<string, string>;
  parseInfoPlist(source: string): Record<string, string>;
  assertApiUrlInChunks(input: { outDir: string; apiUrl: string }): {
    ok: boolean;
    scanned: number;
    matchedFile?: string;
  };
  assertNoRelativeAssetPrefix(input: { outDir: string }): {
    ok: boolean;
    scanned: number;
    offenders: string[];
  };
  devServerOwnsBuildDir(clientDir: string): { owned: boolean; evidence: string[] };
}

const lib = (await import(pathToFileURL(LIB).href)) as unknown as MobileBuildLib;

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${msg}`);
}
function section(name: string): void {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}`);
}

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf-8");
}

const scratch = mkdtempSync(join(tmpdir(), "mobile-build-"));

try {
  // ── argv + API URL ──────────────────────────────────────────────────
  section("argv and NEXT_PUBLIC_API_URL");
  {
    const a = lib.parseMobileArgs(["ios", "--no-sync"]);
    assert(a.platforms.join(",") === "ios", "a named platform is parsed");
    assert(a.noSync === true, "--no-sync is parsed");

    const both = lib.parseMobileArgs([]);
    assert(both.platforms.length === 0, "no platform named means auto-detect");

    assert(lib.validateApiUrl("https://api.example.com").ok, "an absolute https URL is accepted");
    assert(lib.validateApiUrl("http://localhost:5159").ok, "a loopback http URL is accepted");
    assert(!lib.validateApiUrl("").ok, "an empty API URL is refused");
    assert(!lib.validateApiUrl("/api").ok, "a relative API URL is refused");
    assert(
      !lib.validateApiUrl("api.example.com").ok,
      "a scheme-less API URL is refused (it would resolve against the document origin)",
    );

    assert(lib.isLoopbackHost("localhost"), "localhost is loopback");
    assert(lib.isLoopbackHost("127.0.0.1"), "127.0.0.1 is loopback");
    assert(!lib.isLoopbackHost("api.example.com"), "a real host is not loopback");
  }

  // ── platform planning: demand vs offer ──────────────────────────────
  section("planPlatforms — a named platform is a demand, a detected one an offer");
  {
    const ok = { ok: true, reasons: [] };
    const broken = { ok: false, reasons: ["no JDK on PATH", "ANDROID_HOME is not set"] };

    // A Mac with both trees committed but no Android SDK, running a bare
    // `pnpm build:mobile`. Android must be SKIPPED, not fail the run —
    // both trees are committed, so every checkout has an android/.
    const bare = lib.planPlatforms({
      requested: [],
      present: { ios: true, android: true },
      toolchain: { ios: ok, android: broken },
    });
    assert(bare.errors.length === 0, "an auto-detected platform with no toolchain is not an error");
    assert(bare.build.join(",") === "ios", "only the buildable platform is built");
    assert(
      bare.skipped.length === 1 && bare.skipped[0].platform === "android",
      "the unbuildable platform is reported as skipped",
    );
    assert(
      bare.skipped[0].reasons.join(" ").includes("ANDROID_HOME"),
      "the skip carries every reason, so the note is actionable",
    );

    // The same machine, but the user asked for Android by name.
    const demanded = lib.planPlatforms({
      requested: ["android"],
      present: { ios: true, android: true },
      toolchain: { ios: ok, android: broken },
    });
    assert(demanded.errors.length === 1, "a NAMED platform with no toolchain is an error");
    assert(demanded.build.length === 0, "nothing is built when a demand cannot be met");
    assert(
      demanded.errors[0].includes("no JDK on PATH") &&
        demanded.errors[0].includes("ANDROID_HOME is not set"),
      "the error lists every reason at once rather than stopping at the first",
    );

    // The Linux release runner: no Xcode, and it never asked for iOS.
    const linux = lib.planPlatforms({
      requested: ["android"],
      present: { ios: true, android: true },
      toolchain: { ios: { ok: false, reasons: ["not darwin"] }, android: ok },
    });
    assert(
      linux.errors.length === 0 && linux.build.join(",") === "android",
      "a runner that never wanted the other half is not failed by it",
    );

    // Naming a platform NARROWS the run. Both trees here are present and
    // both toolchains work; asking for android must not also sync ios,
    // which would rewrite ios/App/CapApp-SPM/Package.swift and leave an
    // unexplained diff in a tree the run was never about.
    const narrowed = lib.planPlatforms({
      requested: ["android"],
      present: { ios: true, android: true },
      toolchain: { ios: ok, android: ok },
    });
    assert(
      narrowed.build.join(",") === "android",
      "naming a platform narrows the run — the other buildable tree is not swept in",
    );
    assert(narrowed.skipped.length === 0, "an out-of-scope platform is not reported as skipped");

    // Named, but the tree was never generated.
    const noTree = lib.planPlatforms({
      requested: ["ios"],
      present: { ios: false, android: true },
      toolchain: { ios: ok, android: ok },
    });
    assert(noTree.errors.length === 1, "a named platform with no native tree is an error");
    assert(
      noTree.errors[0].includes("cap:add:ios"),
      "the error names the one-time command that generates and commits the tree",
    );

    // Auto-detect with no tree at all is simply silence.
    const absent = lib.planPlatforms({
      requested: [],
      present: { ios: false, android: false },
      toolchain: { ios: ok, android: ok },
    });
    assert(
      absent.errors.length === 0 && absent.build.length === 0 && absent.skipped.length === 0,
      "an absent, unnamed platform is silently absent",
    );

    const typo = lib.planPlatforms({
      requested: ["andriod"],
      present: {},
      toolchain: {},
    });
    assert(typo.errors.length > 0, "a misspelled platform is an error, not an empty build");
  }

  // ── identifier and version drift ────────────────────────────────────
  section("checkIdentityDrift — cap sync never revisits the identifiers");
  {
    const config = { appId: "com.example.demo", appName: "Demo" };

    const agreeing = lib.checkIdentityDrift({
      config,
      pkgVersion: "1.4.0",
      native: {
        ios: {
          files: { pbxproj: "ios/App/App.xcodeproj/project.pbxproj", plist: "ios/App/App/Info.plist" },
          missing: [],
          bundleIds: ["com.example.demo", "com.example.demo"],
          marketingVersions: ["1.4.0", "1.4.0"],
          displayName: "Demo",
        },
      },
    });
    assert(agreeing.length === 0, "an agreeing iOS tree reports no problem");

    // The exact silent failure: appId changed in capacitor.config.ts long
    // after `cap add` ran.
    const drifted = lib.checkIdentityDrift({
      config: { appId: "com.example.renamed", appName: "Demo" },
      pkgVersion: "1.4.0",
      native: {
        ios: {
          files: { pbxproj: "ios/App/App.xcodeproj/project.pbxproj", plist: "ios/App/App/Info.plist" },
          missing: [],
          bundleIds: ["com.example.demo", "com.example.demo"],
          marketingVersions: ["1.4.0", "1.4.0"],
          displayName: "Demo",
        },
      },
    });
    assert(drifted.length > 0, "a changed appId that never reached the native tree is caught");
    assert(
      drifted.some((p) => p.includes("com.example.renamed") && p.includes("com.example.demo")),
      "the report carries BOTH values, so the fix is obvious",
    );
    assert(
      drifted.some((p) => p.includes("project.pbxproj")),
      "the report names the file that has to change",
    );

    // Version drift against the root package.json.
    const versionDrift = lib.checkIdentityDrift({
      config,
      pkgVersion: "1.5.0",
      native: {
        android: {
          files: { gradle: "android/app/build.gradle", strings: "android/app/src/main/res/values/strings.xml" },
          missing: [],
          namespace: "com.example.demo",
          applicationId: "com.example.demo",
          versionName: "1.4.0",
          appName: "Demo",
        },
      },
    });
    assert(
      versionDrift.some((p) => p.includes("1.5.0") && p.includes("1.4.0")),
      "versionName drifting from the root package.json version is caught",
    );

    // Only the platforms in the build set are asserted — a Mac with no
    // Android SDK must not be failed by an Android tree it is not syncing.
    const iosOnly = lib.checkIdentityDrift({
      config,
      pkgVersion: "1.4.0",
      native: {
        ios: {
          files: { pbxproj: "ios/App/App.xcodeproj/project.pbxproj", plist: "ios/App/App/Info.plist" },
          missing: [],
          bundleIds: ["com.example.demo"],
          marketingVersions: ["1.4.0"],
          displayName: "Demo",
        },
      },
    });
    assert(iosOnly.length === 0, "an unbuilt platform's identifiers are not asserted");
  }

  // ── the parsers the drift check is built on ─────────────────────────
  section("pure parsers");
  {
    const cap = lib.parseCapacitorConfig(`
      const config: CapacitorConfig = {
        appId: "com.example.demo",
        appName: "Demo App",
        webDir: "packages/client/out-mobile",
      };
    `);
    assert(cap.appId === "com.example.demo", "appId parses");
    assert(cap.appName === "Demo App", "appName parses");
    assert(
      cap.webDir === "packages/client/out-mobile",
      "webDir parses — a stale `out` here would package a Playwright run as the app",
    );

    const pbx = lib.parsePbxproj(`
      PRODUCT_BUNDLE_IDENTIFIER = com.example.demo;
      MARKETING_VERSION = 1.4.0;
      PRODUCT_BUNDLE_IDENTIFIER = com.example.demo;
      MARKETING_VERSION = 1.4.0;
    `);
    assert(pbx.bundleIds.length === 2, "both build configurations' bundle ids are read");
    assert(pbx.marketingVersions.length === 2, "both configurations' marketing versions are read");

    const gradle = lib.parseAppBuildGradle(`
      android {
        namespace "com.example.demo"
        defaultConfig {
          applicationId "com.example.demo"
          versionCode 3
          versionName "1.4.0"
        }
      }
    `);
    assert(gradle.applicationId === "com.example.demo", "applicationId parses");
    assert(gradle.versionName === "1.4.0", "versionName parses");

    const strings = lib.parseStringsXml(
      `<resources><string name="app_name">Demo</string><string name="title_activity_main">Demo</string></resources>`,
    );
    assert(strings.app_name === "Demo", "strings.xml parses");

    const plist = lib.parseInfoPlist(
      `<dict><key>CFBundleDisplayName</key><string>Demo</string></dict>`,
    );
    assert(plist.CFBundleDisplayName === "Demo", "Info.plist flat pairs parse");
  }

  // ── export assertions ───────────────────────────────────────────────
  section("export assertions — the literal must reach a chunk");
  {
    const out = join(scratch, "out-mobile-ok");
    write(out, "_next/static/chunks/main-abc.js", 'var API="https://api.example.com";');
    write(out, "index.html", '<script src="/_next/static/chunks/main-abc.js"></script>');

    const hit = lib.assertApiUrlInChunks({ outDir: out, apiUrl: "https://api.example.com" });
    assert(hit.ok, "the baked API URL is found in an emitted chunk");
    assert(hit.scanned > 0, "the scan actually read files");

    const miss = lib.assertApiUrlInChunks({ outDir: out, apiUrl: "https://other.example.com" });
    assert(
      !miss.ok,
      "an API URL that never reached a chunk fails — this is the green build that dies on device",
    );

    const prefixOk = lib.assertNoRelativeAssetPrefix({ outDir: out });
    assert(prefixOk.ok, "root-absolute asset references pass");

    const bad = join(scratch, "out-mobile-relative");
    write(bad, "_next/static/chunks/main.js", "var x=1;");
    write(bad, "settings/index.html", '<script src="./_next/static/chunks/main.js"></script>');
    const prefixBad = lib.assertNoRelativeAssetPrefix({ outDir: bad });
    assert(
      !prefixBad.ok,
      "a relative asset prefix fails — it loads at / and breaks every nested route",
    );
    assert(
      prefixBad.offenders.some((f: string) => f.includes("settings")),
      "the offending HTML file is named",
    );
  }

  // ── dev-server guard ────────────────────────────────────────────────
  section("devServerOwnsBuildDir — a production export cannot share .next");
  {
    const cleanClient = join(scratch, "client-clean");
    mkdirSync(cleanClient, { recursive: true });
    assert(
      !lib.devServerOwnsBuildDir(cleanClient).owned,
      "a checkout with no .next at all is not owned",
    );

    // A finished production build leaves .next behind too. Only
    // development-specific artifacts may block, or every second build
    // would refuse to start.
    const builtClient = join(scratch, "client-built");
    write(builtClient, ".next/build-manifest.json", "{}");
    assert(
      !lib.devServerOwnsBuildDir(builtClient).owned,
      "a .next left by a finished production build does NOT block a rebuild",
    );

    const devClient = join(scratch, "client-dev");
    write(devClient, ".next/static/development/_buildManifest.js", "//");
    const owned = lib.devServerOwnsBuildDir(devClient);
    assert(owned.owned, "a live dev server's .next is detected");
    assert(owned.evidence.length > 0, "the refusal can say what it saw");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log();
if (failed > 0) {
  console.error(`✗ ${failed} assertion(s) failed\n`);
  process.exit(1);
}
console.log("✓ mobile build script: all assertions passed\n");
