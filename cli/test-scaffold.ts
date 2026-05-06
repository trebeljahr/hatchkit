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
    surfaces: "client-only",
    defaultBranch: "main",
  });
  const dockerfile = readFileSync(join(tmp, "Dockerfile"), "utf-8");
  const compose = readFileSync(join(tmp, "docker-compose.yml"), "utf-8");
  checks.push(["Dockerfile contains NODE_VERSION=24", /NODE_VERSION=24\b/.test(dockerfile)]);
  checks.push([
    "Dockerfile does NOT contain NODE_VERSION=22",
    !/NODE_VERSION=22\b/.test(dockerfile),
  ]);
  checks.push(["client-only compose maps nginx port 80", compose.includes('"80:80"')]);
  checks.push([
    "client-only compose does NOT map default app port 3000",
    !compose.includes('"3000:3000"'),
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
    surfaces: "client-only",
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

// Coolify API: dockercompose app creation must use per-service domains,
// not the top-level `domains` field that Coolify now rejects.
console.log("\n── coolify api: dockercompose domains payload ─────────────────────────────");
{
  const { CoolifyApi } = await import("./src/utils/coolify-api.js");
  const { normalizeCoolifyGitRepository } = await import("./src/deploy/coolify-app.js");
  const calls: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
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
  } finally {
    globalThis.fetch = originalFetch;
  }

  const dockerComposeBody = JSON.parse(String(calls[0]?.body ?? "{}"));
  const nixpacksBody = JSON.parse(String(calls[1]?.body ?? "{}"));
  const publicRepo = normalizeCoolifyGitRepository("git@github.com:acme/app.git", false);
  const privateRepo = normalizeCoolifyGitRepository("git@github.com:acme/app.git", true);
  const checks: Check[] = [
    ["dockercompose omits top-level domains", dockerComposeBody.domains === undefined],
    [
      "dockercompose sets service domain",
      Array.isArray(dockerComposeBody.docker_compose_domains) &&
        dockerComposeBody.docker_compose_domains[0]?.name === "web" &&
        dockerComposeBody.docker_compose_domains[0]?.domain === "https://app.example.com:3000",
    ],
    ["nixpacks still uses top-level domains", nixpacksBody.domains === "https://app.example.com"],
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
  // After `dotenvx rotate`, the value is `old,new` so the runtime
  // can decrypt both pre- and post-rotation ciphertext. We must
  // preserve the full list when mirroring to the deploy target.
  checks.push([
    "parsePrivateKeyValue preserves comma-joined post-rotate list",
    parsePrivateKeyValue(`DOTENV_PRIVATE_KEY_PRODUCTION=${"a".repeat(64)},${"b".repeat(64)}`) ===
      `${"a".repeat(64)},${"b".repeat(64)}`,
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
  // the new value, NOT the old one.
  const rot = await rotateProjectKey("kt-rotate", { projectDir: rotProj });
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
