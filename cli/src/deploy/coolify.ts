import { join } from "node:path";
import chalk from "chalk";
import { getCoolifyConfig } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { execStream } from "../utils/exec.js";

/** Run the Coolify setup script for the project. */
export async function runCoolifySetup(config: ProjectConfig, repoRoot: string): Promise<void> {
  const coolifyConfig = await getCoolifyConfig();
  const envFile = join(repoRoot, "stacks", `${config.name}.env`);

  console.log(chalk.bold("\n  ── Coolify Setup ─────────────────────────────────────────\n"));

  const env: Record<string, string> = {};
  if (coolifyConfig?.token) {
    env.COOLIFY_TOKEN = coolifyConfig.token;
  }

  const exitCode = await execStream(
    join(repoRoot, "scripts", "setup-coolify-stack.sh"),
    ["--config", envFile],
    { cwd: repoRoot, env },
  );

  if (exitCode !== 0) {
    throw new Error("Coolify setup failed");
  }

  console.log(chalk.green("\n  ✓ Coolify app stack created"));
}
