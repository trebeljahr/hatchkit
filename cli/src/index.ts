#!/usr/bin/env node

import { join, resolve } from "node:path";
import chalk from "chalk";
import {
  isFirstRun,
  runOnboarding,
  getConfig,
  getConfigPath,
  ensureCoolify,
  ensureHetzner,
  ensureDns,
  ensureS3,
  getMlServices,
} from "./config.js";
import { collectProjectConfig } from "./prompts.js";
import { scaffoldApp } from "./scaffold/app.js";
import { scaffoldInfra } from "./scaffold/infra.js";
import { resolveMlServices, printMlSummary, mlEnvVarName } from "./scaffold/ml-client.js";
import { runTerraform } from "./deploy/terraform.js";
import { runCoolifySetup } from "./deploy/coolify.js";
import { setupGitHub } from "./deploy/github.js";
import { deployMlServices } from "./deploy/gpu.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes("--dry-run");

// Resolve the monorepo root (parent of cli/)
const MONOINFRA_ROOT = resolve(join(import.meta.dirname, "..", ".."));
const INFRA_ROOT = join(MONOINFRA_ROOT, "infra");
const STARTER_ROOT = join(MONOINFRA_ROOT, "starter");
const SERVICES_ROOT = join(MONOINFRA_ROOT, "services");

async function main(): Promise<void> {
  console.log(chalk.bold("\n  devops-cli v0.1.0\n"));

  switch (command) {
    case "init":
      await runOnboarding();
      break;
    case "config":
      await handleConfig();
      break;
    case "create":
    case undefined:
      await handleCreate();
      break;
    default:
      printHelp();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleCreate(): Promise<void> {
  // Check if first run
  if (await isFirstRun()) {
    await runOnboarding();
  }

  // Ensure core providers are configured
  await ensureCoolify();

  // Collect project config via interactive prompts
  const config = await collectProjectConfig({ dryRun });

  // Ensure needed providers are configured (lazy prompting)
  if (config.deployTarget === "new") {
    await ensureHetzner();
  }
  if (config.features.includes("s3") && config.s3Provider !== "existing" && config.s3Provider !== "none") {
    await ensureS3(config.s3Provider as "hetzner" | "aws" | "r2");
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
  console.log(`  Deploy to:  ${config.deployTarget === "existing" ? `existing server (${config.serverIp})` : `new Hetzner ${config.serverSize}`}`);
  console.log(`  Features:   ${config.features.length > 0 ? config.features.join(", ") : "none"}`);
  console.log(`  ML:         ${config.mlServices.length > 0 ? config.mlServices.join(", ") : "none"}`);
  console.log(`  Scaffold:   ${config.scaffoldRepo ? "yes" : "no"}`);
  console.log(`  GitHub:     ${config.createGithubRepo ? "yes" : "no"}`);
  console.log(`  Deploy now: ${config.runDeployment ? "yes" : "no"}`);

  if (config.dryRun) {
    console.log(chalk.yellow("\n  [dry-run mode — no changes will be made]\n"));
  }

  // Step 1: Scaffold app repo
  if (config.scaffoldRepo) {
    scaffoldApp(config, appDir);
  }

  // Step 2: Generate infra configs
  scaffoldInfra(config, INFRA_ROOT);

  if (config.dryRun) {
    console.log(chalk.green("\n  ✓ Dry run complete. No changes were made.\n"));
    return;
  }

  // Step 3: Git + GitHub
  if (config.scaffoldRepo) {
    const repoUrl = await setupGitHub(config, appDir);
  }

  // Step 4: Terraform (DNS + optionally server)
  if (config.runDeployment) {
    await runTerraform(config, INFRA_ROOT);
  }

  // Step 5: Coolify setup
  if (config.runDeployment) {
    await runCoolifySetup(config, INFRA_ROOT);
  }

  // Step 6: Deploy ML services
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
        console.log(chalk.dim(`    ${mlEnvVarName(service as any)}=${endpoint}`));
      }
    }
  }

  // Final summary
  console.log(chalk.bold("\n  ── Done! ─────────────────────────────────────────────────\n"));
  console.log(`  App:       ${chalk.cyan(`https://${config.domain}`)}`);
  console.log(`  API:       ${chalk.cyan(`https://api.${config.domain}`)}`);
  console.log(`  App dir:   ${chalk.dim(appDir)}`);
  console.log(`  Config:    ${chalk.dim(getConfigPath())}`);

  if (config.features.includes("stripe")) {
    console.log(chalk.yellow("\n  Next: Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET in Coolify"));
  }

  console.log();
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
      switch (provider) {
        case "coolify": await ensureCoolify(); break;
        case "hetzner": await ensureHetzner(); break;
        case "dns": await ensureDns(); break;
        case "s3": {
          const { select } = await import("@inquirer/prompts");
          const p = await select({ message: "S3 provider:", choices: [
            { name: "Hetzner", value: "hetzner" as const },
            { name: "AWS", value: "aws" as const },
            { name: "R2", value: "r2" as const },
          ]});
          await ensureS3(p);
          break;
        }
        default:
          await (await import("./config.js")).ensureGpuProvider(provider as any);
      }
      break;
    }
    case "reset":
      // Would clear config — leaving as a stub for safety
      console.log(`Config file: ${getConfigPath()}`);
      console.log("Delete the file manually to reset all credentials.");
      break;
    default: {
      // Show current config status
      const config = getConfig();
      console.log(chalk.bold("\n  Provider Status:\n"));
      console.log(`  GitHub:   ${config.providers.github.status === "configured" ? chalk.green("✓") : chalk.red("✗")}`);
      console.log(`  Coolify:  ${config.providers.coolify?.status === "configured" ? chalk.green("✓") : chalk.red("✗")}`);
      console.log(`  Hetzner:  ${config.providers.hetzner?.status === "configured" ? chalk.green("✓") : chalk.red("✗")}`);
      console.log(`  DNS:      ${config.providers.dns?.status === "configured" ? chalk.green(`✓ (${config.providers.dns.provider})`) : chalk.red("✗")}`);

      const s3Providers = Object.keys(config.providers.s3);
      console.log(`  S3:       ${s3Providers.length > 0 ? chalk.green(`✓ (${s3Providers.join(", ")})`) : chalk.dim("not configured")}`);

      const gpuProviders = Object.keys(config.providers.gpu);
      console.log(`  GPU:      ${gpuProviders.length > 0 ? chalk.green(`✓ (${gpuProviders.join(", ")})`) : chalk.dim("not configured")}`);

      const services = getMlServices();
      const serviceCount = Object.keys(services).length;
      console.log(`\n  ML Services: ${serviceCount > 0 ? chalk.green(`${serviceCount} registered`) : chalk.dim("none")}`);
      for (const [name, entry] of Object.entries(services)) {
        console.log(chalk.dim(`    ${name}: ${entry.endpoint} (${entry.platform})`));
      }

      console.log(chalk.dim(`\n  Config: ${getConfigPath()}\n`));
    }
  }
}

function printHelp(): void {
  console.log(`
  ${chalk.bold("Usage:")} devops-cli <command> [options]

  ${chalk.bold("Commands:")}
    create          Scaffold a new project (default)
    init            Run first-time setup / onboarding
    config          Show provider status
    config add <p>  Configure a provider (coolify, hetzner, dns, s3, modal, etc.)
    config reset    Show how to reset credentials

  ${chalk.bold("Options:")}
    --dry-run       Show what would be created without making changes
    --help          Show this help message
`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((error) => {
  console.error(chalk.red(`\n  Error: ${error.message}\n`));
  process.exit(1);
});
