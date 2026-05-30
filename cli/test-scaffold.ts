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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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

const results: Record<string, boolean> = {};

results.minimal = await run("minimal (no flags)", "plain-app", [], (d) => {
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
  const serverEnv = readFileSync(join(d, "packages/server/.env.example"), "utf-8");
  const clientEnv = readFileSync(join(d, "packages/client/.env.example"), "utf-8");
  const serverEnvDev = readFileSync(join(d, "packages/server/.env.development"), "utf-8");
  const gitignore = existsSync(join(d, ".gitignore"))
    ? readFileSync(join(d, ".gitignore"), "utf-8")
    : "";
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
      "server .env.example BETTER_AUTH_URL rewritten to api subdomain",
      /^BETTER_AUTH_URL=https:\/\/api\.plain-app\.example\.com$/m.test(serverEnv),
    ],
    [
      "client .env.example NEXT_PUBLIC_API_URL rewritten",
      /^NEXT_PUBLIC_API_URL=https:\/\/api\.plain-app\.example\.com$/m.test(clientEnv),
    ],
    [
      "client .env.example NEXT_PUBLIC_WS_URL uses wss",
      /^NEXT_PUBLIC_WS_URL=wss:\/\/api\.plain-app\.example\.com$/m.test(clientEnv),
    ],
    [
      ".env.development untouched (still localhost)",
      /FRONTEND_URL=http:\/\/localhost:3000/.test(serverEnvDev),
    ],
    [
      "TRUSTED_ORIGINS stays commented out (no native clients)",
      /^#\s*TRUSTED_ORIGINS=/m.test(serverEnv),
    ],
  ];
});

results.websocket = await run("websocket only", "rt-app", ["websocket"], (d) => {
  return [
    ["ws/ kept", existsSync(join(d, "packages/server/src/ws"))],
    ["stripe service removed", !existsSync(join(d, "packages/server/src/services/stripe.ts"))],
  ];
});

results.desktop = await run("desktop only", "my-cool-app", ["desktop"], (d) => {
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
  const nextCfg = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
  return [
    ["electron/main.ts kept", existsSync(join(d, "electron/main.ts"))],
    ["build/icon.png placeholder kept", statSync(join(d, "build/icon.png")).size > 1000],
    ["desktop workflow kept", existsSync(join(d, ".github/workflows/desktop-release.yml"))],
    ["mobile workflow removed", !existsSync(join(d, ".github/workflows/mobile-release.yml"))],
    ["resources/ removed", !existsSync(join(d, "resources"))],
    ["electron dep present", !!pkg.devDependencies?.electron],
    ["icon-gen dep present", !!pkg.devDependencies?.["icon-gen"]],
    ["no capacitor deps", !pkg.dependencies?.["@capacitor/core"]],
    ["bundleId sanitized (no hyphens)", pkg.build?.appId === "com.example.mycoolapp"],
    ["productName has display name", pkg.build?.productName === "my-cool-app"],
    ["typecheck chains electron", pkg.scripts?.typecheck?.includes("typecheck:electron")],
    ["next.config flipped to export", nextCfg.includes('output: "export"')],
    ["next.config has assetPrefix", nextCfg.includes('assetPrefix: "./"')],
    ["next.config has trailingSlash", nextCfg.includes("trailingSlash: true")],
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
    ["appName has display name", capCfg.includes('appName: "my-cool-app"')],
    ["layout mounts MobileBridgeLoader", layout.includes("MobileBridgeLoader")],
  ];
});

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
    return [
      ["packages/client/ removed", !existsSync(join(d, "packages/client"))],
      ["packages/server/ kept", existsSync(join(d, "packages/server"))],
      ["packages/shared/ kept", existsSync(join(d, "packages/shared"))],
      ["docs-site/ removed", !existsSync(join(d, "docs-site"))],
      ["e2e/ removed", !existsSync(join(d, "e2e"))],
      ["compose: client service stripped", !/^\s{2}client:/m.test(compose)],
      ["compose: server service kept", /^\s{2}server:/m.test(compose)],
      ["compose: mongo service kept", /^\s{2}mongo:/m.test(compose)],
      ["compose: redis service kept", /^\s{2}redis:/m.test(compose)],
      ["pkg.scripts.dev targets server only", pkg.scripts?.dev === "pnpm --filter @starter/server dev"],
      ["pkg.scripts has no build:client", !pkg.scripts?.["build:client"]],
      ["pkg.scripts has no test:e2e", !pkg.scripts?.["test:e2e"]],
      ["manifest persists surfaces=server-only", manifest.surfaces === "backend"],
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
    ];
  },
  { surfaces: "static", mongodbProvider: "external" },
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

results.both = await run("desktop + mobile", "my-cool-app", ["desktop", "mobile"], (d) => {
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
  const nextCfg = readFileSync(join(d, "packages/client/next.config.ts"), "utf-8");
  const capCfg = readFileSync(join(d, "capacitor.config.ts"), "utf-8");
  return [
    ["both workflows kept", existsSync(join(d, ".github/workflows/desktop-release.yml")) && existsSync(join(d, ".github/workflows/mobile-release.yml"))],
    ["both asset source dirs kept", existsSync(join(d, "build/icon.png")) && existsSync(join(d, "resources/icon.png"))],
    ["bundle IDs sanitized in both configs", pkg.build?.appId === "com.example.mycoolapp" && capCfg.includes("com.example.mycoolapp")],
    ["next.config flipped exactly once", (nextCfg.match(/output:\s*["']export["']/g) || []).length === 1],
    ["both dep trees present", !!pkg.devDependencies?.electron && !!pkg.dependencies?.["@capacitor/core"]],
  ];
});

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
    const electronMain = readFileSync(join(d, "electron/main.ts"), "utf-8");
    const androidDev = readFileSync(join(d, "scripts/android-dev.sh"), "utf-8");
    const iosDev = readFileSync(join(d, "scripts/ios-dev.sh"), "utf-8");
    const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));

    const checks: Check[] = [
      ["nativeHmrPort assigned", ports.nativeHmr !== undefined],
      ["nativeHmrPort in 7000-7999", ports.nativeHmr! >= 7000 && ports.nativeHmr! <= 7999],
      ["nativeHmrPort != serverPort", ports.nativeHmr !== ports.server],
      ["nativeHmrPort != clientPort", ports.nativeHmr !== ports.client],
      [`electron DEV_URL uses native port`, electronMain.includes(`"http://localhost:${ports.nativeHmr}"`)],
      [`android-dev.sh NEXT_PORT default = ${ports.nativeHmr}`, androidDev.includes(`NEXT_PORT:-${ports.nativeHmr}`)],
      [`ios-dev.sh NEXT_PORT default = ${ports.nativeHmr}`, iosDev.includes(`NEXT_PORT:-${ports.nativeHmr}`)],
      [`dev:desktop uses native port`, pkg.scripts["dev:desktop"]?.includes(`http://localhost:${ports.nativeHmr}`)],
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
  const { addUsedPorts } = await import("./src/config.js");

  const [serverMin, serverMax] = PORT_RANGES.server;
  // Find two adjacent free ports in the server range so we can bind
  // one and leave the other as the only valid pick.
  let bound = -1, sparePort = -1;
  for (let p = serverMin; p <= serverMax - 1; p++) {
    if ((await isPortFree(p)) && (await isPortFree(p + 1))) {
      bound = p; sparePort = p + 1; break;
    }
  }
  if (bound === -1) throw new Error("no adjacent free ports in server range for test");

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

console.log("\n── coolify api: github app source discovery ─────────────");
{
  const { CoolifyApi } = await import("./src/utils/coolify-api.js");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify([
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
    ["source uuid returned", sources[0]?.uuid === "gh-app-uuid"],
    ["source name returned", sources[0]?.name === "Personal GitHub App"],
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

// Sync plan computation: the manifest → DesiredApp map must produce the
// per-app payload that runCoolifySetup / wireProjectIntoCoolify create
// at scaffold time. Anchored on collection-of-beauty's real shape
// (client-only, port 80, single `app` service) since that's the ground
// truth case the bug was reported against.
console.log(
  "\n── sync: manifest → desired Coolify app states (matches scaffold time) ────────",
);
{
  const { computeDesiredAppStates } = await import("./src/deploy/sync.js");
  const { MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");

  const clientOnly = computeDesiredAppStates({
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: "2026-05-01T00:00:00.000Z",
    name: "collection-of-beauty",
    domain: "beauty.example.com",
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    ports: { server: 3000, client: 3001 },
    surfaces: "static",
  });
  const both = computeDesiredAppStates({
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: "2026-05-01T00:00:00.000Z",
    name: "split-app",
    domain: "split.example.com",
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    ports: { server: 3000, client: 3001 },
    surfaces: "fullstack",
  });

  const singleApp = clientOnly.find((d) => d.appName === "collection-of-beauty");
  const splitClient = both.find((d) => d.appName === "split-app-client");
  const splitServer = both.find((d) => d.appName === "split-app-server");

  const checks: Check[] = [
    ["client-only emits a single-app entry", !!singleApp],
    [
      "client-only: domain canonicalizes to https://<bare>",
      singleApp?.domains[0]?.domain === "https://beauty.example.com",
    ],
    ["client-only: app service named `app`", singleApp?.domains[0]?.name === "app"],
    ["client-only: ports_exposes is 80", singleApp?.portsExposes === "80"],
    ["both: emits split client app", !!splitClient],
    ["both: emits split server app", !!splitServer],
    [
      "both: client gets frontend hostname only",
      splitClient?.domains.length === 1 &&
        splitClient?.domains[0]?.domain === "https://split.example.com",
    ],
    [
      "both: server gets api + path-based backend hosts",
      Array.isArray(splitServer?.domains) &&
        (splitServer?.domains.length ?? 0) === 4 &&
        splitServer?.domains.every((d) => d.name === "server"),
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
  // Two custom dirs (cli, docs) that aren't on the recognised lists.
  // docs has its own lockfile + .npmrc:ignore-workspace=true — the
  // standalone-buildable marker.
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
  const stateA = await detectProject(repoA);
  checks.push(["A: unknownWorkspaceLayout flagged", stateA.unknownWorkspaceLayout === true]);
  checks.push(["A: no serverDir matched", stateA.serverDir === undefined]);
  checks.push(["A: no clientDir matched", stateA.clientDir === undefined]);
  checks.push([
    "A: docs/ surfaced as standalone candidate",
    stateA.standaloneBuildCandidates.some((c) => c.dir.endsWith("/docs")),
  ]);
  checks.push([
    "A: ignore-workspace flag captured",
    stateA.standaloneBuildCandidates.find((c) => c.dir.endsWith("/docs"))?.hasIgnoreWorkspace ===
      true,
  ]);

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
        [
          "next.config wrapped with withLocalDev",
          nextConfig.includes("import { withLocalDev }") &&
            nextConfig.includes(`withLocalDev(nextConfig, { slug: "${slug}" })`),
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
      const importCount = (nextConfig.match(/from "@hatchkit\/dev-plugin-next"/g) ?? []).length;

      const checks: Check[] = [
        ["second enable reports fragment unchanged", second.wroteFragment === "unchanged"],
        ["second enable reports next.config already-wrapped", second.patchedConfig === "already-wrapped"],
        ["second enable reports package.json already-present", second.patchedPackageJson === "already-present"],
        // Two textual hits: the import line + the wrapped export.
        // Three or more = duplicated wrapping.
        ["next.config has exactly one wrap site", withLocalDevCount === 2],
        ["next.config has exactly one plugin import", importCount === 1],
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
        [
          "hoisted into a const before wrapping",
          inlineConfig.includes("__hatchkitLocalDevConfig") &&
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
