/*
 * Plausible provisioning — creates a site for a project domain through
 * the Plausible Sites API and caches the domain under the project name.
 *
 * Plausible's runtime integration is intentionally public: browser
 * bundles only need the tracked domain and script URL. The API key stays
 * in the OS keychain and is used only by hatchkit.
 */

import { ensurePlausible } from "../config.js";
import { SECRET_KEYS, deleteSecret, getSecret, setSecret } from "../utils/secrets.js";

export interface PlausibleSite {
  projectName: string;
  domain: string;
  baseUrl: string;
  scriptUrl: string;
  /** True only when this run created a remote Plausible site through the Sites API. */
  created: boolean;
  /** True when the Sites API is unavailable and Hatchkit can only write browser env. */
  manual: boolean;
}

export type DeleteResult = "deleted" | "not-found";

export class PlausibleSitesApiUnavailableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly status: number,
    detail?: string,
    /** Overrides the default "create the site manually" remedy with a
     *  caller-specific one (e.g. the rename path points at the dashboard
     *  rename instead). */
    action?: string,
  ) {
    super(
      `Plausible Sites API is not available at ${baseUrl} (HTTP ${status}). ` +
        "Plausible Community Edition/self-hosted does not include the Sites API, " +
        "and Plausible Cloud requires Sites API access. " +
        (action ??
          "Create/confirm the site manually in Plausible, or configure Hatchkit with a Sites API-capable Plausible account.") +
        (detail ? ` Response: ${detail}` : ""),
    );
    this.name = "PlausibleSitesApiUnavailableError";
  }
}

function siteDomainKey(projectName: string): string {
  return SECRET_KEYS.plausibleSiteDomain(projectName);
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function siteUrl(baseUrl: string, domain: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/v1/sites/${encodeURIComponent(domain)}`;
}

async function responseText(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

function isSitesApiUnavailableStatus(status: number): boolean {
  return status === 406;
}

function isCreateSitesApiUnavailableStatus(status: number): boolean {
  return status === 404 || isSitesApiUnavailableStatus(status);
}

/** Ask the Plausible Stats API whether a site exists on this instance,
 *  independent of the Sites provisioning API.
 *
 *  This is the disambiguator for self-hosted / Community Edition: CE
 *  serves the Stats API but NOT `/api/v1/sites/*`, so a site route that
 *  answers 404 or 406 there is a *missing API*, not a missing site —
 *  yet by status alone that is indistinguishable from Cloud's genuine
 *  "no such site" 404. The Stats API breaks the tie because CE still
 *  resolves the domain through it.
 *
 *  Returns `true` when the Stats API resolves the domain, `false` when a
 *  live Stats API reports the site is unknown (404), and `null` when the
 *  probe can't decide (auth failure, server or network error) so the
 *  caller keeps its status-based default. */
async function statsApiSeesSite(
  baseUrl: string,
  apiKey: string,
  domain: string,
): Promise<boolean | null> {
  const url =
    `${baseUrl.replace(/\/$/, "")}/api/v1/stats/aggregate` +
    `?site_id=${encodeURIComponent(domain)}&period=7d&metrics=visitors`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (res.ok) return true;
  if (res.status === 404) return false;
  return null;
}

function makeSite(
  projectName: string,
  domain: string,
  baseUrl: string,
  opts: { created: boolean; manual?: boolean },
): PlausibleSite {
  return {
    projectName,
    domain,
    baseUrl,
    scriptUrl: `${baseUrl}/js/script.js`,
    created: opts.created,
    manual: opts.manual ?? false,
  };
}

async function getSite(baseUrl: string, apiKey: string, domain: string): Promise<boolean> {
  const res = await fetch(siteUrl(baseUrl, domain), { headers: authHeaders(apiKey) });
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await responseText(res);
    if (isSitesApiUnavailableStatus(res.status)) {
      throw new PlausibleSitesApiUnavailableError(baseUrl, res.status, text);
    }
    throw new Error(
      `Plausible get site failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return true;
}

export async function plausibleSiteExists(domain: string): Promise<boolean> {
  const cfg = await ensurePlausible();
  return siteExists(cfg.url.replace(/\/$/, ""), cfg.apiKey, domain);
}

/** Core of {@link plausibleSiteExists}, split out for testing with an
 *  explicit base URL / key.
 *
 *  The Sites API is authoritative on Plausible Cloud (200 ⇒ exists, 404
 *  ⇒ absent), but on Community Edition it is absent: `getSite` sees a
 *  406 and throws {@link PlausibleSitesApiUnavailableError}, and some CE
 *  builds answer the item route with a 404 that `getSite` reports as a
 *  plain "not found". Either way the Sites API can't confirm existence
 *  on CE, so whenever it does not positively say "yes" we fall back to
 *  the Stats API — which CE does serve — instead of reporting a false
 *  negative. */
export async function siteExists(
  baseUrl: string,
  apiKey: string,
  domain: string,
): Promise<boolean> {
  const normalized = domain.trim().toLowerCase();
  try {
    if (await getSite(baseUrl, apiKey, normalized)) return true;
  } catch (err) {
    if (!(err instanceof PlausibleSitesApiUnavailableError)) throw err;
  }
  return (await statsApiSeesSite(baseUrl, apiKey, normalized)) === true;
}

export async function provisionPlausibleSite(
  projectName: string,
  domain: string,
): Promise<PlausibleSite> {
  const cfg = await ensurePlausible();
  const baseUrl = cfg.url.replace(/\/$/, "");
  const normalizedDomain = domain.trim().toLowerCase();

  const cachedDomain = await getSecret(siteDomainKey(projectName));
  if (cachedDomain) {
    let exists = false;
    try {
      exists = await getSite(baseUrl, cfg.apiKey, cachedDomain);
    } catch (err) {
      if (err instanceof PlausibleSitesApiUnavailableError) {
        return makeSite(projectName, cachedDomain, baseUrl, { created: false, manual: true });
      }
      throw err;
    }
    if (exists) {
      return makeSite(projectName, cachedDomain, baseUrl, { created: false });
    }
  }

  const body: Record<string, unknown> = {
    domain: normalizedDomain,
    timezone: cfg.timezone ?? "Etc/UTC",
    tracker_script_configuration: {
      outbound_links: true,
      file_downloads: true,
      form_submissions: true,
    },
  };
  if (cfg.teamId) body.team_id = cfg.teamId;

  const res = await fetch(`${baseUrl}/api/v1/sites`, {
    method: "POST",
    headers: authHeaders(cfg.apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await responseText(res);
    if (isCreateSitesApiUnavailableStatus(res.status)) {
      await setSecret(siteDomainKey(projectName), normalizedDomain);
      return makeSite(projectName, normalizedDomain, baseUrl, { created: false, manual: true });
    }
    const alreadyExists =
      res.status === 409 ||
      (res.status === 422 && /already|taken|exists/i.test(text)) ||
      (res.status === 400 && /already|taken|exists/i.test(text));
    if (!alreadyExists) {
      throw new Error(
        `Plausible create site failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
    let exists = false;
    try {
      exists = await getSite(baseUrl, cfg.apiKey, normalizedDomain);
    } catch (err) {
      if (err instanceof PlausibleSitesApiUnavailableError) {
        await setSecret(siteDomainKey(projectName), normalizedDomain);
        return makeSite(projectName, normalizedDomain, baseUrl, { created: false, manual: true });
      }
      throw err;
    }
    if (!exists) {
      throw new Error(
        `Plausible reports ${normalizedDomain} already exists, but it is not readable.`,
      );
    }
  }

  await setSecret(siteDomainKey(projectName), normalizedDomain);
  return makeSite(projectName, normalizedDomain, baseUrl, { created: res.ok });
}

export interface PlausibleRenameResult {
  oldDomain: string;
  newDomain: string;
  baseUrl: string;
}

/** Change a Plausible site's domain via the Sites API
 *  (`PUT /api/v1/sites/{old}` with `{ domain: new }`). Plausible
 *  preserves the site's stats history across the rename and keeps the
 *  old domain working as a redirect alias for a transition window, so
 *  this is the right tool when a deployed project moves to a new
 *  canonical hostname. The keychain domain cache is keyed by project
 *  name — callers that know the project should follow up with
 *  {@link updateCachedPlausibleDomain}. */
export async function renamePlausibleSite(
  oldDomain: string,
  newDomain: string,
): Promise<PlausibleRenameResult> {
  const cfg = await ensurePlausible();
  return renameSite(cfg.url.replace(/\/$/, ""), cfg.apiKey, oldDomain, newDomain);
}

/** Core of {@link renamePlausibleSite}, split out for testing with an
 *  explicit base URL / key. */
export async function renameSite(
  baseUrl: string,
  apiKey: string,
  oldDomain: string,
  newDomain: string,
): Promise<PlausibleRenameResult> {
  const from = oldDomain.trim().toLowerCase();
  const to = newDomain.trim().toLowerCase();
  if (!from || !to) throw new Error("Both the old and the new domain are required.");
  if (from === to) throw new Error("Old and new domain are identical — nothing to rename.");

  const res = await fetch(siteUrl(baseUrl, from), {
    method: "PUT",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ domain: to }),
  });
  if (res.ok) return { oldDomain: from, newDomain: to, baseUrl };

  const text = await responseText(res);

  // A 406 is an unambiguous "this route is not a JSON API here" — Cloud
  // never answers a missing site with 406, so this is always CE/self-
  // hosted without the Sites API.
  if (isSitesApiUnavailableStatus(res.status)) {
    throw new PlausibleSitesApiUnavailableError(
      baseUrl,
      res.status,
      text,
      renameElsewhereHint(from, to),
    );
  }

  // A 404 is ambiguous: Cloud returns it for a genuinely missing site,
  // while CE returns it because `/api/v1/sites/*` is not served at all.
  // The Stats API — which CE does serve — tells the two apart: if it can
  // still see the site, the site exists and only the Sites API is
  // missing, so surface the accurate CE guidance instead of the
  // misleading "no site for X".
  if (res.status === 404) {
    if ((await statsApiSeesSite(baseUrl, apiKey, from)) === true) {
      throw new PlausibleSitesApiUnavailableError(
        baseUrl,
        res.status,
        text,
        renameElsewhereHint(from, to),
      );
    }
    throw new Error(
      `Plausible has no site for "${from}" at ${baseUrl} — check the domain (or create the site first).`,
    );
  }

  throw new Error(
    `Plausible rename site failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
  );
}

function renameElsewhereHint(from: string, to: string): string {
  return (
    `This instance does not expose the Sites API, so "${from}" cannot be renamed programmatically. ` +
    `Rename it to "${to}" in the Plausible dashboard instead — stats history is preserved.`
  );
}

/** Point the per-project domain cache at the renamed site. Only
 *  rewrites the cache when it currently holds `oldDomain` — a project
 *  tracking some other domain is left alone. Returns true when the
 *  cache was updated. */
export async function updateCachedPlausibleDomain(
  projectName: string,
  oldDomain: string,
  newDomain: string,
): Promise<boolean> {
  const cached = await getSecret(siteDomainKey(projectName));
  if (cached !== oldDomain.trim().toLowerCase()) return false;
  await setSecret(siteDomainKey(projectName), newDomain.trim().toLowerCase());
  return true;
}

export async function deletePlausibleSite(projectName: string): Promise<DeleteResult> {
  const cfg = await ensurePlausible();
  const domain = (await getSecret(siteDomainKey(projectName))) ?? projectName;
  const res = await fetch(siteUrl(cfg.url, domain), {
    method: "DELETE",
    headers: authHeaders(cfg.apiKey),
  });

  await deleteSecret(siteDomainKey(projectName));

  if (res.status === 404 || isSitesApiUnavailableStatus(res.status)) return "not-found";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Plausible delete site failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return "deleted";
}
