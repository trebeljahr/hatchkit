#!/usr/bin/env node
/*
 * release-bump — bump cli/package.json + commit + tag, atomically.
 *
 * Replaces `npm version <bump> -m "..."` because npm's built-in
 * version command silently skips the commit/tag step in this monorepo
 * layout (cli/ is a workspace member, not the repo root, and the lock
 * file npm tries to stage doesn't exist anymore — pnpm-lock.yaml at
 * the workspace root is the source of truth). The result: every
 * release left cli/package.json modified-but-uncommitted, the publish
 * succeeded against an untracked version, and the release machinery
 * drifted from git history.
 *
 * Doing the three steps ourselves is unambiguous: bump, stage, commit,
 * tag. release-prep.mjs has already verified the working tree is
 * clean before this runs, so the commit only contains the version bump.
 *
 * Usage: node scripts/release-bump.mjs <patch|minor|major>
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, "..");
const pkgPath = join(cliDir, "package.json");

const bumpKind = process.argv[2];
if (!["patch", "minor", "major"].includes(bumpKind)) {
  console.error(`release-bump: expected patch|minor|major, got ${bumpKind ?? "(nothing)"}`);
  process.exit(1);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", ...opts }).trim();
}

const repoRoot = sh("git rev-parse --show-toplevel");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const current = pkg.version;
const [maj, min, pat] = current.split(".").map((n) => Number(n) || 0);
const next =
  bumpKind === "major"
    ? `${maj + 1}.0.0`
    : bumpKind === "minor"
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;

pkg.version = next;
// npm's `npm version` keeps a trailing newline; preserve that so diffs
// stay 1 line and don't churn whitespace.
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
console.log(`  release-bump: ${current} → ${next}`);

// Bump `@hatchkit/dev-*` workspace packages in lockstep with the CLI.
// The CLI's runtime references the plugin version range as
// `^${cliVersion}` (see devPluginNextVersionRange in dev-setup.ts), so
// every release must guarantee the plugin packages exist on npm at the
// same version. release-packages.mjs publishes them right after this
// script bumps + commits the lockstep set.
const stagedPaths = [join("cli", "package.json")];
const lockstepPackages = ["dev-shared", "dev-plugin-next", "dev-plugin-vite"];
for (const name of lockstepPackages) {
  const subPath = join(repoRoot, "packages", name, "package.json");
  let subPkg;
  try {
    subPkg = JSON.parse(readFileSync(subPath, "utf-8"));
  } catch (err) {
    console.error(`  release-bump: missing packages/${name}/package.json — ${err.message}`);
    process.exit(1);
  }
  if (subPkg.version === next) continue;
  subPkg.version = next;
  writeFileSync(subPath, `${JSON.stringify(subPkg, null, 2)}\n`, "utf-8");
  stagedPaths.push(join("packages", name, "package.json"));
  console.log(`  release-bump: packages/${name} → ${next}`);
}

// Stage + commit + tag from the repo root so the paths in the commit
// are repo-relative regardless of where the script was invoked.
for (const p of stagedPaths) {
  sh(`git add ${JSON.stringify(p)}`, { cwd: repoRoot });
}
sh(`git commit -m ${JSON.stringify(`chore: release v${next}`)}`, { cwd: repoRoot });
sh(`git tag ${JSON.stringify(`v${next}`)}`, { cwd: repoRoot });
console.log(`  release-bump: committed + tagged v${next}`);
