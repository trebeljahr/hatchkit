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
const {
  DEPLOY_WORKFLOW_REL_PATH,
  WORKFLOW_PROMOTE_STEP,
  WORKFLOW_SIGNED_DEPLOY_STEP,
  WORKFLOW_VERIFY_STEP,
  deployVerificationRetrofits,
} = await import("./src/scaffold/deploy-verification.js");
const { DEV_LAUNCHER_LIB_FILES } = await import("./src/scaffold/dev-launcher.js");
const { LINT_GATE_FILES } = await import("./src/scaffold/lint-gate.js");
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

// ── --dry-run leaves a pre-gate deploy workflow alone ────────────────
// The verification-gate retrofit was once pasted twice into runUpdate,
// and the second copy sat outside the dry-run gate. A real run never
// showed it — the first copy had already written the file — but a dry
// run on a project scaffolded before the gate rewrote its workflow.
await withProject("dry-run-pre-gate-workflow", async (dir) => {
  // The starter's workflow minus its promote and verify steps, and with
  // the token-driven deploy steps it had then, is what a project
  // scaffolded before the gate carries.
  const path = join(dir, DEPLOY_WORKFLOW_REL_PATH);
  const starterWorkflow = readFileSync(join(STARTER, DEPLOY_WORKFLOW_REL_PATH), "utf-8");
  const legacyDeploy = [
    "      - name: Deploy via Coolify API",
    "        env:",
    "          COOLIFY_BASE_URL: ${{ secrets.COOLIFY_BASE_URL }}",
    "          COOLIFY_RESOURCE_UUID: ${{ secrets.COOLIFY_RESOURCE_UUID }}",
    "          COOLIFY_API_TOKEN: ${{ secrets.COOLIFY_API_TOKEN }}",
    "        if: env.COOLIFY_BASE_URL != '' && env.COOLIFY_RESOURCE_UUID != ''",
    '        run: curl -fsSL -X POST "$COOLIFY_BASE_URL/api/v1/deploy?uuid=$COOLIFY_RESOURCE_UUID"',
    "",
    "      - name: Deploy via webhook (fallback)",
    "        env:",
    "          COOLIFY_WEBHOOK_URL: ${{ secrets.COOLIFY_WEBHOOK_URL }}",
    "        if: env.COOLIFY_WEBHOOK_URL != ''",
    '        run: curl -fsSL "$COOLIFY_WEBHOOK_URL"',
    "",
  ].join("\n");
  const preGate = starterWorkflow
    .replace(`${WORKFLOW_PROMOTE_STEP}\n`, "")
    .replace(WORKFLOW_SIGNED_DEPLOY_STEP, legacyDeploy)
    .replace(`\n\n${WORKFLOW_VERIFY_STEP.replace(/\n+$/, "")}\n`, "");
  writeFileSync(path, preGate, "utf-8");
  const manifest = JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8"));
  const workflowRetrofit = deployVerificationRetrofits(
    manifest.domain,
    manifest.topology,
    manifest.surfaces,
    manifest.features,
  ).find(([, rel]) => rel === DEPLOY_WORKFLOW_REL_PATH)?.[2];
  await runUpdate(dir, {
    dryRun: true,
    presets: { ...presets, desiredFeatures: manifest.features },
  });
  return [
    [
      "the fixture lacks the promote and verify steps",
      !preGate.includes("- name: Promote this commit") &&
        !preGate.includes("Verify the deployment is actually live"),
    ],
    [
      "a real run would retrofit the fixture",
      workflowRetrofit !== undefined && workflowRetrofit(preGate) !== preGate,
    ],
    ["the workflow is byte-for-byte unchanged", readFileSync(path, "utf-8") === preGate],
  ];
});

// ── --dry-run leaves a pre-lint-gate project alone ───────────────────
// The base-infrastructure retrofit (dev-launcher helpers + lint gate)
// runs outside the dry-run gate so it can report, and once copied its
// files and wrote the root scripts on a dry run too. A freshly
// scaffolded project already carries all of it, so the `dry-run` case
// above never saw the writes.
await withProject("dry-run-pre-lint-gate", async (dir) => {
  const gateFile = LINT_GATE_FILES[0];
  const launcherFile = DEV_LAUNCHER_LIB_FILES[0];
  const scaffolded = existsSync(join(dir, gateFile)) && existsSync(join(dir, launcherFile));
  rmSync(join(dir, gateFile));
  rmSync(join(dir, launcherFile));
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const hadLint = typeof pkg.scripts?.lint === "string";
  delete pkg.scripts.lint;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  const pkgBefore = readFileSync(pkgPath, "utf-8");
  const manifest = JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8"));
  const updatePresets = { ...presets, desiredFeatures: manifest.features };

  const before = fingerprint(dir);
  await runUpdate(dir, { dryRun: true, presets: updatePresets });
  const after = fingerprint(dir);
  const dryRunChecks: Check[] = [
    ["the fixture started with the files and the lint script", scaffolded && hadLint],
    ["the tree is byte-for-byte unchanged", before === after],
    [`${gateFile} was not copied`, !existsSync(join(dir, gateFile))],
    [`${launcherFile} was not copied`, !existsSync(join(dir, launcherFile))],
    ["package.json is byte-for-byte unchanged", readFileSync(pkgPath, "utf-8") === pkgBefore],
  ];

  // A real run on the same tree restores all three, so the dry run
  // above had something to skip.
  await runUpdate(dir, { presets: updatePresets });
  return [
    ...dryRunChecks,
    [`a real run copies ${gateFile}`, existsSync(join(dir, gateFile))],
    [`a real run copies ${launcherFile}`, existsSync(join(dir, launcherFile))],
    [
      "a real run writes the root lint script",
      typeof JSON.parse(readFileSync(pkgPath, "utf-8")).scripts?.lint === "string",
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
    [
      "the edited next.config.ts is left exactly as it was",
      readFileSync(configPath, "utf-8") === edited,
    ],
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
