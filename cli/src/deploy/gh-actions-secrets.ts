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
 * Two workflow shapes coexist today:
 *   · adopt's `deploy.yml` uses COOLIFY_WEBHOOK_URL + COOLIFY_TOKEN
 *     for a single app.
 *   · the starter's `build-and-deploy.yml` uses COOLIFY_BASE_URL +
 *     COOLIFY_API_TOKEN + COOLIFY_<SERVER|CLIENT>_RESOURCE_UUID +
 *     COOLIFY_<SERVER|CLIENT>_DEPLOY_WEBHOOK for split server/client
 *     apps (with API-vs-webhook fallback).
 *
 * setCoolifyDeploySecrets sets BOTH naming conventions so a project
 * works regardless of which workflow file is checked into the repo.
 * Idempotent (`gh secret set` upserts).
 */

import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { exec } from "../utils/exec.js";

/** A Coolify application the workflow should redeploy on push.
 *  `label`:
 *    · undefined   → single-app project (adopt-style). Sets
 *                    COOLIFY_WEBHOOK_URL.
 *    · "SERVER"    → starter-style server app. Sets
 *                    COOLIFY_SERVER_RESOURCE_UUID +
 *                    COOLIFY_SERVER_DEPLOY_WEBHOOK.
 *    · "CLIENT"    → starter-style client app. Sets
 *                    COOLIFY_CLIENT_RESOURCE_UUID +
 *                    COOLIFY_CLIENT_DEPLOY_WEBHOOK. */
export interface CoolifyDeployApp {
  label?: "SERVER" | "CLIENT";
  /** Coolify application uuid. */
  uuid: string;
}

export interface CoolifyDeploySecretsInput {
  /** Working directory that has `.git` + `gh` access. */
  projectDir: string;
  /** GitHub `<owner>/<repo>` slug. */
  repoSlug: string;
  /** One or more apps to wire deploy hooks for. Pass a single
   *  unlabelled entry for adopt-style single-app repos; pass two
   *  labelled entries (SERVER + CLIENT) for the split layout the
   *  starter ships. */
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
  //   Always set the starter's API-style triple — once those are in
  //   place the workflow uses the per-resource uuid + bearer token to
  //   call Coolify directly, which is more robust than webhooks.
  //   Per-app webhook URLs are still set as a fallback.
  const baseUrl = cfg.url.replace(/\/$/, "");
  const secrets: Record<string, string> = {
    COOLIFY_BASE_URL: baseUrl,
    COOLIFY_API_TOKEN: cfg.token,
    // Alias kept for adopt's simpler `deploy.yml` template.
    COOLIFY_TOKEN: cfg.token,
  };

  for (const app of input.apps) {
    const webhook = `${baseUrl}/api/v1/deploy?uuid=${app.uuid}`;
    if (app.label === undefined) {
      // Single-app convention (adopt's template).
      secrets.COOLIFY_WEBHOOK_URL = webhook;
      secrets.COOLIFY_RESOURCE_UUID = app.uuid;
    } else {
      // Split server/client convention (starter's template).
      secrets[`COOLIFY_${app.label}_RESOURCE_UUID`] = app.uuid;
      secrets[`COOLIFY_${app.label}_DEPLOY_WEBHOOK`] = webhook;
    }
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
