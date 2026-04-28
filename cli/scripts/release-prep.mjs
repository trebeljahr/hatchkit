#!/usr/bin/env node
/*
 * release-prep — strict pre-release verification.
 *
 * Refuses to release if the working tree has uncommitted or untracked
 * changes. Exits with a clear list of what's dirty so the version
 * commit + tag, the npm publish, and the push all line up against the
 * same baseline.
 *
 * ALSO refuses when the local cli/package.json version is at-or-
 * behind the version published to npm. `npm version patch` increments
 * from the LOCAL version, not the registry's, so drift between the
 * two leads to the script generating a number that's already taken
 * and the publish step crashing after build/typecheck. Catch it up
 * front instead.
 *
 * Skip with RELEASE_SKIP_PREP=1 (e.g. a CI-driven release that's
 * already vouched for cleanliness). RELEASE_SKIP_NPM_CHECK=1 only
 * skips the npm-version comparison, useful offline.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const repos = [{ label: "hatchkit (main)", path: repoRoot, hint: `cd ${repoRoot}` }];

const dirty = [];
for (const r of repos) {
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
  // Tree is clean — also check that the local version isn't lagging
  // behind what's on npm. `npm version patch` would silently bump
  // into a taken number otherwise.
  if (process.env.RELEASE_SKIP_NPM_CHECK !== "1") {
    const driftError = checkNpmDrift(repoRoot);
    if (driftError) {
      console.error(`\n  ✗ release-prep: ${driftError}\n`);
      process.exit(1);
    }
  }
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

/** Returns null on success, an error message string when the local
 *  cli/package.json is at-or-behind what's published on npm. We only
 *  read the registry — never write — so it's safe to run blind. */
function checkNpmDrift(repoRoot) {
  const pkgPath = join(repoRoot, "cli", "package.json");
  if (!existsSync(pkgPath)) return null; // not the hatchkit monorepo layout
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    return `couldn't parse cli/package.json — ${err.message}`;
  }
  const local = pkg.version;
  const name = pkg.name;
  if (!local || !name) return null;

  let registry;
  try {
    registry = sh(`npm view ${name} version`, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // 404 (package doesn't exist yet on npm) is fine — first publish.
    return null;
  }
  if (!registry) return null;

  // Only refuse when local is BEHIND registry. Equal is the post-sync
  // state — `npm version patch` increments past it cleanly.
  if (compareSemver(local, registry) < 0) {
    return [
      `local ${name}@${local} is behind the registry's ${registry}.`,
      "",
      "  `npm version patch` increments from the LOCAL version, so a release now",
      "  would try to publish a version that's already taken. Sync first:",
      "",
      `      cd ${join(repoRoot, "cli")}`,
      `      npm version ${registry} --no-git-tag-version    # match the registry`,
      `      cd ${repoRoot}`,
      `      git add cli/package.json cli/package-lock.json`,
      `      git commit -m "chore: release v${registry}"`,
      `      git tag v${registry}`,
      "",
      "  Then re-run the release; it'll bump cleanly past that.",
    ].join("\n");
  }
  return null;
}

/** Tiny semver compare — returns -1 / 0 / 1 for a vs b. We only feed
 *  it values that come straight out of package.json + npm view, so
 *  pre-release / build-metadata strings are out of scope. */
function compareSemver(a, b) {
  const [aa, bb] = [a, b].map((v) => v.split(".").map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) {
    if ((aa[i] ?? 0) > (bb[i] ?? 0)) return 1;
    if ((aa[i] ?? 0) < (bb[i] ?? 0)) return -1;
  }
  return 0;
}
