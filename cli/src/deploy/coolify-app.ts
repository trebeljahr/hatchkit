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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig, getDnsConfig } from "../config.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import type { ApplicationCreateInput } from "../utils/coolify-api.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { type PublicIps, discoverPublicIps } from "../utils/coolify-server-ips.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";
import { type CoolifyDeployApp, repoSlugFromRemote } from "./gh-actions-secrets.js";

export interface WireUpInput {
  projectName: string;
  domain: string;
  /** Human-readable one-liner shown on the Coolify project + application
   *  pages. Leave undefined / empty to fall back to the generic
   *  "Adopted by hatchkit" blurb (only used on first create — reconcile
   *  leaves an existing description alone unless this is a non-empty
   *  string). */
  description?: string;
  /** GitHub repo remote. SSH and HTTPS GitHub remotes are normalized before
   *  they are sent to Coolify so public apps clone over HTTPS and private
   *  GitHub-App apps use the `owner/repo` selector. */
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
  /** Compose service that should receive the public domain. When set,
   *  takes precedence over the `projectDir`-based autodetect below.
   *  Defaults to `app` (hatchkit's scaffolded service name) when neither
   *  is provided and no compose file is on disk. */
  dockerComposeServiceName?: string;
  /** Project root on disk. When `dockerComposeServiceName` is unset, we
   *  read the compose file here and pick the service whose `ports:`
   *  mapping matches `portsExposes` — handles user-authored composes
   *  with a non-default service name. Falls through to `app` when the
   *  file isn't there or the parse fails. */
  projectDir?: string;
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
  //
  // Coolify's `description` field is validated against a narrow
  // character class (letters/numbers/spaces and a small set of
  // punctuation — see /api/v1 OpenAPI). Notably no `:`, so a URL
  // won't pass. The stepper validator (validateCoolifyDescription)
  // mirrors that constraint; we trust the user-supplied value here.
  const userDescription = input.description?.trim();
  const createDescription = userDescription || "Adopted by hatchkit";
  const findOrCreateProject = ora(`Coolify: locating project "${input.projectName}"`).start();
  let projectUuid: string;
  let projectCreated = false;
  try {
    const existing = await api.findProjectByName(input.projectName);
    if (existing) {
      projectUuid = existing.uuid;
      findOrCreateProject.succeed(`Coolify project: ${input.projectName} (existing)`);
      // Reconcile description on re-runs only when the user provided
      // one. Skipping the PATCH on empty input preserves whatever
      // description the user may have edited in the Coolify dashboard.
      if (userDescription) {
        try {
          await api.updateProject(existing.uuid, { description: userDescription });
        } catch (err) {
          console.log(
            chalk.dim(`  · Couldn't update Coolify project description: ${(err as Error).message}`),
          );
        }
      }
    } else {
      const created = await api.createProject(input.projectName, createDescription);
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
  const repoRef = normalizeCoolifyGitRepository(input.gitRepository, !!input.isPrivate);
  if (repoRef.gitRepository !== input.gitRepository) {
    console.log(
      chalk.dim(
        `  · Coolify Git source: ${repoRef.gitRepository} (${input.isPrivate ? "GitHub App" : "public HTTPS"})`,
      ),
    );
  }
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
        gitRepository: repoRef.gitRepository,
        githubAppUuid: input.isPrivate ? githubAppUuid : undefined,
        // Only patch description when the user supplied one — same
        // reasoning as the project-level reconcile above (don't
        // clobber a description the user edited in the dashboard).
        description: userDescription ? userDescription : undefined,
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
    // Pick the compose service name the public domain should bind to.
    // Coolify's dockercompose build pack rejects a flat `domains` field
    // (422 — "Use docker_compose_domains instead") because routing has
    // to be per-service. Resolution order:
    //   1. Explicit `dockerComposeServiceName` from the caller (e.g.
    //      adopt's stepper override).
    //   2. Auto-detect from the project's compose file by port match,
    //      so user-authored composes with non-default service names
    //      (`web`, `client`, …) just work.
    //   3. `app` — hatchkit's scaffolded compose template uses that
    //      name. Safe fallback when neither signal is present.
    const dockerComposeServiceName =
      buildPack === "dockercompose"
        ? (input.dockerComposeServiceName ??
          pickComposeServiceForPort(input.projectDir, portsExposes))
        : undefined;
    const baseInput: ApplicationCreateInput = {
      projectUuid,
      serverUuid: resolveServer.uuid,
      gitRepository: repoRef.gitRepository,
      gitBranch: input.gitBranch ?? "main",
      portsExposes,
      // hatchkit's canonical pipeline = GitHub Actions builds image →
      // pushes to GHCR → Coolify pulls via docker-compose.yml. Caller
      // can still override (e.g. for legacy nixpacks paths) but
      // `dockercompose` is the default for any project that's gone
      // through `hatchkit adopt`'s build-pipeline scaffold.
      buildPack,
      name: input.projectName,
      description: createDescription,
      domains: [appDomain],
      dockerComposeDomainServiceName: dockerComposeServiceName,
      instantDeploy: false,
    };

    const createApp = ora(`Coolify: creating app for ${repoRef.gitRepository}`).start();
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
        GITHUB_REPO_URL: repoRef.webUrl ?? input.gitRepository,
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

  // ── 7. First deploy is owned by GitHub Actions, not us. ─────────────
  //
  // The compose file references `ghcr.io/<owner>/<repo>:latest`, which
  // only exists after the scaffolded `.github/workflows/deploy.yml`
  // has run (build → push to GHCR → call Coolify's deploy webhook).
  // If we trigger a deploy here, Coolify tries to pull an image that
  // hasn't been pushed yet and fails with `unauthorized` (GHCR's
  // generic "manifest not found / no creds" response).
  //
  // The canonical hatchkit pipeline:
  //   adopt scaffolds workflow → adopt pushes branch → Actions builds
  //   + pushes image to GHCR → Actions hits Coolify deploy webhook →
  //   Coolify pulls + starts containers.
  //
  // So we just print a heads-up here and let the workflow do its job.
  console.log(
    chalk.dim(
      `  · First deploy runs when GitHub Actions builds + pushes the image to GHCR.\n` +
        "    Watch the workflow in the repo's Actions tab; Coolify auto-pulls via\n" +
        "    the deploy webhook once the image is up.",
    ),
  );

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

export function normalizeCoolifyGitRepository(
  remoteUrl: string,
  isPrivate: boolean,
): { gitRepository: string; webUrl?: string } {
  const slug = repoSlugFromRemote(remoteUrl);
  if (!slug) return { gitRepository: remoteUrl };

  const webUrl = `https://github.com/${slug}`;
  return {
    // Coolify's public endpoint should not receive an SSH remote; it has
    // no deploy key and will fail with "Permission denied (publickey)".
    // The private GitHub App endpoint is selected by repository slug.
    gitRepository: isPrivate ? slug : webUrl,
    webUrl,
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

  // Edge hardening — only attempt once we've actually managed at least
  // one record on this zone (i.e. it's a hatchkit-relevant zone, not a
  // bystander one we happened to look up). Pure best-effort: failures
  // here are logged but never fail the wire-up. Stricter user-set
  // values are preserved (see CloudflareApi.enableEdgeHardening).
  if (result.managed) {
    const harden = ora(`Cloudflare: applying edge protection to ${zone.name}`).start();
    try {
      const r = await cf.enableEdgeHardening(zone.id);
      const summary: string[] = [];
      if (r.changed.length > 0) {
        summary.push(`${r.changed.length} updated`);
      }
      if (r.kept.length > 0) {
        summary.push(`${r.kept.length} already strict`);
      }
      if (r.failed.length > 0) {
        summary.push(`${r.failed.length} skipped`);
      }
      harden.succeed(
        `Cloudflare: edge protection on ${zone.name}` +
          (summary.length > 0 ? ` (${summary.join(", ")})` : ""),
      );
      for (const c of r.changed) {
        console.log(chalk.dim(`    · ${c.id}: ${formatSetting(c.from)} → ${formatSetting(c.to)}`));
      }
      for (const f of r.failed) {
        console.log(chalk.dim(`    · ${f.id} skipped — ${f.error}`));
      }
    } catch (err) {
      harden.fail(`Cloudflare: edge protection skipped — ${(err as Error).message}`);
    }
  }

  return result;
}

/** Format a zone-setting value for one-line display. Cloudflare returns
 *  string scalars for the toggles we touch but the field is loosely
 *  typed; coerce safely. */
function formatSetting(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "(unset)";
  return JSON.stringify(v);
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

/** Read the project's compose file and pick the service the public
 *  domain should bind to under Coolify's dockercompose build pack.
 *
 *  Why this exists: Coolify's API rejects the flat `domains` field for
 *  dockercompose apps and requires `docker_compose_domains` keyed by
 *  service name (422 — "Use docker_compose_domains instead to set
 *  domains for individual services"). The compose file is the source
 *  of truth for which service names exist on this project, so we read
 *  it directly instead of guessing.
 *
 *  Selection rules (first match wins):
 *    1. A service whose `ports:` mapping includes `<portsExposes>` —
 *       most accurate signal that this is the public-facing service.
 *    2. The first top-level service in the file — a sensible fallback
 *       for compose files written without explicit port mappings (e.g.
 *       hatchkit's own template, where the app service exposes the
 *       port via a build arg).
 *    3. `app` — the service name in hatchkit's compose template. Used
 *       when there's no compose file on disk yet (the build-pipeline
 *       scaffold may have written it after a hatchkit run that didn't
 *       reach this branch) or the file can't be parsed.
 *
 *  We deliberately avoid pulling in a YAML library — the regex below
 *  matches top-level `<name>:` keys and `<host>:<container>` port
 *  entries, which is enough for any compose file that compose itself
 *  parses successfully. */
function pickComposeServiceForPort(projectDir: string | undefined, portsExposes: string): string {
  if (!projectDir) return "app";
  for (const name of ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf-8");
      const match = matchComposeService(content, portsExposes);
      if (match) return match;
    } catch {
      // Fall through to the default — better to send a request that
      // might fail with a clearer Coolify error than to crash the
      // adopt flow on a malformed compose file.
    }
    break;
  }
  return "app";
}

/** Extract service-name candidates from a compose file. Returns the
 *  first service with a port mapping that includes `portsExposes`,
 *  else the first top-level service, else undefined. */
function matchComposeService(content: string, portsExposes: string): string | undefined {
  // Find the `services:` block. Anything before it (e.g. version, name)
  // is irrelevant.
  const lines = content.split(/\r?\n/);
  let servicesIndent = -1;
  let inServices = false;
  let firstService: string | undefined;
  let portMatchService: string | undefined;
  let currentService: string | undefined;
  let currentServiceIndent = -1;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;

    if (!inServices) {
      if (/^services\s*:/.test(line)) {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }

    // Exited the services block.
    if (indent <= servicesIndent) break;

    // A service header — `<name>:` indented deeper than `services:`
    // and not deeper than another service. We track the first one we
    // see at the shallowest depth; deeper lines belong to the same
    // service definition.
    if (currentServiceIndent === -1 || indent === currentServiceIndent) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*$/);
      if (m) {
        currentService = m[1];
        currentServiceIndent = indent;
        if (!firstService) firstService = currentService;
        continue;
      }
    }

    // Inside a service body: look for a port mapping that includes
    // the host or container port we care about. Compose accepts
    // "<host>:<container>", "<container>", or the long form with a
    // `target:` key — we match all three.
    if (currentService && !portMatchService) {
      const portsLine = line.match(/^\s*-\s*"?([0-9]+)(?::([0-9]+))?(?:\/[a-z]+)?"?$/);
      if (portsLine) {
        const host = portsLine[1];
        const container = portsLine[2] ?? portsLine[1];
        if (host === portsExposes || container === portsExposes) {
          portMatchService = currentService;
        }
      }
      const targetLine = line.match(/^\s*target\s*:\s*"?([0-9]+)"?\s*$/);
      if (targetLine && targetLine[1] === portsExposes) {
        portMatchService = currentService;
      }
    }
  }

  return portMatchService ?? firstService;
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
