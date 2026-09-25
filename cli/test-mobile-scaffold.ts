/**
 * Mobile feature scaffold + update integration tests.
 *
 * Two paths have to produce the same project, and the failure when they
 * diverge is silent in both directions:
 *
 *   · a file added to the starter and listed only in the strip never
 *     reaches an existing project through `hatchkit update`;
 *   · a file listed only in the add is left behind by a scaffold that
 *     declined mobile, where it imports modules and packages that were
 *     removed — and the project fails its first build.
 *
 * So `scaffold/mobile-feature.ts` is the one manifest, and this file
 * asserts both directions against a real scaffold on disk, plus the
 * edits that live in files the feature does not own: the pre-paint root
 * marker in layout.tsx, the two stylesheet imports in globals.css, and
 * the .gitignore holes that make the native trees committable.
 *
 * Run: pnpm --filter hatchkit test:mobile-scaffold
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolate from the real user config, keychain and Caddy dir — see
// test-scaffold.ts for why these must be set before the dynamic imports.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "mobile-scaffold-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mobile-scaffold-devdir-"));

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

const { scaffoldApp } = await import("./src/scaffold/app.js");
const { runUpdate } = await import("./src/scaffold/update.js");
const { MOBILE_DEPS, MOBILE_PATHS, MOBILE_SCRIPTS } = await import(
  "./src/scaffold/mobile-feature.js"
);
const { mobileLiveReloadOrigins, nativeClientOrigins } = await import(
  "./src/scaffold/native-origins.js"
);
type Feature = import("./src/prompts.js").Feature;
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${msg}`);
}
function section(name: string): void {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}`);
}
const read = (d: string, rel: string): string =>
  existsSync(join(d, rel)) ? readFileSync(join(d, rel), "utf-8") : "";
/** Source with comments removed.
 *
 *  Both checks that use this previously matched the file's OWN PROSE
 *  explaining why the thing is absent — `capacitor.config.ts` says
 *  "never set a custom iosScheme", and `native.css` says "no !important
 *  anywhere in this file". A substring search over the raw text passes on
 *  a file that reintroduced either one, which makes the assertion worse
 *  than useless. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
    .join("\n");

const pkgOf = (d: string): { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =>
  JSON.parse(read(d, "package.json") || "{}");

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

const dirs: string[] = [];
function scratch(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `mobile-${label}-`));
  dirs.push(d);
  return d;
}

try {
  // ── the manifest is the single source ───────────────────────────────
  section("the feature manifest is honoured by both call sites");
  {
    const appSrc = readFileSync(join(import.meta.dirname, "src/scaffold/app.ts"), "utf-8");
    const updateSrc = readFileSync(join(import.meta.dirname, "src/scaffold/update.ts"), "utf-8");
    assert(
      appSrc.includes("MOBILE_PATHS") && updateSrc.includes("MOBILE_PATHS"),
      "both the strip and the add iterate the shared path list rather than their own literals",
    );
    assert(
      !/"@capacitor\/preferences"/.test(updateSrc),
      "update.ts does not carry its own copy of the dependency list",
    );
    assert(MOBILE_PATHS.includes("ios") && MOBILE_PATHS.includes("android"), "the native trees are part of the feature");
    assert(
      MOBILE_SCRIPTS.includes("cap:sync"),
      "the retired `cap:sync` stays in the strip list, so an older project loses it on update — " +
        "a bare cap sync skips every check build-mobile.mjs performs",
    );
  }

  // ── a scaffold WITHOUT mobile must be clean ─────────────────────────
  section("scaffold without mobile leaves nothing behind");
  {
    const d = scratch("nomobile");
    await scaffoldApp(cfg("nomobile", []), d);

    for (const rel of MOBILE_PATHS) {
      assert(!existsSync(join(d, rel)), `stripped: ${rel}`);
    }

    const pkg = pkgOf(d);
    for (const s of MOBILE_SCRIPTS) {
      assert(!(s in (pkg.scripts ?? {})), `script stripped: ${s}`);
    }
    for (const dep of MOBILE_DEPS) {
      assert(
        !(dep in (pkg.dependencies ?? {})) && !(dep in (pkg.devDependencies ?? {})),
        `dependency stripped: ${dep}`,
      );
    }

    const layout = read(d, "packages/client/src/app/layout.tsx");
    assert(!layout.includes("MobileBridgeLoader"), "the bridge loader is out of the layout");
    assert(
      !layout.includes("ROOT_MARKER_SCRIPT"),
      "the pre-paint marker is out of the layout — its module was just deleted",
    );
    assert(
      layout.includes("viewportFit"),
      "the viewport export STAYS: `viewport-fit=cover` is not a mobile setting, and one static " +
        "export serves the browser too",
    );

    const globals = read(d, "packages/client/src/styles/globals.css");
    assert(
      !globals.includes("native.css") && !globals.includes("standalone.css"),
      "globals.css no longer imports stylesheets that are not there — otherwise the first build fails",
    );
  }

  // ── a scaffold WITH mobile is wired end to end ──────────────────────
  section("scaffold with mobile is wired");
  {
    const d = scratch("withmobile");
    await scaffoldApp(cfg("withmobile", ["mobile"]), d);

    for (const rel of MOBILE_PATHS) {
      // ios/ and android/ are generated per machine by `pnpm cap:add:*`
      // and then committed; the starter has no copy to hand over.
      if (rel === "ios" || rel === "android") continue;
      assert(existsSync(join(d, rel)), `present: ${rel}`);
    }

    const pkg = pkgOf(d);
    assert(
      pkg.scripts?.["build:mobile"] === "node scripts/build-mobile.mjs",
      "build:mobile points at the one supported entry point, not `cap sync`",
    );
    assert(!("cap:sync" in (pkg.scripts ?? {})), "there is no bare `cap:sync` escape hatch");
    assert(
      (pkg.scripts?.["cap:run:ios"] ?? "").includes("--no-sync"),
      "cap:run goes through the build script and then tells cap not to sync again",
    );
    assert(
      "@capacitor/network" in (pkg.dependencies ?? {}),
      "the radio plugin is a dependency — navigator.onLine lies on a dead radio in WKWebView",
    );
    assert(
      "@aparajita/capacitor-secure-storage" in (pkg.dependencies ?? {}),
      "the keychain plugin is a dependency — the preference store is readable from an unencrypted backup",
    );

    const cap = read(d, "capacitor.config.ts");
    assert(cap.includes("com.example.withmobile"), "the bundle id is substituted");
    assert(!cap.includes("{{"), "no template placeholder survives");
    assert(
      cap.includes('webDir: "packages/client/out-mobile"'),
      "the mobile export has its own directory — a shared one means a test run can be installed as the app",
    );
    assert(
      !/iosScheme|androidScheme/.test(stripComments(cap)),
      "no custom scheme is set: the scheme IS the origin, and changing it orphans every stored preference",
    );

    const layout = read(d, "packages/client/src/app/layout.tsx");
    assert(layout.includes("ROOT_MARKER_SCRIPT"), "the pre-paint marker is mounted");
    assert(
      /<head>[\s\S]{0,400}ROOT_MARKER_SCRIPT/.test(layout),
      "and it sits in <head>, before the first paint",
    );
    assert(
      !/document\.body[^\n]*\bcap\b/.test(read(d, "packages/client/src/mobile/platform.ts")),
      "the marker goes on <html>, never <body> — a <body> mutation forces suppressHydrationWarning",
    );

    const globals = read(d, "packages/client/src/styles/globals.css");
    assert(globals.includes('@import "./native.css"'), "native.css is imported");
    assert(globals.includes('@import "./standalone.css"'), "standalone.css is imported");
    const firstRule = globals.search(/^[^@\n/ ][^\n]*\{/m);
    const lastImport = globals.lastIndexOf("@import");
    assert(
      firstRule === -1 || lastImport < firstRule,
      "every @import precedes the first rule — CSS requires it",
    );

    const nativeCss = read(d, "packages/client/src/styles/native.css");
    const selectorLines = stripComments(nativeCss)
      .split("\n")
      .filter((l) => /\{\s*$/.test(l) && !/^\s*@/.test(l));
    assert(selectorLines.length > 0, "native.css has rules");
    assert(
      selectorLines.every((l) => l.includes("html.cap")),
      "EVERY selector in native.css is under html.cap — it is inert on web by construction",
    );
    assert(
      !stripComments(nativeCss).includes("!important"),
      "no !important: the file is unlayered and Tailwind's utilities are in @layer utilities, " +
        "so the cascade already does the work",
    );

    const standalone = read(d, "packages/client/src/styles/standalone.css");
    assert(
      standalone.includes("display-mode: standalone"),
      "standalone.css targets the installed web app",
    );
    assert(
      standalone.includes("html:not(.cap)"),
      "and is scoped html:not(.cap), so it can never double up with the native rules",
    );

    const ignore = read(d, ".gitignore");
    assert(
      !/^ios\/\s*$/m.test(ignore) && !/^android\/\s*$/m.test(ignore),
      "the native trees are NOT ignored — the hand edits live only there",
    );
    assert(
      ignore.includes("ios/App/App/public/") &&
        ignore.includes("android/app/src/main/assets/public/") &&
        ignore.includes("android/capacitor-cordova-android-plugins/"),
      "the generated-and-untracked holes are punched — these are why a never-built checkout " +
        "cannot open in Xcode or Gradle",
    );
    assert(
      ignore.includes("packages/client/out-mobile/"),
      "the mobile export directory is ignored",
    );
    assert(
      ignore.includes("android/app/release.keystore"),
      "the signing key is never committed",
    );

    const nextConfig = read(d, "packages/client/next.config.ts");
    assert(nextConfig.includes("NEXT_EXPORT_DIR"), "the generated config honours the export dir");
    // No `assetPrefix`, for either shell. A relative prefix resolves against
    // the CURRENT path, so under `trailingSlash: true` a document at
    // /app/settings/ asks for /app/settings/_next/… and every chunk 404s.
    // Electron is not an exception: `app://-` is a standard origin with a
    // root, and electron/src/resolve-app-path.ts resolves a request path
    // literally — it does not re-resolve a relative one. The prefix was only
    // ever needed while the shell loaded index.html off file://.
    assert(
      !nextConfig.includes("assetPrefix"),
      "no assetPrefix — a relative prefix breaks every nested route in both shells",
    );
    assert(
      nextConfig.includes("allowedDevOrigins"),
      "Android live reload needs the dev origin allowed, or every chunk is blocked behind the splash",
    );

    const envExample = read(d, "packages/server/.env.example");
    for (const origin of nativeClientOrigins(["mobile"])) {
      assert(envExample.includes(origin), `the server trusts ${origin}`);
    }
  }

  // ── adding mobile to an existing project ────────────────────────────
  section("hatchkit update adds mobile to an existing project");
  {
    const d = scratch("update");
    await scaffoldApp(cfg("updated", []), d);
    assert(!existsSync(join(d, "capacitor.config.ts")), "precondition: no mobile yet");

    await runUpdate(d, {
      presets: {
        desiredFeatures: ["mobile"] as Feature[],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
      },
    });

    for (const rel of MOBILE_PATHS) {
      if (rel === "ios" || rel === "android") continue;
      assert(existsSync(join(d, rel)), `update copied: ${rel}`);
    }

    const pkg = pkgOf(d);
    assert(pkg.scripts?.["build:mobile"] !== undefined, "update added build:mobile");
    assert(!("cap:sync" in (pkg.scripts ?? {})), "update does not reintroduce a bare cap:sync");
    assert(
      "@capacitor/network" in (pkg.dependencies ?? {}),
      "update added the newer plugins, not just the original set",
    );

    const layout = read(d, "packages/client/src/app/layout.tsx");
    assert(layout.includes("MobileBridgeLoader"), "update mounted the bridge loader");
    assert(layout.includes("ROOT_MARKER_SCRIPT"), "update mounted the pre-paint marker");

    const globals = read(d, "packages/client/src/styles/globals.css");
    assert(globals.includes('@import "./native.css"'), "update imported native.css");
    const firstRule = globals.search(/^[^@\n/ ][^\n]*\{/m);
    assert(
      firstRule === -1 || globals.lastIndexOf("@import") < firstRule,
      "update inserted the imports BEFORE the first rule, not appended at the end",
    );

    const ignore = read(d, ".gitignore");
    assert(
      !/^ios\/\s*$/m.test(ignore),
      "update un-ignored the native trees — otherwise the hand edits stay on one machine",
    );
    assert(ignore.includes("ios/App/App/public/"), "update punched the generated holes");

    const cap = read(d, "capacitor.config.ts");
    assert(!cap.includes("{{"), "update substituted the identifiers");

    // Re-running must be a no-op rather than a second copy of anything.
    const before = { layout, globals, ignore, cap };
    await runUpdate(d, {
      presets: {
        desiredFeatures: ["mobile"] as Feature[],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
      },
    });
    assert(
      read(d, "packages/client/src/app/layout.tsx") === before.layout,
      "a second update leaves layout.tsx byte-identical",
    );
    assert(
      read(d, "packages/client/src/styles/globals.css") === before.globals,
      "a second update does not import the stylesheets twice",
    );
    assert(read(d, ".gitignore") === before.ignore, "a second update does not duplicate the ignores");
    assert(read(d, "capacitor.config.ts") === before.cap, "a second update leaves the config alone");
  }

  // ── a half-upgraded project is completed, not left half ─────────────
  section("update fills a project that has only part of the feature");
  {
    const d = scratch("partial");
    await scaffoldApp(cfg("partial", ["mobile"]), d);
    // Simulate a project scaffolded before the build script existed: the
    // parent directories are there, the new files are not.
    rmSync(join(d, "scripts/lib"), { recursive: true, force: true });
    rmSync(join(d, "packages/client/src/mobile/network.ts"), { force: true });
    writeFileSync(join(d, "packages/client/src/mobile/bridge.ts"), "// hand-edited\n", "utf-8");

    await runUpdate(d, {
      presets: {
        desiredFeatures: ["mobile"] as Feature[],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
      },
    });

    assert(
      existsSync(join(d, "scripts/lib/mobile-build.mjs")),
      "a missing file inside an EXISTING directory is still copied — a whole-directory skip " +
        "would leave the project half-upgraded",
    );
    assert(
      existsSync(join(d, "packages/client/src/mobile/network.ts")),
      "the missing module is restored",
    );
    assert(
      read(d, "packages/client/src/mobile/bridge.ts") === "// hand-edited\n",
      "a file that already exists is never overwritten — update layers a feature on, it does not reset",
    );
  }

  // ── live-reload origins are not the app's origins ───────────────────
  section("live-reload origins are separate from the bundle's");
  {
    const bundle = nativeClientOrigins(["mobile"]);
    assert(
      bundle.includes("capacitor://localhost") && bundle.includes("https://localhost"),
      "the bundle origins are the iOS and Android document origins",
    );
    assert(
      !bundle.some((o) => o.includes("10.0.2.2")),
      "the emulator's live-reload origin is NOT in the production trust list",
    );

    const live = mobileLiveReloadOrigins({ port: 3000 });
    assert(
      live.includes("http://10.0.2.2:3000"),
      "the Android emulator reaches the host through its NAT alias, never `localhost`",
    );
    assert(live.includes("http://localhost:3000"), "the iOS Simulator shares the Mac's namespace");
    assert(
      !live.some((o) => bundle.includes(o)),
      "no overlap: live reload never exercises the real origin, which is why an auth change " +
        "verified under dev:ios can still fail on the first install",
    );
    assert(
      mobileLiveReloadOrigins({ port: 3000, lanIp: "192.168.1.9" }).includes(
        "http://192.168.1.9:3000",
      ),
      "a physical device on the LAN can be named explicitly",
    );
  }
} finally {
  const { clearAllSecrets } = await import("./src/utils/secrets.js");
  await clearAllSecrets();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });
  rmSync(process.env.HATCHKIT_DEV_CONFIG_DIR!, { recursive: true, force: true });
}

console.log();
if (failed > 0) {
  console.error(`✗ ${failed} assertion(s) failed\n`);
  process.exit(1);
}
console.log("✓ mobile scaffold + update: all assertions passed\n");
