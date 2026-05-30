/*
 * Owner inference + docker-compose image-ref substitution for fresh
 * scaffolds.
 *
 * The starter's docker-compose.yml ships with literal `OWNER/REPO`
 * defaults under each service's `image:` key. Coolify's first deploy
 * tries to pull `ghcr.io/OWNER/REPO-server:main` and fails with
 * `invalid reference format`. CI does the right thing (it tags by
 * `${{ github.repository }}`), so the bug only bites on the very first
 * `docker compose up` before someone manually overrides
 * SERVER_IMAGE/CLIENT_IMAGE.
 *
 * This module fills the defaults during scaffold so the literal
 * placeholders never make it to the deployed compose file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownerFromRemote } from "../deploy/gh-actions-secrets.js";
import { exec } from "../utils/exec.js";

/** Best-effort GitHub owner inference for fresh scaffolds.
 *
 *  Resolution order:
 *    1. `configOwner` — explicit override from ProjectConfig.githubOwner.
 *    2. `git remote get-url origin` inside `projectDir` — covers the
 *       `hatchkit update` re-run case where the repo already has an
 *       origin set.
 *    3. `gh api user --jq .login` — works for any user who has the
 *       `gh` CLI authenticated (the same prerequisite `hatchkit create`
 *       already needs for `gh repo create`).
 *    4. `git config user.name`, sanitised to a GHCR-safe slug — last
 *       resort, covers offline runs where `gh` is unavailable.
 *
 *  Returns `undefined` when nothing resolves so the caller can keep
 *  the literal `OWNER` placeholder and warn the user to edit it. */
export async function inferGhOwner(opts: {
  configOwner?: string;
  projectDir: string;
}): Promise<string | undefined> {
  if (opts.configOwner?.trim()) return opts.configOwner.trim();

  const remote = await exec("git", ["remote", "get-url", "origin"], {
    cwd: opts.projectDir,
    silent: true,
  });
  if (remote.exitCode === 0) {
    const fromRemote = ownerFromRemote(remote.stdout.trim());
    if (fromRemote) return fromRemote;
  }

  const gh = await exec("gh", ["api", "user", "--jq", ".login"], { silent: true });
  if (gh.exitCode === 0) {
    const login = gh.stdout.trim();
    if (login) return login;
  }

  const gitName = await exec("git", ["config", "user.name"], { silent: true });
  if (gitName.exitCode === 0) {
    const slug = gitName.stdout
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }

  return undefined;
}

const COMPOSE_REL = "docker-compose.yml";
const OWNER_REPO_LITERAL = "OWNER/REPO";

export interface ComposeSubstitutionResult {
  /** True when the file was rewritten on disk. */
  written: boolean;
  /** Owner segment written into the image refs. `undefined` when no
   *  owner could be inferred AND no substitution happened. */
  owner?: string;
}

/** Substitute the literal `OWNER/REPO` token in the scaffolded
 *  docker-compose.yml with `${owner}/${repo}`.
 *
 *  Idempotent. The literal `OWNER/REPO` is what the starter ships;
 *  any other content (already-substituted slug, user-edited image ref)
 *  is left untouched. Safe to call from `hatchkit update` re-runs.
 *
 *  When `owner` is undefined, only the `REPO` half is substituted —
 *  the literal `OWNER` placeholder stays so the user can see it and
 *  fix it themselves. The caller should print a warning in that case. */
export function substituteComposeImageRefs(
  outputDir: string,
  owner: string | undefined,
  repo: string,
): ComposeSubstitutionResult {
  const path = join(outputDir, COMPOSE_REL);
  if (!existsSync(path)) return { written: false, owner };

  const before = readFileSync(path, "utf-8");
  if (!before.includes(OWNER_REPO_LITERAL)) return { written: false, owner };

  const replacement = owner ? `${owner}/${repo}` : `OWNER/${repo}`;
  const after = before.replaceAll(OWNER_REPO_LITERAL, replacement);
  if (after === before) return { written: false, owner };

  writeFileSync(path, after, "utf-8");
  return { written: true, owner };
}
