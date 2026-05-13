import chalk from "chalk";
import {
  ensureDns,
  ensureGoogleSearchConsole,
  refreshGoogleSearchConsoleAccessToken,
} from "../config.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";

interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export interface SearchConsoleProvisionResult {
  domain: string;
  siteUrl: string;
  webResourceId?: string;
  dnsRecord?: {
    id: string;
    zoneId: string;
    name: string;
    type: "TXT";
    created: boolean;
    updated: boolean;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeSearchConsoleDomain(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Domain is empty.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (!url.hostname) throw new Error(`Could not parse domain from ${input}.`);
  return url.hostname.replace(/\.$/, "").toLowerCase();
}

function searchConsoleSiteUrl(domain: string): string {
  return `sc-domain:${domain}`;
}

async function googleJson<T>(
  method: string,
  url: string,
  accessToken: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as GoogleApiError & T) : (undefined as T);
  if (!res.ok) {
    const msg =
      (json as GoogleApiError | undefined)?.error?.message ??
      text ??
      `${method} ${url} failed with HTTP ${res.status}`;
    throw new Error(`Google API HTTP ${res.status}: ${msg}`);
  }
  return json as T;
}

async function getVerificationToken(
  accessToken: string,
  domain: string,
): Promise<{ method: string; token: string }> {
  return googleJson("POST", "https://www.googleapis.com/siteVerification/v1/token", accessToken, {
    site: { type: "INET_DOMAIN", identifier: domain },
    verificationMethod: "DNS_TXT",
  });
}

async function verifyWebResource(accessToken: string, domain: string): Promise<{ id?: string }> {
  return googleJson(
    "POST",
    "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=DNS_TXT",
    accessToken,
    { site: { type: "INET_DOMAIN", identifier: domain } },
  );
}

async function addSearchConsoleProperty(accessToken: string, siteUrl: string): Promise<void> {
  await googleJson(
    "PUT",
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`,
    accessToken,
  );
}

async function deleteSearchConsoleProperty(
  accessToken: string,
  siteUrl: string,
): Promise<"deleted" | "not-found"> {
  try {
    await googleJson(
      "DELETE",
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`,
      accessToken,
    );
    return "deleted";
  } catch (err) {
    if (/HTTP 404/i.test((err as Error).message)) return "not-found";
    throw err;
  }
}

async function findCloudflareZone(
  cf: CloudflareApi,
  domain: string,
): Promise<{ id: string; name: string }> {
  const zones = await cf.listZones();
  const zone = zones
    .filter((z) => domain === z.name || domain.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) {
    throw new Error(
      `No Cloudflare zone found for ${domain}. Search Console DNS verification needs a zone this token can edit.`,
    );
  }
  return { id: zone.id, name: zone.name };
}

export async function provisionSearchConsoleForDomain(
  domainInput: string,
): Promise<SearchConsoleProvisionResult> {
  const domain = normalizeSearchConsoleDomain(domainInput);
  const siteUrl = searchConsoleSiteUrl(domain);
  const googleCfg = await ensureGoogleSearchConsole();
  const dnsCfg = await ensureDns();
  if (!dnsCfg.apiToken) {
    throw new Error("Cloudflare API token not configured. Run `hatchkit config add dns`.");
  }

  const accessToken = await refreshGoogleSearchConsoleAccessToken(googleCfg);
  const token = await getVerificationToken(accessToken, domain);
  if (token.method !== "DNS_TXT" || !token.token) {
    throw new Error("Google did not return a DNS_TXT verification token.");
  }

  const cf = new CloudflareApi({ token: dnsCfg.apiToken, accountId: dnsCfg.accountId });
  const zone = await findCloudflareZone(cf, domain);
  const dnsRecord = await cf.upsertRecord(zone.id, {
    type: "TXT",
    name: domain,
    content: token.token,
    ttl: 1,
  });

  let verified: { id?: string } | null = null;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      verified = await verifyWebResource(accessToken, domain);
      lastError = null;
      break;
    } catch (err) {
      lastError = err as Error;
      if (attempt < 6) await sleep(5000);
    }
  }
  if (lastError) {
    throw new Error(
      `Google could not verify ${domain} after adding the DNS TXT record. ` +
        `DNS may still be propagating; re-run \`hatchkit add <project> search-console\` in a few minutes. ` +
        `Last error: ${lastError.message}`,
    );
  }

  await addSearchConsoleProperty(accessToken, siteUrl);
  console.log(
    chalk.green(
      `  ✓ Search Console: verified ${domain} and added ${chalk.cyan(siteUrl)} to the account`,
    ),
  );

  return {
    domain,
    siteUrl,
    webResourceId: verified?.id,
    dnsRecord: {
      id: dnsRecord.id,
      zoneId: zone.id,
      name: domain,
      type: "TXT",
      created: dnsRecord.created,
      updated: dnsRecord.updated,
    },
  };
}

export async function unprovisionSearchConsoleForDomain(
  domainInput: string,
): Promise<"deleted" | "not-found"> {
  const domain = normalizeSearchConsoleDomain(domainInput);
  const siteUrl = searchConsoleSiteUrl(domain);
  const googleCfg = await ensureGoogleSearchConsole();
  const accessToken = await refreshGoogleSearchConsoleAccessToken(googleCfg);
  const result = await deleteSearchConsoleProperty(accessToken, siteUrl);
  if (result === "deleted") {
    console.log(chalk.green(`  ✓ Search Console: removed ${chalk.cyan(siteUrl)} from the account`));
  }
  return result;
}
