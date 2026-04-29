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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const { scaffoldApp } = await import("./src/scaffold/app.js");
type Feature = import("./src/prompts.js").Feature;
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

function cfg(name: string, features: Feature[]): ProjectConfig {
  return {
    name,
    domain: `${name}.example.com`,
    baseDomain: "example.com",
    subdomain: name,
    deployTarget: "existing",
    serverId: 1,
    serverIp: "1.2.3.4",
    features,
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: false,
    runDeployment: false,
    dryRun: false,
  };
}

type Check = [string, boolean];

async function run(label: string, name: string, features: Feature[], expect: (d: string) => Check[]): Promise<boolean> {
  const d = mkdtempSync(join(tmpdir(), `scaffold-${label}-`));
  try {
    console.log(`\n── ${label} ─────────────────────────────`);
    await scaffoldApp(cfg(name, features), d);
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
  return [
    ["package.json renamed", pkg.name === "plain-app"],
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
    ["electron-icon-builder dep present", !!pkg.devDependencies?.["electron-icon-builder"]],
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

// Manifest: verify .hatchkit.json is written with sanitized fields
// and NEVER contains credentials or infrastructure coordinates.
console.log("\n── manifest: sanitized fields only, no leaks ─────────────────────────────");
{
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
      ["has version = 1", manifest.version === 1],
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
  const result = await collectProjectConfig({
    nonInteractive: true,
    presets: {
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
    },
  });
  const checks: Check[] = [
    ["name preserved", result.name === "ni-app"],
    ["domain preserved", result.domain === "ni-app.example.com"],
    ["features preserved", result.features.length === 1 && result.features[0] === "websocket"],
    ["serverSize defaulted to cpx21", result.serverSize === "cpx21"],
    ["serverLocation defaulted to nbg1", result.serverLocation === "nbg1"],
    ["createGithubRepo false", result.createGithubRepo === false],
    ["runDeployment false", result.runDeployment === false],
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

// dotenvx: scaffold a project with some real + some missing env values,
// verify .env.production has a public-key header + one encrypted value
// + one plaintext CHANGE_ME_<KEY>, and that the private key ends up in
// the (isolated) keychain.
console.log("\n── dotenvx: .env.production is sealed correctly ─────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "scaffold-dotenvx-"));
  try {
    const c = cfg("dotenvx-test", ["stripe"]);
    c.envValues = {
      MONGODB_URI: "mongodb+srv://real-host/real-db",
      STRIPE_SECRET_KEY: "sk_live_REAL_VALUE",
      // STRIPE_WEBHOOK_SECRET deliberately omitted → CHANGE_ME path.
    };
    const result = await scaffoldApp(c, d);

    const envProd = readFileSync(join(d, "packages/server/.env.production"), "utf-8");
    const envKeys = readFileSync(join(d, "packages/server/.env.keys"), "utf-8");
    const { getSecret, SECRET_KEYS } = await import("./src/utils/secrets.js");
    const keychainKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey(c.name));

    const checks: Check[] = [
      ["dotenvx result is populated", !!result.dotenvx],
      [
        "encryptedKeys includes STRIPE_SECRET_KEY",
        result.dotenvx?.encryptedKeys.includes("STRIPE_SECRET_KEY") ?? false,
      ],
      [
        "placeholderKeys includes STRIPE_WEBHOOK_SECRET",
        result.dotenvx?.placeholderKeys.includes("STRIPE_WEBHOOK_SECRET") ?? false,
      ],
      [
        ".env.production has DOTENV_PUBLIC_KEY_PRODUCTION",
        /DOTENV_PUBLIC_KEY_PRODUCTION=/.test(envProd),
      ],
      [
        "STRIPE_SECRET_KEY is encrypted (no plaintext sk_live_REAL_VALUE in file)",
        !envProd.includes("sk_live_REAL_VALUE") && /STRIPE_SECRET_KEY="encrypted:/.test(envProd),
      ],
      [
        "STRIPE_WEBHOOK_SECRET is plaintext CHANGE_ME",
        /STRIPE_WEBHOOK_SECRET="?CHANGE_ME_STRIPE_WEBHOOK_SECRET"?/.test(envProd),
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
      [
        "keychain key matches .env.keys",
        keychainKey === result.dotenvx?.privateKey,
      ],
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
  ledger.record({ kind: "resend", client: "test-resend-prod" });

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

// Clean up the isolated config dir + every keychain entry scoped to
// the throwaway service.
{
  const { clearAllSecrets } = await import("./src/utils/secrets.js");
  await clearAllSecrets();
}
rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
