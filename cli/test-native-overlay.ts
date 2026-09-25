/**
 * Native-overlay unit tests.
 *
 * `cap add` generates the iOS and Android trees; a handful of edits then
 * live ONLY in those trees, and both are committed so a fresh checkout
 * builds the real app without a generator run. `pnpm cap:add:*` applies
 * the edits through `starter/scripts/lib/native-overlay.mjs` so nobody has
 * to remember them:
 *
 *   · the iOS ATS exception (iOS blocks plain-http loads, and unlike
 *     Android there is no debug source set for Info.plist — so it is
 *     scoped to localhost and nothing else);
 *   · the supported-orientation set;
 *   · the Android debug-only cleartext config (Android blocks cleartext
 *     for targetSdk 28+, and Capacitor 8's Android runtime no longer reads
 *     `server.cleartext` at all — so a DEBUG-source-set XML file is the
 *     only thing that works, and release builds stay stricter than iOS);
 *   · versionName / MARKETING_VERSION wired to the root package.json;
 *   · the environment-driven, OPTIONAL Android release signing config, so
 *     `./gradlew bundleRelease` still works on a checkout with no key.
 *
 * Every function must be idempotent, because re-running the overlay on an
 * existing tree is the documented repair path — and because a second
 * application that appends a second copy corrupts a committed tree.
 *
 * Run: pnpm --filter hatchkit test:native-overlay
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
const LIB = join(STARTER, "scripts/lib/native-overlay.mjs");
if (!existsSync(LIB)) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

interface Changed {
  source: string;
  changed: boolean;
  occurrences?: number;
}
interface OverlayLib {
  addAtsLocalhostException(plist: string): string;
  setSupportedOrientations(plist: string, opts?: { phone?: string[]; pad?: string[] }): string;
  setMarketingVersion(pbx: string, version: string): Changed;
  setCurrentProjectVersion(pbx: string, build: string | number): Changed;
  androidNetworkSecurityConfigXml(): string;
  addDebugNetworkSecurityConfigToManifest(manifest: string): string;
  debugManifestStub(): string;
  installGradleSigningConfig(gradle: string): string;
  setGradleVersionName(gradle: string, v: string): Changed;
  setGradleVersionCode(gradle: string, v: string | number): Changed;
  OVERLAY_FILES: Record<
    string,
    { edited: string[]; generatedTracked: string[]; generatedUntracked: string[] }
  >;
}

const lib = (await import(pathToFileURL(LIB).href)) as unknown as OverlayLib;

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${msg}`);
}
function section(name: string): void {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}`);
}

/** Every overlay function is applied twice and the second result must
 *  equal the first. A non-idempotent patch corrupts a committed tree the
 *  second time someone runs the documented repair command. */
function idempotent(name: string, apply: (s: string) => string, input: string): void {
  const once = apply(input);
  const twice = apply(once);
  assert(once === twice, `${name} is idempotent — a second application changes nothing`);
  assert(once !== input, `${name} actually did something on a clean input`);
}

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Demo</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
</dict>
</plist>
`;

const PBXPROJ = `
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.demo;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.demo;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
`;

const BUILD_GRADLE = `apply plugin: 'com.android.application'

android {
    namespace "com.example.demo"
    compileSdk rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "com.example.demo"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
`;

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
    </application>
</manifest>
`;

// ── iOS: App Transport Security ───────────────────────────────────────
section("iOS ATS exception");
{
  const out = lib.addAtsLocalhostException(INFO_PLIST);
  assert(out.includes("NSAppTransportSecurity"), "the ATS dict is inserted");
  assert(
    out.includes("NSExceptionDomains") && out.includes("localhost"),
    "the exception is scoped to localhost",
  );
  assert(
    !out.includes("NSAllowsArbitraryLoads</key>\n\t\t<true/>") &&
      !/NSAllowsArbitraryLoads<\/key>\s*<true\/>/.test(out),
    "it does NOT open arbitrary loads — this exception ships in release too, because " +
      "Info.plist has no debug source set",
  );
  assert(out.includes("CFBundleDisplayName"), "the rest of the plist survives");
  assert(out.trimEnd().endsWith("</plist>"), "the document stays well-formed");
  idempotent("addAtsLocalhostException", (s) => lib.addAtsLocalhostException(s), INFO_PLIST);
}

// ── iOS: orientations ─────────────────────────────────────────────────
section("iOS orientation set");
{
  const out = lib.setSupportedOrientations(INFO_PLIST);
  assert(
    out.includes("UISupportedInterfaceOrientations"),
    "the phone orientation set is written",
  );
  assert(
    out.includes("UISupportedInterfaceOrientations~ipad"),
    "the iPad set is written separately",
  );
  assert(out.includes("UIInterfaceOrientationPortrait"), "portrait is the phone default");
  idempotent("setSupportedOrientations", (s) => lib.setSupportedOrientations(s), INFO_PLIST);

  const landscape = lib.setSupportedOrientations(INFO_PLIST, {
    phone: ["UIInterfaceOrientationLandscapeLeft"],
  });
  assert(
    landscape.includes("UIInterfaceOrientationLandscapeLeft"),
    "an explicit orientation set is honoured",
  );
}

// ── iOS: version wiring ───────────────────────────────────────────────
section("iOS version wiring");
{
  const mv = lib.setMarketingVersion(PBXPROJ, "1.4.0");
  assert(mv.changed, "MARKETING_VERSION is rewritten");
  assert(
    mv.occurrences === 2,
    "EVERY build configuration is rewritten — rewriting one ships Debug and Release at different versions",
  );
  assert(!mv.source.includes("MARKETING_VERSION = 1.0;"), "no old value survives");
  assert(
    lib.setMarketingVersion(mv.source, "1.4.0").changed === false,
    "re-applying the same version reports no change",
  );

  const cv = lib.setCurrentProjectVersion(PBXPROJ, 42);
  assert(cv.changed && cv.occurrences === 2, "CURRENT_PROJECT_VERSION is rewritten everywhere");
}

// ── Android: cleartext, in the DEBUG source set only ──────────────────
section("Android debug-only cleartext config");
{
  const xml = lib.androidNetworkSecurityConfigXml();
  assert(xml.includes("localhost"), "localhost is permitted");
  assert(
    xml.includes("10.0.2.2"),
    "the emulator's host-loopback alias is permitted — without it a dev build reaches nothing",
  );
  assert(xml.includes("127.0.0.1"), "loopback is permitted");
  assert(
    !/cleartextTrafficPermitted="true"[^>]*>\s*<\/domain-config>/.test(xml) ||
      xml.includes("<domain"),
    "cleartext is granted per domain, never base-config-wide",
  );
  assert(
    !/<base-config[^>]*cleartextTrafficPermitted="true"/.test(xml),
    "the base config does NOT permit cleartext — only the three named hosts do",
  );

  const stub = lib.debugManifestStub();
  assert(
    !stub.includes("package="),
    "the debug manifest carries no package attribute — the merger takes it from main",
  );
  const merged = lib.addDebugNetworkSecurityConfigToManifest(MANIFEST);
  assert(
    merged.includes('android:networkSecurityConfig="@xml/network_security_config"'),
    "the application tag points at the config",
  );
  idempotent(
    "addDebugNetworkSecurityConfigToManifest",
    (s) => lib.addDebugNetworkSecurityConfigToManifest(s),
    MANIFEST,
  );
}

// ── Android: optional, environment-driven signing ─────────────────────
section("Android signing is environment-driven and optional");
{
  const out = lib.installGradleSigningConfig(BUILD_GRADLE);
  assert(out.includes("signingConfigs"), "a release signingConfig is installed");
  assert(
    out.includes("release.keystore"),
    "the keystore is looked up on disk rather than assumed present",
  );
  for (const k of ["KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"]) {
    assert(out.includes(k), `${k} comes from the environment`);
  }
  assert(
    /exists\(\)/.test(out),
    "the config is conditional on the keystore existing — a checkout with no key still builds",
  );
  assert(
    /logger\.(lifecycle|warn)/.test(out),
    "an unsigned build says so out loud rather than passing quietly",
  );
  assert(out.includes("applicationId"), "the rest of build.gradle survives");
  idempotent("installGradleSigningConfig", (s) => lib.installGradleSigningConfig(s), BUILD_GRADLE);
}

// ── Android: version wiring, driven by CI ─────────────────────────────
section("Android version wiring");
{
  const vn = lib.setGradleVersionName(BUILD_GRADLE, "1.4.0");
  assert(vn.changed, "versionName is rewritten");
  assert(vn.source.includes("1.4.0"), "the new version is present");
  assert(
    vn.source.includes("ANDROID_VERSION_NAME"),
    "CI can override it from the environment — the workflow supplies it per run",
  );
  assert(
    lib.setGradleVersionName(vn.source, "1.4.0").changed === false,
    "re-applying the same versionName reports no change",
  );

  const vc = lib.setGradleVersionCode(BUILD_GRADLE, 7);
  assert(
    vc.source.includes("ANDROID_VERSION_CODE"),
    "versionCode is CI-overridable — both stores permanently reject a build number they have seen",
  );
  idempotent("setGradleVersionCode", (s) => lib.setGradleVersionCode(s, 7).source, BUILD_GRADLE);
}

// ── the generated-file manifest ───────────────────────────────────────
section("OVERLAY_FILES documents what a sync rewrites");
{
  const { ios, android } = lib.OVERLAY_FILES;
  assert(Boolean(ios) && Boolean(android), "both platforms are described");

  const flat = (xs: string[]) => xs.join(" ");
  assert(
    flat(ios.generatedTracked).includes("Package.swift"),
    "Package.swift is generated-but-TRACKED — every sync rewrites it, and it must be committed",
  );
  assert(
    flat(ios.generatedUntracked).includes("public"),
    "the copied web assets are NOT tracked — which is why a never-built checkout cannot open in Xcode",
  );
  assert(
    flat(android.generatedTracked).includes("capacitor.build.gradle") ||
      flat(android.generatedTracked).includes("capacitor.settings.gradle"),
    "the Capacitor gradle fragments are generated-but-tracked",
  );
  assert(
    flat(android.generatedUntracked).includes("capacitor-cordova-android-plugins"),
    "the cordova plugin module is NOT tracked — the other reason a never-built checkout will not open",
  );
  assert(
    flat(android.generatedUntracked).includes("assets/public"),
    "the copied Android web assets are not tracked either",
  );

  // Nothing may be in both lists — that is the one mistake that turns the
  // manifest into misinformation.
  for (const p of [ios, android]) {
    for (const t of p.generatedTracked) {
      assert(
        !p.generatedUntracked.some((u) => u === t),
        `"${t}" is listed as tracked and untracked at once`,
      );
    }
  }
}

console.log();
if (failed > 0) {
  console.error(`✗ ${failed} assertion(s) failed\n`);
  process.exit(1);
}
console.log("✓ native overlay: all assertions passed\n");
