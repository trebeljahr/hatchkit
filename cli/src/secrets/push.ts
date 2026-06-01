/*
 * cli/src/secrets/push.ts — Fan a new credential out to the configured
 * deploy targets (Coolify env + GitHub Actions repo-level secret).
 *
 * Reuses the existing transports rather than building a unified
 * `pushSecret` abstraction:
 *   · Coolify: `CoolifyApi.setAppEnv(uuid, envsMap)` from utils/coolify-api.ts
 *     — same call shape as deploy/keys.ts:pushProjectKeyToCoolify.
 *   · GitHub: `gh secret set <name> --repo <slug> --body <value>` via
 *     utils/exec.ts (silent — value carried in argv briefly, same known
 *     leak surface as deploy/keys.ts:pushProjectKeyToGh).
 *
 * Coolify app resolution walks the same candidate list every other
 * push site uses: `<project>`, `<project>-web`, `<project>-server`,
 * `<project>-client`. Unknown-app errors become `coolify-app-not-found`
 * skip reasons (not exceptions); transient 5xx still bubbles.
 */

import { getCoolifyConfig } from "../config.js";
import { repoSlugFromRemote } from "../deploy/gh-actions-secrets.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { redactErrorMessage } from "./audit.js";
import type { DeployTarget, RotationSkipReason } from "./types.js";

export interface PushResult {
  target: DeployTarget;
  /** Names of the env keys actually pushed. Empty when skipped. */
  pushed: string[];
  /** Populated when the push was skipped. */
  skipReason?: RotationSkipReason;
}

/** Pairs of (key, value) to push. Defined here rather than reusing
 *  `provision/write-env.ts:EnvPair` so call-sites can build the array
 *  from any source — adapter `NewCred.values` is a `Record`, not an
 *  array. */
export interface PushPair {
  key: string;
  value: string;
}

/** Push the given pairs to the Coolify application for `projectName`.
 *  Tries `<projectName>`, `<projectName>-web`, `<projectName>-server`,
 *  `<projectName>-client` in order (same precedence as
 *  deploy/keys.ts:pushProjectKeyToCoolify).
 *
 *  Returns `skipReason: 'no-coolify-config'` when no Coolify config is
 *  present, `'coolify-app-not-found'` when no candidate matches. Other
 *  errors (transient 5xx, auth) throw and bubble. */
export async function pushToCoolify(
  projectName: string,
  pairs: PushPair[],
  options: { appName?: string } = {},
): Promise<PushResult> {
  if (pairs.length === 0) {
    return { target: "coolify", pushed: [] };
  }
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    return { target: "coolify", pushed: [], skipReason: "no-coolify-config" };
  }

  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const candidates = options.appName
    ? [options.appName]
    : [projectName, `${projectName}-web`, `${projectName}-server`, `${projectName}-client`];

  let uuid: string | undefined;
  try {
    const apps = await api.listApplications();
    for (const candidate of candidates) {
      const app = apps.find((a) => a.name === candidate);
      if (app) {
        uuid = app.uuid;
        break;
      }
    }
  } catch (err) {
    // Coolify listApplications failure: surface as not-found when the
    // server itself says "not found", otherwise rethrow.
    if (err instanceof Error && /not found/i.test(err.message)) {
      return { target: "coolify", pushed: [], skipReason: "coolify-app-not-found" };
    }
    throw err;
  }

  if (!uuid) {
    return { target: "coolify", pushed: [], skipReason: "coolify-app-not-found" };
  }

  const envs: Record<string, string> = {};
  for (const { key, value } of pairs) envs[key] = value;

  try {
    await api.setAppEnv(uuid, envs);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return { target: "coolify", pushed: [], skipReason: "coolify-app-not-found" };
    }
    throw err;
  }

  return { target: "coolify", pushed: pairs.map((p) => p.key) };
}

/** Push pairs to GitHub Actions as repo-level secrets via `gh secret
 *  set --body`. The `gh` CLI must be installed and authenticated.
 *
 *  When `repoSlug` is omitted, auto-detects from `git remote get-url
 *  origin`. Returns `skipReason: 'no-git-remote'` when no slug can be
 *  resolved. NEVER falls back to a guessed repo. */
export async function pushToGithub(
  pairs: PushPair[],
  options: { repoSlug?: string; cwd?: string } = {},
): Promise<PushResult> {
  if (pairs.length === 0) {
    return { target: "gh", pushed: [] };
  }
  const slug = options.repoSlug ?? (await detectRepoSlug(options.cwd));
  if (!slug) {
    return { target: "gh", pushed: [], skipReason: "no-git-remote" };
  }

  const pushed: string[] = [];
  for (const { key, value } of pairs) {
    const res = await exec("gh", ["secret", "set", key, "--repo", slug, "--body", value], {
      silent: true,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        redactErrorMessage(`gh secret set ${key} exited ${res.exitCode}: ${res.stderr.trim()}`),
      );
    }
    pushed.push(key);
  }
  return { target: "gh", pushed };
}

/** Single dispatcher used by the orchestrator. Iterates the requested
 *  `targets`, calls the matching helper for each, and returns the
 *  array of per-target results in input order. Each target's failure
 *  is captured as a skip; an unexpected exception bubbles up so the
 *  orchestrator can preserve the rollback blob.
 *
 *  Pairs are filtered to "production-scope" by the orchestrator before
 *  reaching here; both Coolify and GH Actions are production-only
 *  surfaces in the current hatchkit model. */
export async function push(
  targets: ReadonlyArray<DeployTarget>,
  projectName: string,
  pairs: PushPair[],
  options: { ghRepoSlug?: string; coolifyAppName?: string; cwd?: string } = {},
): Promise<PushResult[]> {
  const results: PushResult[] = [];
  for (const target of targets) {
    if (target === "coolify") {
      results.push(await pushToCoolify(projectName, pairs, { appName: options.coolifyAppName }));
    } else if (target === "gh") {
      results.push(
        await pushToGithub(pairs, { repoSlug: options.ghRepoSlug, cwd: options.cwd }),
      );
    }
  }
  return results;
}

/** Resolve `owner/repo` from `git remote get-url origin`. Returns
 *  undefined when no origin remote exists or its URL doesn't parse
 *  as a GitHub remote (mirrors deploy/keys.ts:defaultDetectRepoSlug). */
export async function detectRepoSlug(cwd?: string): Promise<string | undefined> {
  const res = await exec("git", ["remote", "get-url", "origin"], { silent: true, cwd });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
}
