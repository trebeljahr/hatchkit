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
  ) {
    super(
      `Plausible Sites API is not available at ${baseUrl}. ` +
        "Plausible Community Edition/self-hosted does not include the Sites API, " +
        "and Plausible Cloud requires Sites API access. " +
        "Create/confirm the site manually in Plausible, or configure Hatchkit with a Sites API-capable Plausible account." +
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
  const baseUrl = cfg.url.replace(/\/$/, "");
  try {
    return await getSite(baseUrl, cfg.apiKey, domain.trim().toLowerCase());
  } catch (err) {
    if (err instanceof PlausibleSitesApiUnavailableError) return false;
    throw err;
  }
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
