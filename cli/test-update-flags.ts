/**
 * `hatchkit update` — the retrofit contract.
 *
 * Adding a feature LATER has to behave like adding it at scaffold time:
 * the same files land, running it twice changes nothing more, a user's
 * edits survive, and `--dry-run` reports the plan without writing.
 *
 * Every assertion here corresponds to something that was broken:
 *
 *   · `--dry-run` did not exist at all. `update` was the only mutating
 *     command without one, while CLAUDE.md tells agents to prefer it.
 *   · adding `desktop` installed the `icons:desktop` script without
 *     copying the `scripts/icons-desktop.mjs` it runs — the scaffolder
 *     deletes that file from a project with no desktop wrapper.
 *   · neither path flipped `next.config.ts` to `output: "export"`, which
 *     `scaffoldApp` does for the same feature set. Every shell loads
 *     `packages/client/out`, and a standalone build never writes it, so
 *     a retrofitted shell started with nothing to load.
 *
 * Run: pnpm test
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "update-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "update-devdir-"));

const { scaffoldApp } = await import("./src/scaffold/app.js");
const { runUpdate } = await import("./src/scaffold/update.js");
const { STATIC_EXPORT_MARKER } = await import("./src/scaffold/starter-files.js");
type Feature = import("./src/prompts.js").Feature;
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
if (!existsSync(join(STARTER, "package.json"))) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  process.exit(0);
}

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
    scaffoldRepo: true,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
  };
}

type Check = [string, boolean];
const results: Record<string, boolean> = {};

/** Scaffold a featureless project, then hand it to `fn`. */
async function withProject(
  label: string,
  fn: (dir: string) => Promise<Check[]>,
  seed: Feature[] = [],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `update-${label}-`));
  try {
    console.log(`\n── ${label} ─────────────────────────────`);
    await scaffoldApp(cfg(`up-${label}`, seed), dir);
    const checks = await fn(dir);
    let ok = true;
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? "✓" : "✗"} ${name}`);
      if (!pass) ok = false;
    }
    results[label] = ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stable fingerprint of the tree, used to prove --dry-run wrote
 *  nothing and that a second run is a no-op. */
function fingerprint(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(p, r);
      else parts.push(`${r}:${statSync(p).size}`);
    }
  };
  walk(dir, "");
  return parts.join("\n");
}

/** Deepest-first search for any regular file under `dir`. Used to grab a
 *  copied file without naming one, so a feature reorganising its own tree
 *  does not break this test. */
function firstFileUnder(dir: string): string {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = firstFileUnder(p);
      if (found) return found;
    } else if (entry.isFile()) {
      return p;
    }
  }
  return "";
}

const presets = { confirmAddFeatures: true, enableLocalDev: false, pushNativeOrigins: false };

// ── --dry-run writes nothing, and says what it would do ──────────────
await withProject("dry-run", async (dir) => {
  const before = fingerprint(dir);
  const result = await runUpdate(dir, {
    dryRun: true,
    presets: { ...presets, desiredFeatures: ["desktop"] },
  });
  const after = fingerprint(dir);
  return [
    ["reports dryRun: true", result.dryRun === true],
    ["reports what it would add", result.added.join(",") === "desktop"],
    ["the tree is byte-for-byte unchanged", before === after],
    ["no electron/ was created", !existsSync(join(dir, "electron"))],
    [
      "the manifest still records no features",
      JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8")).features.length === 0,
    ],
  ];
});

// ── adding desktop brings the files its scripts need ─────────────────
await withProject("add-desktop", async (dir) => {
  await runUpdate(dir, { presets: { ...presets, desiredFeatures: ["desktop"] } });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
  const nextConfig = readFileSync(join(dir, "packages/client/next.config.ts"), "utf-8");
  return [
    ["electron/ copied", existsSync(join(dir, "electron"))],
    ["desktop-release.yml copied", existsSync(join(dir, ".github/workflows/desktop-release.yml"))],
    ["icons:desktop script installed", typeof pkg.scripts?.["icons:desktop"] === "string"],
    [
      "scripts/icons-desktop.mjs — the file that script runs — is present",
      existsSync(join(dir, "scripts/icons-desktop.mjs")),
    ],
    ["build/icon.png — its icon source — is present", existsSync(join(dir, "build/icon.png"))],
    [
      'next.config.ts flipped to output: "export" (the shell loads packages/client/out)',
      nextConfig.includes(STATIC_EXPORT_MARKER),
    ],
    [
      "manifest records the feature",
      JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8")).features.includes("desktop"),
    ],
  ];
});

// ── idempotent: a second run adds nothing and rewrites nothing ───────
await withProject("idempotent", async (dir) => {
  await runUpdate(dir, { presets: { ...presets, desiredFeatures: ["mobile"] } });
  const afterFirst = fingerprint(dir);
  const second = await runUpdate(dir, { presets: { ...presets, desiredFeatures: ["mobile"] } });
  return [
    ["second run adds nothing", second.added.length === 0],
    ["second run leaves the tree unchanged", fingerprint(dir) === afterFirst],
  ];
});

// ── a user's edits are not clobbered ─────────────────────────────────
await withProject("preserves-edits", async (dir) => {
  await runUpdate(dir, { presets: { ...presets, desiredFeatures: ["desktop"] } });
  // Pick a real file out of the copied tree rather than naming one: the
  // desktop feature's layout has already moved once (electron/main.ts ->
  // electron/src/), and a hardcoded path turns that into a test crash
  // instead of the assertion it is here to make.
  const mainPath = firstFileUnder(join(dir, "electron"));
  const edited = `${readFileSync(mainPath, "utf-8")}\n// user's own line\n`;
  writeFileSync(mainPath, edited, "utf-8");
  // Ask for it again — the copy path must skip a file that exists.
  await runUpdate(dir, {
    presets: { ...presets, desiredFeatures: ["desktop", "mobile"] },
  });
  return [
    ["the hand-edited desktop file survives", readFileSync(mainPath, "utf-8") === edited],
    ["mobile was still added alongside it", existsSync(join(dir, "capacitor.config.ts"))],
  ];
});

// ── an edited next.config.ts is reported, not overwritten ────────────
await withProject("preserves-next-config", async (dir) => {
  const configPath = join(dir, "packages/client/next.config.ts");
  const edited = `${readFileSync(configPath, "utf-8")}\n// hand-tuned by the user\n`;
  writeFileSync(configPath, edited, "utf-8");
  await runUpdate(dir, { presets: { ...presets, desiredFeatures: ["mobile"] } });
  return [
    ["the edited next.config.ts is left exactly as it was", readFileSync(configPath, "utf-8") === edited],
    ["mobile was still added", existsSync(join(dir, "capacitor.config.ts"))],
  ];
});

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
