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
}

export type DeleteResult = "deleted" | "not-found";

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

async function getSite(baseUrl: string, apiKey: string, domain: string): Promise<boolean> {
  const res = await fetch(siteUrl(baseUrl, domain), { headers: authHeaders(apiKey) });
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Plausible get site failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return true;
}

export async function plausibleSiteExists(domain: string): Promise<boolean> {
  const cfg = await ensurePlausible();
  const baseUrl = cfg.url.replace(/\/$/, "");
  return getSite(baseUrl, cfg.apiKey, domain.trim().toLowerCase());
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
    const exists = await getSite(baseUrl, cfg.apiKey, cachedDomain);
    if (exists) {
      return {
        projectName,
        domain: cachedDomain,
        baseUrl,
        scriptUrl: `${baseUrl}/js/script.js`,
      };
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
    const text = await res.text().catch(() => "");
    const alreadyExists =
      res.status === 409 ||
      (res.status === 422 && /already|taken|exists/i.test(text)) ||
      (res.status === 400 && /already|taken|exists/i.test(text));
    if (!alreadyExists) {
      throw new Error(
        `Plausible create site failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
    const exists = await getSite(baseUrl, cfg.apiKey, normalizedDomain);
    if (!exists) {
      throw new Error(
        `Plausible reports ${normalizedDomain} already exists, but it is not readable.`,
      );
    }
  }

  await setSecret(siteDomainKey(projectName), normalizedDomain);
  return {
    projectName,
    domain: normalizedDomain,
    baseUrl,
    scriptUrl: `${baseUrl}/js/script.js`,
  };
}

export async function deletePlausibleSite(projectName: string): Promise<DeleteResult> {
  const cfg = await ensurePlausible();
  const domain = (await getSecret(siteDomainKey(projectName))) ?? projectName;
  const res = await fetch(siteUrl(cfg.url, domain), {
    method: "DELETE",
    headers: authHeaders(cfg.apiKey),
  });

  await deleteSecret(siteDomainKey(projectName));

  if (res.status === 404) return "not-found";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Plausible delete site failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return "deleted";
}
