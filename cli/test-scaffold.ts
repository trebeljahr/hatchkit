/**
 * Scaffold regression matrix.
 *
 * Exercises the copy-from-starter scaffolder across combinations of
 * feature flags (websocket, stripe, desktop, mobile) and asserts the
 * expected files are kept or removed, bundle IDs are sanitized, and
 * next.config.ts is flipped correctly.
 *
 * Requires the `starter/` submodule path to resolve to a checkout of
 * node-realtime-starter (init the submodule or symlink it). Exits 0
 * with a skip message when the starter is missing, so the test is safe
 * to run in CI environments without submodule init.
 *
 * Run: pnpm test
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Isolate the test from the real user config. ESM hoists static
// imports above the `process.env = ...` line, so config.ts would
// otherwise read the real `~/Library/Preferences/hatchkit-nodejs/`
// path before the env var is set. Dynamic imports (below) run AFTER
// this assignment, so the isolated paths actually take effect.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "scaffold-conf-"));
// Same story for the OS keychain: every scaffold mints a dotenvx
// private key and stashes it under the "hatchkit" service. Route
// the test suite to a throwaway service so we don't pollute the real
// user's keychain. clearAllSecrets() at the end wipes it.
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
// The Tailscale local-dev integration writes Caddy fragments to
// ~/.config/dev/projects/ on the host. The test suite redirects that
// root to a throwaway dir so localDev-opt-in scaffolds never touch
// the real user's Caddy setup. Cleaned up at the end of the run
// alongside HATCHKIT_CONF_DIR.
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "scaffold-devdir-"));

const { scaffoldApp } = await import("./src/scaffold/app.js");
type Feature = import("./src/prompts.js").Feature;
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

function cfg(
  name: string,
  features: Feature[],
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
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
    ...overrides,
  };
}

type Check = [string, boolean];

/** Source with comments removed, for assertions that count occurrences of
 *  a config key. Generated files document the rules they implement, so a
 *  raw substring count reads the prose as code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}


async function run(
  label: string,
  name: string,
  features: Feature[],
  expect: (d: string) => Check[],
  overrides: Partial<ProjectConfig> = {},
): Promise<boolean> {
  const d = mkdtempSync(join(tmpdir(), `scaffold-${label}-`));
  try {
    console.log(`\n── ${label} ─────────────────────────────`);
    await scaffoldApp(cfg(name, features, overrides), d);
    const checks = expect(d);
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    return ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ── CI workflow helpers ──────────────────────────────────────────────
// The surface prunes strip jobs out of build-and-deploy.yml (a backend
// scaffold has no packages/client/Dockerfile to build, a static one has
// no packages/server/Dockerfile). Removing a job without shrinking the
// `needs:` lists that name it produces a workflow GitHub rejects
// wholesale, so the checks below assert both halves.

/** Top-level job names declared under `jobs:` (2-space indent). Slices
 *  from the `jobs:` key first — `on:`'s `  push:` is also a bare
 *  2-space key and would otherwise read as a job. */
function ciJobNames(workflow: string): string[] {
  const start = workflow.search(/^jobs:\s*$/m);
  if (start < 0) return [];
  return [...workflow.slice(start).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
}

/** Every job name referenced from a `needs: [...]` flow sequence. */
function ciNeeds(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*needs:\s*\[([^\]]*)\]\s*$/gm)].flatMap((m) =>
    m[1]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  );
}

/** No `needs:` entry may name a job the prune deleted — that's the
 *  failure mode that takes the whole workflow down, not just one job. */
function ciNeedsAreResolvable(workflow: string): boolean {
  const declared = new Set(ciJobNames(workflow));
  return ciNeeds(workflow).every((n) => declared.has(n));
}

const results: Record<string, boolean> = {};

results.minimal = await run("minimal (no flags)", "plain-app", [], (d) => {
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
  const serverEnv = readFileSync(join(d, "packages/server/.env.example"), "utf-8");
  const clientEnv = readFileSync(join(d, "packages/client/.env.example"), "utf-8");
  const serverEnvDev = readFileSync(join(d, "packages/server/.env.development"), "utf-8");
  const clientEnvDev = readFileSync(join(d, "packages/client/.env.development"), "utf-8");
  const manifest = JSON.parse(readFileSync(join(d, ".hatchkit.json"), "utf-8"));
  const ciWorkflow = readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8");
  const clientDockerfile = readFileSync(join(d, "packages/client/Dockerfile"), "utf-8");
  const compose = readFileSync(join(d, "docker-compose.yml"), "utf-8");
  const gitignore = existsSync(join(d, ".gitignore"))
    ? readFileSync(join(d, ".gitignore"), "utf-8")
    : "";
  const claudeMd = readFileSync(join(d, "CLAUDE.md"), "utf-8");
  return [
    ["package.json renamed", pkg.name === "plain-app"],
    [".gitignore copied into scaffold", gitignore.length > 0],
    [".gitignore lists .env.keys (NEVER commit private keys)", /^\.env\.keys$/m.test(gitignore)],
    ["electron/ removed", !existsSync(join(d, "electron"))],
    ["resources/ removed", !existsSync(join(d, "resources"))],
    ["capacitor.config.ts removed", !existsSync(join(d, "capacitor.config.ts"))],
    ["ws/ removed (no websocket)", !existsSync(join(d, "packages/server/src/ws"))],
    ["stripe service removed", !existsSync(join(d, "packages/server/src/services/stripe.ts"))],
    ["no electron deps", !pkg.devDependencies?.electron],
    ["no capacitor deps", !pkg.dependencies?.["@capacitor/core"]],
    ["no build block", !pkg.build],
    [
      "next.config stays standalone",
      readFileSync(join(d, "packages/client/next.config.ts"), "utf-8").includes('output: "standalone"'),
    ],
    [
      "server .env.example FRONTEND_URL rewritten to https",
      /^FRONTEND_URL=https:\/\/plain-app\.example\.com$/m.test(serverEnv),
    ],
    [
      "server .env.example BETTER_AUTH_URL rewritten to bare domain (single-domain routing)",
      /^BETTER_AUTH_URL=https:\/\/plain-app\.example\.com$/m.test(serverEnv),
    ],
    [
      "client .env.example NEXT_PUBLIC_API_URL rewritten to bare domain",
      /^NEXT_PUBLIC_API_URL=https:\/\/plain-app\.example\.com$/m.test(clientEnv),
    ],
    [
      "client .env.example NEXT_PUBLIC_WS_URL uses wss on bare domain",
      /^NEXT_PUBLIC_WS_URL=wss:\/\/plain-app\.example\.com$/m.test(clientEnv),
    ],
    // `.env.development` stays on localhost (only `.env.example` gets the
    // production domain) — but the ports in it are per-project, so the
    // assertion has to follow the manifest's allocation, not the starter's
    // hardcoded 3000/5000. FRONTEND_URL points at the CLIENT port because
    // getTrustedOrigins() feeds it to better-auth and CORS; before the fix it
    // stayed pinned at :3000 while scripts/dev.mjs booted the client
    // somewhere in the 6000s, so local auth broke on every fresh scaffold.
    // Assert on VALUE lines only: the file's comments legitimately mention
    // https:// when contrasting local dev with production.
    [
      ".env.development stays on localhost",
      !serverEnvDev
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .some((l) => l.includes("https://")),
    ],
    [
      "server .env.development FRONTEND_URL → allocated client port",
      new RegExp(`^FRONTEND_URL=http://localhost:${manifest.ports.client}$`, "m").test(
        serverEnvDev,
      ),
    ],
    [
      "server .env.development PORT → allocated server port",
      new RegExp(`^PORT=${manifest.ports.server}$`, "m").test(serverEnvDev),
    ],
    [
      "server .env.development BETTER_AUTH_URL → allocated server port",
      new RegExp(`^BETTER_AUTH_URL=http://localhost:${manifest.ports.server}$`, "m").test(
        serverEnvDev,
      ),
    ],
    [
      "server .env.development has no stale localhost:3000",
      !/localhost:3000/.test(serverEnvDev),
    ],
    [
      "server .env.development has no stale localhost:5000",
      !/localhost:5000/.test(serverEnvDev),
    ],
    [
      "server .env.development has exactly one FRONTEND_URL line",
      (serverEnvDev.match(/^FRONTEND_URL=/gm) ?? []).length === 1,
    ],
    [
      "server .env.development sets a non-empty MONGODB_URI",
      /^MONGODB_URI=mongodb(\+srv)?:\/\/\S+$/m.test(serverEnvDev),
    ],
    [
      "server .env.development carries no private-key material",
      !/DOTENV_PRIVATE_KEY|encrypted:/.test(serverEnvDev),
    ],
    // Cross-package coherence: the client actually boots on the port the
    // server is configured to trust.
    [
      "client dev PORT === server FRONTEND_URL port",
      clientEnvDev.match(/^PORT=(\d+)$/m)?.[1] ===
        serverEnvDev.match(/^FRONTEND_URL=http:\/\/localhost:(\d+)$/m)?.[1],
    ],
    [
      "client dev NEXT_PUBLIC_API_URL === allocated server port",
      clientEnvDev.match(/^NEXT_PUBLIC_API_URL=http:\/\/localhost:(\d+)$/m)?.[1] ===
        String(manifest.ports.server),
    ],
    [
      "TRUSTED_ORIGINS stays commented out (no native clients)",
      /^#\s*TRUSTED_ORIGINS=/m.test(serverEnv),
    ],
    [
      "deploy workflow: native sign-in check present with an empty origin list",
      readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8").includes(
        'HATCHKIT_NATIVE_ORIGINS: ""',
      ),
    ],
    // The client image bakes NEXT_PUBLIC_* at BUILD time — the CI
    // workflow must carry the literal production URLs as build args,
    // the Dockerfile must accept them, and the compose file must NOT
    // pretend runtime env reaches the browser bundle.
    [
      "CI workflow client build-args carry literal API URL",
      /^\s*NEXT_PUBLIC_API_URL=https:\/\/plain-app\.example\.com$/m.test(ciWorkflow),
    ],
    [
      "CI workflow client build-args carry literal WS URL",
      /^\s*NEXT_PUBLIC_WS_URL=wss:\/\/plain-app\.example\.com$/m.test(ciWorkflow),
    ],
    [
      "client Dockerfile declares NEXT_PUBLIC_API_URL build arg",
      clientDockerfile.includes("ARG NEXT_PUBLIC_API_URL"),
    ],
    [
      "client Dockerfile sets HATCHKIT_IMAGE_BUILD guard",
      clientDockerfile.includes("HATCHKIT_IMAGE_BUILD=1"),
    ],
    ["docker-compose has no runtime NEXT_PUBLIC_*", !/^\s*NEXT_PUBLIC_/m.test(compose)],
    // Fullstack keeps every job — the surface prunes must not reach it.
    [
      "CI workflow keeps all four jobs",
      ["verify", "e2e", "build-server", "build-client", "deploy"].every((j) =>
        ciJobNames(ciWorkflow).includes(j),
      ),
    ],
    ["CI workflow needs: entries all resolve", ciNeedsAreResolvable(ciWorkflow)],
    // CLAUDE.md is the first file an agent reads in a generated project.
    // A fullstack scaffold keeps the server-side sections; the marker
    // syntax that drives the pruning must never survive.
    ["CLAUDE.md H1 renamed", /^# plain-app$/m.test(claudeMd)],
    ["CLAUDE.md leaves no hatchkit: markers", !claudeMd.includes("hatchkit:")],
    ["CLAUDE.md keeps the Express middleware section", claudeMd.includes("Critical Middleware Ordering")],
    ["CLAUDE.md keeps the dotenvx section", claudeMd.includes("Environment & Secrets")],
    ["CLAUDE.md keeps both package trees", claudeMd.includes("packages/server/src/") && claudeMd.includes("packages/client/src/")],
    ["CLAUDE.md drops the newsletter smoke commands (no mailing list)", !claudeMd.includes("newsletter:verify")],
    ["CLAUDE.md drops the native section (no desktop/mobile)", !claudeMd.includes("Capacitor")],
    ["CLAUDE.md drops the Stripe inline span (stripe not selected)", !claudeMd.includes("Stripe for payments")],
    ["CLAUDE.md drops the WebSocket bullet (websocket not selected)", !claudeMd.includes("**Real-time:**")],
    ["CLAUDE.md has no 3-blank-line runs", !/\n{3,}/.test(claudeMd)],
  ];
});

results.websocket = await run("websocket only", "rt-app", ["websocket"], (d) => {
  return [
    ["ws/ kept", existsSync(join(d, "packages/server/src/ws"))],
    ["stripe service removed", !existsSync(join(d, "packages/server/src/services/stripe.ts"))],
  ];
});

results.extension = await run("browser extension", "ext-app", ["extension"], (d) => {
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
  const manifestConfig = readFileSync(join(d, "packages/extension/manifest.config.ts"), "utf-8");
  const app = readFileSync(join(d, "packages/server/src/app.ts"), "utf-8");
  const auth = readFileSync(join(d, "packages/server/src/auth/auth.ts"), "utf-8");
  const layout = readFileSync(join(d, "packages/client/src/app/layout.tsx"), "utf-8");
  const claudeMd = readFileSync(join(d, "CLAUDE.md"), "utf-8");
  return [
    ["extension package written", existsSync(join(d, "packages/extension/src/background/bridge.ts"))],
    ["bridge protocol lands in the shared package", existsSync(join(d, "packages/shared/src/extension-bridge.ts"))],
    ["web half written", existsSync(join(d, "packages/client/src/components/ExtensionBridge.tsx"))],
    ["device approval page written", existsSync(join(d, "packages/client/src/app/device/page.tsx"))],
    ["release workflow written", existsSync(join(d, ".github/workflows/extension-release.yml"))],
    ["packaging script written", existsSync(join(d, "scripts/extension-package.mjs"))],
    ["no placeholder survived rendering", !manifestConfig.includes("__HATCHKIT_")],
    ["the dev target points at this project's server port", manifestConfig.includes("apiUrl: \"http://localhost:")],
    ["build scripts added", pkg.scripts?.["build:extension:firefox"] === "pnpm --filter @starter/extension run build:firefox"],
    // The wiring, which is what makes the extension able to talk at all.
    ["server answers /api/health for every origin", app.includes('res.setHeader("Access-Control-Allow-Origin", "*")')],
    ["server reports originTrusted", app.includes("originTrusted:")],
    ["better-auth gets the bearer + device plugins", auth.includes("bearer(),") && auth.includes("deviceAuthorization({")],
    ["the bridge is mounted once", layout.match(/<ExtensionBridge \/>/g)?.length === 1],
    ["CLAUDE.md documents the extension", claudeMd.includes("## Browser Extension")],
    ["CLAUDE.md leaves no hatchkit: markers", !claudeMd.includes("hatchkit:")],
  ];
});

results.extensionRefused = await run(
  "browser extension refused on a static surface",
  "static-ext-app",
  ["extension"],
  (d) => [
    // The feature needs the shared client core AND a server runtime.
    // A static project has neither half of the trust decision, so the
    // scaffold says so instead of writing files that cannot work.
    ["no extension package", !existsSync(join(d, "packages/extension"))],
    ["no release workflow", !existsSync(join(d, ".github/workflows/extension-release.yml"))],
  ],
  { surfaces: "static" },
);

results.desktop = await run("desktop only", "my-cool-app", ["desktop"], (d) => {
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
  const nextCfg = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
  const claudeMd = readFileSync(join(d, "CLAUDE.md"), "utf-8");
  const builderCfg = readFileSync(join(d, "electron-builder.config.mjs"), "utf-8");
  return [
    ["electron/src/main.ts kept", existsSync(join(d, "electron/src/main.ts"))],
    ["electron-builder.config.mjs kept", existsSync(join(d, "electron-builder.config.mjs"))],
    ["build-desktop.mjs kept", existsSync(join(d, "scripts/build-desktop.mjs"))],
    ["build/icon.png placeholder kept", statSync(join(d, "build/icon.png")).size > 1000],
    ["desktop workflow kept", existsSync(join(d, ".github/workflows/desktop-release.yml"))],
    ["mobile workflow removed", !existsSync(join(d, ".github/workflows/mobile-release.yml"))],
    ["resources/ removed", !existsSync(join(d, "resources"))],
    ["electron dep present", !!pkg.devDependencies?.electron],
    ["icon-gen dep present", !!pkg.devDependencies?.["icon-gen"]],
    ["no capacitor deps", !pkg.dependencies?.["@capacitor/core"]],
    // electron-builder reads electron-builder.config.mjs, which
    // scripts/build-desktop.mjs passes with an explicit --config. The `build`
    // block in package.json is gone; a project that kept one would be editing
    // a file the build never reads.
    ["no stale electron-builder block in package.json", pkg.build === undefined],
    ["bundleId sanitized (no hyphens)", builderCfg.includes('appId: "com.example.mycoolapp"')],
    // The display name is a real name, not the slug: `name` is what npm and
    // the image registry use, `productName` is what a person reads.
    [
      "productName is the display name, not the slug",
      builderCfg.includes('productName: "My Cool App"'),
    ],
    ["package.json name stays the slug", pkg.name === "my-cool-app"],
    ["no identifier token left in the builder config", !/\{\{[a-zA-Z]+\}\}/.test(builderCfg)],
    ["typecheck chains electron", pkg.scripts?.typecheck?.includes("typecheck:electron")],
    ["next.config flipped to export", nextCfg.includes('output: "export"')],
    // No assetPrefix: every shell serves the export from an origin with a real
    // root, and a relative prefix resolves against the current directory, so
    // nested routes look for their chunks in the wrong place and render blank.
    ["next.config has no assetPrefix", !nextCfg.includes("assetPrefix")],
    ["next.config has trailingSlash", nextCfg.includes("trailingSlash: true")],
    ["scripts/icons-desktop.mjs kept", existsSync(join(d, "scripts/icons-desktop.mjs"))],
    // Nested conditionals: the native section survives, but only the
    // Electron subsection inside it.
    ["CLAUDE.md keeps the Electron section", claudeMd.includes("### Desktop (Electron)")],
    ["CLAUDE.md drops the Tauri section", !claudeMd.includes("Tauri")],
    ["CLAUDE.md drops the Mobile section", !claudeMd.includes("### Mobile")],
    ["CLAUDE.md keeps static-export caveats", claudeMd.includes("Static export caveats")],
    ["CLAUDE.md leaves no hatchkit: markers", !claudeMd.includes("hatchkit:")],
  ];
});

results.mobile = await run("mobile only", "my-cool-app", ["mobile"], (d) => {
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
  const capCfg = readFileSync(join(d, "capacitor.config.ts"), "utf-8");
  const androidDev = readFileSync(join(d, "scripts/android-dev.sh"), "utf-8");
  const iosDev = readFileSync(join(d, "scripts/ios-dev.sh"), "utf-8");
  const layout = readFileSync(join(d, "packages/client/src/app/layout.tsx"), "utf-8");
  const serverEnv = readFileSync(join(d, "packages/server/.env.example"), "utf-8");
  return [
    [
      "TRUSTED_ORIGINS pre-populated with capacitor://localhost",
      /^TRUSTED_ORIGINS=.*capacitor:\/\/localhost/m.test(serverEnv),
    ],
    [
      "TRUSTED_ORIGINS includes https://localhost",
      /^TRUSTED_ORIGINS=.*https:\/\/localhost/m.test(serverEnv),
    ],
    [
      "deploy workflow probes the same origins .env.example trusts",
      readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8").includes(
        `HATCHKIT_NATIVE_ORIGINS: "${/^TRUSTED_ORIGINS=(.*)$/m.exec(serverEnv)?.[1]}"`,
      ),
    ],
    ["capacitor.config.ts kept", existsSync(join(d, "capacitor.config.ts"))],
    ["mobile bridge kept", existsSync(join(d, "packages/client/src/mobile/bridge.ts"))],
    ["resources/icon.png kept", statSync(join(d, "resources/icon.png")).size > 1000],
    ["android-dev.sh kept", existsSync(join(d, "scripts/android-dev.sh"))],
    ["android-dev.sh honors CAP_DEV_URL override", androidDev.includes('CAP_DEV_URL="${CAP_DEV_URL:-http://$DEV_HOST:$NEXT_PORT}"')],
    ["android-dev.sh can derive Tailscale URL", androidDev.includes("localDev") && androidDev.includes("localDevDomain")],
    ["ios-dev.sh honors CAP_DEV_URL override", iosDev.includes('CAP_DEV_URL="${CAP_DEV_URL:-http://$DEV_HOST:$NEXT_PORT}"')],
    ["mobile workflow kept", existsSync(join(d, ".github/workflows/mobile-release.yml"))],
    ["desktop workflow removed", !existsSync(join(d, ".github/workflows/desktop-release.yml"))],
    ["electron/ removed", !existsSync(join(d, "electron"))],
    ["cap:add:ios + cap:add:android present", !!pkg.scripts?.["cap:add:ios"] && !!pkg.scripts?.["cap:add:android"]],
    ["capacitor deps present", !!pkg.dependencies?.["@capacitor/core"]],
    ["appId sanitized in capacitor.config.ts", capCfg.includes('appId: "com.example.mycoolapp"')],
    // Capacitor's appName is the LAUNCHER label — the short name, which
    // `cap add` copies into CFBundleDisplayName and the Android app_name.
    ["appName is the launcher short name", capCfg.includes('appName: "My Cool App"')],
    ["layout mounts MobileBridgeLoader", layout.includes("MobileBridgeLoader")],
  ];
});

results.desktopMobile = await run(
  "desktop + mobile (both native wrappers)",
  "dino-game",
  ["mobile", "desktop"],
  (d) => {
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
    const manifest = JSON.parse(readFileSync(join(d, ".hatchkit.json"), "utf-8"));
    const capCfgRaw = readFileSync(join(d, "capacitor.config.ts"), "utf-8");
    const builderCfg = readFileSync(join(d, "electron-builder.config.mjs"), "utf-8");
    const serverEnv = readFileSync(join(d, "packages/server/.env.example"), "utf-8");
    const nextCfg = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
    const nativeHmr = manifest.ports?.nativeHmr;
    return [
      ["electron/ kept", existsSync(join(d, "electron"))],
      ["capacitor.config.ts kept", existsSync(join(d, "capacitor.config.ts"))],
      ["build/icon.png kept", statSync(join(d, "build/icon.png")).size > 1000],
      ["desktop workflow kept", existsSync(join(d, ".github/workflows/desktop-release.yml"))],
      ["mobile workflow kept", existsSync(join(d, ".github/workflows/mobile-release.yml"))],
      ["capacitor.config.ts placeholders substituted", !capCfgRaw.includes("{{")],
      ["package.json placeholders substituted", !readFileSync(join(d, "package.json"), "utf-8").includes("{{")],
      // The two wrappers write the same bundle id from the same source.
      // A divergence here is exactly what the identifier-agreement check
      // exists to catch, and it must not be reachable from a clean scaffold.
      ["electron appId sanitized", builderCfg.includes('appId: "com.example.dinogame"')],
      ["capacitor appId agrees with electron appId", capCfgRaw.includes('appId: "com.example.dinogame"')],
      ["electron productName is the display name", builderCfg.includes('productName: "Dino Game"')],
      ["nativeHmr port assigned", typeof nativeHmr === "number"],
      // Electron has no dev URL of its own any more: the main process reads
      // ELECTRON_DEV_URL, which only `dev:desktop` sets.
      [
        "dev:desktop retargeted at the nativeHmr port",
        pkg.scripts?.["dev:desktop"]?.includes(
          `ELECTRON_DEV_URL=http://localhost:${nativeHmr}`,
        ),
      ],
      ["electron deps present", !!pkg.devDependencies?.electron],
      ["capacitor deps present", !!pkg.dependencies?.["@capacitor/core"]],
      [
        "TRUSTED_ORIGINS includes the Electron origin",
        /^TRUSTED_ORIGINS=.*app:\/\/-/m.test(serverEnv),
      ],
      [
        "TRUSTED_ORIGINS includes the Capacitor origins",
        /^TRUSTED_ORIGINS=.*capacitor:\/\/localhost/m.test(serverEnv),
      ],
      ["next.config flipped to export", nextCfg.includes('output: "export"')],
      // Two native features both ask for the static-export flip; the
      // rewrite must be a fixed point, not run once per feature.
      //
      // Comments are stripped first: the generated config EXPLAINS
      // `output: "export"` in prose (why distDir is the out dir, why a
      // dev server holding .next blocks a build), and a raw count reads
      // those mentions as a second flip.
      [
        "next.config flipped exactly once",
        (stripComments(nextCfg).match(/output:\s*["']export["']/g) || []).length === 1,
      ],
      ["resources/icon.png kept (mobile assets)", existsSync(join(d, "resources/icon.png"))],
      [
        "manifest records both native features",
        Array.isArray(manifest.features) &&
          manifest.features.includes("desktop") &&
          manifest.features.includes("mobile"),
      ],
      ["no tauri scripts survive", !pkg.scripts?.["dev:tauri"] && !pkg.scripts?.tauri],
      ["no itch scripts survive", !pkg.scripts?.["itch:push:mac"]],
      ["src-tauri/ is gone from the starter", !existsSync(join(d, "src-tauri"))],
    ];
  },
);


results.serverOnly = await run(
  "surfaces: server-only",
  "api-only",
  [],
  (d) => {
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
    const compose = existsSync(join(d, "docker-compose.yml"))
      ? readFileSync(join(d, "docker-compose.yml"), "utf-8")
      : "";
    const manifest = JSON.parse(readFileSync(join(d, ".hatchkit.json"), "utf-8"));
    const ci = readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8");
    const ciJobs = ciJobNames(ci);
    return [
      ["packages/client/ removed", !existsSync(join(d, "packages/client"))],
      ["packages/server/ kept", existsSync(join(d, "packages/server"))],
      ["packages/shared/ kept", existsSync(join(d, "packages/shared"))],
      ["docs-site/ removed", !existsSync(join(d, "docs-site"))],
      ["e2e/ removed", !existsSync(join(d, "e2e"))],
      ["compose: client service stripped", !/^\s{2}client:/m.test(compose)],
      ["compose: server service kept", /^\s{2}server:/m.test(compose)],
      ["compose: mongo service kept", /^\s{2}mongo:/m.test(compose)],
      // This case scaffolds with NO features, and redis exists only for
      // `websocket`. It used to survive anyway — the server waited on a
      // container nothing talked to, while infra.ts derived
      // `redisEnabled: false` from the same feature. The surface prune
      // removed it for `static` only, so every other featureless
      // scaffold shipped the stray service.
      ["compose: redis service stripped (websocket not selected)", !/^\s{2}redis:/m.test(compose)],
      ["compose: no dangling `- redis` depends_on", !/^\s*- redis\s*$/m.test(compose)],
      ["compose: no REDIS_URL env for a redis that isn't there", !/REDIS_URL:/.test(compose)],
      ["pkg.scripts.dev targets server only", pkg.scripts?.dev === "pnpm --filter @starter/server dev"],
      ["pkg.scripts has no build:client", !pkg.scripts?.["build:client"]],
      ["pkg.scripts has no test:e2e", !pkg.scripts?.["test:e2e"]],
      ["manifest persists surfaces=server-only", manifest.surfaces === "backend"],

      // ── CI workflow: nothing may build the deleted client ──
      ["ci: build-client job removed", !ciJobs.includes("build-client")],
      ["ci: no packages/client/Dockerfile reference", !ci.includes("packages/client/Dockerfile")],
      ["ci: e2e job removed (e2e/ is gone)", !ciJobs.includes("e2e")],
      ["ci: no playwright steps survive", !/playwright/i.test(ci)],
      ["ci: build-server job kept", ciJobs.includes("build-server")],
      ["ci: verify job kept", ciJobs.includes("verify")],
      ["ci: deploy job kept", ciJobs.includes("deploy")],
      ["ci: verify drops the test:client step", !/pnpm run test:client/.test(ci)],
      ["ci: verify keeps the test:unit step", /- run: pnpm run test:unit/.test(ci)],
      ["ci: deploy needs only build-server", /^\s*needs: \[build-server\]$/m.test(ci)],
      ["ci: every needs: entry resolves to a declared job", ciNeedsAreResolvable(ci)],
      ["ci: no client build-args block left behind", !ci.includes("NEXT_PUBLIC_API_URL=")],
    ];
  },
  { surfaces: "backend" },
);

results.clientOnly = await run(
  "surfaces: client-only",
  "static-site",
  [],
  (d) => {
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
    const clientPkg = JSON.parse(
      readFileSync(join(d, "packages/client/package.json"), "utf-8"),
    );
    const compose = existsSync(join(d, "docker-compose.yml"))
      ? readFileSync(join(d, "docker-compose.yml"), "utf-8")
      : "";
    const manifest = JSON.parse(readFileSync(join(d, ".hatchkit.json"), "utf-8"));
    const layout = readFileSync(
      join(d, "packages/client/src/app/layout.tsx"),
      "utf-8",
    );
    const landing = readFileSync(join(d, "packages/client/src/app/page.tsx"), "utf-8");
    const sharedIndex = readFileSync(
      join(d, "packages/shared/src/index.ts"),
      "utf-8",
    );
    const ci = readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8");
    const ciJobs = ciJobNames(ci);
    return [
      ["packages/server/ removed", !existsSync(join(d, "packages/server"))],
      ["packages/client/ kept", existsSync(join(d, "packages/client"))],
      ["packages/shared/ml-types.ts removed", !existsSync(join(d, "packages/shared/src/ml-types.ts"))],
      ["shared barrel no longer re-exports ml-types", !/ml-types/.test(sharedIndex)],
      ["(protected) route group removed", !existsSync(join(d, "packages/client/src/app/(protected)"))],
      ["login route removed", !existsSync(join(d, "packages/client/src/app/login"))],
      ["signup route removed", !existsSync(join(d, "packages/client/src/app/signup"))],
      ["trpc-provider removed", !existsSync(join(d, "packages/client/src/providers/trpc-provider.tsx"))],
      ["auth-provider removed", !existsSync(join(d, "packages/client/src/providers/auth-provider.tsx"))],
      ["lib/trpc.ts removed", !existsSync(join(d, "packages/client/src/lib/trpc.ts"))],
      ["lib/auth-client.ts removed", !existsSync(join(d, "packages/client/src/lib/auth-client.ts"))],
      ["hooks/use-auth.ts removed", !existsSync(join(d, "packages/client/src/hooks/use-auth.ts"))],
      ["components/ml/ removed", !existsSync(join(d, "packages/client/src/components/ml"))],
      ["layout drops TRPCProvider/AuthProvider", !/TRPCProvider|AuthProvider/.test(layout)],
      ["landing has no /login or /signup links", !/href="\/(login|signup)"/.test(landing)],
      ["client pkg dropped @trpc/client", !clientPkg.dependencies?.["@trpc/client"]],
      ["client pkg dropped @trpc/react-query", !clientPkg.dependencies?.["@trpc/react-query"]],
      ["client pkg dropped better-auth", !clientPkg.dependencies?.["better-auth"]],
      ["compose: server service stripped", !/^\s{2}server:/m.test(compose)],
      ["compose: mongo service stripped", !/^\s{2}mongo:/m.test(compose)],
      ["compose: redis service stripped", !/^\s{2}redis:/m.test(compose)],
      ["compose: client service kept", /^\s{2}client:/m.test(compose)],
      ["compose: mongo-data volume removed", !/mongo-data:/.test(compose)],
      ["pkg.scripts.dev targets client only", pkg.scripts?.dev === "pnpm --filter @starter/client dev"],
      ["pkg.scripts has no build:server", !pkg.scripts?.["build:server"]],
      ["pkg.scripts has no test:unit", !pkg.scripts?.["test:unit"]],
      ["manifest persists surfaces=client-only", manifest.surfaces === "static"],
      [
        "no packages/server/.env.production (dotenvx skipped)",
        !existsSync(join(d, "packages/server/.env.production")),
      ],

      // ── CI workflow: nothing may build or test the deleted server ──
      ["ci: build-server job removed", !ciJobs.includes("build-server")],
      ["ci: no packages/server/Dockerfile reference", !ci.includes("packages/server/Dockerfile")],
      ["ci: e2e job removed (e2e/ + playwright.config.ts are gone)", !ciJobs.includes("e2e")],
      ["ci: no playwright steps survive", !/playwright/i.test(ci)],
      ["ci: no mongo/redis/minio services survive", !/mongo|redis|minio/i.test(ci)],
      ["ci: build-client job kept", ciJobs.includes("build-client")],
      ["ci: verify job kept", ciJobs.includes("verify")],
      ["ci: deploy job kept", ciJobs.includes("deploy")],
      ["ci: verify drops the test:unit step", !/pnpm run test:unit/.test(ci)],
      ["ci: verify keeps the test:client step", /- run: pnpm run test:client/.test(ci)],
      ["ci: deploy needs only build-client", /^\s*needs: \[build-client\]$/m.test(ci)],
      ["ci: every needs: entry resolves to a declared job", ciNeedsAreResolvable(ci)],
      [
        "ci: client build-args survive the prune (NEXT_PUBLIC_* bake at image build)",
        /^\s*NEXT_PUBLIC_API_URL=https:\/\/static-site\.example\.com$/m.test(ci),
      ],
    ];
  },
  { surfaces: "static", mongodbProvider: "external" },
);

// The exact combination that shipped broken: a static, Coolify-hosted
// client with no features and no newsletter. Every assertion here maps
// to something that had to be hand-fixed downstream after a scaffold.
results.staticCoolify = await run(
  "surfaces: static + coolify, no features",
  "flat-site",
  [],
  (d) => {
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
    const nextCfg = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
    const rawTsconfig = readFileSync(join(d, "packages/client/tsconfig.json"), "utf-8");
    const globals = readFileSync(join(d, "packages/client/src/styles/globals.css"), "utf-8");
    const claudeMd = readFileSync(join(d, "CLAUDE.md"), "utf-8");
    return [
      // ── next.config: nothing may reference the deleted server ──
      [
        "next.config drops the NEXT_PUBLIC_API_URL build guard",
        !nextCfg.includes("NEXT_PUBLIC_API_URL"),
      ],
      ["next.config drops the /api/* rewrite", !nextCfg.includes("/api/")],
      ["next.config has no rewrites() at all", !/rewrites\s*\(/.test(nextCfg)],
      ["next.config drops @starter/server from transpilePackages", !nextCfg.includes("@starter/server")],
      [
        "next.config keeps @starter/shared in transpilePackages",
        /transpilePackages\s*:\s*\[\s*"@starter\/shared"\s*\]/.test(nextCfg),
      ],
      [
        "next.config keeps output: standalone (coolify, not pages)",
        nextCfg.includes('output: "standalone"'),
      ],

      // ── client tsconfig ──
      ["client tsconfig drops @starter/server/trpc path", !rawTsconfig.includes("@starter/server")],
      [
        "client tsconfig is still valid JSON",
        (() => {
          try {
            JSON.parse(rawTsconfig);
            return true;
          } catch {
            return false;
          }
        })(),
      ],
      [
        "client tsconfig keeps @starter/shared paths",
        JSON.parse(rawTsconfig).compilerOptions.paths["@starter/shared"] !== undefined,
      ],

      // ── globals.css: @plugin only resolves JS plugins ──
      ["globals.css imports tw-animate-css (not @plugin)", /^@import "tw-animate-css";$/m.test(globals)],
      ["globals.css has no @plugin directive", !globals.includes("@plugin")],

      // ── newsletter strip is complete ──
      ["scripts/newsletter-send.ts removed", !existsSync(join(d, "scripts/newsletter-send.ts"))],
      ["scripts/newsletter-draft.ts removed", !existsSync(join(d, "scripts/newsletter-draft.ts"))],
      ["scripts/newsletter-test-tx.ts removed", !existsSync(join(d, "scripts/newsletter-test-tx.ts"))],
      ["scripts/newsletter-verify.ts removed", !existsSync(join(d, "scripts/newsletter-verify.ts"))],
      ["scripts/newsletter-welcome.ts removed", !existsSync(join(d, "scripts/newsletter-welcome.ts"))],
      ["emails/ removed", !existsSync(join(d, "emails"))],
      [
        "no newsletter:* scripts survive",
        !Object.keys(pkg.scripts ?? {}).some((s) => s.startsWith("newsletter:")),
      ],

      // ── desktop strip is complete ──
      ["scripts/icons-desktop.mjs removed", !existsSync(join(d, "scripts/icons-desktop.mjs"))],
      ["pkg.scripts has no icons:desktop", !pkg.scripts?.["icons:desktop"]],

      // ── CLAUDE.md: renamed + pruned ──
      ["CLAUDE.md H1 renamed", /^# flat-site$/m.test(claudeMd)],
      ["CLAUDE.md drops the starter name entirely", !claudeMd.includes("node-realtime-starter")],
      ["CLAUDE.md leaves no hatchkit: markers", !claudeMd.includes("hatchkit:")],
      [
        "CLAUDE.md drops the Express middleware section",
        !claudeMd.includes("Critical Middleware Ordering"),
      ],
      ["CLAUDE.md drops the dotenvx section", !claudeMd.includes("Environment & Secrets")],
      ["CLAUDE.md drops the newsletter smoke commands", !claudeMd.includes("newsletter:verify")],
      ["CLAUDE.md drops the desktop/mobile section", !claudeMd.includes("Capacitor")],
      ["CLAUDE.md drops the packages/server tree", !claudeMd.includes("packages/server/src/")],
      ["CLAUDE.md keeps the packages/client tree", claudeMd.includes("packages/client/src/")],
      ["CLAUDE.md drops test:unit / test:e2e", !/test:(unit|e2e)/.test(claudeMd)],
      ["CLAUDE.md keeps a static-appropriate tagline", /no backend\.$/m.test(claudeMd)],
      ["CLAUDE.md has no 3-blank-line runs", !/\n{3,}/.test(claudeMd)],
      ["CLAUDE.md starts at the H1 (no leading blank)", claudeMd.startsWith("# flat-site")],
    ];
  },
  { surfaces: "static", deploymentMode: "coolify", mongodbProvider: "external" },
);

results.postgres = await run(
  "dbEngine: postgres",
  "pg-app",
  [],
  (d) => {
    const compose = readFileSync(join(d, "docker-compose.yml"), "utf-8");
    const composeDev = readFileSync(join(d, "docker-compose.dev.yml"), "utf-8");
    const serverPkg = JSON.parse(
      readFileSync(join(d, "packages/server/package.json"), "utf-8"),
    );
    const connection = readFileSync(
      join(d, "packages/server/src/db/connection.ts"),
      "utf-8",
    );
    const schema = readFileSync(join(d, "packages/server/src/db/schema.ts"), "utf-8");
    const auth = readFileSync(join(d, "packages/server/src/auth/auth.ts"), "utf-8");
    const itemsRouter = readFileSync(
      join(d, "packages/server/src/trpc/routers/items.ts"),
      "utf-8",
    );
    const envExample = readFileSync(join(d, "packages/server/.env.example"), "utf-8");
    const envDev = readFileSync(join(d, "packages/server/.env.development"), "utf-8");
    const envTs = readFileSync(join(d, "packages/server/src/config/env.ts"), "utf-8");
    return [
      ["docker-compose: postgres service", /^ {2}postgres:/m.test(compose)],
      ["docker-compose: no mongo service", !/^ {2}mongo:/m.test(compose)],
      ["docker-compose: postgres-data volume", /postgres-data:/.test(compose)],
      ["docker-compose: no mongo-data volume", !/mongo-data:/.test(compose)],
      ["docker-compose.dev: postgres service", /postgres:/.test(composeDev)],
      ["server pkg: drizzle-orm dep", !!serverPkg.dependencies?.["drizzle-orm"]],
      ["server pkg: pg dep", !!serverPkg.dependencies?.pg],
      ["server pkg: no mongoose dep", !serverPkg.dependencies?.mongoose],
      ["server pkg: no mongodb dep", !serverPkg.dependencies?.mongodb],
      ["server pkg: drizzle-kit devDep", !!serverPkg.devDependencies?.["drizzle-kit"]],
      ["server pkg: db:generate script", !!serverPkg.scripts?.["db:generate"]],
      ["drizzle.config.ts written", existsSync(join(d, "packages/server/drizzle.config.ts"))],
      ["connection.ts uses drizzle", /drizzle/.test(connection)],
      ["connection.ts has connectToDB", /export async function connectToDB/.test(connection)],
      ["connection.ts has isDatabaseReady", /export function isDatabaseReady/.test(connection)],
      ["schema.ts defines items table", /pgTable\("items"/.test(schema)],
      ["schema.ts defines profiles table", /pgTable\("profiles"/.test(schema)],
      ["schema.ts defines better-auth user table", /pgTable\("user"/.test(schema)],
      ["auth.ts uses drizzle adapter", /drizzleAdapter/.test(auth)],
      ["auth.ts: no mongodb adapter", !/mongodbAdapter/.test(auth)],
      ["items router queries via Item.listForOwner", /Item\.listForOwner/.test(itemsRouter)],
      ["env.ts has POSTGRES_URL", /POSTGRES_URL/.test(envTs)],
      ["env.ts: no MONGODB_URI", !/MONGODB_URI/.test(envTs)],
      [".env.example: POSTGRES_URL", /^POSTGRES_URL=postgres:\/\//m.test(envExample)],
      [".env.example: no MONGODB_URI", !/MONGODB_URI/.test(envExample)],
      [".env.development: POSTGRES_URL", /^POSTGRES_URL=postgres:\/\//m.test(envDev)],
    ];
  },
  { dbEngine: "postgres", dbProvider: "external", mongodbProvider: "external" },
);

// ── E2E local S3 ─────────────────────────────────────────────────────
// Docker Hub no longer serves minio/minio, so the old CI step failed the
// e2e job before any test ran. CI now starts the same pinned SeaweedFS
// image as e2e/start-server.sh, creating the one bucket
// playwright.config.ts names — and only for projects with S3 code.
const { SEAWEEDFS_IMAGE, seaweedfsCiStep, upgradeWorkflowE2eS3 } = await import(
  "./src/scaffold/e2e-s3.js"
);

/** Every file under `dir` whose content mentions MinIO. */
function filesMentioningMinio(dir: string): string[] {
  const hits: string[] = [];
  const walk = (p: string): void => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/minio/i.test(readFileSync(full, "utf-8"))) hits.push(full.slice(dir.length + 1));
    }
  };
  walk(dir);
  return hits;
}

/** Lines of the `e2e:` job only. */
function e2eJob(workflow: string): string {
  const m = /^ {2}e2e:\s*\n([\s\S]*?)(?=^ {2}[A-Za-z0-9_-]+:\s*$)/m.exec(workflow);
  return m ? m[1] : "";
}

results.e2eS3Enabled = await run("e2e local S3: s3 feature", "bucket-app", ["s3"], (d) => {
  const ci = readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8");
  const startServer = readFileSync(join(d, "e2e/start-server.sh"), "utf-8");
  const playwright = readFileSync(join(d, "playwright.config.ts"), "utf-8");
  const job = e2eJob(ci);
  return [
    ["no file in the project mentions MinIO", filesMentioningMinio(d).length === 0],
    ["ci: SeaweedFS step creates bucket-app-e2e", ci.includes(seaweedfsCiStep("bucket-app-e2e"))],
    ["ci: e2e job sets no S3_* / AWS_* env", !/^\s+(S3_|AWS_)/m.test(job)],
    ["playwright: bucket is bucket-app-e2e", playwright.includes('S3_BUCKET_NAME: "bucket-app-e2e"')],
    ["playwright: public URL uses the same bucket", playwright.includes("127.0.0.1:9002/bucket-app-e2e")],
    ["start-server.sh: creates bucket-app-e2e", startServer.includes("S3_BUCKET=bucket-app-e2e")],
    ["start-server.sh: waits on bucket-app-e2e", startServer.includes("9002/bucket-app-e2e &&")],
    ["start-server.sh: pinned image", startServer.includes(SEAWEEDFS_IMAGE)],
    // global-teardown.ts removes containers by these literal names.
    ["start-server.sh: container names unchanged", startServer.includes("starter-e2e-seaweedfs")],
    ["ci: needs: entries all resolve", ciNeedsAreResolvable(ci)],
  ];
});

results.e2eS3Disabled = await run("e2e local S3: no S3 code", "no-bucket-app", [], (d) => {
  const ci = readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8");
  const startServer = readFileSync(join(d, "e2e/start-server.sh"), "utf-8");
  const playwright = readFileSync(join(d, "playwright.config.ts"), "utf-8");
  const job = e2eJob(ci);
  return [
    ["no file in the project mentions MinIO", filesMentioningMinio(d).length === 0],
    ["ci: e2e job kept", ciJobNames(ci).includes("e2e")],
    ["ci: no SeaweedFS step", !/seaweedfs/i.test(ci)],
    ["ci: e2e job sets no S3_* / AWS_* env", !/^\s+(S3_|AWS_)/m.test(job)],
    ["ci: e2e job still runs playwright", job.includes("npx playwright test")],
    ["start-server.sh: no SeaweedFS block", !/seaweedfs/i.test(startServer)],
    ["start-server.sh: Mongo + Redis kept", /Wait for MongoDB/.test(startServer) && /Wait for Redis/.test(startServer)],
    ["playwright: no S3 / AWS env", !/S3_|AWS_/.test(playwright)],
    ["playwright: server env kept", /BETTER_AUTH_SECRET/.test(playwright) && /FRONTEND_URL/.test(playwright)],
  ];
});

// ML services import storage.ts, so they keep the container even
// without the `s3` feature.
results.e2eS3Ml = await run(
  "e2e local S3: ML service",
  "ml-app",
  [],
  (d) => {
    const ci = readFileSync(join(d, ".github/workflows/build-and-deploy.yml"), "utf-8");
    return [["ci: SeaweedFS step kept", ci.includes(seaweedfsCiStep("ml-app-e2e"))]];
  },
  { mlServices: ["background-removal"] },
);

console.log("\n── e2e local S3: pinned image + workflow retrofit ─────────────");
{
  const checks: Check[] = [];
  const read = (rel: string) => readFileSync(join(STARTER, "..", rel), "utf-8");
  for (const rel of [
    "starter/e2e/start-server.sh",
    "starter/docker-compose.dev.yml",
    "starter/.github/workflows/build-and-deploy.yml",
    "cli/src/templates/build-pipeline/deploy.yml.hbs",
  ]) {
    const content = read(rel);
    checks.push([`${rel}: uses ${SEAWEEDFS_IMAGE}`, content.includes(SEAWEEDFS_IMAGE)]);
    checks.push([
      `${rel}: no other seaweedfs tag`,
      content.split("chrislusf/seaweedfs:").length === content.split(SEAWEEDFS_IMAGE).length,
    ]);
    checks.push([`${rel}: no MinIO`, !/minio/i.test(content)]);
  }
  checks.push([
    "starter workflow step == seaweedfsCiStep(starter-e2e)",
    read("starter/.github/workflows/build-and-deploy.yml").includes(seaweedfsCiStep("starter-e2e")),
  ]);
  checks.push([
    "adopt template step == seaweedfsCiStep(starter-e2e)",
    read("cli/src/templates/build-pipeline/deploy.yml.hbs").includes(seaweedfsCiStep("starter-e2e")),
  ]);

  // The workflow an existing project was generated with.
  const legacy = [
    "jobs:",
    "  e2e:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: pnpm run build",
    "",
    "      - name: Start MinIO",
    "        run: |",
    "          docker run -d --name e2e-minio -p 9002:9000 \\",
    "            -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \\",
    "            --tmpfs /data minio/minio:latest server /data",
    "          docker run --rm --network host \\",
    "            --entrypoint sh minio/mc:latest -c \\",
    '            "mc alias set local http://127.0.0.1:9002 minioadmin minioadmin && \\',
    '             mc mb --ignore-existing local/starter-e2e"',
    "",
    "      - run: npx playwright install --with-deps chromium",
    "",
    "      - name: Run E2E tests",
    "        run: npx playwright test",
    "        env:",
    '          CI: "true"',
    "          S3_ENDPOINT: http://127.0.0.1:9002",
    "          S3_BUCKET_NAME: starter-e2e",
    "          AWS_ACCESS_KEY_ID: minioadmin",
    "          AWS_SECRET_ACCESS_KEY: minioadmin",
    "          AWS_REGION: us-east-1",
    "",
    "  build-server:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      AWS_REGION: eu-central-1",
    "",
  ].join("\n");

  const pw = upgradeWorkflowE2eS3(legacy, { enabled: true, s3Env: "playwright", bucket: "tyt-e2e" });
  checks.push(["retrofit (playwright): no MinIO left", !/minio/i.test(pw)]);
  checks.push(["retrofit (playwright): SeaweedFS step for the playwright bucket", pw.includes(seaweedfsCiStep("tyt-e2e"))]);
  checks.push(["retrofit (playwright): e2e S3/AWS env dropped", !/^\s+(S3_|AWS_)/m.test(e2eJob(pw))]);
  checks.push(["retrofit (playwright): other jobs' env untouched", pw.includes("      AWS_REGION: eu-central-1")]);
  checks.push(["retrofit (playwright): playwright install step kept", pw.includes("      - run: npx playwright install --with-deps chromium")]);
  checks.push([
    "retrofit (playwright): idempotent",
    upgradeWorkflowE2eS3(pw, { enabled: true, s3Env: "playwright", bucket: "tyt-e2e" }) === pw,
  ]);

  const wf = upgradeWorkflowE2eS3(legacy, { enabled: true, s3Env: "workflow", bucket: "starter-e2e" });
  checks.push(["retrofit (workflow): no MinIO left", !/minio/i.test(wf)]);
  checks.push(["retrofit (workflow): job env keeps the bucket", wf.includes("          S3_BUCKET_NAME: starter-e2e")]);
  checks.push(["retrofit (workflow): placeholder credentials", wf.includes("          AWS_ACCESS_KEY_ID: hatchkit-dev")]);

  const off = upgradeWorkflowE2eS3(legacy, { enabled: false, s3Env: "playwright", bucket: "tyt-e2e" });
  checks.push(["retrofit (no S3 code): no MinIO / SeaweedFS step", !/minio|seaweedfs/i.test(off)]);
  checks.push(["retrofit (no S3 code): steps either side kept", off.includes("      - run: pnpm run build\n\n      - run: npx playwright install")]);

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.e2eS3PinAndRetrofit = ok;
}

// Existing-dir guard: scaffold into a non-empty directory should throw.
// Ports: confirm every file that references ports is rewritten
// coherently, and that two scaffolds don't collide.
console.log("\n── ports: web-only ─────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "scaffold-ports-web-"));
  try {
    const { ports } = await scaffoldApp(cfg("port-test-web", []), d);
    const serverEnvDev = readFileSync(join(d, "packages/server/.env.development"), "utf-8");
    const clientEnvDev = readFileSync(join(d, "packages/client/.env.development"), "utf-8");
    const serverDockerfile = readFileSync(join(d, "packages/server/Dockerfile"), "utf-8");
    const clientDockerfile = readFileSync(join(d, "packages/client/Dockerfile"), "utf-8");
    const compose = readFileSync(join(d, "docker-compose.yml"), "utf-8");
    const devMjs = readFileSync(join(d, "scripts/dev.mjs"), "utf-8");

    const checks: Check[] = [
      ["serverPort in 5000-5999", ports.server >= 5000 && ports.server <= 5999],
      ["clientPort in 6000-6999", ports.client >= 6000 && ports.client <= 6999],
      ["nativeHmrPort not set (no native)", ports.nativeHmr === undefined],
      [`server .env.development has PORT=${ports.server}`, serverEnvDev.includes(`PORT=${ports.server}`)],
      [`server .env.development BETTER_AUTH_URL uses server port`, serverEnvDev.includes(`localhost:${ports.server}`)],
      [`client .env.development has PORT=${ports.client}`, clientEnvDev.includes(`PORT=${ports.client}`)],
      [`client .env.development API_URL uses server port`, clientEnvDev.includes(`NEXT_PUBLIC_API_URL=http://localhost:${ports.server}`)],
      [`server Dockerfile has EXPOSE ${ports.server}`, serverDockerfile.includes(`EXPOSE ${ports.server}`)],
      [`client Dockerfile has EXPOSE ${ports.client}`, clientDockerfile.includes(`EXPOSE ${ports.client}`)],
      [`docker-compose server PORT=${ports.server}`, compose.includes(`PORT: "${ports.server}"`)],
      [`dev.mjs fixed apiPort=${ports.server}`, devMjs.includes(`apiPort = ${ports.server}`)],
      [`dev.mjs fixed clientPort=${ports.client}`, devMjs.includes(`clientPort = ${ports.client}`)],
      ["no stray localhost:5000", !serverEnvDev.includes("localhost:5000") && !clientEnvDev.includes("localhost:5000")],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.portsWeb = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log("\n── ports: desktop + mobile (native HMR port) ─────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "scaffold-ports-native-"));
  try {
    const { ports } = await scaffoldApp(cfg("port-test-native", ["desktop", "mobile"]), d);
    const androidDev = readFileSync(join(d, "scripts/android-dev.sh"), "utf-8");
    const iosDev = readFileSync(join(d, "scripts/ios-dev.sh"), "utf-8");
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));

    const checks: Check[] = [
      ["nativeHmrPort assigned", ports.nativeHmr !== undefined],
      ["nativeHmrPort in 7000-7999", ports.nativeHmr! >= 7000 && ports.nativeHmr! <= 7999],
      ["nativeHmrPort != serverPort", ports.nativeHmr !== ports.server],
      ["nativeHmrPort != clientPort", ports.nativeHmr !== ports.client],
      // Electron itself has no port to rewrite any more: the main process
      // reads ELECTRON_DEV_URL and nothing else, and `dev:desktop` is the one
      // place that sets it (checked below).
      [`android-dev.sh NEXT_PORT default = ${ports.nativeHmr}`, androidDev.includes(`NEXT_PORT:-${ports.nativeHmr}`)],
      [`ios-dev.sh NEXT_PORT default = ${ports.nativeHmr}`, iosDev.includes(`NEXT_PORT:-${ports.nativeHmr}`)],
      [`dev:desktop uses native port`, pkg.scripts["dev:desktop"]?.includes(`http://localhost:${ports.nativeHmr}`)],
      [
        `dev:desktop sets ELECTRON_DEV_URL to it`,
        pkg.scripts["dev:desktop"]?.includes(
          `ELECTRON_DEV_URL=http://localhost:${ports.nativeHmr}`,
        ),
      ],
      [
        `dev:desktop runs the bundled main`,
        pkg.scripts["dev:desktop"]?.includes("electron/dist/main.js"),
      ],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.portsNative = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log("\n── ports: no collisions across two scaffolds ─────────────────────────────");
{
  const d1 = mkdtempSync(join(tmpdir(), "scaffold-ports-a-"));
  const d2 = mkdtempSync(join(tmpdir(), "scaffold-ports-b-"));
  try {
    const a = (await scaffoldApp(cfg("port-test-a", ["mobile"]), d1)).ports;
    const b = (await scaffoldApp(cfg("port-test-b", ["mobile"]), d2)).ports;
    void a; void b;
    const allPorts = [a.server, a.client, a.nativeHmr!, b.server, b.client, b.nativeHmr!];
    const unique = new Set(allPorts);
    const checks: Check[] = [
      ["all 6 ports unique across two scaffolds", unique.size === 6],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.portsNoCollide = ok;
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
}

// Compose image refs: docker-compose.yml ships with literal
// `ghcr.io/OWNER/REPO-{server,client}:main` defaults. Without
// substitution, the first Coolify `docker compose up` fails with
// `invalid reference format`. The scaffold has to fill OWNER + REPO
// during the initial copy so the first deploy "just works".
console.log("\n── compose: OWNER/REPO substituted for first-deploy correctness ─────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "scaffold-compose-refs-"));
  try {
    await scaffoldApp(cfg("compose-refs", [], { githubOwner: "acme" }), d);
    const compose = readFileSync(join(d, "docker-compose.yml"), "utf-8");
    const checks: Check[] = [
      ["no literal OWNER token", !/\bOWNER\b/.test(compose)],
      ["no literal REPO token", !/\bREPO\b/.test(compose)],
      [
        "server image points at ghcr.io/acme/compose-refs-server:main",
        compose.includes("ghcr.io/acme/compose-refs-server:main"),
      ],
      [
        "client image points at ghcr.io/acme/compose-refs-client:main",
        compose.includes("ghcr.io/acme/compose-refs-client:main"),
      ],
      [
        "SERVER_IMAGE override still wins (default form preserved)",
        compose.includes("${SERVER_IMAGE:-ghcr.io/acme/compose-refs-server:main}"),
      ],
      [
        "CLIENT_IMAGE override still wins (default form preserved)",
        compose.includes("${CLIENT_IMAGE:-ghcr.io/acme/compose-refs-client:main}"),
      ],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.composeImageRefs = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Compose substitution helper: verify idempotency + literal-only
// matching so `hatchkit update` re-runs never overwrite a project
// where the user already hand-edited the image refs.
console.log("\n── compose: substituteComposeImageRefs is idempotent + literal-only ─────────────────────────────");
{
  const { substituteComposeImageRefs } = await import("./src/scaffold/owner.js");
  const d = mkdtempSync(join(tmpdir(), "scaffold-compose-helper-"));
  try {
    mkdirSync(d, { recursive: true });
    const composePath = join(d, "docker-compose.yml");
    const original = [
      "services:",
      "  server:",
      "    image: ${SERVER_IMAGE:-ghcr.io/OWNER/REPO-server:main}",
      "",
    ].join("\n");
    writeFileSync(composePath, original, "utf-8");

    const first = substituteComposeImageRefs(d, "acme", "my-app");
    const afterFirst = readFileSync(composePath, "utf-8");

    // Second call on the already-substituted file should be a no-op.
    const second = substituteComposeImageRefs(d, "acme", "my-app");
    const afterSecond = readFileSync(composePath, "utf-8");

    // User hand-edits to a different owner/repo must survive re-runs.
    writeFileSync(
      composePath,
      "image: ${SERVER_IMAGE:-ghcr.io/different-owner/different-repo-server:main}\n",
      "utf-8",
    );
    const third = substituteComposeImageRefs(d, "acme", "my-app");
    const afterThird = readFileSync(composePath, "utf-8");

    const checks: Check[] = [
      ["first call rewrites file", first.written === true],
      ["first call substitutes owner + repo", afterFirst.includes("ghcr.io/acme/my-app-server:main")],
      ["second call is a no-op", second.written === false && afterSecond === afterFirst],
      ["hand-edited file left alone", third.written === false],
      [
        "hand-edited owner/repo preserved verbatim",
        afterThird.includes("different-owner/different-repo-server"),
      ],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.composeHelper = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Manifest: verify .hatchkit.json is written with sanitized fields
// and NEVER contains credentials or infrastructure coordinates.
console.log("\n── manifest: sanitized fields only, no leaks ─────────────────────────────");
{
  const { MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");
  const d = mkdtempSync(join(tmpdir(), "scaffold-manifest-"));
  try {
    const cfgWithSecrets = cfg("manifest-test", ["desktop", "mobile"]);
    // Seed values that MUST NOT appear in the manifest.
    cfgWithSecrets.serverIp = "10.9.8.7";
    cfgWithSecrets.serverId = 99;
    cfgWithSecrets.s3Provider = "existing";
    cfgWithSecrets.s3ExistingEndpoint = "https://secret.minio.internal";
    cfgWithSecrets.s3ExistingBucket = "secret-bucket";
    cfgWithSecrets.s3ExistingAccessKey = "AKIA-SECRET";
    cfgWithSecrets.s3ExistingSecretKey = "very-secret-key";
    cfgWithSecrets.serverSize = "cpx41";
    cfgWithSecrets.serverLocation = "hel1";
    await scaffoldApp(cfgWithSecrets, d);

    const manifest = JSON.parse(readFileSync(join(d, ".hatchkit.json"), "utf-8"));
    const json = JSON.stringify(manifest);
    const checks: Check[] = [
      ["manifest exists", typeof manifest === "object"],
      ["has version = MANIFEST_VERSION", manifest.version === MANIFEST_VERSION],
      ["has cliVersion", typeof manifest.cliVersion === "string"],
      ["has scaffoldedAt (ISO)", typeof manifest.scaffoldedAt === "string"],
      ["contains name", manifest.name === "manifest-test"],
      ["contains features", Array.isArray(manifest.features) && manifest.features.includes("desktop")],
      ["contains ports", typeof manifest.ports.server === "number"],
      ["does NOT contain serverIp", !json.includes("10.9.8.7")],
      ["does NOT contain serverId=99", !json.includes('"serverId":99') && !json.includes('"serverId": 99')],
      ["does NOT contain secret.minio", !json.includes("secret.minio")],
      ["does NOT contain secret-bucket", !json.includes("secret-bucket")],
      ["does NOT contain AKIA-SECRET", !json.includes("AKIA-SECRET")],
      ["does NOT contain very-secret-key", !json.includes("very-secret-key")],
      ["does NOT contain serverSize", !json.includes("cpx41")],
      ["does NOT contain serverLocation", !json.includes("hel1") && !json.includes('"serverLocation"')],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.manifest = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Non-interactive: verify presets bypass prompts in collectProjectConfig.
console.log("\n── non-interactive: presets bypass prompts ─────────────────────────────");
{
  const { collectProjectConfig } = await import("./src/prompts.js");
  const presets: Parameters<typeof collectProjectConfig>[0]["presets"] = {
    name: "ni-app",
    domain: "ni-app.example.com",
    baseDomain: "example.com",
    subdomain: "ni-app",
    deployTarget: "new",
    features: ["websocket"],
    mlServices: [],
    forceRedeployMl: [],
    s3Provider: "none",
    scaffoldRepo: true,
    createGithubRepo: false,
    runDeployment: false,
  };
  const result = await collectProjectConfig({
    nonInteractive: true,
    presets,
  });
  const noLocalDev = await collectProjectConfig({
    nonInteractive: true,
    presets,
    forceNoLocalDev: true,
  });
  const checks: Check[] = [
    ["name preserved", result.name === "ni-app"],
    ["domain preserved", result.domain === "ni-app.example.com"],
    ["features preserved", result.features.length === 1 && result.features[0] === "websocket"],
    ["serverSize defaulted to cpx21", result.serverSize === "cpx21"],
    ["serverLocation defaulted to nbg1", result.serverLocation === "nbg1"],
    ["createGithubRepo false", result.createGithubRepo === false],
    ["runDeployment false", result.runDeployment === false],
    ["non-interactive localDev defaults on", result.localDev?.slug === "ni-app"],
    ["forceNoLocalDev disables localDev", noLocalDev.localDev === undefined],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.nonInteractive = ok;
}

// Update: scaffold a web-only project, verify manifest round-trips
// and runUpdate is importable. Full interactive flow runs during
// manual dev — we don't mock the inquirer prompts here.
console.log("\n── update: manifest round-trip for web-only project ─────────────────────────────");
{
  const { runUpdate } = await import("./src/scaffold/update.js");
  const { readManifest } = await import("./src/scaffold/manifest.js");
  const d = mkdtempSync(join(tmpdir(), "scaffold-update-"));
  try {
    await scaffoldApp(cfg("update-test", ["websocket"]), d);
    const m1 = readManifest(d);
    const checks: Check[] = [
      ["initial manifest loads", m1 !== null],
      ["initial features = [websocket]", m1?.features.length === 1 && m1?.features[0] === "websocket"],
      ["no nativeHmr port (web-only)", m1?.ports.nativeHmr === undefined],
      ["runUpdate is exported", typeof runUpdate === "function"],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.updateManifest = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Update: adding `desktop` to a project that already has its own Electron
// shell must fill gaps, not take the shell over. A project ships, and then its
// desktop half grows: its own build script, its own dev command, an Electron
// major it was tested against. Every one of those used to be replaced by the
// starter's version the moment `hatchkit update` added the feature — a break
// with no diff left to read, because the overwritten command was the only
// record of what the project did.
console.log("\n── update: desktop add is additive over a project's own shell ────────────────");
{
  const { runUpdate } = await import("./src/scaffold/update.js");
  const STARTER_PKG = JSON.parse(readFileSync(join(STARTER, "package.json"), "utf-8"));

  /** A project that hand-rolled the desktop half before hatchkit offered it. */
  function ownShell(d: string): void {
    mkdirSync(join(d, "electron/src"), { recursive: true });
    writeFileSync(join(d, "electron/src/main.ts"), "// my own main process\n");
    writeFileSync(join(d, "electron-builder.config.mjs"), "export default { appId: 'mine' };\n");
    mkdirSync(join(d, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(d, ".github/workflows/desktop-release.yml"),
      "name: desktop-release\n# hand-written\n",
    );
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
    pkg.scripts["build:desktop"] = "node scripts/my-desktop-build.mjs";
    pkg.scripts["dev:desktop"] = "node scripts/my-desktop-dev.mjs";
    pkg.devDependencies = { ...pkg.devDependencies, electron: "^41.0.0" };
    writeFileSync(join(d, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  }

  const presets = {
    desiredFeatures: ["websocket", "desktop"] as Feature[],
    confirmAddFeatures: true,
    enableLocalDev: false,
  };

  const keep = mkdtempSync(join(tmpdir(), "scaffold-update-ownshell-"));
  const forced = mkdtempSync(join(tmpdir(), "scaffold-update-forceshell-"));
  try {
    await scaffoldApp(cfg("own-shell", ["websocket"]), keep);
    ownShell(keep);
    const added = await runUpdate(keep, { presets });
    const pkgKeep = JSON.parse(readFileSync(join(keep, "package.json"), "utf-8"));

    await scaffoldApp(cfg("forced-shell", ["websocket"]), forced);
    ownShell(forced);
    await runUpdate(forced, { force: true, presets });
    const pkgForced = JSON.parse(readFileSync(join(forced, "package.json"), "utf-8"));

    const checks: Check[] = [
      ["reports desktop added", added.added.includes("desktop")],
      [
        "own main process kept",
        readFileSync(join(keep, "electron/src/main.ts"), "utf-8").includes("my own main process"),
      ],
      [
        "own electron-builder config kept",
        readFileSync(join(keep, "electron-builder.config.mjs"), "utf-8").includes("mine"),
      ],
      [
        "hand-written desktop-release.yml kept",
        readFileSync(join(keep, ".github/workflows/desktop-release.yml"), "utf-8").includes(
          "hand-written",
        ),
      ],
      [
        "own build:desktop kept",
        pkgKeep.scripts["build:desktop"] === "node scripts/my-desktop-build.mjs",
      ],
      [
        "own dev:desktop kept (port pass too)",
        pkgKeep.scripts["dev:desktop"] === "node scripts/my-desktop-dev.mjs",
      ],
      ["own electron pin kept", pkgKeep.devDependencies.electron === "^41.0.0"],
      [
        "missing script still filled in",
        pkgKeep.scripts["electron:compile"] === STARTER_PKG.scripts["electron:compile"],
      ],
      [
        "missing dev dep still filled in",
        pkgKeep.devDependencies["electron-updater"] ===
          STARTER_PKG.devDependencies["electron-updater"],
      ],
      [
        "typecheck chains electron exactly once",
        (pkgKeep.scripts.typecheck.match(/typecheck:electron/g) ?? []).length === 1,
      ],
      [
        "--force takes the starter's build:desktop",
        pkgForced.scripts["build:desktop"] === STARTER_PKG.scripts["build:desktop"],
      ],
      [
        "--force takes the starter's electron pin",
        pkgForced.devDependencies.electron === STARTER_PKG.devDependencies.electron,
      ],
      [
        "--force still keeps the project's files",
        readFileSync(join(forced, "electron-builder.config.mjs"), "utf-8").includes("mine"),
      ],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.updateDesktopAdditive = ok;
  } finally {
    for (const d of [keep, forced]) rmSync(d, { recursive: true, force: true });
  }
}

// applyPorts owns the `dev:desktop` script. It runs from `create`, where the
// script is whatever the starter shipped a second earlier, AND from
// `hatchkit update` / `server add` against repos that have reshaped it — so
// the retarget is gated on the script still having a generated shape.
console.log("\n── applyPorts: dev:desktop retargeted only while generated ──────────────────");
{
  const { applyPorts, isGeneratedDevDesktopScript } = await import(
    "./src/scaffold/starter-files.js"
  );
  const STARTER_PKG = JSON.parse(readFileSync(join(STARTER, "package.json"), "utf-8"));
  const starterDevDesktop: string = STARTER_PKG.scripts["dev:desktop"];
  // The shape earlier starters generated, before the shell was bundled. An
  // older project must still get its port retargeted.
  const legacy =
    'concurrently -k -n next,electron -c blue,magenta "PORT=7000 pnpm --filter ' +
    '@starter/client dev" "wait-on http://localhost:7000 && pnpm electron:compile && ' +
    'ELECTRON_DEV_URL=http://localhost:7000 electron electron/main.js"';
  const custom = "node scripts/my-desktop-dev.mjs";
  const d = mkdtempSync(join(tmpdir(), "scaffold-applyports-"));
  try {
    const write = (script: string | undefined): void => {
      const scripts: Record<string, string> = {};
      if (script !== undefined) scripts["dev:desktop"] = script;
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "p", scripts }, null, 2));
    };
    const read = (): string | undefined =>
      JSON.parse(readFileSync(join(d, "package.json"), "utf-8")).scripts["dev:desktop"];
    const ports = { server: 5101, client: 6101, nativeHmr: 7101 };
    const opts = { wantsDesktop: true, wantsMobile: false };

    write(starterDevDesktop);
    const keptStarter = applyPorts(d, ports, opts);
    const afterStarter = read();

    write(legacy);
    applyPorts(d, ports, opts);
    const afterLegacy = read();

    write(custom);
    const keptCustom = applyPorts(d, ports, opts);
    const afterCustom = read();

    write(custom);
    applyPorts(d, ports, { ...opts, force: true });
    const afterForced = read();

    write(undefined);
    applyPorts(d, ports, opts);
    const afterMissing = read();

    const checks: Check[] = [
      ["starter shape recognised", isGeneratedDevDesktopScript(starterDevDesktop)],
      ["pre-bundle shape recognised", isGeneratedDevDesktopScript(legacy)],
      ["a project's own command is not", !isGeneratedDevDesktopScript(custom)],
      ["starter script retargeted", afterStarter?.includes("localhost:7101") === true],
      ["retarget reports nothing kept", keptStarter.length === 0],
      ["pre-bundle script retargeted", afterLegacy?.includes("localhost:7101") === true],
      ["own command left alone", afterCustom === custom],
      ["own command reported as kept", keptCustom.some((k) => k.startsWith("dev:desktop"))],
      ["--force retargets it", afterForced?.includes("localhost:7101") === true],
      ["absent script is written", afterMissing?.includes("localhost:7101") === true],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.applyPortsDevDesktopGuard = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Update: add workspaces to a scaffolded project. This is the real
// `hatchkit update` dispatch, not applyWorkspacesFeature in isolation —
// cli/test-workspaces.ts covers the feature module itself, while this
// checks that update's manifest round-trip and re-run guarantees hold
// for a feature whose files live in cli/src/templates/ rather than in
// starter/.
console.log("\n── update: add workspaces (+ idempotent re-run) ──────────────────────────────");
{
  const { runUpdate } = await import("./src/scaffold/update.js");
  const { readManifest } = await import("./src/scaffold/manifest.js");
  const d = mkdtempSync(join(tmpdir(), "scaffold-update-workspaces-"));
  try {
    await scaffoldApp(cfg("workspaces-add-test", ["websocket"]), d);

    const first = await runUpdate(d, {
      presets: {
        desiredFeatures: ["websocket", "workspaces"],
        confirmAddFeatures: true,
        enableLocalDev: false,
      },
    });
    const m1 = readManifest(d);
    const routerAfterFirst = readFileSync(
      join(d, "packages/server/src/trpc/router.ts"),
      "utf-8",
    );
    const auth = readFileSync(join(d, "packages/server/src/auth/auth.ts"), "utf-8");

    // A second run with the same desired set must change nothing.
    const second = await runUpdate(d, {
      presets: {
        desiredFeatures: ["websocket", "workspaces"],
        confirmAddFeatures: true,
        enableLocalDev: false,
      },
    });
    const routerAfterSecond = readFileSync(
      join(d, "packages/server/src/trpc/router.ts"),
      "utf-8",
    );

    const checks: Check[] = [
      ["first run reports workspaces added", first.added.includes("workspaces")],
      ["manifest gains workspaces", m1?.features.includes("workspaces") === true],
      [
        "membership service written",
        existsSync(join(d, "packages/server/src/services/membership/index.ts")),
      ],
      [
        "membership contract written",
        existsSync(join(d, "packages/shared/src/membership.ts")),
      ],
      [
        "organization lockdown written",
        existsSync(join(d, "packages/server/src/auth/organization-lockdown.ts")),
      ],
      [
        "lockdown pinned by a generated test",
        existsSync(join(d, "packages/server/src/tests/organization-http-lockdown.test.ts")),
      ],
      [
        "invite page sits OUTSIDE the protected tree",
        existsSync(join(d, "packages/client/src/app/invite/page.tsx")) &&
          !existsSync(join(d, "packages/client/src/app/(protected)/invite/page.tsx")),
      ],
      [
        "members screen sits INSIDE the protected tree",
        existsSync(join(d, "packages/client/src/app/(protected)/members/page.tsx")),
      ],
      [
        "websocket on → per-recipient fan-out written",
        existsSync(join(d, "packages/server/src/ws/membership-sync.ts")),
      ],
      ["routers registered", routerAfterFirst.includes("workspaces: workspacesRouter")],
      ["shared re-export wired", readFileSync(join(d, "packages/shared/src/index.ts"), "utf-8").includes("./membership.js")],
      ["organization plugin installed", auth.includes("organization(")],
      ["lockdown wired as the before-hook", auth.includes("hooks: { before: organizationLockdown }")],
      ["organization deletion disabled server-side", auth.includes("disableOrganizationDeletion: true")],
      ["re-run adds nothing", second.added.length === 0],
      ["re-run does not double the router registration", routerAfterFirst === routerAfterSecond],
      [
        "no placeholder survived into the project",
        !readFileSync(join(d, "packages/shared/src/membership.ts"), "utf-8").includes("__HATCHKIT_"),
      ],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.updateWorkspaces = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Update: add desktop to a web-only project, then verify the re-run is
// a no-op. `update` re-applies every selected feature on every run, so a
// feature that is not idempotent corrupts the project a little each time.
console.log("\n── update: add desktop (+ idempotent re-run) ─────────");
{
  const { runUpdate } = await import("./src/scaffold/update.js");
  const { readManifest } = await import("./src/scaffold/manifest.js");
  const d = mkdtempSync(join(tmpdir(), "scaffold-update-desktop-"));
  try {
    await scaffoldApp(cfg("desktop-add-test", ["websocket"]), d);

    const first = await runUpdate(d, {
      presets: {
        desiredFeatures: ["websocket", "desktop"],
        confirmAddFeatures: true,
        enableLocalDev: false,
      },
    });
    const m1 = readManifest(d);
    const pkg1 = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
    const builderCfg = readFileSync(join(d, "electron-builder.config.mjs"), "utf-8");
    const pkgRaw = readFileSync(join(d, "package.json"), "utf-8");
    const mainTs1 = readFileSync(join(d, "electron/src/main.ts"), "utf-8");

    // Second run with the same desired set must be a no-op.
    const second = await runUpdate(d, {
      presets: {
        desiredFeatures: ["websocket", "desktop"],
        confirmAddFeatures: true,
        enableLocalDev: false,
      },
    });
    const pkgRaw2 = readFileSync(join(d, "package.json"), "utf-8");
    const mainTs2 = readFileSync(join(d, "electron/src/main.ts"), "utf-8");

    const checks: Check[] = [
      ["first run reports desktop added", first.added.includes("desktop")],
      ["electron/src copied", existsSync(join(d, "electron/src/main.ts"))],
      ["the build script came with it", existsSync(join(d, "scripts/build-desktop.mjs"))],
      ["the builder config came with it", existsSync(join(d, "electron-builder.config.mjs"))],
      ["desktop workflow copied", existsSync(join(d, ".github/workflows/desktop-release.yml"))],
      ["manifest gains desktop", m1?.features.includes("desktop") === true],
      ["manifest gains nativeHmr port", typeof m1?.ports.nativeHmr === "number"],
      ["placeholders substituted", !pkgRaw.includes("{{")],
      ["productName substituted", builderCfg.includes('productName: "Desktop Add Test"')],
      ["appId sanitized", builderCfg.includes('appId: "com.example.desktopaddtest"')],
      ["no identifier token left in the builder config", !builderCfg.includes("{{")],
      // Electron reads ELECTRON_DEV_URL and nothing else; only `dev:desktop`
      // sets it.
      [
        "dev:desktop retargeted at the nativeHmr port",
        pkg1.scripts?.["dev:desktop"]?.includes(
          `ELECTRON_DEV_URL=http://localhost:${m1?.ports.nativeHmr}`,
        ),
      ],
      ["electron devDep merged", !!pkg1.devDependencies?.electron],
      ["re-run adds nothing", second.added.length === 0],
      ["re-run leaves package.json untouched", pkgRaw2 === pkgRaw],
      ["re-run leaves electron/src/main.ts untouched", mainTs2 === mainTs1],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.updateDesktop = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Server add: retrofit a client-only scaffold back to full-stack
// without touching providers. This is the local half of the
// client-only → server+client adoption path; deploy wiring remains in
// `hatchkit adopt --resume`.
console.log("\n── server add: retrofit client-only project ─────────────────────────────");
{
  const { runServerAdd } = await import("./src/scaffold/server-add.js");
  const { readManifest, writeManifest } = await import("./src/scaffold/manifest.js");
  const d = mkdtempSync(join(tmpdir(), "scaffold-server-add-"));
  try {
    await scaffoldApp(
      cfg("server-add-test", [], {
        surfaces: "static",
      }),
      d,
    );
    const before = readManifest(d);
    if (before) writeManifest(d, { ...before, deploymentMode: "gh-pages" });
    const result = await runServerAdd(d, {
      yes: true,
      presets: { confirmAdd: true },
    });
    const after = readManifest(d);
    const rootPkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
    const sharedIndex = readFileSync(join(d, "packages/shared/src/index.ts"), "utf-8");
    const serverEnv = readFileSync(join(d, "packages/server/.env.example"), "utf-8");
    const checks: Check[] = [
      ["initial scaffold was static", before?.surfaces === "static"],
      ["server package created", existsSync(join(d, "packages/server/package.json"))],
      ["shared ml-types restored", existsSync(join(d, "packages/shared/src/ml-types.ts"))],
      ["shared barrel exports ml-types", sharedIndex.includes("./ml-types.js")],
      ["manifest surfaces now fullstack", after?.surfaces === "fullstack"],
      ["gh-pages switched to coolify", after?.deploymentMode === "coolify"],
      ["root dev script restored", rootPkg.scripts?.dev === "node scripts/dev.mjs"],
      ["root build script includes server", rootPkg.scripts?.build?.includes("@starter/server")],
      ["server env domain rewritten", /FRONTEND_URL=https:\/\/server-add-test\.example\.com/m.test(serverEnv)],
      ["result reports changes", result.changed],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.serverAdd = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// dotenvx: scaffold a project, verify the encrypted/placeholder
// envelope. STRIPE_* are deliberately NOT in the scaffolder's
// candidate list — `provisionStripeProject` (run after scaffold) is
// what writes those values into .env.development + .env.production
// with per-project keys. So this test asserts the inverse: STRIPE_*
// is absent from the seeded file, and the auto-minted secrets we DO
// seed (BETTER_AUTH_SECRET) land encrypted.
console.log("\n── dotenvx: .env.production is sealed correctly ─────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "scaffold-dotenvx-"));
  try {
    const c = cfg("dotenvx-test", ["stripe"]);
    c.envValues = {
      MONGODB_URI: "mongodb+srv://real-host/real-db",
      // STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET intentionally omitted —
      // they're outside the scaffold's contract now (per-project Stripe
      // provisioning writes them post-scaffold).
    };
    const result = await scaffoldApp(c, d);

    const envProd = readFileSync(join(d, "packages/server/.env.production"), "utf-8");
    const envKeys = readFileSync(join(d, "packages/server/.env.keys"), "utf-8");
    const { getSecret, SECRET_KEYS } = await import("./src/utils/secrets.js");
    const keychainKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey(c.name));

    const checks: Check[] = [
      ["dotenvx result is populated", !!result.dotenvx],
      [
        "encryptedKeys does NOT include STRIPE_SECRET_KEY (provisioned post-scaffold)",
        !(result.dotenvx?.encryptedKeys.includes("STRIPE_SECRET_KEY") ?? false),
      ],
      [
        "placeholderKeys does NOT include STRIPE_WEBHOOK_SECRET (provisioned post-scaffold)",
        !(result.dotenvx?.placeholderKeys.includes("STRIPE_WEBHOOK_SECRET") ?? false),
      ],
      [
        ".env.production has DOTENV_PUBLIC_KEY_PRODUCTION",
        /DOTENV_PUBLIC_KEY_PRODUCTION=/.test(envProd),
      ],
      [
        ".env.production does not pre-seed STRIPE_SECRET_KEY",
        !/^STRIPE_SECRET_KEY=/m.test(envProd),
      ],
      [
        ".env.production does not pre-seed STRIPE_WEBHOOK_SECRET",
        !/^STRIPE_WEBHOOK_SECRET=/m.test(envProd),
      ],
      [
        "BETTER_AUTH_SECRET auto-generated + encrypted",
        !envProd.includes("CHANGE_ME_BETTER_AUTH_SECRET") &&
          /BETTER_AUTH_SECRET="encrypted:/.test(envProd),
      ],
      [
        ".env.keys has DOTENV_PRIVATE_KEY_PRODUCTION (on disk, gitignored)",
        /DOTENV_PRIVATE_KEY_PRODUCTION=/.test(envKeys),
      ],
      [
        "private key mirrored into (isolated) keychain",
        typeof keychainKey === "string" && keychainKey.length > 0,
      ],
      ["keychain key matches .env.keys", keychainKey === result.dotenvx?.privateKey],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.dotenvx = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Port availability check — must run LAST in the port-test sequence
// because it aggressively reserves most of the server range, which
// would starve any later scaffold.
console.log("\n── ports: avoids already-bound ports on the host ─────────────────────────────");
{
  const { createServer } = await import("node:net");
  const { PORT_RANGES, isPortFree } = await import("./src/utils/ports.js");
  const { addUsedPorts, getUsedPorts } = await import("./src/config.js");

  const [serverMin, serverMax] = PORT_RANGES.server;
  // Find two adjacent ports that are free on the host AND unclaimed in
  // the CLI registry. Earlier scaffolds in this file have already
  // registered ports without binding them, so an OS-only check picks a
  // pair the picker would refuse anyway — and the reservation below then
  // leaves it nothing at all to choose. That made this test depend on
  // how many scaffolds happened to run before it.
  const alreadyUsed = new Set(getUsedPorts());
  let bound = -1;
  let sparePort = -1;
  for (let p = serverMin; p <= serverMax - 1; p++) {
    if (alreadyUsed.has(p) || alreadyUsed.has(p + 1)) continue;
    if ((await isPortFree(p)) && (await isPortFree(p + 1))) {
      bound = p;
      sparePort = p + 1;
      break;
    }
  }
  if (bound === -1) throw new Error("no adjacent unclaimed free ports in server range for test");

  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(bound, "127.0.0.1", () => resolve());
  });

  // Reserve every other port in the server range via the CLI registry
  // so the picker is forced to choose between `bound` (busy) and
  // `sparePort` (free).
  const reserved: number[] = [];
  for (let p = serverMin; p <= serverMax; p++) {
    if (p !== bound && p !== sparePort) reserved.push(p);
  }
  // sparePort must be the ONLY pickable port when the picker runs.
  addUsedPorts(reserved);

  const d = mkdtempSync(join(tmpdir(), "scaffold-ports-busy-"));
  try {
    const { ports } = await scaffoldApp(cfg("busy-port-test", []), d);
    console.log(`  bound=${bound}, spare=${sparePort}, picked server=${ports.server}`);
    const checks: Check[] = [
      ["picker skipped the bound port", ports.server === sparePort],
      ["picker did NOT pick the bound port", ports.server !== bound],
      ["picked server port is actually free", await isPortFree(ports.server)],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    results.portsBusyAvoid = ok;
  } finally {
    rmSync(d, { recursive: true, force: true });
    await new Promise<void>((r) => blocker.close(() => r()));
  }
}

// Rollback: force scaffoldApp to fail by stubbing STARTER_ROOT's
// `package.json` to unreadable contents, verify no half-scaffold + no
// port leak in the registry. We simulate failure by creating a
// directory where the file is expected (so readFileSync throws EISDIR).
console.log("\n── rollback: failed scaffold leaves no partial state ─────────────────────────────");
{
  const { mkdirSync } = await import("node:fs");
  const { getUsedPorts } = await import("./src/config.js");

  // Seed a trap: replace the expected next.config.ts with a directory
  // inside a throwaway copy of the starter. Easiest: scaffold, then
  // immediately force a step to throw. Instead, we take a direct
  // approach — call scaffoldApp with an outputDir pointing at a file
  // that happens to exist (so cpSync fails).
  const collision = mkdtempSync(join(tmpdir(), "scaffold-rollback-"));
  writeFileSync(join(collision, "already-here"), "block");

  // Count ports before the failed run.
  const before = getUsedPorts().length;

  let threw = false;
  try {
    await scaffoldApp(cfg("rollback-test", []), collision);
  } catch {
    threw = true;
  }

  const after = getUsedPorts().length;
  const checks: Check[] = [
    ["scaffoldApp threw", threw],
    ["no ports leaked into registry", after === before],
    ["collision dir was not overwritten", existsSync(join(collision, "already-here"))],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.rollback = ok;
  rmSync(collision, { recursive: true, force: true });
}

// Keytar migration: seed a legacy plaintext token in the conf store,
// call the ensure function, verify the token moves to keytar and is
// cleared from conf.
console.log("\n── keytar migration: legacy plaintext secret moved to keychain ─────────────────────────────");
{
  const { default: Conf } = await import("conf");
  const { getSecret, setSecret, deleteSecret, SECRET_KEYS } = await import(
    "./src/utils/secrets.js"
  );

  // Ensure the keytar entry is clean before the test so we observe
  // only this test's effect.
  await deleteSecret(SECRET_KEYS.coolifyToken);

  // Write a legacy shape directly into the isolated conf store.
  const rawStore = new Conf({
    projectName: "hatchkit",
    cwd: process.env.HATCHKIT_CONF_DIR,
  });
  rawStore.set("providers.coolify", {
    status: "configured",
    url: "https://coolify.test.local",
    token: "legacy-plaintext-token",
    lastVerified: new Date().toISOString(),
  });

  // Trigger migration via the read path.
  const { getCoolifyConfig } = await import("./src/config.js");
  const loaded = await getCoolifyConfig();

  // After migration, conf should no longer hold the token.
  const coolifyMeta = rawStore.get("providers.coolify") as {
    token?: string;
  } | undefined;
  const secretValue = await getSecret(SECRET_KEYS.coolifyToken);

  const checks: Check[] = [
    ["getCoolifyConfig() returned merged config", loaded?.token === "legacy-plaintext-token"],
    ["token removed from conf JSON", coolifyMeta?.token === undefined],
    ["token present in keytar", secretValue === "legacy-plaintext-token"],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.keytarMigration = ok;

  // Clean up: remove the keytar entry we created so we don't pollute
  // the developer's real keychain across test runs.
  await deleteSecret(SECRET_KEYS.coolifyToken);
}

// Build pipeline: NODE_VERSION auto-detect from engines.node + the
// `created` vs `overwritten` split that adopt's ledger keys off.
// Covers the bug where the Dockerfile baked in node:22-alpine while
// the project's package.json pinned `engines.node: ">=24"`, producing
// ERR_PNPM_UNSUPPORTED_ENGINE in CI. The detection MUST track the
// project's engines field, and `force: true` must NEVER mark
// pre-existing files as `created` (the safety invariant for undo).
console.log("\n── build pipeline: engines.node detection + created/overwritten safety ─────");
{
  const { detectNodeMajorVersion, scaffoldBuildPipeline } = await import(
    "./src/scaffold/build-pipeline.js"
  );
  const tmp = mkdtempSync(join(tmpdir(), "build-pipeline-test-"));
  const checks: Check[] = [];

  // 1. detectNodeMajorVersion handles the common engines.node shapes.
  const cases: Array<[string | undefined, string]> = [
    [undefined, "24"],
    [">=24", "24"],
    [">=24.0.0", "24"],
    ["^24.0.0", "24"],
    ["~24.5.1", "24"],
    ["24.x", "24"],
    [">=22", "22"],
    [">=20.0.0 <24.0.0", "20"],
    ["22 || 24", "22"],
    ["weird", "24"],
    [">=10", "24"],
  ];
  for (const [engines, expected] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "pkg-engines-"));
    const pkg: { engines?: { node?: string } } = engines ? { engines: { node: engines } } : {};
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    const got = detectNodeMajorVersion(dir);
    checks.push([
      `engines=${JSON.stringify(engines)} -> "${got}" (expected "${expected}")`,
      got === expected,
    ]);
    rmSync(dir, { recursive: true, force: true });
  }

  // 2. Dockerfile actually contains the detected version.
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ engines: { node: ">=24" } }));
  const r1 = scaffoldBuildPipeline({
    projectDir: tmp,
    projectName: "test-app",
    ghOwner: "owner",
    entrypoint: "dist/index.js",
    port: 3000,
    surfaces: "static",
    defaultBranch: "main",
  });
  const dockerfile = readFileSync(join(tmp, "Dockerfile"), "utf-8");
  const compose = readFileSync(join(tmp, "docker-compose.yml"), "utf-8");
  checks.push(["Dockerfile contains NODE_VERSION=24", /NODE_VERSION=24\b/.test(dockerfile)]);
  checks.push([
    "Dockerfile does NOT contain NODE_VERSION=22",
    !/NODE_VERSION=22\b/.test(dockerfile),
  ]);
  checks.push(["client-only compose exposes nginx port 80", /expose:\s*\n\s*-\s*"80"/.test(compose)]);
  checks.push([
    "client-only compose does NOT publish host:80 (Coolify Traefik owns it)",
    !compose.includes('"80:80"'),
  ]);
  checks.push([
    "client-only compose does NOT expose default app port 3000",
    !/expose:\s*\n\s*-\s*"3000"/.test(compose),
  ]);
  checks.push(["created list includes Dockerfile", r1.created.includes("Dockerfile")]);
  checks.push(["overwritten list is empty on first run", r1.overwritten.length === 0]);

  // 3. Re-run with force=true. Pre-existing Dockerfile/compose/workflow
  //    must land in `overwritten`, NOT `created` — the critical
  //    invariant for the ledger so destroy never deletes user content.
  const r2 = scaffoldBuildPipeline({
    projectDir: tmp,
    projectName: "test-app",
    ghOwner: "owner",
    entrypoint: "dist/index.js",
    port: 3000,
    surfaces: "static",
    defaultBranch: "main",
    force: true,
  });
  checks.push(["force=true: Dockerfile in overwritten", r2.overwritten.includes("Dockerfile")]);
  checks.push(["force=true: Dockerfile NOT in created", !r2.created.includes("Dockerfile")]);
  checks.push([
    "force=true: docker-compose.yml in overwritten",
    r2.overwritten.includes("docker-compose.yml"),
  ]);
  checks.push([
    "force=true: deploy.yml in overwritten",
    r2.overwritten.includes(".github/workflows/deploy.yml"),
  ]);
  checks.push([
    "force=true: created list empty (everything pre-existed)",
    r2.created.length === 0,
  ]);

  // 4. The adopt workflow's E2E S3 container follows the `s3` input.
  const withS3 = readFileSync(join(tmp, ".github/workflows/deploy.yml"), "utf-8");
  checks.push(["deploy.yml (default): SeaweedFS step", withS3.includes("- name: Start SeaweedFS")]);
  checks.push(["deploy.yml (default): no MinIO", !/minio/i.test(withS3)]);
  scaffoldBuildPipeline({
    projectDir: tmp,
    projectName: "test-app",
    ghOwner: "owner",
    entrypoint: "dist/index.js",
    port: 3000,
    surfaces: "static",
    defaultBranch: "main",
    force: true,
    s3: false,
  });
  const noS3 = readFileSync(join(tmp, ".github/workflows/deploy.yml"), "utf-8");
  checks.push(["deploy.yml (s3: false): no SeaweedFS step", !/seaweedfs/i.test(noS3)]);
  checks.push(["deploy.yml (s3: false): no S3_* / AWS_* env", !/^\s+(S3_|AWS_)/m.test(noS3)]);
  checks.push(["deploy.yml (s3: false): E2E run kept", noS3.includes("npx playwright test")]);

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.buildPipelineNodeVersion = ok;
  rmSync(tmp, { recursive: true, force: true });
}

// Build pipeline: framework detection picks the right Dockerfile.
// A Next.js project needs a Node runtime even when surfaces look
// "client-only" — Server Actions and route handlers don't compile
// under `output: "export"`. Bug we're guarding against: hatchkit
// scaffolded an nginx-static Dockerfile copying /app/dist for a
// Next.js project, and the build failed at runtime (no dist/) and
// at compile time (Server Actions refuse static export).
console.log("\n── build pipeline: framework detection (Next.js) ───────────────────────────");
{
  const { detectFramework, scaffoldBuildPipeline } = await import(
    "./src/scaffold/build-pipeline.js"
  );
  const checks: Check[] = [];

  // 1. detectFramework via next.config.* file.
  for (const ext of ["ts", "mjs", "js", "cjs"]) {
    const dir = mkdtempSync(join(tmpdir(), `next-config-${ext}-`));
    writeFileSync(join(dir, `next.config.${ext}`), "export default {};");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    checks.push([`detects next.config.${ext}`, detectFramework(dir) === "nextjs"]);
    rmSync(dir, { recursive: true, force: true });
  }

  // 2. detectFramework via package.json deps (no config file).
  {
    const dir = mkdtempSync(join(tmpdir(), "next-deps-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "^16" } }),
    );
    checks.push(["detects `next` in dependencies", detectFramework(dir) === "nextjs"]);
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "next-devdeps-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { next: "^16" } }),
    );
    checks.push(["detects `next` in devDependencies", detectFramework(dir) === "nextjs"]);
    rmSync(dir, { recursive: true, force: true });
  }

  // 3. Generic fallback (no signals).
  {
    const dir = mkdtempSync(join(tmpdir(), "no-next-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    checks.push(["empty package.json → generic", detectFramework(dir) === "generic"]);
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "vite-only-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { vite: "^5" } }),
    );
    checks.push(["vite-only project → generic", detectFramework(dir) === "generic"]);
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. Scaffold with Next.js + client-only surfaces — the foot-gun the
  //    sprite-tools deploy tripped over. Must produce a Node-runtime
  //    Dockerfile (not nginx) and a compose that maps the real app
  //    port (not nginx's :80). Healthcheck must be node-based, not
  //    wget-based — node:slim ships neither wget nor busybox.
  {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-next-client-"));
    writeFileSync(join(dir, "next.config.ts"), "export default {};");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { next: "^16" } }),
    );
    scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "next-app",
      ghOwner: "owner",
      entrypoint: "",
      port: 3000,
      surfaces: "static",
      defaultBranch: "main",
    });
    const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf-8");
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf-8");

    checks.push(["Next.js Dockerfile runs next start", /node_modules\/.bin\/next/.test(dockerfile)]);
    checks.push(["Next.js Dockerfile uses bookworm-slim", /bookworm-slim/.test(dockerfile)]);
    checks.push([
      "Next.js Dockerfile does NOT serve via nginx (no FROM nginx)",
      !/^FROM\s+nginx[:\s]/m.test(dockerfile),
    ]);
    checks.push([
      "Next.js Dockerfile does NOT COPY /app/dist",
      !/COPY --from=build \/app\/dist/.test(dockerfile),
    ]);
    checks.push([
      "Next.js compose exposes app port (not nginx :80) despite client-only",
      /expose:\s*\n\s*-\s*"3000"/.test(compose),
    ]);
    checks.push([
      "Next.js compose does NOT expose nginx :80",
      !/expose:\s*\n\s*-\s*"80"/.test(compose),
    ]);
    checks.push([
      "Next.js compose does NOT publish host ports (Coolify Traefik routes)",
      !/^\s*ports:/m.test(compose),
    ]);
    checks.push([
      "Next.js compose healthcheck command is node-based, not wget",
      /wget --(spider|quiet)/.test(compose) === false &&
        /- "node"/.test(compose) &&
        /- "-e"/.test(compose),
    ]);
    rmSync(dir, { recursive: true, force: true });
  }

  // 4b. pnpm workspace monorepo with Next in a sub-package. The
  //     foot-gun: detectFramework only checked the root, so projects
  //     like gamedev (Next 15 in showcase/, deploys to Coolify+GHCR)
  //     fell through to the nginx-static client Dockerfile. Must
  //     return "nextjs" AND surface the sub-package so the monorepo
  //     Dockerfile variant can run the workspace build correctly.
  {
    const { detectNextjsMonorepoPackage } = await import("./src/scaffold/build-pipeline.js");
    const dir = mkdtempSync(join(tmpdir(), "scaffold-next-monorepo-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "monorepo-root", private: true }),
    );
    writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "showcase"\n');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const subDir = join(dir, "showcase");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "next.config.ts"), "export default {};");
    writeFileSync(
      join(subDir, "package.json"),
      JSON.stringify({
        name: "3d-assets-showcase",
        dependencies: { next: "^15" },
      }),
    );

    checks.push(["monorepo Next detected as nextjs", detectFramework(dir) === "nextjs"]);
    const hit = detectNextjsMonorepoPackage(dir);
    checks.push(["monorepo packageDir is showcase", hit?.packageDir === "showcase"]);
    checks.push([
      "monorepo packageName is sub-package name",
      hit?.packageName === "3d-assets-showcase",
    ]);

    scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "monorepo-app",
      ghOwner: "owner",
      entrypoint: "",
      port: 3000,
      surfaces: "static",
      defaultBranch: "main",
    });
    const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf-8");
    checks.push([
      "monorepo Dockerfile uses workspace-aware build (pnpm --filter)",
      /pnpm --filter 3d-assets-showcase build/.test(dockerfile),
    ]);
    checks.push([
      "monorepo Dockerfile WORKDIRs into the sub-package",
      /WORKDIR \/app\/showcase/.test(dockerfile),
    ]);
    checks.push([
      "monorepo Dockerfile is NOT the nginx client variant",
      !/^FROM\s+nginx[:\s]/m.test(dockerfile),
    ]);
    checks.push([
      "monorepo Dockerfile is NOT the single-package Next variant",
      /pnpm-workspace\.yaml/.test(dockerfile),
    ]);

    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf-8");
    checks.push([
      "scaffolded compose pins pull_policy: always",
      /pull_policy:\s*always/.test(compose),
    ]);

    rmSync(dir, { recursive: true, force: true });
  }

  // 5. Non-Next.js (generic) keeps the historical surfaces-driven
  //    nginx-for-client / Node-for-server split. Regression guard:
  //    don't accidentally route Vite/Astro projects through the
  //    Next.js template.
  {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-vite-client-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { vite: "^5" } }),
    );
    scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "vite-app",
      ghOwner: "owner",
      entrypoint: "",
      port: 3000,
      surfaces: "static",
      defaultBranch: "main",
    });
    const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf-8");
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf-8");
    checks.push(["generic client-only still uses nginx", /nginx/.test(dockerfile)]);
    checks.push([
      "generic client-only compose still exposes :80",
      /expose:\s*\n\s*-\s*"80"/.test(compose),
    ]);
    rmSync(dir, { recursive: true, force: true });
  }

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.buildPipelineFrameworkDetection = ok;
}

// Coolify API: dockercompose app creation must use per-service domains,
// not the top-level `domains` field that Coolify now rejects.
console.log("\n── coolify api: dockercompose domains payload ─────────────────────────────");
{
  const { CoolifyApi } = await import("./src/utils/coolify-api.js");
  const { normalizeCoolifyGitRepository } = await import("./src/deploy/coolify-app.js");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ uuid: "app-uuid" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const api = new CoolifyApi({ url: "https://coolify.test", token: "test-token" });
    await api.createApplicationFromPublicRepo({
      projectUuid: "project-uuid",
      serverUuid: "server-uuid",
      gitRepository: "https://github.com/acme/app",
      buildPack: "dockercompose",
      domains: ["https://app.example.com:3000"],
      dockerComposeDomainServiceName: "web",
    });
    await api.createApplicationFromPublicRepo({
      projectUuid: "project-uuid",
      serverUuid: "server-uuid",
      gitRepository: "https://github.com/acme/app",
      buildPack: "nixpacks",
      domains: ["https://app.example.com"],
    });
    await api.createApplicationFromPrivateGithubApp({
      projectUuid: "project-uuid",
      serverUuid: "server-uuid",
      gitRepository: "acme/private-app",
      githubAppUuid: "github-app-uuid",
      buildPack: "dockercompose",
      domains: ["https://private.example.com:3000"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const dockerComposeBody = JSON.parse(String(calls[0]?.init.body ?? "{}"));
  const nixpacksBody = JSON.parse(String(calls[1]?.init.body ?? "{}"));
  const privateBody = JSON.parse(String(calls[2]?.init.body ?? "{}"));
  const publicRepo = normalizeCoolifyGitRepository("git@github.com:acme/app.git", false);
  const privateRepo = normalizeCoolifyGitRepository("git@github.com:acme/app.git", true);
  const checks: Check[] = [
    ["public create uses /applications/public", calls[0]?.url.endsWith("/applications/public")],
    [
      "private create uses /applications/private-github-app",
      calls[2]?.url.endsWith("/applications/private-github-app"),
    ],
    ["dockercompose omits top-level domains", dockerComposeBody.domains === undefined],
    [
      "dockercompose sets service domain",
      Array.isArray(dockerComposeBody.docker_compose_domains) &&
        dockerComposeBody.docker_compose_domains[0]?.name === "web" &&
        dockerComposeBody.docker_compose_domains[0]?.domain === "https://app.example.com:3000",
    ],
    ["nixpacks still uses top-level domains", nixpacksBody.domains === "https://app.example.com"],
    ["private create sends github_app_uuid", privateBody.github_app_uuid === "github-app-uuid"],
    ["private create sends owner/repo selector", privateBody.git_repository === "acme/private-app"],
    ["public SSH remote normalizes to HTTPS", publicRepo.gitRepository === "https://github.com/acme/app"],
    ["private SSH remote normalizes to owner/repo", privateRepo.gitRepository === "acme/app"],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.coolifyDockerComposeDomains = ok;
}

// Coolify API: /github-apps discovery, and the filter that keeps the
// seeded "Public GitHub" entry out of the results.
//
// Every Coolify install ships that seeded source (is_public: true,
// html_url: https://github.com, no app_id/private key). It exists so
// the UI can clone public repos over anonymous HTTPS — it cannot see a
// private repo, and passing its uuid to
// POST /applications/private-github-app makes Coolify answer a bare
// `500 Internal Server Error`. That's exactly what broke `hatchkit
// adopt` on a private repo whose Coolify install had no real App: the
// seeded row was the only "source", so adopt offered it, the user
// picked it, and Coolify 500'd. Filtering it out turns that into the
// existing "install a GitHub App" guidance, and stops `doctor` from
// reporting a usable App source when there is none.
console.log("\n── coolify api: github app source discovery ─────────────");
{
  const { CoolifyApi, isPublicGithubSource } = await import("./src/utils/coolify-api.js");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify([
        // Coolify returns the seeded public source first on a stock
        // install — the ordering that made adopt auto-pick it.
        {
          uuid: "public-github-uuid",
          name: "Public GitHub",
          html_url: "https://github.com",
          api_url: "https://api.github.com",
          is_public: true,
        },
        {
          uuid: "gh-app-uuid",
          name: "Personal GitHub App",
          html_url: "https://github.com/apps/coolify-personal",
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  let sources: Array<{ uuid: string; name: string; html_url?: string }> = [];
  try {
    const api = new CoolifyApi({ url: "https://coolify.test", token: "test-token" });
    sources = await api.listGithubSources();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const checks: Check[] = [
    ["source discovery uses /github-apps", calls[0]?.endsWith("/github-apps")],
    ["seeded 'Public GitHub' source filtered out", sources.length === 1],
    ["source uuid returned", sources[0]?.uuid === "gh-app-uuid"],
    ["source name returned", sources[0]?.name === "Personal GitHub App"],
    // The predicate itself. Two positive shapes (Coolify's flag, and a
    // bare-origin URL for builds that don't send the flag) and the
    // negatives that must survive — including the two "we can't tell"
    // cases, where keeping the source is strictly better than
    // reporting an empty list.
    [
      "isPublicGithubSource: is_public flag",
      isPublicGithubSource({ name: "Public GitHub", html_url: "https://github.com", is_public: true }),
    ],
    [
      "isPublicGithubSource: bare origin without the flag",
      isPublicGithubSource({ name: "Public GitHub", html_url: "https://github.com" }),
    ],
    [
      "isPublicGithubSource: bare origin with a trailing slash",
      isPublicGithubSource({ name: "Public GitHub", html_url: "https://github.com/" }),
    ],
    [
      "isPublicGithubSource: keeps a real App on github.com",
      !isPublicGithubSource({ html_url: "https://github.com/apps/coolify-personal" }),
    ],
    [
      "isPublicGithubSource: keeps a real App on a GHE host",
      !isPublicGithubSource({ html_url: "https://gh.acme.internal/apps/acme-coolify" }),
    ],
    [
      "isPublicGithubSource: falls back to api_url",
      !isPublicGithubSource({ api_url: "https://api.github.com/apps/legacy" }),
    ],
    ["isPublicGithubSource: keeps a source with no URL", !isPublicGithubSource({ name: "opaque" })],
    [
      "isPublicGithubSource: keeps a source with an unparseable URL",
      !isPublicGithubSource({ name: "opaque", html_url: "not a url" }),
    ],
    [
      "isPublicGithubSource: keeps an explicitly non-public source",
      !isPublicGithubSource({ html_url: "https://github.com/apps/acme", is_public: false }),
    ],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.coolifyGithubAppSources = ok;
}

// Coolify API: updateApplication must send domains/dockerComposeDomains
// when those fields are passed. Pre-fix this silently dropped them, which
// is what left collection-of-beauty's container with zero traefik labels
// (Coolify only auto-generates labels when the per-service routing is
// populated). This test locks the regression closed.
console.log(
  "\n── coolify api: updateApplication forwards docker_compose_domains ─────────────",
);
{
  const { CoolifyApi } = await import("./src/utils/coolify-api.js");
  const calls: { url: string; init: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    // Coolify returns `{}` on a successful PATCH; mirror that so the
    // CoolifyApi.request body-parser doesn't trip on an empty string.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const api = new CoolifyApi({ url: "https://coolify.test", token: "test-token" });
    await api.updateApplication("app-uuid-1", {
      buildPack: "dockercompose",
      portsExposes: "3000",
      dockerComposeDomains: [{ name: "app", domain: "https://beauty.example.com" }],
    });
    await api.updateApplication("app-uuid-2", {
      buildPack: "nixpacks",
      portsExposes: "8080",
      domains: ["https://api.example.com", "https://www.example.com"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const composeBody = JSON.parse(String(calls[0]?.init.body ?? "{}"));
  const flatBody = JSON.parse(String(calls[1]?.init.body ?? "{}"));
  const checks: Check[] = [
    ["compose update PATCHes /applications/{uuid}", calls[0]?.init.method === "PATCH"],
    ["compose update sets build_pack", composeBody.build_pack === "dockercompose"],
    [
      "compose update sets docker_compose_domains",
      Array.isArray(composeBody.docker_compose_domains) &&
        composeBody.docker_compose_domains[0]?.name === "app" &&
        composeBody.docker_compose_domains[0]?.domain === "https://beauty.example.com",
    ],
    ["compose update omits flat domains", composeBody.domains === undefined],
    [
      "flat update joins domains with comma",
      flatBody.domains === "https://api.example.com,https://www.example.com",
    ],
    ["flat update omits docker_compose_domains", flatBody.docker_compose_domains === undefined],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.coolifyUpdateApplicationDomains = ok;
}

// Plausible CE/self-hosted does not ship the Sites API. Its GET path can
// answer 406 during add's conflict preflight, and create can answer 404/406.
// Hatchkit should still write browser tracker env for a manually-created site.
console.log("\n── plausible api: CE fallback writes manual tracker env ─────────────────────");
{
  const { getStore } = await import("./src/config.js");
  const { SECRET_KEYS, deleteSecret, setSecret } = await import("./src/utils/secrets.js");
  const { runProvision } = await import("./src/provision/index.js");

  const store = getStore();
  store.set("providers.plausible", {
    status: "configured",
    url: "https://plausible.test",
    timezone: "Etc/UTC",
  });
  await setSecret(SECRET_KEYS.plausibleApiKey, "test-plausible-key");
  const tmp = mkdtempSync(join(tmpdir(), "plausible-ce-env-"));

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = String(url).includes("/api/v1/sites/") ? 406 : 404;
    return new Response(
      JSON.stringify({ message: status === 406 ? "Not Acceptable" : "Not Found", status }),
      {
        status,
        statusText: status === 406 ? "Not Acceptable" : "Not Found",
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  let threw = false;
  let prodEnv = "";
  let eventCreated: boolean | undefined;
  try {
    await runProvision({
      baseName: "plausible-ce-test",
      services: ["plausible"],
      domain: "fractal.garden",
      surfaces: {
        mode: "static",
        projectDir: tmp,
        clientEnvDir: tmp,
      },
      failIfExists: true,
      onProvisioned: (event) => {
        if (event.service === "plausible") eventCreated = event.created;
      },
    });
    prodEnv = readFileSync(join(tmp, ".env.production"), "utf-8");
  } catch (err) {
    threw = true;
    console.log(`    runProvision threw: ${(err as Error).message}`);
  } finally {
    globalThis.fetch = originalFetch;
    await deleteSecret(SECRET_KEYS.plausibleApiKey);
    await deleteSecret(SECRET_KEYS.plausibleSiteDomain("plausible-ce-test"));
    (store as unknown as { delete(key: string): void }).delete("providers.plausible");
    rmSync(tmp, { recursive: true, force: true });
  }

  const checks: Check[] = [
    ["runProvision does not throw on CE Sites API responses", !threw],
    [
      "preflight probes Plausible site endpoint",
      calls.some((c) => c.url === "https://plausible.test/api/v1/sites/fractal.garden"),
    ],
    [
      "provision tries Plausible create endpoint",
      calls.some(
        (c) => c.url === "https://plausible.test/api/v1/sites" && c.init.method === "POST",
      ),
    ],
    ["provision event reports no remote site created", eventCreated === false],
    ["prod env contains Plausible domain key", /PUBLIC_PLAUSIBLE_DOMAIN=/.test(prodEnv)],
    [
      "prod env contains Next.js Plausible domain key",
      /NEXT_PUBLIC_PLAUSIBLE_DOMAIN=/.test(prodEnv),
    ],
    ["prod env contains Plausible script key", /PUBLIC_PLAUSIBLE_SCRIPT_URL=/.test(prodEnv)],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.plausibleCeManualFallback = ok;
}

// Sync plan computation: the manifest → desired Coolify state must
// name compose services that actually exist, and must emit at most one
// entry per service (Coolify STORES docker_compose_domains as a map, so
// duplicates are a silent last-wins drop). Anchored on
// collection-of-beauty's real shape (static, port 80) and on the
// starter's fullstack compose.
//
// The previous version of this block asserted the OLD behaviour — a
// service literally named `app`, and four separate `server` entries.
// Both were bugs: `app` appears in no hatchkit compose file, and the
// four entries collapsed to one inside Coolify.
console.log("\n── sync: manifest → desired Coolify app states (matches scaffold time) ────────");
{
  const { computeRoutingPlan } = await import("./src/deploy/routing.js");

  const staticSite = computeRoutingPlan({
    name: "collection-of-beauty",
    domain: "beauty.example.com",
    topology: "single-origin",
    surfaces: "static",
    ports: { server: 3000, client: 3001 },
    composeServices: ["client"],
  });
  const fullstack = computeRoutingPlan({
    name: "split-app",
    domain: "split.example.com",
    topology: "single-origin",
    surfaces: "fullstack",
    ports: { server: 3000, client: 3001 },
    composeServices: ["server", "client", "mongo", "redis"],
  });
  const split = computeRoutingPlan({
    name: "split-app",
    domain: "split.example.com",
    topology: "split",
    surfaces: "fullstack",
    ports: { server: 3000, client: 3001 },
  });

  const staticApp = staticSite.apps[0];
  const composeApp = fullstack.apps[0];
  const splitClient = split.apps.find((a) => a.appName === "split-app-client");
  const splitServer = split.apps.find((a) => a.appName === "split-app-server");

  const checks: Check[] = [
    ["static: one app named after the project", staticSite.apps.length === 1 && staticApp.appName === "collection-of-beauty"],
    [
      "static: domain canonicalizes to https://<bare>",
      staticApp.composeDomains[0]?.domain === "https://beauty.example.com",
    ],
    [
      "static: routes the `client` service, never the phantom `app`",
      staticApp.composeDomains[0]?.name === "client",
    ],
    ["static: ports_exposes is 80", staticApp.portsExposes === "80"],
    [
      "fullstack: client on the bare domain, server on /api",
      composeApp.composeDomains.length === 2 &&
        composeApp.composeDomains[0]?.domain === "https://split.example.com" &&
        composeApp.composeDomains[1]?.domain === "https://split.example.com/api",
    ],
    [
      "fullstack: one entry per service (Coolify stores a map)",
      new Set(composeApp.composeDomains.map((d) => d.name)).size ===
        composeApp.composeDomains.length,
    ],
    [
      "fullstack: strip-prefix off so /api survives to Express",
      composeApp.stripPrefix === false,
    ],
    ["split: emits split client app", !!splitClient],
    ["split: emits split server app", !!splitServer],
    [
      "split: client gets the frontend hostname only",
      splitClient?.composeDomains.length === 1 &&
        splitClient?.composeDomains[0]?.domain === "https://split.example.com",
    ],
    [
      "split: server gets api.<domain> at the root path",
      splitServer?.composeDomains.length === 1 &&
        splitServer?.composeDomains[0]?.domain === "https://api.split.example.com",
    ],
    [
      "split: reports the extra DNS record it needs",
      split.extraDnsHostnames.join(",") === "api.split.example.com",
    ],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.syncDesiredAppStates = ok;
}

// Adopt rollback safety: every LedgerStep kind has a recipe + describe
// + correct destructive flag, and the file-system undos only touch the
// path they were given. This catches the safety invariant — if I add a
// new kind later and forget to wire it up, this test fails.
console.log("\n── adopt ledger: every kind has recipe/describe + safe file undo ─────────────");
{
  const { RunLedger } = await import("./src/utils/run-ledger.js");
  const { printRecipe } = await import("./src/deploy/rollback.js");
  // Re-import the destructive predicate via a wrapper — it's not exported,
  // so probe it indirectly by checking that runRollback (with `yes:false`
  // unset) would prompt. For test purposes, just walk the ledger and
  // ensure printRecipe doesn't throw for any kind.
  const tmp = mkdtempSync(join(tmpdir(), "adopt-ledger-"));
  const manifestPath = join(tmp, ".hatchkit.json");
  const keysPath = join(tmp, ".env.keys");
  const dockerfilePath = join(tmp, "Dockerfile");
  const gitDir = join(tmp, ".git");
  for (const p of [manifestPath, keysPath, dockerfilePath]) writeFileSync(p, "test");
  const { mkdirSync: mk2 } = await import("node:fs");
  mk2(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

  const ledger = RunLedger.start("adopt-ledger-test");
  // One of every adopt-only kind PLUS a couple of shared kinds.
  ledger.record({ kind: "dotenvxKeysFile", path: keysPath });
  ledger.record({ kind: "keychain", account: "hatchkit:test:dummy" });
  ledger.record({ kind: "manifest", path: manifestPath });
  ledger.record({ kind: "gitInit", path: gitDir });
  ledger.record({ kind: "github", repo: "owner/test-repo" });
  ledger.record({ kind: "scaffoldedFile", path: dockerfilePath });
  ledger.record({ kind: "coolifyApp", uuid: "fake-app-uuid" });
  ledger.record({ kind: "coolifyProject", uuid: "fake-proj-uuid" });
  ledger.record({
    kind: "cloudflareDnsRecord",
    zoneId: "zone1",
    recordId: "rec1",
    name: "x.example.com",
    type: "A",
  });
  ledger.record({ kind: "glitchtip", project: "test-glitch" });
  ledger.record({ kind: "openpanel", project: "test-op" });
  ledger.record({ kind: "plausible", project: "test-plausible" });
  ledger.record({
    kind: "listmonkList",
    listmonkUrl: "https://listmonk.example.com",
    listName: "test-listmonk",
    listId: 1,
  });

  const checks: Check[] = [];
  // 1. Recipe printer handles every kind without throwing.
  let recipeOk = true;
  try {
    printRecipe(ledger);
  } catch (e) {
    recipeOk = false;
    console.log(`    recipe threw: ${(e as Error).message}`);
  }
  checks.push(["printRecipe handles every adopt kind", recipeOk]);

  // 2. File-system undos only delete the path they reference. We
  //    rebuild the ledger as just the local-only kinds and call
  //    runRollback with --yes to skip prompts. The keychain step is
  //    safe to run because the account doesn't exist.
  const { runRollback } = await import("./src/deploy/rollback.js");
  const fsLedger = RunLedger.start("adopt-fs-undo-test");
  fsLedger.record({ kind: "manifest", path: manifestPath });
  fsLedger.record({ kind: "dotenvxKeysFile", path: keysPath });
  fsLedger.record({ kind: "scaffoldedFile", path: dockerfilePath });
  fsLedger.record({ kind: "gitInit", path: gitDir });
  // Sentinel file outside the recorded paths — if undo touches anything
  // other than what's recorded, this disappears.
  const sentinelPath = join(tmp, "DO-NOT-DELETE.txt");
  writeFileSync(sentinelPath, "sentinel");

  let undoThrew = false;
  try {
    await runRollback(fsLedger, { yes: true });
  } catch (e) {
    undoThrew = true;
    console.log(`    runRollback threw: ${(e as Error).message}`);
  }
  checks.push(["runRollback with adopt-only kinds doesn't throw", !undoThrew]);
  checks.push(["manifest deleted by undo", !existsSync(manifestPath)]);
  checks.push(["dotenvxKeysFile deleted by undo", !existsSync(keysPath)]);
  checks.push(["scaffoldedFile deleted by undo", !existsSync(dockerfilePath)]);
  checks.push(["gitInit dir deleted by undo", !existsSync(gitDir)]);
  // The CRITICAL safety check: nothing outside the ledger paths.
  checks.push(["sentinel outside ledger paths NOT touched", existsSync(sentinelPath)]);
  // The tmp dir itself must still exist — undo never goes wider than recorded.
  checks.push(["tmp project dir NOT touched (no rm -rf of project root)", existsSync(tmp)]);

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.adoptLedgerSafety = ok;
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n── existing-dir guard ─────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "scaffold-existing-guard-"));
  try {
    // Put a file in the target to simulate a non-empty dir.
    writeFileSync(join(d, "marker.txt"), "existing");
    let threw = false;
    try {
      await scaffoldApp(cfg("guard-test", []), d);
    } catch (err) {
      threw = err instanceof Error && err.message.includes("already exists");
    }
    console.log(`  ${threw ? "✓" : "✗"} throws on non-empty output dir`);
    results.existingDirGuard = threw;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// Adopt leak regression: against a fresh git repo with NO `.gitignore`
// (or one that doesn't cover `.env.keys`), generating the dotenvx keypair
// must NOT result in `.env.keys` being staged or committed. Reproduces
// the real-world incident where `.env.keys` was pushed to a public repo.
console.log("\n── adopt: .env.keys is gitignored, never staged ─────────────────────────────");
{
  const { execa } = await import("execa");
  const { ensureGitignoreEntries, looksLikeDotenvxPrivateKey } = await import(
    "./src/utils/gitignore.js"
  );
  const checks: Check[] = [];

  // Scenario A: pre-existing .gitignore that covers .env / .env.local / .env.*.local
  // (the actual incident shape) but NOT .env.keys.
  const repoA = mkdtempSync(join(tmpdir(), "adopt-leak-existing-ignore-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: repoA });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: repoA });
  await execa("git", ["config", "user.name", "test"], { cwd: repoA });
  writeFileSync(
    join(repoA, ".gitignore"),
    "# pre-existing entries (no trailing newline)\n.env\n.env.local\n.env.*.local",
  );
  writeFileSync(join(repoA, "package.json"), JSON.stringify({ name: "leak-test" }));

  // Run the same call adopt's bootstrapDotenvxNow makes BEFORE writing
  // .env.keys, then drop a realistic .env.keys file.
  const r = ensureGitignoreEntries(repoA, [".env.keys"]);
  writeFileSync(
    join(repoA, ".env.keys"),
    `#/!!!!!!!!!!!!!!!!!!!.env.keys!!!!!!!!!!!!!!!!!!!!!!/
#/   DOTENV_PRIVATE_KEYS: DO NOT commit to source control   /
#/!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!/
DOTENV_PRIVATE_KEY_PRODUCTION="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
`,
  );
  await execa("git", ["add", "-A"], { cwd: repoA });
  const stagedA = (await execa("git", ["diff", "--cached", "--name-only"], { cwd: repoA })).stdout
    .split("\n")
    .filter(Boolean);
  await execa("git", ["commit", "-m", "Adopt under hatchkit management"], { cwd: repoA });
  const commitFiles = (await execa("git", ["show", "--name-only", "--pretty=", "HEAD"], { cwd: repoA })).stdout
    .split("\n")
    .filter(Boolean);
  // Confirm `git check-ignore` sees the file as ignored.
  const checkIgnore = await execa("git", ["check-ignore", "-v", ".env.keys"], {
    cwd: repoA,
    reject: false,
  });

  checks.push(["A: ensureGitignoreEntries appended .env.keys", r.added.includes(".env.keys")]);
  checks.push(["A: existing .gitignore preserved (still has .env entry)", readFileSync(join(repoA, ".gitignore"), "utf-8").includes(".env\n")]);
  checks.push([".env.keys NOT in staged files", !stagedA.includes(".env.keys")]);
  checks.push([".env.keys NOT in resulting commit", !commitFiles.includes(".env.keys")]);
  checks.push([".gitignore IS in the commit (carries the new rule)", commitFiles.includes(".gitignore")]);
  checks.push(["package.json IS in the commit (sanity)", commitFiles.includes("package.json")]);
  checks.push(["git check-ignore reports .env.keys as ignored", checkIgnore.exitCode === 0]);

  // Scenario B: NO .gitignore at all. ensureGitignoreEntries must create one.
  const repoB = mkdtempSync(join(tmpdir(), "adopt-leak-no-ignore-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: repoB });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: repoB });
  await execa("git", ["config", "user.name", "test"], { cwd: repoB });
  writeFileSync(join(repoB, "package.json"), JSON.stringify({ name: "leak-test" }));
  const rB = ensureGitignoreEntries(repoB, [".env.keys"]);
  writeFileSync(join(repoB, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="aabbcc"\n`);
  await execa("git", ["add", "-A"], { cwd: repoB });
  const stagedB = (await execa("git", ["diff", "--cached", "--name-only"], { cwd: repoB })).stdout
    .split("\n")
    .filter(Boolean);

  checks.push(["B: .gitignore was created from scratch", rB.fileCreated]);
  checks.push(["B: .env.keys NOT in staged files", !stagedB.includes(".env.keys")]);
  checks.push(["B: .gitignore IS in staged files", stagedB.includes(".gitignore")]);

  // Scenario C: defensive guard — looksLikeDotenvxPrivateKey identifies
  // the danger file but NOT a normal encrypted .env.production (which
  // contains DOTENV_PUBLIC_KEY_PRODUCTION, NOT DOTENV_PRIVATE_KEY).
  const repoC = mkdtempSync(join(tmpdir(), "adopt-leak-guard-"));
  writeFileSync(
    join(repoC, ".env.keys"),
    `#/   DOTENV_PRIVATE_KEYS: DO NOT commit to source control   /
DOTENV_PRIVATE_KEY_PRODUCTION="dead"
`,
  );
  writeFileSync(
    join(repoC, ".env.production"),
    `#/!!!!!!!!!!!!!!!!!!!.env.production!!!!!!!!!!!!!!!!!!!!!/
DOTENV_PUBLIC_KEY_PRODUCTION="beef"
STRIPE_SECRET_KEY="encrypted:abc"
`,
  );
  writeFileSync(join(repoC, "README.md"), "# project\n");
  checks.push([
    "C: guard flags .env.keys",
    looksLikeDotenvxPrivateKey(join(repoC, ".env.keys")),
  ]);
  checks.push([
    "C: guard does NOT flag encrypted .env.production (only public key in header)",
    !looksLikeDotenvxPrivateKey(join(repoC, ".env.production")),
  ]);
  checks.push([
    "C: guard does NOT flag README",
    !looksLikeDotenvxPrivateKey(join(repoC, "README.md")),
  ]);
  checks.push([
    "C: guard returns false on missing file",
    !looksLikeDotenvxPrivateKey(join(repoC, "does-not-exist")),
  ]);

  // Scenario D: idempotency — running ensureGitignoreEntries twice
  // doesn't duplicate the line, and detects the entry whether written
  // bare (`.env.keys`), with leading slash (`/.env.keys`), or as a
  // comment-stripped match.
  const repoD = mkdtempSync(join(tmpdir(), "adopt-leak-idempotent-"));
  writeFileSync(join(repoD, ".gitignore"), "/.env.keys\n");
  const rD = ensureGitignoreEntries(repoD, [".env.keys"]);
  checks.push(["D: detects /.env.keys as already-present", rD.alreadyPresent.includes(".env.keys")]);
  checks.push(["D: did not append duplicate entry", rD.added.length === 0]);

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.adoptLeakRegression = ok;

  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
  rmSync(repoC, { recursive: true, force: true });
  rmSync(repoD, { recursive: true, force: true });
}

// keys set / rotate: round-trip the dotenvx private key through the
// keychain. Uses the throwaway HATCHKIT_KEYTAR_SERVICE so writes don't
// bleed into the developer's real keychain.
console.log("\n── keys set: keychain round-trip ─────────────────────────────");
{
  const {
    setProjectKey,
    locateEnvKeysFile,
    locateEnvProductionFile,
    parsePrivateKeyValue,
    parseEnvKeysEntries,
    readPublicKey,
    rotateProjectKey,
  } = await import("./src/deploy/keys.js");
  const { getSecret, deleteSecret, SECRET_KEYS } = await import("./src/utils/secrets.js");
  const { set: dotenvxSet } = await import("@dotenvx/dotenvx");

  const checks: Check[] = [];

  // 1. Direct --key flag → keychain.
  const directKey = "a".repeat(64);
  const r1 = await setProjectKey("kt-direct", { key: directKey });
  const got1 = await getSecret(SECRET_KEYS.dotenvxPrivateKey("kt-direct"));
  checks.push(["set --key writes to keychain", got1 === directKey]);
  checks.push(["set --key reports source=flag", r1.source === "flag"]);
  checks.push(["set --key reports written=true on first write", r1.written]);
  checks.push(["set --key reports changed=true on first write", r1.changed]);

  // 2. Idempotency — same value, no write, no change.
  const r2 = await setProjectKey("kt-direct", { key: directKey });
  checks.push(["set --key idempotent: changed=false on no-op", !r2.changed]);
  checks.push(["set --key idempotent: written=false on no-op", !r2.written]);

  // 3. Dry-run reports changed=true but written=false.
  const newKey = "b".repeat(64);
  const r3 = await setProjectKey("kt-direct", { key: newKey, dryRun: true });
  const stillOld = await getSecret(SECRET_KEYS.dotenvxPrivateKey("kt-direct"));
  checks.push(["set --dry-run reports changed=true", r3.changed]);
  checks.push(["set --dry-run reports written=false", !r3.written]);
  checks.push(["set --dry-run did NOT write to keychain", stillOld === directKey]);

  // 4. Rejects garbage. Plain text isn't a hex key.
  let threwGarbage = false;
  try {
    await setProjectKey("kt-direct", { key: "not-a-key" });
  } catch {
    threwGarbage = true;
  }
  checks.push(["set rejects non-hex value", threwGarbage]);

  // 5. From .env.keys autoread (root layout).
  const projRoot = mkdtempSync(join(tmpdir(), "kt-set-root-"));
  const rootKey = "c".repeat(64);
  writeFileSync(join(projRoot, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${rootKey}"\n`);
  const r5 = await setProjectKey("kt-from-root", { projectDir: projRoot });
  const got5 = await getSecret(SECRET_KEYS.dotenvxPrivateKey("kt-from-root"));
  checks.push(["set autoreads .env.keys at project root", got5 === rootKey]);
  checks.push([
    "set reports envKeysPath when source=env-keys",
    r5.envKeysPath === join(projRoot, ".env.keys"),
  ]);
  rmSync(projRoot, { recursive: true, force: true });

  // 6. From .env.keys autoread (packages/server layout — same as adopt).
  const projMono = mkdtempSync(join(tmpdir(), "kt-set-mono-"));
  const monoKey = "d".repeat(64);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(projMono, "packages/server"), { recursive: true });
  writeFileSync(
    join(projMono, "packages/server/.env.keys"),
    `DOTENV_PRIVATE_KEY_PRODUCTION="${monoKey}"\n`,
  );
  await setProjectKey("kt-from-mono", { projectDir: projMono });
  const got6 = await getSecret(SECRET_KEYS.dotenvxPrivateKey("kt-from-mono"));
  checks.push(["set autoreads packages/server/.env.keys", got6 === monoKey]);
  checks.push([
    "locateEnvKeysFile prefers packages/server over root",
    locateEnvKeysFile(projMono) === join(projMono, "packages/server/.env.keys"),
  ]);
  rmSync(projMono, { recursive: true, force: true });

  // 7. parsePrivateKeyValue handles quoted + unquoted lines + comments.
  checks.push([
    "parsePrivateKeyValue handles quoted",
    parsePrivateKeyValue('DOTENV_PRIVATE_KEY_PRODUCTION="abc123"') === "abc123",
  ]);
  checks.push([
    "parsePrivateKeyValue handles unquoted",
    parsePrivateKeyValue("DOTENV_PRIVATE_KEY_PRODUCTION=abc123") === "abc123",
  ]);
  checks.push([
    "parsePrivateKeyValue ignores DOTENV_PRIVATE_KEY (no env suffix)",
    parsePrivateKeyValue('DOTENV_PRIVATE_KEY="abc123"\n') === undefined,
  ]);
  checks.push([
    "parsePrivateKeyValue picks the production line out of mixed file",
    parsePrivateKeyValue(
      `# header comment\nDOTENV_PRIVATE_KEY="aaaa1111"\nDOTENV_PRIVATE_KEY_PRODUCTION="bbbb2222"\n`,
    ) === "bbbb2222",
  ]);
  // dotenvx itself appends new keys to the end of a comma list on
  // each rotate, so historical .env.keys files can carry stale
  // entries. `parsePrivateKeyValue` returns the LAST entry (the
  // current key) — `keys rotate` then prunes the on-disk list back
  // to one. Older single-entry files are unaffected.
  checks.push([
    "parsePrivateKeyValue returns last entry of comma-joined list",
    parsePrivateKeyValue(`DOTENV_PRIVATE_KEY_PRODUCTION=${"a".repeat(64)},${"b".repeat(64)}`) ===
      "b".repeat(64),
  ]);

  // 8. End-to-end rotate: seed an encrypted .env.production via the
  //    real dotenvx call (matching what scaffoldDotenvx does), set the
  //    keychain to the initial key, then run rotateProjectKey and
  //    assert the keychain holds the NEW key (different from initial).
  const rotProj = mkdtempSync(join(tmpdir(), "kt-rotate-"));
  // Seed an encrypted .env.production at root with one value.
  const prodPath = join(rotProj, ".env.production");
  dotenvxSet("FOO", "bar", { path: prodPath, encrypt: true });
  const initialKeyMatch = parsePrivateKeyValue(
    readFileSync(join(rotProj, ".env.keys"), "utf-8"),
  );
  // Mirror the initial key into the keychain so rotate can verify it
  // changed afterwards.
  await setProjectKey("kt-rotate", { projectDir: rotProj });
  const beforeKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey("kt-rotate"));
  checks.push([
    "rotate setup: keychain primed with initial key",
    beforeKey === initialKeyMatch,
  ]);

  // dryRun first — no rotation, no keychain change.
  const dry = await rotateProjectKey("kt-rotate", { projectDir: rotProj, dryRun: true });
  const afterDryKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey("kt-rotate"));
  checks.push(["rotate --dry-run: rotated=false", !dry.rotated]);
  checks.push(["rotate --dry-run: keychain unchanged", afterDryKey === beforeKey]);

  // Real rotate. dotenvx generates a new keypair → keychain must hold
  // the new value, NOT the old one. `noPush: true` keeps the test
  // offline; the propagation paths are covered by test-keys-rotate.ts
  // with injected stubs.
  const rot = await rotateProjectKey("kt-rotate", { projectDir: rotProj, noPush: true });
  const newFileKey = parsePrivateKeyValue(readFileSync(join(rotProj, ".env.keys"), "utf-8"));
  const afterKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey("kt-rotate"));
  checks.push(["rotate: rotated=true", rot.rotated]);
  checks.push(["rotate: produced a new key (different from initial)", newFileKey !== beforeKey]);
  checks.push(["rotate: keychain updated to new key", afterKey === newFileKey]);
  checks.push(["rotate: set.changed=true (key actually rotated)", rot.set.changed]);
  checks.push(["rotate: set.written=true", rot.set.written]);
  checks.push([
    "rotate: locateEnvProductionFile finds the seeded file",
    locateEnvProductionFile(rotProj) === prodPath,
  ]);
  checks.push([
    "rotate: .env.keys pruned to a single entry",
    (parseEnvKeysEntries(readFileSync(join(rotProj, ".env.keys"), "utf-8")) ?? []).length === 1,
  ]);
  checks.push([
    "rotate: result.newPublicKey matches .env.production",
    rot.newPublicKey === readPublicKey(prodPath),
  ]);
  rmSync(rotProj, { recursive: true, force: true });

  // Cleanup the throwaway keychain entries from this test block.
  await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("kt-direct"));
  await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("kt-from-root"));
  await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("kt-from-mono"));
  await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("kt-rotate"));

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.keysSetRotate = ok;
}

// doctor: project-local key-state checks. Asserts the new tracked-by-git
// detection AND the keychain-vs-file drift detection, scoped to a
// fixture project so doctor's global checks don't interfere.
console.log("\n── doctor: project key-state checks ─────────────────────────────");
{
  const { execa } = await import("execa");
  const { checkProjectKeyState } = await import("./src/doctor.js");
  const { setSecret, deleteSecret, SECRET_KEYS } = await import("./src/utils/secrets.js");

  const checks: Check[] = [];

  // Scenario 1: no .hatchkit.json → no checks emitted.
  const tmpA = mkdtempSync(join(tmpdir(), "doctor-no-manifest-"));
  const noManifest = await checkProjectKeyState(tmpA);
  checks.push(["no manifest → empty result (skip silently)", noManifest.length === 0]);
  rmSync(tmpA, { recursive: true, force: true });

  // Scenario 2: manifest + .env.keys + matching keychain → all OK.
  const tmpB = mkdtempSync(join(tmpdir(), "doctor-healthy-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: tmpB });
  await execa("git", ["config", "user.email", "t@t"], { cwd: tmpB });
  await execa("git", ["config", "user.name", "t"], { cwd: tmpB });
  writeFileSync(join(tmpB, ".gitignore"), ".env.keys\n");
  writeFileSync(join(tmpB, ".hatchkit.json"), JSON.stringify({ name: "doc-healthy" }));
  const healthyKey = "f".repeat(64);
  writeFileSync(join(tmpB, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${healthyKey}"\n`);
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("doc-healthy"), healthyKey);

  const healthy = await checkProjectKeyState(tmpB);
  checks.push([
    "healthy: hygiene check status=ok",
    healthy.find((r) => r.name.includes("hygiene"))?.status === "ok",
  ]);
  checks.push([
    "healthy: keychain sync status=ok",
    healthy.find((r) => r.name.includes("keychain sync"))?.status === "ok",
  ]);
  await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("doc-healthy"));
  rmSync(tmpB, { recursive: true, force: true });

  // Scenario 3: .env.keys is tracked by git → leak check fails.
  const tmpC = mkdtempSync(join(tmpdir(), "doctor-leak-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: tmpC });
  await execa("git", ["config", "user.email", "t@t"], { cwd: tmpC });
  await execa("git", ["config", "user.name", "t"], { cwd: tmpC });
  writeFileSync(join(tmpC, ".hatchkit.json"), JSON.stringify({ name: "doc-leak" }));
  const leakKey = "9".repeat(64);
  writeFileSync(join(tmpC, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${leakKey}"\n`);
  // Force-add (no .gitignore yet) and commit so it lands in the index.
  await execa("git", ["add", "-f", ".env.keys"], { cwd: tmpC });
  await execa("git", ["commit", "-m", "leak"], { cwd: tmpC });
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("doc-leak"), leakKey);

  const leaked = await checkProjectKeyState(tmpC);
  const leakResult = leaked.find((r) => r.name.includes("leak"));
  checks.push(["tracked .env.keys: status=fail", leakResult?.status === "fail"]);
  checks.push([
    "tracked .env.keys: hint mentions `keys rotate`",
    !!leakResult?.hint?.some((h) => h.includes("hatchkit keys rotate")),
  ]);
  await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("doc-leak"));
  rmSync(tmpC, { recursive: true, force: true });

  // Scenario 4: .env.keys differs from keychain (post-rotate, pre-set).
  const tmpD = mkdtempSync(join(tmpdir(), "doctor-drift-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: tmpD });
  await execa("git", ["config", "user.email", "t@t"], { cwd: tmpD });
  await execa("git", ["config", "user.name", "t"], { cwd: tmpD });
  writeFileSync(join(tmpD, ".gitignore"), ".env.keys\n");
  writeFileSync(join(tmpD, ".hatchkit.json"), JSON.stringify({ name: "doc-drift" }));
  writeFileSync(join(tmpD, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${"e".repeat(64)}"\n`);
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("doc-drift"), "1".repeat(64));

  const drift = await checkProjectKeyState(tmpD);
  // Project name contains "drift" too — match on the suffix label.
  const driftResult = drift.find((r) => r.name.includes("(keychain drift)"));
  checks.push(["keychain drift: status=fail", driftResult?.status === "fail"]);
  checks.push([
    "keychain drift: hint mentions `keys set`",
    !!driftResult?.hint?.some((h) => h.includes("hatchkit keys set")),
  ]);
  await deleteSecret(SECRET_KEYS.dotenvxPrivateKey("doc-drift"));
  rmSync(tmpD, { recursive: true, force: true });

  // Scenario 5: .env.keys present, keychain empty (post-`config reset`).
  const tmpE = mkdtempSync(join(tmpdir(), "doctor-no-keychain-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: tmpE });
  await execa("git", ["config", "user.email", "t@t"], { cwd: tmpE });
  await execa("git", ["config", "user.name", "t"], { cwd: tmpE });
  writeFileSync(join(tmpE, ".gitignore"), ".env.keys\n");
  writeFileSync(join(tmpE, ".hatchkit.json"), JSON.stringify({ name: "doc-empty" }));
  writeFileSync(join(tmpE, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${"7".repeat(64)}"\n`);

  const noKc = await checkProjectKeyState(tmpE);
  const noKcResult = noKc.find((r) => r.name.includes("drift"));
  checks.push(["missing keychain entry: status=fail", noKcResult?.status === "fail"]);
  checks.push([
    "missing keychain entry: detail mentions missing",
    !!noKcResult?.detail?.includes("missing"),
  ]);
  rmSync(tmpE, { recursive: true, force: true });

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.doctorKeyChecks = ok;
}

// doctor's production-env model check. Two independent failures used to
// pass silently, and both are reproduced here with a real git repo:
//   · a GLOBAL ignore (core.excludesFile) dropping `.env.production`,
//     which a repo .gitignore only beats with an explicit `!` negation —
//     omitting the file is not enough;
//   · a Dockerfile still shipping the encrypted file into its RUNTIME
//     stage, which is the other env model and drifts against Coolify.
console.log("\n── doctor: production env model ─────────────────────────────");
{
  const { execa } = await import("execa");
  const { checkProjectProdEnvState } = await import("./src/doctor.js");
  const checks: Check[] = [];

  /** Spin up a throwaway repo with a global excludes file that lists
   *  `.env.production`, mirroring the ~/.config/git/ignore most machines
   *  actually carry. */
  const makeRepo = async (label: string, gitignore: string) => {
    const dir = mkdtempSync(join(tmpdir(), `doctor-prodenv-${label}-`));
    await execa("git", ["init", "--initial-branch=main"], { cwd: dir });
    await execa("git", ["config", "user.email", "t@t"], { cwd: dir });
    await execa("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "globalignore"), ".env.production\n.env.development\n");
    await execa("git", ["config", "core.excludesFile", join(dir, "globalignore")], { cwd: dir });
    writeFileSync(join(dir, ".hatchkit.json"), JSON.stringify({ name: `pe-${label}` }));
    writeFileSync(join(dir, ".gitignore"), gitignore);
    mkdirSync(join(dir, "packages", "server"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "server", ".env.production"),
      'BETTER_AUTH_SECRET="encrypted:abc"\n',
    );
    return dir;
  };

  // Scenario 1: no negation → the global ignore silently wins.
  const tmpA = await makeRepo("global", ".env\n.env.keys\n");
  const resA = await checkProjectProdEnvState(tmpA);
  const failA = resA.find((r) => r.name.includes("not committed"));
  checks.push(["global ignore: status=fail", failA?.status === "fail"]);
  checks.push([
    "global ignore: detail names the offending ignore file",
    !!failA?.detail?.includes("globalignore"),
  ]);
  checks.push([
    "global ignore: hint offers the `!` negation",
    !!failA?.hint?.some((h) => h.includes("!.env.production")),
  ]);
  rmSync(tmpA, { recursive: true, force: true });

  // Scenario 2: negation present AND committed → clean.
  const tmpB = await makeRepo("ok", ".env\n.env.keys\n!.env.production\n");
  await execa("git", ["add", "-A"], { cwd: tmpB });
  await execa("git", ["commit", "-m", "init"], { cwd: tmpB });
  const resB = await checkProjectProdEnvState(tmpB);
  checks.push([
    "negation + committed: status=ok",
    resB.find((r) => r.name.includes("tracked"))?.status === "ok",
  ]);
  checks.push([
    "negation + committed: no mismatch reported",
    !resB.some((r) => r.name.includes("mismatch")),
  ]);
  rmSync(tmpB, { recursive: true, force: true });

  // Scenario 3: negation present but the file was never `git add`ed.
  // `git check-ignore -v` exits 0 here and prints the NEGATED pattern,
  // so a naive reading reports "ignored by !.env.production" and tells
  // the user to apply a fix they already have. It must not.
  const tmpC = await makeRepo("unadded", ".env\n.env.keys\n!.env.production\n");
  const resC = await checkProjectProdEnvState(tmpC);
  const failC = resC.find((r) => r.name.includes("not committed"));
  checks.push(["negation, unadded: status=fail", failC?.status === "fail"]);
  checks.push([
    "negation, unadded: not blamed on an ignore rule",
    !!failC?.detail?.includes("not tracked by git") && !failC.detail.includes("git-ignored"),
  ]);
  rmSync(tmpC, { recursive: true, force: true });

  // Scenario 4: runtime stage ships the encrypted file → model mismatch.
  const tmpD = await makeRepo("shipped", ".env\n.env.keys\n!.env.production\n");
  writeFileSync(
    join(tmpD, "packages", "server", "Dockerfile"),
    [
      "FROM node:24 AS build",
      "COPY . .",
      "FROM node:24 AS runtime",
      "COPY --from=build /prod/dist ./dist",
      "COPY packages/server/.env.production ./.env.production",
      'CMD ["node", "dist/index.js"]',
    ].join("\n"),
  );
  const resD = await checkProjectProdEnvState(tmpD);
  const mismatchD = resD.find((r) => r.name.includes("mismatch"));
  checks.push(["runtime COPY: status=fail", mismatchD?.status === "fail"]);
  checks.push([
    "runtime COPY: hint points at `hatchkit sync`",
    !!mismatchD?.hint?.some((h) => h.includes("hatchkit sync")),
  ]);
  rmSync(tmpD, { recursive: true, force: true });

  // Scenario 5: only a BUILD stage copies it. That layer is discarded,
  // so nothing ships and there is nothing to report.
  const tmpE = await makeRepo("buildonly", ".env\n.env.keys\n!.env.production\n");
  writeFileSync(
    join(tmpE, "packages", "server", "Dockerfile"),
    [
      "FROM node:24 AS build",
      "COPY packages/server/.env.production ./.env.production",
      "RUN node scripts/migrate.js",
      "FROM node:24 AS runtime",
      "COPY --from=build /prod/dist ./dist",
      'CMD ["node", "dist/index.js"]',
    ].join("\n"),
  );
  const resE = await checkProjectProdEnvState(tmpE);
  checks.push([
    "build-stage-only COPY: no mismatch reported",
    !resE.some((r) => r.name.includes("mismatch")),
  ]);
  rmSync(tmpE, { recursive: true, force: true });

  // Scenario 6: no `.env.production` at all. A project holding every
  // value directly in Coolify is legitimate — stay silent, don't nag.
  const tmpF = mkdtempSync(join(tmpdir(), "doctor-prodenv-none-"));
  writeFileSync(join(tmpF, ".hatchkit.json"), JSON.stringify({ name: "pe-none" }));
  const resF = await checkProjectProdEnvState(tmpF);
  checks.push(["no .env.production: silent", resF.length === 0]);
  rmSync(tmpF, { recursive: true, force: true });

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.doctorProdEnvChecks = ok;
}

// Adopt's first line of defence against leaking dotenvx private keys.
// Locks down two helpers in cli/src/utils/gitignore.ts:
//   · ensureGitignoreEntries — append `.env.keys` before bootstrapDotenvxNow
//     writes it, so the next `git add -A` doesn't sweep the key into a commit.
//   · looksLikeDotenvxPrivateKey — last-mile staged-file scan in
//     setupGitHubRemote that refuses to commit anything that smells like a key.
console.log("\n── adopt: gitignore + private-key guard ─────────────────────────────");
{
  const { ensureGitignoreEntries, looksLikeDotenvxPrivateKey } = await import(
    "./src/utils/gitignore.js"
  );
  const checks: Check[] = [];

  // Case 1: no .gitignore at all → file gets created with the entry.
  const tmpA = mkdtempSync(join(tmpdir(), "gi-fresh-"));
  try {
    const r = ensureGitignoreEntries(tmpA, [".env.keys"]);
    const written = readFileSync(join(tmpA, ".gitignore"), "utf-8");
    checks.push(["fresh repo: .gitignore created", r.fileCreated === true]);
    checks.push(["fresh repo: .env.keys reported as added", r.added.includes(".env.keys")]);
    checks.push(["fresh repo: file actually contains .env.keys", /^\.env\.keys$/m.test(written)]);
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
  }

  // Case 2: existing .gitignore missing the entry → appended without
  // disturbing the user's existing lines.
  const tmpB = mkdtempSync(join(tmpdir(), "gi-append-"));
  try {
    const before = "node_modules/\ndist/\n";
    writeFileSync(join(tmpB, ".gitignore"), before);
    const r = ensureGitignoreEntries(tmpB, [".env.keys"]);
    const after = readFileSync(join(tmpB, ".gitignore"), "utf-8");
    checks.push(["existing file: not re-created", r.fileCreated === false]);
    checks.push(["existing file: .env.keys appended", r.added.includes(".env.keys")]);
    checks.push(["existing file: original lines preserved", after.startsWith(before)]);
    checks.push(["existing file: now contains .env.keys", /^\.env\.keys$/m.test(after)]);
  } finally {
    rmSync(tmpB, { recursive: true, force: true });
  }

  // Case 3: entry already present → no-op (idempotent), file untouched.
  const tmpC = mkdtempSync(join(tmpdir(), "gi-noop-"));
  try {
    const before = "node_modules/\n.env.keys\n";
    writeFileSync(join(tmpC, ".gitignore"), before);
    const r = ensureGitignoreEntries(tmpC, [".env.keys"]);
    const after = readFileSync(join(tmpC, ".gitignore"), "utf-8");
    checks.push(["idempotent: nothing added", r.added.length === 0]);
    checks.push(["idempotent: reported as alreadyPresent", r.alreadyPresent.includes(".env.keys")]);
    checks.push(["idempotent: file content unchanged", after === before]);
  } finally {
    rmSync(tmpC, { recursive: true, force: true });
  }

  // Case 4: leading-slash variant `/.env.keys` is recognized as the same
  // pattern. Without normalization we'd duplicate the entry on every run.
  const tmpD = mkdtempSync(join(tmpdir(), "gi-slash-"));
  try {
    writeFileSync(join(tmpD, ".gitignore"), "/.env.keys\n");
    const r = ensureGitignoreEntries(tmpD, [".env.keys"]);
    checks.push(["leading-slash variant counts as present", r.added.length === 0]);
    checks.push([
      "leading-slash variant: alreadyPresent populated",
      r.alreadyPresent.includes(".env.keys"),
    ]);
  } finally {
    rmSync(tmpD, { recursive: true, force: true });
  }

  // Case 5: looksLikeDotenvxPrivateKey — flags a real `.env.keys` shape.
  const tmpE = mkdtempSync(join(tmpdir(), "gi-detect-"));
  try {
    const keysFile = join(tmpE, ".env.keys");
    writeFileSync(
      keysFile,
      `#-------------------------dotenvx-keys----------------\nDOTENV_PRIVATE_KEY_PRODUCTION="${"a".repeat(
        64,
      )}"\n`,
    );
    checks.push([".env.keys content flagged as private key", looksLikeDotenvxPrivateKey(keysFile)]);

    // Encrypted .env.production has DOTENV_PUBLIC_KEY but NOT
    // DOTENV_PRIVATE_KEY — must NOT be flagged or we'd refuse to
    // commit the file we explicitly want shipped with the repo.
    const prodFile = join(tmpE, ".env.production");
    writeFileSync(
      prodFile,
      `#-------------------------dotenvx-keys----------------\nDOTENV_PUBLIC_KEY_PRODUCTION="${"b".repeat(
        64,
      )}"\nFOO="encrypted:abc"\n`,
    );
    checks.push([
      ".env.production (public-key only) NOT flagged",
      looksLikeDotenvxPrivateKey(prodFile) === false,
    ]);

    // Missing file shouldn't throw — guards in setupGitHubRemote rely
    // on this being safe to call against deleted/renamed staged paths.
    checks.push([
      "missing file: returns false (no throw)",
      looksLikeDotenvxPrivateKey(join(tmpE, "does-not-exist")) === false,
    ]);
  } finally {
    rmSync(tmpE, { recursive: true, force: true });
  }

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.gitignoreGuard = ok;
}

// adopt: unrecognised workspace layout detection — guards against the
// regression where adopt-on-self scaffolded a single-package Dockerfile
// for a pnpm workspace and the GH Actions build broke with "tsc: not
// found" because the root `pnpm install` had no workspace packages to
// install against. The fix: flag layouts with a workspace marker but
// no conventional server/client dir as `unknownWorkspaceLayout` and
// default `scaffoldBuildPipeline: false`.
{
  console.log("\n── adopt: unrecognised workspace layout ─────────────────────────────");
  const { detectProject } = await import("./src/adopt.js");
  const checks: Array<[string, boolean]> = [];

  // Scenario A: pnpm-workspace.yaml at root + no server/client dirs.
  // With the projectSubdir feature, detection now AUTO-PICKS the sole
  // standalone candidate as the deployable. To exercise the original
  // "we genuinely don't know" path, add a second sibling candidate so
  // the auto-pick bails out and parks the cursor for the stepper.
  const repoA = mkdtempSync(join(tmpdir(), "adopt-unknown-layout-"));
  writeFileSync(join(repoA, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(repoA, "pnpm-workspace.yaml"), 'packages:\n  - "cli"\n');
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(repoA, "cli"));
  writeFileSync(join(repoA, "cli/package.json"), JSON.stringify({ name: "x-cli" }));
  mkdirSync(join(repoA, "docs"));
  writeFileSync(join(repoA, "docs/package.json"), JSON.stringify({ name: "x-docs" }));
  writeFileSync(join(repoA, "docs/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repoA, "docs/.npmrc"), "ignore-workspace=true\n");
  // Second candidate keeps detection ambiguous — otherwise adopt now
  // auto-picks docs/ as the deployable (the desired new behavior for
  // the CLI + marketing-site case).
  mkdirSync(join(repoA, "site"));
  writeFileSync(join(repoA, "site/package.json"), JSON.stringify({ name: "x-site" }));
  writeFileSync(join(repoA, "site/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const stateA = await detectProject(repoA);
  checks.push(["A: projectSubdir undefined (ambiguous)", stateA.projectSubdir === undefined]);
  checks.push(["A: unknownWorkspaceLayout flagged", stateA.unknownWorkspaceLayout === true]);
  checks.push(["A: no serverDir matched", stateA.serverDir === undefined]);
  checks.push(["A: no clientDir matched", stateA.clientDir === undefined]);
  checks.push([
    "A: docs/ surfaced as standalone candidate",
    stateA.standaloneBuildCandidates.some((c) => c.dir.endsWith("/docs")),
  ]);
  checks.push([
    "A: site/ also surfaced as standalone candidate",
    stateA.standaloneBuildCandidates.some((c) => c.dir.endsWith("/site")),
  ]);
  checks.push([
    "A: ignore-workspace flag captured",
    stateA.standaloneBuildCandidates.find((c) => c.dir.endsWith("/docs"))?.hasIgnoreWorkspace ===
      true,
  ]);

  // Scenario A2: single-candidate variant — auto-pick site/, subdir
  // set, unknown-layout flag stays off.
  const repoA2 = mkdtempSync(join(tmpdir(), "adopt-auto-pick-"));
  writeFileSync(join(repoA2, "package.json"), JSON.stringify({ name: "cli-repo" }));
  mkdirSync(join(repoA2, "site"));
  writeFileSync(join(repoA2, "site/package.json"), JSON.stringify({ name: "marketing" }));
  writeFileSync(join(repoA2, "site/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repoA2, "site/.npmrc"), "ignore-workspace=true\n");
  const stateA2 = await detectProject(repoA2);
  checks.push(["A2: projectSubdir auto-picked to site", stateA2.projectSubdir === "site"]);
  checks.push(["A2: projectDir rebased into site", stateA2.projectDir.endsWith("/site")]);
  checks.push([
    "A2: unknownWorkspaceLayout off after auto-pick",
    stateA2.unknownWorkspaceLayout === false,
  ]);
  rmSync(repoA2, { recursive: true, force: true });

  // Scenario B: standard layout — `apps/web` exists, so detection
  // resolves a clientDir and the unknown-layout flag stays off even
  // with a workspace marker present.
  const repoB = mkdtempSync(join(tmpdir(), "adopt-standard-layout-"));
  writeFileSync(join(repoB, "package.json"), JSON.stringify({ name: "y" }));
  writeFileSync(join(repoB, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
  mkdirSync(join(repoB, "apps"));
  mkdirSync(join(repoB, "apps/web"));
  writeFileSync(join(repoB, "apps/web/package.json"), JSON.stringify({ name: "y-web" }));
  const stateB = await detectProject(repoB);
  checks.push([
    "B: standard layout → unknownWorkspaceLayout false",
    stateB.unknownWorkspaceLayout === false,
  ]);
  checks.push(["B: clientDir resolved to apps/web", stateB.clientDir?.endsWith("/apps/web") === true]);

  // Scenario C: no workspace marker — single-package layout stays
  // unflagged even when the standard dirs don't match.
  const repoC = mkdtempSync(join(tmpdir(), "adopt-single-package-"));
  writeFileSync(join(repoC, "package.json"), JSON.stringify({ name: "z" }));
  const stateC = await detectProject(repoC);
  checks.push([
    "C: single-package layout → unknownWorkspaceLayout false",
    stateC.unknownWorkspaceLayout === false,
  ]);

  // Scenario D: npm/yarn-style workspaces (workspaces field in root
  // package.json) — same as pnpm-workspace.yaml, should flag.
  const repoD = mkdtempSync(join(tmpdir(), "adopt-npm-workspaces-"));
  writeFileSync(
    join(repoD, "package.json"),
    JSON.stringify({ name: "w", workspaces: ["packages/*"] }),
  );
  const stateD = await detectProject(repoD);
  checks.push([
    "D: npm workspaces field → unknownWorkspaceLayout flagged",
    stateD.unknownWorkspaceLayout === true,
  ]);

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.adoptUnknownLayout = ok;

  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
  rmSync(repoC, { recursive: true, force: true });
  rmSync(repoD, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tailscale local-dev integration tests.
//
// All exercised via the same scaffoldApp / enableProjectLocalDev /
// disableProjectLocalDev surface real users hit. The throwaway
// HATCHKIT_DEV_CONFIG_DIR set at the top of this file isolates every
// fragment write from `~/.config/dev/projects/`, so re-runs don't
// accumulate stale state on the host.
// ---------------------------------------------------------------------------
{
  const devDir = process.env.HATCHKIT_DEV_CONFIG_DIR!;
  const fragmentDir = join(devDir, "projects");
  const { enableProjectLocalDev, disableProjectLocalDev } = await import("./src/dev-setup.js");
  // The `portsBusyAvoid` test upstream reserves almost the entire
  // server range (1000 ports minus 2) to exercise the busy-port skip.
  // Subsequent scaffolds inherit that registry and run out of free
  // server ports almost immediately. Clear the registry here so the
  // localDev cases — which exercise scaffoldApp — start with a clean
  // port pool. We're already isolated from the real user config via
  // HATCHKIT_CONF_DIR, so this only resets the throwaway store.
  const { removeUsedPorts, getUsedPorts } = await import("./src/config.js");
  removeUsedPorts(getUsedPorts());

  // Case 1: scaffold with localDev set writes a fragment at the client
  // dev port + drops docs/dev-setup.md + wraps next.config + adds the
  // plugin dep.
  results.localDevScaffold = await (async () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-localdev-"));
    const slug = `ld-${process.pid}`;
    try {
      console.log("\n── localDev: scaffold opt-in ──────────────────────");
      const result = await scaffoldApp(cfg(slug, [], { localDev: { slug } }), d);
      const fragmentPath = join(fragmentDir, `${slug}.caddy`);
      const fragment = existsSync(fragmentPath) ? readFileSync(fragmentPath, "utf-8") : "";
      const nextConfig = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
      const clientPkg = JSON.parse(
        readFileSync(join(d, "packages/client/package.json"), "utf-8"),
      );
      const checks: Check[] = [
        ["scaffold returns localDev info", result.localDev?.slug === slug],
        ["scaffold returns derived localDev domain", result.localDev?.domain === "local.example.com"],
        ["fragment exists at projects/<slug>.caddy", existsSync(fragmentPath)],
        [
          `fragment proxies the client dev port (${result.ports.client})`,
          fragment.includes(`reverse_proxy 127.0.0.1:${result.ports.client}`),
        ],
        [
          "fragment uses the slug for both matcher and host",
          fragment.includes(`@${slug} host ${slug}.local.example.com`),
        ],
        ["docs/dev-setup.md generated", existsSync(join(d, "docs/dev-setup.md"))],
        // @hatchkit/dev-plugin-next is ESM-only and Next loads next.config.ts
        // through a CJS loader, so a TOP-LEVEL import of it kills `next build`
        // with ERR_PACKAGE_PATH_NOT_EXPORTED before the config is ever read.
        // The wrapper must therefore be phase-gated and load the plugin via a
        // dynamic import that only runs during `next dev`.
        [
          "next.config has NO top-level @hatchkit/dev-plugin-next import",
          !/^\s*import\s*\{[^}]*withLocalDev[^}]*\}\s*from\s*["']@hatchkit\/dev-plugin-next["']/m.test(
            nextConfig,
          ),
        ],
        [
          "next.config imports PHASE_DEVELOPMENT_SERVER from next/constants",
          nextConfig.includes('import { PHASE_DEVELOPMENT_SERVER } from "next/constants";'),
        ],
        [
          "next.config default export is phase-gated",
          /export default async function hatchkitLocalDevConfig\(phase: string\)/.test(
            nextConfig,
          ) && nextConfig.includes("if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;"),
        ],
        [
          "next.config loads the plugin via dynamic import",
          nextConfig.includes('await import("@hatchkit/dev-plugin-next")'),
        ],
        [
          "next.config wraps with the project slug",
          nextConfig.includes(`withLocalDev(nextConfig, { slug: "${slug}" })`),
        ],
        [
          "next.config falls back when the plugin import throws",
          nextConfig.includes("} catch (error) {") &&
            nextConfig.includes("local-dev plugin unavailable"),
        ],
        // The load-bearing invariant: `next build` runs a non-dev phase, and
        // that branch must return BEFORE anything imports the plugin.
        [
          "non-dev phase returns before the dynamic import",
          nextConfig.indexOf("if (phase !== PHASE_DEVELOPMENT_SERVER) return") <
            nextConfig.indexOf('await import("@hatchkit/dev-plugin-next")'),
        ],
        [
          "@hatchkit/dev-plugin-next added to client deps",
          typeof clientPkg.dependencies?.["@hatchkit/dev-plugin-next"] === "string",
        ],
      ];
      let ok = true;
      for (const [n, c] of checks) {
        console.log(`  ${c ? "✓" : "✗"} ${n}`);
        if (!c) ok = false;
      }
      return ok;
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(join(fragmentDir, `${slug}.caddy`), { force: true });
    }
  })();

  // Case 2: server-only surface points the fragment at the server port.
  results.localDevServerOnly = await (async () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-localdev-srv-"));
    const slug = `ld-srv-${process.pid}`;
    try {
      console.log("\n── localDev: server-only points at server port ────");
      const result = await scaffoldApp(
        cfg(slug, [], { surfaces: "backend", localDev: { slug } }),
        d,
      );
      const fragmentPath = join(fragmentDir, `${slug}.caddy`);
      const fragment = existsSync(fragmentPath) ? readFileSync(fragmentPath, "utf-8") : "";
      const checks: Check[] = [
        ["fragment exists", existsSync(fragmentPath)],
        [
          `fragment proxies the server port (${result.ports.server}), not the client one`,
          fragment.includes(`reverse_proxy 127.0.0.1:${result.ports.server}`),
        ],
        // The server-only surface prunes packages/client, so there's no
        // next.config to wrap. enableProjectLocalDev should silently
        // skip the patch rather than throwing.
        [
          "no next.config to patch — silent skip",
          !existsSync(join(d, "packages/client/next.config.ts")),
        ],
      ];
      let ok = true;
      for (const [n, c] of checks) {
        console.log(`  ${c ? "✓" : "✗"} ${n}`);
        if (!c) ok = false;
      }
      return ok;
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(join(fragmentDir, `${slug}.caddy`), { force: true });
    }
  })();

  // Case 3: enable is idempotent — running it again on an already-wired
  // project shouldn't duplicate the import or re-add the dep.
  results.localDevReenableIdempotent = await (async () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-localdev-idem-"));
    const slug = `ld-idem-${process.pid}`;
    try {
      console.log("\n── localDev: idempotent re-enable ─────────────────");
      const first = await scaffoldApp(cfg(slug, [], { localDev: { slug } }), d);
      const devPort = first.ports.client;
      const second = await enableProjectLocalDev({ projectDir: d, slug, devPort });

      const nextConfig = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
      const withLocalDevCount = (nextConfig.match(/withLocalDev/g) ?? []).length;
      const dynamicImportCount = (
        nextConfig.match(/await import\("@hatchkit\/dev-plugin-next"\)/g) ?? []
      ).length;
      const phaseImportCount = (nextConfig.match(/from "next\/constants"/g) ?? []).length;
      const defaultExportCount = (nextConfig.match(/^export default /gm) ?? []).length;

      const checks: Check[] = [
        ["second enable reports fragment unchanged", second.wroteFragment === "unchanged"],
        ["second enable reports next.config already-wrapped", second.patchedConfig === "already-wrapped"],
        ["second enable reports package.json already-present", second.patchedPackageJson === "already-present"],
        // Two textual hits: the `const { withLocalDev } = await import(…)`
        // destructure + the call site. Three or more = duplicated wrapping.
        ["next.config has exactly one wrap site", withLocalDevCount === 2],
        ["next.config has exactly one dynamic plugin import", dynamicImportCount === 1],
        // The prepended `next/constants` import and the gated default export
        // must not be duplicated by a re-enable either.
        ["next.config has exactly one next/constants import", phaseImportCount === 1],
        ["next.config has exactly one default export", defaultExportCount === 1],
      ];
      let ok = true;
      for (const [n, c] of checks) {
        console.log(`  ${c ? "✓" : "✗"} ${n}`);
        if (!c) ok = false;
      }
      return ok;
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(join(fragmentDir, `${slug}.caddy`), { force: true });
    }
  })();

  // Case 4: disable removes the fragment + docs but leaves the
  // next.config wrapper + package.json dep in place.
  results.localDevDisableCleanup = await (async () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-localdev-dis-"));
    const slug = `ld-dis-${process.pid}`;
    try {
      console.log("\n── localDev: disable cleanup ──────────────────────");
      await scaffoldApp(cfg(slug, [], { localDev: { slug } }), d);
      const fragmentPath = join(fragmentDir, `${slug}.caddy`);
      const beforeFragment = existsSync(fragmentPath);
      const beforeDocs = existsSync(join(d, "docs/dev-setup.md"));

      const result = disableProjectLocalDev(d, slug);
      const nextConfig = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
      const clientPkg = JSON.parse(
        readFileSync(join(d, "packages/client/package.json"), "utf-8"),
      );

      const checks: Check[] = [
        ["fragment existed before disable", beforeFragment],
        ["docs existed before disable", beforeDocs],
        ["disable reports fragment removed", result.removedFragment],
        ["disable reports docs removed", result.removedDocs],
        ["fragment gone after disable", !existsSync(fragmentPath)],
        ["docs gone after disable", !existsSync(join(d, "docs/dev-setup.md"))],
        // Wrapper + dep stay — they're inert without a fragment and we
        // don't want to fight user edits on either file.
        ["next.config wrapper retained", nextConfig.includes("withLocalDev")],
        [
          "plugin dep retained in package.json",
          typeof clientPkg.dependencies?.["@hatchkit/dev-plugin-next"] === "string",
        ],
      ];
      let ok = true;
      for (const [n, c] of checks) {
        console.log(`  ${c ? "✓" : "✗"} ${n}`);
        if (!c) ok = false;
      }
      return ok;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  })();

  // Case 5: next.config patcher copes with hand-edited shapes.
  //   (a) inline `export default { … }` — must hoist into a const and wrap.
  //   (b) already imports something from @hatchkit/dev-plugin-next — leave alone.
  results.localDevNextConfigPatchShapes = await (async () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-localdev-shape-"));
    const slug = `ld-shape-${process.pid}`;
    try {
      console.log("\n── localDev: next.config patch handles hand-edits ──");
      // Build a real scaffold and replace the next.config with an inline
      // export expression — covers the hoist branch. Re-enable should
      // wrap cleanly without leaving the inline expression dangling.
      await scaffoldApp(cfg(slug, []), d);
      const nextPath = join(d, "packages/client/next.config.ts");
      writeFileSync(
        nextPath,
        `import type { NextConfig } from "next";\n\nexport default { reactStrictMode: true } satisfies NextConfig;\n`,
      );
      const inlineResult = await enableProjectLocalDev({
        projectDir: d,
        slug,
        devPort: 4321,
      });
      const inlineConfig = readFileSync(nextPath, "utf-8");

      // Now run enable AGAIN on the result — guard branch must keep
      // its hands off the file the second time around.
      const guardResult = await enableProjectLocalDev({
        projectDir: d,
        slug,
        devPort: 4321,
      });
      const guardedConfig = readFileSync(nextPath, "utf-8");

      const checks: Check[] = [
        ["inline-export shape patched", inlineResult.patchedConfig === "added"],
        // The hoisted const has to be referenced from all three branches of
        // the gated export (early return, wrapped return, catch fallback) —
        // four textual hits including the declaration itself. Re-evaluating
        // the inline expression per branch would be a silent behaviour change.
        [
          "hoisted into a const before wrapping",
          (inlineConfig.match(/__hatchkitLocalDevConfig/g) ?? []).length === 4 &&
            inlineConfig.includes(`withLocalDev(__hatchkitLocalDevConfig, { slug: "${slug}" })`),
        ],
        ["second enable detects existing wrap", guardResult.patchedConfig === "already-wrapped"],
        ["second enable left the file alone", inlineConfig === guardedConfig],
      ];
      let ok = true;
      for (const [n, c] of checks) {
        console.log(`  ${c ? "✓" : "✗"} ${n}`);
        if (!c) ok = false;
      }
      return ok;
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(join(fragmentDir, `${slug}.caddy`), { force: true });
    }
  })();

  // Case 6: `hatchkit update` retrofits an existing project that was
  // scaffolded before the local-dev integration landed. Stubs the
  // inquirer prompts so the test runs non-interactively, then verifies
  // the post-update manifest carries the localDev field and the
  // on-disk artifacts (fragment, docs, next.config wrapper) match the
  // scaffold-time shape.
  results.localDevUpdateRetrofit = await (async () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-localdev-upd-"));
    const slug = `ld-upd-${process.pid}`;
    try {
      console.log("\n── localDev: `hatchkit update` retrofit path ──────");

      // 1. Scaffold WITHOUT localDev to simulate a pre-integration project.
      await scaffoldApp(cfg(slug, []), d);
      const fragmentPath = join(fragmentDir, `${slug}.caddy`);
      if (existsSync(fragmentPath)) rmSync(fragmentPath);

      // 2. Run update headless via the presets path. ESM modules forbid
      //    monkey-patching @inquirer/prompts at runtime, so update.ts
      //    exposes UpdateOptions.presets specifically for this test
      //    surface. Real CLI invocations leave presets undefined and
      //    hit the interactive path.
      const { runUpdate } = await import("./src/scaffold/update.js");
      const updateResult = await runUpdate(d, {
        presets: {
          desiredFeatures: [],
          enableLocalDev: true,
          localDevSlug: slug,
        },
      });

      const { readManifest } = await import("./src/scaffold/manifest.js");
      const updatedManifest = readManifest(d);
      const nextConfig = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");

      const checks: Check[] = [
        ["update reports localDev enabled", updateResult.localDevEnabled?.slug === slug],
        ["manifest now carries localDev.slug", updatedManifest?.localDev?.slug === slug],
        ["manifest now carries localDev.domain", updatedManifest?.localDev?.domain === "local.example.com"],
        ["Caddy fragment landed", existsSync(fragmentPath)],
        ["docs/dev-setup.md generated", existsSync(join(d, "docs/dev-setup.md"))],
        ["next.config wrapped with withLocalDev", nextConfig.includes("withLocalDev")],
      ];
      let ok = true;
      for (const [n, c] of checks) {
        console.log(`  ${c ? "✓" : "✗"} ${n}`);
        if (!c) ok = false;
      }
      return ok;
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(join(fragmentDir, `${slug}.caddy`), { force: true });
    }
  })();

  // Case 7: a project scaffolded by hatchkit <= 0.2.18 carries the LEGACY
  // shape — a top-level `import { withLocalDev } from "@hatchkit/dev-plugin-next"`
  // plus `export default withLocalDev(cfg, { … });`. That import is what broke
  // `next build` outright, and re-running enable is the only repair path those
  // projects have, so the patcher must rewrite them in place rather than
  // reporting "already-wrapped" and walking away.
  results.localDevLegacyMigration = await (async () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-localdev-legacy-"));
    const slug = `ld-legacy-${process.pid}`;
    try {
      console.log("\n── localDev: legacy top-level-import migration ────");
      await scaffoldApp(cfg(slug, []), d);
      const nextPath = join(d, "packages/client/next.config.ts");
      writeFileSync(
        nextPath,
        [
          'import { withLocalDev } from "@hatchkit/dev-plugin-next";',
          'import type { NextConfig } from "next";',
          "",
          "const nextConfig: NextConfig = { trailingSlash: true };",
          "",
          'export default withLocalDev(nextConfig, { slug: "old-slug", localDevDomain: "local.foo.com" });',
          "",
        ].join("\n"),
      );

      const result = await enableProjectLocalDev({ projectDir: d, slug, devPort: 4322 });
      const migrated = readFileSync(nextPath, "utf-8");

      const second = await enableProjectLocalDev({ projectDir: d, slug, devPort: 4322 });
      const afterSecond = readFileSync(nextPath, "utf-8");

      const checks: Check[] = [
        ["legacy shape reported as migrated", result.patchedConfig === "migrated"],
        [
          "top-level plugin import removed",
          !/^\s*import\s*\{[^}]*withLocalDev[^}]*\}\s*from\s*["']@hatchkit\/dev-plugin-next["']/m.test(
            migrated,
          ),
        ],
        [
          "next/constants import added exactly once",
          (migrated.match(/from "next\/constants"/g) ?? []).length === 1,
        ],
        ["plugin now loaded dynamically", migrated.includes('await import("@hatchkit/dev-plugin-next")')],
        // Hand-tuned options (localDevDomain, defaultPort) must survive the
        // migration — clobbering them with the CLI-passed slug would silently
        // repoint a user's existing Caddy fragment.
        [
          "existing options literal preserved verbatim",
          migrated.includes(
            'withLocalDev(nextConfig, { slug: "old-slug", localDevDomain: "local.foo.com" })',
          ),
        ],
        ["no ragged blank runs left behind", !/\n{3,}/.test(migrated)],
        ["second enable reports already-wrapped", second.patchedConfig === "already-wrapped"],
        ["second enable left the file byte-identical", migrated === afterSecond],
      ];
      let ok = true;
      for (const [n, c] of checks) {
        console.log(`  ${c ? "✓" : "✗"} ${n}`);
        if (!c) ok = false;
      }
      return ok;
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(join(fragmentDir, `${slug}.caddy`), { force: true });
    }
  })();
}

results.cloudflareZoneResolver = await (async () => {
  console.log("\n── cloudflare: closest zone resolver ───────────────");
  const { CloudflareApi } = await import("./src/utils/cloudflare-api.js");
  const api = new CloudflareApi({ token: "test" });
  const calls: string[] = [];
  const zones = new Map([
    [
      "example.com",
      {
        id: "zone-parent",
        name: "example.com",
        name_servers: [],
        status: "active",
      },
    ],
  ]);
  api.getZoneByName = async (name: string) => {
    calls.push(name);
    return zones.get(name) ?? null;
  };

  const parent = await api.resolveZoneForName("connection.example.com");
  const parentCalls = calls.splice(0);
  zones.set("connection.example.com", {
    id: "zone-sub",
    name: "connection.example.com",
    name_servers: [],
    status: "active",
  });
  const exact = await api.resolveZoneForName("connection.example.com.");
  const wildcard = await api.resolveZoneForName("*.mail.example.com");

  const checks: Check[] = [
    ["subdomain falls back to parent zone", parent?.name === "example.com"],
    [
      "lookup tries exact hostname before parent",
      parentCalls.join(",") === "connection.example.com,example.com",
    ],
    ["delegated subdomain zone wins when present", exact?.name === "connection.example.com"],
    ["wildcard hostname strips leading star", wildcard?.name === "example.com"],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  return ok;
})();

// Pure-transform coverage for the regen-infra / rename-domain upgrade
// path: projects scaffolded before the client build-args existed must
// gain the Dockerfile ARG/ENV block and the workflow build-args, and
// re-running the transforms must be a no-op.
results.clientBuildArgUpgrades = await (async () => {
  console.log(`\n── client build-arg upgrade transforms ─────────────`);
  const {
    setWorkflowClientBuildArgUrls,
    stripComposeClientRuntimeNextPublic,
    upgradeClientDockerfile,
    upgradeWorkflowClientBuildArgs,
  } = await import("./src/scaffold/client-build-args.js");

  const oldDockerfile = [
    "FROM deps AS build",
    "COPY packages/client packages/client",
    "RUN pnpm --filter @starter/shared run build",
    "RUN pnpm --filter @starter/client run build",
    "",
  ].join("\n");
  const upgradedDockerfile = upgradeClientDockerfile(oldDockerfile);

  const oldWorkflow = [
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          context: .",
    "          file: packages/client/Dockerfile",
    "          push: true",
    "          tags: |",
    "            ghcr.io/owner/repo-client:main",
    "",
  ].join("\n");
  const upgradedWorkflow = upgradeWorkflowClientBuildArgs(oldWorkflow, "shiny.example.com");

  const compose = [
    "  client:",
    "    environment:",
    '      PORT: "3000"',
    "      NEXT_PUBLIC_API_URL: ${API_URL}",
    "      NEXT_PUBLIC_WS_URL: ${WS_URL:-}",
    "    restart: unless-stopped",
    "",
  ].join("\n");
  const strippedCompose = stripComposeClientRuntimeNextPublic(compose);

  const checks: Check[] = [
    [
      "Dockerfile upgrade inserts ARG block before the build RUN",
      upgradedDockerfile.indexOf("ARG NEXT_PUBLIC_API_URL") > 0 &&
        upgradedDockerfile.indexOf("ARG NEXT_PUBLIC_API_URL") <
          upgradedDockerfile.indexOf("RUN pnpm --filter @starter/shared run build"),
    ],
    [
      "Dockerfile upgrade sets HATCHKIT_IMAGE_BUILD guard",
      upgradedDockerfile.includes("HATCHKIT_IMAGE_BUILD=1"),
    ],
    [
      "Dockerfile upgrade is idempotent",
      upgradeClientDockerfile(upgradedDockerfile) === upgradedDockerfile,
    ],
    [
      "workflow upgrade inserts build-args with literal API URL",
      /^\s*NEXT_PUBLIC_API_URL=https:\/\/shiny\.example\.com$/m.test(upgradedWorkflow),
    ],
    [
      "workflow upgrade inserts build-args before tags",
      upgradedWorkflow.indexOf("build-args: |") > 0 &&
        upgradedWorkflow.indexOf("build-args: |") < upgradedWorkflow.indexOf("tags: |"),
    ],
    [
      "workflow upgrade is idempotent",
      upgradeWorkflowClientBuildArgs(upgradedWorkflow, "shiny.example.com") === upgradedWorkflow,
    ],
    [
      "rename rewrites existing literal URLs to the new domain",
      /^\s*NEXT_PUBLIC_API_URL=https:\/\/moved\.example\.org$/m.test(
        setWorkflowClientBuildArgUrls(upgradedWorkflow, "moved.example.org"),
      ) &&
        /^\s*NEXT_PUBLIC_WS_URL=wss:\/\/moved\.example\.org$/m.test(
          setWorkflowClientBuildArgUrls(upgradedWorkflow, "moved.example.org"),
        ),
    ],
    [
      "compose strip removes NEXT_PUBLIC_* lines, keeps PORT",
      !/NEXT_PUBLIC_/.test(strippedCompose) && strippedCompose.includes('PORT: "3000"'),
    ],
    [
      "compose strip is idempotent",
      stripComposeClientRuntimeNextPublic(strippedCompose) === strippedCompose,
    ],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  return ok;
})();

// Coolify deploy-secret naming, split vs single-origin. A split project
// has TWO Coolify apps to redeploy and one uuid can only trigger one of
// them, so the paired names have to come back — but the two sets must
// stay mutually exclusive, or an older checked-in workflow (whose
// single-app step is NOT gated on the paired secrets) fires an extra
// deploy.
console.log("\n── deploy secrets: split vs single-origin ─────────────────────────────");
{
  const { computeCoolifyDeploySecrets, coolifyDeploySecretNames, resourceUuidSecretName } =
    await import("./src/deploy/gh-actions-secrets.js");
  const checks: Check[] = [];
  const base = { coolifyUrl: "https://coolify.example.com/", coolifyToken: "tok" };

  checks.push([
    "secret name: client",
    resourceUuidSecretName("client") === "COOLIFY_CLIENT_RESOURCE_UUID",
  ]);
  checks.push([
    "secret name: server",
    resourceUuidSecretName("server") === "COOLIFY_SERVER_RESOURCE_UUID",
  ]);

  // Single-origin: one unlabelled app.
  const single = computeCoolifyDeploySecrets({
    ...base,
    apps: [{ uuid: "uuid-single" }],
  });
  checks.push([
    "single: COOLIFY_RESOURCE_UUID set",
    single.secrets.COOLIFY_RESOURCE_UUID === "uuid-single",
  ]);
  checks.push([
    "single: webhook points at the app, trailing slash trimmed",
    single.secrets.COOLIFY_WEBHOOK_URL ===
      "https://coolify.example.com/api/v1/deploy?uuid=uuid-single",
  ]);
  checks.push([
    "single: no paired names emitted",
    !("COOLIFY_CLIENT_RESOURCE_UUID" in single.secrets) &&
      !("COOLIFY_SERVER_RESOURCE_UUID" in single.secrets),
  ]);
  checks.push([
    "single: stale paired names queued for removal",
    single.staleToRemove.includes("COOLIFY_CLIENT_RESOURCE_UUID") &&
      single.staleToRemove.includes("COOLIFY_SERVER_RESOURCE_UUID"),
  ]);
  checks.push([
    "single: keeps its own uuid out of the removal list",
    !single.staleToRemove.includes("COOLIFY_RESOURCE_UUID"),
  ]);

  // Split: two roled apps.
  const split = computeCoolifyDeploySecrets({
    ...base,
    apps: [
      { uuid: "uuid-server", role: "server" },
      { uuid: "uuid-client", role: "client" },
    ],
  });
  checks.push([
    "split: both paired uuids set",
    split.secrets.COOLIFY_SERVER_RESOURCE_UUID === "uuid-server" &&
      split.secrets.COOLIFY_CLIENT_RESOURCE_UUID === "uuid-client",
  ]);
  checks.push([
    "split: no single-app uuid (would double-deploy on older workflows)",
    !("COOLIFY_RESOURCE_UUID" in split.secrets) &&
      !("COOLIFY_WEBHOOK_URL" in split.secrets),
  ]);
  checks.push([
    "split: clears the single-app uuid so it can't double-deploy the client",
    split.staleToRemove.includes("COOLIFY_RESOURCE_UUID") &&
      split.staleToRemove.includes("COOLIFY_WEBHOOK_URL"),
  ]);
  checks.push([
    "split: clears the superseded role-suffixed spelling",
    split.staleToRemove.includes("COOLIFY_RESOURCE_UUID_CLIENT") &&
      split.staleToRemove.includes("COOLIFY_RESOURCE_UUID_SERVER"),
  ]);
  checks.push([
    "split: never emits the role-suffixed spelling",
    !Object.keys(split.secrets).some((n) => /_(CLIENT|SERVER)$/.test(n)),
  ]);
  checks.push([
    "split: emission order stable regardless of input order",
    JSON.stringify(Object.keys(split.secrets)) ===
      JSON.stringify(
        Object.keys(
          computeCoolifyDeploySecrets({
            ...base,
            apps: [
              { uuid: "uuid-client", role: "client" },
              { uuid: "uuid-server", role: "server" },
            ],
          }).secrets,
        ),
      ),
  ]);

  // Both flows always carry the API triple.
  for (const [label, r] of [
    ["single", single],
    ["split", split],
  ] as const) {
    checks.push([
      `${label}: base url + token triple present`,
      r.secrets.COOLIFY_BASE_URL === "https://coolify.example.com" &&
        r.secrets.COOLIFY_API_TOKEN === "tok" &&
        r.secrets.COOLIFY_TOKEN === "tok",
    ]);
  }

  // adopt's --resume gate asks "are all the names already on the repo?".
  // It must be derived from the push, or a split project's gate sees the
  // single-app names, skips, and leaves the second app untriggered.
  checks.push([
    "names helper matches what split actually pushes",
    JSON.stringify(
      coolifyDeploySecretNames([
        { uuid: "a", role: "server" },
        { uuid: "b", role: "client" },
      ]),
    ) === JSON.stringify(Object.keys(split.secrets)),
  ]);
  checks.push([
    "names helper matches what single-origin actually pushes",
    JSON.stringify(coolifyDeploySecretNames([{ uuid: "a" }])) ===
      JSON.stringify(Object.keys(single.secrets)),
  ]);
  checks.push(["names helper: empty in, empty out", coolifyDeploySecretNames([]).length === 0]);

  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  results.deploySecretTopology = ok;
}

// ---------------------------------------------------------------------------
// Generated-project build regressions.
//
// Every assertion below guards a defect that shipped in a real scaffold and
// broke `pnpm install` or `pnpm run build` in the USER's project rather than
// anywhere in this repo — so they all assert on generated-file content, not on
// scaffolder internals. Reported against hatchkit 0.2.17; see the fixes in
// cli/src/scaffold/, cli/src/dev-setup.ts and starter/.
// ---------------------------------------------------------------------------

/** Recursively collect files under `dir` whose name ends with `ext`. */
function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Every relative import specifier in `srcDir` that does not resolve on disk.
 *
 *  This is the generic guard for the whole conditional-strip bug class: the
 *  scaffolder deletes feature files (services/stripe.ts, ws/) but the modules
 *  that imported them are hand-edited text, so a missed strip leaves a dangling
 *  `./services/stripe.js` import that only surfaces when the user runs `tsc`.
 *  NodeNext specifiers carry a `.js` extension that maps back to `.ts` source. */
function danglingRelativeImports(srcDir: string): string[] {
  const bad: string[] = [];
  for (const file of walkFiles(srcDir, ".ts")) {
    const content = readFileSync(file, "utf-8");
    for (const m of content.matchAll(/\bfrom\s+"(\.[^"]*)"/g)) {
      const spec = m[1];
      const base = resolve(dirname(file), spec.replace(/\.js$/, ""));
      const resolves = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base].some((c) =>
        existsSync(c),
      );
      if (!resolves) bad.push(`${file.slice(srcDir.length + 1)} → ${spec}`);
    }
  }
  return bad;
}

/** Structural problems with a pnpm-workspace.yaml `allowBuilds:` block.
 *
 *  pnpm 11 turns ERR_PNPM_IGNORED_BUILDS into a hard error and checks it before
 *  every `pnpm run <script>`, so a missing block — or a prose placeholder where
 *  a boolean belongs — breaks `install` AND every script in the scaffold.
 *  Assumes `allowBuilds:` is the last top-level key, which is how both the
 *  starter file and renderWorkspaceYaml() lay it out. */
function workspaceAllowBuildsProblems(content: string): string[] {
  const problems: string[] = [];
  if (!/^allowBuilds:$/m.test(content)) {
    problems.push("no top-level allowBuilds: block");
    return problems;
  }
  if (/set this to/i.test(content)) problems.push("carries a prose placeholder value");
  const block = content.slice(content.indexOf("allowBuilds:") + "allowBuilds:".length);
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    if (!/^ {2}(?:'[^']+'|[A-Za-z0-9@/._-]+): (?:true|false)$/.test(line)) {
      problems.push(`non-boolean allowBuilds entry: ${JSON.stringify(line)}`);
    }
  }
  return problems;
}

/** Exports-map problems in a generated workspace package.json.
 *
 *  A package with no `"type": "module"` emits CommonJS under tsconfig.base's
 *  `module: NodeNext`, so an exports map offering only an `import` condition is
 *  unresolvable from the Next.js client bundler (which resolves under
 *  ["node","require"]) and dies with ERR_PACKAGE_PATH_NOT_EXPORTED. Condition
 *  order matters too: `"types"` must be matched first. */
function exportsMapProblems(pkgPath: string): string[] {
  const problems: string[] = [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const map = pkg.exports;
  if (!map || typeof map !== "object") return problems;
  const isEsm = pkg.type === "module";
  for (const [subpath, entry] of Object.entries(map as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const keys = Object.keys(entry as Record<string, unknown>);
    if (keys.includes("types") && keys[0] !== "types") {
      problems.push(`${pkg.name} "${subpath}": "types" must come first, got "${keys[0]}"`);
    }
    // A types-only subpath (e.g. @starter/server's "./trpc") never resolves at
    // runtime — nothing to check.
    const runtime = keys.filter((k) => k !== "types");
    if (runtime.length === 0) continue;
    const requireResolvable = runtime.some((k) => k === "require" || k === "default");
    if (!isEsm && !requireResolvable) {
      problems.push(
        `${pkg.name} "${subpath}": CJS emit but conditions [${runtime.join(", ")}] — unresolvable under require`,
      );
    }
  }
  return problems;
}

// Stamp A — the exact feature combination from the bug report. Everything
// asserted here is feature-independent except the stripe-OFF checks.
results.buildRegressionsReported = await run(
  "build regressions: reported combo (ws+s3+analytics+desktop+mobile)",
  "stamp-a",
  ["websocket", "s3", "analytics", "desktop", "mobile"],
  (d) => {
    const workspace = readFileSync(join(d, "pnpm-workspace.yaml"), "utf-8");
    const globals = readFileSync(join(d, "packages/client/src/styles/globals.css"), "utf-8");
    const authClient = readFileSync(join(d, "packages/client/src/lib/auth-client.ts"), "utf-8");
    const serverApp = readFileSync(join(d, "packages/server/src/app.ts"), "utf-8");
    const serverIndex = readFileSync(join(d, "packages/server/src/index.ts"), "utf-8");
    const serverEnvDev = readFileSync(join(d, "packages/server/.env.development"), "utf-8");
    const manifest = JSON.parse(readFileSync(join(d, ".hatchkit.json"), "utf-8"));

    // Defect 4 — sweep every workspace package, not just @starter/shared, so a
    // future package inherits the guard for free.
    const pkgProblems = readdirSync(join(d, "packages"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(d, "packages", e.name, "package.json"))
      .filter((p) => existsSync(p))
      .flatMap(exportsMapProblems);

    // Defect 5 — Tailwind v4 resolves `@plugin` specifiers under node/require,
    // and tw-animate-css exports only a "style" condition, so `@plugin` there
    // fails the CSS build outright. `@import` is the documented usage.
    const atRules = globals
      .split("\n")
      .map((line, i) => [i, /^@([\w-]+)/.exec(line)?.[1]] as const)
      .filter((pair): pair is readonly [number, string] => pair[1] !== undefined);
    const firstNonImport = atRules.find(([, rule]) => rule !== "import" && rule !== "charset");
    const lastImport = [...atRules].reverse().find(([, rule]) => rule === "import");

    // Defect 6 — better-auth calls `new URL(baseURL)` at module scope, so a
    // relative or empty origin throws during Next's Node prerender. Assert no
    // branch of resolveAuthOrigin can yield one.
    const originBody = /function resolveAuthOrigin\(\): string \{([\s\S]*?)\n\}/.exec(authClient);
    const originReturns = [...(originBody?.[1] ?? "").matchAll(/return\s+([^;]+);/g)].map((m) =>
      m[1].trim(),
    );

    // Defect 2 — a top-level import of the ESM-only dev plugin anywhere under
    // packages/client/ kills `next build`, whatever wrote it.
    const staticPluginImports = [
      ...walkFiles(join(d, "packages/client"), ".ts"),
      ...walkFiles(join(d, "packages/client"), ".tsx"),
    ].filter((f) =>
      /^\s*import\s[^\n]*from\s*["']@hatchkit\/dev-plugin-next["']/m.test(readFileSync(f, "utf-8")),
    );

    return [
      // ── defect 1: pnpm-workspace.yaml ──────────────────────────────
      ["pnpm-workspace.yaml allowBuilds is well-formed", workspaceAllowBuildsProblems(workspace).length === 0],
      [
        "allowBuilds lists unrs-resolver (arrives via eslint-config-next)",
        /^\s{2}unrs-resolver: true$/m.test(workspace),
      ],
      ["allowBuilds quotes the scoped @sentry/cli key", workspace.includes("  '@sentry/cli': true")],

      // ── defect 2: no ESM-only plugin import in the client ──────────
      [
        "no top-level @hatchkit/dev-plugin-next import under packages/client",
        staticPluginImports.length === 0,
      ],

      // ── defect 3: stripe NOT selected ──────────────────────────────
      ["stripe service removed", !existsSync(join(d, "packages/server/src/services/stripe.ts"))],
      ["server app.ts drops the stripe import", !serverApp.includes("services/stripe.js")],
      ["server app.ts drops handleStripeWebhook", !serverApp.includes("handleStripeWebhook")],
      ["server app.ts drops the webhook mount", !serverApp.includes("/api/stripe/webhook")],
      ["server index.ts drops the stripe import", !serverIndex.includes("services/stripe.js")],
      ["server index.ts drops warnStripeStatus", !serverIndex.includes("warnStripeStatus")],
      [
        "billing router survives the stripe strip",
        existsSync(join(d, "packages/server/src/trpc/routers/billing.ts")),
      ],
      [
        "no dangling relative imports under packages/server/src",
        danglingRelativeImports(join(d, "packages/server/src")).length === 0,
      ],

      // ── defect 4: exports maps ─────────────────────────────────────
      ["every packages/* exports map is require-resolvable", pkgProblems.length === 0],
      [
        "@starter/shared exports map is exactly types→default",
        (() => {
          const shared = JSON.parse(
            readFileSync(join(d, "packages/shared/package.json"), "utf-8"),
          );
          // If shared ever gains "type": "module" this assertion should fail
          // loudly — the whole map has to be revisited, not just patched.
          return (
            shared.type === undefined &&
            JSON.stringify(Object.keys(shared.exports["."])) === '["types","default"]' &&
            JSON.stringify(Object.keys(shared.exports["./*"])) === '["types","default"]' &&
            shared.main === shared.exports["."].default &&
            shared.types === shared.exports["."].types
          );
        })(),
      ],

      // ── defect 5: globals.css ──────────────────────────────────────
      ["globals.css has no @plugin directive", !/^@plugin\s/m.test(globals)],
      ['globals.css imports "tw-animate-css"', /^@import\s+"tw-animate-css";$/m.test(globals)],
      ['globals.css line 1 is @import "tailwindcss"', globals.split("\n")[0] === '@import "tailwindcss";'],
      [
        "globals.css keeps every @import ahead of other at-rules",
        firstNonImport === undefined ||
          lastImport === undefined ||
          lastImport[0] < firstNonImport[0],
      ],

      // ── defect 6: auth-client baseURL ──────────────────────────────
      ["auth-client has no empty-string fallback", !authClient.includes(': ""')],
      [
        "auth-client guards the browser branch",
        authClient.includes('typeof window !== "undefined"') &&
          authClient.includes("window.location.origin"),
      ],
      ["auth-client has an absolute prerender fallback", /return\s+"http:\/\/localhost";/.test(authClient)],
      [
        "every resolveAuthOrigin branch returns an absolute origin",
        originReturns.length > 0 &&
          originReturns.every(
            (r) =>
              r.includes("configured") ||
              /^"https?:\/\/[^"]+"$/.test(r) ||
              r.includes("window.location.origin") ||
              // The browser branch binds window.location.origin to a local so
              // it can reject the opaque `file://` origin (which serializes to
              // the string "null") before returning it. Accept that shape only
              // when both the binding and the guard are present — otherwise a
              // bare `return someLocal;` would slip through.
              (originBody?.[1]?.includes(`const ${r} = window.location.origin`) === true &&
                originBody[1].includes(`${r} !== "null"`)),
          ),
      ],
      [
        "auth-client re-exports survive",
        authClient.includes("export const { signIn, signUp, signOut, useSession } = authClient;"),
      ],

      // ── defect 7 (negative): no newsletter → no /sub routes at all ──
      ["app/sub stripped when newsletter is unselected", !existsSync(join(d, "packages/client/src/app/sub"))],

      // ── defect 8: server dev env ───────────────────────────────────
      [".env.development exists", existsSync(join(d, "packages/server/.env.development"))],
      [".env.development sets a non-empty MONGODB_URI", /^MONGODB_URI=mongodb(\+srv)?:\/\/\S+$/m.test(serverEnvDev)],
      [
        ".env.development FRONTEND_URL → allocated client port",
        new RegExp(`^FRONTEND_URL=http://localhost:${manifest.ports.client}$`, "m").test(serverEnvDev),
      ],
      [
        ".env.development PORT → allocated server port",
        new RegExp(`^PORT=${manifest.ports.server}$`, "m").test(serverEnvDev),
      ],
    ];
  },
);

// Stamp B — the opposite branch of the conditional codegen: stripe ON, plus a
// listmonk mailing list (which keeps the /sub routes) AND desktop+mobile
// (which flips next.config to a static export). That intersection is the one
// that shipped an unbuildable project.
results.buildRegressionsCommerce = await run(
  "build regressions: commerce combo (stripe + listmonk + static export)",
  "stamp-b",
  ["websocket", "stripe", "desktop", "mobile"],
  (d) => {
    const serverApp = readFileSync(join(d, "packages/server/src/app.ts"), "utf-8");
    const serverIndex = readFileSync(join(d, "packages/server/src/index.ts"), "utf-8");
    const nextCfg = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
    const subDir = join(d, "packages/client/src/app/sub");
    const errorPage = readFileSync(join(subDir, "error/page.tsx"), "utf-8");
    const reasonMessage = readFileSync(join(subDir, "error/reason-message.tsx"), "utf-8");
    const confirmed = readFileSync(join(subDir, "confirmed/page.tsx"), "utf-8");

    // Under `output: "export"` every route prerenders, so a single page opting
    // into dynamic rendering fails the whole build.
    const isStaticExport = /output:\s*["']export["']/.test(nextCfg);
    const forcedDynamic = walkFiles(join(d, "packages/client/src/app"), ".tsx").filter((f) =>
      /dynamic\s*=\s*["']force-dynamic["']/.test(readFileSync(f, "utf-8")),
    );

    return [
      // ── defect 3: stripe SELECTED — the wiring must survive ────────
      ["stripe service kept", existsSync(join(d, "packages/server/src/services/stripe.ts"))],
      [
        "server app.ts keeps the stripe import",
        serverApp.includes('import { handleStripeWebhook } from "./services/stripe.js";'),
      ],
      ["server index.ts keeps warnStripeStatus()", serverIndex.includes("warnStripeStatus();")],
      // Load-bearing express ordering: the raw-body webhook must sit AFTER the
      // better-auth handler (which parses its own body) and BEFORE
      // express.json() (which would consume the body and break the signature).
      [
        "webhook mount sits between the auth handler and express.json()",
        serverApp.indexOf('"/api/auth/{*any}"') > -1 &&
          serverApp.indexOf('"/api/auth/{*any}"') < serverApp.indexOf('"/api/stripe/webhook"') &&
          // Match the actual mount, not the comment above the auth handler
          // that also spells `express.json()`.
          serverApp.indexOf('"/api/stripe/webhook"') < serverApp.indexOf("app.use(express.json("),
      ],
      ["websocket wiring kept", serverIndex.includes("const wss = setupWebSocket(server);")],
      [
        "no dangling relative imports under packages/server/src",
        danglingRelativeImports(join(d, "packages/server/src")).length === 0,
      ],

      // ── defect 7: /sub routes under a static export ────────────────
      ["listmonk keeps the /sub routes", existsSync(join(subDir, "page.tsx"))],
      ["desktop/mobile flips next.config to a static export", isStaticExport],
      [
        "no app/ page forces dynamic rendering under output: export",
        !isStaticExport || forcedDynamic.length === 0,
      ],
      ["/sub/error/page.tsx does not await searchParams", !errorPage.includes("await searchParams")],
      ["/sub/error/page.tsx is a sync server component", !/export default async function/.test(errorPage)],
      [
        "/sub/error/page.tsx suspends the client reason reader",
        errorPage.includes('from "react"') &&
          errorPage.includes("<Suspense") &&
          errorPage.includes("<ReasonMessage"),
      ],
      [
        "/sub/error/reason-message.tsx is a client component",
        reasonMessage.split("\n")[0] === '"use client";' &&
          reasonMessage.includes('from "next/navigation"') &&
          reasonMessage.includes("useSearchParams"),
      ],
      [
        "reason messages survived the move to the client module",
        ["missing", "malformed", "bad_signature", "expired", "list_add_failed"].every((k) =>
          reasonMessage.includes(`${k}:`),
        ),
      ],
      [
        "/sub/error keeps its noindex metadata and both links",
        /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/.test(errorPage) &&
          errorPage.includes('href="/sub"') &&
          errorPage.includes('href="/"'),
      ],
      ["/sub/confirmed drops force-dynamic", !/dynamic\s*=\s*["']force-dynamic["']/.test(confirmed)],
    ];
  },
  { email: { transactional: "none", mailingList: "listmonk-ses" } },
);

// Defect 1, the other half: `hatchkit server add` regenerates
// pnpm-workspace.yaml when a client-only project has none. Before the fix that
// path wrote a bare `packages:` list with no allowBuilds block, so the
// retrofitted project inherited the exact ERR_PNPM_IGNORED_BUILDS failure the
// starter was fixed to avoid.
results.workspaceAllowBuildsFallback = await (async () => {
  console.log("\n── workspace: allowBuilds fallback + drift guard ───");
  const { runServerAdd, WORKSPACE_ALLOW_BUILDS, renderWorkspaceYaml } = await import(
    "./src/scaffold/server-add.js"
  );
  const { readManifest, writeManifest } = await import("./src/scaffold/manifest.js");
  const rendered = renderWorkspaceYaml(["packages/*"]);
  const starterWorkspace = readFileSync(join(STARTER, "pnpm-workspace.yaml"), "utf-8");
  const allowBuildsOf = (s: string): string => s.slice(s.indexOf("allowBuilds:"));

  const missing = mkdtempSync(join(tmpdir(), "scaffold-ws-missing-"));
  const partial = mkdtempSync(join(tmpdir(), "scaffold-ws-partial-"));
  try {
    // (a) file-missing branch.
    await scaffoldApp(cfg("ws-missing", [], { surfaces: "static" }), missing);
    rmSync(join(missing, "pnpm-workspace.yaml"), { force: true });
    const addResult = await runServerAdd(missing, { yes: true, presets: { confirmAdd: true } });
    const regenerated = readFileSync(join(missing, "pnpm-workspace.yaml"), "utf-8");
    const lines = regenerated.split("\n");

    // Re-running is a no-op: reset the manifest back to static so the second
    // pass actually reaches ensureWorkspacePackages instead of early-returning
    // on `surfaces: fullstack`.
    const m = readManifest(missing);
    if (m) writeManifest(missing, { ...m, surfaces: "static" });
    await runServerAdd(missing, { yes: true, presets: { confirmAdd: true } });
    const rerun = readFileSync(join(missing, "pnpm-workspace.yaml"), "utf-8");

    // (b) file-exists branch: a `packages:` block without the glob. The new
    // entry has to land INSIDE that block — appended at EOF it would parse as
    // a member of the allowBuilds mapping.
    await scaffoldApp(cfg("ws-partial", [], { surfaces: "static" }), partial);
    writeFileSync(
      join(partial, "pnpm-workspace.yaml"),
      starterWorkspace.replace(/^\s*-\s*"packages\/\*"\n/m, ""),
    );
    await runServerAdd(partial, { yes: true, presets: { confirmAdd: true } });
    const patched = readFileSync(join(partial, "pnpm-workspace.yaml"), "utf-8");
    const patchedLines = patched.split("\n");
    const globIdx = patchedLines.findIndex((l) => /^\s*-\s*"packages\/\*"$/.test(l));
    const allowIdx = patchedLines.findIndex((l) => /^allowBuilds:$/.test(l));

    const checks: Check[] = [
      // The drift guard: the constant and the starter file must stay
      // byte-identical, or a scaffold and a retrofit disagree about which
      // packages may run build scripts.
      [
        "WORKSPACE_ALLOW_BUILDS matches starter/pnpm-workspace.yaml byte-for-byte",
        allowBuildsOf(rendered) === allowBuildsOf(starterWorkspace),
      ],
      ["WORKSPACE_ALLOW_BUILDS is non-empty", WORKSPACE_ALLOW_BUILDS.length > 0],
      ["WORKSPACE_ALLOW_BUILDS lists unrs-resolver", WORKSPACE_ALLOW_BUILDS.includes("unrs-resolver")],
      ["rendered workspace has no prose placeholder", !/set this to true or false/.test(rendered)],
      ["rendered workspace allowBuilds is well-formed", workspaceAllowBuildsProblems(rendered).length === 0],
      ["rendered workspace quotes the scoped @sentry/cli key", rendered.includes("  '@sentry/cli': true")],

      ["server add reports pnpm-workspace.yaml created", addResult.created.includes("pnpm-workspace.yaml")],
      ["regenerated workspace equals renderWorkspaceYaml()", regenerated === rendered],
      ["regenerated workspace lists packages/*", lines.some((l) => /^\s*-\s*"packages\/\*"$/.test(l))],
      ["regenerated workspace has an allowBuilds block", /^allowBuilds:$/m.test(regenerated)],
      ["regenerated workspace allowBuilds is well-formed", workspaceAllowBuildsProblems(regenerated).length === 0],
      ["re-running server add leaves the workspace byte-identical", rerun === regenerated],
      [
        "re-running server add does not duplicate packages/*",
        (rerun.match(/^\s*-\s*"packages\/\*"$/gm) ?? []).length === 1,
      ],

      ["existing workspace: packages/* appended inside the packages block", globIdx > -1 && allowIdx > globIdx],
      [
        "existing workspace: allowBuilds block left intact",
        allowBuildsOf(patched) === allowBuildsOf(starterWorkspace),
      ],
    ];
    let ok = true;
    for (const [n, c] of checks) {
      console.log(`  ${c ? "✓" : "✗"} ${n}`);
      if (!c) ok = false;
    }
    return ok;
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(partial, { recursive: true, force: true });
  }
})();

// The `stamp-build` CI job is what turns every assertion above into an actual
// install+build gate — the static matrix in this file can only see file
// content, never a compiler error. These are shape guards on that job so it
// cannot silently narrow: a renamed script, a dropped `starter/**` path filter
// or a folded-into-`check` job would all fail only on CI, or not at all.
results.ciStampPresets = (() => {
  console.log("\n── CI: stamp-build job cannot silently narrow ─────");
  const repoRoot = resolve(import.meta.dirname, "..");
  const stampScriptPath = resolve(import.meta.dirname, "scripts/ci-stamp.ts");
  const workflowPath = join(repoRoot, ".github/workflows/ci.yml");
  const stampScript = existsSync(stampScriptPath) ? readFileSync(stampScriptPath, "utf-8") : "";
  const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf-8") : "";

  const checks: Check[] = [
    ["cli/scripts/ci-stamp.ts exists", existsSync(stampScriptPath)],
    [
      "ci-stamp keeps the reported preset (the exact bug-report combo)",
      stampScript.includes('"websocket", "s3", "analytics", "desktop", "mobile"'),
    ],
    [
      "ci-stamp keeps the commerce preset (opposite conditional-codegen branch)",
      stampScript.includes('"websocket", "stripe", "desktop", "mobile"') &&
        stampScript.includes('mailingList: "listmonk-ses"'),
    ],
    // Dropping starter/** re-opens the blind spot that let template-only
    // regressions ship: the old filter only watched cli/**.
    ['ci.yml paths still watch "starter/**"', workflow.includes('- "starter/**"')],
    ["ci.yml has a standalone stamp-build job", /^ {2}stamp-build:$/m.test(workflow)],
    [
      "ci-stamp keeps the web preset (standalone build, no static export)",
      stampScript.includes("web:"),
    ],
    // The point of a separate job is that it actually compiles the stamp.
    // Assert on stamp-build's OWN step block — a check that "check:" and
    // "stamp-build:" are different strings can never fail.
    [
      "stamp-build installs, builds and unit-tests the stamped project",
      (() => {
        const start = workflow.indexOf("\n  stamp-build:");
        if (start === -1) return false;
        // Slice to the next top-level job key, or EOF for the last job.
        const rest = workflow.slice(start + 1);
        const next = rest.slice(1).search(/^ {2}\S+:$/m);
        const block = next === -1 ? rest : rest.slice(0, next + 1);
        return (
          block.includes("pnpm install --no-frozen-lockfile") &&
          block.includes("pnpm run build") &&
          block.includes("pnpm run test:unit")
        );
      })(),
    ],
    // NOT because of package renaming — cli/src/deploy/rename-project.ts
    // deliberately leaves the @starter/* workspace names alone. The lockfile
    // drifts because scaffolding PRUNES dependencies the chosen feature set
    // doesn't need. pnpm defaults to frozen when CI=true, hence the flag.
    [
      "stamped install uses --no-frozen-lockfile",
      workflow.includes("pnpm install --no-frozen-lockfile"),
    ],
    [
      "stamp-build sets NEXT_PUBLIC_API_URL (next.config hard-fails without it)",
      /^\s*NEXT_PUBLIC_API_URL:\s*\S+$/m.test(workflow),
    ],
  ];
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  return ok;
})();

// Clean up the isolated config dir + every keychain entry scoped to
// the throwaway service.
{
  const { clearAllSecrets } = await import("./src/utils/secrets.js");
  await clearAllSecrets();
}
rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_DEV_CONFIG_DIR!, { recursive: true, force: true });

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
