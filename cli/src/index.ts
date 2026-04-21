#!/usr/bin/env node

import { join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import {
  ensureCoolify,
  ensureDns,
  ensureGitHub,
  ensureGpuProvider,
  ensureHetzner,
  ensureS3,
  getConfig,
  getConfigPath,
  getMlServices,
  isFirstRun,
  resetConfig,
  runOnboarding,
} from "./config.js";
import { runCoolifySetup } from "./deploy/coolify.js";
import { setupGitHub } from "./deploy/github.js";
import { deployMlServices } from "./deploy/gpu.js";
import { runTerraform } from "./deploy/terraform.js";
import { collectProjectConfig } from "./prompts.js";
import { scaffoldApp } from "./scaffold/app.js";
import { scaffoldInfra } from "./scaffold/infra.js";
import { mlEnvVarName, printMlSummary, resolveMlServices } from "./scaffold/ml-client.js";
import { runUpdate } from "./scaffold/update.js";
import { exec, execOk } from "./utils/exec.js";
import { parseCreateFlags } from "./utils/flags.js";
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

  console.log(chalk.bold(`\n  devops-cli v${getCliVersion()}\n`));

  // Global --help without a subcommand prints the top-level help.
  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "init":
      if (args.includes("--help")) return printHelp("init");
      await runOnboarding();
      break;
    case "config":
      if (args.includes("--help") && args.length === 2) return printHelp("config");
      await handleConfig();
      break;
    case "create":
    case undefined:
      if (args.includes("--help")) return printHelp("create");
      await handleCreate();
      break;
    case "update":
      if (args.includes("--help")) return printHelp("update");
      await handleUpdate();
      break;
    default:
      printHelp();
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
  const { yes: nonInteractive, dryRun, presets, forceNoGithub, forceNoDeploy } = flags;

  // Check if first run (skip onboarding when non-interactive — the
  // onboarding prompts would stall automation).
  if (!nonInteractive && (await isFirstRun())) {
    await runOnboarding();
  }

  // Collect project config via interactive prompts (or presets).
  const config = await collectProjectConfig({ dryRun, presets, nonInteractive });
  if (forceNoGithub) config.createGithubRepo = false;
  if (forceNoDeploy) config.runDeployment = false;

  // Ensure needed providers are configured (lazy prompting).
  // Coolify is only needed when deploying OR when picking from
  // existing servers. This lets scaffold-only + --no-deploy runs
  // skip the Coolify setup prompt entirely.
  if (config.deployTarget === "existing" || config.runDeployment) {
    await ensureCoolify();
  }
  // GitHub is checked here so auth failures surface before scaffold
  // (not deep inside `setupGitHub` after files are on disk).
  if (config.createGithubRepo) {
    await ensureGitHub();
  }
  if (config.deployTarget === "new") {
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
  console.log(
    `  Deploy to:  ${config.deployTarget === "existing" ? `existing server (${config.serverIp})` : `new Hetzner ${config.serverSize}`}`,
  );
  console.log(`  Features:   ${config.features.length > 0 ? config.features.join(", ") : "none"}`);
  console.log(
    `  ML:         ${config.mlServices.length > 0 ? config.mlServices.join(", ") : "none"}`,
  );
  console.log(`  Scaffold:   ${config.scaffoldRepo ? "yes" : "no"}`);
  console.log(`  GitHub:     ${config.createGithubRepo ? "yes" : "no"}`);
  console.log(`  Deploy now: ${config.runDeployment ? "yes" : "no"}`);

  if (config.dryRun) {
    console.log(chalk.yellow("\n  [dry-run mode — no changes will be made]\n"));
  }

  // Step 1: Scaffold app repo
  let scaffoldResult: { ports: { server: number; client: number; nativeHmr?: number } } | undefined;
  if (config.scaffoldRepo) {
    scaffoldResult = await scaffoldApp(config, appDir);
    const { ports } = scaffoldResult;
    console.log(
      chalk.dim(
        `  Ports: server=${ports.server}, client=${ports.client}` +
          (ports.nativeHmr ? `, native HMR=${ports.nativeHmr}` : ""),
      ),
    );
  }

  if (config.dryRun) {
    scaffoldInfra(config, INFRA_ROOT, {
      serverPort: scaffoldResult?.ports.server,
      clientPort: scaffoldResult?.ports.client,
    });
    console.log(chalk.green("\n  ✓ Dry run complete. No changes were made.\n"));
    return;
  }

  // Step 2: Install deps. Required for the initial commit to pick up
  // the lockfile delta and for the user to `pnpm dev` immediately.
  let installedDeps = false;
  if (config.scaffoldRepo) {
    const hasPnpm = await execOk("pnpm", ["--version"]);
    if (!hasPnpm) {
      console.log(
        chalk.yellow(
          "  pnpm not found on PATH — skipping install step. Install deps with your preferred tool once available.",
        ),
      );
    } else {
      const shouldInstall = await confirm({
        message: "Install dependencies now (pnpm install)?",
        default: true,
      });
      if (shouldInstall) {
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
  }

  // Step 3: Git + GitHub — must run BEFORE scaffoldInfra so the repo
  // URL can be threaded into the Coolify env (GITHUB_REPO_URL).
  let repoUrl: string | null = null;
  if (config.scaffoldRepo) {
    repoUrl = await setupGitHub(config, appDir);
  }

  // Step 4: Generate infra configs (with repo URL + ports baked in).
  scaffoldInfra(config, INFRA_ROOT, {
    repoUrl: repoUrl ?? undefined,
    serverPort: scaffoldResult?.ports.server,
    clientPort: scaffoldResult?.ports.client,
  });

  // Step 5: Terraform (DNS + optionally server)
  if (config.runDeployment) {
    await runTerraform(config, INFRA_ROOT);
  }

  // Step 6: Coolify setup
  if (config.runDeployment) {
    await runCoolifySetup(config, INFRA_ROOT);
  }

  // Step 7: Deploy ML services
  if (config.runDeployment && deploy.length > 0 && config.gpuPlatform) {
    const endpoints = await deployMlServices(
      deploy,
      config.gpuPlatform,
      SERVICES_ROOT,
      config.customHfModelId,
    );

    // Print env vars to set
    if (Object.keys(endpoints).length > 0) {
      console.log(chalk.bold("\n  ML service endpoints (add to Coolify env):"));
      for (const [service, endpoint] of Object.entries(endpoints)) {
        // Service keys come from our own `deploy: MlService[]` so the
        // cast is sound, but narrow via the literal-array check so a
        // stray unknown slips don't silently format wrong.
        const knownServices = [
          "3d-extraction",
          "subtitles",
          "image-recognition",
          "background-removal",
          "custom-hf",
        ] as const;
        type KnownService = (typeof knownServices)[number];
        if ((knownServices as readonly string[]).includes(service)) {
          console.log(chalk.dim(`    ${mlEnvVarName(service as KnownService)}=${endpoint}`));
        }
      }
    }
  }

  // Final summary
  console.log(chalk.bold("\n  ── Done! ─────────────────────────────────────────────────\n"));
  console.log(`  App:       ${chalk.cyan(`https://${config.domain}`)}`);
  console.log(`  API:       ${chalk.cyan(`https://api.${config.domain}`)}`);
  console.log(`  App dir:   ${chalk.dim(appDir)}`);
  console.log(`  Config:    ${chalk.dim(getConfigPath())}`);

  if (config.scaffoldRepo) {
    if (installedDeps) {
      console.log(chalk.yellow(`\n  Next: cd ${config.name} && pnpm dev`));
    } else {
      console.log(chalk.yellow(`\n  Next: cd ${config.name} && pnpm install && pnpm dev`));
    }
  }

  if (config.features.includes("stripe")) {
    console.log(
      chalk.yellow(
        "\n  Next: Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET in Coolify",
      ),
    );
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
        console.log("Usage: devops-cli config add <provider>");
        console.log("Providers: coolify, hetzner, dns, s3, modal, runpod, hf, replicate");
        return;
      }
      // Handle provider setup based on name
      const gpuPlatforms = ["modal", "runpod", "hf", "replicate"] as const;
      type GpuPlatformName = (typeof gpuPlatforms)[number];
      const isGpuPlatform = (p: string): p is GpuPlatformName =>
        (gpuPlatforms as readonly string[]).includes(p);

      switch (provider) {
        case "coolify":
          await ensureCoolify();
          break;
        case "hetzner":
          await ensureHetzner();
          break;
        case "dns":
          await ensureDns();
          break;
        case "s3": {
          const { select } = await import("@inquirer/prompts");
          const p = await select({
            message: "S3 provider:",
            choices: [
              { name: "Hetzner", value: "hetzner" as const },
              { name: "AWS", value: "aws" as const },
              { name: "R2", value: "r2" as const },
            ],
          });
          await ensureS3(p);
          break;
        }
        default:
          if (!isGpuPlatform(provider)) {
            console.log(chalk.red(`  Unknown provider: ${provider}`));
            console.log(
              chalk.dim("  Valid: coolify, hetzner, dns, s3, modal, runpod, hf, replicate"),
            );
            return;
          }
          await ensureGpuProvider(provider);
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

function printHelp(topic?: "create" | "init" | "config" | "update"): void {
  if (topic === "create") {
    console.log(`
  ${chalk.bold("devops-cli create")} — scaffold a new project

  ${chalk.bold("Usage:")}
    devops-cli create [--dry-run]

  ${chalk.bold("What it does (interactively):")}
    1. Prompts for project name, domain, deploy target, features, ML services
    2. Copies the starter template and strips unselected features
    3. Assigns unique ports per project (server, client, native HMR)
    4. Runs \`pnpm install\` (if pnpm is present and you opt in)
    5. Initializes git, optionally creates a GitHub repo
    6. Generates Terraform tfvars + Coolify .env
    7. Optionally deploys: Terraform → Coolify → ML services

  ${chalk.bold("Options:")}
    --dry-run       Show the plan without writing anything
    --help          Show this help
`);
    return;
  }
  if (topic === "init") {
    console.log(`
  ${chalk.bold("devops-cli init")} — one-time onboarding

  Prompts for: GitHub (via gh CLI), Coolify (URL + token), optionally
  Hetzner Cloud, DNS provider, S3, and GPU platforms. Tokens go to the
  OS keychain; metadata to ${chalk.dim(getConfigPath())}.
`);
    return;
  }
  if (topic === "update") {
    console.log(`
  ${chalk.bold("devops-cli update")} — add features to an already-scaffolded project

  ${chalk.bold("Usage:")}
    cd <project-dir> && devops-cli update

  ${chalk.bold("What it does:")}
    Reads the project's .devops-cli.json manifest, lets you pick a new
    feature set, and copies the additive pieces from the starter.
    Currently supported additions: ${chalk.cyan("desktop")}, ${chalk.cyan("mobile")}.

  ${chalk.bold("Removal is not supported.")} Removing features could delete
    user code — remove manually + edit the manifest.
`);
    return;
  }
  if (topic === "config") {
    console.log(`
  ${chalk.bold("devops-cli config")} — manage provider credentials

  ${chalk.bold("Subcommands:")}
    config              Show status of every configured provider
    config add <p>      Configure a provider
                        (coolify, hetzner, dns, s3, modal, runpod, hf, replicate)
    config reset        Clear ALL CLI config (providers, tokens, ML registry, ports)
`);
    return;
  }
  console.log(`
  ${chalk.bold("Usage:")} devops-cli <command> [options]

  ${chalk.bold("Commands:")}
    create          Scaffold a new project (default)
    update          Add features to an already-scaffolded project (run in project dir)
    init            Run first-time setup / onboarding
    config          Show provider status
    config add <p>  Configure a provider (coolify, hetzner, dns, s3, modal, etc.)
    config reset    Clear ALL CLI config (providers, tokens, ML registry, ports)

  ${chalk.bold("Options:")}
    --version, -v   Print the CLI version
    --help, -h      Show this help message (pass to a subcommand for detail)
    --dry-run       (with \`create\`) show what would change without writing
    --yes, -y       (with \`create\`) skip prompts, use defaults / --config values
    --config <path> (with \`create\`) load JSON overrides for ProjectConfig fields
    --name <name>   (with \`create\`) set project name without prompting
    --no-github     (with \`create\`) skip GitHub repo creation
    --no-deploy     (with \`create\`) skip Terraform/Coolify/ML deployment

  ${chalk.bold("Environment:")}
    DEVOPS_CLI_CONF_DIR   Override the config/ports-registry location
                          (advanced — useful for isolated per-workspace state
                          or automated testing).
`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((error) => {
  console.error(chalk.red(`\n  Error: ${error.message}\n`));
  process.exit(1);
});
