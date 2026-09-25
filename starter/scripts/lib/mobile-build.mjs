// Logic behind scripts/build-mobile.mjs, factored out so it can be unit-tested
// without spawning a build, a simulator, or Capacitor.
//
// Two rules keep this file testable:
//
//   1. It imports node: builtins and nothing else. Hatchkit's test suite
//      imports this file straight out of the template, where the generated
//      project's node_modules does not exist.
//   2. Every filesystem-touching function takes an explicit path and is a thin
//      wrapper over a pure string parser. Tests drive the parsers with fixture
//      strings; the wrappers only do readFileSync + parse.
//
// The failure modes these helpers exist to prevent are documented at each
// function. They are all of the same shape: a mobile build that succeeds,
// produces an installable app, and is broken in a way nobody sees until the
// app is on a device.

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** Platforms this repo can build. Order is the order we report them in. */
export const MOBILE_PLATFORMS = ["ios", "android"];

/**
 * The mobile export directory, relative to packages/client.
 *
 * It is deliberately NOT `out`, which the web build and Playwright use, and
 * NOT `out-desktop`, which Electron uses. One shared export directory means a
 * Playwright run (or a desktop build) can leave its output behind and have it
 * silently packaged as the mobile app — a green build that ships the wrong
 * bundle. Separate directories make that impossible rather than unlikely.
 */
export const MOBILE_OUT_DIR = "out-mobile";

/** Matches a "double", 'single', or `template` quoted literal. */
const QUOTED = "(?:\"([^\"]*)\"|'([^']*)'|`([^`]*)`)";

function pickGroup(match) {
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

// ---------------------------------------------------------------------------
// Pure string parsers
//
// Everything below this line takes a string and returns data. No filesystem,
// no process, no network — so a test can feed a fixture and assert on the
// result.
// ---------------------------------------------------------------------------

/**
 * Pull { appId, appName, webDir } out of capacitor.config.ts.
 *
 * Parsed with a regex on purpose. capacitor.config.ts is TypeScript and reads
 * process.env at module scope (CAP_DEV_URL), so importing it would need a TS
 * loader and would let the ambient environment change what we read. A regex
 * reads what is written in the file, which is exactly the value `cap add`
 * copied into the native trees.
 */
export function parseCapacitorConfig(source) {
  const read = (key) =>
    pickGroup(
      new RegExp("\\b" + key + "\\s*:\\s*" + QUOTED).exec(source),
    );
  return {
    appId: read("appId"),
    appName: read("appName"),
    webDir: read("webDir"),
  };
}

/**
 * Pull every PRODUCT_BUNDLE_IDENTIFIER and MARKETING_VERSION out of an Xcode
 * project.pbxproj.
 *
 * Every occurrence, not the first: a pbxproj carries one XCBuildConfiguration
 * per (target, configuration) pair, so Debug and Release each hold their own
 * copy. Editing only one in Xcode produces a project that debugs under the new
 * bundle id and archives under the old one.
 *
 * Values in a pbxproj are quoted only when they need to be, so accept both.
 */
export function parsePbxproj(source) {
  const collect = (key) => {
    const re = new RegExp(
      key + "\\s*=\\s*(?:\"([^\"]*)\"|([^;\\n]+))\\s*;",
      "g",
    );
    const out = [];
    for (const m of source.matchAll(re)) {
      out.push((m[1] ?? m[2] ?? "").trim());
    }
    return out;
  };
  return {
    bundleIds: collect("PRODUCT_BUNDLE_IDENTIFIER"),
    marketingVersions: collect("MARKETING_VERSION"),
  };
}

/**
 * Pull the identity fields out of android/app/build.gradle.
 *
 * Handles both the Groovy (`namespace "com.x"`) and Kotlin-DSL
 * (`namespace = "com.x"`) spellings. The lookahead stops `applicationId` from
 * matching `applicationIdSuffix`, which is a different setting and would make
 * us report drift against a value nobody set.
 */
export function parseAppBuildGradle(source) {
  const str = (key) =>
    pickGroup(
      new RegExp(
        "\\b" + key + "(?![A-Za-z0-9_])\\s*=?\\s*" + QUOTED,
      ).exec(source),
    );
  const codeMatch = /\bversionCode(?![A-Za-z0-9_])\s*=?\s*(\d+)/.exec(source);
  return {
    namespace: str("namespace"),
    applicationId: str("applicationId"),
    versionName: str("versionName"),
    versionCode: codeMatch ? Number(codeMatch[1]) : undefined,
  };
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    // Android escapes a literal apostrophe or quote inside a string resource.
    .replace(/\\(['"])/g, "$1")
    .trim();
}

/**
 * Parse an Android strings.xml into a flat { name: value } map.
 *
 * <string-array> and <plurals> are ignored — we only ever read scalar app
 * identity strings (app_name, title_activity_main, package_name).
 */
export function parseStringsXml(source) {
  const out = {};
  const re = /<string\s+[^>]*name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
  for (const m of source.matchAll(re)) {
    out[m[1]] = decodeXmlText(m[2]);
  }
  return out;
}

/**
 * Parse a .plist into a flat { key: value } map of <key>/<string> pairs ONLY.
 *
 * Documented limitation: this is not a plist parser. <array>, <dict>, <true/>,
 * <integer> and friends are skipped, and a <key>/<string> pair nested inside a
 * sub-dict is indistinguishable from a top-level one, so it lands in the same
 * flat map. That is acceptable because the only keys we read are the top-level
 * CFBundle* scalars, whose names do not recur inside the nested dicts that an
 * Info.plist normally carries (UIApplicationSceneManifest, NSAppTransport-
 * Security). If you need anything structural, shell out to `plutil` instead of
 * widening this.
 */
export function parseInfoPlist(source) {
  const out = {};
  const re = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const m of source.matchAll(re)) {
    out[decodeXmlText(m[1])] = decodeXmlText(m[2]);
  }
  return out;
}

/**
 * Parse argv for build-mobile.mjs. Pure so the flag matrix is testable.
 *
 * Bare platform names are a demand (see planPlatforms); flags are:
 *   --no-sync     build and verify, but do not run `cap sync`
 *   --dry-run     plan and preflight only, build nothing
 *   --skip-build  reuse an existing out-mobile (used by cap:run:* after a build)
 */
export function parseMobileArgs(argv) {
  const platforms = [];
  const errors = [];
  let noSync = false;
  let dryRun = false;
  let skipBuild = false;
  let help = false;

  for (const arg of argv) {
    if (arg === "--no-sync") noSync = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--skip-build") skipBuild = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (MOBILE_PLATFORMS.includes(arg)) {
      if (!platforms.includes(arg)) platforms.push(arg);
    } else {
      errors.push(
        `unknown argument "${arg}" — expected one of: ` +
          `${MOBILE_PLATFORMS.join(", ")}, --no-sync, --dry-run, --skip-build`,
      );
    }
  }

  return { platforms, noSync, dryRun, skipBuild, help, errors };
}

/**
 * Validate NEXT_PUBLIC_API_URL. Must be an absolute http(s) URL.
 *
 * A relative or scheme-less value is worse than an unset one: it parses in the
 * browser against the document origin, so it works in `next dev` on
 * http://localhost:3000 and resolves to capacitor://localhost/<path> on device.
 */
export function validateApiUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: "value is empty" };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      error: `"${value}" is not an absolute URL (it needs a scheme and a host)`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: `"${value}" uses the ${url.protocol} scheme; only http and https work from a WebView`,
    };
  }
  if (!url.hostname) {
    return { ok: false, error: `"${value}" has no host` };
  }
  return { ok: true, url };
}

/** True for hosts that only resolve on the machine that ran the build. */
export function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Decide which platforms to build.
 *
 * A NAMED PLATFORM IS A DEMAND; AN AUTO-DETECTED ONE IS AN OFFER.
 *
 * Why the asymmetry: both native trees are committed to the repo, so every
 * checkout has an android/ directory whether or not that machine has a JDK and
 * an Android SDK, and an ios/ directory whether or not it has Xcode. A Mac
 * with no Android SDK and a Linux CI runner with no Xcode must both survive a
 * bare `pnpm build:mobile`. Treating a present-but-unbuildable tree as an
 * error would break both.
 *
 * But when someone types `pnpm build:mobile android`, silently skipping
 * Android and exiting 0 is the worst possible outcome: the release pipeline
 * reports success and produces nothing.
 *
 * Naming a platform also NARROWS the run. `pnpm build:mobile android` builds
 * and syncs android and nothing else; it does not additionally pick up an ios
 * tree that happens to be buildable on this machine. Auto-detection is what
 * happens when nothing was named — it is not an addition to what was.
 * Syncing a platform nobody asked for rewrites its generated-but-tracked
 * files (Package.swift, capacitor.build.gradle) and leaves an unexplained
 * diff in a tree the run was never about.
 *
 *   ANY platform named:
 *     named + tree missing        -> error (tell them to run cap:add once)
 *     named + toolchain missing   -> error, listing every reason
 *     named + ok                  -> build
 *     not named                   -> out of scope entirely, silently
 *
 *   NOTHING named (auto-detect):
 *     tree present, ok            -> build
 *     tree present, no toolchain  -> skip with a note, not an error
 *     tree absent                 -> silently absent
 *
 * @param {{requested?: string[], present?: Record<string, boolean>,
 *          toolchain?: Record<string, {ok: boolean, reasons?: string[]}>}} input
 * @returns {{build: string[], skipped: {platform: string, reasons: string[]}[],
 *            errors: string[]}}
 */
export function planPlatforms({ requested = [], present = {}, toolchain = {} }) {
  const build = [];
  const skipped = [];
  const errors = [];

  for (const name of requested) {
    if (!MOBILE_PLATFORMS.includes(name)) {
      errors.push(
        `"${name}" is not a mobile platform (expected ${MOBILE_PLATFORMS.join(" or ")})`,
      );
    }
  }

  const named = new Set(requested);

  for (const platform of MOBILE_PLATFORMS) {
    const probe = toolchain[platform] ?? {
      ok: false,
      reasons: [`no toolchain probe ran for ${platform}`],
    };
    const reasons = probe.reasons ?? [];
    const hasTree = Boolean(present[platform]);

    // Naming any platform narrows the run to the named set. See the
    // header: auto-detection replaces an empty command line, it does not
    // extend a populated one.
    if (named.size > 0 && !named.has(platform)) continue;

    if (named.has(platform)) {
      if (!hasTree) {
        errors.push(
          `${platform}: asked for, but there is no native tree at ./${platform}. ` +
            `Run \`pnpm cap:add:${platform}\` once and commit the generated tree.`,
        );
        continue;
      }
      if (!probe.ok) {
        errors.push(
          [
            `${platform}: asked for, but the toolchain on this machine cannot build it:`,
            ...reasons.map((r) => `  - ${r}`),
          ].join("\n"),
        );
        continue;
      }
      build.push(platform);
      continue;
    }

    if (!hasTree) continue;
    if (!probe.ok) {
      skipped.push({ platform, reasons });
      continue;
    }
    build.push(platform);
  }

  return { build, skipped, errors };
}

// ---------------------------------------------------------------------------
// Dev-server detection
// ---------------------------------------------------------------------------

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Report whether a running `next dev` owns packages/client/.next.
 *
 * Why this matters: with `output: "export"` Next treats a custom distDir as
 * the OUT directory and forces the build directory back to `.next`. So the
 * mobile export cannot be given its own build dir — it must use the same
 * `.next` a dev server is holding open. Running both at once produces a build
 * that either fails halfway with an unrelated ENOENT on a chunk the dev server
 * just rewrote, or worse, succeeds against a half-overwritten manifest.
 *
 * The heuristic is deliberately conservative, because a false positive blocks
 * a build that would have worked. `.next/trace` and `.next/build-manifest.json`
 * are written by `next build` too, so on their own they prove nothing; they are
 * reported as corroborating evidence only. Ownership requires at least one
 * artifact that ONLY a dev server produces:
 *
 *   .next/static/development/            dev-only chunk output
 *   .next/dev-server.pid                 written by newer Next dev servers
 *   .next/cache/webpack/ any *-development* entry   dev-only compiler cache
 *
 * @param {string} clientDir absolute path to packages/client
 * @returns {{owned: boolean, evidence: string[]}}
 */
export function devServerOwnsBuildDir(clientDir) {
  const nextDir = join(clientDir, ".next");
  const evidence = [];
  if (!isDir(nextDir)) return { owned: false, evidence };

  let owned = false;

  if (isDir(join(nextDir, "static", "development"))) {
    owned = true;
    evidence.push(".next/static/development/ exists (only `next dev` writes it)");
  }
  if (existsSync(join(nextDir, "dev-server.pid"))) {
    owned = true;
    evidence.push(".next/dev-server.pid exists");
  }
  for (const entry of safeReaddir(join(nextDir, "cache", "webpack"))) {
    if (/-development/.test(entry)) {
      owned = true;
      evidence.push(
        `.next/cache/webpack/${entry}/ exists (dev-only compiler cache)`,
      );
    }
  }

  // Corroborating only — never enough on their own, and pointless noise when
  // no dev-only artifact was found.
  if (owned) {
    if (existsSync(join(nextDir, "trace"))) {
      evidence.push(".next/trace exists (also written by `next build`)");
    }
    if (existsSync(join(nextDir, "build-manifest.json"))) {
      evidence.push(
        ".next/build-manifest.json exists (also written by `next build`)",
      );
    }
  }

  return { owned, evidence };
}

// ---------------------------------------------------------------------------
// Native identity
// ---------------------------------------------------------------------------

/** Files each platform's identity is read from, relative to the repo root. */
export const NATIVE_IDENTITY_FILES = {
  ios: {
    pbxproj: "ios/App/App.xcodeproj/project.pbxproj",
    infoPlist: "ios/App/App/Info.plist",
  },
  android: {
    // Groovy first; the Kotlin DSL spelling is the fallback.
    buildGradle: "android/app/build.gradle",
    buildGradleKts: "android/app/build.gradle.kts",
    stringsXml: "android/app/src/main/res/values/strings.xml",
  },
};

function readIfExists(path) {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Read the identity values that live inside the committed native trees.
 *
 * @param {{projectDir: string, platforms?: string[]}} input
 * @returns {{ios?: object, android?: object}}
 */
export function readNativeIdentity({ projectDir, platforms = MOBILE_PLATFORMS }) {
  const result = {};

  if (platforms.includes("ios")) {
    const files = NATIVE_IDENTITY_FILES.ios;
    const pbxPath = join(projectDir, files.pbxproj);
    const plistPath = join(projectDir, files.infoPlist);
    const pbxSource = readIfExists(pbxPath);
    const plistSource = readIfExists(plistPath);
    const missing = [];
    if (pbxSource === undefined) missing.push(files.pbxproj);
    if (plistSource === undefined) missing.push(files.infoPlist);

    const pbx = pbxSource ? parsePbxproj(pbxSource) : { bundleIds: [], marketingVersions: [] };
    const plist = plistSource ? parseInfoPlist(plistSource) : {};

    result.ios = {
      bundleIds: pbx.bundleIds,
      marketingVersions: pbx.marketingVersions,
      displayName: plist.CFBundleDisplayName,
      files: { pbxproj: files.pbxproj, infoPlist: files.infoPlist },
      missing,
    };
  }

  if (platforms.includes("android")) {
    const files = NATIVE_IDENTITY_FILES.android;
    let gradleRel = files.buildGradle;
    let gradleSource = readIfExists(join(projectDir, gradleRel));
    if (gradleSource === undefined) {
      gradleRel = files.buildGradleKts;
      gradleSource = readIfExists(join(projectDir, gradleRel));
    }
    const stringsSource = readIfExists(join(projectDir, files.stringsXml));
    const missing = [];
    if (gradleSource === undefined) missing.push(files.buildGradle);
    if (stringsSource === undefined) missing.push(files.stringsXml);

    const gradle = gradleSource ? parseAppBuildGradle(gradleSource) : {};
    const strings = stringsSource ? parseStringsXml(stringsSource) : {};

    result.android = {
      namespace: gradle.namespace,
      applicationId: gradle.applicationId,
      versionName: gradle.versionName,
      versionCode: gradle.versionCode,
      appName: strings.app_name,
      titleActivityMain: strings.title_activity_main,
      packageName: strings.package_name,
      files: { buildGradle: gradleRel, stringsXml: files.stringsXml },
      missing,
    };
  }

  return result;
}

function mismatch(problems, { file, field, found, expected, source }) {
  problems.push(
    `${file}: ${field} is "${found}", but ${source} says "${expected}"`,
  );
}

/**
 * Compare capacitor.config.ts + package.json against the native trees.
 *
 * WHY THIS CHECK EXISTS: @capacitor/cli calls editProjectSettingsIOS and
 * editProjectSettingsAndroid exactly once — right after it extracts the
 * platform template during `cap add`. `cap sync` never revisits them; it only
 * copies the web assets and refreshes the plugin list. So changing `appId` or
 * `appName` in capacitor.config.ts after the native trees were generated
 * updates nothing native. The build stays green and the app ships under the
 * old bundle identifier, which on iOS means it is a different app to App Store
 * Connect and on Android means an upload the Play Console rejects — or, worse,
 * accepts as some other listing.
 *
 * The same holds for versions: MARKETING_VERSION and versionName are written
 * once from whatever the template had, and never tracked against the root
 * package.json version again.
 *
 * Every mismatch is an error, and every mismatch is listed. Stopping at the
 * first one turns a single rename into four sequential failed builds.
 *
 * Only pass the platforms that are actually in the build set — an unbuildable
 * android/ tree on a Mac with no SDK must not fail an iOS-only build.
 *
 * @param {{config: {appId?: string, appName?: string}, pkgVersion: string,
 *          native: object}} input
 * @returns {string[]} human-readable problems, empty when clean
 */
export function checkIdentityDrift({ config, pkgVersion, native }) {
  const problems = [];
  const appId = config?.appId;
  const appName = config?.appName;

  if (!appId) {
    problems.push("capacitor.config.ts: could not read `appId`");
  }
  if (!appName) {
    problems.push("capacitor.config.ts: could not read `appName`");
  }
  if (!pkgVersion) {
    problems.push("package.json: could not read `version`");
  }

  const ios = native?.ios;
  if (ios) {
    for (const file of ios.missing ?? []) {
      problems.push(
        `${file} is missing — the iOS tree is absent or half-generated. ` +
          "Re-run `pnpm cap:add:ios` and commit the result.",
      );
    }
    if ((ios.missing ?? []).length === 0) {
      const bundleIds = [...new Set(ios.bundleIds ?? [])];
      if (bundleIds.length === 0) {
        problems.push(
          `${ios.files.pbxproj}: no PRODUCT_BUNDLE_IDENTIFIER found — the Xcode project looks corrupt`,
        );
      }
      for (const found of bundleIds) {
        if (appId && found !== appId) {
          mismatch(problems, {
            file: ios.files.pbxproj,
            field: "PRODUCT_BUNDLE_IDENTIFIER",
            found,
            expected: appId,
            source: "capacitor.config.ts appId",
          });
        }
      }

      const versions = [...new Set(ios.marketingVersions ?? [])];
      if (versions.length === 0) {
        problems.push(`${ios.files.pbxproj}: no MARKETING_VERSION found`);
      }
      for (const found of versions) {
        if (pkgVersion && found !== pkgVersion) {
          mismatch(problems, {
            file: ios.files.pbxproj,
            field: "MARKETING_VERSION",
            found,
            expected: pkgVersion,
            source: "package.json version",
          });
        }
      }

      const displayName = ios.displayName;
      if (displayName === undefined) {
        problems.push(`${ios.files.infoPlist}: no CFBundleDisplayName found`);
      } else if (displayName.includes("$(")) {
        // Left as an Xcode build-setting reference ($(PRODUCT_NAME)); Xcode
        // resolves it, so there is nothing for us to compare.
      } else if (appName && displayName !== appName) {
        mismatch(problems, {
          file: ios.files.infoPlist,
          field: "CFBundleDisplayName",
          found: displayName,
          expected: appName,
          source: "capacitor.config.ts appName",
        });
      }
    }
  }

  const android = native?.android;
  if (android) {
    for (const file of android.missing ?? []) {
      problems.push(
        `${file} is missing — the Android tree is absent or half-generated. ` +
          "Re-run `pnpm cap:add:android` and commit the result.",
      );
    }
    if ((android.missing ?? []).length === 0) {
      const gradle = android.files.buildGradle;
      const strings = android.files.stringsXml;

      for (const [field, found] of [
        ["namespace", android.namespace],
        ["applicationId", android.applicationId],
      ]) {
        if (found === undefined) {
          problems.push(`${gradle}: no ${field} found`);
        } else if (appId && found !== appId) {
          mismatch(problems, {
            file: gradle,
            field,
            found,
            expected: appId,
            source: "capacitor.config.ts appId",
          });
        }
      }

      if (android.versionName === undefined) {
        problems.push(`${gradle}: no versionName found`);
      } else if (pkgVersion && android.versionName !== pkgVersion) {
        mismatch(problems, {
          file: gradle,
          field: "versionName",
          found: android.versionName,
          expected: pkgVersion,
          source: "package.json version",
        });
      }

      for (const [field, found] of [
        ["app_name", android.appName],
        ["title_activity_main", android.titleActivityMain],
      ]) {
        if (found === undefined) {
          problems.push(`${strings}: no <string name="${field}"> found`);
        } else if (appName && found !== appName) {
          mismatch(problems, {
            file: strings,
            field: `<string name="${field}">`,
            found,
            expected: appName,
            source: "capacitor.config.ts appName",
          });
        }
      }

      // package_name is written by `cap add` from appId. It is checked only
      // when present, because it is not part of every template generation.
      // custom_url_scheme is deliberately NOT checked: people legitimately
      // change the deep-link scheme away from the bundle id.
      if (android.packageName !== undefined && appId && android.packageName !== appId) {
        mismatch(problems, {
          file: strings,
          field: '<string name="package_name">',
          found: android.packageName,
          expected: appId,
          source: "capacitor.config.ts appId",
        });
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Export verification
// ---------------------------------------------------------------------------

/** Collect files under `dir` matching `match`, depth-first, symlinks skipped. */
function listFiles(dir, match, depth = 0) {
  if (depth > 12 || !isDir(dir)) return [];
  const found = [];
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      found.push(...listFiles(full, match, depth + 1));
    } else if (stat.isFile() && match(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Assert the API URL literal actually reached an emitted JS chunk.
 *
 * Next inlines NEXT_PUBLIC_* at build time. If the literal is not in the
 * bundle, the value never reached the compiler — a typo'd variable name, a
 * child process that lost the env, a dotenv file that shadowed it. The app
 * then falls back to relative URLs, resolves every request against its own
 * document origin (capacitor://localhost or https://localhost), and fails on
 * device while building perfectly green.
 *
 * Files over maxFileBytes are skipped: a source map or a vendored WASM blob is
 * not where an inlined literal lives, and reading a 40 MB file into a string to
 * find that out is how this check starts getting deleted.
 *
 * @returns {{ok: boolean, scanned: number, matchedFile?: string}}
 */
export function assertApiUrlInChunks({ outDir, apiUrl, maxFileBytes = 8 * 1024 * 1024 }) {
  const nextDir = join(outDir, "_next");
  const isJs = (name) => name.endsWith(".js");

  let files = listFiles(join(nextDir, "static", "chunks"), isJs);
  if (files.length === 0) {
    // Fallback: chunk layout moves between Next majors, so widen rather than
    // report a false "not found" because the directory was renamed.
    files = listFiles(nextDir, isJs);
  }

  let scanned = 0;
  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.size > maxFileBytes) continue;
    scanned++;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (source.includes(apiUrl)) {
      return { ok: true, scanned, matchedFile: file };
    }
  }

  return { ok: false, scanned };
}

/** The literal a relative assetPrefix leaves in every emitted HTML document. */
export const RELATIVE_ASSET_PREFIX_MARKER = "\"./_next";

/**
 * Assert no emitted HTML references assets as "./_next/...".
 *
 * `assetPrefix: "./"` is correct for Electron, which loads the export over
 * file:// from a real directory tree. It is wrong for Capacitor: the WebView
 * serves the export from capacitor://localhost/ with trailingSlash routing, so
 * a document at /settings/index.html resolves "./_next/..." to
 * /settings/_next/..., which does not exist. The root route works, every
 * nested route is a blank screen with 404s in a console nobody has open.
 *
 * @returns {{ok: boolean, scanned: number, offenders: string[]}}
 */
export function assertNoRelativeAssetPrefix({ outDir }) {
  const files = listFiles(outDir, (name) => name.endsWith(".html"));
  const offenders = [];
  let scanned = 0;
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scanned++;
    if (source.includes(RELATIVE_ASSET_PREFIX_MARKER)) offenders.push(file);
  }
  return { ok: offenders.length === 0, scanned, offenders };
}

/**
 * True when `path` exists and carries the executable bit for this user.
 * Exported because the Android toolchain probe needs it and it is annoying to
 * restate; git drops the bit on some checkouts and Gradle then "is missing".
 */
export function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
