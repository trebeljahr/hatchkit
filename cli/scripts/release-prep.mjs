#!/usr/bin/env node
/*
 * release-prep — strict pre-release verification.
 *
 * Refuses to release if any of the three repos (hatchkit main,
 * infra submodule, starter submodule) has uncommitted or untracked
 * changes. Exits with a clear list of which repos need handling and
 * what's dirty in each — release scripts assume a clean baseline so
 * the version commit + tag, the npm publish, and the cross-repo push
 * all line up against the same set of trees.
 *
 * Skip with RELEASE_SKIP_PREP=1 (e.g. a CI-driven release that's
 * already vouched for cleanliness).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

if (process.env.RELEASE_SKIP_PREP === "1") {
  console.log("  release-prep: RELEASE_SKIP_PREP=1 — skipping.");
  process.exit(0);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts }).trim();
}

let repoRoot;
try {
  repoRoot = sh("git rev-parse --show-toplevel");
} catch {
  console.error("  release-prep: not inside a git repo. Aborting.");
  process.exit(1);
}

const repos = [
  { label: "hatchkit (main)", path: repoRoot, hint: `cd ${repoRoot}` },
  {
    label: "infra (submodule)",
    path: join(repoRoot, "infra"),
    hint: `cd ${join(repoRoot, "infra")}`,
  },
  {
    label: "starter (submodule)",
    path: join(repoRoot, "starter"),
    hint: `cd ${join(repoRoot, "starter")}`,
  },
];

const dirty = [];
for (const r of repos) {
  // Submodule may not be initialized — skip silently rather than fail.
  // (`.git` is a file inside an initialized submodule, a dir at the root.)
  if (!existsSync(join(r.path, ".git"))) continue;

  let status;
  try {
    status = sh("git status --porcelain", { cwd: r.path });
  } catch (err) {
    console.error(`  release-prep: couldn't read ${r.label}: ${err.message}`);
    process.exit(1);
  }
  if (status) {
    dirty.push({ ...r, status });
  }
}

if (dirty.length === 0) {
  console.log("  ✓ release-prep: all trees clean. Continuing release.");
  process.exit(0);
}

console.error("\n  ✗ release-prep: cannot release — dangling changes.\n");
for (const r of dirty) {
  const rel = r.path === repoRoot ? "." : relative(repoRoot, r.path);
  console.error(`  ── ${r.label}  (${rel}/)`);
  for (const line of r.status.split("\n")) {
    console.error(`      ${line}`);
  }
  console.error();
}
console.error("  Handle each tree before releasing:");
for (const r of dirty) {
  console.error(`    ${r.hint} && git status   # commit / stash / discard`);
}
console.error("\n  Then re-run the release.\n");
process.exit(1);
