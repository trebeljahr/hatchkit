import chalk from "chalk";
import { exec, execStream } from "../utils/exec.js";
import type { ProjectConfig } from "../prompts.js";

/** Initialize git repo, create GitHub remote, and push. */
export async function setupGitHub(
  config: ProjectConfig,
  appDir: string,
): Promise<string | null> {
  console.log(chalk.bold("\n  ── GitHub ────────────────────────────────────────────────\n"));

  // Git init
  await exec("git", ["init"], {
    cwd: appDir,
    spinner: "Initializing git repo...",
  });

  // Initial commit
  await exec("git", ["add", "-A"], { cwd: appDir });
  await exec("git", ["commit", "-m", "Initial scaffold"], {
    cwd: appDir,
    spinner: "Creating initial commit...",
  });

  if (!config.createGithubRepo) {
    console.log(chalk.dim("  Skipped GitHub remote creation."));
    return null;
  }

  // Create GitHub repo
  const createResult = await exec(
    "gh",
    ["repo", "create", config.name, "--private", "--source=.", "--push"],
    { cwd: appDir, spinner: `Creating GitHub repo: ${config.name}...` },
  );

  if (createResult.exitCode !== 0) {
    console.log(chalk.yellow("  Warning: Could not create GitHub repo. You can do this manually later."));
    return null;
  }

  // Get the repo URL
  const urlResult = await exec("gh", ["repo", "view", "--json", "url", "-q", ".url"], {
    cwd: appDir,
  });

  const repoUrl = urlResult.stdout.trim();
  console.log(chalk.green(`  ✓ GitHub repo: ${repoUrl}`));
  return repoUrl;
}
