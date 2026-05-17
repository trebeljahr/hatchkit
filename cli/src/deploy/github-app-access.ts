/*
 * Grant a Coolify-installed GitHub App access to a specific repo.
 *
 * Background: Coolify clones private repos through a GitHub App source.
 * When the App is installed against "Selected repositories" (the usual
 * default — "All repositories" is a power-user choice), a brand-new
 * repo created via `gh repo create --private` is NOT on the App's
 * selected list. Coolify's POST /applications/private-github-app then
 * 404s with "Repository not found or not accessible by the GitHub App."
 *
 * This module tries to add the new repo to the App's selected-repos
 * list programmatically, using the user's `gh` CLI token. If that
 * fails (org install with insufficient permissions, missing scopes,
 * App not installed at all, …) the caller falls back to a manual
 * prompt with the App's install URL.
 *
 * Endpoints used (all via `gh api`):
 *   · GET  /user/installations
 *   · GET  /repos/{owner}/{repo}
 *   · PUT  /user/installations/{installation_id}/repositories/{repository_id}
 */

import { exec } from "../utils/exec.js";

export interface GrantInput {
  /** Coolify GitHub source's `html_url`, e.g.
   *  `https://github.com/apps/trebeljahr-coolify`. The App slug is
   *  parsed from the URL — Coolify's /github-apps response doesn't
   *  expose it as a standalone field. */
  appHtmlUrl: string | undefined;
  /** `<owner>/<repo>` slug. */
  repoSlug: string;
}

export type GrantResult =
  | {
      kind: "granted";
      appSlug: string;
      installationId: number;
      account: string;
    }
  | {
      kind: "already-all-repos";
      appSlug: string;
      installationId: number;
      account: string;
    }
  | {
      kind: "already-selected";
      appSlug: string;
      installationId: number;
      account: string;
    }
  | {
      kind: "failed";
      reason: string;
      appSlug?: string;
      installUrl: string;
      /** Settings URL for an existing installation — surfaced so the
       *  retry prompt can point users at the "Configure repositories"
       *  screen rather than the install-target picker. Undefined when
       *  we never resolved an installation_id. */
      installSettingsUrl?: string;
    };

interface InstallationInfo {
  id: number;
  account: { login: string; type?: string };
  app_slug: string;
  target_type: string;
  repository_selection: "all" | "selected";
}

/** Parse the App slug from a GitHub App html_url. Accepts the
 *  canonical `https://github.com/apps/<slug>` shape; returns
 *  `undefined` for anything else (Coolify's older `api_url` shape
 *  doesn't carry the slug). */
export function appSlugFromHtmlUrl(htmlUrl: string | undefined): string | undefined {
  if (!htmlUrl) return undefined;
  try {
    const u = new URL(htmlUrl);
    if (u.hostname !== "github.com") return undefined;
    const m = u.pathname.match(/^\/apps\/([^/]+)\/?$/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Default install URL — used when we have the App slug but no
 *  installation_id (App never installed, gh missing, etc.). Sends the
 *  user to GitHub's install-target picker. */
export function installUrlForSlug(slug: string): string {
  return `https://github.com/apps/${slug}/installations/select_target`;
}

/** Existing-installation settings URL — points at the configure-
 *  repositories screen for a specific install. */
export function installSettingsUrl(info: {
  account: string;
  type?: string;
  installationId: number;
}): string {
  // Org installations live under /organizations/<org>/settings/...,
  // user installations under /settings/installations/<id>. GitHub
  // redirects either way, but the org URL avoids an extra hop.
  return info.type === "Organization"
    ? `https://github.com/organizations/${info.account}/settings/installations/${info.installationId}`
    : `https://github.com/settings/installations/${info.installationId}`;
}

async function ghApi(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await exec("gh", ["api", ...args], { silent: true });
  return { ok: r.exitCode === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** List GitHub App installations visible to the authenticated user.
 *  Returns [] on any failure (gh missing, not logged in, scope error)
 *  — callers downgrade to manual flow rather than blowing up. */
export async function listUserInstallations(): Promise<InstallationInfo[]> {
  const r = await ghApi([
    "--paginate",
    "/user/installations",
    "--jq",
    ".installations[] | {id, account: {login: .account.login, type: .account.type}, app_slug, target_type, repository_selection}",
  ]);
  if (!r.ok) return [];
  // --jq with paginate emits one JSON object per line.
  const out: InstallationInfo[] = [];
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as InstallationInfo);
    } catch {
      // Tolerate stray lines (eg gh prints a warning before the JSON
      // when the token's about to expire); other entries still count.
    }
  }
  return out;
}

async function resolveRepoId(repoSlug: string): Promise<number | undefined> {
  const r = await ghApi([`/repos/${repoSlug}`, "--jq", ".id"]);
  if (!r.ok) return undefined;
  const n = Number(r.stdout);
  return Number.isFinite(n) ? n : undefined;
}

async function putRepoOnInstallation(
  installationId: number,
  repoId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const r = await ghApi([
    "--method",
    "PUT",
    `/user/installations/${installationId}/repositories/${repoId}`,
  ]);
  if (r.ok) return { ok: true };
  return { ok: false, reason: r.stderr || r.stdout || `PUT failed (exit non-zero)` };
}

/** Best-effort: ensure the Coolify GitHub App can see `repoSlug`. See
 *  module header for the full rationale. */
export async function ensureCoolifyAppHasRepoAccess(input: GrantInput): Promise<GrantResult> {
  const appSlug = appSlugFromHtmlUrl(input.appHtmlUrl);
  if (!appSlug) {
    // No App slug → we can't even guess the install URL. Best we can
    // do is point users at github.com/settings/installations so they
    // can find the App manually.
    return {
      kind: "failed",
      reason:
        "Coolify GitHub source has no html_url — can't find the matching GitHub App installation.",
      installUrl: "https://github.com/settings/installations",
    };
  }

  const installs = await listUserInstallations();
  const match = installs.find((i) => i.app_slug === appSlug);

  if (!match) {
    return {
      kind: "failed",
      reason: `GitHub App "${appSlug}" is not installed on any account/org you can see.`,
      appSlug,
      installUrl: installUrlForSlug(appSlug),
    };
  }

  const settingsUrl = installSettingsUrl({
    account: match.account.login,
    type: match.account.type,
    installationId: match.id,
  });

  if (match.repository_selection === "all") {
    return {
      kind: "already-all-repos",
      appSlug,
      installationId: match.id,
      account: match.account.login,
    };
  }

  const repoId = await resolveRepoId(input.repoSlug);
  if (!repoId) {
    return {
      kind: "failed",
      reason: `Couldn't resolve numeric repo id for ${input.repoSlug} via gh api.`,
      appSlug,
      installUrl: installUrlForSlug(appSlug),
      installSettingsUrl: settingsUrl,
    };
  }

  const put = await putRepoOnInstallation(match.id, repoId);
  if (!put.ok) {
    return {
      kind: "failed",
      reason: put.reason ?? "PUT /user/installations/.../repositories failed.",
      appSlug,
      installUrl: installUrlForSlug(appSlug),
      installSettingsUrl: settingsUrl,
    };
  }

  return {
    kind: "granted",
    appSlug,
    installationId: match.id,
    account: match.account.login,
  };
}
