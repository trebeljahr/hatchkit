/*
 * Wire an existing project into the user's already-configured
 * Coolify + DNS setup, without scaffolding new infra.
 *
 * Used by `hatchkit adopt` (and reusable from elsewhere). The
 * difference from the create-flow `runCoolifySetup`:
 *   · `runCoolifySetup` runs a shell script that lives in the
 *     hatchkit monorepo's infra/ submodule. It generates Terraform
 *     tfvars, runs `terraform apply` for new servers + DNS, then
 *     calls a stack script. None of that is reachable when hatchkit
 *     is installed globally and run from a foreign project repo.
 *   · This module talks directly to the Coolify + Cloudflare REST
 *     APIs. No submodule, no shell scripts, no Terraform — just
 *     idempotent API calls against credentials hatchkit already has
 *     in keychain.
 *
 * Scope:
 *   · Coolify: find/create the project, find the server, create the
 *     application from a public or private GitHub repo, set the
 *     baseline env (DOTENV_PRIVATE_KEY_PRODUCTION, GITHUB_REPO_URL),
 *     trigger a deploy.
 *   · DNS: upsert a single A record for the bare domain pointing at
 *     the Coolify server's IP. Cloudflare-only for now (the only DNS
 *     provider whose record CRUD is wired up today). INWX users get
 *     a clear "add an A record yourself" hint.
 */

import { resolve4, resolve6 } from "node:dns/promises";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig, getDnsConfig } from "../config.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import type { ApplicationCreateInput } from "../utils/coolify-api.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";
import type { CoolifyDeployApp } from "./gh-actions-secrets.js";

export interface WireUpInput {
  projectName: string;
  domain: string;
  /** GitHub repo URL — `https://github.com/owner/repo`. */
  gitRepository: string;
  /** Default `main`. */
  gitBranch?: string;
  /** Container port the app listens on. Default `3000`. */
  portsExposes?: string;
  /** Coolify build pack. `nixpacks` for typical Node servers,
   *  `static` for SPAs / static sites without a runtime, `dockerfile`
   *  / `dockercompose` when the project ships its own. Default
   *  `nixpacks`. */
  buildPack?: "nixpacks" | "static" | "dockerfile" | "dockercompose";
  /** Treat the repo as private. When true, hatchkit picks (or asks
   *  for) a Coolify GitHub App uuid. */
  isPrivate?: boolean;
  /** When the user has already chosen one previously, skip the picker. */
  githubAppUuid?: string;
}

export interface WireUpResult {
  /** Coolify application uuid. */
  appUuid: string;
  /** Coolify project uuid (existing or freshly created). */
  projectUuid: string;
  /** Coolify server uuid the app runs on. */
  serverUuid: string;
  /** Public IPv4 (preferred from Coolify, falling back to DNS). */
  serverIpv4?: string;
  /** Public IPv6 — only set when Coolify exposes one and we wrote
   *  an AAAA record. */
  serverIpv6?: string;
  /** Whether the IPv4 reported by Coolify and the one resolved via
   *  DNS for the dashboard hostname disagree. Useful to flag
   *  misconfigured proxy / floating-IP setups. */
  ipMismatchWarning?: string;
  /** Cloudflare DNS record id for the A record, if managed. */
  dnsRecordId?: string;
  /** Cloudflare DNS record id for the AAAA record, if managed. */
  dnsRecordIdV6?: string;
  /** True when at least one DNS record (A or AAAA) was upserted. */
  dnsManaged: boolean;
}

/** Top-level wire-up. Throws on the first hard failure (no project,
 *  no server, app create rejected). The DNS step is best-effort —
 *  failures there log a hint and return without setting `dnsManaged`. */
export async function wireProjectIntoCoolify(input: WireUpInput): Promise<WireUpResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  // ── 1. Resolve / create the Coolify project ─────────────────────────
  const findOrCreateProject = ora(`Coolify: locating project "${input.projectName}"`).start();
  let projectUuid: string;
  try {
    const existing = await api.findProjectByName(input.projectName);
    if (existing) {
      projectUuid = existing.uuid;
      findOrCreateProject.succeed(`Coolify project: ${input.projectName} (existing)`);
    } else {
      // Coolify's `description` field is validated against a narrow
      // character class (letters/numbers/spaces and a small set of
      // punctuation — see /api/v1 OpenAPI). Notably no `:`, so a
      // URL won't pass. Keep the description plain prose; the GitHub
      // repo URL ends up on the application itself anyway.
      const created = await api.createProject(input.projectName, "Adopted by hatchkit");
      projectUuid = created.uuid;
      findOrCreateProject.succeed(`Coolify project: ${input.projectName} (created)`);
    }
  } catch (err) {
    findOrCreateProject.fail();
    throw err;
  }

  // ── 2. Resolve the server (single = pick automatically; many = error
  //       and ask the user to install a single-server hatchkit config). ─
  const servers = await api.listServers();
  if (servers.length === 0) {
    throw new Error(
      "No Coolify servers configured. Add one in the Coolify dashboard before adopting.",
    );
  }
  const server = servers[0];
  if (servers.length > 1) {
    console.log(
      chalk.yellow(
        `  Multiple Coolify servers found — defaulting to "${server.name}" (${server.ip}).` +
          " Edit the app's server in the dashboard if that's wrong.",
      ),
    );
  }
  const resolveServer = await api.findServer({ ip: server.ip });
  if (!resolveServer) {
    throw new Error(`Couldn't resolve uuid for server "${server.name}" (${server.ip}).`);
  }

  // ── 3. Resolve a GitHub source for private repos ───────────────────
  let githubAppUuid: string | undefined = input.githubAppUuid;
  if (input.isPrivate && !githubAppUuid) {
    const sources = await api.listGithubSources();
    if (sources.length === 1) {
      githubAppUuid = sources[0].uuid;
      console.log(chalk.dim(`  Using Coolify GitHub source "${sources[0].name}".`));
    } else if (sources.length === 0) {
      throw new Error(
        "Repo is private but no Coolify GitHub source is configured. Add one in the Coolify dashboard\n" +
          "  (Settings → Sources → GitHub Apps), then re-run.",
      );
    } else {
      const { select } = await import("@inquirer/prompts");
      githubAppUuid = await select({
        message: "Pick the Coolify GitHub source for this repo:",
        choices: sources.map((s) => ({
          name: `${s.name}${s.html_url ? `  ${chalk.dim(s.html_url)}` : ""}`,
          value: s.uuid,
        })),
      });
    }
  }

  // ── 4. Create the app — or reuse an existing one with the same
  //       name. Coolify doesn't enforce name uniqueness, but creating
  //       a duplicate on every `--resume` is loud and confusing. ───
  let appUuid: string;
  const existingApp = await api.findApplicationByName(input.projectName);
  if (existingApp) {
    console.log(
      chalk.dim(
        `  · Coolify app "${input.projectName}" already exists (${existingApp.uuid}) — skipping create, will update env + DNS.`,
      ),
    );
    appUuid = existingApp.uuid;
  } else {
    const baseInput: ApplicationCreateInput = {
      projectUuid,
      serverUuid: resolveServer.uuid,
      gitRepository: input.gitRepository,
      gitBranch: input.gitBranch ?? "main",
      portsExposes: input.portsExposes ?? "3000",
      // hatchkit's canonical pipeline = GitHub Actions builds image →
      // pushes to GHCR → Coolify pulls via docker-compose.yml. Caller
      // can still override (e.g. for legacy nixpacks paths) but
      // `dockercompose` is the default for any project that's gone
      // through `hatchkit adopt`'s build-pipeline scaffold.
      buildPack: input.buildPack ?? "dockercompose",
      name: input.projectName,
      description: "Adopted by hatchkit",
      domains: [`https://${input.domain}`],
      instantDeploy: false,
    };

    const createApp = ora(`Coolify: creating app for ${input.gitRepository}`).start();
    try {
      const res = input.isPrivate
        ? await api.createApplicationFromPrivateGithubApp({
            ...baseInput,
            githubAppUuid: githubAppUuid as string,
          })
        : await api.createApplicationFromPublicRepo(baseInput);
      appUuid = res.uuid;
      createApp.succeed(`Coolify app created (uuid: ${appUuid})`);
    } catch (err) {
      createApp.fail();
      throw err;
    }
  }

  // ── 5. Set the bare-minimum env vars on the app: the dotenvx
  //       private key (so prod can decrypt .env.production) and
  //       GITHUB_REPO_URL (used by the starter for self-reference). ─
  const dotenvKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey(input.projectName));
  if (dotenvKey) {
    const setEnv = ora("Coolify: pushing baseline env (dotenvx key + repo URL)").start();
    try {
      await api.setAppEnv(appUuid, {
        DOTENV_PRIVATE_KEY_PRODUCTION: dotenvKey,
        GITHUB_REPO_URL: input.gitRepository,
      });
      setEnv.succeed("Coolify: baseline env set");
    } catch (err) {
      setEnv.fail("Coolify: couldn't set baseline env");
      console.log(
        chalk.yellow(
          `  ${(err as Error).message} — set DOTENV_PRIVATE_KEY_PRODUCTION manually in the dashboard.`,
        ),
      );
    }
  } else {
    console.log(
      chalk.yellow(
        "  No dotenvx private key in the keychain — skipping env push.\n" +
          "  Run `hatchkit keys push <project>` once one's available.",
      ),
    );
  }

  // ── 6. DNS — discover the box's public IP(s) and upsert records. ─
  //
  // Discovery order:
  //   1. Coolify's `/servers/{uuid}/domains` exposes the configured
  //      `public_ipv4` and `public_ipv6` for localhost-Coolify
  //      installs (where /servers reports "host.docker.internal").
  //   2. Independently resolve the Coolify dashboard URL's hostname
  //      via dns.resolve4 + dns.resolve6 — that hostname IS public
  //      (we're talking to it from the internet) so its A / AAAA
  //      records are by definition the right pointers for new app
  //      domains too.
  // We use Coolify's value as primary, fall back to DNS resolution,
  // and surface a warning when the two disagree (catches stale or
  // misconfigured public_ipv4 / proxy setups).
  const ips = await discoverPublicIps(api, resolveServer.uuid, server.ip, cfg.url);
  const dnsResult = await wireDns(input.domain, ips);

  // ── 7. Trigger first deploy. ───────────────────────────────────────
  const deploy = ora("Coolify: triggering first deploy").start();
  try {
    await api.deployApplication(appUuid);
    deploy.succeed("Coolify: deploy triggered");
  } catch (err) {
    deploy.fail("Coolify: couldn't auto-trigger the deploy");
    console.log(
      chalk.dim(
        `  Click "Deploy" in the Coolify dashboard — the app exists, just isn't running yet.`,
      ),
    );
  }

  return {
    appUuid,
    projectUuid,
    serverUuid: resolveServer.uuid,
    serverIpv4: ips.v4,
    serverIpv6: ips.v6,
    ipMismatchWarning: ips.mismatchWarning,
    dnsRecordId: dnsResult.recordIdV4,
    dnsRecordIdV6: dnsResult.recordIdV6,
    dnsManaged: dnsResult.managed,
  };
}

/** True for valid public-routable IPv4 strings. Filters out the
 *  values Coolify hands back on Docker installs (`host.docker.internal`,
 *  `localhost`, `127.0.0.1`) plus IPv6, which we don't auto-manage. */
function isPublicIpv4(s: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return false;
  const parts = s.split(".").map((n) => Number(n));
  if (parts.some((n) => n < 0 || n > 255)) return false;
  if (parts[0] === 127) return false; // loopback
  if (parts[0] === 0) return false;
  return true;
}

/** True for valid public-routable IPv6 strings. Filters loopback
 *  (::1) and link-local. Coarse — node:net.isIPv6 would be stricter
 *  but the obvious filters cover the practical cases. */
function isPublicIpv6(s: string): boolean {
  if (!/^[0-9a-fA-F:]+$/.test(s) || !s.includes(":")) return false;
  if (s === "::" || s === "::1") return false;
  if (s.toLowerCase().startsWith("fe80:")) return false; // link-local
  return true;
}

interface PublicIps {
  v4?: string;
  v6?: string;
  /** Set when Coolify's IPv4 and DNS-resolved IPv4 disagree — the user
   *  might have a stale public_ipv4 field, a misconfigured proxy, or
   *  a floating IP that's pointed elsewhere. We still proceed using
   *  Coolify's value (its self-reported truth), but flag it. */
  mismatchWarning?: string;
}

/** Resolve the box's public IPv4 + IPv6, preferring Coolify's
 *  configured values (via /servers/{uuid}/domains, which surfaces the
 *  instance's `public_ipv4` / `public_ipv6` for localhost-Coolify
 *  installs that report `host.docker.internal` on /servers), falling
 *  back to DNS resolution of the dashboard hostname. Cross-checks
 *  the two IPv4 sources and surfaces a warning when they disagree. */
async function discoverPublicIps(
  api: CoolifyApi,
  serverUuid: string,
  fallbackServerIp: string,
  dashboardUrl: string,
): Promise<PublicIps> {
  // Step 1: Coolify-reported IPs. /servers/{uuid}/domains returns
  // entries with `ip` set per running domain; for localhost-Coolify
  // this falls back to the configured public_ipv4 / public_ipv6.
  let coolifyV4: string | undefined;
  let coolifyV6: string | undefined;
  try {
    const domains = await api.getServerDomains(serverUuid);
    for (const d of domains) {
      const ip = (d.ip ?? "").trim();
      if (!coolifyV4 && isPublicIpv4(ip)) coolifyV4 = ip;
      if (!coolifyV6 && isPublicIpv6(ip)) coolifyV6 = ip;
    }
  } catch {
    // /servers/{uuid}/domains can 404 / 501 on older Coolify builds.
    // Treat as "Coolify doesn't know" and fall back to DNS only.
  }
  // /servers itself may return a real IPv4 on non-Docker installs —
  // use it as a last-resort source.
  if (!coolifyV4 && isPublicIpv4(fallbackServerIp)) coolifyV4 = fallbackServerIp;
  if (!coolifyV6 && isPublicIpv6(fallbackServerIp)) coolifyV6 = fallbackServerIp;

  // Step 2: independent DNS resolution of the dashboard hostname.
  let host: string | undefined;
  try {
    host = new URL(dashboardUrl).hostname;
  } catch {
    /* ignore — dashboard URL might be malformed */
  }
  let dnsV4: string | undefined;
  let dnsV6: string | undefined;
  if (host && !isPublicIpv4(host)) {
    const spinner = ora(`Resolving ${host} for cross-check`).start();
    try {
      const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      if (v4.status === "fulfilled" && v4.value[0] && isPublicIpv4(v4.value[0])) {
        dnsV4 = v4.value[0];
      }
      if (v6.status === "fulfilled" && v6.value[0] && isPublicIpv6(v6.value[0])) {
        dnsV6 = v6.value[0];
      }
      const parts = [dnsV4 && `A ${dnsV4}`, dnsV6 && `AAAA ${dnsV6}`].filter(Boolean);
      spinner.succeed(`DNS for ${host}: ${parts.length > 0 ? parts.join(", ") : "no records"}`);
    } catch {
      spinner.fail(`Couldn't resolve ${host}`);
    }
  } else if (host && isPublicIpv4(host)) {
    dnsV4 = host;
  }

  // Step 3: cross-check + decide. Prefer Coolify's value when we have
  // it (it's the box's self-reported truth); fall back to DNS.
  const v4 = coolifyV4 ?? dnsV4;
  const v6 = coolifyV6 ?? dnsV6;
  let mismatchWarning: string | undefined;
  if (coolifyV4 && dnsV4 && coolifyV4 !== dnsV4) {
    mismatchWarning = `Coolify reports public IPv4 ${coolifyV4} but ${host} resolves to ${dnsV4}. Using Coolify's value; double-check the DNS records and any floating-IP / proxy setup.`;
    console.log(chalk.yellow(`  ⚠ ${mismatchWarning}`));
  }
  return { v4, v6, mismatchWarning };
}

interface DnsWireResult {
  managed: boolean;
  recordIdV4?: string;
  recordIdV6?: string;
}

/** Upsert A and/or AAAA records for `domain` on Cloudflare. Either
 *  IP being undefined is fine — we only upsert what we've got, so a
 *  v6-only deploy gets just an AAAA record and v4-only gets just an A. */
async function wireDns(domain: string, ips: PublicIps): Promise<DnsWireResult> {
  if (!ips.v4 && !ips.v6) {
    console.log(
      chalk.yellow(
        "  Couldn't resolve a public IPv4 or IPv6 for the Coolify server.\n" +
          `  Add an A (and optionally AAAA) record for ${domain} manually pointing at\n` +
          "  the box's public IP, or fix the server's IP in the Coolify dashboard so\n" +
          "  /servers/{uuid}/domains returns it.",
      ),
    );
    return { managed: false };
  }
  const dns = await getDnsConfig();
  if (!dns) {
    console.log(
      chalk.yellow(
        "  No DNS provider configured. Add records yourself:\n" +
          (ips.v4 ? `    A    ${domain}  →  ${ips.v4}\n` : "") +
          (ips.v6 ? `    AAAA ${domain}  →  ${ips.v6}\n` : "") +
          "  Or run `hatchkit config add dns` and re-run.",
      ),
    );
    return { managed: false };
  }
  if (dns.provider !== "cloudflare") {
    console.log(
      chalk.yellow(
        `  DNS provider is ${dns.provider} — automatic record management isn't wired\n` +
          "  up for that provider yet. Add records manually:\n" +
          (ips.v4 ? `    A    ${domain}  →  ${ips.v4}\n` : "") +
          (ips.v6 ? `    AAAA ${domain}  →  ${ips.v6}\n` : ""),
      ),
    );
    return { managed: false };
  }
  if (!dns.apiToken) {
    console.log(
      chalk.yellow(
        "  Cloudflare token missing from keychain — re-run `hatchkit config add dns` to refresh.",
      ),
    );
    return { managed: false };
  }

  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
  const zoneName = inferZone(domain);
  const zoneSpinner = ora(`Cloudflare: locating zone "${zoneName}"`).start();
  let zone: { id: string; name: string } | null;
  try {
    zone = await cf.getZoneByName(zoneName);
    if (!zone) {
      zoneSpinner.fail();
      console.log(
        chalk.yellow(
          `  No Cloudflare zone matches "${zoneName}". Add one (or change the\n` +
            "  domain) and set the records manually.",
        ),
      );
      return { managed: false };
    }
    zoneSpinner.succeed(`Cloudflare zone: ${zone.name}`);
  } catch (err) {
    zoneSpinner.fail(`Cloudflare zone lookup failed: ${(err as Error).message}`);
    return { managed: false };
  }

  const result: DnsWireResult = { managed: false };
  if (ips.v4) {
    const id = await upsertOne(cf, zone.id, "A", domain, ips.v4);
    if (id) {
      result.recordIdV4 = id;
      result.managed = true;
    }
  }
  if (ips.v6) {
    const id = await upsertOne(cf, zone.id, "AAAA", domain, ips.v6);
    if (id) {
      result.recordIdV6 = id;
      result.managed = true;
    }
  }
  return result;
}

async function upsertOne(
  cf: CloudflareApi,
  zoneId: string,
  type: "A" | "AAAA",
  domain: string,
  content: string,
): Promise<string | undefined> {
  const spinner = ora(`Cloudflare: upserting ${type} ${domain} → ${content}`).start();
  try {
    const res = await cf.upsertRecord(zoneId, { type, name: domain, content, proxied: true });
    if (res.created) spinner.succeed(`Cloudflare: created ${type} ${domain} → ${content}`);
    else if (res.updated) spinner.succeed(`Cloudflare: updated ${type} ${domain} → ${content}`);
    else spinner.succeed(`Cloudflare: ${type} ${domain} → ${content} already correct`);
    return res.id;
  } catch (err) {
    spinner.fail(`Cloudflare: ${type}-record upsert failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** Best-effort eTLD+1 inference. Works for the common case
 *  (sub.domain.tld → domain.tld). For multi-segment public suffixes
 *  (foo.co.uk) the user may need to override; rare enough that
 *  shipping a PSL parser is overkill. */
function inferZone(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

/** Look up the Coolify apps belonging to a project for the
 *  Actions-secrets push. Tries the names hatchkit / the starter
 *  conventions produce, in priority order:
 *    · `<name>-server` + `<name>-client`  → starter split layout
 *    · `<name>`                            → adopt single-app layout
 *    · `<name>-web` / `<name>-app` / `<name>-api` → setup-coolify-stack.sh
 *      defaults (treated as single-app, no SERVER/CLIENT label).
 *
 *  Returns an empty array when Coolify isn't configured or no app
 *  matches — callers log a manual-recipe hint in that case. */
export async function findCoolifyAppsForProject(projectName: string): Promise<CoolifyDeployApp[]> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return [];
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const apps = await api.listApplications();
  const byName = new Map(apps.map((a) => [a.name, a.uuid]));

  const found: CoolifyDeployApp[] = [];
  const serverUuid = byName.get(`${projectName}-server`);
  const clientUuid = byName.get(`${projectName}-client`);
  if (serverUuid) found.push({ uuid: serverUuid, label: "SERVER" });
  if (clientUuid) found.push({ uuid: clientUuid, label: "CLIENT" });

  if (found.length === 0) {
    // Single-app fallbacks. Picked in priority order — first match wins.
    for (const candidate of [
      projectName,
      `${projectName}-web`,
      `${projectName}-app`,
      `${projectName}-api`,
    ]) {
      const uuid = byName.get(candidate);
      if (uuid) {
        found.push({ uuid });
        break;
      }
    }
  }

  return found;
}
