/**
 * CI stamp harness — produces one real scaffold for the build smoke test.
 *
 * The scaffold matrix in `cli/test-scaffold.ts` asserts on *file presence*:
 * which files survived, which were deleted, how identifiers were rewritten.
 * It never compiles anything. That is precisely why the v0.2.17 "a fresh
 * scaffold cannot install or build" report got through — dangling imports,
 * a broken exports map, a bad Tailwind directive and an unset base URL are
 * all invisible to a presence check and all fatal to `pnpm run build`.
 *
 * This script exists so CI can stamp a project and then actually run
 * `pnpm install && pnpm run build && pnpm run test:unit` against it.
 *
 *   tsx scripts/ci-stamp.ts --preset <reported|commerce|web> --out <dir>
 *
 * Host safety: nothing here talks to a provider, DNS, Coolify, Terraform or
 * S3. The config sets createGithubRepo/runDeployment/installDeps to false, so
 * the only side effects are file writes under --out plus the throwaway config,
 * keychain and local-dev dirs allocated below.
 */
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolate from the real user environment BEFORE the scaffolder is loaded.
// ESM hoists static imports above statements, so `config.ts` would read the
// real preferences dir if we imported it at the top of the file. The dynamic
// import further down runs after these assignments, so they take effect.
// Same reasoning as the header of cli/test-scaffold.ts.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "ci-stamp-conf-"));
// Every scaffold mints a dotenvx private key and stashes it in the OS
// keychain. Route it to a per-process service name so a run can never read
// or clobber a real user's "hatchkit" entries. On the CI runner this lands in
// an ephemeral session keyring that dies with the job.
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-ci-${process.pid}`;
// The Tailscale local-dev integration writes Caddy fragments under
// ~/.config/dev/projects/. Redirect that root too, even though no preset here
// opts into localDev — a future preset that does must not touch the host.
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ci-stamp-devdir-"));

const { scaffoldApp } = await import("../src/scaffold/app.js");
type Feature = import("../src/prompts.js").Feature;
type EmailIntent = import("../src/prompts.js").EmailIntent;
type ProjectConfig = import("../src/prompts.js").ProjectConfig;

/** Mirrors the `cfg()` helper in cli/test-scaffold.ts: a fully populated
 *  non-interactive ProjectConfig with every network-touching flag off. */
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

const LISTMONK_SES: EmailIntent = { transactional: "none", mailingList: "listmonk-ses" };

/** Three presets, deliberately no more. Each stamp costs a full pnpm install
 *  plus a Next build, so the matrix stays at the combinations that cover the
 *  two mutually exclusive client build modes plus the conditional codegen
 *  branches that actually produced the reported breakage.
 *
 *  The split that matters is `wantsDesktop || wantsTauri || wantsMobile` in
 *  cli/src/scaffold/app.ts: when any native shell is selected, scaffoldApp
 *  calls `flipNextConfigToStaticExport()` and the client's next.config.ts is
 *  replaced with a hardcoded `output: "export"` config. Without a native
 *  shell the starter's own next.config.ts survives and the client builds
 *  `output: "standalone"` — the plain web deploy, and the configuration most
 *  projects actually ship.
 *
 *  - `reported`: the exact feature set from the bug report. Static export.
 *  - `commerce`: stripe + listmonk-ses, which exercises the opposite branch
 *    of the conditional codegen — the Stripe service files are kept, and the
 *    newsletter subscribe pages survive into a static-export client.
 *  - `web`: no native shell, so the starter's next.config.ts is left intact
 *    and the standalone build path gets compiled. Carries the full server
 *    feature set (websocket + stripe + s3 + analytics) so the server build
 *    is exercised with everything kept rather than everything pruned. */
const PRESETS: Record<string, { name: string; features: Feature[]; email?: EmailIntent }> = {
  reported: {
    name: "ci-stamp-reported",
    features: ["websocket", "s3", "analytics", "desktop", "mobile"],
  },
  commerce: {
    name: "ci-stamp-commerce",
    features: ["websocket", "stripe", "desktop", "mobile"],
    email: LISTMONK_SES,
  },
  web: {
    name: "ci-stamp-web",
    features: ["websocket", "stripe", "s3", "analytics"],
  },
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const presetName = arg("--preset") ?? "reported";
const preset = PRESETS[presetName];
if (!preset) {
  console.error(
    `Unknown --preset "${presetName}". Known presets: ${Object.keys(PRESETS).join(", ")}`,
  );
  process.exit(1);
}

const outDir = arg("--out");
if (!outDir) {
  console.error("Missing --out <dir>.");
  process.exit(1);
}

const target = resolve(outDir);
mkdirSync(target, { recursive: true });

// Fail with a pointed message rather than a stack trace when the template is
// missing. `starter/` is a plain in-repo directory, so this only fires on a
// partial checkout — or if someone runs the script from outside the monorepo.
const starter = resolve(join(import.meta.dirname, "..", "..", "starter"));
if (!existsSync(join(starter, "package.json"))) {
  console.error(`Starter template not found at ${starter}. Checkout looks incomplete.`);
  process.exit(1);
}

console.log(`Stamping preset "${presetName}" (${preset.features.join(", ")}) into ${target}`);
await scaffoldApp(
  cfg(preset.name, preset.features, preset.email ? { email: preset.email } : {}),
  target,
);
console.log(`Stamped ${preset.name} -> ${target}`);
