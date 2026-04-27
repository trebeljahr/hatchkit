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
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";

export interface WireUpInput {
  projectName: string;
  domain: string;
  /** GitHub repo URL — `https://github.com/owner/repo`. */
  gitRepository: string;
  /** Default `main`. */
  gitBranch?: string;
  /** Container port the app listens on. Default `3000`. */
  portsExposes?: string;
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
  /** Server IP — used by the DNS step + reported back. */
  serverIp: string;
  /** Cloudflare DNS record id for the apex/sub A record, if we
   *  managed it. */
  dnsRecordId?: string;
  /** True when DNS provider is Cloudflare and we wrote the A record. */
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
      const created = await api.createProject(
        input.projectName,
        `Adopted by hatchkit — ${input.gitRepository}`,
      );
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

  // ── 4. Create the app. ─────────────────────────────────────────────
  const baseInput: ApplicationCreateInput = {
    projectUuid,
    serverUuid: resolveServer.uuid,
    gitRepository: input.gitRepository,
    gitBranch: input.gitBranch ?? "main",
    portsExposes: input.portsExposes ?? "3000",
    name: input.projectName,
    description: "Adopted by hatchkit",
    domains: [`https://${input.domain}`],
    instantDeploy: false,
  };

  const createApp = ora(`Coolify: creating app for ${input.gitRepository}`).start();
  let appUuid: string;
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

  // ── 6. DNS (Cloudflare only for now). ──────────────────────────────
  const dnsResult = await wireDns(input.domain, server.ip);

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
    serverIp: server.ip,
    dnsRecordId: dnsResult.recordId,
    dnsManaged: dnsResult.managed,
  };
}

interface DnsWireResult {
  managed: boolean;
  recordId?: string;
}

async function wireDns(domain: string, serverIp: string): Promise<DnsWireResult> {
  const dns = await getDnsConfig();
  if (!dns) {
    console.log(
      chalk.yellow(
        "  No DNS provider configured. Add an A record yourself for\n" +
          `    ${domain}  →  ${serverIp}\n` +
          "  Or run `hatchkit config add dns` and re-run.",
      ),
    );
    return { managed: false };
  }
  if (dns.provider !== "cloudflare") {
    console.log(
      chalk.yellow(
        `  DNS provider is ${dns.provider} — automatic A-record management isn't wired\n` +
          "  up for that provider yet. Add the A record manually:\n" +
          `    ${domain}  →  ${serverIp}`,
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

  // Find the zone that owns this domain. The zone name is the eTLD+1
  // — e.g. for `protocol.trebeljahr.com` the zone is `trebeljahr.com`.
  const zoneName = inferZone(domain);
  const spinner = ora(`Cloudflare: locating zone "${zoneName}"`).start();
  let zone: { id: string; name: string } | null;
  try {
    zone = await cf.getZoneByName(zoneName);
    if (!zone) {
      spinner.fail();
      console.log(
        chalk.yellow(
          `  No Cloudflare zone matches "${zoneName}". Add one (or change the\n` +
            "  domain) and re-run, or set the A record manually.",
        ),
      );
      return { managed: false };
    }
    spinner.succeed(`Cloudflare zone: ${zone.name}`);
  } catch (err) {
    spinner.fail(`Cloudflare zone lookup failed: ${(err as Error).message}`);
    return { managed: false };
  }

  const upsert = ora(`Cloudflare: upserting A record ${domain} → ${serverIp}`).start();
  try {
    const res = await cf.upsertRecord(zone.id, {
      type: "A",
      name: domain,
      content: serverIp,
      proxied: true,
    });
    if (res.created) upsert.succeed(`Cloudflare: created A ${domain} → ${serverIp}`);
    else if (res.updated) upsert.succeed(`Cloudflare: updated A ${domain} → ${serverIp}`);
    else upsert.succeed(`Cloudflare: A ${domain} → ${serverIp} already correct`);
    return { managed: true, recordId: res.id };
  } catch (err) {
    upsert.fail(`Cloudflare: A-record upsert failed: ${(err as Error).message}`);
    return { managed: false };
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
