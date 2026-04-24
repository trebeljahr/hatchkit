#!/usr/bin/env node
/*
 * release-prep — run before `npm version` so any dangling working-tree
 * changes get committed and shipped with the release instead of hanging
 * around on main afterwards.
 *
 * Runs from cli/ (where the release scripts live). Finds the repo root
 * via `git rev-parse --show-toplevel` and operates on the whole repo,
 * not just cli/ — if you've left changes under infra/ or docs/ they get
 * picked up too.
 *
 * Safety rails:
 *   - Refuses to run if any staged/untracked path looks like a secret
 *     (.env*, *.pem, *.key, *credentials*, *secret*).
 *   - Submodule pointer changes (git shows as ` M infra` vs `M  infra`)
 *     are fine, but untracked content INSIDE a submodule is NOT auto-
 *     committed from the parent repo — you'd want to commit that inside
 *     the submodule yourself first. We warn + bail in that case.
 *   - Interactive: prompts for a commit message (default:
 *     "chore: pre-release changes").
 *   - Non-interactive (no TTY): uses the default message and proceeds.
 *     Skip the whole thing with RELEASE_SKIP_PREP=1.
 */

import { execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

if (process.env.RELEASE_SKIP_PREP === "1") {
  console.log("  release-prep: RELEASE_SKIP_PREP=1 — skipping.");
  process.exit(0);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts }).trim();
}

// Find the repo root so git commands work no matter where the script was
// launched from (pnpm invokes scripts with cwd=cli/).
let repoRoot;
try {
  repoRoot = sh("git rev-parse --show-toplevel");
} catch (err) {
  console.error("  release-prep: not inside a git repo. Aborting.");
  process.exit(1);
}

const porcelain = sh("git status --porcelain", { cwd: repoRoot });
if (!porcelain) {
  console.log("  release-prep: working tree clean. Nothing to commit.");
  process.exit(0);
}

const entries = porcelain.split("\n").map((l) => {
  // Porcelain format: "XY path". X = index, Y = worktree. Submodules
  // show up with `m`/`M` in position Y + 1 for content changes.
  const code = l.slice(0, 2);
  const path = l.slice(3);
  return { code, path };
});

console.log("\n  release-prep: working tree isn't clean.\n");
console.log(sh("git status --short", { cwd: repoRoot }));

// Refuse secret-looking paths. Keep the pattern conservative — better a
// false positive that requires manual commit than a leaked token.
const SECRET_RE = /(^|\/)(\.env(\.|$)|[^/]*credentials[^/]*|[^/]*secret[^/]*|[^/]*\.(pem|key|pfx|p12)$)/i;
const secretsFound = entries.filter((e) => SECRET_RE.test(e.path));
if (secretsFound.length > 0) {
  console.error("\n  release-prep: refusing — these paths look like secrets:\n");
  for (const e of secretsFound) console.error(`    ${e.path}`);
  console.error(
    "\n  Resolve manually: gitignore, delete, or commit yourself and re-run the release.",
  );
  process.exit(1);
}

// Untracked content inside a submodule shows as e.g. ' m infra' with
// only the second column set to lowercase 'm'. Parent-repo `git add`
// can't reach inside; bail so the user commits in the submodule first.
const untrackedInSubmodule = entries.filter((e) => e.code === " m" || e.code === "?m");
if (untrackedInSubmodule.length > 0) {
  console.error(
    "\n  release-prep: submodule has untracked changes inside it:\n",
  );
  for (const e of untrackedInSubmodule) {
    console.error(`    ${e.path} — commit inside the submodule first`);
  }
  console.error(
    "\n  cd into each submodule, commit, then `git add <submodule>` + re-run the release.",
  );
  process.exit(1);
}

// Prompt for a commit message unless we're non-interactive.
const DEFAULT_MSG = "chore: pre-release changes";
let message = DEFAULT_MSG;
if (input.isTTY && output.isTTY) {
  const rl = createInterface({ input, output });
  message = await new Promise((resolve) => {
    rl.question(`  Commit message [${DEFAULT_MSG}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || DEFAULT_MSG);
    });
  });
} else {
  console.log(`  release-prep: non-interactive — using default message "${DEFAULT_MSG}".`);
}

// Stage + commit at the repo root. Using `git add -A` here is intentional
// (the whole point of this helper is to sweep everything into the release
// commit); the secret-path guard above is what keeps it safe.
const add = spawnSync("git", ["add", "-A"], { cwd: repoRoot, stdio: "inherit" });
if (add.status !== 0) {
  console.error("  release-prep: `git add -A` failed.");
  process.exit(add.status ?? 1);
}

const commit = spawnSync("git", ["commit", "-m", message], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (commit.status !== 0) {
  console.error(
    "  release-prep: `git commit` failed (pre-commit hook? empty diff after filters?).",
  );
  process.exit(commit.status ?? 1);
}

console.log("\n  release-prep: committed. Continuing release.\n");
