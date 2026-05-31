#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import {
  ensureCoolify,
  ensureDns,
  ensureGitHub,
  ensureHetzner,
  ensureS3,
  getConfig,
  getConfigPath,
  getCoolifyConfig,
  getGhcrConfig,
  getMlServices,
  isFirstRun,
  reconfigureProvider,
  resetConfig,
  runOnboarding,
} from "./config.js";
import { runCoolifySetup } from "./deploy/coolify.js";
import { setupGitHub } from "./deploy/github.js";
import { deployMlServices } from "./deploy/gpu.js";
import {
  pushProjectKeyToCoolify,
  pushProjectKeyToGh,
  rotateProjectKey,
  setProjectKey,
  showProjectKey,
} from "./deploy/keys.js";
import { handleCreateFailure, runRollback } from "./deploy/rollback.js";
import { requireCloudflareZoneForTerraform, runTerraform } from "./deploy/terraform.js";
import { type GpuPlatform, type ProjectConfig, collectProjectConfig } from "./prompts.js";
import {
  type ProvisionService,
  type ProvisionedEvent,
  type SurfaceMode,
  runProvision,
  runUnprovision,
} from "./provision/index.js";
import { scaffoldApp } from "./scaffold/app.js";
import { scaffoldInfra } from "./scaffold/infra.js";
import { type ProjectManifest, readManifest } from "./scaffold/manifest.js";
import { mlEnvVarName, printMlSummary, resolveMlServices } from "./scaffold/ml-client.js";
import { runUpdate } from "./scaffold/update.js";
import {
  installCancelHandler,
  isCancelInProgress,
  uninstallCancelHandler,
} from "./utils/cancel-handler.js";
import { exec, execOk } from "./utils/exec.js";
import { parseCreateFlags } from "./utils/flags.js";
import { RunLedger } from "./utils/run-ledger.js";
import { SECRET_KEYS } from "./utils/secrets.js";
import { getCliVersion } from "./utils/version.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

// Resolve the monorepo root. From both `cli/src/index.ts` (tsx) and
// `cli/dist/index.js` (compiled), two parent hops land at the worktree.
// STARTER_ROOT is resolved inside scaffold/app.ts (not here) — it's
// only needed from that module.
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", ".."));
const INFRA_ROOT = join(MONOREPO_ROOT, "infra");
const SERVICES_ROOT = join(MONOREPO_ROOT, "services");

async function main(): Promise<void> {
  // --version / -v short-circuit before the banner and any config work.
  if (command === "--version" || command === "-v") {
    console.log(getCliVersion());
    return;
  }

  const isJson = args.includes("--json");

  // Suppress the banner for machine-readable output so stdout is pure JSON.
  if (!isJson) {
    console.log(chalk.bold(`\n  hatchkit v${getCliVersion()}\n`));
  }

  // Global --help / help subcommand (with optional topic).
  if (command === "--help" || command === "-h" || command === "help") {
    const topic = command === "help" ? (args[1] as HelpTopic | undefined) : undefined;
    printHelp(topic);
    return;
  }

  switch (command) {
    case "init":
    case "setup":
      if (args.includes("--help")) return printHelp("setup");
      await runOnboarding();
      break;
    case "config":
      if (args.includes("--help") && args.length === 2) return printHelp("config");
      await handleConfig();
      break;
    case "status": {
      if (args.includes("--help")) return printHelp("status");
      const { collectStatus, renderStatusHuman } = await import("./status.js");
      const s = collectStatus();
      if (isJson) {
        console.log(JSON.stringify(s, null, 2));
      } else {
        console.log(renderStatusHuman(s));
      }
      break;
    }
    case "explain": {
      if (args.includes("--help")) return printHelp("explain");
      const { renderExplain } = await import("./explain.js");
      console.log(renderExplain({ json: isJson }));
      break;
    }
    case "completion": {
      if (args.includes("--help")) return printHelp("completion");
      const { renderCompletion } = await import("./completion.js");
      const shell = (args[1] ?? "").toLowerCase();
      if (shell !== "zsh" && shell !== "bash" && shell !== "fish") {
        console.log("Usage: hatchkit completion <zsh|bash|fish>");
        process.exit(1);
      }
      console.log(renderCompletion(shell));
      break;
    }
    case "create":
      if (args.includes("--help")) return printHelp("create");
      await handleCreate();
      break;
    case undefined:
      await handleNoArgs();
      break;
    case "update":
      if (args.includes("--help")) return printHelp("update");
      await handleUpdate();
      break;
    case "server":
      if (args.includes("--help") && args.length === 2) return printHelp("server");
      await handleServer();
      break;
    case "keys":
      if (args.includes("--help") && args.length === 2) return printHelp("keys");
      await handleKeys();
      break;
    case "secrets":
      if (args.includes("--help") && args.length === 2) return printHelp("secrets");
      await handleSecrets();
      break;
    case "add":
      if (args.includes("--help")) return printHelp("add");
      await handleAdd();
      break;
    case "remove":
      if (args.includes("--help")) return printHelp("remove");
      await handleRemove();
      break;
    case "adopt": {
      if (args.includes("--help")) return printHelp("adopt");
      const { runAdopt } = await import("./adopt.js");
      await runAdopt(resolve("."), {
        resume: args.includes("--resume"),
        regeneratePipeline: args.includes("--regenerate-pipeline"),
      });
      break;
    }
    case "destroy":
      if (args.includes("--help")) return printHelp("destroy");
      await handleDestroy();
      break;
    case "rename-domain": {
      if (args.includes("--help")) return printHelp("rename-domain");
      const { runRenameDomainCli } = await import("./deploy/rename-domain.js");
      await runRenameDomainCli(args.slice(1), MONOREPO_ROOT);
      break;
    }
    case "set-description": {
      if (args.includes("--help")) return printHelp("set-description");
      const { runSetDescriptionCli } = await import("./deploy/set-description.js");
      await runSetDescriptionCli(args.slice(1));
      break;
    }
    case "rename-project": {
      if (args.includes("--help")) return printHelp("rename-project");
      const { runRenameProjectCli } = await import("./deploy/rename-project.js");
      await runRenameProjectCli(args.slice(1), MONOREPO_ROOT);
      break;
    }
    case "sync": {
      if (args.includes("--help")) return printHelp("sync");
      const { runSyncCli } = await import("./deploy/sync.js");
      await runSyncCli(args.slice(1));
      break;
    }
    case "regen-infra": {
      if (args.includes("--help")) return printHelp("regen-infra");
      const { runRegenInfraCli } = await import("./deploy/regen-infra.js");
      await runRegenInfraCli(args.slice(1), MONOREPO_ROOT);
      break;
    }
    case "doctor": {
      if (args.includes("--help")) return printHelp("doctor");
      const { runDoctor } = await import("./doctor.js");
      await runDoctor({ json: isJson });
      break;
    }
    case "dev-setup": {
      if (args.includes("--help")) return printHelp("dev-setup");
      const { runDevSetupCli } = await import("./dev-setup.js");
      await runDevSetupCli(args.slice(1));
      break;
    }
    case "overview": {
      if (args.includes("--help")) return printHelp("overview");
      const { runOverview } = await import("./overview.js");
      await runOverview({ json: isJson, all: args.includes("--all") });
      break;
    }
    case "inventory": {
      if (args.includes("--help")) return printHelp("inventory");
      const { runInventory } = await import("./inventory.js");
      const nameFlag = flagValue("--name");
      const domainFlag = flagValue("--domain");
      const repoFlag = flagValue("--repo");
      const inputOverride: { name?: string; domain?: string; repo?: string } = {};
      if (nameFlag) inputOverride.name = nameFlag;
      if (domainFlag) inputOverride.domain = domainFlag;
      if (repoFlag) inputOverride.repo = repoFlag;
      await runInventory(resolve("."), {
        json: isJson,
        yes: args.includes("--yes") || args.includes("-y"),
        save: args.includes("--save"),
        noSave: args.includes("--no-save"),
        input: Object.keys(inputOverride).length > 0 ? inputOverride : undefined,
      });
      break;
    }
    case "provision": {
      const sub = args[1];
      if (sub === "s3") {
        await handleProvisionS3();
        break;
      }
      console.log("Usage: hatchkit provision s3 [flags]");
      console.log("Provisions S3/R2 buckets for the project in the current directory.\n");
      console.log("Flags:");
      console.log("  --assets-bucket <name>     Override default <project>-assets name");
      console.log("  --with-state-bucket        Also create the private <project>-state bucket");
      console.log(
        "  --state-bucket <name>      Create state bucket with this name (implies --with-state-bucket)",
      );
      console.log(
        "  --public-hostname <host>   Custom domain for the assets bucket (default s3.<domain>)",
      );
      console.log(
        "  --no-custom-domain         Skip custom-domain attempt; use the managed r2.dev URL",
      );
      console.log("  --env-prefix R2|S3|AWS     Override auto-detected env-var prefix");
      console.log("  --no-cron-secret           Skip CRON_SECRET generation");
      console.log(
        "  --cors-origin <url>        Add an origin to the assets-bucket CORS rule (repeatable)",
      );
      console.log(
        '  --cors-allow-all           Set CORS origins to ["*"] (mutually exclusive with --cors-origin)',
      );
      console.log("  --no-cors                  Skip the CORS reconcile step entirely");
      process.exit(1);
      break;
    }
    case "assets": {
      if (args.includes("--help") && args.length === 2) {
        printHelp("assets");
        break;
      }
      const { handleAssets } = await import("./assets/index.js");
      const code = await handleAssets(args.slice(1));
      if (code !== 0) process.exit(code);
      break;
    }
    case "dns": {
      if (args.includes("--help")) return printHelp("dns");
      await handleDns();
      break;
    }
    case "email": {
      if (args.includes("--help") && args.length === 2) return printHelp("email");
      const { handleEmailCommand } = await import("./email/index.js");
      await handleEmailCommand(args.slice(1));
      break;
    }
    case "ses": {
      await handleSesCommand(args.slice(1));
      break;
    }
    case "gh-pages":
    case "pages": {
      if (args.includes("--help")) return printHelp("gh-pages");
      if (command === "pages") {
        console.log(
          chalk.yellow("  Note: `hatchkit pages` has been renamed to `hatchkit gh-pages`."),
        );
      }
      if (args.includes("--undo")) {
        const { runPagesUndo } = await import("./deploy/pages.js");
        await runPagesUndo(resolve("."), {
          dryRun: args.includes("--dry-run"),
          yes: args.includes("--yes") || args.includes("-y"),
        });
        break;
      }
      const { runPagesSetup } = await import("./deploy/pages.js");
      await runPagesSetup(resolve("."));
      break;
    }
    default:
      printHelp();
  }
}

/** No-args: show the status-aware menu. If stdin is a TTY, also offer
 *  to kick off the most likely next step (setup or create). Agents
 *  running non-interactively just get the menu + exit 0. */
async function handleNoArgs(): Promise<void> {
  const { collectStatus, renderMenu } = await import("./status.js");
  const s = collectStatus();
  console.log(renderMenu(s));

  if (!process.stdin.isTTY) return;

  const hasCore =
    s.providers.find((p) => p.key === "coolify")?.configured &&
    s.providers.find((p) => p.key === "hetzner")?.configured &&
    s.providers.find((p) => p.key === "dns")?.configured &&
    s.providers.find((p) => p.key === "github")?.configured;

  if (!hasCore) {
    const ok = await confirm({ message: "Run `hatchkit setup` now?", default: true });
    if (ok) await runOnboarding();
    return;
  }
  const ok = await confirm({
    message: "Scaffold a new project now (`hatchkit create`)?",
    default: true,
  });
  if (ok) await handleCreate();
}

async function handleKeys(): Promise<void> {
  const sub = args[1];
  const projectName = args[2];
  if (!sub || !projectName) {
    console.log("Usage: hatchkit keys <show|set|rotate|push> <project-name> [flags]");
    process.exit(1);
  }
  const isJson = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const keyFlag = flagValue("--key");
  // The legacy `keys push` had no `--target` and always meant Coolify
  // — keep that for back-compat. Anything explicit (`--target=gh|both`)
  // overrides the default.
  const target = (flagValue("--target") ?? "coolify") as "coolify" | "gh" | "both";
  if (!["coolify", "gh", "both"].includes(target)) {
    console.log(`Invalid --target=${target}. Valid: coolify, gh, both`);
    process.exit(1);
  }
  const pushCoolify = args.includes("--push-coolify");
  const pushGh = flagValue("--push-gh");
  const repoArg = flagValue("--repo");

  switch (sub) {
    case "show":
      await showProjectKey(projectName, { json: isJson });
      break;
    case "set": {
      // `--stdin` is explicit. We avoid auto-detecting via
      // `!process.stdin.isTTY` because npm/pnpm wrappers (and CI
      // runners) replace stdin even when the user didn't pipe
      // anything — that would falsely trigger a "stdin is empty" error
      // and skip the autoread-from-`.env.keys` default.
      const fromStdin = args.includes("--stdin");
      const result = await setProjectKey(projectName, {
        key: keyFlag,
        fromStdin,
        dryRun,
      });
      if (isJson) {
        process.stdout.write(`${JSON.stringify({ project: projectName, ...result })}\n`);
        return;
      }
      const verb = result.written ? "Updated" : result.changed ? "Would update" : "No change —";
      const sourceLabel =
        result.source === "flag"
          ? "--key flag"
          : result.source === "stdin"
            ? "stdin"
            : `${result.envKeysPath}`;
      console.log(chalk.green(`  ${verb} keychain entry ${chalk.cyan(result.account)}`));
      console.log(chalk.dim(`  source: ${sourceLabel}`));
      if (!result.changed) {
        console.log(chalk.dim("  (keychain already held this value)"));
      }
      break;
    }
    case "rotate": {
      // Default is propagate-everywhere — the prior bug pattern (rotate
      // locally, forget Coolify + GHA, runtime decrypt fails silently)
      // is too easy to hit if push is opt-in. `--no-push` exists for
      // the rare "I want to rotate but not propagate yet" case.
      // Legacy `--push-coolify` is accepted as a no-op (still default).
      const noPush = args.includes("--no-push");
      const result = await rotateProjectKey(projectName, {
        noPush,
        ghRepo: pushGh,
        dryRun,
      });
      if (isJson) {
        process.stdout.write(`${JSON.stringify({ project: projectName, ...result })}\n`);
        return;
      }
      if (dryRun) {
        console.log(chalk.yellow("  --dry-run — nothing was rotated."));
      } else {
        console.log(chalk.green(`  Rotated dotenvx keypair for ${result.envProductionPath}`));
        if (result.prunedStaleKeys > 0) {
          console.log(
            chalk.dim(
              `  Pruned ${result.prunedStaleKeys} stale key${result.prunedStaleKeys === 1 ? "" : "s"} from .env.keys`,
            ),
          );
        }
        console.log(chalk.green(`  Updated keychain entry ${chalk.cyan(result.set.account)}`));
      }
      if (result.pushedCoolify) {
        console.log(chalk.green(`  Pushed to Coolify (${result.pushedCoolify.uuid})`));
      } else if (result.skippedCoolify) {
        console.log(chalk.dim(`  Coolify push skipped (${result.skippedCoolify})`));
      }
      if (result.pushedGh) {
        console.log(chalk.green(`  Pushed to GitHub repo ${result.pushedGh.repo}`));
      } else if (result.skippedGh) {
        console.log(chalk.dim(`  GitHub push skipped (${result.skippedGh})`));
      }
      // Silence the `pushCoolify` / `pushGh` reads so unused-var lint
      // stays quiet — they're parsed for back-compat but no longer act.
      void pushCoolify;
      break;
    }
    case "push": {
      const repo = repoArg ?? (target === "coolify" ? undefined : await detectRepoSlug());
      if ((target === "gh" || target === "both") && !repo) {
        throw new Error("Couldn't infer GitHub repo for --target=gh. Pass --repo <owner/repo>.");
      }
      if (target === "coolify" || target === "both") {
        await pushProjectKeyToCoolify(projectName);
      }
      if (target === "gh" || target === "both") {
        await pushProjectKeyToGh(projectName, repo!);
      }
      break;
    }
    default:
      console.log(`Unknown keys subcommand: ${sub}`);
      console.log("Valid: show, set, rotate, push");
      process.exit(1);
  }
}

/** `hatchkit secrets <sub> <project>` dispatch. Only `rotate` is wired
 *  today — the orchestrator at `./secrets/orchestrator.ts` owns every
 *  upstream call, env-file write, deploy-target push, keychain rollback
 *  bookkeeping, and audit emission. This handler is intentionally thin:
 *  parse flags, run the orchestrator, exit. Modeled after `handleKeys`. */
async function handleSecrets(): Promise<void> {
  const sub = args[1];
  if (!sub) {
    console.log("Usage: hatchkit secrets rotate <project-name> [flags]");
    process.exit(1);
  }

  switch (sub) {
    case "rotate": {
      if (args.includes("--help")) return printHelp("secrets");
      const projectName = args[2];
      if (!projectName || projectName.startsWith("--")) {
        console.log("Usage: hatchkit secrets rotate <project-name> [flags]");
        process.exit(1);
      }

      const isJson = args.includes("--json");
      const dryRun = args.includes("--dry-run");

      // `--env` is reserved for future scoping; only `production` is
      // supported today (Coolify + gh secrets are production-only).
      const envFlag = (flagValue("--env") ?? "production").toLowerCase();
      if (envFlag !== "production") {
        console.log(`Invalid --env=${envFlag}. Only 'production' is supported today.`);
        process.exit(1);
      }

      // Lazy-import so the registry side-effects (adapter registration
      // via the barrel) only run when the user actually invokes this
      // path. Matches the lazy-import convention used elsewhere in
      // this router (doctor, inventory, overview, dns, email, ...).
      const { runSecretsRotate } = await import("./secrets/orchestrator.js");
      const { all: listAdapters } = await import("./secrets/registry.js");

      // `--providers` is a comma list of adapter names, or 'all'.
      // Validated against the live registry so a typo errors cleanly
      // rather than silently rotating zero adapters.
      const providersFlag = flagValue("--providers");
      let only: string[] | undefined;
      if (providersFlag && providersFlag.toLowerCase() !== "all") {
        const requested = providersFlag
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const known = new Set(listAdapters().map((a) => a.name));
        const unknown = requested.filter((n) => !known.has(n));
        if (unknown.length > 0) {
          console.log(
            `Unknown --providers entries: ${unknown.join(", ")}. ` +
              `Known: ${[...known].join(", ") || "(none registered)"}.`,
          );
          process.exit(1);
        }
        only = requested;
      }

      // `--push-targets` is a comma list of coolify|gh|github, or 'both'.
      // 'github' is accepted as a friendly alias for the canonical 'gh'.
      const pushTargetsFlag = flagValue("--push-targets");
      let pushTargets: ("coolify" | "gh")[] | undefined;
      let noPush = false;
      if (pushTargetsFlag) {
        const raw = pushTargetsFlag.toLowerCase();
        if (raw === "both") {
          pushTargets = ["coolify", "gh"];
        } else if (raw === "none") {
          noPush = true;
        } else {
          const requested = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const normalized = requested.map((t) => (t === "github" ? "gh" : t));
          const valid = new Set(["coolify", "gh"]);
          const invalid = normalized.filter((t) => !valid.has(t));
          if (invalid.length > 0) {
            console.log(
              `Invalid --push-targets entries: ${invalid.join(", ")}. ` +
                "Valid: coolify, gh, github, both, none.",
            );
            process.exit(1);
          }
          pushTargets = normalized as ("coolify" | "gh")[];
        }
      }

      // `--revoke-old=after-verify|never|immediate`. Default
      // `after-verify` matches the orchestrator's default and the
      // safety-guards section of the design.
      const revokeFlag = (flagValue("--revoke-old") ?? "after-verify").toLowerCase();
      const validRevoke = new Set(["after-verify", "never", "immediate"]);
      if (!validRevoke.has(revokeFlag)) {
        console.log(`Invalid --revoke-old=${revokeFlag}. Valid: after-verify, never, immediate.`);
        process.exit(1);
      }
      const revokePolicy = revokeFlag as "after-verify" | "never" | "immediate";

      const ghRepo = flagValue("--push-gh") ?? flagValue("--repo");

      try {
        await runSecretsRotate({
          projectName,
          projectDir: resolve("."),
          dryRun,
          noPush,
          pushTargets,
          revokePolicy,
          only,
          json: isJson,
          ghRepo,
        });
      } catch (err) {
        // Orchestrator throws on captureOld/createNew failures (rollback
        // blob preserved) and on the pre-flight guards
        // (assertManifest, assertEnvKeysNotTracked). Surface the
        // already-redacted message and exit non-zero so CI catches it.
        const message = err instanceof Error ? err.message : String(err);
        if (isJson) {
          process.stdout.write(`${JSON.stringify({ project: projectName, error: message })}\n`);
        } else {
          console.error(chalk.red(`  ${message}`));
        }
        process.exit(1);
      }
      break;
    }
    default:
      console.log(`Unknown secrets subcommand: ${sub}`);
      console.log("Valid: rotate");
      process.exit(1);
  }
}

/** `--flag=value` or `--flag value` lookup. Returns undefined when
 *  absent. The first form is preferred in user-facing examples (no
 *  ambiguity with positional args), but both forms parse cleanly. */
function flagValue(name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

function provisionSurfaceModeFromManifest(manifest: ProjectManifest | null): SurfaceMode {
  if (manifest?.surfaces === "backend") return "backend";
  if (manifest?.surfaces === "static") return "static";
  if (manifest?.surfaces === "split") return "split";
  return "fullstack";
}

/** Resolve the GitHub `owner/repo` slug from the cwd's git origin.
 *  Returns undefined when no remote is set or it's not a GitHub URL. */
async function detectRepoSlug(): Promise<string | undefined> {
  const { repoSlugFromRemote } = await import("./deploy/gh-actions-secrets.js");
  const res = await exec("git", ["remote", "get-url", "origin"], { silent: true });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
}

/** Walk up from `serverEnvDir` looking for the closest `.hatchkit.json`,
 *  capped at 4 levels so we never escape a project tree. Used by the
 *  non-interactive `hatchkit add` path to find the manifest without
 *  forcing the user to pass `--project-dir` explicitly when the env
 *  dir already lives inside the project (`packages/server`,
 *  `apps/web`, etc.). Returns undefined when no manifest is found —
 *  callers fall back to "skip s3" with a hint. */
function inferProjectDir(startDir: string | undefined): string | undefined {
  if (!startDir) return undefined;
  let cur = startDir;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(cur, ".hatchkit.json"))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return undefined;
}

function looksLikeProjectDir(dir: string): boolean {
  return [
    "package.json",
    ".git",
    "CNAME",
    "public/CNAME",
    "static/CNAME",
    "docs/CNAME",
    "site/CNAME",
  ].some((relPath) => existsSync(join(dir, relPath)));
}

async function promptForProjectDir(baseName: string): Promise<string> {
  const { input } = await import("@inquirer/prompts");
  const namedProjectDir = resolve(baseName);
  const defaultDir = existsSync(namedProjectDir)
    ? `./${baseName}`
    : looksLikeProjectDir(process.cwd())
      ? "."
      : `./${baseName}`;
  const answer = await input({
    message: "Project directory (relative to cwd):",
    default: defaultDir,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Enter a project directory.";
      const abs = resolve(trimmed);
      return existsSync(abs) ? true : `No such directory: ${abs}`;
    },
  });
  return resolve(answer.trim());
}

function manifestBucketEntries(
  manifest: ProjectManifest | null,
): Array<{ name: string; tokenId?: string }> {
  const buckets = manifest?.s3Buckets;
  if (!buckets) return [];
  const out: Array<{ name: string; tokenId?: string }> = [];
  for (const [key, value] of Object.entries(buckets)) {
    if (key === "tokenId" || key === "accountId") continue;
    if (value && typeof value === "object" && "name" in value) {
      out.push(value as { name: string; tokenId?: string });
    }
  }
  return out;
}

function readIfExists(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function readProjectEnvText(projectDir: string | undefined, baseName: string | undefined): string {
  const chunks: string[] = [];
  if (projectDir) {
    for (const dir of [
      ".",
      "packages/server",
      "packages/client",
      "packages/web",
      "apps/server",
      "apps/api",
      "apps/web",
      "apps/client",
      "server",
      "client",
      "web",
    ]) {
      const abs = resolve(projectDir, dir);
      chunks.push(readIfExists(join(abs, ".env.production")));
      chunks.push(readIfExists(join(abs, ".env.development")));
    }
  }
  if (baseName) {
    const provisionedDir = join(dirname(getConfigPath()), "provisioned");
    if (existsSync(provisionedDir)) {
      for (const file of readdirSync(provisionedDir)) {
        if (file.startsWith(`${baseName}.`) && file.endsWith(".env")) {
          chunks.push(readIfExists(join(provisionedDir, file)));
        }
      }
    }
  }
  return chunks.join("\n");
}

function servicesAlreadyAdded(args: {
  baseName?: string;
  projectDir?: string;
  manifest: ProjectManifest | null;
}): Set<ProvisionService> {
  const text = readProjectEnvText(args.projectDir, args.baseName);
  const added = new Set<ProvisionService>();
  if (/(^|\n)(PUBLIC_)?GLITCHTIP_DSN=/m.test(text)) added.add("glitchtip");
  if (/(^|\n)(PUBLIC_)?OPENPANEL_CLIENT_ID=/m.test(text)) added.add("openpanel");
  if (/(^|\n)(NEXT_PUBLIC_|PUBLIC_)?PLAUSIBLE_DOMAIN=/m.test(text)) added.add("plausible");
  if (/(^|\n)LISTMONK_URL=/m.test(text) && /(^|\n)SES_SMTP_HOST=/m.test(text)) {
    added.add("listmonk-ses");
  }
  if (/(^|\n)R2(_[A-Z0-9]+)?_ACCESS_KEY_ID=/m.test(text)) added.add("s3");
  if (manifestBucketEntries(args.manifest).some((bucket) => bucket.tokenId)) added.add("s3");
  if (args.manifest?.integrations?.email) added.add("email");
  if (args.manifest?.integrations?.searchConsole) added.add("search-console");
  return added;
}

function servicesImpossibleForProject(manifest: ProjectManifest | null): Set<ProvisionService> {
  const blocked = new Set<ProvisionService>();
  if (!manifest) return blocked;
  if (!manifest.domain) {
    blocked.add("email");
  }
  if (manifest.surfaces === "backend") blocked.add("plausible");
  if (manifest.surfaces === "static") {
    blocked.add("listmonk-ses");
    blocked.add("s3");
  }
  if (manifestBucketEntries(manifest).length === 0) blocked.add("s3");
  return blocked;
}

function addPositionals(rawArgs: string[]): string[] {
  const valueFlags = new Set([
    "--server-dir",
    "--client-dir",
    "--project-dir",
    "--domain",
    "--name",
    "--surfaces",
  ]);
  const positional: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  return positional;
}

function recordProvisionedEvent(ledger: RunLedger, event: ProvisionedEvent): void {
  if (event.service === "glitchtip") ledger.record({ kind: "glitchtip", project: event.project });
  if (event.service === "openpanel") ledger.record({ kind: "openpanel", project: event.project });
  if (event.service === "plausible" && event.created) {
    ledger.record({ kind: "plausible", project: event.project });
  }
  if (event.service === "sesDomain") {
    ledger.record({ kind: "sesDomain", domain: event.domain });
  }
  if (
    event.service === "sesDns" &&
    (event.createdRecords.length > 0 || event.mergedSpf.length > 0)
  ) {
    ledger.record({
      kind: "sesDns",
      domainName: event.domainName,
      zoneId: event.zoneId,
      zoneName: event.zoneName,
      records: event.createdRecords,
      mergedSpf: event.mergedSpf,
    });
  }
  if (event.service === "sesMailFromConfigured") {
    // MAIL FROM DNS records reuse the generic cloudflareDnsRecord
    // ledger kind so destroy / rollback paths already handle deletion.
    // Only entries this run *created* land here — the orchestrator
    // pre-filters updates + unchanged rows out of `createdRecords`.
    for (const r of event.createdRecords) {
      ledger.record({
        kind: "cloudflareDnsRecord",
        zoneId: event.zoneId,
        recordId: r.id,
        name: r.name,
        type: r.type,
      });
    }
  }
  if (event.service === "listmonkList" && event.createdThisRun) {
    ledger.record({
      kind: "listmonkList",
      listmonkUrl: event.listmonkUrl,
      listName: event.listName,
      listId: event.listId,
    });
  }
  if (event.service === "s3" && event.minted) {
    ledger.record({
      kind: "r2Token",
      tokenId: event.tokenId,
      accountId: event.accountId,
      audience: "account",
    });
  }
  if (event.service === "search-console" && event.dnsRecord?.created) {
    ledger.record({
      kind: "cloudflareDnsRecord",
      zoneId: event.dnsRecord.zoneId,
      recordId: event.dnsRecord.id,
      name: event.dnsRecord.name,
      type: event.dnsRecord.type,
    });
  }
  if (event.service === "dotenvxKey") {
    ledger.record({ kind: "keychain", account: event.account });
  }
  if (event.service === "email") {
    if (event.destinationCreatedThisRun) {
      ledger.record({
        kind: "cloudflareEmailDestination",
        accountId: event.accountId,
        destinationId: event.destinationId,
        email: event.destinationEmail,
      });
    }
    for (const dns of event.dnsRecords) {
      ledger.record({
        kind: "cloudflareDnsRecord",
        zoneId: event.zoneId,
        recordId: dns.id,
        name: dns.name,
        type: dns.type,
      });
    }
    for (const rule of event.rules) {
      if (!rule.created) continue;
      ledger.record({
        kind: "cloudflareEmailRoutingRule",
        zoneId: event.zoneId,
        ruleId: rule.id,
        address: rule.address,
      });
    }
  }
}

async function handleAdd(): Promise<void> {
  // Positional args are optional — anything missing is prompted for.
  //   hatchkit add                             (fully interactive)
  //   hatchkit add raptor-runner               (prompts for services)
  //   hatchkit add raptor-runner all
  //   hatchkit add raptor-runner glitchtip,listmonk-ses
  const allServices: ProvisionService[] = [
    "glitchtip",
    "openpanel",
    "plausible",
    "listmonk-ses",
    "s3",
    "email",
    "search-console",
  ];
  const isServiceExpr = (value: string | undefined): boolean => {
    if (!value) return false;
    if (value === "all") return true;
    return value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .every((s) => (allServices as readonly string[]).includes(s));
  };

  const nameFlag = flagValue("--name");
  const domainFlag = flagValue("--domain");
  const serverDirFlag = flagValue("--server-dir");
  const clientDirFlag = flagValue("--client-dir");
  const projectDirFlag = flagValue("--project-dir");
  const surfaceFlag = flagValue("--surfaces");
  const projectDirFromFlag = projectDirFlag ? resolve(projectDirFlag) : undefined;
  if (projectDirFromFlag && !existsSync(projectDirFromFlag)) {
    console.log(chalk.red(`  --project-dir does not exist: ${projectDirFromFlag}`));
    process.exit(1);
  }

  const positional = addPositionals(args.slice(1));
  const firstArgIsService = isServiceExpr(positional[0]);
  const positionalProjectName = firstArgIsService ? undefined : positional[0];
  let inferredProjectDir =
    projectDirFromFlag ??
    (positionalProjectName && existsSync(resolve(positionalProjectName))
      ? resolve(positionalProjectName)
      : inferProjectDir(process.cwd()));
  let inferredManifest = inferredProjectDir ? readManifest(inferredProjectDir) : null;
  let baseName = positionalProjectName ?? nameFlag ?? inferredManifest?.name;
  const rawService = firstArgIsService ? positional[0] : positional[1];

  if (!baseName) {
    if (!process.stdin.isTTY) {
      console.log(chalk.red("  Project name is required. Pass <project-name> or --name <name>."));
      process.exit(1);
    }
    const { input } = await import("@inquirer/prompts");
    const { validateProjectName } = await import("./utils/validate.js");
    baseName = await input({
      message: "Project name (e.g. raptor-runner):",
      validate: validateProjectName,
    });
  }

  if (!inferredProjectDir) {
    const namedProjectDir = resolve(baseName);
    if (existsSync(namedProjectDir)) {
      inferredProjectDir = namedProjectDir;
      inferredManifest = readManifest(namedProjectDir);
    }
  }

  const alreadyAdded = servicesAlreadyAdded({
    baseName,
    projectDir: inferredProjectDir,
    manifest: inferredManifest,
  });
  const impossible = servicesImpossibleForProject(inferredManifest);
  const rerunnableServices = new Set<ProvisionService>(["search-console"]);
  const addableServices = allServices.filter(
    (service) => !alreadyAdded.has(service) && !impossible.has(service),
  );

  let services: ProvisionService[];
  if (!rawService) {
    if (addableServices.length === 0) {
      console.log(
        chalk.green(`  Nothing to add — ${baseName} already has every supported service.`),
      );
      return;
    }
    const { multiselect } = await import("./utils/multiselect.js");
    // Listmonk + SES is reached via the opinionated email-intent
    // prompt below, not the generic service multi-select. The order
    // here is: ask email-intent first (only when the listmonk-ses
    // service is still addable), then the multi-select for the
    // remaining non-email services.
    const emailServicesAddable: ProvisionService[] = (
      ["listmonk-ses"] as ProvisionService[]
    ).filter((s) => addableServices.includes(s));
    let emailIntentServices: ProvisionService[] = [];
    if (emailServicesAddable.length > 0) {
      const { askEmailIntent, emailIntentToProvisionServices } = await import("./prompts.js");
      const intent = await askEmailIntent({
        current: inferredManifest?.email,
      });
      emailIntentServices = emailIntentToProvisionServices(intent).filter((s) =>
        emailServicesAddable.includes(s),
      );
    }
    const serviceChoices: Array<{ name: string; value: ProvisionService; checked: boolean }> = [
      { name: "GlitchTip (error tracking)", value: "glitchtip", checked: false },
      { name: "OpenPanel (product analytics)", value: "openpanel", checked: false },
      { name: "Plausible (web analytics)", value: "plausible", checked: false },
      {
        name: "S3 / R2 (per-bucket scoped credentials from .hatchkit.json)",
        value: "s3",
        checked: false,
      },
      {
        name: "Email forwarding (Cloudflare Email Routing — MX/SPF/DMARC + rules)",
        value: "email",
        checked: false,
      },
      {
        name: "Google Search Console (DNS verification + domain property)",
        value: "search-console",
        checked: false,
      },
    ];
    const remainingChoices = serviceChoices.filter((choice) =>
      addableServices.includes(choice.value),
    );
    const extra =
      remainingChoices.length > 0
        ? await multiselect<ProvisionService>({
            message: "Other services to add?",
            choices: remainingChoices,
            required: emailIntentServices.length === 0,
          })
        : [];
    services = [...emailIntentServices, ...extra];
    if (services.length === 0) {
      console.log(chalk.dim("  Nothing selected — exiting."));
      return;
    }
  } else if (rawService === "all") {
    services = addableServices;
    if (services.length === 0) {
      console.log(
        chalk.green(`  Nothing to add — ${baseName} already has every supported service.`),
      );
      return;
    }
  } else {
    const requested = rawService.split(",").map((s) => s.trim().toLowerCase());
    const invalid = requested.filter((s) => !(allServices as readonly string[]).includes(s));
    if (invalid.length > 0) {
      console.log(chalk.red(`  Unknown service(s): ${invalid.join(", ")}`));
      console.log(chalk.dim(`  Valid: ${allServices.join(", ")}, or 'all'`));
      process.exit(1);
    }
    const skipped = requested.filter((service) => {
      const svc = service as ProvisionService;
      return impossible.has(svc) || (alreadyAdded.has(svc) && !rerunnableServices.has(svc));
    });
    if (skipped.length > 0) {
      console.log(
        chalk.red(
          `  Refusing to add already-present/unavailable service(s): ${skipped.join(", ")}`,
        ),
      );
      console.log(
        chalk.dim("  Run `hatchkit remove` first if you want Hatchkit to recreate them."),
      );
      process.exit(1);
    }
    services = requested.filter((service) => {
      const svc = service as ProvisionService;
      return !impossible.has(svc) && (!alreadyAdded.has(svc) || rerunnableServices.has(svc));
    }) as ProvisionService[];
    if (services.length === 0) {
      console.log(
        chalk.green(`  Nothing to add — requested service(s) are already present or unavailable.`),
      );
      return;
    }
  }

  // Flag parsing:
  //   --no-write                      → never write; print a cache summary only
  //   --enable-dev-obs                → also populate .env.development with observability creds
  //   --surfaces=<fullstack|split|backend|static>
  //   --server-dir <path>             → absolute or project-relative env dir for the server
  //   --client-dir <path>             → same for the client
  //   --domain <domain>               → site/domain-scoped services (Plausible/Search Console)
  //   --name <name>                   → project name when no positional/manifest name exists
  //   (no surface flags)              → prompt interactively
  const noWrite = args.includes("--no-write");
  const enableDevObs = args.includes("--enable-dev-obs");

  const validSurfaceModes = ["fullstack", "split", "backend", "static"] as const;
  const noEnvServices = new Set<ProvisionService>(["email", "search-console"]);
  const onlyNoEnvServices = services.every((service) => noEnvServices.has(service));
  let surfaces: Parameters<typeof runProvision>[0]["surfaces"] = undefined;
  if (noWrite) {
    surfaces = false;
  } else if (onlyNoEnvServices) {
    let projectDir = inferredProjectDir;
    if (!projectDir) {
      if (!process.stdin.isTTY) {
        console.log(
          chalk.red(
            "  A project directory is required for no-env services. Pass --project-dir <path>.",
          ),
        );
        process.exit(1);
      }
      projectDir = await promptForProjectDir(baseName);
      inferredProjectDir = projectDir;
      inferredManifest = readManifest(projectDir);
    }
    surfaces = {
      mode: provisionSurfaceModeFromManifest(inferredManifest),
      projectDir,
    };
  } else if (surfaceFlag || serverDirFlag || clientDirFlag || projectDirFlag) {
    // Non-interactive surface config: require every field we need.
    if (!surfaceFlag || !(validSurfaceModes as readonly string[]).includes(surfaceFlag)) {
      console.log(
        chalk.red(
          `  --surfaces=<mode> is required when --server-dir/--client-dir/--project-dir is passed.\n  Valid: ${validSurfaceModes.join(", ")}`,
        ),
      );
      process.exit(1);
    }
    const mode = surfaceFlag as (typeof validSurfaceModes)[number];
    const needsServer = mode !== "static";
    const needsClient = mode !== "backend";
    if (needsServer && !serverDirFlag) {
      console.log(chalk.red("  --server-dir <path> is required for this --surfaces mode."));
      process.exit(1);
    }
    if (needsClient && !clientDirFlag) {
      console.log(chalk.red("  --client-dir <path> is required for this --surfaces mode."));
      process.exit(1);
    }
    surfaces = {
      mode,
      serverEnvDir: needsServer ? resolve(serverDirFlag as string) : undefined,
      clientEnvDir: needsClient ? resolve(clientDirFlag as string) : undefined,
      // --project-dir is optional in the flag path. It points at the
      // project root used for manifest/package/CNAME inference (and for
      // s3Buckets). When absent and the serverEnvDir is a
      // `packages/server` style subdir, we infer it by walking up two
      // segments.
      projectDir: projectDirFlag
        ? resolve(projectDirFlag)
        : inferProjectDir(needsServer ? resolve(serverDirFlag as string) : undefined),
    };
  }

  const ledger = RunLedger.resumeOrStart(baseName);
  await runProvision({
    baseName,
    services,
    surfaces,
    enableDevObs,
    domain: domainFlag,
    failIfExists: true,
    onProvisioned: (event) => recordProvisionedEvent(ledger, event),
  });
  ledger.complete();
}

async function handleProvisionS3(): Promise<void> {
  // `hatchkit provision s3` — create the public+private bucket pair
  // for the adopted project in cwd, write credentials/URLs into its
  // encrypted .env.production, and record bucket names in
  // .hatchkit.json. Idempotent across re-runs.
  const projectDir = resolve(".");
  const { provisionS3ForProject } = await import("./provision/s3-buckets.js");
  const { getSecret, SECRET_KEYS: SK } = await import("./utils/secrets.js");
  const { validateS3KeyPair } = await import("./config.js");

  // Optional flags — keep minimal; the function reads everything else
  // from the manifest + global config + keychain.
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const provider = flag("--provider");
  const assetsBucketName = flag("--assets-bucket");
  const stateBucketName = flag("--state-bucket");
  // State bucket is opt-in. Default: only the public assets bucket is
  // created — that's all a typical Next-only frontend needs. Pass
  // --with-state-bucket (or --state-bucket <name>) when there's a
  // server reading/writing private state files.
  const includeStateBucket = args.includes("--with-state-bucket") || stateBucketName !== undefined;
  const publicHostnameFlag = flag("--public-hostname");
  const skipCustomDomain = args.includes("--no-custom-domain");
  const envPrefixFlag = flag("--env-prefix");
  const envPrefix =
    envPrefixFlag === "R2" || envPrefixFlag === "S3" || envPrefixFlag === "AWS"
      ? envPrefixFlag
      : undefined;
  const generateCronSecret = !args.includes("--no-cron-secret");

  // CORS: --cors-origin is repeatable (`--cors-origin a --cors-origin b`),
  // --cors-allow-all sets the rule to ["*"] (mutually exclusive with the
  // above), --no-cors skips the reconcile step and pins the manifest's
  // `cors.skipped` so re-runs respect the choice.
  const corsExtraOrigins: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cors-origin" && args[i + 1]) {
      corsExtraOrigins.push(args[i + 1]);
      i++;
    } else if (args[i].startsWith("--cors-origin=")) {
      corsExtraOrigins.push(args[i].slice("--cors-origin=".length));
    }
  }
  const corsAllowAll = args.includes("--cors-allow-all");
  const skipCors = args.includes("--no-cors");
  if (corsAllowAll && corsExtraOrigins.length > 0) {
    console.error(
      chalk.red("  --cors-allow-all and --cors-origin are mutually exclusive — pick one."),
    );
    process.exit(1);
  }
  if (skipCors && (corsAllowAll || corsExtraOrigins.length > 0)) {
    console.error(
      chalk.red(
        "  --no-cors disables the CORS step entirely — drop it if you want --cors-origin or --cors-allow-all to take effect.",
      ),
    );
    process.exit(1);
  }

  // Admin token check — `s3:r2:admin-token` is the keys-to-the-kingdom
  // for hatchkit's R2 setup. It (a) creates buckets, (b) attaches
  // custom domains, (c) MINTS per-project S3 credentials scoped to
  // that project's buckets. Per-project access/secret pairs are
  // generated on the fly and never pasted by the user — see
  // CloudflareApi.createR2ApiToken.
  //
  // Required permissions on this token (BOTH must be set):
  //   · Account > Workers R2 Storage > Edit  — for bucket admin
  //   · User    > API Tokens         > Edit  — for child-token issuance
  // Optional:
  //   · Zone    > Zone               > Read  — needed only if you
  //     want custom-domain attach instead of the managed r2.dev URL
  //
  // If it's missing, defer to `ensureS3("r2")` — the same global setup
  // path `hatchkit config add s3 r2` runs, including token verification
  // against both required perms. Keeps the global vs. per-project
  // boundary clean: this command (provision s3) only does per-project
  // work; the admin token is a global concern.
  const existingAdmin = await getSecret(SK.r2AdminToken);
  if (!existingAdmin) {
    console.log(
      chalk.yellow(
        "\n  R2 admin token not configured — running global setup first (same as `hatchkit config add s3 r2`).",
      ),
    );
    await ensureS3("r2");
  }

  // Migrate away from the legacy account-wide S3 access/secret pair.
  // Old hatchkit stored a single shared pair under `s3:<provider>:access-key`
  // / `:secret-key` and wrote it into every project's .env.production.
  // The new model issues per-project scoped credentials, so the
  // account-wide pair is unused (and was corrupt for some users due to
  // a paste-collision bug — same value in both slots). Delete it on
  // first run, surface what happened so the user can confirm.
  const provName = flag("--provider") ?? "r2";
  const legacyAccess = await getSecret(SK.s3AccessKey(provName));
  const legacySecret = await getSecret(SK.s3SecretKey(provName));
  if (legacyAccess || legacySecret) {
    const issue =
      legacyAccess && legacySecret
        ? validateS3KeyPair(provName, legacyAccess, legacySecret)
        : "incomplete pair";
    const { deleteSecret } = await import("./utils/secrets.js");
    await deleteSecret(SK.s3AccessKey(provName));
    await deleteSecret(SK.s3SecretKey(provName));
    console.log(
      chalk.dim(
        `  · Removed legacy account-wide ${provName} S3 keys (${issue ?? "unused now"}); per-project tokens supersede them.`,
      ),
    );
  }

  // Resolve the custom-domain choice. Precedence:
  //   --no-custom-domain                → null (skip, use r2.dev)
  //   --public-hostname <host>          → <host>
  //   stdin is a TTY, no flags          → prompt with sensible default
  //                                       (re-using the existing custom
  //                                       domain on re-run, otherwise
  //                                       `assets.<project-domain>`). Empty
  //                                       answer → null (skip).
  //   non-TTY, no flags                 → undefined (function falls back
  //                                       to its built-in default)
  let publicHostname: string | null | undefined = publicHostnameFlag;
  if (skipCustomDomain) {
    publicHostname = null;
  } else if (publicHostname === undefined) {
    // Reuse the manifest's recorded custom hostname when present —
    // re-running provision shouldn't re-prompt for a value the user
    // already settled on. Pass `--public-hostname=<host>` to change
    // it explicitly (or `--no-custom-domain` to switch to managed
    // r2.dev). Only on first run, when nothing's recorded yet, do we
    // prompt with `assets.<domain>` as the default.
    const { defaultBucketHostname, existingCustomHostname } = await import(
      "./provision/s3-buckets.js"
    );
    const { readManifest } = await import("./scaffold/manifest.js");
    const m = readManifest(projectDir);
    const recorded = m ? existingCustomHostname(m) : null;
    if (recorded) {
      publicHostname = recorded;
    } else if (process.stdin.isTTY) {
      const { input } = await import("@inquirer/prompts");
      const def = m ? defaultBucketHostname(m.domain) : undefined;
      const answer = (
        await input({
          message:
            "Custom domain for the public assets bucket (leave empty to use the managed r2.dev URL):",
          default: def,
        })
      ).trim();
      publicHostname = answer === "" ? null : answer;
    }
  }

  console.log(chalk.bold("\n  hatchkit provision s3"));
  const result = await provisionS3ForProject({
    projectDir,
    provider,
    assetsBucketName,
    stateBucketName,
    includeStateBucket,
    publicHostname,
    envPrefix,
    generateCronSecret,
    corsExtraOrigins: corsExtraOrigins.length > 0 ? corsExtraOrigins : undefined,
    corsAllowAll: corsAllowAll || undefined,
    skipCors: skipCors || undefined,
  });

  console.log();
  console.log(chalk.green(result.state ? "  ✓ Buckets ready" : "  ✓ Bucket ready"));
  console.log(
    `    assets: ${chalk.cyan(result.assets.name)} → ${chalk.cyan(result.assets.publicUrl)}`,
  );
  if (result.state) {
    console.log(`    state:  ${chalk.cyan(result.state.name)}  ${chalk.dim("(private)")}`);
  } else {
    console.log(
      chalk.dim(
        "    (no private state bucket — pass --with-state-bucket if you need one for server-side files)",
      ),
    );
  }
  if (result.assets.cors?.skipped) {
    console.log(
      chalk.dim(
        "    cors:   skipped (--no-cors / manifest opt-out) — browser fetch() against the bucket will be CORS-blocked",
      ),
    );
  } else if (result.assets.cors?.origins?.length) {
    const list = result.assets.cors.origins;
    const preview = list.slice(0, 3).join(", ");
    const tail = list.length > 3 ? `, +${list.length - 3} more` : "";
    console.log(`    cors:   ${chalk.dim(`${list.length} origin(s) — ${preview}${tail}`)}`);
  }
  if (result.envWritten.length > 0) {
    console.log(
      chalk.green(`\n  ✓ Wrote ${result.envWritten.length} encrypted entries to .env.production:`),
    );
    for (const k of result.envWritten) console.log(`    · ${k}`);
  }
  if (result.envKept.length > 0) {
    console.log(
      chalk.dim(`  · Kept ${result.envKept.length} existing entries: ${result.envKept.join(", ")}`),
    );
  }
  console.log();
}

async function handleDestroy(): Promise<void> {
  // `hatchkit destroy <project> [--yes] [--recipe]`
  //   destroy reads the run ledger written by `hatchkit create` and
  //   reverses the recorded steps. With --recipe it just prints the
  //   shell-command rollback recipe and exits (no execution).
  const positional = args.slice(1).filter((a) => !a.startsWith("--"));
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  const recipeOnly = args.includes("--recipe");

  let name = positional[0];
  if (!name) {
    const { input } = await import("@inquirer/prompts");
    const { validateProjectName } = await import("./utils/validate.js");
    name = await input({
      message: "Project name to destroy:",
      validate: validateProjectName,
    });
  }

  const ledger = RunLedger.load(name);
  if (!ledger) {
    console.log(
      chalk.yellow(
        `  No run ledger found for "${name}". Either it was never created via \`hatchkit create\` or the ledger was already cleaned up.`,
      ),
    );
    process.exit(1);
  }

  const { printRecipe } = await import("./deploy/rollback.js");
  printRecipe(ledger);

  if (recipeOnly) return;

  if (!skipConfirm) {
    const ok = await confirm({
      message: `Roll back ${ledger.steps.length} step(s) for ${chalk.cyan(name)}?`,
      default: false,
    });
    if (!ok) {
      console.log(chalk.dim("  Aborted. Ledger left in place."));
      return;
    }
  }

  await runRollback(ledger, { yes: skipConfirm });
}

async function handleRemove(): Promise<void> {
  // Mirrors handleAdd: `hatchkit remove [<name>] [<services>] [--dry-run] [--yes]`
  //   hatchkit remove                             (fully interactive)
  //   hatchkit remove raptor-runner               (prompts for services)
  //   hatchkit remove raptor-runner all
  //   hatchkit remove raptor-runner glitchtip,listmonk-ses
  //   hatchkit remove raptor-runner all --yes     (skip confirmation)
  const positional = args.slice(1).filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  let baseName = positional[0];
  const rawService = positional[1];

  const allServices: ProvisionService[] = [
    "glitchtip",
    "openpanel",
    "plausible",
    "listmonk-ses",
    "s3",
    "email",
    "search-console",
  ];

  if (!baseName) {
    const { input } = await import("@inquirer/prompts");
    const { validateProjectName } = await import("./utils/validate.js");
    baseName = await input({
      message: "Project name to remove (e.g. raptor-runner):",
      validate: validateProjectName,
    });
  }

  let services: ProvisionService[];
  if (!rawService) {
    const { multiselect } = await import("./utils/multiselect.js");
    services = await multiselect<ProvisionService>({
      message: "Which services to remove?",
      choices: [
        { name: "GlitchTip (deletes the project)", value: "glitchtip", checked: true },
        { name: "OpenPanel (deletes the project)", value: "openpanel", checked: true },
        { name: "Plausible (deletes the site)", value: "plausible", checked: false },
        {
          name: "Listmonk + SES (deletes the per-project Listmonk lists; keeps the SES identity)",
          value: "listmonk-ses",
          checked: true,
        },
        { name: "S3 / R2 (deletes per-bucket scoped tokens)", value: "s3", checked: false },
        {
          name: "Email forwarding (deletes routing rules + DNS records; keeps destination)",
          value: "email",
          checked: false,
        },
        {
          name: "Google Search Console (removes property; keeps verification token)",
          value: "search-console",
          checked: false,
        },
      ],
      required: true,
    });
  } else if (rawService === "all") {
    services = allServices;
  } else {
    const requested = rawService.split(",").map((s) => s.trim().toLowerCase());
    const invalid = requested.filter((s) => !(allServices as readonly string[]).includes(s));
    if (invalid.length > 0) {
      console.log(chalk.red(`  Unknown service(s): ${invalid.join(", ")}`));
      console.log(chalk.dim(`  Valid: ${allServices.join(", ")}, or 'all'`));
      process.exit(1);
    }
    services = requested as ProvisionService[];
  }

  // Confirmation — deletion is permanent upstream. Skip on --yes or --dry-run.
  if (!skipConfirm && !dryRun) {
    const { confirm } = await import("@inquirer/prompts");
    const ok = await confirm({
      message: `Delete clients of "${baseName}" from ${services.join(", ")}? This can't be undone.`,
      default: false,
    });
    if (!ok) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }
  }

  // For `s3` removal, hand the orchestrator a projectDir so it can read
  // the manifest's s3Buckets list. Default: walk up from the named
  // project directory if it exists; the s3 unprovision falls back to
  // a keychain sweep when the manifest can't be found.
  let projectDir: string | undefined;
  if (services.includes("s3") || services.includes("search-console")) {
    const guess = resolve(baseName);
    if (existsSync(join(guess, ".hatchkit.json"))) {
      projectDir = guess;
    } else if (existsSync(join(process.cwd(), ".hatchkit.json"))) {
      projectDir = process.cwd();
    }
  }

  await runUnprovision({ baseName, services, dryRun, projectDir });
}

async function handleDns(): Promise<void> {
  const sub = args[1];
  switch (sub) {
    case "link-to-cloudflare": {
      const rest = args.slice(2);
      const dryRun = rest.includes("--dry-run");
      const domains = rest.filter((a) => !a.startsWith("--"));
      const { runDnsLinkToCloudflare } = await import("./dns.js");
      await runDnsLinkToCloudflare({ domains, dryRun });
      break;
    }
    default:
      printHelp("dns");
  }
}

// SES sub-commands.
//
// `hatchkit ses verify <email>` is the everyday-use command: register a
// recipient address so sandbox-mode test sends can reach it. SES mails
// the user a confirm link; they click; status flips to verified. AWS
// requires this per-address while the account is in sandbox.
//
// `hatchkit ses status` is the cheat-sheet view: region, sandbox flag,
// daily/per-second send caps, count of verified identities. Cheap call
// (one GetAccount + one ListEmailIdentities page).
//
// `hatchkit ses list` mirrors `aws sesv2 list-email-identities` but
// pulls auth from hatchkit's keychain so it works without aws CLI config.
async function handleSesCommand(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (!sub || sub === "--help") {
    console.log(`
  ${chalk.bold("hatchkit ses")} — Amazon SES helpers

  ${chalk.bold("Subcommands:")}
    ${chalk.cyan("verify <email>")}     Register a recipient address. SES mails a
                       one-time confirm link to that address; clicking it
                       flips it to verified. Required for every test
                       recipient while your SES account is in sandbox.

    ${chalk.cyan("unverify <email>")}   Drop a verified address (sesv2:DeleteEmailIdentity).
                       404-tolerant.

    ${chalk.cyan("list [domains|emails]")}
                       List identities. Without a filter, prints both.

    ${chalk.cyan("status")}             Region, sandbox state, send caps, identity
                       count. Run this first when something fails.
`);
    return;
  }

  const { ensureSes } = await import("./config.js");
  const cfg = await ensureSes();
  const auth = {
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  };

  switch (sub) {
    case "verify": {
      const email = rest[1];
      if (!email || !/.+@.+\..+/.test(email)) {
        console.log(chalk.red("  Usage: hatchkit ses verify <email>"));
        process.exit(1);
      }
      const { verifySesEmailAddress } = await import("./provision/ses.js");
      const r = await verifySesEmailAddress(email, auth);
      if (r.verified) {
        console.log(chalk.green(`  ✓ ${email} already verified.`));
      } else {
        console.log(
          chalk.green(
            `  ✓ Verification email sent to ${email}. Click the AWS link in the inbox to flip it to verified.`,
          ),
        );
      }
      break;
    }
    case "unverify": {
      const email = rest[1];
      if (!email) {
        console.log(chalk.red("  Usage: hatchkit ses unverify <email>"));
        process.exit(1);
      }
      const { deleteSesEmailAddress } = await import("./provision/ses.js");
      const r = await deleteSesEmailAddress(email, auth);
      console.log(
        r === "deleted"
          ? chalk.green(`  ✓ ${email} unverified.`)
          : chalk.dim(`  · ${email} was not in the account.`),
      );
      break;
    }
    case "list": {
      const filter = rest[1];
      const { listSesDomains } = await import("./provision/ses.js");
      const all = await listSesDomains(auth);
      const isEmail = (s: string) => s.includes("@");
      const domains = all.filter((s) => !isEmail(s));
      const emails = all.filter(isEmail);
      if (!filter || filter === "domains") {
        console.log(chalk.bold(`\n  Domain identities (${domains.length}):`));
        for (const d of domains) console.log(`    ${d}`);
        if (domains.length === 0) console.log(chalk.dim("    (none)"));
      }
      if (!filter || filter === "emails") {
        console.log(chalk.bold(`\n  Email-address identities (${emails.length}):`));
        for (const e of emails) console.log(`    ${e}`);
        if (emails.length === 0) console.log(chalk.dim("    (none)"));
      }
      break;
    }
    case "status": {
      const { getSesAccountInfo, listSesDomains } = await import("./provision/ses.js");
      const info = await getSesAccountInfo(auth);
      const ids = await listSesDomains(auth);
      console.log(chalk.bold("\n  SES account status\n"));
      console.log(`  Region:               ${chalk.cyan(cfg.region)}`);
      console.log(
        `  Production access:    ${
          info.productionAccessEnabled
            ? chalk.green("yes (out of sandbox)")
            : chalk.yellow("no (sandbox — verified recipients only)")
        }`,
      );
      console.log(
        `  Sending enabled:      ${info.sendingEnabled ? chalk.green("yes") : chalk.red("no (suspended)")}`,
      );
      if (info.max24HourSend !== undefined) {
        console.log(
          `  24h send cap:         ${info.max24HourSend === -1 ? chalk.green("unlimited") : info.max24HourSend}`,
        );
      }
      if (info.maxSendRate !== undefined) {
        console.log(`  Max send rate (/s):   ${info.maxSendRate}`);
      }
      if (info.enforcementStatus) {
        console.log(`  Enforcement:          ${chalk.yellow(info.enforcementStatus)}`);
      }
      console.log(`  Identities:           ${ids.length}`);
      if (!info.productionAccessEnabled) {
        console.log(
          chalk.dim(
            `\n  Lift the sandbox at:  https://console.aws.amazon.com/ses/home?region=${cfg.region}#/account\n`,
          ),
        );
      }
      break;
    }
    default:
      console.log(chalk.red(`  Unknown sub-command: ${sub}`));
      console.log(chalk.dim("  Run `hatchkit ses --help` for the list."));
      process.exit(1);
  }
}

async function configureGhcrForCreate(
  repoUrl: string,
  isPrivateRepo: boolean,
  ledger: RunLedger | null,
): Promise<void> {
  const { repoSlugFromRemote } = await import("./deploy/gh-actions-secrets.js");
  const slug = repoSlugFromRemote(repoUrl);
  if (!slug) {
    console.log(
      chalk.dim("  · Couldn't resolve owner/repo from GitHub URL — skipping GHCR pull setup."),
    );
    return;
  }

  const coolify = await getCoolifyConfig();
  if (!coolify) {
    console.log(chalk.dim("  · Coolify not configured — skipping GHCR pull setup."));
    return;
  }

  const { CoolifyApi } = await import("./utils/coolify-api.js");
  const { makeGhcrPackagePublic, registerGhcrCredsWithCoolify } = await import("./deploy/ghcr.js");
  if (!isPrivateRepo) {
    const result = await makeGhcrPackagePublic({ repoSlug: slug });
    if (result.kind === "public-set") return;
    if (result.kind === "skipped" || result.kind === "failed") {
      console.log(chalk.yellow(`  GHCR public-image setup skipped: ${result.reason}`));
      console.log(chalk.dim(result.recovery.map((line: string) => `  ${line}`).join("\n")));
    }
    return;
  }

  const ghcrConfig = await getGhcrConfig();
  const api = new CoolifyApi({ url: coolify.url, token: coolify.token });
  const result = await registerGhcrCredsWithCoolify({
    api,
    repoSlug: slug,
    pullToken: ghcrConfig?.pullToken,
    username: ghcrConfig?.username,
    coolifyUrl: coolify.url,
    manual: ghcrConfig?.manual === true,
  });

  if (result.kind === "private-registered") {
    for (const h of result.hosts) {
      if (!h.newlyLoggedIn) continue;
      ledger?.record({
        kind: "coolifyGhcrSshLogin",
        serverUuid: h.serverUuid,
        host: h.host,
        user: h.user,
        port: h.port,
      });
    }
    return;
  }

  if (result.kind === "skipped" || result.kind === "failed") {
    console.log(chalk.yellow(`  GHCR private-image pull setup skipped: ${result.reason}`));
    console.log(chalk.dim(result.recovery.map((line: string) => `  ${line}`).join("\n")));
  }
}

function isCreatedGithubRepoPrivate(config: ProjectConfig): boolean {
  return config.createGithubRepo && (config.githubRepoVisibility ?? "public") === "private";
}

function createProvisionServices(config: ProjectConfig): ProvisionService[] {
  const services = (config as ProjectConfig & { provisionServices?: ProvisionService[] })
    .provisionServices;
  if (services !== undefined) return services;
  if (config.features.includes("analytics")) return config.analyticsProviders ?? ["glitchtip"];
  return [];
}

async function ensureCreateProvisionProviders(services: ProvisionService[]): Promise<void> {
  if (services.length === 0) return;
  const unique = new Set(services);
  const {
    ensureDefaultForwardingEmail,
    ensureGlitchtip,
    ensureGoogleSearchConsole,
    ensureListmonk,
    ensureOpenpanel,
    ensurePlausible,
    ensureSes,
  } = await import("./config.js");

  if (unique.has("glitchtip")) await ensureGlitchtip();
  if (unique.has("openpanel")) await ensureOpenpanel();
  if (unique.has("plausible")) await ensurePlausible();
  if (unique.has("listmonk-ses")) {
    await ensureSes();
    await ensureListmonk();
  }
  if (unique.has("email")) {
    await ensureDns();
    await ensureDefaultForwardingEmail();
  }
  if (unique.has("search-console")) {
    await ensureGoogleSearchConsole();
    await ensureDns();
  }
}

// ---------------------------------------------------------------------------
// Provider pre-flights
// ---------------------------------------------------------------------------

/** Ensure all providers required by the current config are configured.
 *  Idempotent — already-configured providers return instantly. Called
 *  before the review loop (so credentials are collected pre-"Proceed")
 *  and again after each in-review edit that might add new providers. */
async function ensureRequiredProviders(config: ProjectConfig): Promise<void> {
  if (config.deploymentMode === "coolify" && config.runDeployment && !config.dryRun) {
    const dns = await ensureDns();
    await requireCloudflareZoneForTerraform(config.baseDomain, dns);
  }

  if (
    config.deploymentMode === "coolify" &&
    (config.deployTarget === "existing" || config.runDeployment)
  ) {
    await ensureCoolify();
  }

  if (config.createGithubRepo || config.deploymentMode === "gh-pages") {
    await ensureGitHub();
  }

  if (
    config.deploymentMode === "coolify" &&
    config.deployTarget === "new" &&
    config.runDeployment
  ) {
    await ensureHetzner();
  }

  if (
    config.features.includes("s3") &&
    config.s3Provider !== "existing" &&
    config.s3Provider !== "none"
  ) {
    if (
      config.s3Provider === "hetzner" ||
      config.s3Provider === "aws" ||
      config.s3Provider === "r2"
    ) {
      await ensureS3(config.s3Provider);
    }
  }

  const provisionServices = createProvisionServices(config);
  if (!config.dryRun) await ensureCreateProvisionProviders(provisionServices);

  if (config.features.includes("stripe")) {
    const { ensureStripe } = await import("./config.js");
    await ensureStripe();

    // Pre-collect per-project Stripe keys so execution doesn't prompt.
    // Keys are cached in keychain — subsequent calls return instantly.
    if (config.surfaces !== "static") {
      const { collectPerProjectKeys } = await import("./provision/stripe.js");
      const master = await ensureStripe();
      if (master.hasTestMaster) {
        await collectPerProjectKeys({ projectName: config.name, mode: "test", reprompt: false });
      }
      if (master.hasLiveMaster) {
        await collectPerProjectKeys({ projectName: config.name, mode: "live", reprompt: false });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleCreate(): Promise<void> {
  // Parse CLI flags. `--yes` (with optional `--config <path>`) turns
  // the flow non-interactive; otherwise we still prompt for anything
  // not supplied via flags / config file.
  const flags = parseCreateFlags(args);
  const {
    yes: nonInteractive,
    dryRun,
    presets,
    forceNoGithub,
    forceNoDeploy,
    forceNoInstall,
    forceNoLocalDev,
  } = flags;

  // Check if first run (skip onboarding when non-interactive — the
  // onboarding prompts would stall automation).
  if (!nonInteractive && (await isFirstRun())) {
    await runOnboarding();
  }

  // Collect project config via interactive prompts (or presets).
  // The beforeReview hook ensures all provider credentials are collected
  // BEFORE the user clicks "Proceed" in the review loop — making post-
  // Proceed execution fully non-interactive.
  const config = await collectProjectConfig({
    dryRun,
    presets,
    nonInteractive,
    forceNoLocalDev,
    beforeReview: nonInteractive ? undefined : ensureRequiredProviders,
  });
  if (forceNoGithub) config.createGithubRepo = false;
  if (forceNoDeploy) config.runDeployment = false;
  if (forceNoInstall) config.installDeps = false;
  if (forceNoLocalDev) config.localDev = undefined;

  // In non-interactive mode the beforeReview hook doesn't run (no review
  // loop), so we still need the provider pre-flight here. For interactive
  // mode this is a no-op — credentials are already configured.
  await ensureRequiredProviders(config);

  const provisionServices = createProvisionServices(config);

  const appDir = resolve(config.name);

  // Resolve ML services (reuse or deploy)
  const { reuse, deploy } = await resolveMlServices(config);
  if (config.mlServices.length > 0) {
    printMlSummary(reuse, deploy);
  }

  // Summary before execution
  console.log(chalk.bold("\n  ── Summary ───────────────────────────────────────────────\n"));
  console.log(`  Project:    ${chalk.cyan(config.name)}`);
  if (config.description) {
    console.log(`  Descr.:     ${chalk.cyan(config.description)}`);
  }
  console.log(`  Domain:     ${chalk.cyan(config.domain)}`);
  if (config.deploymentMode === "gh-pages") {
    console.log(`  Deploy to:  ${chalk.cyan("GitHub Pages (static)")}`);
  } else if (config.deploymentMode === "scaffold-only") {
    console.log(`  Deploy to:  ${chalk.dim("scaffold only (no deploy)")}`);
  } else {
    console.log(
      `  Deploy to:  ${config.deployTarget === "existing" ? `existing server (${config.serverIpv4 ?? config.serverIp ?? "?"}${config.serverIpv6 ? ` · ${config.serverIpv6}` : ""})` : `new Hetzner ${config.serverSize}`}`,
    );
  }
  console.log(`  Features:   ${config.features.length > 0 ? config.features.join(", ") : "none"}`);
  console.log(
    `  Services:   ${provisionServices.length > 0 ? provisionServices.join(", ") : "none"}`,
  );
  console.log(
    `  ML:         ${config.mlServices.length > 0 ? config.mlServices.join(", ") : "none"}`,
  );
  console.log(`  Scaffold:   ${config.scaffoldRepo ? "yes" : "no"}`);
  console.log(
    `  GitHub:     ${config.createGithubRepo ? `yes (${config.githubRepoVisibility ?? "public"})` : "no"}`,
  );
  console.log(`  Install:    ${config.installDeps ? "yes (pnpm install)" : "no"}`);
  console.log(`  Deploy now: ${config.runDeployment ? "yes" : "no"}`);

  if (config.dryRun) {
    console.log(chalk.yellow("\n  [dry-run mode — no changes will be made]\n"));
  }

  // Run ledger — append-only record of what each step accomplished, so
  // a mid-run failure can offer a tailored cleanup recipe + auto-undo.
  // Skipped for dry-run (nothing to undo) and when the user opted out of
  // both scaffolding and deployment (also nothing to undo).
  const useLedger = !config.dryRun && (config.scaffoldRepo || config.runDeployment);
  const ledger = useLedger ? RunLedger.start(config.name) : null;

  // Intercept Ctrl+C so the user gets the recipe + rollback prompt
  // instead of leaving partial state stranded. Paired with
  // `uninstallCancelHandler()` in the finally block below.
  if (ledger) installCancelHandler(ledger, "create");

  // Hoisted across the try-block boundary so the success summary below
  // can read them. Declared with let so they can be reassigned inside.
  let scaffoldResult: Awaited<ReturnType<typeof scaffoldApp>> | undefined;
  let installedDeps = false;

  try {
    // Step 1: Scaffold app repo
    if (config.scaffoldRepo) {
      scaffoldResult = await scaffoldApp(config, appDir);
      ledger?.record({ kind: "scaffold", path: appDir });
      if (scaffoldResult.dotenvx) {
        ledger?.record({
          kind: "keychain",
          account: SECRET_KEYS.dotenvxPrivateKey(config.name),
        });
      }
      if (scaffoldResult.localDev) {
        ledger?.record({ kind: "localDevFragment", slug: scaffoldResult.localDev.slug });
      }
      const { ports } = scaffoldResult;
      console.log(
        chalk.dim(
          `  Ports: server=${ports.server}, client=${ports.client}` +
            (ports.nativeHmr ? `, native HMR=${ports.nativeHmr}` : ""),
        ),
      );
      if (scaffoldResult.dotenvx) {
        const { printDotenvxSummary } = await import("./scaffold/dotenvx.js");
        printDotenvxSummary(scaffoldResult.dotenvx, config.name);
      }

      // Auto-provision selected project-scoped services
      // through the same machinery used by `hatchkit add`, so create,
      // adopt, and existing-project provisioning stay aligned.
      if (provisionServices.length > 0 && !config.dryRun) {
        try {
          await runProvision({
            baseName: config.name,
            services: provisionServices,
            domain: config.domain,
            surfaces: {
              mode: config.surfaces,
              projectDir: appDir,
              serverEnvDir:
                config.surfaces === "static" ? undefined : join(appDir, "packages/server"),
              clientEnvDir:
                config.surfaces === "backend" ? undefined : join(appDir, "packages/client"),
            },
            emailForwarding: config.emailForwarding?.enabled
              ? {
                  addresses: config.emailForwarding.addresses,
                  catchAll: config.emailForwarding.catchAll,
                }
              : undefined,
            onProvisioned: (event) => {
              if (ledger) recordProvisionedEvent(ledger, event);
            },
          });
        } catch (err) {
          console.log(
            chalk.yellow(`  Couldn't auto-provision services: ${(err as Error).message}`),
          );
          console.log(
            chalk.dim(
              `  Run \`hatchkit add ${config.name} ${provisionServices.join(",")}\` once providers are reachable.`,
            ),
          );
        }
      }

      // Stripe: walk the user through pasting per-project keys (sk + pk
      // for test + live), auto-mint a webhook endpoint per mode using
      // the master keys, and persist:
      //   · sandbox creds  → .env.development (plaintext)
      //   · live creds     → .env.production  (dotenvx-encrypted)
      // Webhook endpoint ids are tracked in keychain so destroy can
      // reach them later. Skipped for static (no server runtime).
      if (config.features.includes("stripe") && config.surfaces !== "static") {
        try {
          const { provisionStripeProject, renderStripeEnv, renderStripeSkipComment } = await import(
            "./provision/stripe.js"
          );
          const { appendCommentBlock, parseEnvLines, writeDevEnv, writeProdEnv } = await import(
            "./provision/write-env.js"
          );
          const result = await provisionStripeProject({
            projectName: config.name,
            domain: config.domain,
          });

          const devEnvPath = join(appDir, "packages/server/.env.development");
          const prodEnvPath = join(appDir, "packages/server/.env.production");
          const devLabel = "packages/server/.env.development";
          const prodLabel = "packages/server/.env.production";

          if (result.test) {
            if (result.test.kind === "skipped") {
              appendCommentBlock(devEnvPath, renderStripeSkipComment("test", devLabel));
            }
            const pairs = parseEnvLines(renderStripeEnv(result.test));
            writeDevEnv(devEnvPath, pairs);
            // Only record the webhook ledger entry when we actually
            // touched Stripe's API — skipped runs leave nothing to undo.
            if (result.test.kind === "configured") {
              ledger?.record({
                kind: "keychain",
                account: SECRET_KEYS.stripeProjectWebhookId(config.name, "test"),
              });
            }
            console.log(
              chalk.green(
                result.test.kind === "skipped"
                  ? `  ✓ Stripe sandbox placeholders → ${devLabel} (fill in later)`
                  : `  ✓ Stripe sandbox creds → ${devLabel} (${pairs.length} keys)`,
              ),
            );
          }
          if (result.live) {
            if (result.live.kind === "skipped") {
              appendCommentBlock(prodEnvPath, renderStripeSkipComment("live", prodLabel));
            }
            const pairs = parseEnvLines(renderStripeEnv(result.live));
            writeProdEnv(prodEnvPath, pairs);
            if (result.live.kind === "configured") {
              ledger?.record({
                kind: "keychain",
                account: SECRET_KEYS.stripeProjectWebhookId(config.name, "live"),
              });
            }
            console.log(
              chalk.green(
                result.live.kind === "skipped"
                  ? `  ✓ Stripe live placeholders → ${prodLabel} (encrypted CHANGE_ME values, fill in later)`
                  : `  ✓ Stripe live creds → ${prodLabel} (encrypted, ${pairs.length} keys)`,
              ),
            );
          }
        } catch (err) {
          console.log(chalk.yellow(`  Couldn't auto-provision Stripe: ${(err as Error).message}`));
          console.log(
            chalk.dim(
              `  Create the webhook manually: dashboard.stripe.com → Developers → Webhooks,\n` +
                `  point at https://${config.domain}/api/stripe/webhook, then\n` +
                `  \`dotenvx set STRIPE_WEBHOOK_SECRET <whsec_…> -f packages/server/.env.production\`.`,
            ),
          );
        }
      }
    }

    if (config.dryRun) {
      // Coolify mode previews the Terraform tfvars + Coolify env that
      // would be written. gh-pages and scaffold-only have nothing
      // equivalent — Pages reads no env, scaffold-only writes no infra.
      if (config.deploymentMode === "coolify") {
        scaffoldInfra(config, INFRA_ROOT, {
          serverPort: scaffoldResult?.ports.server,
          clientPort: scaffoldResult?.ports.client,
        });
      } else if (config.deploymentMode === "gh-pages") {
        console.log(
          chalk.dim(
            "  · gh-pages mode — would write `.github/workflows/gh-pages.yml`, patch `next.config`,\n" +
              "    write CNAME, enable Pages, configure DNS, and wait for the Let's Encrypt cert.",
          ),
        );
      }
      console.log(chalk.green("\n  ✓ Dry run complete. No changes were made.\n"));
      return;
    }

    // Step 2: Install deps. The decision was captured upfront (in the
    // stepper) so the user can walk away — no mid-scaffold prompt here.
    // Required for the initial commit to pick up the lockfile delta and
    // for the user to `pnpm dev` immediately.
    if (config.scaffoldRepo && config.installDeps) {
      const hasPnpm = await execOk("pnpm", ["--version"]);
      if (!hasPnpm) {
        console.log(
          chalk.yellow(
            "  pnpm not found on PATH — skipping install step. Install deps with your preferred tool once available.",
          ),
        );
      } else {
        const res = await exec("pnpm", ["install"], {
          cwd: appDir,
          spinner: "Installing dependencies...",
        });
        if (res.exitCode === 0) {
          installedDeps = true;
        } else {
          console.log(chalk.yellow("  pnpm install failed — continuing anyway."));
        }
      }
    }

    // Step 3: Git + GitHub — must run BEFORE scaffoldInfra so the repo
    // URL can be threaded into the Coolify env (GITHUB_REPO_URL).
    let repoUrl: string | null = null;
    if (config.scaffoldRepo) {
      repoUrl = await setupGitHub(config, appDir);
      if (repoUrl) {
        // Strip the https://github.com/ prefix so the recorded value is
        // gh-CLI-friendly (`gh repo delete <owner>/<repo>`).
        const slug = repoUrl.replace(/^https?:\/\/github\.com\//, "");
        ledger?.record({ kind: "github", repo: slug });
      }
    }

    // Step 4: Generate infra configs (with repo URL + ports baked in).
    const infraResult = scaffoldInfra(config, INFRA_ROOT, {
      repoUrl: repoUrl ?? undefined,
      serverPort: scaffoldResult?.ports.server,
      clientPort: scaffoldResult?.ports.client,
    });
    if (infraResult.tfvarsPath) {
      ledger?.record({ kind: "tfvars", path: infraResult.tfvarsPath });
    }
    if (infraResult.coolifyEnvPath) {
      ledger?.record({ kind: "coolifyEnv", path: infraResult.coolifyEnvPath });
    }

    // Step 5: Terraform (DNS + optionally server). Coolify-only —
    // gh-pages handles its own DNS via `runPagesSetupProgrammatic`
    // a few steps down, and `scaffold-only` skips deploy entirely.
    if (config.runDeployment && config.deploymentMode === "coolify") {
      const tfResult = await runTerraform(config, INFRA_ROOT);
      if (tfResult.applied) {
        ledger?.record({
          kind: "terraformApplied",
          stackDir: tfResult.applied.stackDir,
          tfvarsPath: tfResult.applied.tfvarsPath,
        });
      }
    }

    // Step 6: Coolify setup. Only runs in coolify mode; gh-pages has
    // no Coolify app to provision (the site lives on GitHub's CDN).
    if (config.runDeployment && config.deploymentMode === "coolify") {
      const coolifyResult = await runCoolifySetup(config, {
        repoUrl: repoUrl ?? undefined,
        serverPort: scaffoldResult?.ports.server,
        clientPort: scaffoldResult?.ports.client,
        isPrivateRepo: isCreatedGithubRepoPrivate(config),
        preresolvedGithubSource: config.coolifyGithubSource,
      });
      // Order matters: rollback iterates the ledger in REVERSE, so we
      // record parent-before-child (project before app). Otherwise
      // reverse iteration tries to delete the project before the app
      // and Coolify rejects with `Project has resources, so it cannot
      // be deleted.` Same invariant applied in adopt.ts.
      if (coolifyResult.projectCreated) {
        ledger?.record({ kind: "coolifyProject", uuid: coolifyResult.projectUuid });
      }
      ledger?.record({ kind: "coolifyApp", uuid: coolifyResult.appUuid });

      // Provision a per-project DB container on Coolify when the user
      // picked that path. Best-effort: a failure here doesn't undo the
      // app deploy — we surface clear instructions instead. Engine
      // dispatch follows config.dbEngine (default "mongodb"); the
      // legacy `mongodbProvider` field is read as a fallback for
      // pre-postgres presets.
      const dbProvider = config.dbProvider ?? config.mongodbProvider;
      if (dbProvider === "coolify" && config.scaffoldRepo) {
        try {
          const serverEnvDir = join(appDir, "packages/server");
          if (config.dbEngine === "postgres") {
            const { provisionCoolifyPostgres } = await import("./deploy/coolify-postgres.js");
            const pgResult = await provisionCoolifyPostgres(config, serverEnvDir);
            ledger?.record({ kind: "coolifyDb", uuid: pgResult.databaseUuid });
          } else {
            const { provisionCoolifyMongo } = await import("./deploy/coolify-mongo.js");
            const mongoResult = await provisionCoolifyMongo(config, serverEnvDir);
            ledger?.record({ kind: "coolifyDb", uuid: mongoResult.databaseUuid });
          }
        } catch (err) {
          const engineLabel = config.dbEngine === "postgres" ? "Postgres" : "MongoDB";
          const uriVar = config.dbEngine === "postgres" ? "POSTGRES_URL" : "MONGODB_URI";
          console.log(
            chalk.yellow(`  Couldn't auto-provision ${engineLabel}: ${(err as Error).message}`),
          );
          console.log(
            chalk.dim(
              `  Create one manually in Coolify: New → Database → ${engineLabel},\n` +
                `  then set ${uriVar} on the app's env (or run\n` +
                `  \`dotenvx set ${uriVar} <url> -f packages/server/.env.production\`).`,
            ),
          );
        }
      }

      // Push the dotenvx private key to Coolify so the starter's server
      // can decrypt .env.production at runtime. Best-effort — if the
      // Coolify app doesn't exist yet (race with the stack script), we
      // print the manual command instead of failing the whole flow.
      if (scaffoldResult?.dotenvx) {
        try {
          // App name matches the project name (the dockercompose
          // wrapper). The candidate-list fallback in
          // `pushProjectKeyToCoolify` still catches legacy `-web`
          // projects.
          await pushProjectKeyToCoolify(config.name, { appName: config.name });
        } catch (err) {
          console.log(chalk.yellow(`  Couldn't auto-push dotenvx key: ${(err as Error).message}`));
          console.log(
            chalk.dim(
              `  Push manually once the Coolify app exists: hatchkit keys push ${config.name}`,
            ),
          );
        }
      }

      // Set the GH Actions deploy secrets so the starter's
      // build-and-deploy.yml workflow can hit Coolify on push.
      // Mirrors the same flow `hatchkit adopt` runs: discover the
      // matching Coolify app(s) by name, push COOLIFY_BASE_URL +
      // COOLIFY_API_TOKEN + per-app resource uuids + webhook URLs.
      // Best-effort — failures print a manual recipe.
      if (repoUrl && config.scaffoldRepo) {
        try {
          const { findCoolifyAppsForProject } = await import("./deploy/coolify-app.js");
          const { ghSecretExists, repoSlugFromRemote, setCoolifyDeploySecrets } = await import(
            "./deploy/gh-actions-secrets.js"
          );
          const slug = repoSlugFromRemote(repoUrl);
          const apps = await findCoolifyAppsForProject(config.name);
          if (slug) {
            if (apps.length > 0) {
              await setCoolifyDeploySecrets({
                projectDir: appDir,
                repoSlug: slug,
                apps,
              });
            } else {
              console.log(
                chalk.dim(
                  `  · No Coolify app named "${config.name}" / "${config.name}-server" / "${config.name}-client" / "${config.name}-web" found — skipping Coolify deploy secret push.`,
                ),
              );
            }
            const secretName = "DOTENV_PRIVATE_KEY_PRODUCTION";
            const preExisted = await ghSecretExists(appDir, slug, secretName);
            await pushProjectKeyToGh(config.name, slug);
            if (!preExisted) {
              ledger?.record({ kind: "ghActionsSecret", repo: slug, name: secretName });
            }
          }
        } catch (err) {
          console.log(
            chalk.yellow(`  Couldn't push GH Actions deploy secrets: ${(err as Error).message}`),
          );
        }
      }
    }

    // Step 6.25 (gh-pages only): run Pages setup. Writes the
    // .github/workflows/gh-pages.yml + CNAME file locally and wires
    // the remote side (enable Pages, register cname, configure DNS,
    // poll for the Let's Encrypt cert, flip https_enforced). Must
    // happen BEFORE push so the new files land in the first push and
    // the workflow runs immediately.
    if (
      config.deploymentMode === "gh-pages" &&
      config.scaffoldRepo &&
      config.runDeployment &&
      repoUrl
    ) {
      const { runPagesSetupProgrammatic } = await import("./deploy/pages.js");
      const { exec: bashExec } = await import("./utils/exec.js");
      // The scaffold's `pruneToClientOnly` rewrites the root build
      // script to `pnpm --filter @starter/shared run build && pnpm
      // --filter @starter/client run build` — runs from the repo
      // root, outputs to `packages/client/out/` (after the Pages-
      // mode Next config patch sets `output: "export"`).
      const detected = {
        kind: "node-build" as const,
        publishDir: "packages/client/out",
        packageManager: "pnpm" as const,
        buildScript: "build",
        workDir: "",
      };
      const slug = repoUrl.replace(/^https?:\/\/github\.com\//, "");
      try {
        const { pageUrl } = await runPagesSetupProgrammatic(appDir, {
          detected,
          domain: config.domain,
        });
        ledger?.record({
          kind: "ghPages",
          repo: slug,
          projectDir: appDir,
          cname: config.domain,
        });
        // Commit the workflow + CNAME file before the push step
        // below picks up the staged changes. Empty diffs (e.g. re-
        // running on an idempotent state) just produce a no-op commit.
        await bashExec("git", ["add", "-A"], { cwd: appDir, silent: true });
        const status = await bashExec("git", ["status", "--porcelain"], {
          cwd: appDir,
          silent: true,
        });
        if (status.stdout.trim()) {
          await bashExec("git", ["commit", "-m", "ci: GitHub Pages setup"], {
            cwd: appDir,
            silent: true,
          });
        }
        console.log(chalk.green(`  ✓ GitHub Pages will publish at ${pageUrl}`));
      } catch (err) {
        console.log(chalk.yellow(`  Couldn't auto-wire GitHub Pages: ${(err as Error).message}`));
        console.log(
          chalk.dim(`  Run \`hatchkit gh-pages\` from ${appDir} once the issue is resolved.`),
        );
      }
    }

    // Step 6.5: push the working branch to origin. Done AFTER Coolify
    // wiring + Actions-secret upserts so the workflow's first run
    // already has the secrets it needs to deploy. setupGitHub above
    // created the repo + `origin` but deliberately skipped the push.
    if (config.scaffoldRepo && config.createGithubRepo && repoUrl) {
      const { pushInitialBranch } = await import("./deploy/github.js");
      const pushed = await pushInitialBranch(appDir);
      if (pushed && config.deploymentMode === "coolify") {
        await configureGhcrForCreate(repoUrl, isCreatedGithubRepoPrivate(config), ledger);
      }
    }

    // Email forwarding (Cloudflare Email Routing) is now wired through
    // the standard provision pipeline at Step 1's runProvision call
    // when the planning-phase Email forwarding step set
    // `config.emailForwarding.enabled = true` (which also adds `"email"`
    // to provisionServices). No mid-exec confirm — answers are
    // collected up-front so the rest of `create` runs unattended.

    // Step 7: Deploy ML services
    if (
      config.runDeployment &&
      deploy.length > 0 &&
      config.gpuPlatforms &&
      config.gpuPlatforms.length > 0
    ) {
      const endpoints = await deployMlServices(
        deploy,
        config.gpuPlatforms,
        SERVICES_ROOT,
        config.customHfModelId,
      );

      // Print env vars to set
      if (Object.keys(endpoints).length > 0) {
        const { mlPlatformUrlEnv } = await import("./scaffold/ml-client.js");
        const knownServices = [
          "3d-extraction",
          "subtitles",
          "image-recognition",
          "background-removal",
          "custom-hf",
        ] as const;
        type KnownService = (typeof knownServices)[number];

        console.log(chalk.bold("\n  ML service endpoints (add to Coolify env):"));
        console.log(chalk.dim(`    ML_BACKEND=${config.gpuPlatforms[0]}`));
        for (const [service, byPlatform] of Object.entries(endpoints)) {
          if (!(knownServices as readonly string[]).includes(service)) continue;
          const svc = service as KnownService;
          // Per-platform URL — the runtime config picks one based on ML_BACKEND.
          for (const [platform, url] of Object.entries(byPlatform)) {
            if (!url) continue;
            console.log(chalk.dim(`    ${mlPlatformUrlEnv(svc, platform as GpuPlatform)}=${url}`));
          }
          // Legacy ENDPOINT for back-compat — points at the default platform.
          const defaultUrl = byPlatform[config.gpuPlatforms[0]];
          if (defaultUrl) {
            console.log(chalk.dim(`    ${mlEnvVarName(svc)}=${defaultUrl}`));
          }
        }
      }
    }
    ledger?.complete();
  } catch (err) {
    // Ctrl+C path: the SIGINT handler is already driving the
    // recipe/rollback flow and will call process.exit when its prompt
    // resolves. Don't run a second cleanup or race it to the exit.
    if (isCancelInProgress()) return;
    if (ledger) {
      await handleCreateFailure(ledger, err);
    } else {
      console.log(chalk.red(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`));
    }
    process.exit(1);
  } finally {
    uninstallCancelHandler();
  }

  // Final summary
  console.log(chalk.bold("\n  ── Done! ─────────────────────────────────────────────────\n"));
  console.log(`  App:       ${chalk.cyan(`https://${config.domain}`)}`);
  // Skip the API line for static — there's no backend, so showing a
  // "/api" URL just confuses the user (and falsely implies a service
  // is listening at that path).
  if (config.surfaces !== "static") {
    console.log(`  API:       ${chalk.cyan(`https://${config.domain}/api`)}`);
  }
  if (config.deploymentMode === "gh-pages") {
    console.log(
      chalk.dim(
        `  Hosting:   GitHub Pages — first build kicks off on push, https cert provisions over the next few minutes.`,
      ),
    );
  }
  console.log(`  App dir:   ${chalk.dim(appDir)}`);
  console.log(`  Config:    ${chalk.dim(getConfigPath())}`);

  if (config.scaffoldRepo) {
    if (installedDeps) {
      console.log(chalk.yellow(`\n  Next: cd ${config.name} && pnpm dev`));
    } else {
      console.log(chalk.yellow(`\n  Next: cd ${config.name} && pnpm install && pnpm dev`));
    }
  }

  if (config.features.includes("mobile")) {
    console.log(chalk.yellow("\n  Next (mobile): generate native projects once:"));
    console.log(chalk.dim("    pnpm cap:add:ios       # requires Xcode"));
    console.log(chalk.dim("    pnpm cap:add:android   # requires Android Studio / SDK"));
  }

  if (config.features.includes("desktop")) {
    console.log(
      chalk.yellow("\n  Next (desktop): replace build/icon.png with a 512×512 logo, then:"),
    );
    console.log(chalk.dim("    pnpm icons:desktop     # cross-platform (icon-gen)"));
  }

  if (config.features.includes("desktop") || config.features.includes("mobile")) {
    console.log(
      chalk.yellow(
        "\n  Server CORS: TRUSTED_ORIGINS is already set in .env.example for native clients.",
      ),
    );
    console.log(
      chalk.dim(
        "  Make sure the same values land in your production env (Coolify / secret store).",
      ),
    );
    // Note: file:// sends Origin: null — not safe with credentials. A
    // custom Electron protocol (app://-) is what needs to be trusted.
  }

  console.log();
}

async function handleUpdate(): Promise<void> {
  const projectDir = resolve(".");
  const result = await runUpdate(projectDir);
  if (result.added.length > 0) {
    console.log(chalk.green(`\n  ✓ Added features: ${result.added.join(", ")}`));
    console.log(chalk.yellow("  Run `pnpm install` to pick up the new dependencies."));
  }
  if (result.removed.length > 0) {
    console.log(chalk.yellow(`  ⚠ Removal requested but skipped: ${result.removed.join(", ")}`));
  }
  if (result.localDevEnabled) {
    console.log(
      chalk.yellow(
        "  Run `pnpm install` to pick up @hatchkit/dev-plugin-next, then `hatchkit doctor` to confirm host plumbing.",
      ),
    );
  }
}

async function handleServer(): Promise<void> {
  const sub = args[1];
  if (sub !== "add") {
    console.log("Usage: hatchkit server add [--yes] [--dry-run] [--server-dir <path>]");
    console.log("Run `hatchkit help server` for details.");
    process.exit(1);
  }
  const { runServerAdd } = await import("./scaffold/server-add.js");
  const result = await runServerAdd(resolve("."), {
    yes: args.includes("--yes") || args.includes("-y"),
    dryRun: args.includes("--dry-run"),
    serverDir: flagValue("--server-dir"),
    sharedDir: flagValue("--shared-dir"),
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.dryRun) {
    console.log(chalk.yellow("  --dry-run — no files were changed."));
  }
  if (result.created.length > 0) {
    console.log(chalk.green(`  ✓ Created: ${result.created.join(", ")}`));
  }
  if (result.updated.length > 0) {
    console.log(chalk.green(`  ✓ Updated: ${result.updated.join(", ")}`));
  }
  if (result.reused.length > 0) {
    console.log(chalk.dim(`  · Reused existing: ${result.reused.join(", ")}`));
  }
  for (const warning of result.warnings) {
    console.log(chalk.yellow(`  ! ${warning}`));
  }
  if (result.skipped.length > 0 && !result.changed) {
    console.log(chalk.dim(`  · ${result.skipped.join(", ")}`));
  }
  if (result.nextSteps.length > 0) {
    console.log(chalk.bold("\n  Next:"));
    for (const step of result.nextSteps) console.log(`    ${step}`);
  }
}

async function handleConfig(): Promise<void> {
  const subcommand = args[1];

  switch (subcommand) {
    case "add": {
      const provider = args[2];
      if (!provider) {
        console.log("Usage: hatchkit config add <provider>");
        console.log(
          "Providers: coolify, coolify-github-app, ghcr, hetzner, dns, s3, modal, runpod, hf, replicate, glitchtip, openpanel, plausible, listmonk, ses, search-console, stripe",
        );
        return;
      }
      // Handle provider setup based on name
      const gpuPlatforms = ["modal", "runpod", "hf", "replicate"] as const;
      type GpuPlatformName = (typeof gpuPlatforms)[number];
      const isGpuPlatform = (p: string): p is GpuPlatformName =>
        (gpuPlatforms as readonly string[]).includes(p);

      switch (provider) {
        case "coolify":
        case "coolify-github-app":
        case "hetzner":
        case "dns":
        case "glitchtip":
        case "openpanel":
        case "plausible":
        case "ses":
        case "search-console":
        case "stripe":
          await reconfigureProvider(provider);
          break;
        case "ghcr": {
          // `--manual` forces the legacy paste flow for users who want a
          // machine PAT separate from the gh CLI session (e.g. an SSO'd
          // org token, or a CI machine where gh isn't logged in).
          // Otherwise hatchkit derives the pull token from `gh` directly.
          const manual = args.includes("--manual");
          await reconfigureProvider("ghcr", { manual });
          break;
        }
        case "listmonk": {
          // `hatchkit config add listmonk --deploy` walks the user
          // through deploying Listmonk on Coolify before the regular
          // URL/api-user/token prompts. Plumbed via the opts arg on
          // reconfigureProvider rather than a parallel path so the
          // wipe-then-ensure invariant stays in one place.
          const deploy = args.includes("--deploy");
          await reconfigureProvider("listmonk", { deploy });
          break;
        }
        case "s3": {
          // Accept the sub-provider as a positional arg so doctor's
          // recovery hint (`hatchkit config add s3 r2`) is a one-line
          // copy-paste — no interactive picker between the user and
          // re-pasting the rotated token. Falls back to the picker
          // when omitted, for parity with the no-arg menu.
          const sub = args[3];
          const validSubs = ["hetzner", "aws", "r2"] as const;
          type S3Sub = (typeof validSubs)[number];
          let p: S3Sub;
          if (sub && (validSubs as readonly string[]).includes(sub)) {
            p = sub as S3Sub;
          } else if (sub) {
            console.log(chalk.red(`  Unknown S3 sub-provider: ${sub}`));
            console.log(chalk.dim(`  Valid: ${validSubs.join(", ")}`));
            return;
          } else {
            const { select } = await import("@inquirer/prompts");
            p = await select({
              message: "S3 provider:",
              choices: [
                { name: "Hetzner", value: "hetzner" as const },
                { name: "AWS", value: "aws" as const },
                { name: "R2 (Cloudflare)", value: "r2" as const },
              ],
            });
          }
          await reconfigureProvider(`s3.${p}`);
          break;
        }
        default:
          if (!isGpuPlatform(provider)) {
            console.log(chalk.red(`  Unknown provider: ${provider}`));
            console.log(
              chalk.dim(
                "  Valid: coolify, coolify-github-app, ghcr, hetzner, dns, s3, modal, runpod, hf, replicate, glitchtip, openpanel, plausible, listmonk, ses, search-console, stripe",
              ),
            );
            return;
          }
          await reconfigureProvider(`gpu.${provider}`);
      }
      break;
    }
    case "reset": {
      const ok = await confirm({
        message: "Clear ALL CLI config (providers, tokens, ML registry)?",
        default: false,
      });
      if (ok) {
        await resetConfig();
        console.log(chalk.green("  ✓ Config cleared."));
      } else {
        console.log(chalk.dim("  Cancelled."));
      }
      break;
    }
    default: {
      // Show current config status
      const config = getConfig();
      console.log(chalk.bold("\n  Provider Status:\n"));
      console.log(
        `  GitHub:   ${config.providers.github.status === "configured" ? chalk.green("✓") : chalk.red("✗")}`,
      );
      console.log(
        `  Coolify:  ${config.providers.coolify?.status === "configured" ? chalk.green("✓") : chalk.red("✗")}`,
      );
      console.log(
        `  GHCR:     ${config.providers.ghcr?.status === "configured" ? chalk.green(`✓ (${config.providers.ghcr.username ?? ""})`) : chalk.dim("not configured (only needed for private adopt)")}`,
      );
      console.log(
        `  Hetzner:  ${config.providers.hetzner?.status === "configured" ? chalk.green("✓") : chalk.red("✗")}`,
      );
      console.log(
        `  DNS:      ${config.providers.dns?.status === "configured" ? chalk.green(`✓ (${config.providers.dns.provider})`) : chalk.red("✗")}`,
      );

      const s3Providers = Object.keys(config.providers.s3);
      console.log(
        `  S3:       ${s3Providers.length > 0 ? chalk.green(`✓ (${s3Providers.join(", ")})`) : chalk.dim("not configured")}`,
      );

      const gpuProviders = Object.keys(config.providers.gpu);
      console.log(
        `  GPU:      ${gpuProviders.length > 0 ? chalk.green(`✓ (${gpuProviders.join(", ")})`) : chalk.dim("not configured")}`,
      );

      const services = getMlServices();
      const serviceCount = Object.keys(services).length;
      console.log(
        `\n  ML Services: ${serviceCount > 0 ? chalk.green(`${serviceCount} registered`) : chalk.dim("none")}`,
      );
      for (const [name, entry] of Object.entries(services)) {
        console.log(chalk.dim(`    ${name}: ${entry.endpoint} (${entry.platform})`));
      }

      console.log(chalk.dim(`\n  Config: ${getConfigPath()}\n`));
    }
  }
}

type HelpTopic =
  | "create"
  | "init"
  | "setup"
  | "config"
  | "update"
  | "server"
  | "keys"
  | "secrets"
  | "add"
  | "adopt"
  | "assets"
  | "remove"
  | "destroy"
  | "rename-domain"
  | "rename-project"
  | "set-description"
  | "sync"
  | "regen-infra"
  | "doctor"
  | "dev-setup"
  | "inventory"
  | "overview"
  | "status"
  | "explain"
  | "completion"
  | "gh-pages"
  | "dns"
  | "email";

function printHelp(topic?: HelpTopic): void {
  if (topic === "create") {
    console.log(`
  ${chalk.bold("hatchkit create")} — scaffold a new project

  ${chalk.bold("Usage:")}
    hatchkit create [--dry-run]

  ${chalk.bold("What it does (interactively):")}
    1. Prompts for project name, domain, surfaces, deployment mode, features, services, ML
    2. Copies the starter template and strips unselected features
    3. Assigns unique ports per project (server, client, native HMR)
    4. Runs \`pnpm install\` (if pnpm is present and you opt in)
    5. Initializes git, optionally creates a GitHub repo
    6. Optionally provisions GlitchTip/OpenPanel/Plausible, Listmonk + SES, Email Routing, Search Console
    7. Generates Terraform tfvars + Coolify .env (Coolify mode)
    8. Deploys: Terraform → Coolify → ML  ${chalk.dim("OR")}  GitHub Pages setup

  ${chalk.bold("Deployment modes:")}
    ${chalk.cyan("coolify")}        Full-stack on Hetzner — DB, providers, Docker. Default.
    ${chalk.cyan("gh-pages")}       Static-only on GitHub Pages. Only offered when surfaces
                   is ${chalk.dim("static")}; the scaffold's Next config is patched to
                   ${chalk.dim('`output: "export"`')} and the gh-pages workflow is written.
    ${chalk.cyan("scaffold-only")}  Write files, skip deploy. Pick this to defer setup.

  ${chalk.bold("Options:")}
    --dry-run       Show the plan without writing anything
    --help          Show this help
`);
    return;
  }
  if (topic === "init" || topic === "setup") {
    console.log(`
  ${chalk.bold("hatchkit setup")} — one-time onboarding ${chalk.dim("(alias: init)")}

  Interactively wires up every credential hatchkit needs:
    - GitHub (via gh CLI)
    - Coolify (URL + token)
    - Hetzner Cloud, DNS provider, S3 (optional)
    - GlitchTip, OpenPanel, Listmonk + SES, Search Console (optional)

  Tokens go to the OS keychain; metadata to
  ${chalk.dim(getConfigPath())}.
  Any skipped providers are prompted for on first use.
`);
    return;
  }
  if (topic === "keys") {
    console.log(`
  ${chalk.bold("hatchkit keys")} — manage per-project dotenvx private keys

  ${chalk.bold("Subcommands:")}
    keys show <project>     Print DOTENV_PRIVATE_KEY_PRODUCTION from the
                            OS keychain. Useful for piping into pbcopy
                            or pasting into Coolify / CI secret stores.
    keys set <project>      Upsert the key into the OS keychain. Source
                            (in priority order): ${chalk.cyan("--key=…")}, ${chalk.cyan("--stdin")},
                            or auto-read from ${chalk.cyan("./.env.keys")}'s
                            DOTENV_PRIVATE_KEY_PRODUCTION line. Idempotent.
    keys rotate <project>   Run \`dotenvx rotate -f .env.production\`,
                            prune ${chalk.cyan(".env.keys")} back to the new key,
                            update the keychain, AND ${chalk.bold("by default")} push
                            to Coolify + the detected GitHub repo. Pass
                            ${chalk.cyan("--no-push")} to skip propagation.
    keys push <project>     Mirror the keychain copy to a deploy target.

  ${chalk.bold("Flags (apply to set / rotate / push):")}
    --key=<value>           Direct value for ${chalk.cyan("keys set")}.
    --stdin                 (set) Read the key from stdin (e.g. \`cat key | hatchkit keys set …\`).
    --target={coolify|gh|both}  Where ${chalk.cyan("keys push")} mirrors to. Default
                            ${chalk.dim("coolify")} for back-compat.
    --repo <owner/repo>     GH repo for ${chalk.cyan("keys push --target=gh|both")}.
                            Inferred from ${chalk.dim("git remote origin")} when omitted.
    --no-push               (rotate) Skip Coolify + GitHub propagation.
                            Use only when you intend to handle the
                            fan-out yourself (rare — the default is
                            ${chalk.bold("push everywhere previously configured")}).
    --push-gh <owner/repo>  (rotate) Override the auto-detected GitHub
                            repo for the DOTENV_PRIVATE_KEY_PRODUCTION
                            Actions secret push.
    --push-coolify          (rotate) Accepted for back-compat — Coolify
                            is now pushed to by default. No-op.
    --dry-run               Print what would change, don't write.
    --json                  Machine-readable output.

  ${chalk.bold("Examples:")}
    hatchkit keys rotate raptor-runner
    hatchkit keys rotate raptor-runner --no-push
    cat .env.keys | hatchkit keys set raptor-runner --stdin
    hatchkit keys push raptor-runner --target=both --repo acme/raptor

  The key is generated at scaffold time and lives in macOS Keychain /
  libsecret under the "hatchkit" service. Never written to git.
`);
    return;
  }
  if (topic === "secrets") {
    console.log(`
  ${chalk.bold("hatchkit secrets")} — rotate per-project provider credentials

  ${chalk.bold("Subcommands:")}
    secrets rotate <project>   Mint fresh upstream credentials for every
                               detected provider, write them to
                               ${chalk.cyan(".env.production")} (encrypted) and
                               ${chalk.cyan(".env.development")} (plaintext), push to
                               deploy targets, verify, then revoke the
                               old credential. Two-phase: a verify
                               failure leaves the OLD credential live
                               and stashes a rollback blob in the
                               keychain so you can recover.

  ${chalk.bold("Flags (rotate):")}
    --env production           Scope the rotation. Only ${chalk.cyan("production")} is
                               supported today.
    --providers <list>         Comma list of adapter names, or ${chalk.cyan("all")}.
                               E.g. ${chalk.dim("--providers=openpanel,glitchtip")}.
                               Default: ${chalk.dim("all")} (every registered adapter
                               whose detect() returns true).
    --push-targets <list>      Comma list of ${chalk.cyan("coolify")}, ${chalk.cyan("gh")} (alias
                               ${chalk.cyan("github")}), or ${chalk.cyan("both")} / ${chalk.cyan("none")}. Default:
                               ${chalk.dim("both")} — silently filters to whatever's
                               actually configured + detected.
    --revoke-old=<policy>      ${chalk.cyan("after-verify")} (default): revoke OLD
                               credential only after verify succeeds.
                               ${chalk.cyan("never")}: leave OLD credential live (safe
                               for audit replays).
                               ${chalk.cyan("immediate")}: revoke BEFORE verify (for
                               emergency leak-race rotations only).
    --push-gh <owner/repo>     Override the auto-detected GitHub repo
                               for the Actions secret push. (alias:
                               ${chalk.cyan("--repo")})
    --dry-run                  Print the plan (providers, env-key names,
                               deploy targets, revoke policy) without
                               minting, writing, or pushing anything.
    --json                     Emit one NDJSON line of ${chalk.cyan("RotationAudit")} on
                               stdout. Names + outcomes only — never
                               credential values.

  ${chalk.bold("Examples:")}
    hatchkit secrets rotate raptor-runner
    hatchkit secrets rotate raptor-runner --dry-run
    hatchkit secrets rotate raptor-runner --providers=openpanel
    hatchkit secrets rotate raptor-runner --push-targets=none
    hatchkit secrets rotate raptor-runner --revoke-old=immediate

  ${chalk.bold("Safety:")}
    REFUSES if ${chalk.cyan(".env.keys")} is tracked by git (run
    ${chalk.cyan("git rm --cached .env.keys && hatchkit keys rotate <project>")} first).
    WARNS but proceeds if ${chalk.cyan(".env.production")} isn't dotenvx-encrypted
    (run ${chalk.cyan("hatchkit adopt")} first to migrate).
    A failed verify leaves the OLD credential live and stashes a
    rollback blob under keychain account
    ${chalk.dim("secrets-rollback:<project>:<adapter>")}.
`);
    return;
  }
  if (topic === "update") {
    console.log(`
  ${chalk.bold("hatchkit update")} — add features to an already-scaffolded project

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit update

  ${chalk.bold("What it does:")}
    Reads the project's .hatchkit.json manifest, lets you pick a new
    feature set, and copies the additive pieces from the starter.
    Currently supported additions: ${chalk.cyan("desktop")}, ${chalk.cyan("mobile")}.

  ${chalk.bold("Removal is not supported.")} Removing features could delete
    user code — remove manually + edit the manifest.
`);
    return;
  }
  if (topic === "server") {
    console.log(`
  ${chalk.bold("hatchkit server add")} — retrofit a server into a static project

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit server add
    cd <project-dir> && hatchkit server add --yes

  ${chalk.bold("What it does:")}
    Reads .hatchkit.json, copies the Hatchkit server package from the
    starter, restores shared server types, updates root scripts/workspace
    files, flips manifest surfaces from ${chalk.cyan("static")} to
    ${chalk.cyan("fullstack")}, and switches gh-pages projects back to coolify.

  ${chalk.bold("What it does not do:")}
    No provider calls. No Coolify, DNS, GitHub, keychain, or Terraform
    mutation. To wire deploy infra after the local scaffold:

      hatchkit adopt --resume --regenerate-pipeline

  ${chalk.bold("Options:")}
    --server-dir <path>   Destination for the server package. Default:
                          ${chalk.dim("packages/server")}.
    --shared-dir <path>   Destination for the shared package. Default:
                          ${chalk.dim("packages/shared")}.
    --yes, -y             Skip confirmation.
    --dry-run             Show planned local changes without writing.
    --json                Machine-readable result.
`);
    return;
  }
  if (topic === "gh-pages") {
    console.log(`
  ${chalk.bold("hatchkit gh-pages")} — wire GitHub Pages for the current repo

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit gh-pages
    cd <project-dir> && hatchkit gh-pages --undo [--dry-run] [--yes]

  ${chalk.bold("What it does:")}
    1. Reads the repo via \`gh repo view\` (must be a GitHub repo you own).
    2. Scans the repo root + ${chalk.dim("docs/ site/ www/ web/")} for candidate sites:
         - ${chalk.cyan("jekyll")}      (Gemfile + _config.yml)
         - ${chalk.cyan("node-build")}  (package.json with a \`build\` script)
         - ${chalk.cyan("static")}      (index.html)
       If multiple sites are found, prompts you to pick. If none are
       found, prompts for kind + location manually.
    3. Enables Pages via the GitHub API with ${chalk.dim("build_type=workflow")}.
    4. Writes ${chalk.cyan(".github/workflows/gh-pages.yml")} tailored to the site kind.
       Refuses to overwrite any existing Pages workflow in the repo.
    5. Optionally registers a custom domain + wires DNS:
         - Cloudflare: auto-configured via API (uses your stored token)
         - INWX / manual: prints the records you need to add
       Also writes a ${chalk.cyan("CNAME")} file into the published folder (or
       ${chalk.dim("public/")} for build-step projects).

  ${chalk.bold("After running:")}
    git add -A && git commit -m "ci: deploy to GitHub Pages" && git push

  ${chalk.bold("Undo (--undo):")}
    Reverses what the command put in place:
      - Disables Pages via ${chalk.dim("DELETE /repos/<owner>/<repo>/pages")} (clears the cname too).
      - Deletes Cloudflare records that point at GitHub's Pages IPs / ${chalk.dim("<user>.github.io")}
        for the registered domain (only when a Cloudflare token is configured + the
        zone is in this account).
      - Removes ${chalk.cyan(".github/workflows/gh-pages.yml")} (only the file hatchkit writes
        — hand-written Pages workflows are left untouched).
      - Removes any ${chalk.cyan("CNAME")} files whose content matches the registered domain.
    ${chalk.dim("--dry-run")} prints the plan without changing anything. ${chalk.dim("--yes")} skips the confirm.

  ${chalk.bold("Notes:")}
    - Private repos need a paid GitHub plan for Pages. Free-tier repos
      must be made public first.
    - For ${chalk.dim("node-build")} sites, confirm the detected publish dir matches what
      your build tool actually outputs (Vite → dist, CRA → build, etc).
    - Monorepos / hybrids: if both the root and ${chalk.dim("docs/")} have sites, you'll
      be prompted to pick one. Run the command twice if you want both.
`);
    return;
  }
  if (topic === "dns") {
    console.log(`
  ${chalk.bold("hatchkit dns")} — DNS reconciliation helpers

  ${chalk.bold("Subcommands:")}
    link-to-cloudflare [domain...]
        For each Cloudflare zone, push its nameservers to INWX as the
        registrar delegation. Use after importing zones into Cloudflare
        when you don't want to click through INWX per-domain.

        No args  → processes every zone the token can see.
        Args     → space-separated domain names, filters to those.
        ${chalk.dim("--dry-run")}     → print-only, no API calls.
        ${chalk.dim("INWX_SANDBOX=1")} → use the OTE sandbox instead of production.

  ${chalk.bold("Prerequisites:")}
    Run ${chalk.cyan("hatchkit config add dns")} (Cloudflare-only), then answer
    ${chalk.cyan("yes")} to "Is INWX your domain registrar?" when prompted.
`);
    return;
  }
  if (topic === "email") {
    console.log(`
  ${chalk.bold("hatchkit email")} — Cloudflare Email Routing + SES MAIL FROM

  ${chalk.bold("Subcommands:")}
    setup            Configure Email Routing + DNS (MX, SPF, DMARC) for a domain
    status           Print current routing state (read-only)
    ses-mail-from    Manage SES Custom MAIL FROM Domain for this project
                     ${chalk.dim("(subcommands: setup | status | remove)")}

  ${chalk.bold("Flags (setup):")}
    --domain <fqdn>           Override the project domain
    --to <email>              Forwarding destination (saved globally on first use)
    --addresses <list>        Comma-separated local parts (skips picker)
    --all-defaults            Use every default preset; skip picker
    --no-catch-all            Don't set the *@domain catch-all rule
    --dmarc <none|quarantine|reject>  DMARC policy (default: quarantine)
    --no-listmonk-spf         Skip auto-merging amazonses.com

  ${chalk.bold("What it sets:")}
    · Email Routing enabled on the zone
    · Destination address verified at Cloudflare (verification email sent)
    · MX records → route1/route2/route3.mx.cloudflare.net
    · SPF TXT (single record, merged with SES if detected)
    · DMARC TXT at _dmarc.<domain> (default p=quarantine sp=none)
    · One forwarding rule per picked address
    · Optional catch-all rule (*@<domain>)

  ${chalk.bold("Prerequisites:")}
    DNS must be on Cloudflare (${chalk.cyan("hatchkit config add dns")}). The token
    needs Zone:DNS:Edit + Zone:Email Routing Rules:Edit +
    Account:Email Routing Addresses:Edit.
`);
    return;
  }
  if (topic === "doctor") {
    console.log(`
  ${chalk.bold("hatchkit doctor")} — verify every configured provider

  Runs a read-only API call against each provider whose credentials are
  stored (Coolify /version, Hetzner /servers, Cloudflare /tokens/verify,
  Listmonk /api/lists, …). Reports ok / fail / not-configured per provider
  and exits non-zero if any check fails. Safe to run repeatedly.
`);
    return;
  }
  if (topic === "dev-setup") {
    console.log(`
  ${chalk.bold("hatchkit dev-setup")} — Tailscale-served dev URLs

  Wires up the host-wide plumbing that makes every scaffolded project
  reachable from any Tailscale peer at:

    ${chalk.cyan("https://<slug>.local.<your-domain>/")}

  …without per-project DNS, port juggling, or framework basePath config.

  ${chalk.bold("Host-wide subcommands (run once per machine):")}
    dev-setup init [--force]   Auto-write ~/.config/dev/Caddyfile, register
                               a launchd job to run Caddy on a free port
                               (default 9443, auto-bumps on collision),
                               register a tailscale serve TCP=443 bridge,
                               and auto-upsert the wildcard DNS A record
                               when Cloudflare credentials are available.
                               Idempotent — safe to re-run.
    dev-setup status           Print the same Local-dev rows that
                               ${chalk.cyan("hatchkit doctor")} would show.

  ${chalk.bold("Per-project subcommands (retrofit existing projects):")}
    dev-setup enable [--slug <s>] [--port <p>] [--project-dir <path>]
                               Wire the project at cwd (or --project-dir)
                               for Tailscale dev URLs: writes Caddy fragment,
                               docs/dev-setup.md, patches next.config to
                               wrap with ${chalk.cyan("withLocalDev")}, adds
                               ${chalk.cyan("@hatchkit/dev-plugin-next")} to
                               package.json. Persists slug in .hatchkit.json.
                               New scaffolds auto-enable this — only needed
                               for projects created before the integration
                               landed.
    dev-setup disable          Remove the Caddy fragment + docs file. Leaves
                               next.config + dep in place (they're inert
                               without the fragment).

  ${chalk.bold("DNS:")}
    ${chalk.cyan("dev-setup init")} auto-upserts a DNS-only A record on a
    dedicated ${chalk.cyan("local.")} subdomain:
    *.local.<your-domain>  A  <your-tailnet-ip>  (DNS-only)

    Custom ${chalk.cyan("--domain")} values must use that ${chalk.cyan("local.")} prefix so
    Hatchkit never overwrites a production wildcard such as *.example.com.

    If Cloudflare credentials are unavailable, add that record manually.

  This feature is fully optional: until you run ${chalk.cyan("dev-setup init")},
  ${chalk.cyan("hatchkit doctor")} surfaces zero Local-dev rows. Within a project,
  set ${chalk.cyan("HATCHKIT_LOCAL_DEV=0")} in env to suppress the plugin entirely
  on a single dev run.
`);
    return;
  }
  if (topic === "overview") {
    console.log(`
  ${chalk.bold("hatchkit overview")} — fleet-level view of every configured provider

  Distinct from ${chalk.cyan("status")} (which providers do I have credentials for?),
  ${chalk.cyan("doctor")} (are those credentials valid?), and ${chalk.cyan("inventory")} (what does THIS
  project have?). ${chalk.cyan("overview")} answers "what does my whole hatchkit
  footprint look like, across every configured provider?" — no name or
  domain filter, just a roll-up of top-level resources.

  ${chalk.bold("What it lists:")}
    · Coolify              applications, projects, databases
    · Cloudflare DNS       zones
    · R2                   buckets (whole account)
    · Hetzner S3 / AWS S3  credential presence (bucket listing not implemented)
    · GlitchTip            projects in the configured org
    · OpenPanel            projects
    · Stripe               webhook endpoints (test + live)

  ${chalk.bold("Cross-references:")}
    After listing every provider, ${chalk.cyan("overview")} cross-references the
    raw data to flag fleet-level inconsistencies — the kind of bitrot
    that a single-provider lens can't see:

      · Coolify app deploys from a repo \`gh\` can't find (deleted/renamed)
      · App fqdn references an apex with no Cloudflare zone
      · R2 bucket follows the \`<project>-<role>\` convention but has no
        matching Coolify app (orphan from a destroyed project)
      · GlitchTip / OpenPanel / Plausible project/site with no Coolify app counterpart
      · Cloudflare zone with no Coolify app pointing into it

  ${chalk.bold("Flags:")}
    --all                Print every resource per provider (default: 6-line preview)
    --json               Machine-readable OverviewReport (non-interactive)

  Read-only — every call is a GET. Safe to run repeatedly.
`);
    return;
  }
  if (topic === "inventory") {
    console.log(`
  ${chalk.bold("hatchkit inventory")} — survey what already exists for this project

  Inverse of ${chalk.cyan("doctor")}: instead of "are my credentials valid?", asks
  "given THIS project (cwd / name / domain / repo), what resources
  already exist across every configured provider — and is anything
  out of sync?"

  ${chalk.bold("Inference (cwd → identity):")}
    · .hatchkit.json            — name, domain
    · package.json              — name, description
    · git remote                — GitHub owner/repo
    · CNAME file                — gh-pages custom domain
    · .env.production dotenvx   — encryption state
    · .github/workflows/        — gh-pages / Coolify deploy workflows

  Asks interactively for anything that couldn't be inferred. Confirms
  inferred values unless ${chalk.cyan("--yes")} is passed.

  ${chalk.bold("Scans (parallel, read-only):")}
    · Coolify    — projects, applications (with fqdn + git source)
    · DNS        — Cloudflare zone + relevant records (apex/www/api/s3/…)
    · R2         — buckets (manifest + naming-convention candidates) + CORS
    · GitHub     — repo visibility, Pages status, relevant repo secrets
    · GlitchTip  — projects in the configured org
    · OpenPanel  — projects
    · Stripe     — webhook endpoints whose URL contains the project domain

  ${chalk.bold("Drift detection (cross-references):")}
    · Coolify app fqdn vs DNS A record (and the linked server's public IP)
    · Coolify app git source vs local git remote (renamed repo gotcha)
    · Manifest s3Buckets entries vs live R2 buckets
    · Bucket CORS — manifest origins vs live policy
    · gh-pages workflow on disk vs Pages enabled on repo (and CNAME ↔ Pages cname)
    · dotenvx encrypted locally but no DOTENV_PRIVATE_KEY_PRODUCTION secret in GH

  ${chalk.bold("Flags:")}
    --name <project>     Override inferred project name
    --domain <domain>    Override inferred domain
    --repo <owner/name>  Override inferred GitHub repo
    --yes, -y            Skip confirm-inferred-value prompts
    --save               Write a minimal .hatchkit.json without prompting
    --no-save            Suppress the end-of-run save prompt
    --json               Machine-readable InventoryReport (non-interactive)

  ${chalk.bold("Persisting identity:")}
    After an interactive run, when ${chalk.cyan(".hatchkit.json")} doesn't yet exist
    and both name + domain are inferred, hatchkit offers to write a
    minimal manifest. The manifest carries the right schema for every
    other command (adopt, update, sync, keys), with conservative defaults
    for fields inventory can't infer (features=[], s3Provider="none",
    deployTarget="existing", ports={server:3000,client:5173}). Run
    ${chalk.cyan("hatchkit adopt --resume")} afterwards to flesh out the rest via
    the adopt stepper.
`);
    return;
  }
  if (topic === "add") {
    console.log(`
  ${chalk.bold("hatchkit add")} — provision per-project clients and write env files

  ${chalk.bold("Usage:")}
    hatchkit add [<project-name>] [<services>] [flags]
    hatchkit add [<services>] --name <project-name> [flags]
    hatchkit add [<services>] [flags]   ${chalk.dim("(inside a project with .hatchkit.json)")}

  ${chalk.bold("What it does:")}
    · GlitchTip / OpenPanel: ${chalk.bold("one project per product")}, events tagged by
      \`environment\` so dev / staging / prod share the same dashboard.
    · Plausible: one site for the public project domain, with browser tracker env.
      Observability values are written to ${chalk.cyan(".env.production")} only — dev noise pollutes real metrics.
      Pass ${chalk.cyan("--enable-dev-obs")} to populate ${chalk.cyan(".env.development")} too.
    · Listmonk + SES: verifies the SES sending identity for
      ${chalk.cyan("mail.<projectDomain>")}, publishes DKIM into Cloudflare, creates
      per-project ${chalk.cyan("<project>")} + ${chalk.cyan("<project>-test")} Listmonk lists,
      seeds passthrough tx + campaign templates, and writes LISTMONK_*/
      SES_SMTP_* into the server env.
    · Search Console: verifies the project domain via Cloudflare DNS TXT,
      then adds the ${chalk.cyan("sc-domain:<domain>")} property to your Google account.
      No runtime env is written.
    · ${chalk.cyan(".env.production")} is dotenvx-encrypted — commit-safe.
      ${chalk.cyan(".env.development")} is plaintext — gitignored, not encrypted.
    · A 0600 cache of every value is saved under
      ${chalk.dim("<config-dir>/provisioned/<project>.*.env")} for recoverability.
      ${chalk.dim("Secret values never hit stdout.")}
    · The interactive menu only shows services not already present for the
      current project, starts with nothing selected, and refuses explicit
      requests that would recreate known resources.
    · Before creating provider resources, add runs read-only existence probes
      for the selected services and stops on conflicts so cleanup stays safe.

  ${chalk.bold("Surfaces:")}
    hatchkit asks which surfaces your project has. Options:
      · ${chalk.cyan("fullstack")}  — single package, server runtime, one obs project (recommended)
      · ${chalk.cyan("split")}      — separate server + client packages, one obs project per surface
      · ${chalk.cyan("backend")}    — API / CLI / worker, no UI bundle
      · ${chalk.cyan("static")}     — gh-pages / S3+CDN / SPA, no server runtime

    Env for each surface is written to its own directory (e.g.
    ${chalk.dim("packages/server/.env.production")}, ${chalk.dim("packages/client/.env.production")}).

  ${chalk.bold("Services:")}
    glitchtip   GLITCHTIP_DSN (server) / PUBLIC_GLITCHTIP_DSN (client)
    openpanel   OPENPANEL_* (server) / PUBLIC_OPENPANEL_* (client)
    plausible   NEXT_PUBLIC_PLAUSIBLE_DOMAIN / *_SCRIPT_URL (client only)
    listmonk-ses
                LISTMONK_URL / _API_USER / _API_TOKEN / _FROM_EMAIL /
                _LIVE_LIST_ID / _TEST_LIST_ID / _TX_TEMPLATE_ID /
                _CAMPAIGN_TEMPLATE_ID + SES_SMTP_HOST / _PORT / _USERNAME /
                _PASSWORD (server only)
    search-console
                Google Search Console domain property (DNS verification; no env)
    s3          R2_<BUCKET>_ACCESS_KEY_ID / *_SECRET_ACCESS_KEY / *_BUCKET / R2_ENDPOINT
                — mints a per-bucket scoped Cloudflare R2 API token for every
                  bucket declared in .hatchkit.json (s3Buckets). Single-bucket
                  projects also get unprefixed R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
                  aliases. Buckets must already exist (s3Provider: "existing").

  ${chalk.bold("Flags:")}
    --enable-dev-obs            Also populate .env.development with obs creds.
    --no-write                  Skip writing; save 0600 cache only.
    --surfaces=<mode>           shared | server-only | client-only | separate
    --server-dir <path>         Server env directory (skips prompt when set).
    --client-dir <path>         Client env directory (skips prompt when set).
    --project-dir <path>        Project root for manifest/package/CNAME inference
                                (needed for s3 and non-Hatchkit Search Console onboarding;
                                inferred from --server-dir or prompted if omitted).
    --name <name>               Project name when no positional or manifest name exists.
    --domain <domain>           Site/domain-scoped services (Plausible, Search Console);
                                prompted for Search Console when omitted.

  ${chalk.bold("Examples:")}
    hatchkit add
    hatchkit add search-console
    hatchkit add raptor-runner
    hatchkit add raptor-runner all --enable-dev-obs
    hatchkit add search-console --name asteroids --domain asteroids.example.com \\
        --project-dir ~/projects/asteroid-game
    hatchkit add my-app search-console --domain app.example.com --project-dir ./my-app
    hatchkit add fractal-garden search-console --domain fractal.garden
    hatchkit add raptor-runner glitchtip,listmonk-ses --no-write
    hatchkit add raptor-runner all --surfaces=shared \\
        --server-dir ./raptor-runner/packages/server \\
        --client-dir ./raptor-runner/packages/client
`);
    return;
  }
  if (topic === "adopt") {
    console.log(`
  ${chalk.bold("hatchkit adopt")} — bring an existing project under hatchkit management

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit adopt

  ${chalk.bold("What it does:")}
    Inverse of \`hatchkit create\`. Inspects the current directory,
    detects what's already there (package.json name, repo layout,
    .env state, dotenvx encryption, Coolify app match, git origin,
    feature flags inferable from deps), then runs a stepper-style
    review. On confirm:

      · ${chalk.cyan("Initialize dotenvx")} — generates an encrypted
        \`.env.production\` + \`.env.keys\` if missing, or re-encrypts
        an existing plain file. The keypair is what every other
        hatchkit step depends on, so this defaults to ON.
      · Imports DOTENV_PRIVATE_KEY_PRODUCTION into the OS keychain.
      · Writes \`.hatchkit.json\` so \`update\`, \`add\`, \`keys\` recognise
        the project.
      · ${chalk.cyan("GitHub remote")} — \`git init\` (if needed),
        commit, \`gh repo create --private|--public --source=. --push\`.
        Visibility is prompted (default private) or set with
        \`--github-visibility private|public\`. Skipped when an \`origin\`
        is already set.
      · ${chalk.cyan("Coolify + DNS")} — direct REST-API calls into the
        Coolify and Cloudflare you already configured (no Terraform,
        no submodule). Finds or creates the Coolify project, picks
        the server (single-server setups auto-resolve), creates the
        application from the GitHub repo (private repos use a
        Coolify GitHub App source), pushes the baseline env
        (DOTENV_PRIVATE_KEY_PRODUCTION + GITHUB_REPO_URL), upserts an
        A record \`<domain> → <server-ip>\` on Cloudflare, and triggers
        the first deploy. Defaults ON when no matching app exists.
      · Optionally provisions GlitchTip / OpenPanel / Plausible / Listmonk + SES,
        Email Routing, and Search Console (same machinery as \`hatchkit add\`).
      · Optionally pushes the dotenvx private key to Coolify
        (redundant when the Coolify+DNS step ran — it already does).

  ${chalk.bold("Limitations:")}
    · Cloudflare only for DNS automation. INWX / manual users get a
      "create the A record yourself" hint with the exact target IP.
    · Doesn't provision new Hetzner servers — the Coolify wiring
      assumes the server is already in your Coolify dashboard.

  ${chalk.bold("When to use:")}
    The project wasn't created by hatchkit but you want it managed
    going forward.

  ${chalk.bold("Refuses to run twice — unless you ask:")}
    If \`.hatchkit.json\` already exists, adopt exits with a hint
    pointing at \`hatchkit update\` / \`hatchkit add\`. When a previous
    adopt run failed mid-way (e.g. Coolify rejected something) and
    you want to retry, pass \`--resume\` to re-run over the existing
    manifest. Already-finished steps (encrypted .env, configured
    git origin, existing Coolify app) auto-skip; only the unfinished
    bits actually run.

  ${chalk.bold("--regenerate-pipeline")}
    Re-render the build pipeline files (Dockerfile, docker-compose.yml,
    .github/workflows/deploy.yml) over the existing copies. Useful when
    the templates picked up a fix you want — e.g. the Node base-image
    auto-detection, newer GitHub Actions versions. Pre-existing files
    that get overwritten are NOT recorded in the rollback ledger,
    so a later \`hatchkit destroy\` won't surprise-delete them.
    Combine with \`--resume\` if the project is already adopted:
      hatchkit adopt --resume --regenerate-pipeline
`);
    return;
  }
  if (topic === "remove") {
    console.log(`
  ${chalk.bold("hatchkit remove")} — inverse of ${chalk.cyan("add")}: tear down per-project clients

  ${chalk.bold("Usage:")}
    hatchkit remove [<project-name>] [<services>] [--dry-run] [--yes]

  Both positional args are optional — anything missing is prompted for.
  ${chalk.dim("(<services> is 'all', a single service, or a comma-separated list.)")}

  ${chalk.bold("What it does:")}
    For every selected service, deletes both clients:
      - ${chalk.cyan("<project-name>-dev")}
      - ${chalk.cyan("<project-name>-prod")}
    Also removes the local env cache at
    ${chalk.dim("<config-dir>/provisioned/<project-name>.{dev,prod}.env")}.

    Re-runs are idempotent — missing upstream resources log
    ${chalk.dim("already gone")} and keep going.

  ${chalk.bold("Services:")}
    glitchtip   Deletes the GlitchTip project
    openpanel   Deletes the OpenPanel project (and clears cached creds)
    plausible   Deletes the Plausible site cached for this project
    listmonk-ses
                Deletes the per-project Listmonk lists; keeps the SES identity
                so a future re-add can reuse the verified sending subdomain
    search-console
                Removes the Search Console property from your Google account
                (keeps DNS verification token / ownership state)
    s3          Deletes per-bucket scoped Cloudflare R2 API tokens
                (clears the keychain entries and DELETEs upstream)

  ${chalk.bold("Options:")}
    --dry-run   Print what would be deleted; hit no APIs, remove no files.
    --yes, -y   Skip the interactive confirmation prompt.

  ${chalk.bold("Examples:")}
    hatchkit remove raptor-runner all
    hatchkit remove raptor-runner glitchtip,listmonk-ses --dry-run
    hatchkit remove raptor-runner all --yes
`);
    return;
  }
  if (topic === "destroy") {
    console.log(`
  ${chalk.bold("hatchkit destroy")} — undo a project that ${chalk.cyan("hatchkit create")} or ${chalk.cyan("hatchkit adopt")} set up

  ${chalk.bold("Usage:")}
    hatchkit destroy [<project-name>] [--yes] [--recipe]

  Reads the run ledger written by ${chalk.cyan("hatchkit create")} / ${chalk.cyan("hatchkit adopt")} and
  reverses only the resources hatchkit actually created — pre-existing
  files, repos, Coolify apps and DNS records the user had before the
  run are NEVER touched. Destructive operations (rm -rf the local repo,
  gh repo delete, terraform destroy, gitInit removal, Coolify app/project
  delete, Cloudflare record delete) prompt per-step unless ${chalk.dim("--yes")} is passed.

  ${chalk.bold("What it can undo:")}
    create-only:
    - local project directory                  ${chalk.dim("rm -rf")}
    - generated tfvars + Coolify .env files    ${chalk.dim("rm")}
    - Terraform-applied resources              ${chalk.dim("terraform destroy")}

    create + adopt:
    - GitHub repo                              ${chalk.dim("gh repo delete")}
    - dotenvx private key in keychain          ${chalk.dim("keytar deletePassword")}
    - GlitchTip / OpenPanel / Plausible / Listmonk + SES ${chalk.dim("DELETE")} per-vendor
    - Coolify app / project / database         ${chalk.dim("DELETE /api/v1/...")}

    adopt-only (fine-grained, never wider than what adopt itself wrote):
    - .hatchkit.json + .env.keys               ${chalk.dim("rm")}
    - Dockerfile / compose / GH Actions yml    ${chalk.dim("rm")} (only files adopt wrote)
    - .git directory                            ${chalk.dim("rm -rf")} (only when adopt ran git init)
    - Cloudflare DNS records                   ${chalk.dim("DELETE /zones/.../dns_records")}
                                                (only records adopt CREATED, never updated)

  ${chalk.bold("Options:")}
    --yes, -y   Skip per-step confirmation on destructive operations.
    --recipe    Print the rollback recipe (bash commands) and exit. No execution.

  ${chalk.bold("Examples:")}
    hatchkit destroy ai-playground
    hatchkit destroy ai-playground --recipe   ${chalk.dim("# just print the recipe")}
    hatchkit destroy ai-playground --yes      ${chalk.dim("# no confirmations")}
`);
    return;
  }
  if (topic === "set-description") {
    console.log(`
  ${chalk.bold("hatchkit set-description")} — update a project's description across every surface

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit set-description --to "New blurb"
    hatchkit set-description --dir <project-dir> --to "New blurb" --dry-run
    hatchkit set-description --clear

  ${chalk.bold("What it updates:")}
    ${chalk.cyan(".hatchkit.json")}      manifest.description
    ${chalk.cyan("package.json")}        description field (root)
    ${chalk.cyan("Coolify")}             project + application description (PATCH)
    ${chalk.cyan("GitHub")}              ${chalk.dim("gh repo edit <slug> --description …")}

  ${chalk.bold("Options:")}
    --to <text>     New description (prompted if omitted). Positional
                    arg works too: ${chalk.dim('hatchkit set-description "New blurb"')}.
    --clear         Write an empty description everywhere. Mutually
                    exclusive with --to.
    --dir <path>    Project dir (defaults to cwd).
    --no-coolify    Skip the two Coolify PATCHes.
    --no-github     Skip ${chalk.dim("gh repo edit")}.
    --dry-run       Show the plan; don't write.
    --yes, -y       Skip the confirmation prompt.

  ${chalk.bold("Notes:")}
    · Each provider step is best-effort — a failed Coolify or GitHub
      call logs a warning but the other surfaces still get updated.
    · Coolify is auto-skipped when not configured; GitHub is auto-skipped
      when the repo has no GitHub ${chalk.dim("origin")} remote.

  ${chalk.bold("Example:")}
    cd ~/src/my-project
    hatchkit set-description --to "Realtime collab whiteboard" --dry-run
    hatchkit set-description --to "Realtime collab whiteboard"
`);
    return;
  }
  if (topic === "rename-domain") {
    console.log(`
  ${chalk.bold("hatchkit rename-domain")} — move a project to a new domain

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit rename-domain --to <new-domain>
    hatchkit rename-domain --dir <project-dir> --to <new-domain> --dry-run

  ${chalk.bold("What it rewrites:")}
    ${chalk.cyan(".hatchkit.json")}                                (manifest domain)
    ${chalk.cyan("infra/terraform/stacks/<stack>/<name>.tfvars")}  (domain + subdomain keys)
    ${chalk.cyan("infra/stacks/<name>.env")}                       (APP_DOMAIN +
                                                     any line that mentions the
                                                     old full domain; skips
                                                     COOLIFY_URL)

  ${chalk.bold("What it does NOT touch (you run these manually):")}
    - ${chalk.dim("terraform apply")} — review the plan before destroying old records.
    - Coolify app FQDN + redeploy — UI or API. New TLS cert: 1-3 min.
    - ${chalk.dim("hatchkit dns link-to-cloudflare")} if NS flip is needed.
    - OAuth redirect URIs, Stripe webhooks, app-code references.

  ${chalk.bold("Options:")}
    --to <domain>   Target domain (prompted if omitted).
    --dir <path>    Project dir (defaults to cwd).
    --dry-run       Show the plan; don't write.
    --yes, -y       Skip the confirmation prompt.

  ${chalk.bold("Example:")}
    cd ~/src/my-project
    hatchkit rename-domain --to my-project.com --dry-run
    hatchkit rename-domain --to my-project.com
`);
    return;
  }
  if (topic === "rename-project") {
    console.log(`
  ${chalk.bold("hatchkit rename-project")} — change a scaffolded project's slug

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit rename-project --to <new-name>
    hatchkit rename-project --dir <project-dir> --to <new-name> --dry-run

  ${chalk.bold("What it rewrites (locally):")}
    ${chalk.cyan(".hatchkit.json")}                                (manifest name)
    ${chalk.cyan("package.json")}                                  (top-level name +
                                                     ${chalk.dim("<old>-{dev,prod,e2e,assets}")} refs)
    ${chalk.cyan("docker-compose.dev.yml, playwright.config.ts,")}
    ${chalk.cyan("packages/server/.env.*, packages/server/src/config/env.ts")}
                                                    (${chalk.dim("<old>-{dev,e2e,assets}")} swap)
    ${chalk.cyan("README.md")}                                     (literal occurrences)
    ${chalk.cyan("infra/terraform/stacks/<stack>/<old>.tfvars")}   (file rename +
                                                     server_name + s3_bucket_name)
    ${chalk.cyan("infra/stacks/<old>.env")}                        (file rename +
                                                     PROJECT_NAME / APP_NAME /
                                                     S3_BUCKET)
    ${chalk.cyan("<configDir>/runs/<old>.json")}                   (ledger file rename +
                                                     name + local-file step paths)
    ${chalk.cyan("<configDir>/provisioned/<old>.*.env")}            (cached provisioned env
                                                     blocks renamed)
    ${chalk.cyan("docker-compose.yml")}                             (${chalk.dim("ghcr.io/<owner>/<old>-*")}
                                                     image refs — when an origin
                                                     remote points at GitHub)

  ${chalk.bold("Opt-in remote / keychain ops (off by default):")}
    --gh            ${chalk.dim("gh repo rename")} + ${chalk.dim("git remote set-url origin")}; rewrites
                    github / ghActionsSecret / ghPages step.repo entries in
                    the ledger. Same-owner only — no cross-owner transfers.
    --coolify       PATCH /projects/{uuid} {name}. Apps stay ${chalk.dim("<old>-server")}
                    etc. (Coolify API has no rename for applications);
                    cosmetic only, deploys still work because lookups
                    are uuid-keyed.
    --keys          Re-key every per-project keychain entry (dotenvx,
                    per-project s3, openpanel, plausible, stripe-per-project)
                    from ${chalk.dim("<old>")} to ${chalk.dim("<new>")}. Set-before-delete; refuses
                    to clobber an existing target with a different value.
    --ci            Dispatch ${chalk.dim("build-and-deploy.yml")} so new GHCR images
                    publish at ${chalk.dim("ghcr.io/<owner>/<new>-*")} before redeploy.
    --all           Shorthand for --gh --coolify --keys --ci.

  ${chalk.bold("Still your job (no rename API or destructive):")}
    - Cloudflare R2 buckets ${chalk.dim("<old>-assets / <old>-state")} — R2 has no
      rename; create new, copy objects, update manifest, delete old.
    - GlitchTip / OpenPanel / Plausible project slugs + Listmonk list
      names — no rename API. Recreating drops history; leave them or
      ${chalk.dim("hatchkit add <new> <svc>")} + ${chalk.dim("hatchkit remove <old> <svc>")}.
    - Tailscale local-dev Caddy fragment (re-run dev-setup if enabled).
    - The project directory itself (${chalk.dim("mv ../<old> ../<new>")} if you want it).
    - Old GHCR images at ${chalk.dim("ghcr.io/<owner>/<old>-*")} — left in registry by
      design (easy rollback). Delete recipe printed in the checklist.

  ${chalk.bold("Options:")}
    --to <name>     New project name (prompted if omitted; slug rules).
    --dir <path>    Project dir (defaults to cwd).
    --dry-run       Show the plan; don't write, don't call APIs.
    --yes, -y       Skip the confirmation prompt.

  ${chalk.bold("Examples:")}
    hatchkit rename-project --to my-app --dry-run
    hatchkit rename-project --to my-app
    hatchkit rename-project --to my-app --all          ${chalk.dim("# full automation")}
    hatchkit rename-project --to my-app --gh --keys    ${chalk.dim("# GitHub + keychain only")}
`);
    return;
  }
  if (topic === "sync") {
    console.log(`
  ${chalk.bold("hatchkit sync")} — push the manifest's view of the project onto Coolify

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit sync [--dry-run] [--json]
    hatchkit sync --dir <project-dir>

  ${chalk.bold("What it does:")}
    Reads ${chalk.cyan(".hatchkit.json")} from the project root, finds the matching
    Coolify application(s) by name, and PATCHes the domain + ports
    payload onto each one. Idempotent — apps already in sync are
    reported and skipped.

    For ${chalk.cyan("dockercompose")} apps the domain lands in
    ${chalk.dim("docker_compose_domains")} (per-service routing); Coolify regenerates
    its auto-traefik labels on the next deploy. For nixpacks / dockerfile
    / static apps the domain lands in the flat ${chalk.dim("domains")} field instead.

  ${chalk.bold("When to use:")}
    · An older hatchkit scaffolded the project with no Domain set in
      Coolify (the container had zero ${chalk.dim("traefik.*")} labels).
    · You changed the domain in ${chalk.dim(".hatchkit.json")} and want Coolify to
      catch up without re-running adopt.
    · You want a one-shot reconcile after editing the manifest by hand.

  ${chalk.bold("Out of scope (use other commands):")}
    · DNS records  → ${chalk.cyan("hatchkit adopt")} or rename-domain follow-ups
    · Env vars     → ${chalk.cyan("hatchkit keys push")}
    · ML services  → ${chalk.cyan("hatchkit add gpu")}
    · S3 buckets   → ${chalk.cyan("hatchkit provision s3")}

  ${chalk.bold("Options:")}
    --dir <path>   Project root (defaults to cwd).
    --dry-run      Show the diff without PATCHing Coolify.
    --json         Emit ${chalk.dim("{ ok, apps, dryRun, error? }")} to stdout (suppresses
                   the human-readable rendering).

  ${chalk.bold("Verifying on the box:")}
    On the VPS hosting Coolify, after a redeploy:
      ${chalk.dim("docker inspect <container> --format '{{json .Config.Labels}}' \\\\")}
      ${chalk.dim("  | jq 'with_entries(select(.key | startswith(\"traefik\")))'")}
    A correctly-synced container has 10+ traefik labels (HTTP router,
    HTTPS router with letsencrypt, gzip middleware, redirect-to-https).
`);
    return;
  }
  if (topic === "regen-infra") {
    console.log(`
  ${chalk.bold("hatchkit regen-infra")} — rewrite tfvars + Coolify .env from the manifest

  ${chalk.bold("Usage:")}
    cd <project-dir> && hatchkit regen-infra [--dry-run]
    hatchkit regen-infra --dir <project-dir> [--dry-run]

  ${chalk.bold("What it does:")}
    Reads ${chalk.cyan(".hatchkit.json")}, re-runs the same generators ${chalk.cyan("hatchkit create")}
    uses (${chalk.dim("generateTfvars")} + ${chalk.dim("generateCoolifyEnv")}), and writes the result
    back to the existing tfvars + Coolify stack .env paths under
    ${chalk.dim("infra/")}. Infra-only fields the manifest doesn't carry (server IPs,
    Hetzner type/location) are preserved from the existing tfvars on
    disk, so a regen never silently blows away discovered values.

  ${chalk.bold("When to use:")}
    · You upgraded the CLI and want existing projects to pick up the
      new tfvars logic (e.g. dropping the ${chalk.dim("api.<sub>")} subdomain for
      client-only surfaces).
    · You edited ${chalk.cyan(".hatchkit.json")} by hand (changed surfaces, added a
      feature) and want the infra files re-rendered to match.

  ${chalk.bold("Out of scope:")}
    · Does NOT run terraform — review the diff, then
      ${chalk.dim("terraform -chdir=<stack> apply -var-file=<name>.tfvars")} yourself.
    · Does NOT touch Coolify live state — use ${chalk.cyan("hatchkit sync")} for that.

  ${chalk.bold("Options:")}
    --dir <path>   Project root (defaults to cwd).
    --dry-run      Print the unified diff without writing.
`);
    return;
  }
  if (topic === "config") {
    console.log(`
  ${chalk.bold("hatchkit config")} — manage provider credentials

  ${chalk.bold("Subcommands:")}
    config              Show status of every configured provider (alias: \`status\`)
    config add <p>      Configure a provider
                        (coolify, ghcr, hetzner, dns, s3, modal, runpod, hf, replicate,
                         glitchtip, openpanel, plausible, listmonk, ses, search-console, stripe)
    config reset        Clear ALL CLI config (providers, tokens, ML registry, ports)
`);
    return;
  }
  if (topic === "status") {
    console.log(`
  ${chalk.bold("hatchkit status")} — show provider status + next-step hint

  ${chalk.bold("Usage:")}
    hatchkit status [--json]

  ${chalk.bold("Output:")}
    Human: ✓/· per provider, next-best-step, config path.
    JSON:  full StatusSnapshot — stable shape for agents / scripts.
`);
    return;
  }
  if (topic === "explain") {
    console.log(`
  ${chalk.bold("hatchkit explain")} — one-page mental model of the CLI

  ${chalk.bold("Usage:")}
    hatchkit explain [--json]

  Dumps a plain-text (or JSON) description of concepts, commands, and
  the canonical workflow. Useful for humans with zero context and for
  agents that need to "grok" hatchkit before driving it.
`);
    return;
  }
  if (topic === "assets") {
    console.log(`
  ${chalk.bold("hatchkit assets")} — move bytes between local S3 and prod buckets

  ${chalk.bold("Subcommands:")}
    assets seed     [--from <dir>]                Local dir → local S3 bucket.
                                                  Defaults to ./seed/assets.
    assets push     [--bucket assets|state]       Local S3 → prod bucket.
    assets pull     [--bucket assets|state]       Prod bucket → local S3.
                                                  Caution: prod data may include PII.
    assets migrate  --from-endpoint=URL           External S3 → prod bucket.
                    --from-bucket=NAME            The adoption escape hatch — copy
                    --from-key=AKIA…              an existing S3-compatible bucket
                    --from-secret=…               into the project's prod bucket.
                    [--from-region=us-east-1]
                    [--from-prefix=path/]
    assets list     [dev|prod] [--bucket KIND]    Show what's in a bucket.

  ${chalk.bold("Common flags:")}
    --dir <path>     Project dir (defaults to cwd).
    --bucket KIND    "assets" (default) or "state".
    --dry-run        Plan only — list what would be copied, transfer nothing.
    --json           Machine-readable output.

  ${chalk.bold("Notes:")}
    Mirror semantics: copy missing + changed objects. Never deletes
    from the target. Streams Get→Put so cross-provider migrations
    (e.g. AWS S3 → R2) work without server-side copy.

    Reads dev creds from ${chalk.cyan("packages/server/.env.development")} (plaintext)
    and prod creds from ${chalk.cyan("packages/server/.env.production")} (decrypted via
    dotenvx + .env.keys). Bucket names come from .hatchkit.json when
    the env doesn't carry them (R2's URL-driven assets bucket).

  ${chalk.bold("Examples:")}
    hatchkit assets seed                                # ./seed/assets/ → local S3
    hatchkit assets push --dry-run                      # see what would ship to prod
    hatchkit assets push                                # actually ship it
    hatchkit assets migrate --from-endpoint https://nyc3.digitaloceanspaces.com \\
      --from-bucket old-app-uploads \\
      --from-key DOXXXXXXXXX --from-secret <secret>     # one-off adoption migration
    hatchkit assets list prod                           # sanity-check
`);
    return;
  }
  if (topic === "completion") {
    console.log(`
  ${chalk.bold("hatchkit completion")} — print a shell-completion script

  ${chalk.bold("Usage:")}
    hatchkit completion <zsh|bash|fish>

  Pipe into your shell config, e.g.:
    hatchkit completion zsh  > ~/.zsh/completions/_hatchkit
    hatchkit completion bash > /usr/local/etc/bash_completion.d/hatchkit
    hatchkit completion fish > ~/.config/fish/completions/hatchkit.fish
`);
    return;
  }
  console.log(`
  ${chalk.bold("Usage:")} hatchkit <command> [options]

  ${chalk.bold("Getting started:")}
    setup           One-time onboarding — wires up all credentials (alias: init)
    status          Show what's configured and what's next
    doctor          Health-check every provider with contextual fix hints
    inventory       Survey what already exists for this project (and flag drift)
    overview        Fleet-level survey — every resource across all configured providers
    explain         One-page mental model of the CLI

  ${chalk.bold("Projects:")}
    create          Scaffold a new project (interactive)
    adopt           Bring an existing project under hatchkit management (run in project dir)
    update          Add features to an already-scaffolded project (run in project dir)
    server add      Retrofit a server into a client-only project
    add             Create GlitchTip / OpenPanel / Plausible / Listmonk + SES / email / search clients for an existing project
    assets          Move bytes between local S3 and prod buckets (seed/push/pull/migrate)
    remove          Delete the -dev/-prod clients created by 'add' (inverse of add)
    destroy         Roll back everything ${chalk.cyan("hatchkit create")} did for a project
    rename-domain   Move a scaffolded project to a new domain (rewrites tfvars/env/manifest)
    rename-project  Change a scaffolded project's slug (rewrites manifest/pkg.json/tfvars/env/ledger)
    set-description Update a project's description across manifest, package.json, Coolify, GitHub
    sync            Push the manifest's domain/ports onto the matching Coolify app(s)
    gh-pages        Wire GitHub Pages for the current repo (static / Vite / Jekyll — with DNS)
    dns             DNS reconciliation helpers (link-to-cloudflare, …)
    email           Set up Cloudflare Email Routing + MX/SPF/DMARC (setup/status)
    keys show <p>   Print the dotenvx private key for a project
    keys set <p>    Upsert the key into the OS keychain (after \`dotenvx rotate\`)
    keys rotate <p> Rotate the dotenvx keypair, mirror to keychain + (default) deploy targets
    keys push <p>   Push the key to Coolify (default) and/or GitHub Actions
    secrets rotate <p>  Rotate per-project provider credentials (OpenPanel, GlitchTip, ...)

  ${chalk.bold("Config:")}
    config          Show provider status (same as \`status\`)
    config add <p>  Configure a provider (coolify, hetzner, dns, s3, modal, …)
    config reset    Clear ALL CLI config (providers, tokens, ML registry, ports)

  ${chalk.bold("For agents / scripts:")}
    status --json     StatusSnapshot as JSON
    doctor --json     Per-provider health with fix hints as JSON
    inventory --json  InventoryReport — resources found per provider + drift
    overview --json   OverviewReport — fleet-level resource counts + names
    completion <shell>  Print a zsh/bash/fish completion script

  ${chalk.bold("Options:")}
    --version, -v   Print the CLI version
    --help, -h      Show this help message (pass to a subcommand for detail)
    --json          Machine-readable output (status, doctor, explain)
    --dry-run       (with \`create\`) show what would change without writing
    --yes, -y       (with \`create\`) skip prompts, use defaults / --config values
    --config <path> (with \`create\`) load JSON overrides for ProjectConfig fields
    --name <name>   (with \`create\`) set project name without prompting
    --local-dev[=<slug>] (with \`create\`) enable Tailscale dev URL, optionally with slug
    --no-local-dev  (with \`create\`) skip local-dev wiring
    --no-github     (with \`create\`) skip GitHub repo creation
    --github-visibility {private|public}
                    (with \`create\`) visibility for a newly-created GitHub repo.
                    Default: private. Shorthands: \`--private\`, \`--public\`.
    --no-deploy     (with \`create\`) skip Terraform/Coolify/ML deployment

  ${chalk.bold("Environment:")}
    HATCHKIT_CONF_DIR   Override the config/ports-registry location

  ${chalk.dim("Run `hatchkit help <command>` for per-command detail.")}
`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((error) => {
  console.error(chalk.red(`\n  Error: ${error.message}\n`));
  process.exit(1);
});
