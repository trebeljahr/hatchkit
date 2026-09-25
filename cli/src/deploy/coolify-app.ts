import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig, getDnsConfig } from "../config.js";
import { readImageEnvDefaults } from "../scaffold/deploy-verification.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { composeServicesOf, validateComposeServices } from "../utils/compose.js";
import type { ApplicationCreateInput } from "../utils/coolify-api.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { type PublicIps, discoverPublicIps } from "../utils/coolify-server-ips.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";
import { type CoolifyDeployApp, repoSlugFromRemote } from "./gh-actions-secrets.js";
import { type RoutedApp, type RoutingPlan, type Topology, computeRoutingPlan } from "./routing.js";
import { pushNativeOriginsToServerApps } from "./trusted-origins.js";

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
  /** Compose service that should receive the public/bare domain. Feeds
   *  routing's `publicService`; when unset routing derives it from
   *  `surfaces` and then from the compose file itself. */
  dockerComposeServiceName?: string;
  /** Fully-computed routing plan. Pass this when the caller already
   *  built one (adopt does, so the stepper can show it before the user
   *  commits); otherwise it's derived from the fields below. */
  routing?: RoutingPlan;
  /** How the deployment is spread across Coolify applications. Default
   *  `single-origin` — one compose app with `/api` path-routed to the
   *  server. See {@link ProjectManifest.topology}. */
  topology?: Topology;
  /** Project shape, used to pick default service names. */
  surfaces?: "fullstack" | "split" | "backend" | "static";
  /** Ports the two halves listen on, for `ports_exposes`. */
  ports?: { server?: number; client?: number };
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
  /** Repo-relative path Coolify should use as the build context root
   *  for every app in the routing plan (single-origin: one app; split:
   *  both client + server share the git tree, so the same subdir
   *  applies to both). Set (e.g. `"site"`, `"apps/web"`) when the
   *  deployable lives in a subfolder of a larger repo; leave unset
   *  for the historical single-package-at-root layout. Passed
   *  verbatim to Coolify as `base_directory` on every create + PATCH. */
  baseDirectory?: string;
  /** Project features, read ONLY for their native-client origins
   *  (mobile / desktop). When any are present they are
   *  merged into TRUSTED_ORIGINS on the server app after the baseline
   *  env, with the same diff + confirmation `hatchkit sync` shows.
   *  Omit (or pass `[]`) for a project with no server. */
  nativeClientFeatures?: readonly string[];
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
  /** Coolify application uuid of the app that owns the bare domain.
   *  Equals `apps[0].uuid`; kept as its own field so single-app callers
   *  don't have to change. */
  appUuid: string;
  /** Every Coolify application created or reconciled by this call. One
   *  entry under `single-origin`, two under `split`. */
  apps: Array<{ uuid: string; name: string; role: RoutedApp["role"]; created: boolean }>;
  /** Hostnames beyond the bare domain this topology needs DNS for
   *  (`api.<domain>` under `split`). Records for these ARE upserted
   *  when a DNS provider is configured; the list is returned so the
   *  caller can print a manual recipe when one isn't. */
  extraDnsHostnames: string[];
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
          `  Coolify's built-in "Public GitHub" source doesn't count — it clones over\n` +
          `  anonymous HTTPS and can't see a private repo.\n` +
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

  // ── 4. Create / reconcile the Coolify application(s) ───────────────
  const buildPack = input.buildPack ?? "dockercompose";
  const repoRef = normalizeCoolifyGitRepository(input.gitRepository, !!input.isPrivate);
  if (repoRef.gitRepository !== input.gitRepository) {
    console.log(
      chalk.dim(
        `  · Coolify Git source: ${repoRef.gitRepository} (${input.isPrivate ? "GitHub App" : "public HTTPS"})`,
      ),
    );
  }

  //
  // The desired routing comes from deploy/routing.ts — the SAME module
  // `create` and `sync` use, so the three commands can no longer
  // disagree about which apps exist or which domains hang off them.
  // `single-origin` yields one app; `split` yields `<name>-client` +
  // `<name>-server`.
  const composeServices = composeServicesOf(input.projectDir);
  const plan =
    input.routing ??
    computeRoutingPlan({
      name: input.projectName,
      domain: input.domain,
      topology: input.topology ?? "single-origin",
      surfaces: input.surfaces,
      ports: input.ports,
      publicService: input.dockerComposeServiceName || undefined,
      composeServices,
    });

  const provisioned: Array<{
    uuid: string;
    name: string;
    role: RoutedApp["role"];
    created: boolean;
  }> = [];

  for (const routed of plan.apps) {
    // Validate the routed service names against the compose file BEFORE
    // any write. Coolify answers a `docker_compose_domains` PATCH that
    // names a non-existent service with 200 OK, then emits no Traefik
    // labels at all — the app's FQDN stays empty and every request
    // 503s. Skip the domain payload and emit a copy-pasteable caveat
    // rather than pushing to a phantom name; the rest of the
    // create/reconcile still runs.
    let composeServiceCaveat: CoolifyCaveat | undefined;
    if (buildPack === "dockercompose") {
      const validation = validateComposeServices(input.projectDir, routed.requiredComposeServices);
      if (!validation.ok) {
        composeServiceCaveat = {
          title: `Coolify routing skipped — phantom compose service(s) ${validation.missing
            .map((m: string) => `"${m}"`)
            .join(", ")}`,
          reason:
            `${validation.composeFile} declares only: ${validation.declaredServices.join(", ")}. ` +
            "Coolify would accept the write (200 OK) but Traefik would never bind a domain, so every request 503s.",
          recovery: [
            `Set "publicService" in .hatchkit.json to one of: ${validation.declaredServices.join(", ")}.`,
            "Then re-run: hatchkit adopt --resume",
          ],
        };
      }
    }
    const skipDomain = !!composeServiceCaveat;
    const domainPayload =
      buildPack === "dockercompose"
        ? skipDomain
          ? {}
          : { dockerComposeDomains: routed.composeDomains }
        : { domains: routed.flatDomains };

    // Accept the alias names on LOOKUP so a hand-rolled
    // `<name>-backend` / `<name>-frontend` pair is reconciled in place
    // instead of being shadowed by a second, empty app.
    let existingApp = await api.findApplicationByName(routed.appName);
    if (!existingApp) {
      for (const alias of routed.aliases) {
        existingApp = await api.findApplicationByName(alias);
        if (existingApp) {
          console.log(
            chalk.dim(
              `  · Matched existing Coolify app "${alias}" for the ${routed.role} half ` +
                `(hatchkit's own name would be "${routed.appName}").`,
            ),
          );
          break;
        }
      }
    }

    if (existingApp) {
      console.log(
        chalk.dim(
          `  · Coolify app "${existingApp.name || routed.appName}" already exists (${existingApp.uuid}) — skipping create, will reconcile build pack + domain + env + DNS.`,
        ),
      );
      // Reconcile the build pack + compose location + ports + DOMAINS
      // against what hatchkit's pipeline expects. Catches the case where
      // the app was created (by Coolify's UI, an older hatchkit, or a
      // first-run that picked the wrong value) with build_pack=static
      // or nixpacks — symptom is "Coolify ignores docker-compose.yml
      // and tries to serve the repo as a static site".
      const reconcile = ora(
        `Coolify: reconciling build pack + domain on "${existingApp.name || routed.appName}"`,
      ).start();
      try {
        await api.updateApplication(existingApp.uuid, {
          buildPack,
          portsExposes: routed.portsExposes,
          dockerComposeLocation: buildPack === "dockercompose" ? routed.composeLocation : undefined,
          gitBranch: input.gitBranch ?? "main",
          gitRepository: repoRef.gitRepository,
          githubAppUuid: input.isPrivate ? githubAppUuid : undefined,
          // Only patch description when the user supplied one — don't
          // clobber a description edited in the dashboard.
          description: userDescription ? userDescription : undefined,
          // Always push the manifest's view of `base_directory` so an
          // app that was created at repo root, then re-adopted from a
          // subdir (or vice versa), converges to the right build context
          // on the next deploy. Empty string resets Coolify back to `/`.
          baseDirectory: input.baseDirectory ?? "",
          // Pushed even when the domain payload is skipped: it's an app
          // setting, not part of the routing, and getting it wrong is
          // the difference between /api/health and a 404.
          ...(routed.stripPrefix !== undefined ? { isStripprefixEnabled: routed.stripPrefix } : {}),
          ...domainPayload,
        });
        if (skipDomain) {
          reconcile.warn(
            `Coolify: build pack set to ${buildPack}; domain PATCH skipped (compose service mismatch).`,
          );
        } else {
          reconcile.succeed(
            `Coolify: build pack set to ${buildPack}, routing → ${formatRouting(routed)}`,
          );
        }
      } catch (err) {
        reconcile.fail(`Coolify: couldn't reconcile build pack/domain: ${(err as Error).message}`);
        console.log(
          chalk.dim(
            `  Set Build Pack = ${buildPack} and Domain = ${formatRouting(routed)} manually on the app's Configuration page in Coolify.`,
          ),
        );
      }
      if (composeServiceCaveat) caveats.push(composeServiceCaveat);
      provisioned.push({
        uuid: existingApp.uuid,
        name: existingApp.name || routed.appName,
        role: routed.role,
        created: false,
      });
      continue;
    }

    const baseInput: ApplicationCreateInput = {
      projectUuid,
      serverUuid: resolveServer.uuid,
      gitRepository: repoRef.gitRepository,
      gitBranch: input.gitBranch ?? "main",
      portsExposes: routed.portsExposes,
      // hatchkit's canonical pipeline = GitHub Actions builds image →
      // pushes to GHCR → Coolify pulls via docker-compose.yml. Caller
      // can still override (e.g. for legacy nixpacks paths) but
      // `dockercompose` is the default for any project that's gone
      // through `hatchkit adopt`'s build-pipeline scaffold.
      buildPack,
      dockerComposeLocation: routed.composeLocation,
      name: routed.appName,
      description: createDescription,
      ...(buildPack === "dockercompose" ? {} : { domains: routed.flatDomains }),
      ...(buildPack === "dockercompose" && !skipDomain
        ? { dockerComposeDomains: routed.composeDomains }
        : {}),
      // Tell Coolify which subfolder of the repo holds the build
      // context. Coolify reads docker-compose.yml / Dockerfile relative
      // to this directory, so getting it right is the difference
      // between "Coolify builds the marketing site" and "Coolify
      // tries to build the CLI and fails". Every app in the routing
      // plan builds from the same subdir (they share the git tree).
      ...(input.baseDirectory ? { baseDirectory: input.baseDirectory } : {}),
      instantDeploy: false,
    };

    const createApp = ora(`Coolify: creating app "${routed.appName}"`).start();
    let createdUuid: string;
    try {
      const res = input.isPrivate
        ? await api.createApplicationFromPrivateGithubApp({
            ...baseInput,
            githubAppUuid: githubAppUuid as string,
          })
        : await api.createApplicationFromPublicRepo(baseInput);
      createdUuid = res.uuid;
      createApp.succeed(`Coolify app created: ${routed.appName} (uuid: ${createdUuid})`);
    } catch (err) {
      createApp.fail();
      const message = err instanceof Error ? err.message : String(err);
      // Coolify answers a bare 500 when the github_app_uuid isn't a
      // real GitHub App (no app_id / private key to mint an
      // installation token with). The seeded "Public GitHub" source is
      // the usual culprit; listGithubSources filters it out now, so a
      // 500 here means the picked App is broken on the Coolify side.
      if (/private-github-app failed:\s*5\d\d/.test(message)) {
        const sourcesUrl = `${cfg.url.replace(/\/$/, "")}/sources`;
        throw new Error(
          `${message}\n` +
            `  Coolify couldn't use GitHub source ${githubAppUuid} to clone a private repo.\n` +
            `  Check the App at ${sourcesUrl} has an App ID + private key and is installed on GitHub,\n` +
            `  or set the repo visibility row to public if the repo doesn't need auth.`,
        );
      }
      throw err;
    }

    // `is_stripprefix_enabled` isn't accepted on the create endpoints,
    // so path-scoped routing needs this follow-up PATCH. Without it
    // Coolify strips `/api` and every API call 404s at Express.
    if (routed.stripPrefix === false) {
      const strip = ora("Coolify: disabling path-prefix stripping").start();
      try {
        await api.updateApplication(createdUuid, { isStripprefixEnabled: false });
        strip.succeed("Coolify: path-prefix stripping disabled (so /api reaches the server)");
      } catch (err) {
        strip.fail(`Coolify: couldn't disable path-prefix stripping — ${(err as Error).message}`);
        caveats.push({
          title: `Path-prefix stripping left ON for "${routed.appName}"`,
          reason: `PATCH is_stripprefix_enabled=false failed: ${(err as Error).message}. Coolify will deliver /api/health to the server as /health, so every API call 404s.`,
          recovery: [
            `Open the Coolify app's Configuration page → Advanced → "Strip Prefix" → toggle OFF.`,
            "Or re-run: hatchkit sync",
          ],
        });
      }
    }

    if (composeServiceCaveat) caveats.push(composeServiceCaveat);
    provisioned.push({
      uuid: createdUuid,
      name: routed.appName,
      role: routed.role,
      created: true,
    });
  }

  const appUuid = provisioned[0].uuid;
  const appCreated = provisioned.some((a) => a.created);

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
        // Seed the compose file's image variables (APP_IMAGE for an
        // adopted single-service project, SERVER_IMAGE / CLIENT_IMAGE
        // for a two-package one) with its own defaults. The deploy
        // workflow repoints these at the immutable
        // `:<sha>` tag on every push, and Coolify's env API only UPDATES
        // an existing variable — a PATCH naming a key that isn't there
        // returns 200 and does nothing, so the pin silently no-ops and
        // the app keeps running whatever `:main` resolved to. Seeding the
        // value the compose already defaults to changes nothing about
        // what runs; it just makes the key exist.
        ...readImageEnvDefaults(input.projectDir),
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

  // ── 5b. Native-client origins. better-auth rejects a Capacitor /
  //        Electron shell's origin with 403 INVALID_ORIGIN
  //        unless TRUSTED_ORIGINS names it, and an adopted project's
  //        production env may live entirely in Coolify. Merged, confirmed
  //        and read back on the server app — deploy/trusted-origins.ts.
  const nativeOrigins = await pushNativeOriginsToServerApps({
    api,
    apps: provisioned,
    features: input.nativeClientFeatures ?? [],
  });
  for (const o of nativeOrigins) {
    if (o.status === "failed" || o.status === "unreadable" || o.status === "needs-confirmation") {
      caveats.push({
        title: `TRUSTED_ORIGINS not updated on ${o.app} — native clients will get 403 INVALID_ORIGIN`,
        reason: o.detail ?? `missing ${o.added.join(", ")} (${o.status})`,
        recovery: ["hatchkit sync --dry-run   # review the diff", "hatchkit sync --deploy"],
      });
    }
  }

  // ── 6. DNS — pull the box's public IP(s) from Coolify and upsert records.
  //
  // Coolify is the source of truth: `/servers/{uuid}/domains` exposes
  // the configured `public_ipv4` and `public_ipv6` for localhost-Coolify
  // installs (where /servers reports "host.docker.internal"), and
  // /servers itself returns a real IPv4 on non-Docker installs.
  const ips = await discoverPublicIps(api, resolveServer.uuid, server.ip);
  const dnsResult = await wireDns(input.domain, ips);
  // Topologies that add a hostname (split's `api.<domain>`) need their
  // own record — the bare-domain A record above doesn't cover it, and a
  // missing one presents as "the API is just down" with no other
  // symptom. Best-effort: failures become a caveat, not a hard stop.
  for (const host of plan.extraDnsHostnames) {
    const extra = await wireDns(host, ips);
    if (extra.caveat) caveats.push(extra.caveat);
  }

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
    apps: provisioned,
    extraDnsHostnames: plan.extraDnsHostnames,
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

/** One-line rendering of an app's routing, for spinner text and the
 *  manual-fix hint. Shows `service=url` for compose apps (the shape
 *  Coolify stores) and a plain URL list otherwise. */
function formatRouting(routed: RoutedApp): string {
  if (routed.composeDomains.length > 0) {
    return routed.composeDomains.map((d) => `${d.name}=${d.domain}`).join(", ");
  }
  return routed.flatDomains.join(", ");
}

export interface DnsWireResult {
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
export async function wireDns(domain: string, ips: PublicIps): Promise<DnsWireResult> {
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
 *  Actions-secrets push.
 *
 *  `single-origin` (and any project whose topology we don't know) has
 *  ONE app; the candidate list below covers hatchkit's current name
 *  plus the legacy ones older `runCoolifySetup` releases produced.
 *
 *  `split` has TWO, and both need a deploy trigger — returning only one
 *  would leave half the deployment stuck on a stale image forever. Each
 *  is matched through its aliases so a hand-rolled `-backend` /
 *  `-frontend` pair (tiao's shape) is found rather than skipped, and
 *  each carries a `role` so the secrets push can name them apart.
 *
 *  Returns an empty array when Coolify isn't configured or nothing
 *  matches — callers log a manual-recipe hint in that case. */
export async function findCoolifyAppsForProject(
  projectName: string,
  topology: Topology = "single-origin",
): Promise<CoolifyDeployApp[]> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return [];
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const apps = await api.listApplications();
  const byName = new Map(apps.map((a) => [a.name, a.uuid]));

  if (topology === "split") {
    const plan = computeRoutingPlan({
      name: projectName,
      // Domain doesn't affect the app NAMES, which is all we need here.
      domain: "example.invalid",
      topology: "split",
    });
    const found: CoolifyDeployApp[] = [];
    for (const routed of plan.apps) {
      for (const candidate of [routed.appName, ...routed.aliases]) {
        const uuid = byName.get(candidate);
        if (uuid) {
          found.push({ uuid, role: routed.role === "server" ? "server" : "client" });
          break;
        }
      }
    }
    if (found.length > 0) return found;
    // Fall through: a manifest may say `split` before the apps exist.
  }

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
