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
 *
 * Both targets update only keys the target ALREADY holds. A hatchkit
 * app normally reads its secrets from the committed, encrypted
 * `.env.production`; a Coolify env var or Actions secret of the same
 * name exists only where the project put one on purpose, and there it
 * overrides the file, so it must move with the rotation. Creating a
 * new plaintext copy where none existed would spread the credential to
 * one more place it can leak from.
 *
 * Two refinements:
 *   · A pair marked `secret: false` also updates an Actions VARIABLE of
 *     the same name — a client build value like NEXT_PUBLIC_SENTRY_DSN
 *     lives there, because it ships in the bundle anyway.
 *   · A pair with `previous` (a name that isn't in the env file) updates
 *     a target only where it holds exactly that old value, read back
 *     first. Actions secrets can't be read, so such a pair never touches
 *     one.
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
  /** `false` lets the pair update a repo VARIABLE of the same name.
   *  Default: secret — Actions secrets only. */
  secret?: boolean;
  /** Update a target only where it currently holds exactly this value.
   *  Set for names that live on deploy targets alone, so a same-named
   *  value someone set for another service is never overwritten. */
  previous?: string;
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

  let onTarget: PushPair[];
  try {
    if (pairs.some((p) => p.previous !== undefined)) {
      // Comparing against `previous` needs the live values. They stay in
      // this block: compared, never printed or returned. A value the
      // token can't read (no read:sensitive) can't be confirmed, so it
      // isn't overwritten.
      const live = new Map<string, string | undefined>();
      for (const row of await api.listAppEnvRows(uuid)) {
        if (!row.isPreview) live.set(row.key, row.value);
      }
      onTarget = pairs.filter((p) => {
        if (!live.has(p.key)) return false;
        if (p.previous === undefined) return true;
        return live.get(p.key)?.trim() === p.previous;
      });
    } else {
      const present = new Set(await api.listAppEnvKeys(uuid));
      onTarget = pairs.filter((p) => present.has(p.key));
    }
    if (onTarget.length === 0) return { target: "coolify", pushed: [] };
    const envs: Record<string, string> = {};
    for (const { key, value } of onTarget) envs[key] = value;
    await api.setAppEnv(uuid, envs);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return { target: "coolify", pushed: [], skipReason: "coolify-app-not-found" };
    }
    throw err;
  }

  return { target: "coolify", pushed: onTarget.map((p) => p.key) };
}

/** Update repo-level GitHub Actions secrets that already exist, via
 *  `gh secret set <name>` with the value on stdin (never in argv, where
 *  `ps` can read it). The `gh` CLI must be installed and authenticated.
 *  Pairs marked `secret: false` also update an existing repo variable of
 *  the same name (`gh variable set`, value on stdin as well).
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
  // A secret's value can't be read back, so a pair that must match an
  // old value never updates one.
  const secretPairs = pairs.filter((p) => p.previous === undefined);
  const present = secretPairs.length > 0 ? await listGithubSecretNames(slug) : new Set<string>();
  for (const { key, value } of secretPairs) {
    if (!present.has(key)) continue;
    const res = await exec("gh", ["secret", "set", key, "--repo", slug], {
      silent: true,
      input: value,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        redactErrorMessage(`gh secret set ${key} exited ${res.exitCode}: ${res.stderr.trim()}`),
      );
    }
    pushed.push(key);
  }

  const variablePairs = pairs.filter((p) => p.secret === false);
  if (variablePairs.length > 0) {
    const variables = await listGithubVariables(slug);
    for (const { key, value, previous } of variablePairs) {
      if (!variables.has(key)) continue;
      if (previous !== undefined && variables.get(key)?.trim() !== previous) continue;
      const res = await exec("gh", ["variable", "set", key, "--repo", slug], {
        silent: true,
        input: value,
      });
      if (res.exitCode !== 0) {
        throw new Error(
          redactErrorMessage(`gh variable set ${key} exited ${res.exitCode}: ${res.stderr.trim()}`),
        );
      }
      if (!pushed.includes(key)) pushed.push(key);
    }
  }
  return { target: "gh", pushed };
}

/** Repo-level Actions variables on `slug`, name → value. Variables are
 *  not secret (the API returns their values); only names reach output. */
export async function listGithubVariables(slug: string): Promise<Map<string, string>> {
  const res = await exec("gh", ["variable", "list", "--repo", slug, "--json", "name,value"], {
    silent: true,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      redactErrorMessage(
        `gh variable list --repo ${slug} exited ${res.exitCode}: ${res.stderr.trim()}`,
      ),
    );
  }
  try {
    const rows = JSON.parse(res.stdout || "[]") as Array<{ name?: string; value?: string }>;
    return new Map(
      rows.filter((r) => r.name).map((r) => [r.name as string, r.value ?? ""] as const),
    );
  } catch {
    throw new Error(`gh variable list --repo ${slug} returned output that is not JSON`);
  }
}

/** Names of the repo-level Actions secrets on `slug`. Names only — the
 *  API never returns a secret value. */
export async function listGithubSecretNames(slug: string): Promise<Set<string>> {
  const res = await exec("gh", ["secret", "list", "--repo", slug, "--json", "name"], {
    silent: true,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      redactErrorMessage(`gh secret list --repo ${slug} exited ${res.exitCode}: ${res.stderr.trim()}`),
    );
  }
  try {
    const rows = JSON.parse(res.stdout || "[]") as Array<{ name?: string }>;
    return new Set(rows.map((r) => r.name ?? "").filter(Boolean));
  } catch {
    throw new Error(`gh secret list --repo ${slug} returned output that is not JSON`);
  }
}

/** Single dispatcher used by the orchestrator. Iterates the requested
 *  `targets`, calls the matching helper for each, and returns the
 *  array of per-target results in input order. Each target's failure
 *  is captured as a skip; an unexpected exception bubbles up to the
 *  orchestrator, which catches it locally so other adapters keep
 *  their audit entries.
 *
 *  Pairs are filtered to "production-scope" by the orchestrator before
 *  reaching here; both Coolify and GH Actions are production-only
 *  surfaces in the current hatchkit model. */
async function pushReal(
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

/** Mutable indirection so unit tests can swap in a throwing stub
 *  without touching real Coolify/GH credentials. The exported `push`
 *  delegates through this reference; the rotation orchestrator only
 *  ever sees `push`, so no production code path notices the seam. */
let activePush: typeof pushReal = pushReal;

export async function push(
  targets: ReadonlyArray<DeployTarget>,
  projectName: string,
  pairs: PushPair[],
  options: { ghRepoSlug?: string; coolifyAppName?: string; cwd?: string } = {},
): Promise<PushResult[]> {
  return activePush(targets, projectName, pairs, options);
}

/** Test-only seam. Replaces the internal push implementation with
 *  `fn` (typically a throwing stub for exercising the orchestrator's
 *  push-failure path). Call with `undefined` to restore the real
 *  implementation. NEVER use this in production code. */
export function __setPushImplForTesting(fn: typeof pushReal | undefined): void {
  activePush = fn ?? pushReal;
}

/** Resolve `owner/repo` from `git remote get-url origin`. Returns
 *  undefined when no origin remote exists or its URL doesn't parse
 *  as a GitHub remote (mirrors deploy/keys.ts:defaultDetectRepoSlug). */
export async function detectRepoSlug(cwd?: string): Promise<string | undefined> {
  const res = await exec("git", ["remote", "get-url", "origin"], { silent: true, cwd });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
}
