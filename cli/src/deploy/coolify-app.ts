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

import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig, getDnsConfig } from "../config.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import type { ApplicationCreateInput } from "../utils/coolify-api.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { type PublicIps, discoverPublicIps } from "../utils/coolify-server-ips.js";
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
  /** Compose service that should receive the public domain. Defaults to
   *  the service name hatchkit scaffolds (`app`). */
  dockerComposeServiceName?: string;
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
  /** Cloudflare zone id used when records were managed — paired with
   *  recordId/recordIdV6 for a future delete during rollback. */
  dnsZoneId?: string;
  /** True when at least one DNS record (A or AAAA) was upserted. */
  dnsManaged: boolean;
  // ── "Did this run actually create vs. reuse?" flags. Adopt's
  //    ledger keys off these — only resources hatchkit *created* are
  //    recorded, so a later rollback never deletes things the user
  //    had before this run.
  /** True when this call POSTed `/projects` (vs. matched an existing
   *  Coolify project by name). */
  projectCreated: boolean;
  /** True when this call POSTed `/applications/{public,private}` (vs.
   *  matched an existing Coolify application by name). */
  appCreated: boolean;
  /** True when the A record was newly created (not updated). On
   *  `updated`, we'd be deleting a record whose original content we
   *  overwrote — destructive in a way the user can't recover from,
   *  so we deliberately don't track it for rollback. */
  dnsRecordCreatedV4: boolean;
  /** Same as dnsRecordCreatedV4, for the AAAA record. */
  dnsRecordCreatedV6: boolean;
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
  let projectCreated = false;
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
      projectCreated = true;
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
      const sourcesUrl = `${cfg.url.replace(/\/$/, "")}/sources`;
      throw new Error(
        `Repo is private but no Coolify GitHub source is configured.\n` +
          `  Install a GitHub App at ${sourcesUrl}, then re-run with \`hatchkit adopt --resume\`.`,
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
  let appCreated = false;
  const buildPack = input.buildPack ?? "dockercompose";
  const portsExposes = input.portsExposes ?? "3000";
  const appDomain =
    buildPack === "dockercompose"
      ? formatDockerComposeDomain(input.domain, portsExposes)
      : `https://${input.domain}`;
  const existingApp = await api.findApplicationByName(input.projectName);
  if (existingApp) {
    console.log(
      chalk.dim(
        `  · Coolify app "${input.projectName}" already exists (${existingApp.uuid}) — skipping create, will reconcile build pack + env + DNS.`,
      ),
    );
    appUuid = existingApp.uuid;
    // Reconcile the build pack + compose location + ports against
    // what hatchkit's pipeline expects. Catches the case where the
    // app was created (by Coolify's UI, an older hatchkit, or a
    // first-run that picked the wrong value) with build_pack=static
    // or nixpacks — symptom is "Coolify ignores docker-compose.yml
    // and tries to serve the repo as a static site". A blind PATCH
    // is fine here: every adopted app goes through the same
    // GHCR-pull-via-compose pipeline, so dockercompose is always
    // the right answer once adopt has scaffolded the build files.
    const reconcile = ora("Coolify: reconciling build pack on existing app").start();
    try {
      await api.updateApplication(existingApp.uuid, {
        buildPack,
        portsExposes,
        dockerComposeLocation: buildPack === "dockercompose" ? "/docker-compose.yml" : undefined,
        gitBranch: input.gitBranch ?? "main",
        gitRepository: input.gitRepository,
      });
      reconcile.succeed(`Coolify: build pack set to ${buildPack}`);
    } catch (err) {
      reconcile.fail(`Coolify: couldn't reconcile build pack: ${(err as Error).message}`);
      console.log(
        chalk.dim(
          `  Set Build Pack = ${buildPack} manually on the app's Configuration page in Coolify.`,
        ),
      );
    }
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
      domains: [appDomain],
      dockerComposeDomainServiceName: input.dockerComposeServiceName ?? "app",
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
      appCreated = true;
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
  } catch {
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
    dnsZoneId: dnsResult.zoneId,
    dnsManaged: dnsResult.managed,
    projectCreated,
    appCreated,
    dnsRecordCreatedV4: dnsResult.createdV4,
    dnsRecordCreatedV6: dnsResult.createdV6,
  };
}

function formatDockerComposeDomain(domain: string, portsExposes: string): string {
  const port = firstExposePort(portsExposes);
  if (!port || port === "80" || port === "443") return `https://${domain}`;
  return `https://${domain}:${port}`;
}

function firstExposePort(portsExposes: string): string | undefined {
  const first = portsExposes
    .split(",")
    .map((p) => p.trim())
    .find(Boolean);
  return first?.split(":").pop()?.trim();
}

interface DnsWireResult {
  managed: boolean;
  recordIdV4?: string;
  recordIdV6?: string;
  /** Cloudflare zone id, when the upsert reached the API. Surfaced so
   *  the rollback ledger can target the right zone without having to
   *  re-resolve it. */
  zoneId?: string;
  /** True when we POSTed (vs. PATCHed) the A record. Adopt only
   *  records the rollback step on `created`, never on `updated` —
   *  reverting an update means restoring content we don't have. */
  createdV4: boolean;
  createdV6: boolean;
}

/** Upsert A and/or AAAA records for `domain` on Cloudflare. Either
 *  IP being undefined is fine — we only upsert what we've got, so a
 *  v6-only deploy gets just an AAAA record and v4-only gets just an A. */
async function wireDns(domain: string, ips: PublicIps): Promise<DnsWireResult> {
  const empty: DnsWireResult = { managed: false, createdV4: false, createdV6: false };
  if (!ips.v4 && !ips.v6) {
    console.log(
      chalk.yellow(
        "  Couldn't resolve a public IPv4 or IPv6 for the Coolify server.\n" +
          `  Add an A (and optionally AAAA) record for ${domain} manually pointing at\n` +
          "  the box's public IP, or fix the server's IP in the Coolify dashboard so\n" +
          "  /servers/{uuid}/domains returns it.",
      ),
    );
    return empty;
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
    return empty;
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
    return empty;
  }
  if (!dns.apiToken) {
    console.log(
      chalk.yellow(
        "  Cloudflare token missing from keychain — re-run `hatchkit config add dns` to refresh.",
      ),
    );
    return empty;
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
      return empty;
    }
    zoneSpinner.succeed(`Cloudflare zone: ${zone.name}`);
  } catch (err) {
    zoneSpinner.fail(`Cloudflare zone lookup failed: ${(err as Error).message}`);
    return empty;
  }

  const result: DnsWireResult = {
    managed: false,
    zoneId: zone.id,
    createdV4: false,
    createdV6: false,
  };
  if (ips.v4) {
    const r = await upsertOne(cf, zone.id, "A", domain, ips.v4);
    if (r) {
      result.recordIdV4 = r.id;
      result.createdV4 = r.created;
      result.managed = true;
    }
  }
  if (ips.v6) {
    const r = await upsertOne(cf, zone.id, "AAAA", domain, ips.v6);
    if (r) {
      result.recordIdV6 = r.id;
      result.createdV6 = r.created;
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
): Promise<{ id: string; created: boolean } | undefined> {
  const spinner = ora(`Cloudflare: upserting ${type} ${domain} → ${content}`).start();
  try {
    const res = await cf.upsertRecord(zoneId, { type, name: domain, content, proxied: true });
    if (res.created) spinner.succeed(`Cloudflare: created ${type} ${domain} → ${content}`);
    else if (res.updated) spinner.succeed(`Cloudflare: updated ${type} ${domain} → ${content}`);
    else spinner.succeed(`Cloudflare: ${type} ${domain} → ${content} already correct`);
    return { id: res.id, created: res.created };
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
 *    · `<name>-web` / `<name>-app` / `<name>-api` → `runCoolifySetup`
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
