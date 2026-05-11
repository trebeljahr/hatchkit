#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import {
  ensureCoolify,
  ensureGitHub,
  ensureHetzner,
  ensureS3,
  getConfig,
  getConfigPath,
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
import { runTerraform } from "./deploy/terraform.js";
import { type GpuPlatform, collectProjectConfig } from "./prompts.js";
import { type ProvisionService, runProvision, runUnprovision } from "./provision/index.js";
import { scaffoldApp } from "./scaffold/app.js";
import { scaffoldInfra } from "./scaffold/infra.js";
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
    case "keys":
      if (args.includes("--help") && args.length === 2) return printHelp("keys");
      await handleKeys();
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
      const result = await rotateProjectKey(projectName, {
        pushCoolify,
        pushGh,
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
        console.log(chalk.green(`  Updated keychain entry ${chalk.cyan(result.set.account)}`));
      }
      if (result.pushedCoolify) {
        console.log(chalk.green(`  Pushed to Coolify (${result.pushedCoolify.uuid})`));
      }
      if (result.pushedGh) {
        console.log(chalk.green(`  Pushed to GitHub repo ${result.pushedGh.repo}`));
      }
      if (!opts(result).pushedAnywhere) {
        console.log(
          chalk.dim(
            "  Tip: pass --push-coolify and/or --push-gh <owner/repo> to fan out the new key.",
          ),
        );
      }
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

/** Resolve the GitHub `owner/repo` slug from the cwd's git origin.
 *  Returns undefined when no remote is set or it's not a GitHub URL. */
async function detectRepoSlug(): Promise<string | undefined> {
  const { repoSlugFromRemote } = await import("./deploy/gh-actions-secrets.js");
  const res = await exec("git", ["remote", "get-url", "origin"], { silent: true });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
}

/** Helper for the rotate-summary tip — collapses "did we push anywhere"
 *  to a single boolean so the inline check stays readable. */
function opts(result: {
  pushedCoolify?: unknown;
  pushedGh?: unknown;
}): { pushedAnywhere: boolean } {
  return { pushedAnywhere: !!result.pushedCoolify || !!result.pushedGh };
}

/** Walk up from `serverEnvDir` looking for the closest `.hatchkit.json`,
 *  capped at 4 levels so we never escape a project tree. Used by the
 *  non-interactive `hatchkit add` path to find the manifest without
 *  forcing the user to pass `--project-dir` explicitly when the env
 *  dir already lives inside the project (`packages/server`,
 *  `apps/web`, etc.). Returns undefined when no manifest is found —
 *  callers fall back to "skip s3" with a hint. */
function inferProjectDir(serverEnvDir: string | undefined): string | undefined {
  if (!serverEnvDir) return undefined;
  let cur = serverEnvDir;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(cur, ".hatchkit.json"))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return undefined;
}

async function handleAdd(): Promise<void> {
  // Positional args are optional — anything missing is prompted for.
  //   hatchkit add                             (fully interactive)
  //   hatchkit add raptor-runner               (prompts for services)
  //   hatchkit add raptor-runner all
  //   hatchkit add raptor-runner glitchtip,resend
  const positional = args.slice(1).filter((a) => !a.startsWith("--"));
  let baseName = positional[0];
  const rawService = positional[1];

  const allServices: ProvisionService[] = ["glitchtip", "openpanel", "resend", "s3"];

  if (!baseName) {
    const { input } = await import("@inquirer/prompts");
    const { validateProjectName } = await import("./utils/validate.js");
    baseName = await input({
      message: "Project name (e.g. raptor-runner):",
      validate: validateProjectName,
    });
  }

  let services: ProvisionService[];
  if (!rawService) {
    const { multiselect } = await import("./utils/multiselect.js");
    services = await multiselect<ProvisionService>({
      message: "Which services to add?",
      choices: [
        { name: "GlitchTip (error tracking)", value: "glitchtip", checked: true },
        { name: "OpenPanel (product analytics)", value: "openpanel", checked: true },
        { name: "Resend (transactional email)", value: "resend", checked: true },
        {
          name: "S3 / R2 (per-bucket scoped credentials from .hatchkit.json)",
          value: "s3",
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

  // Flag parsing:
  //   --no-write                      → never write; print a cache summary only
  //   --enable-dev-obs                → also populate .env.development with GlitchTip/OpenPanel creds
  //   --surfaces=<shared|separate|server-only|client-only>
  //   --server-dir <path>             → absolute or project-relative env dir for the server
  //   --client-dir <path>             → same for the client
  //   (no surface flags)              → prompt interactively
  const noWrite = args.includes("--no-write");
  const enableDevObs = args.includes("--enable-dev-obs");
  const surfaceFlag = args.find((a) => a.startsWith("--surfaces="))?.slice("--surfaces=".length);
  const serverDirIdx = args.indexOf("--server-dir");
  const clientDirIdx = args.indexOf("--client-dir");
  const projectDirIdx = args.indexOf("--project-dir");
  const serverDirFlag = serverDirIdx >= 0 ? args[serverDirIdx + 1] : undefined;
  const clientDirFlag = clientDirIdx >= 0 ? args[clientDirIdx + 1] : undefined;
  const projectDirFlag = projectDirIdx >= 0 ? args[projectDirIdx + 1] : undefined;

  const { resolve: resolvePath } = await import("node:path");
  const validSurfaceModes = ["shared", "separate", "server-only", "client-only"] as const;
  let surfaces: Parameters<typeof runProvision>[0]["surfaces"] = undefined;
  if (noWrite) {
    surfaces = false;
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
    const needsServer = mode === "shared" || mode === "separate" || mode === "server-only";
    const needsClient = mode === "shared" || mode === "separate" || mode === "client-only";
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
      serverEnvDir: needsServer ? resolvePath(serverDirFlag as string) : undefined,
      clientEnvDir: needsClient ? resolvePath(clientDirFlag as string) : undefined,
      // --project-dir is optional in the flag path. When provided, it
      // points at the directory holding `.hatchkit.json` (needed for
      // the `s3` service to read s3Buckets). When absent and the
      // serverEnvDir is a `packages/server` style subdir, we infer it
      // by walking up two segments.
      projectDir: projectDirFlag
        ? resolvePath(projectDirFlag)
        : inferProjectDir(needsServer ? resolvePath(serverDirFlag as string) : undefined),
    };
  }

  await runProvision({ baseName, services, surfaces, enableDevObs });
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
  //   hatchkit remove raptor-runner glitchtip,resend
  //   hatchkit remove raptor-runner all --yes     (skip confirmation)
  const positional = args.slice(1).filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  let baseName = positional[0];
  const rawService = positional[1];

  const allServices: ProvisionService[] = ["glitchtip", "openpanel", "resend", "s3"];

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
        { name: "Resend (deletes the API key)", value: "resend", checked: true },
        { name: "S3 / R2 (deletes per-bucket scoped tokens)", value: "s3", checked: false },
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
  if (services.includes("s3")) {
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
  } = flags;

  // Check if first run (skip onboarding when non-interactive — the
  // onboarding prompts would stall automation).
  if (!nonInteractive && (await isFirstRun())) {
    await runOnboarding();
  }

  // Collect project config via interactive prompts (or presets).
  const config = await collectProjectConfig({ dryRun, presets, nonInteractive });
  if (forceNoGithub) config.createGithubRepo = false;
  if (forceNoDeploy) config.runDeployment = false;
  if (forceNoInstall) config.installDeps = false;

  // Ensure needed providers are configured (lazy prompting).
  // Coolify + Hetzner only matter for the coolify deployment mode.
  // gh-pages skips them entirely (no server, no Docker registry).
  if (
    config.deploymentMode === "coolify" &&
    (config.deployTarget === "existing" || config.runDeployment)
  ) {
    await ensureCoolify();
  }
  // GitHub is checked here so auth failures surface before scaffold
  // (not deep inside `setupGitHub` after files are on disk). Pages
  // also needs GitHub auth for the API calls that enable Pages and
  // set the cname — so we require it whenever gh-pages is involved.
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
  // Pre-flight observability + email + Stripe providers used by `hatchkit
  // create` directly (not just `add`): if the user picked the analytics
  // feature, GlitchTip needs to be configured before we can mint a DSN
  // for them. Same for Stripe webhook auto-provisioning.
  if (config.features.includes("analytics")) {
    const { ensureGlitchtip } = await import("./config.js");
    await ensureGlitchtip();
  }
  if (config.features.includes("stripe")) {
    const { ensureStripe } = await import("./config.js");
    await ensureStripe();
  }

  const appDir = resolve(config.name);

  // Resolve ML services (reuse or deploy)
  const { reuse, deploy } = await resolveMlServices(config);
  if (config.mlServices.length > 0) {
    printMlSummary(reuse, deploy);
  }

  // Summary before execution
  console.log(chalk.bold("\n  ── Summary ───────────────────────────────────────────────\n"));
  console.log(`  Project:    ${chalk.cyan(config.name)}`);
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
    `  ML:         ${config.mlServices.length > 0 ? config.mlServices.join(", ") : "none"}`,
  );
  console.log(`  Scaffold:   ${config.scaffoldRepo ? "yes" : "no"}`);
  console.log(`  GitHub:     ${config.createGithubRepo ? "yes" : "no"}`);
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

      // Auto-provision GlitchTip + write its DSN encrypted into
      // .env.production. The user picked the `analytics` feature; we
      // already verified GlitchTip is configured during pre-flight.
      // Skipped for client-only — the encrypt target lives in
      // packages/server/, which doesn't exist post-prune. The client
      // side of analytics (OpenPanel via NEXT_PUBLIC_*) still works
      // without any provisioning.
      if (config.features.includes("analytics") && config.surfaces !== "client-only") {
        try {
          const { provisionGlitchtipClient } = await import("./provision/glitchtip.js");
          const { set: dotenvxSet } = await import("@dotenvx/dotenvx");
          const ora = (await import("ora")).default;
          const spinner = ora(`GlitchTip: creating project ${config.name}`).start();
          const res = await provisionGlitchtipClient(config.name);
          ledger?.record({ kind: "glitchtip", project: config.name });
          spinner.succeed(`GlitchTip project ready (DSN encrypted into .env.production)`);
          const prodEnvPath = join(appDir, "packages/server/.env.production");
          dotenvxSet("GLITCHTIP_DSN", res.dsn, { path: prodEnvPath, encrypt: true });
        } catch (err) {
          console.log(
            chalk.yellow(`  Couldn't auto-provision GlitchTip: ${(err as Error).message}`),
          );
          console.log(
            chalk.dim(
              `  Run \`hatchkit add ${config.name} glitchtip\` once GlitchTip is reachable.`,
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
      // reach them later. Skipped for client-only (server-only feature).
      if (config.features.includes("stripe") && config.surfaces !== "client-only") {
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

          if (!result.test && !result.live) {
            console.log(
              chalk.yellow(
                "  Stripe: no master key configured for either mode — wiring skipped.\n" +
                  "  Run `hatchkit config add stripe` to add a test and/or live master key,\n" +
                  "  then re-run from the project dir.",
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

      // Provision a per-project MongoDB container on Coolify when the
      // user picked that path. Best-effort: a failure here doesn't undo
      // the app deploy — we surface clear instructions instead.
      if (config.mongodbProvider === "coolify" && config.scaffoldRepo) {
        try {
          const { provisionCoolifyMongo } = await import("./deploy/coolify-mongo.js");
          const serverEnvDir = join(appDir, "packages/server");
          const mongoResult = await provisionCoolifyMongo(config, serverEnvDir);
          ledger?.record({ kind: "coolifyDb", uuid: mongoResult.databaseUuid });
        } catch (err) {
          console.log(chalk.yellow(`  Couldn't auto-provision MongoDB: ${(err as Error).message}`));
          console.log(
            chalk.dim(
              `  Create one manually in Coolify: New → Database → MongoDB,\n` +
                `  then set MONGODB_URI on the app's env (or run\n` +
                `  \`dotenvx set MONGODB_URI <url> -f packages/server/.env.production\`).`,
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
          const { repoSlugFromRemote, setCoolifyDeploySecrets } = await import(
            "./deploy/gh-actions-secrets.js"
          );
          const slug = repoSlugFromRemote(repoUrl);
          const apps = await findCoolifyAppsForProject(config.name);
          if (slug && apps.length > 0) {
            await setCoolifyDeploySecrets({
              projectDir: appDir,
              repoSlug: slug,
              apps,
            });
          } else if (apps.length === 0) {
            console.log(
              chalk.dim(
                `  · No Coolify app named "${config.name}" / "${config.name}-server" / "${config.name}-client" / "${config.name}-web" found — skipping Actions secret push.`,
              ),
            );
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
        console.log(
          chalk.yellow(`  Couldn't auto-wire GitHub Pages: ${(err as Error).message}`),
        );
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
      await pushInitialBranch(appDir);
    }

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
  // Skip the API line for client-only — there's no backend, so showing
  // a "/api" URL just confuses the user (and falsely implies a service
  // is listening at that path).
  if (config.surfaces !== "client-only") {
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
    console.log(chalk.dim("    pnpm icons:desktop     # cross-platform (electron-icon-builder)"));
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
}

async function handleConfig(): Promise<void> {
  const subcommand = args[1];

  switch (subcommand) {
    case "add": {
      const provider = args[2];
      if (!provider) {
        console.log("Usage: hatchkit config add <provider>");
        console.log(
          "Providers: coolify, ghcr, hetzner, dns, s3, modal, runpod, hf, replicate, glitchtip, openpanel, resend, stripe",
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
        case "hetzner":
        case "dns":
        case "glitchtip":
        case "openpanel":
        case "resend":
        case "stripe":
        case "ghcr":
          await reconfigureProvider(provider);
          break;
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
                "  Valid: coolify, ghcr, hetzner, dns, s3, modal, runpod, hf, replicate, glitchtip, openpanel, resend, stripe",
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
  | "keys"
  | "add"
  | "adopt"
  | "assets"
  | "remove"
  | "destroy"
  | "rename-domain"
  | "sync"
  | "regen-infra"
  | "doctor"
  | "inventory"
  | "overview"
  | "status"
  | "explain"
  | "completion"
  | "gh-pages"
  | "dns";

function printHelp(topic?: HelpTopic): void {
  if (topic === "create") {
    console.log(`
  ${chalk.bold("hatchkit create")} — scaffold a new project

  ${chalk.bold("Usage:")}
    hatchkit create [--dry-run]

  ${chalk.bold("What it does (interactively):")}
    1. Prompts for project name, domain, surfaces, deployment mode, features, ML
    2. Copies the starter template and strips unselected features
    3. Assigns unique ports per project (server, client, native HMR)
    4. Runs \`pnpm install\` (if pnpm is present and you opt in)
    5. Initializes git, optionally creates a GitHub repo
    6. Generates Terraform tfvars + Coolify .env (Coolify mode)
    7. Deploys: Terraform → Coolify → ML  ${chalk.dim("OR")}  GitHub Pages setup

  ${chalk.bold("Deployment modes:")}
    ${chalk.cyan("coolify")}        Full-stack on Hetzner — DB, providers, Docker. Default.
    ${chalk.cyan("gh-pages")}       Static-only on GitHub Pages. Only offered when surfaces
                   is ${chalk.dim("client-only")}; the scaffold's Next config is patched to
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
    - GlitchTip, OpenPanel, Resend (optional)

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
    keys rotate <project>   Run \`dotenvx rotate -f .env.production\` in
                            the project, then ${chalk.cyan("keys set")}, then
                            optionally fan out to Coolify and/or GitHub.
    keys push <project>     Mirror the keychain copy to a deploy target.

  ${chalk.bold("Flags (apply to set / rotate / push):")}
    --key=<value>           Direct value for ${chalk.cyan("keys set")}.
    --stdin                 (set) Read the key from stdin (e.g. \`cat key | hatchkit keys set …\`).
    --target={coolify|gh|both}  Where ${chalk.cyan("keys push")} mirrors to. Default
                            ${chalk.dim("coolify")} for back-compat.
    --repo <owner/repo>     GH repo for ${chalk.cyan("keys push --target=gh|both")}.
                            Inferred from ${chalk.dim("git remote origin")} when omitted.
    --push-coolify          (rotate) Mirror the new key onto Coolify.
    --push-gh <owner/repo>  (rotate) Mirror the new key into the named
                            GH repo's DOTENV_PRIVATE_KEY_PRODUCTION
                            Actions secret.
    --dry-run               Print what would change, don't write.
    --json                  Machine-readable output.

  ${chalk.bold("Examples:")}
    hatchkit keys rotate raptor-runner --push-coolify --push-gh acme/raptor
    cat .env.keys | hatchkit keys set raptor-runner --stdin
    hatchkit keys push raptor-runner --target=both --repo acme/raptor

  The key is generated at scaffold time and lives in macOS Keychain /
  libsecret under the "hatchkit" service. Never written to git.
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
    Run ${chalk.cyan("hatchkit config add dns")} and choose Cloudflare, then answer
    ${chalk.cyan("yes")} to "Is INWX your domain registrar?" when prompted.
`);
    return;
  }
  if (topic === "doctor") {
    console.log(`
  ${chalk.bold("hatchkit doctor")} — verify every configured provider

  Runs a read-only API call against each provider whose credentials are
  stored (Coolify /version, Hetzner /servers, Cloudflare /tokens/verify,
  Resend /domains, …). Reports ok / fail / not-configured per provider
  and exits non-zero if any check fails. Safe to run repeatedly.
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
    · Resend               verified domains
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
      · GlitchTip / OpenPanel project with no Coolify app counterpart
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
    · Resend     — verified-domain match
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

  ${chalk.bold("What it does:")}
    · GlitchTip / OpenPanel: ${chalk.bold("one project per product")}, events tagged by
      \`environment\` so dev / staging / prod share the same dashboard.
      Written to ${chalk.cyan(".env.production")} only — dev noise pollutes real metrics.
      Pass ${chalk.cyan("--enable-dev-obs")} to populate ${chalk.cyan(".env.development")} too.
    · Resend: separate ${chalk.cyan("-dev")} and ${chalk.cyan("-prod")} API keys (audience
      safety). Written to the server's dev + prod env respectively.
    · ${chalk.cyan(".env.production")} is dotenvx-encrypted — commit-safe.
      ${chalk.cyan(".env.development")} is plaintext — gitignored, not encrypted.
    · A 0600 cache of every value is saved under
      ${chalk.dim("<config-dir>/provisioned/<project>.*.env")} for recoverability.
      ${chalk.dim("Secret values never hit stdout.")}

  ${chalk.bold("Surfaces:")}
    hatchkit asks which surfaces your project has. Options:
      · ${chalk.cyan("shared")}       — server + client, one obs project (recommended)
      · ${chalk.cyan("server-only")}  — no browser bundle (API, CLI, worker)
      · ${chalk.cyan("client-only")}  — static site / SPA with no backend
      · ${chalk.cyan("separate")}     — server + client, one obs project per surface

    Env for each surface is written to its own directory (e.g.
    ${chalk.dim("packages/server/.env.production")}, ${chalk.dim("packages/client/.env.production")}).

  ${chalk.bold("Services:")}
    glitchtip   GLITCHTIP_DSN (server) / PUBLIC_GLITCHTIP_DSN (client)
    openpanel   OPENPANEL_* (server) / PUBLIC_OPENPANEL_* (client)
    resend      RESEND_API_KEY (server only)
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
    --project-dir <path>        Project root holding .hatchkit.json (s3 only;
                                inferred from --server-dir if omitted).

  ${chalk.bold("Examples:")}
    hatchkit add
    hatchkit add raptor-runner
    hatchkit add raptor-runner all --enable-dev-obs
    hatchkit add raptor-runner glitchtip,resend --no-write
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
        commit, \`gh repo create --private --source=. --push\`. Skipped
        when an \`origin\` is already set.
      · ${chalk.cyan("Coolify + DNS")} — direct REST-API calls into the
        Coolify and Cloudflare you already configured (no Terraform,
        no submodule). Finds or creates the Coolify project, picks
        the server (single-server setups auto-resolve), creates the
        application from the GitHub repo (private repos use a
        Coolify GitHub App source), pushes the baseline env
        (DOTENV_PRIVATE_KEY_PRODUCTION + GITHUB_REPO_URL), upserts an
        A record \`<domain> → <server-ip>\` on Cloudflare, and triggers
        the first deploy. Defaults ON when no matching app exists.
      · Optionally provisions GlitchTip / OpenPanel / Resend clients
        (same machinery as \`hatchkit add\`).
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
    resend      Finds API keys by name and deletes them
    s3          Deletes per-bucket scoped Cloudflare R2 API tokens
                (clears the keychain entries and DELETEs upstream)

  ${chalk.bold("Options:")}
    --dry-run   Print what would be deleted; hit no APIs, remove no files.
    --yes, -y   Skip the interactive confirmation prompt.

  ${chalk.bold("Examples:")}
    hatchkit remove raptor-runner all
    hatchkit remove raptor-runner glitchtip,resend --dry-run
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
    - GlitchTip / OpenPanel / Resend           ${chalk.dim("DELETE")} per-vendor
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
                         glitchtip, openpanel, resend, stripe)
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
  ${chalk.bold("hatchkit assets")} — move bytes between local MinIO and prod buckets

  ${chalk.bold("Subcommands:")}
    assets seed     [--from <dir>]                Local dir → local MinIO bucket.
                                                  Defaults to ./seed/assets.
    assets push     [--bucket assets|state]       Local MinIO → prod bucket.
    assets pull     [--bucket assets|state]       Prod bucket → local MinIO.
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
    hatchkit assets seed                                # ./seed/assets/ → local MinIO
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
    add             Create GlitchTip / OpenPanel / Resend clients for an existing project
    assets          Move bytes between local MinIO and prod buckets (seed/push/pull/migrate)
    remove          Delete the -dev/-prod clients created by 'add' (inverse of add)
    destroy         Roll back everything ${chalk.cyan("hatchkit create")} did for a project
    rename-domain   Move a scaffolded project to a new domain (rewrites tfvars/env/manifest)
    sync            Push the manifest's domain/ports onto the matching Coolify app(s)
    gh-pages        Wire GitHub Pages for the current repo (static / Vite / Jekyll — with DNS)
    dns             DNS reconciliation helpers (link-to-cloudflare, …)
    keys show <p>   Print the dotenvx private key for a project
    keys set <p>    Upsert the key into the OS keychain (after \`dotenvx rotate\`)
    keys rotate <p> Rotate the dotenvx keypair, mirror to keychain + (optional) deploy targets
    keys push <p>   Push the key to Coolify (default) and/or GitHub Actions

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
    --no-github     (with \`create\`) skip GitHub repo creation
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
