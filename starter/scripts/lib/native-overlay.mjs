// scripts/lib/native-overlay.mjs — the edits that `cap add` does NOT make.
//
// `npx cap add ios|android` generates a stock native project. A handful of
// settings live ONLY inside those generated trees and have no representation
// in capacitor.config.ts, so they survive a fresh clone only because the
// native trees are committed:
//
//   · iOS App Transport Security exception (a debug build must reach a
//     plain-http local API)
//   · supported interface orientations
//   · Android debug-only cleartext network_security_config.xml
//   · versionName / MARKETING_VERSION wired to the root package.json version
//   · the optional, environment-driven Android release signing config
//
// Nobody remembers to redo those by hand after `cap add`. So `cap:add:*`
// runs `cap add` and then applies this overlay, and re-running the overlay
// on an existing tree is the documented repair path.
//
// Contract for everything exported here:
//   · pure — takes a STRING of file contents, returns a STRING (or a small
//     plain object). No filesystem, no process, node: builtins only. That is
//     what lets the test suite drive these with fixtures.
//   · IDEMPOTENT — applying twice equals applying once.
//   · returns the input UNCHANGED when the target edit is already present,
//     so the caller can diff-then-write and report "already applied"
//     instead of dirtying a committed native tree on every run.
//
// No XML/pbxproj parser is used on purpose. A parser round-trip reformats
// the whole file and turns a two-line overlay into a thousand-line diff
// against a committed tree, which hides the real change in review.

// ---------------------------------------------------------------------------
// iOS - Info.plist
// ---------------------------------------------------------------------------

const DEFAULT_PHONE_ORIENTATIONS = ["UIInterfaceOrientationPortrait"];

const DEFAULT_PAD_ORIENTATIONS = [
  "UIInterfaceOrientationPortrait",
  "UIInterfaceOrientationPortraitUpsideDown",
  "UIInterfaceOrientationLandscapeLeft",
  "UIInterfaceOrientationLandscapeRight",
];

// Xcode writes plists with tab indentation; a hand-edited one may use
// spaces. Copy whatever the file already uses so the inserted block does
// not stand out as a whitespace-only diff next to its neighbours.
function detectPlistIndent(source) {
  const match = source.match(/\n([ \t]+)<key>/);
  return match ? match[1] : "\t";
}

// Matches the closing `</dict></plist>` that ends every plist, including the
// newline in front of it. Anchored to end-of-file so a nested `</dict>`
// somewhere in the middle can never be mistaken for the root one.
const PLIST_TAIL = /\n[ \t]*<\/dict>\s*<\/plist>\s*$/;

function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert the App Transport Security exception that lets a build talk to a
 * plain-http API on localhost.
 *
 * iOS blocks plain-http loads outright. A debug build pointed at a local API
 * (`http://localhost:5000`, the live-reload dev server) is refused by the
 * network stack before the request leaves the device, and the WebView reports
 * it as a generic load failure that reads like a server outage.
 *
 * Unlike Android there is NO separate debug source set for Info.plist — one
 * plist ships in every configuration. So this exception is present in release
 * builds too. That is exactly why it is scoped to `localhost` and nothing
 * else: a shipped app has no route to the user's localhost, so the exception
 * is unreachable in the field, while a blanket `NSAllowsArbitraryLoads` would
 * weaken every connection the app makes and is separately questioned during
 * App Store review.
 *
 * Returns the input unchanged when NSAppTransportSecurity already exists —
 * a project that has grown its own ATS rules is never overwritten here.
 *
 * @param {string} plistSource
 * @returns {string}
 */
export function addAtsLocalhostException(plistSource) {
  if (/<key>\s*NSAppTransportSecurity\s*<\/key>/.test(plistSource)) {
    return plistSource;
  }
  if (!PLIST_TAIL.test(plistSource)) {
    // Unrecognised shape. Returning the input is the safe failure: the
    // caller reports "missing"/"unchanged" rather than writing a plist
    // that Xcode then refuses to open.
    return plistSource;
  }

  const i = detectPlistIndent(plistSource);
  const block = [
    `${i}<key>NSAppTransportSecurity</key>`,
    `${i}<dict>`,
    `${i}${i}<!-- Local networking + a localhost-only http exception. Scoped`,
    `${i}${i}     deliberately: there is no debug-only plist, so whatever is`,
    `${i}${i}     written here also ships in the App Store build. -->`,
    `${i}${i}<key>NSAllowsLocalNetworking</key>`,
    `${i}${i}<true/>`,
    `${i}${i}<key>NSExceptionDomains</key>`,
    `${i}${i}<dict>`,
    `${i}${i}${i}<key>localhost</key>`,
    `${i}${i}${i}<dict>`,
    `${i}${i}${i}${i}<key>NSExceptionAllowsInsecureHTTPLoads</key>`,
    `${i}${i}${i}${i}<true/>`,
    `${i}${i}${i}</dict>`,
    `${i}${i}</dict>`,
    `${i}</dict>`,
  ].join("\n");

  return plistSource.replace(PLIST_TAIL, (tail) => `\n${block}${tail}`);
}

/**
 * Set UISupportedInterfaceOrientations (iPhone) and
 * UISupportedInterfaceOrientations~ipad.
 *
 * The orientation set is enforced by the OS, not by the web layer: CSS and
 * the ScreenOrientation plugin cannot hold a layout that the plist allows the
 * system to rotate away from. Getting this wrong ships an app that rotates
 * into a layout nobody designed.
 *
 * iPad is a separate key and iPadOS requires all four orientations from any
 * app that wants to be a multitasking citizen, which is why the defaults
 * differ per idiom.
 *
 * @param {string} plistSource
 * @param {{ phone?: string[], pad?: string[] }} [options]
 * @returns {string}
 */
export function setSupportedOrientations(plistSource, options = {}) {
  const phone = options.phone ?? DEFAULT_PHONE_ORIENTATIONS;
  const pad = options.pad ?? DEFAULT_PAD_ORIENTATIONS;
  let out = plistSource;
  out = upsertPlistStringArray(out, "UISupportedInterfaceOrientations", phone);
  out = upsertPlistStringArray(out, "UISupportedInterfaceOrientations~ipad", pad);
  return out;
}

// Replace the <array> that follows <key>, or append the pair before the
// closing root dict when the key is absent. Writing the identical block over
// an identical block is what makes this idempotent - no marker needed.
function upsertPlistStringArray(source, key, values) {
  const i = detectPlistIndent(source);
  const block = [
    `${i}<key>${key}</key>`,
    `${i}<array>`,
    ...values.map((value) => `${i}${i}<string>${value}</string>`),
    `${i}</array>`,
  ].join("\n");

  // `<key>UISupportedInterfaceOrientations</key>` cannot match the ~ipad key,
  // because the literal `</key>` right after the name pins the whole name.
  const existing = new RegExp(
    `[ \\t]*<key>${escapeForRegExp(key)}</key>\\s*\\n[ \\t]*<array>[\\s\\S]*?</array>`,
  );
  if (existing.test(source)) return source.replace(existing, block);
  if (!PLIST_TAIL.test(source)) return source;
  return source.replace(PLIST_TAIL, (tail) => `\n${block}${tail}`);
}

// ---------------------------------------------------------------------------
// iOS - project.pbxproj
// ---------------------------------------------------------------------------

// A pbxproj carries one XCBuildConfiguration per configuration (Debug and
// Release at minimum) and repeats every build setting in each of them.
// Rewriting only the first occurrence produces a project where the Release
// archive keeps the old version - a mismatch that is only noticed after the
// upload is rejected. So every occurrence is rewritten, and the count is
// returned so the caller can show it.
function replaceBuildSetting(source, key, value) {
  const pattern = new RegExp(`(${escapeForRegExp(key)}\\s*=\\s*)([^;]*)(;)`, "g");
  let occurrences = 0;
  const out = source.replace(pattern, (_match, head, _old, tail) => {
    occurrences += 1;
    return `${head}${value}${tail}`;
  });
  return { source: out, changed: out !== source, occurrences };
}

/**
 * Rewrite EVERY `MARKETING_VERSION = x;` to the given version.
 *
 * MARKETING_VERSION is CFBundleShortVersionString - the version a user sees.
 * It is kept equal to the root package.json version so there is one place to
 * bump and no chance of the store listing disagreeing with the web build.
 *
 * @param {string} pbxprojSource
 * @param {string} version
 * @returns {{ source: string, changed: boolean, occurrences: number }}
 */
export function setMarketingVersion(pbxprojSource, version) {
  return replaceBuildSetting(pbxprojSource, "MARKETING_VERSION", version);
}

/**
 * Rewrite EVERY `CURRENT_PROJECT_VERSION = n;` to the given build number.
 *
 * CURRENT_PROJECT_VERSION is CFBundleVersion, the build number. App Store
 * Connect refuses a build number it has already accepted for the same
 * version, so this is the value CI must bump on every upload - not something
 * a human should be expected to remember.
 *
 * @param {string} pbxprojSource
 * @param {string|number} buildNumber
 * @returns {{ source: string, changed: boolean, occurrences: number }}
 */
export function setCurrentProjectVersion(pbxprojSource, buildNumber) {
  return replaceBuildSetting(pbxprojSource, "CURRENT_PROJECT_VERSION", String(buildNumber));
}

// ---------------------------------------------------------------------------
// Android - network security config
// ---------------------------------------------------------------------------

/**
 * Full text of the debug-only network_security_config.xml.
 *
 * Android blocks cleartext HTTP by default from targetSdk 28 onward, and
 * Capacitor 8's Android runtime no longer reads `server.cleartext` from
 * capacitor.config.ts at all - setting it there has no effect and the
 * failure looks like a WebView that loads a blank page.
 *
 * This file belongs in the DEBUG source set (app/src/debug/res/xml/). The
 * release build therefore gets NO cleartext exception whatsoever, which is
 * stricter than the iOS side, where a single plist has to serve both
 * configurations.
 *
 * Three hosts and nothing else:
 *   localhost  - the app talking to a server on the device itself
 *   127.0.0.1  - the same host by address, after an `adb reverse` tunnel
 *   10.0.2.2   - the emulator's alias for the host machine's loopback
 *
 * @returns {string}
 */
export function androidNetworkSecurityConfigXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  Debug-only cleartext exception. This file lives in app/src/debug/ and is
  merged into debug builds ONLY - the release manifest never references it,
  so a shipped build still refuses every plain-http connection.

  Keep this list at three entries. Widening it to a real hostname means the
  debug build silently accepts an unencrypted connection to a server that is
  not on this machine.
-->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <!-- A server running on the device/emulator itself. -->
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
        <!-- The emulator's fixed alias for the host machine's loopback.
             A device on Wi-Fi does not resolve this; use \`adb reverse\`
             so the dev server appears on localhost instead of adding a
             LAN address here. -->
        <domain includeSubdomains="false">10.0.2.2</domain>
    </domain-config>
</network-security-config>
`;
}

/**
 * Add `android:networkSecurityConfig="@xml/network_security_config"` to the
 * <application> tag.
 *
 * Intended for app/src/debug/AndroidManifest.xml. The manifest merger
 * overlays a debug-source-set manifest onto the main one, so the attribute
 * reaches debug builds and only debug builds. Pointing the MAIN manifest at
 * this file instead is the usual mistake - it ships the exception.
 *
 * Returns the input unchanged when the attribute is already present.
 *
 * @param {string} manifestSource
 * @returns {string}
 */
export function addDebugNetworkSecurityConfigToManifest(manifestSource) {
  if (/android:networkSecurityConfig\s*=/.test(manifestSource)) return manifestSource;
  if (!/<application\b/.test(manifestSource)) return manifestSource;
  return manifestSource.replace(
    /<application\b/,
    '<application\n        android:networkSecurityConfig="@xml/network_security_config"',
  );
}

/**
 * Minimal app/src/debug/AndroidManifest.xml carrying only the <application>
 * override.
 *
 * Note there is no `package` attribute and no components. A debug-source-set
 * manifest is not a standalone manifest: the merger takes the package (and
 * everything else) from app/src/main/AndroidManifest.xml and applies this one
 * as an overlay. Declaring a package here either duplicates what main already
 * says or, worse, disagrees with it and fails the merge with an error that
 * points at the wrong file.
 *
 * @returns {string}
 */
export function debugManifestStub() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  Debug source set overlay. Merged on top of app/src/main/AndroidManifest.xml
  for debug builds only. No package attribute: the merger takes it from main.
  Add nothing here that a release build must not have.
-->
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:networkSecurityConfig="@xml/network_security_config" />
</manifest>
`;
}

// ---------------------------------------------------------------------------
// Android - app/build.gradle
// ---------------------------------------------------------------------------

// Presence of this marker is the idempotency check for the signing overlay.
// A textual re-scan for `signingConfigs` would also match a block the user
// wrote by hand, and then this function would refuse to install on a project
// it has never touched.
const SIGNING_MARKER = "--- release signing (environment-driven, optional) ---";

const SIGNING_DEFS = `// ${SIGNING_MARKER}
// Signing is environment-driven and OPTIONAL by design: \`./gradlew
// bundleRelease\` must succeed on a checkout that has no key, otherwise
// every contributor needs the release keystore before they can even
// confirm the release build compiles.
//
// The cost of that choice is that a missing key produces an UNSIGNED
// bundle instead of an error. CI is where that must not pass quietly -
// the release workflow asserts the artifact is signed. Do not turn this
// into a hard failure here; it would only move the pain to the wrong
// people.
//
// Never fall back to the debug key. An AAB signed with the debug key is
// rejected at upload with a message about the certificate, which sends
// the reader looking at the store account instead of at the missing env.
def hasText = { value -> value != null && !value.trim().isEmpty() }
def releaseKeystore = file('release.keystore')
def releaseStorePassword = System.getenv("KEYSTORE_PASSWORD")
def releaseKeyAlias = System.getenv("KEY_ALIAS")
def releaseKeyPassword = System.getenv("KEY_PASSWORD")
def canSignRelease = releaseKeystore.exists() &&
    hasText(releaseStorePassword) &&
    hasText(releaseKeyAlias) &&
    hasText(releaseKeyPassword)
`;

const SIGNING_CONFIGS_BLOCK = `    // Declared only when a key is actually usable. An empty signingConfig
    // with null passwords fails later, deep inside the signing task, with a
    // message that does not mention the missing environment variables.
    if (canSignRelease) {
        signingConfigs {
            release {
                storeFile releaseKeystore
                storePassword releaseStorePassword
                keyAlias releaseKeyAlias
                keyPassword releaseKeyPassword
            }
        }
    } else {
        logger.lifecycle("release signing: no keystore or credentials found - the release bundle will be UNSIGNED")
    }
`;

function signingConfigLine(indent) {
  return (
    `${indent}// null = unsigned output, on purpose (see canSignRelease above).\n` +
    `${indent}signingConfig canSignRelease ? signingConfigs.release : null\n`
  );
}

/**
 * Install the optional, environment-driven release signing config into
 * android/app/build.gradle.
 *
 * Idempotent via a marker comment. Returns the input unchanged when the
 * overlay is already installed, or when the file has no top-level
 * `android {` block to anchor against (an unrecognised file is left alone
 * rather than half-edited).
 *
 * @param {string} buildGradleSource
 * @returns {string}
 */
export function installGradleSigningConfig(buildGradleSource) {
  if (buildGradleSource.includes(SIGNING_MARKER)) return buildGradleSource;

  const androidBlock = /^android\s*\{[ \t]*\n/m;
  if (!androidBlock.test(buildGradleSource)) return buildGradleSource;

  // The `def`s go at the top level, above `android {`, so the ternary in
  // buildTypes can see them. `file('release.keystore')` resolves against the
  // module directory, i.e. android/app/release.keystore.
  let out = buildGradleSource.replace(
    androidBlock,
    `${SIGNING_DEFS}\nandroid {\n${SIGNING_CONFIGS_BLOCK}`,
  );

  // Wire buildTypes.release at whatever shape the generated file has.
  const releaseInBuildTypes = /(buildTypes\s*\{[\s\S]*?\n([ \t]*)release\s*\{[ \t]*\n)/;
  const bareBuildTypes = /^([ \t]*)buildTypes\s*\{[ \t]*\n/m;

  if (releaseInBuildTypes.test(out)) {
    out = out.replace(releaseInBuildTypes, (full, _all, indent) => {
      return `${full}${signingConfigLine(`${indent}    `)}`;
    });
  } else if (bareBuildTypes.test(out)) {
    out = out.replace(bareBuildTypes, (full, indent) => {
      return (
        `${full}${indent}    release {\n` +
        `${signingConfigLine(`${indent}        `)}` +
        `${indent}    }\n`
      );
    });
  } else {
    // No buildTypes at all - add one next to the signingConfigs block so the
    // signing config is actually consumed. A signingConfigs block nothing
    // references is the silent version of this whole failure.
    out = out.replace(
      SIGNING_CONFIGS_BLOCK,
      `${SIGNING_CONFIGS_BLOCK}\n    buildTypes {\n        release {\n${signingConfigLine("            ")}        }\n    }\n`,
    );
  }

  return out;
}

// Replace a line inside defaultConfig, keeping its indentation, or insert it
// when the line is absent. Indentation is preserved rather than normalised so
// the diff against a committed tree stays one line long.
function upsertDefaultConfigLine(source, linePattern, line) {
  const existing = source.match(linePattern);
  if (existing) {
    const out = source.replace(linePattern, `${existing[1]}${line}`);
    return { source: out, changed: out !== source };
  }
  const defaultConfig = /^([ \t]*)defaultConfig\s*\{[ \t]*\n/m;
  const block = source.match(defaultConfig);
  if (!block) return { source, changed: false };
  const out = source.replace(defaultConfig, (full) => `${full}${block[1]}    ${line}\n`);
  return { source: out, changed: out !== source };
}

/**
 * Wire `versionName` to the root package.json version, overridable by
 * ANDROID_VERSION_NAME.
 *
 * @param {string} buildGradleSource
 * @param {string} versionName
 * @returns {{ source: string, changed: boolean }}
 */
export function setGradleVersionName(buildGradleSource, versionName) {
  return upsertDefaultConfigLine(
    buildGradleSource,
    /^([ \t]*)versionName[ \t]+.*$/m,
    `versionName System.getenv("ANDROID_VERSION_NAME") ?: "${versionName}"`,
  );
}

/**
 * Wire `versionCode`, overridable by ANDROID_VERSION_CODE.
 *
 * Both stores refuse a build number they have already seen - Play rejects a
 * duplicate versionCode at upload, App Store Connect rejects a duplicate
 * CFBundleVersion. A hardcoded number therefore breaks the SECOND release,
 * not the first, which is the worst moment to discover it. So the literal
 * here is only the local fallback; CI supplies the real monotonic number
 * through the environment.
 *
 * `System.getenv(...)` returns a String, hence the `.toInteger()` - Gradle
 * rejects a String versionCode with a type error that does not name the env
 * variable.
 *
 * @param {string} buildGradleSource
 * @param {string|number} versionCode
 * @returns {{ source: string, changed: boolean }}
 */
export function setGradleVersionCode(buildGradleSource, versionCode) {
  return upsertDefaultConfigLine(
    buildGradleSource,
    /^([ \t]*)versionCode[ \t]+.*$/m,
    `versionCode (System.getenv("ANDROID_VERSION_CODE") ?: "${versionCode}").toInteger()`,
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * What the overlay touches, and what else lives inside the committed native
 * trees. Paths are relative to the platform root (`ios/`, `android/`).
 *
 * `edited`             - files this overlay rewrites.
 * `generatedTracked`   - written by `cap sync` / the assets generator, but
 *                        COMMITTED, because a fresh checkout needs them
 *                        before it can build.
 * `generatedUntracked` - regenerated by every build, NOT committed.
 *
 * Consequence of the untracked list, and the reason `cap:add:*` prints it:
 * a checkout that has never run the mobile build has no copied web assets
 * and no capacitor-cordova-android-plugins module. Opening such a tree
 * directly in Xcode or Android Studio fails with a missing-file error that
 * reads like a corrupt project. Run the mobile build first, then open.
 *
 * Consequence of `App/CapApp-SPM/Package.swift` being tracked: it hardcodes
 * the package manager's content-addressed store paths for every Capacitor
 * plugin. Any lockfile refresh renames those directories, so the committed
 * file then points at paths that no longer exist and Xcode fails to resolve
 * the local SPM package. Re-run the mobile build after any install, and
 * before opening the iOS project directly.
 */
export const OVERLAY_FILES = {
  ios: {
    edited: ["App/App/Info.plist", "App/App.xcodeproj/project.pbxproj"],
    generatedTracked: [
      // Rewritten by every `cap sync`; holds absolute store paths.
      "App/CapApp-SPM/Package.swift",
      // Rewritten by `capacitor-assets generate`.
      "App/App/Assets.xcassets/**",
    ],
    generatedUntracked: [
      // The copied web export.
      "App/App/public/",
    ],
  },
  android: {
    edited: [
      "app/build.gradle",
      "app/src/debug/AndroidManifest.xml",
      "app/src/debug/res/xml/network_security_config.xml",
    ],
    generatedTracked: [
      // Both rewritten by every `cap sync`.
      "capacitor.settings.gradle",
      "app/capacitor.build.gradle",
      // Rewritten by `capacitor-assets generate`.
      "app/src/main/res/mipmap-*/**",
      "app/src/main/res/drawable*/**",
    ],
    generatedUntracked: [
      // The copied web export.
      "app/src/main/assets/public/",
      // Re-derived from the installed plugins on every sync. Sibling of
      // app/, inside the android/ root - Gradle settings reference it, so a
      // checkout without it fails at configure time, not at build time.
      "capacitor-cordova-android-plugins/",
    ],
  },
};
