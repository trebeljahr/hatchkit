/*
 * GitHub Actions secrets helpers shared by `hatchkit adopt` and
 * `hatchkit create`.
 *
 * Both flows scaffold a GitHub Actions workflow that builds the
 * Docker image, pushes to GHCR, and triggers Coolify to redeploy.
 * Setting the workflow's secrets must happen BEFORE the first git
 * push, otherwise the workflow's first run hits the "secret not
 * set — skipping deploy trigger" branch and silently no-ops.
 *
 * Canonical workflow shape (current hatchkit deploy.yml):
 *   COOLIFY_BASE_URL + COOLIFY_API_TOKEN + COOLIFY_RESOURCE_UUID +
 *   COOLIFY_WEBHOOK_URL (legacy fallback path). One uuid per project —
 *   the per-surface split (COOLIFY_<SERVER|CLIENT>_RESOURCE_UUID) used
 *   by an older starter template never matched a real project layout
 *   in production, so hatchkit no longer pushes those names.
 *
 * Idempotent (`gh secret set` upserts).
 */

import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { exec } from "../utils/exec.js";

/** A Coolify application the workflow should redeploy on push.
 *
 *  Hatchkit's current deploy.yml uses a single uuid per project
 *  (`COOLIFY_RESOURCE_UUID` + `COOLIFY_WEBHOOK_URL`). Older code
 *  optionally labelled apps as `SERVER` / `CLIENT` to push
 *  `COOLIFY_<label>_RESOURCE_UUID` / `_DEPLOY_WEBHOOK` for a
 *  per-surface split deploy — that workflow shape is gone and the
 *  caller now passes the single resolved app uuid directly. The
 *  `label` field is retained as `never` to give existing callsites a
 *  loud compile error if they try to set it again. */
export interface CoolifyDeployApp {
  /** Coolify application uuid. */
  uuid: string;
  /** Which half of a `split` deployment this app is. Undefined for a
   *  `single-origin` project, which has exactly one app and therefore
   *  exactly one deploy trigger. */
  role?: "client" | "server";
}

export interface CoolifyDeploySecretsInput {
  /** Working directory that has `.git` + `gh` access. */
  projectDir: string;
  /** GitHub `<owner>/<repo>` slug. */
  repoSlug: string;
  /** One or more apps to wire deploy hooks for. Pass a single
   *  unlabelled entry for a `single-origin` project; pass two entries
   *  carrying `role` for a `split` one. The first entry is always the
   *  app that owns the bare domain. */
  apps: CoolifyDeployApp[];
}

export interface CoolifyDeploySecretsResult {
  ok: boolean;
  /** Names of the secrets that were upserted. Used by the caller for
   *  the success log line. */
  pushed: string[];
}

/** Push the secrets that the scaffolded GH Actions workflows need
 *  to talk to Coolify. Best-effort — failures don't roll anything
 *  back; the caller gets a copy-pasteable manual recipe instead. */
export async function setCoolifyDeploySecrets(
  input: CoolifyDeploySecretsInput,
): Promise<CoolifyDeploySecretsResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    console.log(chalk.dim("  · Coolify not configured — skipping Actions secret push."));
    return { ok: false, pushed: [] };
  }
  if (input.apps.length === 0) {
    console.log(chalk.dim("  · No Coolify apps to wire deploy hooks for — skipping."));
    return { ok: false, pushed: [] };
  }

  // Build the secret map.
  //   Set the API-style triple so the workflow uses the per-resource
  //   uuid + bearer token to call Coolify directly. The webhook URL is
  //   set as a fallback path that bypasses the bearer token when an
  //   older deploy.yml template is checked in.
  const baseUrl = cfg.url.replace(/\/$/, "");
  const secrets: Record<string, string> = {
    COOLIFY_BASE_URL: baseUrl,
    COOLIFY_API_TOKEN: cfg.token,
    // Alias kept for adopt's simpler `deploy.yml` template.
    COOLIFY_TOKEN: cfg.token,
  };

  // COOLIFY_RESOURCE_UUID is always set, to the app that owns the bare
  // domain. A `single-origin` project has only that one app, and the
  // generated deploy job fires exactly one trigger from it.
  const primary = input.apps[0];
  secrets.COOLIFY_WEBHOOK_URL = `${baseUrl}/api/v1/deploy?uuid=${primary.uuid}`;
  secrets.COOLIFY_RESOURCE_UUID = primary.uuid;

  // `split` deployments have two apps and therefore need two triggers.
  // The role-suffixed names are additive: the deploy job fires each one
  // only when its secret is non-empty, so an older checked-in workflow
  // that only knows COOLIFY_RESOURCE_UUID keeps working unchanged.
  for (const app of input.apps) {
    if (!app.role) continue;
    const suffix = app.role.toUpperCase();
    secrets[`COOLIFY_RESOURCE_UUID_${suffix}`] = app.uuid;
    secrets[`COOLIFY_WEBHOOK_URL_${suffix}`] = `${baseUrl}/api/v1/deploy?uuid=${app.uuid}`;
  }

  const names = Object.keys(secrets);
  const spinner = ora(
    `GitHub: setting ${names.length} Actions secret${names.length === 1 ? "" : "s"} on ${input.repoSlug}`,
  ).start();
  try {
    for (const [name, value] of Object.entries(secrets)) {
      await ghSecretSet(input.projectDir, input.repoSlug, name, value);
    }
    spinner.succeed(`GitHub: Actions secrets set (${names.join(", ")})`);
    return { ok: true, pushed: names };
  } catch (err) {
    spinner.fail(`GitHub: setting secrets failed — ${(err as Error).message}`);
    console.log(
      chalk.dim(
        `  Set them manually with:\n` +
          names
            .map((n) => `    gh secret set ${n} --repo ${input.repoSlug} --body '${secrets[n]}'`)
            .join("\n"),
      ),
    );
    return { ok: false, pushed: [] };
  }
}

async function ghSecretSet(cwd: string, repo: string, name: string, value: string): Promise<void> {
  const res = await exec("gh", ["secret", "set", name, "--repo", repo, "--body", value], {
    cwd,
  });
  if (res.exitCode !== 0) {
    throw new Error(`gh secret set ${name} exited ${res.exitCode}: ${res.stderr.trim()}`);
  }
}

/** Probe whether a repo-level Actions secret with the given name is
 *  already set on the repo. Used by adopt before recording a fresh
 *  secret in the ledger — we MUST NOT record (and thus risk rolling
 *  back) a secret the user set themselves before hatchkit ran.
 *
 *  Returns `true` (i.e., assume present, don't record) on probe
 *  failure too — `gh secret list` requires admin scope on private
 *  repos and the user's PAT may not have it. Erring toward "exists"
 *  is the safe direction: at worst destroy leaves the secret behind;
 *  the wrong direction would delete the user's data.
 */
export async function ghSecretExists(
  cwd: string,
  repoSlug: string,
  name: string,
): Promise<boolean> {
  const res = await exec(
    "gh",
    [
      "secret",
      "list",
      "--repo",
      repoSlug,
      "--json",
      "name",
      "-q",
      `.[] | select(.name=="${name}") | .name`,
    ],
    { cwd, silent: true },
  );
  if (res.exitCode !== 0) return true;
  return res.stdout.trim().length > 0;
}

/** Delete a repo-level Actions secret. Used by rollback. Returns
 *  "not-found" when the secret wasn't there (gh exits non-zero with
 *  "could not find secret" — treat as already-undone). */
export async function ghSecretDelete(
  repoSlug: string,
  name: string,
): Promise<"done" | "not-found"> {
  const res = await exec("gh", ["secret", "delete", name, "--repo", repoSlug], { silent: true });
  if (res.exitCode === 0) return "done";
  const msg = `${res.stderr}\n${res.stdout}`;
  if (/not found|could not find/i.test(msg)) return "not-found";
  throw new Error(`gh secret delete ${name} exited ${res.exitCode}: ${res.stderr.trim()}`);
}

/** Extract `owner/repo` from a git remote URL.
 *    git@github.com:owner/repo.git           → owner/repo
 *    https://github.com/owner/repo[.git]     → owner/repo
 *  Returns undefined for non-GitHub URLs. */
export function repoSlugFromRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return undefined;
}

/** Extract the `owner` segment alone from a GitHub remote URL. */
export function ownerFromRemote(url: string | undefined): string | undefined {
  const slug = repoSlugFromRemote(url);
  return slug?.split("/")[0];
}
