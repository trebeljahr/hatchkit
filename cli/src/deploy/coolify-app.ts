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
  /** True when this project's deploys are GHA-driven (build → push to
   *  GHCR → call Coolify's deploy webhook). In that mode Coolify's
   *  git-webhook auto-deploy MUST be off — otherwise Coolify reacts to
   *  every git push by trying to deploy a stale/absent image before the
   *  GHA build finishes pushing the fresh one, surfacing as race-y deploy
   *  failures. When false / undefined, hatchkit leaves Coolify's
   *  auto-deploy at its default (i.e. on) so source-builds work as
   *  expected. */
  scaffoldBuildPipeline?: boolean;
}

/** Structural shape of a "do this next" hint that `wireProjectIntoCoolify`
 *  surfaces back to its caller. Mirrors adopt.ts's `AdoptCaveat` so the
 *  caller can push it straight into the caveats array without an
 *  adapter — keeps the two layers loosely coupled (coolify-app.ts has
 *  no dependency on adopt.ts's type) while still giving the user a
 *  single consolidated recovery block. */
export interface CoolifyCaveat {
  title: string;
  reason: string;
  recovery: string[];
}

export interface WireUpResult {
  /** Coolify application uuid. */
  appUuid: string;
  /** Coolify project uuid (existing or freshly created). */
  projectUuid: string;
  /** Coolify server uuid the app runs on. */
  serverUuid: string;
  /** Public IPv4 reported by Coolify. */
  serverIpv4?: string;
  /** Public IPv6 — only set when Coolify exposes one and we wrote
   *  an AAAA record. */
  serverIpv6?: string;
  /** Cloudflare DNS record id for the A record, if managed. */
  dnsRecordId?: string;
  /** Cloudflare DNS record id for the AAAA record, if managed. */
  dnsRecordIdV6?: string;
  /** Cloudflare zone id used when records were managed — paired with
   *  recordId/recordIdV6 for a future delete during rollback. */
  dnsZoneId?: string;
  /** True when at least one DNS record (A or AAAA) was upserted. */
  dnsManaged: boolean;
  /** Populated when DNS wasn't fully wired — either skipped (no
   *  provider, no token, no IPs) or failed mid-call. Carries the
   *  copy-pasteable recovery recipe the user needs (target IPs,
   *  recommended record type, the `dig` they can run to verify).
   *  Surfaced verbatim in adopt's caveats block so the user sees
   *  one consolidated "what's missing" list. Absent when DNS was
   *  wired successfully (no caveat to surface). */
  dnsCaveat?: CoolifyCaveat;
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
  /** Additional caveats surfaced by Coolify wiring (compose-service
   *  mismatch on a phantom name, is_auto_deploy_enabled toggle failed,
   *  etc.). Adopt concatenates these into its top-level caveats array
   *  so the user sees one consolidated recovery block. */
  caveats: CoolifyCaveat[];
}

/** Top-level wire-up. Throws on the first hard failure (no project,
 *  no server, app create rejected). The DNS step is best-effort —
 *  failures there log a hint and return without setting `dnsManaged`. */
export async function wireProjectIntoCoolify(input: WireUpInput): Promise<WireUpResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  /** Caveats accumulated during the wire-up. Adopt concatenates these
   *  into its top-level caveats array so the user sees one consolidated
   *  recovery block at the end. */
  const caveats: CoolifyCaveat[] = [];

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
        `  · Coolify app "${input.projectName}" already exists (${existingApp.uuid}) — skipping create, will reconcile build pack + domain + env + DNS.`,
      ),
    );
    appUuid = existingApp.uuid;
    // Pick the compose service the public domain should bind to.
    // Same priority chain as the create branch: explicit caller hint →
    // compose-file auto-detect. We compute it here too because the
    // reconcile PATCH below has to send `docker_compose_domains` —
    // without it Coolify keeps the previous (or empty) routing and
    // never generates the per-service traefik labels, which is the
    // exact symptom that left collection-of-beauty with zero traefik
    // labels on its container.
    const dockerComposeServiceName =
      buildPack === "dockercompose"
        ? (input.dockerComposeServiceName ??
          pickComposeServiceForPort(input.projectDir, portsExposes))
        : undefined;
    // Validate the picked name actually appears in the compose file.
    // Coolify's docker_compose_domains PATCH silently no-ops when the
    // name doesn't match a service — the deploy succeeds, but Traefik
    // never binds the domain. Emit a caveat + skip the domain PATCH
    // when validation fails (the rest of the reconcile still runs).
    let composeServiceCaveat: CoolifyCaveat | undefined;
    if (dockerComposeServiceName) {
      const validation = validateComposeService(input.projectDir, dockerComposeServiceName);
      if (!validation.ok) {
        composeServiceCaveat = {
          title: `Coolify routing skipped — phantom compose service "${dockerComposeServiceName}"`,
          reason: `Service "${dockerComposeServiceName}" is not declared in ${validation.composeFile}. Coolify would accept the PATCH (200 OK) but Traefik would never bind a domain, so every request 503s.`,
          recovery: [
            `Set "publicService" in .hatchkit.json to one of: ${validation.declaredServices.join(", ")}.`,
            `Then re-run: hatchkit adopt --resume`,
          ],
        };
      }
    }
    // Reconcile the build pack + compose location + ports + DOMAINS
    // against what hatchkit's pipeline expects. Catches the case where
    // the app was created (by Coolify's UI, an older hatchkit, or a
    // first-run that picked the wrong value) with build_pack=static
    // or nixpacks — symptom is "Coolify ignores docker-compose.yml
    // and tries to serve the repo as a static site". A blind PATCH
    // is fine here: every adopted app goes through the same
    // GHCR-pull-via-compose pipeline, so dockercompose is always
    // the right answer once adopt has scaffolded the build files.
    //
    // Domain is included so re-running adopt actually pushes the
    // manifest's `domain` to Coolify even when the app already exists
    // — the previous code path skipped this and Coolify kept the
    // empty (or stale) Domain field, so Traefik never got per-service
    // routing labels. Skipped when the compose-service validation
    // above flagged a phantom name (caveat already queued).
    const reconcile = ora("Coolify: reconciling build pack + domain on existing app").start();
    try {
      const skipDomain = !!composeServiceCaveat;
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
        ...(buildPack === "dockercompose"
          ? skipDomain || !dockerComposeServiceName
            ? {}
            : {
                dockerComposeDomains: [{ name: dockerComposeServiceName, domain: appDomain }],
              }
          : { domains: [appDomain] }),
      });
      if (skipDomain) {
        reconcile.warn(
          `Coolify: build pack set to ${buildPack}; domain PATCH skipped (compose service mismatch).`,
        );
      } else {
        reconcile.succeed(`Coolify: build pack set to ${buildPack}, domain → ${appDomain}`);
      }
    } catch (err) {
      reconcile.fail(`Coolify: couldn't reconcile build pack/domain: ${(err as Error).message}`);
      console.log(
        chalk.dim(
          `  Set Build Pack = ${buildPack} and Domain = ${appDomain} manually on the app's Configuration page in Coolify.`,
        ),
      );
    }
    if (composeServiceCaveat) caveats.push(composeServiceCaveat);
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
    //   3. undefined — when we have no signal at all (no caller hint
    //      and no compose file on disk yet). The create POST omits the
    //      per-service domain in that case; a follow-up `--resume` (or
    //      `hatchkit sync`) after the compose file lands will fix it.
    const dockerComposeServiceName =
      buildPack === "dockercompose"
        ? (input.dockerComposeServiceName ??
          pickComposeServiceForPort(input.projectDir, portsExposes))
        : undefined;
    let composeServiceCaveat: CoolifyCaveat | undefined;
    if (dockerComposeServiceName) {
      const validation = validateComposeService(input.projectDir, dockerComposeServiceName);
      if (!validation.ok) {
        composeServiceCaveat = {
          title: `Coolify routing skipped — phantom compose service "${dockerComposeServiceName}"`,
          reason: `Service "${dockerComposeServiceName}" is not declared in ${validation.composeFile}. Coolify would accept the create but Traefik would never bind a domain, so every request 503s.`,
          recovery: [
            `Set "publicService" in .hatchkit.json to one of: ${validation.declaredServices.join(", ")}.`,
            `Then re-run: hatchkit adopt --resume`,
          ],
        };
      }
    }
    const skipDomain = !!composeServiceCaveat;
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
      domains: skipDomain ? undefined : [appDomain],
      dockerComposeDomainServiceName: skipDomain ? undefined : dockerComposeServiceName,
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
    if (composeServiceCaveat) caveats.push(composeServiceCaveat);
  }

  // ── 4b. Toggle Coolify's git-webhook auto-deploy.
  //
  // Build-pipeline projects (GHA builds the image + calls Coolify's
  // deploy webhook) want auto-deploy OFF. Otherwise every git push
  // triggers Coolify to redeploy from a stale-or-absent GHCR image
  // before the GHA build has produced the fresh one — surfaces as
  // flaky deploys. Source-build projects keep the default ON.
  //
  // Best-effort: PATCH failure surfaces as a caveat (rare — the field
  // is documented on every Coolify v4 build hatchkit supports), the
  // create/reconcile above already succeeded, and the user can flip
  // the toggle from the dashboard.
  if (input.scaffoldBuildPipeline === true) {
    const toggle = ora("Coolify: disabling git-webhook auto-deploy (GHA owns deploys)").start();
    try {
      await api.updateApplication(appUuid, { isAutoDeployEnabled: false });
      toggle.succeed("Coolify: auto-deploy off (GHA owns deploys)");
    } catch (err) {
      toggle.fail(`Coolify: couldn't disable auto-deploy: ${(err as Error).message}`);
      caveats.push({
        title: "Coolify auto-deploy left ON for a build-pipeline project",
        reason: `PATCH is_auto_deploy_enabled=false failed: ${(err as Error).message}`,
        recovery: [
          `Open the Coolify app's Configuration page → Source → "Auto Deploy on Git Push" → toggle OFF.`,
          `Or re-run: hatchkit adopt --resume`,
        ],
      });
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

  // ── 6. DNS — pull the box's public IP(s) from Coolify and upsert records.
  //
  // Coolify is the source of truth: `/servers/{uuid}/domains` exposes
  // the configured `public_ipv4` and `public_ipv6` for localhost-Coolify
  // installs (where /servers reports "host.docker.internal"), and
  // /servers itself returns a real IPv4 on non-Docker installs.
  const ips = await discoverPublicIps(api, resolveServer.uuid, server.ip);
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
    dnsRecordId: dnsResult.recordIdV4,
    dnsRecordIdV6: dnsResult.recordIdV6,
    dnsZoneId: dnsResult.zoneId,
    dnsManaged: dnsResult.managed,
    dnsCaveat: dnsResult.caveat,
    projectCreated,
    appCreated,
    dnsRecordCreatedV4: dnsResult.createdV4,
    dnsRecordCreatedV6: dnsResult.createdV6,
    caveats,
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
  /** Populated whenever DNS wasn't fully wired — skipped (no provider,
   *  no token, no IPs) or failed mid-call. Carries a copy-pasteable
   *  recovery recipe surfaced verbatim in the adopt caveats block. */
  caveat?: CoolifyCaveat;
}

/** Compose the "add this record manually" recovery lines that go into
 *  the DNS caveat. Centralised so the no-provider / no-token / no-IP
 *  / no-zone branches all give the user the same shape of fix. The
 *  `dig` line at the end is what the user runs after they apply the
 *  fix to confirm the record propagated. */
function dnsRecoveryRecipe(domain: string, ips: PublicIps, extra: string[] = []): string[] {
  const records: string[] = [];
  if (ips.v4) records.push(`A    ${domain}  →  ${ips.v4}  (proxied/orange-cloud ON)`);
  if (ips.v6) records.push(`AAAA ${domain}  →  ${ips.v6}  (proxied/orange-cloud ON)`);
  if (records.length === 0) {
    records.push(`A/AAAA ${domain}  →  <Coolify server public IP>`);
  }
  return [
    "Set the following DNS record(s) yourself:",
    ...records.map((r) => `  ${r}`),
    ...extra,
    `Verify after propagation: dig +short ${domain}`,
  ];
}

/** Upsert A and/or AAAA records for `domain` on Cloudflare. Either
 *  IP being undefined is fine — we only upsert what we've got, so a
 *  v6-only deploy gets just an AAAA record and v4-only gets just an A. */
async function wireDns(domain: string, ips: PublicIps): Promise<DnsWireResult> {
  const empty = (caveat?: CoolifyCaveat): DnsWireResult => ({
    managed: false,
    createdV4: false,
    createdV6: false,
    caveat,
  });
  if (!ips.v4 && !ips.v6) {
    console.log(
      chalk.yellow(
        `\n  ⚠ Couldn't resolve a public IPv4 or IPv6 for the Coolify server — DNS wiring skipped.`,
      ),
    );
    return empty({
      title: `DNS for ${domain} not wired`,
      reason: "Coolify reported no public IPv4 / IPv6 for the server.",
      recovery: [
        "Fix the server's IP in the Coolify dashboard so /servers/{uuid}/domains returns it,",
        "or look up the box's IP manually and add the record yourself:",
        `  A ${domain}  →  <Coolify server public IP>  (proxied/orange-cloud ON)`,
        `Verify after propagation: dig +short ${domain}`,
      ],
    });
  }
  const dns = await getDnsConfig();
  if (!dns) {
    console.log(
      chalk.yellow(
        `\n  ⚠ No DNS provider configured — ${domain} record NOT created. ` +
          `Recipe surfaced in the caveats block at the end of this run.`,
      ),
    );
    return empty({
      title: `DNS for ${domain} not wired`,
      reason: "No DNS provider configured in hatchkit.",
      recovery: dnsRecoveryRecipe(domain, ips, [
        "Or wire it once via Hatchkit so future runs auto-upsert:",
        "  hatchkit config add dns",
        "  hatchkit adopt --resume",
      ]),
    });
  }
  if (!dns.apiToken) {
    console.log(
      chalk.yellow(`\n  ⚠ Cloudflare token missing from keychain — ${domain} record NOT created.`),
    );
    return empty({
      title: `DNS for ${domain} not wired`,
      reason: "Cloudflare DNS provider configured but its API token is missing from the keychain.",
      recovery: [
        "Refresh the token:",
        "  hatchkit config add dns",
        "Then re-run: hatchkit adopt --resume",
        "Or apply the record manually:",
        ...dnsRecoveryRecipe(domain, ips).slice(1),
      ],
    });
  }

  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
  const zoneName = inferZone(domain);
  const zoneSpinner = ora(`Cloudflare: locating zone "${zoneName}"`).start();
  let zone: { id: string; name: string } | null;
  try {
    zone = await cf.getZoneByName(zoneName);
    if (!zone) {
      zoneSpinner.fail();
      return empty({
        title: `DNS for ${domain} not wired`,
        reason: `No Cloudflare zone matches "${zoneName}" on the configured account.`,
        recovery: [
          `Add the zone in Cloudflare (or change the project domain so it lives under a zone you already own),`,
          `then re-run: hatchkit adopt --resume`,
          `Or apply the record on whatever DNS provider owns ${zoneName}:`,
          ...dnsRecoveryRecipe(domain, ips).slice(1),
        ],
      });
    }
    zoneSpinner.succeed(`Cloudflare zone: ${zone.name}`);
  } catch (err) {
    zoneSpinner.fail(`Cloudflare zone lookup failed: ${(err as Error).message}`);
    return empty({
      title: `DNS for ${domain} not wired`,
      reason: `Cloudflare zone lookup failed: ${(err as Error).message}`,
      recovery: [
        `Re-check token scope (Zone:DNS:Edit + Zone:Zone:Read required):`,
        `  hatchkit doctor`,
        `Then re-run: hatchkit adopt --resume`,
        `Or apply the record manually:`,
        ...dnsRecoveryRecipe(domain, ips).slice(1),
      ],
    });
  }

  const result: DnsWireResult = {
    managed: false,
    zoneId: zone.id,
    createdV4: false,
    createdV6: false,
  };
  const upsertFailures: string[] = [];
  if (ips.v4) {
    const r = await upsertOne(cf, zone.id, "A", domain, ips.v4);
    if (r) {
      result.recordIdV4 = r.id;
      result.createdV4 = r.created;
      result.managed = true;
    } else {
      upsertFailures.push(`A → ${ips.v4}`);
    }
  }
  if (ips.v6) {
    const r = await upsertOne(cf, zone.id, "AAAA", domain, ips.v6);
    if (r) {
      result.recordIdV6 = r.id;
      result.createdV6 = r.created;
      result.managed = true;
    } else {
      upsertFailures.push(`AAAA → ${ips.v6}`);
    }
  }
  if (upsertFailures.length > 0 && !result.managed) {
    // Every requested upsert failed (so `managed` stayed false). Surface
    // a caveat with the full set so the user knows what didn't land.
    result.caveat = {
      title: `DNS for ${domain} not wired`,
      reason: `Cloudflare upsert failed for: ${upsertFailures.join(", ")}.`,
      recovery: [
        `Check Cloudflare's last error in the spinner output above.`,
        `Apply the record manually:`,
        ...dnsRecoveryRecipe(domain, ips).slice(1),
      ],
    };
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

/** Validate the chosen compose service name against the project's
 *  docker-compose file. Coolify's docker_compose_domains PATCH silently
 *  no-ops when `name` doesn't match a service in the compose — the
 *  response is still 200 OK, but no Traefik labels get emitted, the
 *  app's FQDN stays empty, and every request 503s. We surface this
 *  to the caller as a structured result so they can skip the PATCH +
 *  emit a copy-pasteable caveat instead of pushing to a phantom name.
 *
 *  Result shapes:
 *    · { ok: true } — service exists in compose, or no compose file on
 *      disk we can parse (caller proceeds with the PATCH).
 *    · { ok: false, declaredServices } — compose found, service NOT in
 *      its `services:` block; caller skips the PATCH and emits caveat.
 */
function validateComposeService(
  projectDir: string | undefined,
  serviceName: string,
): { ok: true } | { ok: false; declaredServices: string[]; composeFile: string } {
  if (!projectDir) return { ok: true };
  for (const name of ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    let services: string[];
    try {
      services = listComposeServices(readFileSync(path, "utf-8"));
    } catch {
      // Unreadable / unparseable compose: don't block the deploy on
      // our parser's limits.
      return { ok: true };
    }
    if (services.length === 0) return { ok: true };
    if (services.includes(serviceName)) return { ok: true };
    return { ok: false, declaredServices: services, composeFile: name };
  }
  return { ok: true };
}

/** Extract the list of top-level service keys from a compose file.
 *  Shares the indent-aware traversal with matchComposeService below
 *  but returns the full set instead of a single match. */
function listComposeServices(content: string): string[] {
  const services: string[] = [];
  const lines = content.split(/\r?\n/);
  let servicesIndent = -1;
  let inServices = false;
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

    if (indent <= servicesIndent) break;

    if (currentServiceIndent === -1 || indent === currentServiceIndent) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*$/);
      if (m && !m[1].startsWith("x-")) {
        currentServiceIndent = indent;
        services.push(m[1]);
      }
    }
  }
  return services;
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
 *  Actions-secrets push. Tries the names hatchkit produces, in
 *  priority order:
 *    · `<name>`                            → single-app layout
 *      (current `create` + `adopt` output, all surfaces).
 *    · `<name>-server`                     → legacy starter-server.
 *    · `<name>-web` / `<name>-app` / `<name>-api` → legacy
 *      `runCoolifySetup` output (single-app).
 *
 *  Returns an empty array when Coolify isn't configured or no app
 *  matches — callers log a manual-recipe hint in that case. The
 *  per-surface split layout (`-server` + `-client` simultaneously)
 *  isn't supported any more; the current deploy.yml takes one uuid. */
export async function findCoolifyAppsForProject(projectName: string): Promise<CoolifyDeployApp[]> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return [];
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const apps = await api.listApplications();
  const byName = new Map(apps.map((a) => [a.name, a.uuid]));

  const found: CoolifyDeployApp[] = [];
  // Single-app fallbacks. Picked in priority order — first match wins.
  for (const candidate of [
    projectName,
    `${projectName}-server`,
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

  return found;
}
