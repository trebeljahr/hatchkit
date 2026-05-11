import chalk from "chalk";
import type { ProjectConfig } from "../prompts.js";
import { exec } from "../utils/exec.js";

/** Initialize git repo + create GitHub remote. Does NOT push — the
 *  caller (handleCreate / runAdopt) finishes the deploy wiring (env,
 *  Coolify app, GH Actions secrets) before invoking pushInitialBranch
 *  so the workflow's first run has the secrets it needs to redeploy
 *  Coolify. */
export async function setupGitHub(config: ProjectConfig, appDir: string): Promise<string | null> {
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

  // Create GitHub repo + register `origin`, but DO NOT push yet.
  // pushInitialBranch is called by the caller after Coolify wiring
  // and Actions-secret upserts have completed.
  const createResult = await exec(
    "gh",
    ["repo", "create", config.name, "--private", "--source=."],
    { cwd: appDir, spinner: `Creating GitHub repo: ${config.name}...` },
  );

  if (createResult.exitCode !== 0) {
    console.log(chalk.yellow("  Could not create GitHub repo. Your local git repo is ready;"));
    console.log(chalk.yellow(`  push it manually once the remote exists:`));
    console.log(chalk.dim(`    cd ${appDir}`));
    console.log(chalk.dim(`    gh repo create ${config.name} --private --source=. --push`));
    console.log(
      chalk.yellow(
        '  Note: the Coolify env will have GITHUB_REPO_URL="" — update it after pushing.',
      ),
    );
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

/** Push the working branch to `origin`. Run AFTER Coolify wiring +
 *  GH Actions secrets are in place so the workflow's first run can
 *  hit the redeploy webhook successfully. Returns true on a clean
 *  push, false otherwise — the caller uses this to gate the GHCR
 *  visibility flip (no push = no Actions run = no image to wait for). */
export async function pushInitialBranch(projectDir: string): Promise<boolean> {
  // `git symbolic-ref --short HEAD` is more reliable than rev-parse
  // for the brand-new `git init` case where HEAD points at an unborn
  // ref (no commits yet would error on rev-parse).
  const headRes = await exec("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: projectDir,
    silent: true,
  });
  const branch = headRes.exitCode === 0 ? headRes.stdout.trim() : "main";
  const push = await exec("git", ["push", "-u", "origin", branch], {
    cwd: projectDir,
    spinner: `Pushing ${branch} to origin...`,
  });
  if (push.exitCode !== 0) {
    console.log(
      chalk.yellow(
        `  Couldn't push ${branch} to origin — push manually:\n` +
          `    cd ${projectDir}\n` +
          `    git push -u origin ${branch}`,
      ),
    );
    return false;
  }
  return true;
}
