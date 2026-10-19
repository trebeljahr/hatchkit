/*
 * Cloudflare Access in front of Coolify's hostname.
 *
 * Since 2026-10-19 coolify.trebeljahr.com sits behind a Cloudflare Access
 * application: only Rico's address gets past a sign-in (email code), so
 * Coolify's login page, API and websockets are invisible to everyone else.
 * The origin accepts only Cloudflare's IP ranges, so Access cannot be
 * walked around via the server's IP. Three narrower Access applications
 * bypass the sign-in:
 *
 *   <host>/webhooks/source/github/events  CI deploys (signed per app)
 *   <host>/api/v1/sentinel/push           Sentinel on other servers
 *   <host>/api/v1                         TEMPORARY, until hatchkit sends
 *                                         a service token (this module)
 *
 * The GitLab/Bitbucket/Gitea webhook handlers stay behind Access on
 * purpose: their null-secret bypass (GHSA-w8wm-r924-f65v) is the class of
 * bug the sign-in keeps away from the internet.
 *
 * `hatchkit coolify access` gives this machine a service token: it creates
 * one with the Cloudflare operator token, stores id and secret in the
 * keychain without printing them, adds a Service Auth policy to the main
 * application, and checks a protected path. `--close-api-bypass` then
 * deletes the temporary /api/v1 bypass (and puts it back if the API stops
 * answering). From then on every CoolifyApi call carries
 * CF-Access-Client-Id/-Secret (utils/coolify-api.ts).
 */

import chalk from "chalk";
import { getCloudflareProvisioner, getCoolifyConfig } from "../config.js";
import { accessHeaders, isAccessSignIn, registerCoolifyAccess } from "../utils/coolify-api.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

export const COOLIFY_ACCESS_USAGE = `Usage:
  hatchkit coolify access [--dry-run] [--rotate] [--close-api-bypass]

Gives hatchkit a Cloudflare Access service token for Coolify's hostname
(stored in the keychain, never printed) and adds a Service Auth policy to
the Access application. --close-api-bypass then deletes the temporary
/api/v1 bypass once the token works. --rotate replaces an existing token.
Needs the Cloudflare operator token with Access: Apps and Policies Edit and
Access: Service Tokens Edit.`;

export interface AccessApp {
  id: string;
  name: string;
  domain: string;
}

/** The Access applications for Coolify at `host`, by exact domain. */
export function findCoolifyAccessApps(apps: AccessApp[], host: string) {
  const by = (domain: string) => apps.find((a) => a.domain.toLowerCase() === domain);
  const h = host.toLowerCase();
  return {
    main: by(h),
    apiBypass: by(`${h}/api/v1`),
    sentinelBypass: by(`${h}/api/v1/sentinel/push`),
    webhookBypass: by(`${h}/webhooks/source/github/events`),
  };
}

export function serviceTokenPolicy(tokenId: string) {
  return {
    name: "Service Auth: hatchkit CLI",
    decision: "non_identity",
    include: [{ service_token: { token_id: tokenId } }],
    precedence: 2,
  };
}

type Cf = <T>(method: string, path: string, body?: unknown) => Promise<T>;

function cloudflare(token: string): Cf {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: Array<{ code: number; message: string }>;
    };
    if (!res.ok || json.success === false) {
      const msg = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
      const hint =
        res.status === 403 || /\b(10000|9109)\b/.test(msg)
          ? " — give hatchkit's Cloudflare operator token Account → Access: Apps and Policies → Edit and Access: Service Tokens → Edit"
          : "";
      throw new Error(
        `Cloudflare ${method} ${path}: HTTP ${res.status}${msg ? ` ${msg}` : ""}${hint}`,
      );
    }
    return json.result as T;
  };
}

/** GET a path behind Access with the service token; true when Coolify (not
 *  the Access sign-in) answered. Retries while the policy propagates. */
async function reachesCoolify(
  url: string,
  path: string,
  bearer?: string,
  tries = 10,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}${path}`, {
        headers: accessHeaders(url, bearer ? { Authorization: `Bearer ${bearer}` } : undefined),
        signal: AbortSignal.timeout(10_000),
      });
      if (!isAccessSignIn(res) && res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export async function runCoolifyAccess(args: string[]): Promise<boolean> {
  const dryRun = args.includes("--dry-run");
  const rotate = args.includes("--rotate");
  const closeBypass = args.includes("--close-api-bypass");

  const coolify = await getCoolifyConfig();
  if (!coolify)
    throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  const url = coolify.url.replace(/\/$/, "");
  const host = new URL(url).hostname;
  const prov = await getCloudflareProvisioner();
  if (!prov) throw new Error("No Cloudflare operator token — `hatchkit config add cloudflare`.");
  const cf = cloudflare(prov.token);
  const acct = prov.accountId;

  const apps = (await cf<AccessApp[] | null>("GET", `/accounts/${acct}/access/apps`)) ?? [];
  const found = findCoolifyAccessApps(apps, host);
  if (!found.main) {
    // Cloudflare filters this list by the token's permissions instead of
    // refusing: a token without Access permissions sees an empty list.
    console.log(
      chalk.yellow(
        `  No Cloudflare Access application for ${host} among the ${apps.length} the operator token can see (account ${acct}).`,
      ),
    );
    if (apps.length === 0) {
      console.log(
        chalk.dim(
          "    A token without Access permissions sees none. Add to hatchkit's operator token at\n" +
            "    https://dash.cloudflare.com/profile/api-tokens: Account · Access: Apps and Policies · Edit\n" +
            "    and Account · Access: Service Tokens · Edit, then re-run.",
        ),
      );
    }
    return false;
  }
  console.log(chalk.dim(`  Access application: ${found.main.name} (${host})`));
  for (const [label, app] of [
    ["GitHub webhooks bypass", found.webhookBypass],
    ["Sentinel push bypass", found.sentinelBypass],
    ["API bypass (temporary)", found.apiBypass],
  ] as const) {
    console.log(chalk.dim(`  ${label}: ${app ? "present" : "absent"}`));
  }

  const [haveId, haveSecret] = await Promise.all([
    getSecret(SECRET_KEYS.coolifyAccessClientId),
    getSecret(SECRET_KEYS.coolifyAccessClientSecret),
  ]);
  const haveToken = Boolean(haveId && haveSecret) && !rotate;

  if (dryRun) {
    console.log(
      chalk.dim(
        haveToken
          ? "  would check the stored service token against a protected path"
          : `  would create service token "hatchkit-cli ${host}" (1 year), store it in the keychain and add a Service Auth policy`,
      ),
    );
    if (closeBypass && found.apiBypass)
      console.log(chalk.dim("  would delete the temporary /api/v1 bypass once the token works"));
    console.log(chalk.dim("\n  --dry-run: nothing written."));
    return true;
  }

  if (!haveToken) {
    const token = await cf<{ id: string; client_id: string; client_secret: string }>(
      "POST",
      `/accounts/${acct}/access/service_tokens`,
      { name: `hatchkit-cli ${host}`, duration: "8760h" },
    );
    await setSecret(SECRET_KEYS.coolifyAccessClientId, token.client_id);
    await setSecret(SECRET_KEYS.coolifyAccessClientSecret, token.client_secret);
    registerCoolifyAccess(url, { clientId: token.client_id, clientSecret: token.client_secret });
    const policies = await cf<Array<{ include?: unknown[] }>>(
      "GET",
      `/accounts/${acct}/access/apps/${found.main.id}/policies`,
    );
    if (!JSON.stringify(policies).includes(token.id)) {
      await cf(
        "POST",
        `/accounts/${acct}/access/apps/${found.main.id}/policies`,
        serviceTokenPolicy(token.id),
      );
    }
    console.log(
      chalk.green(`  ✓ service token "hatchkit-cli ${host}" stored in the keychain (not printed)`),
    );
  }

  // /api/health sits behind the main application, so it proves the token.
  if (!(await reachesCoolify(url, "/api/health"))) {
    console.log(chalk.red(`  ✗ ${host}/api/health still answers with the Access sign-in.`));
    console.log(
      chalk.dim("    Check the Service Auth policy on the Access application, then re-run."),
    );
    return false;
  }
  console.log(chalk.green(`  ✓ the service token gets through Access (${host}/api/health)`));

  if (!closeBypass || !found.apiBypass) return true;
  const bypass = found.apiBypass;
  await cf("DELETE", `/accounts/${acct}/access/apps/${bypass.id}`);
  if (await reachesCoolify(url, "/api/v1/version", coolify.token)) {
    console.log(chalk.green(`  ✓ deleted the temporary bypass; the API answers through Access`));
    return true;
  }
  // Put it back rather than leave hatchkit locked out.
  const again = await cf<{ id: string }>("POST", `/accounts/${acct}/access/apps`, {
    name: bypass.name,
    type: "self_hosted",
    domain: bypass.domain,
    session_duration: "24h",
    app_launcher_visible: false,
  });
  await cf("POST", `/accounts/${acct}/access/apps/${again.id}/policies`, {
    name: "Bypass: everyone",
    decision: "bypass",
    include: [{ everyone: {} }],
    precedence: 1,
  });
  console.log(chalk.red("  ✗ the API did not answer through Access; the /api/v1 bypass is back."));
  return false;
}
