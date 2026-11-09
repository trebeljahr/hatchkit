import chalk from "chalk";
import type { ProjectConfig } from "../prompts.js";
import { exec } from "../utils/exec.js";
import { stageAllSafely } from "../utils/git-safety.js";

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

  if (config.createGithubRepo && config.reuseGithubRepo) {
    return reuseExistingGithubRepo(config, appDir);
  }

  // Initial commit. stageAllSafely refuses a staged secret whatever
  // `.gitignore` says; the `gh repo create` below would publish it.
  await stageAllSafely(appDir, { project: config.name });
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
  const visibility = config.githubRepoVisibility ?? "public";
  const createResult = await exec(
    "gh",
    ["repo", "create", config.name, `--${visibility}`, "--source=."],
    { cwd: appDir, spinner: `Creating ${visibility} GitHub repo: ${config.name}...` },
  );

  if (createResult.exitCode !== 0) {
    const reused = await reuseEmptyRepo(config.name, visibility, appDir);
    if (reused) return reused;
    console.log(chalk.yellow("  Could not create GitHub repo. Your local git repo is ready;"));
    console.log(chalk.yellow(`  push it manually once the remote exists:`));
    console.log(chalk.dim(`    cd ${appDir}`));
    console.log(chalk.dim(`    gh repo create ${config.name} --${visibility} --source=. --push`));
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

/** A create that failed after `gh repo create` leaves an empty repo
 *  behind, and re-running create then fails on "name already exists".
 *  Take that repo over when it is provably the leftover: empty (nothing
 *  was ever pushed) and of the visibility asked for. A repo with any
 *  history is never adopted here — it is someone's work. */
async function reuseEmptyRepo(
  name: string,
  visibility: string,
  appDir: string,
): Promise<string | null> {
  const view = await exec("gh", ["repo", "view", name, "--json", "url,sshUrl,isEmpty,visibility"], {
    cwd: appDir,
    silent: true,
  });
  if (view.exitCode !== 0) return null;
  let repo: { url: string; sshUrl: string; isEmpty: boolean; visibility: string };
  try {
    repo = JSON.parse(view.stdout);
  } catch {
    return null;
  }
  if (!repo.isEmpty || repo.visibility.toLowerCase() !== visibility) return null;
  const remote = await gitRemoteFor(repo, appDir);
  const add = await exec("git", ["remote", "add", "origin", remote], { cwd: appDir, silent: true });
  if (add.exitCode !== 0) return null;
  console.log(
    chalk.green(
      `  ✓ GitHub repo: ${repo.url} (empty ${visibility} repo from an earlier run, reused)`,
    ),
  );
  return repo.url;
}

/** The URL `origin` gets: ssh when `gh` is set to the ssh protocol,
 *  else https. */
async function gitRemoteFor(repo: { url: string; sshUrl: string }, cwd?: string): Promise<string> {
  const protocol = await exec("gh", ["config", "get", "git_protocol"], { cwd, silent: true });
  return protocol.stdout.trim() === "ssh" ? repo.sshUrl : `${repo.url}.git`;
}

/** The branch a reused repo's scaffold lands on. The starter's
 *  workflows trigger on `main`, so the scaffold goes there whatever the
 *  old repo's default branch was. */
export const REUSED_REPO_BRANCH = "main";

export interface ReusableGithubRepo {
  /** `owner/name`, as `gh` accepts it. */
  slug: string;
  url: string;
  /** What `origin` is set to (see gitRemoteFor). */
  remote: string;
  private: boolean;
  /** Branch the scaffold is stacked on: the repo's `main` when it has
   *  one, else its default branch. Null for an empty repo. */
  baseBranch: string | null;
}

/** Look up the repo `--reuse-github-repo` points at and check it fits:
 *  it exists, and its visibility matches the one asked for (hatchkit
 *  never changes the visibility of a repo it did not create, and the
 *  GHCR and Coolify wiring follow the requested visibility). Throws a
 *  message naming the fix. Read-only. */
export async function inspectReusableGithubRepo(
  config: Pick<ProjectConfig, "name" | "githubOwner" | "githubRepoVisibility">,
  cwd?: string,
): Promise<ReusableGithubRepo> {
  const slug = config.githubOwner ? `${config.githubOwner}/${config.name}` : config.name;
  const view = await exec(
    "gh",
    [
      "repo",
      "view",
      slug,
      "--json",
      "nameWithOwner,url,sshUrl,visibility,isEmpty,defaultBranchRef",
    ],
    { cwd, silent: true },
  );
  if (view.exitCode !== 0) {
    throw new Error(
      `--reuse-github-repo: no GitHub repo ${slug} found (gh repo view failed). ` +
        "Drop the flag to create a new repo, or pass the existing repo's name.",
    );
  }
  const info = JSON.parse(view.stdout) as {
    nameWithOwner: string;
    url: string;
    sshUrl: string;
    visibility: string;
    isEmpty: boolean;
    defaultBranchRef: { name: string } | null;
  };
  const wanted = config.githubRepoVisibility ?? "public";
  const actual = info.visibility.toLowerCase();
  if (actual !== wanted) {
    throw new Error(
      `--reuse-github-repo: ${info.nameWithOwner} is ${actual}, but this create asks for a ${wanted} repo. ` +
        `Pass --${actual === "private" ? "private" : "public"} to keep it as it is; hatchkit does not change an existing repo's visibility.`,
    );
  }
  let baseBranch: string | null = null;
  if (!info.isEmpty) {
    const main = await exec(
      "gh",
      ["api", `repos/${info.nameWithOwner}/branches/${REUSED_REPO_BRANCH}`],
      {
        cwd,
        silent: true,
      },
    );
    baseBranch = main.exitCode === 0 ? REUSED_REPO_BRANCH : (info.defaultBranchRef?.name ?? null);
  }
  return {
    slug: info.nameWithOwner,
    url: info.url,
    remote: await gitRemoteFor(info, cwd),
    private: actual === "private",
    baseBranch,
  };
}

/** Make the scaffold's first commits sit on top of an existing repo's
 *  history instead of starting a new one. `appDir` is a fresh `git init`
 *  with nothing committed. The result on `main`:
 *
 *    <old history> ── "Clear the previous code for a fresh start" (empty tree)
 *                  ── "Initial scaffold"
 *
 *  so the old commits stay reachable from `main` and the push is a
 *  fast-forward when the old repo already had `main`. `remote` is any
 *  URL git can fetch (a GitHub https URL, or a local path in tests). */
export async function stackScaffoldOnHistory(
  appDir: string,
  remote: string,
  baseBranch: string | null,
  project: string,
): Promise<void> {
  const git = async (args: string[], spinner?: string) => {
    const result = await exec("git", args, { cwd: appDir, silent: !spinner, spinner });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout.trim();
  };

  await git(["symbolic-ref", "HEAD", `refs/heads/${REUSED_REPO_BRANCH}`]);
  await git(["remote", "add", "origin", remote]);

  if (baseBranch) {
    await git(["fetch", "--no-tags", "origin", baseBranch], `Fetching ${baseBranch} history...`);
    // A fresh `git init` has an empty index, so write-tree gives the
    // empty tree in whatever object format the repo uses.
    const emptyTree = await git(["write-tree"]);
    const clear = await git([
      "commit-tree",
      emptyTree,
      "-p",
      "FETCH_HEAD",
      "-m",
      "Clear the previous code for a fresh start\n\n" +
        "The commits before this one stay in the history. The next commit is a new hatchkit scaffold.",
    ]);
    await git(["update-ref", "HEAD", clear]);
  }

  await stageAllSafely(appDir, { project });
  await git(["commit", "-m", "Initial scaffold"], "Creating initial commit...");
}

/** `--reuse-github-repo` path of setupGitHub: no `gh repo create`, the
 *  scaffold is stacked on the existing repo's history. */
async function reuseExistingGithubRepo(
  config: ProjectConfig,
  appDir: string,
): Promise<string | null> {
  let repo: ReusableGithubRepo;
  try {
    repo = await inspectReusableGithubRepo(config, appDir);
  } catch (err) {
    // Preflight already checked this; a failure here means the repo
    // changed mid-run. Leave a committed local repo, as the create path
    // does when `gh repo create` fails.
    console.log(chalk.yellow(`  ${(err as Error).message}`));
    await stageAllSafely(appDir, { project: config.name });
    await exec("git", ["commit", "-m", "Initial scaffold"], { cwd: appDir, silent: true });
    return null;
  }

  await stackScaffoldOnHistory(appDir, repo.remote, repo.baseBranch, config.name);
  console.log(
    chalk.green(
      `  ✓ Reusing GitHub repo: ${repo.url}` +
        (repo.baseBranch ? ` (scaffold stacked on ${repo.baseBranch}, history kept)` : " (empty)"),
    ),
  );
  return repo.url;
}

/** Push the working branch to `origin`. Run AFTER Coolify wiring +
 *  GH Actions secrets are in place so the workflow's first run can
 *  hit the redeploy webhook successfully. Returns true on a clean
 *  push, false otherwise — the caller uses this to gate the GHCR
 *  visibility flip (no push = no Actions run = no image to wait for). */
export async function pushInitialBranch(
  projectDir: string,
  opts: { makeDefaultBranch?: boolean } = {},
): Promise<boolean> {
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
  if (opts.makeDefaultBranch) {
    // A reused repo may still default to `master`; the workflows and
    // Coolify follow `main`. The old branch itself is left alone.
    const edit = await exec("gh", ["repo", "edit", "--default-branch", branch], {
      cwd: projectDir,
      spinner: `Making ${branch} the default branch...`,
    });
    if (edit.exitCode !== 0) {
      console.log(
        chalk.yellow(
          `  Couldn't make ${branch} the default branch — run:\n` +
            `    gh repo edit --default-branch ${branch}`,
        ),
      );
    }
  }
  return true;
}
