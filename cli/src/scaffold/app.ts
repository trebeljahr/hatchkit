import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import chalk from "chalk";
import type { ProjectConfig, MlService } from "../prompts.js";

// Monorepo root → starter submodule
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

/** Scaffold a new app by copying the starter template and customizing it. */
export function scaffoldApp(config: ProjectConfig, outputDir: string): string[] {
  if (config.dryRun) {
    return scaffoldDryRun(config, outputDir);
  }

  if (!existsSync(STARTER_ROOT)) {
    throw new Error(
      `Starter template not found at ${STARTER_ROOT}. Run 'git submodule update --init' in the monorepo root.`,
    );
  }

  console.log(chalk.dim(`\n  Copying starter template from ${STARTER_ROOT}...`));

  // Copy the entire starter, excluding .git and node_modules
  cpSync(STARTER_ROOT, outputDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.replace(STARTER_ROOT, "");
      if (rel.includes("/.git")) return false;
      if (rel.includes("/node_modules")) return false;
      if (rel.includes("/.next")) return false;
      if (rel.includes("/dist/")) return false;
      return true;
    },
  });

  const modifications: string[] = [];

  // Rename the project in package.json files
  replaceInFile(
    join(outputDir, "package.json"),
    "node-realtime-starter",
    config.name,
  );
  modifications.push("package.json (renamed project)");

  // Update .env.example and .env.development with the project domain
  for (const envFile of [".env.example", ".env.development", "packages/server/.env.example", "packages/server/.env.development"]) {
    const path = join(outputDir, envFile);
    if (existsSync(path)) {
      replaceInFile(path, "localhost", config.domain);
      modifications.push(`${envFile} (updated domain)`);
    }
  }

  // Remove features the user didn't select
  if (!config.features.includes("websocket")) {
    removeIfExists(join(outputDir, "packages/server/src/ws"));
    modifications.push("removed: ws/ (WebSocket not selected)");
  }

  if (!config.features.includes("stripe")) {
    removeIfExists(join(outputDir, "packages/server/src/services/stripe.ts"));
    modifications.push("removed: stripe service (Stripe not selected)");
  }

  // Remove ML playground pages for services not selected
  const allMlServices: MlService[] = ["background-removal", "subtitles", "image-recognition", "3d-extraction"];
  for (const service of allMlServices) {
    if (!config.mlServices.includes(service)) {
      removeIfExists(join(outputDir, `packages/client/src/app/(protected)/playground/${service}`));
      modifications.push(`removed: playground/${service} (not selected)`);
    }
  }

  // If no ML services selected at all, remove the entire playground and ML infrastructure
  if (config.mlServices.length === 0) {
    removeIfExists(join(outputDir, "packages/client/src/app/(protected)/playground"));
    removeIfExists(join(outputDir, "packages/client/src/components/ml"));
    removeIfExists(join(outputDir, "packages/server/src/trpc/routers/ml.ts"));
    removeIfExists(join(outputDir, "packages/server/src/services/ml.ts"));
    removeIfExists(join(outputDir, "packages/shared/src/ml-types.ts"));

    // Remove ml router from the tRPC router registration
    const routerPath = join(outputDir, "packages/server/src/trpc/router.ts");
    if (existsSync(routerPath)) {
      let content = readFileSync(routerPath, "utf-8");
      content = content.replace('import { mlRouter } from "./routers/ml.js";\n', "");
      content = content.replace("  ml: mlRouter,\n", "");
      writeFileSync(routerPath, content, "utf-8");
    }

    // Remove ml-types export from shared barrel
    const sharedIndexPath = join(outputDir, "packages/shared/src/index.ts");
    if (existsSync(sharedIndexPath)) {
      let content = readFileSync(sharedIndexPath, "utf-8");
      content = content.replace('export * from "./ml-types.js";\n', "");
      writeFileSync(sharedIndexPath, content, "utf-8");
    }

    // Remove Playground from navbar
    const layoutPath = join(outputDir, "packages/client/src/app/(protected)/layout.tsx");
    if (existsSync(layoutPath)) {
      let content = readFileSync(layoutPath, "utf-8");
      content = content.replace(
        /\s*<Link\s+href="\/playground"[^>]*>[^<]*<\/Link>/,
        "",
      );
      writeFileSync(layoutPath, content, "utf-8");
    }

    modifications.push("removed: ML playground, ML router, ML types, ML navbar link");
  }

  console.log(chalk.green(`  ✓ Scaffolded project in ${outputDir}`));
  if (modifications.length > 0) {
    console.log(chalk.dim(`    ${modifications.length} modifications applied`));
  }

  return modifications;
}

/** Dry run — list what would happen. */
function scaffoldDryRun(config: ProjectConfig, outputDir: string): string[] {
  console.log(chalk.bold("\n  [dry-run] Would scaffold from starter template:\n"));
  console.log(chalk.dim(`    Source: ${STARTER_ROOT}`));
  console.log(chalk.dim(`    Target: ${outputDir}`));
  console.log();

  const actions: string[] = [];
  actions.push("Copy starter template");
  actions.push(`Rename project to "${config.name}"`);
  actions.push(`Set domain to "${config.domain}"`);

  if (!config.features.includes("websocket")) actions.push("Remove WebSocket support");
  if (!config.features.includes("stripe")) actions.push("Remove Stripe integration");
  if (config.mlServices.length === 0) {
    actions.push("Remove ML playground, router, types");
  } else {
    const removed = ["background-removal", "subtitles", "image-recognition", "3d-extraction"]
      .filter((s) => !config.mlServices.includes(s as MlService));
    if (removed.length > 0) {
      actions.push(`Remove unused ML pages: ${removed.join(", ")}`);
    }
  }

  for (const action of actions) {
    console.log(chalk.dim(`    - ${action}`));
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function replaceInFile(filePath: string, search: string, replace: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  writeFileSync(filePath, content.replaceAll(search, replace), "utf-8");
}

function removeIfExists(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}
