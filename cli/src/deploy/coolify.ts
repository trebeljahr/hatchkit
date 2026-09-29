/*
 * Coolify project + application provisioning. Replaces the old
 * `infra/scripts/setup-coolify-stack.sh`, which spoke an obsolete
 * dialect of the Coolify REST API (`POST /databases` instead of
 * `/databases/mongodb`, single-key `POST /envs` instead of bulk
 * `PATCH /envs/bulk`) and silently swallowed db-creation failures.
 *
 * What this module owns:
 *   1. Project create-or-reuse (idempotent on project name).
 *   2. Server resolution (prefers `config.serverUuid` from the prompt
 *      flow; falls back to ip-keyed lookup or first server).
 *   3. Application create-or-reuse — one Coolify app named `<name>`
 *      regardless of surface, public-repo flavour. The compose file
 *      inside carries the server/client services (or just one of them
 *      after surface pruning), and Coolify exposes those as the
 *      per-service routing targets.
 *   4. Multi-domain routing (frontend + api subdomain + path-based API
 *      and websocket — the same five-host strategy the old script used).
 *   5. Minimal env vars on the application (NODE_ENV / PORT /
 *      FRONTEND_URL), plus the native clients' origins merged into
 *      TRUSTED_ORIGINS on the server app (deploy/trusted-origins.ts). App secrets and DB URLs go into encrypted
 *      .env.production via dotenvx — not directly onto the Coolify app
 *      — so the keyholder is the only one who sees plaintext, and
 *      redeploys don't require touching the Coolify UI.
 *
 * What this module does NOT own:
 *   · MongoDB / Redis containers — `provisionCoolifyMongo` (and a
 *     future Redis sibling) handle those, called separately by the
 *     create flow after the app exists.
 *   · GitHub Actions deploy secrets — `setCoolifyDeploySecrets` runs
 *     after we return, once we know the app uuid.
 */
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { readImageEnvDefaults } from "../scaffold/deploy-verification.js";
import { workflowsPromotingLive } from "../scaffold/signed-deploy.js";
import { liveImageRefs } from "./coolify-deploy-hook.js";

import { composeServicesOf, validateComposeServices } from "../utils/compose.js";
import { type ApplicationCreateInput, CoolifyApi } from "../utils/coolify-api.js";
import { repoSlugFromCoolifyGitRepository, repoSlugFromRemote } from "./gh-actions-secrets.js";
import {
  appSlugFromHtmlUrl,
  ensureCoolifyAppHasRepoAccess,
  installUrlForSlug,
} from "./github-app-access.js";
import { formatImageRef, healthCheckFor } from "./image-runtime.js";
import { type RoutedApp, computeRoutingPlan } from "./routing.js";
import { type NativeOriginsOutcome, pushNativeOriginsToServerApps } from "./trusted-origins.js";

/** The image variables to seed on a compose app: the compose defaults,
 *  re-pointed at `:live` when the project's workflow promotes it. */
export function deployImageDefaults(projectDir?: string): Record<string, string> {
  const defaults = readImageEnvDefaults(projectDir);
  return projectDir && workflowsPromotingLive(projectDir).length > 0
    ? liveImageRefs(defaults)
    : defaults;
}

export interface RunCoolifySetupOptions {
  /** GitHub repository URL — required when creating a new application
   *  (Coolify's `git_repository` field). Existing apps are matched by
   *  name and reused without it. */
  repoUrl?: string;
  /** Server-side container port. Coolify routes incoming traffic to
   *  this port via Traefik. The starter's Express server listens here
   *  in production (it also serves the built client assets). */
  serverPort?: number;
  /** Client dev port — currently unused by Coolify (no Vite dev server
   *  in production). Accepted for symmetry with `scaffoldInfra` and so
   *  future build-time / preview deploys have it. */
  clientPort?: number;
  /** The default `hatchkit create` path creates `gh repo create
   *  --private`. Private GitHub repos must be wired through a Coolify
   *  GitHub App source, not the public-repo endpoint, or Coolify accepts
   *  the app but later cannot clone/pull it. */
  isPrivateRepo?: boolean;
  /** Pre-resolved Coolify GitHub App source — picked upfront in the
   *  stepper (or edit loop) when the user selects a private repo, so the
   *  deploy step doesn't pause for an inline picker / walkthrough. */
  preresolvedGithubSource?: ResolvedGithubAppSource;
  /** Scaffolded project root. Used to read the compose file so routing
   *  can only ever name services that actually exist — a name that
   *  isn't in the compose is accepted by Coolify with a 200 and then
   *  produces no Traefik labels at all. */
  projectDir?: string;
  /** `hatchkit create --yes`: accept the native-client TRUSTED_ORIGINS
   *  diff without a prompt. Without it the diff is shown and confirmed
   *  interactively, and skipped (with the command to finish it) when
   *  there is no terminal to ask on. */
  assumeYes?: boolean;
}

export interface RunCoolifySetupResult {
  /** Coolify uuid of the created (or reused) application. The caller
   *  records this in the run ledger so a partial-create rollback can
   *  delete it via `CoolifyApi.deleteApplication`. */
  appUuid: string;
  /** Coolify uuid of the project the app lives in. Recorded in the run
   *  ledger when `projectCreated` is true, so rollback removes the
   *  empty project after the app/db steps. */
  projectUuid: string;
  /** True when this call POSTed `/projects` (vs. matched an existing
   *  Coolify project by name). The caller guards `ledger.record` on
   *  this so a rollback never deletes a project the user had before. */
  projectCreated: boolean;
  /** True when this call POSTed `/applications/...` (vs. matched an
   *  existing Coolify application by name). Same ledger guard
   *  reasoning as `projectCreated`. */
  appCreated: boolean;
  /** Every Coolify application this run created or reconciled. One
   *  entry for `single-origin`; two (`-client` + `-server`) for
   *  `split`. `appUuid` above is `apps[0].uuid` — the app that owns the
   *  bare domain — kept as a distinct field so existing single-app
   *  callers don't have to change. */
  apps: Array<{
    uuid: string;
    name: string;
    role: RoutedApp["role"];
    created: boolean;
  }>;
  /** Hostnames beyond the bare domain that this topology needs DNS for
   *  (`api.<domain>` under `split`). Terraform owns the bare domain's
   *  record on the create path; anything listed here still needs one. */
  extraDnsHostnames: string[];
  /** What happened to TRUSTED_ORIGINS on each server app. Empty for a
   *  project with no native client. */
  nativeOrigins: NativeOriginsOutcome[];
}

/** Create the Coolify project + application for this hatchkit project,
 *  idempotent across re-runs. Throws on hard failures so the caller's
 *  failure handler can offer a tailored cleanup. */
export async function runCoolifySetup(
  config: ProjectConfig,
  options: RunCoolifySetupOptions = {},
): Promise<RunCoolifySetupResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  }

  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  console.log(chalk.bold("\n  ── Coolify Setup ─────────────────────────────────────────\n"));

  const verify = ora(`Connecting to Coolify at ${cfg.url}`).start();
  try {
    const version = await api.getVersion();
    verify.succeed(`Connected to Coolify v${version}`);
  } catch (err) {
    verify.fail();
    throw new Error(`Cannot reach Coolify API at ${cfg.url}: ${(err as Error).message}`);
  }

  const serverUuid = await resolveServerUuid(api, config);
  const isPrivateRepo = options.isPrivateRepo ?? false;
  const repoRef = options.repoUrl
    ? normalizeCoolifyGitRepository(options.repoUrl, isPrivateRepo)
    : null;
  let githubAppUuid: string | undefined;
  let githubAppHtmlUrl: string | undefined;
  if (isPrivateRepo) {
    const source = options.preresolvedGithubSource ?? (await resolveGithubAppSource(api, cfg.url));
    githubAppUuid = source.uuid;
    githubAppHtmlUrl = source.htmlUrl;
    if (repoRef && repoRef.gitRepository !== options.repoUrl) {
      console.log(chalk.dim(`  Git source: ${repoRef.gitRepository} (Coolify GitHub App)`));
    }
    // Proactively add the (possibly freshly-created) repo to the
    // GitHub App's selected-repos list. Without this, Coolify's
    // /applications/private-github-app POST 404s with "Repository not
    // found or not accessible by the GitHub App." The grant helper is
    // best-effort — if it fails, the create call's retry/abort loop
    // below surfaces a manual remediation prompt.
    if (repoRef) {
      await ensureRepoVisibleToCoolifyApp({
        appHtmlUrl: githubAppHtmlUrl,
        repoSlug: repoRef.gitRepository,
      });
    }
  }

  // Project: reuse one with the same name when present. The old bash
  // script always created a new one, which left orphan empty projects
  // behind on every retry.
  //
  // Description: prefer the user-supplied one (collected by the create
  // prompt + survives the review-edit loop). Empty falls through to
  // Coolify's default — undefined is also fine; the API treats absent
  // and empty alike.
  const description = config.description?.trim() || undefined;
  let projectUuid: string;
  let projectCreated = false;
  const existingProject = await api.findProjectByName(config.name);
  if (existingProject) {
    projectUuid = existingProject.uuid;
    console.log(chalk.dim(`  Using existing Coolify project ${config.name} (${projectUuid})`));
    // Reconcile description on re-runs when the user supplied one,
    // matching the adopt-side semantics: don't clobber a description
    // edited in the Coolify dashboard, but do push the user's value
    // when they took the trouble to fill the prompt.
    if (description) {
      try {
        await api.updateProject(existingProject.uuid, { description });
      } catch (err) {
        console.log(
          chalk.dim(`  · Couldn't update Coolify project description: ${(err as Error).message}`),
        );
      }
    }
  } else {
    const project = await api.createProject(config.name, description);
    projectUuid = project.uuid;
    projectCreated = true;
    console.log(chalk.green(`  ✓ Project created: ${config.name} (${projectUuid})`));
  }

  // ── Routing ────────────────────────────────────────────────────────
  //
  // Delegated wholesale to deploy/routing.ts so `create`, `adopt` and
  // `sync` cannot drift apart again. That module also documents the two
  // Coolify behaviours this used to get wrong:
  //
  //   · `docker_compose_domains` is STORED as a map keyed by service
  //     name, so the old code's four separate `server` entries were a
  //     silent last-wins collapse — `https://<domain>/api` never
  //     existed on any project hatchkit created. Several FQDNs for one
  //     service have to be comma-joined into one entry instead.
  //   · a non-`/` path pulls in Coolify's Traefik `stripprefix`
  //     middleware, so `/api/health` would arrive at Express as
  //     `/health`. `stripPrefix` below turns that off.
  const composeServices = composeServicesOf(options.projectDir);
  const runtime = config.coolifyRuntime ?? "compose";
  const plan = computeRoutingPlan({
    name: config.name,
    domain: config.domain,
    topology: config.topology ?? "single-origin",
    surfaces: config.surfaces ?? "fullstack",
    ports: { server: options.serverPort, client: options.clientPort },
    publicService: config.publicService,
    composeServices,
    runtime,
    ...(runtime === "image"
      ? {
          images: imageRefsForProject({
            projectDir: options.projectDir,
            repoSlug: repoSlugFromCoolifyGitRepository(repoRef?.gitRepository),
          }),
          containerPorts: {
            app: STARTER_CONTAINER_PORT,
            client: STARTER_CONTAINER_PORT,
            server: STARTER_CONTAINER_PORT,
          },
        }
      : {}),
  });

  console.log(chalk.dim(`  Topology: ${plan.topology} · runtime: ${runtime}`));
  for (const app of plan.apps) {
    console.log(chalk.dim(`  Domain routing — ${app.appName}:`));
    for (const entry of app.composeDomains) {
      console.log(chalk.dim(`    ${entry.name} → ${entry.domain}`));
    }
    if (app.runtime === "image") {
      for (const url of app.flatDomains) console.log(chalk.dim(`    → ${url}`));
      if (app.image)
        console.log(
          chalk.dim(`    image ${formatImageRef(app.image)} · health ${app.healthCheck?.path}`),
        );
    }
    if (app.stripPrefix === false) {
      console.log(chalk.dim("    (path-prefix stripping disabled so /api survives to the server)"));
    }
  }
  if (plan.extraDnsHostnames.length > 0) {
    console.log(
      chalk.dim(`  Extra DNS needed: ${plan.extraDnsHostnames.map((h) => `A ${h}`).join(", ")}`),
    );
  }

  // Fail loudly rather than pushing a service name the compose doesn't
  // declare: Coolify answers such a PATCH with 200 OK, emits no Traefik
  // labels, and every request to the app 503s. A hard error here is far
  // cheaper to debug than a green create followed by a dead domain.
  for (const app of plan.apps) {
    const validation = validateComposeServices(
      options.projectDir,
      app.role === "compose" ? app.requiredComposeServices : [],
    );
    if (!validation.ok) {
      throw new Error(
        `Coolify routing for "${app.appName}" names compose service(s) ` +
          `${validation.missing.map((m) => `"${m}"`).join(", ")}, but ${validation.composeFile} ` +
          `declares only: ${validation.declaredServices.join(", ")}. ` +
          `Coolify would accept this and then serve 503s. ` +
          `Set "publicService" in .hatchkit.json to one of the declared services and re-run.`,
      );
    }
  }

  // Application(s): reuse-by-name. `findApplicationByName` matches
  // across every project the user can see; first hit wins. Within a
  // single hatchkit-managed Coolify install, project names are unique
  // enough that a hit means "the same app" — same assumption
  // coolify-mongo makes when it resolves the project.
  const provisioned: RunCoolifySetupResult["apps"] = [];
  for (const routed of plan.apps) {
    provisioned.push(
      await provisionRoutedApp({
        api,
        routed,
        projectUuid,
        serverUuid,
        description,
        repoRef,
        isPrivateRepo,
        githubAppUuid,
        githubAppHtmlUrl,
      }),
    );
  }

  const appUuid = provisioned[0].uuid;
  const appCreated = provisioned.some((a) => a.created);

  // Env vars on the Coolify application. Keep this list minimal —
  // anything secret (DB URLs, S3 creds, JWT secrets, …) goes into
  // .env.production and is decrypted at runtime via the dotenvx
  // private key that `hatchkit keys push` puts on Coolify. That keeps
  // prod secrets out of Coolify's UI.
  //
  // Static scaffolds get only NODE_ENV — there's no server to honour
  // PORT (the Next.js standalone server already binds 3000) and
  // FRONTEND_URL is meaningless without a CORS-checking backend.
  const surfaces = config.surfaces ?? "fullstack";
  if (runtime === "image") {
    // One container per app, so each gets exactly its own env. PORT is
    // the port Traefik forwards to (`ports_exposes`), and has to be:
    // there is no compose file pinning it any more.
    for (const app of provisioned) {
      const routed = plan.apps.find((r) => r.appName === app.name) ?? plan.apps[0];
      const envs: Record<string, string> = { NODE_ENV: "production", PORT: routed.portsExposes };
      if (app.role === "server" || (app.role === "app" && surfaces === "backend")) {
        envs.FRONTEND_URL = `https://${config.domain}`;
      }
      await api.setAppEnv(app.uuid, envs);
    }
    console.log(chalk.green(`  ✓ Set env vars on ${provisioned.length} image application(s)`));
  }
  const envs: Record<string, string> =
    surfaces === "static"
      ? { NODE_ENV: "production" }
      : {
          NODE_ENV: "production",
          PORT: String(options.serverPort ?? 3000),
          FRONTEND_URL: `https://${config.domain}`,
        };
  // Seed SERVER_IMAGE / CLIENT_IMAGE with the compose file's own
  // defaults. The deploy job repoints these at the immutable `:<sha>`
  // tag on every push, and Coolify's env API only UPDATES an existing
  // variable — a PATCH naming a key that isn't there returns 200 and
  // does nothing, so the pin silently no-ops and the app keeps running
  // whatever `:main` resolved to. Seeding the same value the compose
  // already defaults to changes nothing about what runs; it just makes
  // the key exist.
  //
  // A project whose workflow promotes `:live` (the signed deploy) gets
  // `:live` instead: nothing moves any other tag on deploy.
  Object.assign(envs, deployImageDefaults(options.projectDir));
  // Every app in the plan gets the same baseline. Under `split` the
  // client app has no use for PORT/FRONTEND_URL, but Coolify env is
  // additive and harmless, and keeping one code path means the two
  // halves can't drift.
  if (runtime === "compose") {
    for (const app of provisioned) {
      await api.setAppEnv(app.uuid, envs);
    }
    console.log(
      chalk.green(
        `  ✓ Set ${Object.keys(envs).length} env vars on ${provisioned.length} application(s) (${Object.keys(envs).join(", ")})`,
      ),
    );
  }

  // Native shells (Capacitor / Electron) load the client from
  // their own document origin, which better-auth rejects with 403
  // INVALID_ORIGIN unless TRUSTED_ORIGINS names it. The minimal env
  // above can't carry it: projects whose production env lives in
  // Coolify rather than a committed .env.production would never see the
  // value the scaffold wrote into .env.example. Merged, confirmed and
  // read back — see deploy/trusted-origins.ts. Server app only.
  const nativeOrigins = await pushNativeOriginsToServerApps({
    api,
    apps: provisioned,
    features: config.features,
    surfaces,
    yes: options.assumeYes,
  });

  console.log(chalk.green("\n  ✓ Coolify app stack created"));

  return {
    appUuid,
    projectUuid,
    projectCreated,
    appCreated,
    apps: provisioned,
    extraDnsHostnames: plan.extraDnsHostnames,
    nativeOrigins,
  };
}

/** Create-or-reconcile ONE Coolify application against its slice of the
 *  routing plan. Split out of `runCoolifySetup` because `split`
 *  topology runs it twice and the two calls must be identical apart
 *  from the name / domains / ports they carry.
 *
 *  Every field pushed here is idempotent, so a re-run converges rather
 *  than duplicating. `is_stripprefix_enabled` rides along only when the
 *  plan has an opinion about it — a path-free layout leaves the field
 *  unsent, because Coolify attaches no stripprefix middleware there and
 *  some builds reject the key outright. */
export async function provisionRoutedApp(args: {
  api: CoolifyApi;
  routed: RoutedApp;
  projectUuid: string;
  serverUuid: string;
  description?: string;
  repoRef: { gitRepository: string } | null;
  isPrivateRepo: boolean;
  githubAppUuid?: string;
  githubAppHtmlUrl?: string;
  /** Take the domain even when Coolify reports it as claimed. Threaded
   *  into the reconcile PATCH (where Coolify honours it) and into the
   *  create body (where, for `dockercompose`, Coolify strips it before
   *  reading it — see ApplicationCreateInput.forceDomainOverride). Do
   *  not present this to users as a fix for a create-time 409. */
  forceDomainOverride?: boolean;
}): Promise<{ uuid: string; name: string; role: RoutedApp["role"]; created: boolean }> {
  const { api, routed, projectUuid, serverUuid, description, repoRef, isPrivateRepo } = args;

  // Accept the alias names when LOOKING UP an existing app so a
  // hand-rolled `<name>-backend` / `<name>-frontend` pair is reconciled
  // in place instead of being shadowed by a second, empty app.
  let existingApp = await api.findApplicationByName(routed.appName);
  if (!existingApp) {
    for (const alias of routed.aliases) {
      existingApp = await api.findApplicationByName(alias);
      if (existingApp) {
        console.log(
          chalk.dim(
            `  Matched existing Coolify app "${alias}" for the ${routed.role} half ` +
              `(hatchkit's own name would be "${routed.appName}").`,
          ),
        );
        break;
      }
    }
  }

  if (routed.runtime === "image") {
    return provisionImageApp({ ...args, existingApp });
  }

  if (existingApp) {
    console.log(
      chalk.dim(`  Using existing Coolify application ${existingApp.name} (${existingApp.uuid})`),
    );
    // A stale manifest (no `coolifyRuntime`, so read as compose) must
    // never turn a migrated image app back into a compose app: that
    // would put the project straight back on stop-then-start deploys,
    // and the compose file it would build from may no longer exist.
    const live = await api.getApplication(existingApp.uuid).catch(() => null);
    if (live?.buildPack === "dockerimage") {
      console.log(
        chalk.yellow(
          `  ${existingApp.name} is a Docker Image app (zero-downtime deploys) but this project's manifest\n` +
            '  says compose. Left it as it is. Set "coolifyRuntime": "image" in .hatchkit.json.',
        ),
      );
      return {
        uuid: existingApp.uuid,
        name: existingApp.name || routed.appName,
        role: routed.role,
        created: false,
      };
    }
    const reconcile = ora(`Reconciling Coolify app source + routing (${existingApp.name})`).start();
    try {
      await api.updateApplication(existingApp.uuid, {
        buildPack: "dockercompose",
        portsExposes: routed.portsExposes,
        dockerComposeLocation: routed.composeLocation,
        gitBranch: "main",
        gitRepository: repoRef?.gitRepository,
        githubAppUuid: isPrivateRepo ? args.githubAppUuid : undefined,
        description,
        dockerComposeDomains: routed.composeDomains,
        // Omitted entirely when the plan has no opinion — see
        // RoutedApp.stripPrefix.
        ...(routed.stripPrefix !== undefined ? { isStripprefixEnabled: routed.stripPrefix } : {}),
        forceDomainOverride: args.forceDomainOverride,
      });
      reconcile.succeed(`Coolify app source/routing reconciled (${existingApp.name})`);
    } catch (err) {
      reconcile.fail(`Coolify app reconcile failed: ${(err as Error).message}`);
      console.log(
        chalk.dim(
          "  Existing app kept. In Coolify, verify Build Pack = Docker Compose, Git source is the GitHub App source, and domains are attached to the right compose services.",
        ),
      );
    }
    return {
      uuid: existingApp.uuid,
      name: existingApp.name || routed.appName,
      role: routed.role,
      created: false,
    };
  }

  if (!repoRef) {
    throw new Error(
      "No GitHub repo URL — can't create the Coolify application. Did the GitHub step run?",
    );
  }
  const create = ora(`Creating application ${routed.appName}`).start();
  try {
    const createInput: ApplicationCreateInput = {
      projectUuid,
      serverUuid,
      environmentName: "production",
      gitRepository: repoRef.gitRepository,
      gitBranch: "main",
      // Canonical pipeline: GitHub Actions builds → pushes to GHCR →
      // Coolify pulls via docker-compose.yml (scaffolded at the repo
      // root by `scaffoldBuildPipeline`). `dockerfile` here would
      // ignore that compose file and try to build the repo directly,
      // which fails on the monorepo layout.
      buildPack: "dockercompose",
      dockerComposeLocation: routed.composeLocation,
      // Coolify still requires a `ports_exposes` value even for
      // dockercompose apps — it's metadata once the compose file
      // takes over.
      portsExposes: routed.portsExposes,
      name: routed.appName,
      description,
      // Per-service routing. Bypasses the `domains`-flat translation in
      // coolify-api.ts because the starter's compose has more than one
      // public service.
      dockerComposeDomains: routed.composeDomains,
      forceDomainOverride: args.forceDomainOverride,
      // First deploy lands via GitHub Actions on first push, so we
      // don't need Coolify to start the (empty) container right now.
      instantDeploy: false,
    };
    const created = isPrivateRepo
      ? await createPrivateAppWithRetry({
          api,
          createInput,
          githubAppUuid: args.githubAppUuid as string,
          githubAppHtmlUrl: args.githubAppHtmlUrl,
          repoSlug: repoRef.gitRepository,
          spinner: create,
          appName: routed.appName,
        })
      : await api.createApplicationFromPublicRepo(createInput);
    create.succeed(`Application created: ${routed.appName} (${created.uuid})`);

    // `is_stripprefix_enabled` isn't accepted on the create endpoints,
    // so path-scoped routing needs this follow-up PATCH. Without it
    // Coolify strips `/api` and every API call 404s at Express.
    if (routed.stripPrefix === false) {
      const strip = ora("Coolify: disabling path-prefix stripping").start();
      try {
        await api.updateApplication(created.uuid, { isStripprefixEnabled: false });
        strip.succeed("Coolify: path-prefix stripping disabled (so /api reaches the server)");
      } catch (err) {
        strip.fail(`Coolify: couldn't disable path-prefix stripping — ${(err as Error).message}`);
        console.log(
          chalk.yellow(
            `  Turn "Strip Prefix" OFF on ${routed.appName} in Coolify, or every /api request will 404.`,
          ),
        );
      }
    }
    return { uuid: created.uuid, name: routed.appName, role: routed.role, created: true };
  } catch (err) {
    // The private-repo path may have stopped the spinner itself with
    // a tailored message. Don't overwrite that with a generic fail.
    if (create.isSpinning) create.fail();
    throw err;
  }
}

/** `provisionRoutedApp` for an `image`-runtime app: create or reconcile
 *  a Coolify Docker Image application (deploy/image-runtime.ts).
 *
 *  Reconcile never sends `docker_registry_image_tag`. After the first
 *  push the deploy job owns that field — it pins each commit's sha — and
 *  resetting it to the plan's initial branch tag would quietly roll
 *  production back to whatever that mutable tag points at.
 *
 *  An existing `dockercompose` app under the same name is left alone.
 *  Converting it in place would restart the site as a different kind of
 *  app with no way to test the result first; `hatchkit migrate-runtime`
 *  does that move side by side, with a verified cutover. */
async function provisionImageApp(args: {
  api: CoolifyApi;
  routed: RoutedApp;
  projectUuid: string;
  serverUuid: string;
  description?: string;
  forceDomainOverride?: boolean;
  existingApp: { uuid: string; name: string } | null;
}): Promise<{ uuid: string; name: string; role: RoutedApp["role"]; created: boolean }> {
  const { api, routed, existingApp } = args;
  const pathOpinion =
    routed.stripPrefix !== undefined ? { isStripprefixEnabled: routed.stripPrefix } : {};

  if (existingApp) {
    const live = await api.getApplication(existingApp.uuid);
    const name = existingApp.name || routed.appName;
    if (live.buildPack === "dockercompose") {
      console.log(
        chalk.yellow(
          `  ${name} already exists as a Docker Compose app — its deploys stop the site.\n` +
            `  Left it untouched. Move it with: hatchkit migrate-runtime ${name} --dry-run`,
        ),
      );
      return { uuid: existingApp.uuid, name, role: routed.role, created: false };
    }
    const reconcile = ora(`Reconciling Coolify image app (${name})`).start();
    try {
      const result = await api.updateApplication(existingApp.uuid, {
        portsExposes: routed.portsExposes,
        domains: routed.flatDomains,
        ...(routed.image ? { dockerRegistryImageName: routed.image.name } : {}),
        ...(routed.healthCheck ? { healthCheck: routed.healthCheck } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...pathOpinion,
        forceDomainOverride: args.forceDomainOverride,
      });
      reconcile.succeed(`Coolify image app reconciled (${name})`);
      if (result.droppedFields.includes("is_stripprefix_enabled")) {
        printStripPrefixManualStep(name);
      }
    } catch (err) {
      reconcile.fail(`Coolify image app reconcile failed: ${(err as Error).message}`);
    }
    return { uuid: existingApp.uuid, name, role: routed.role, created: false };
  }

  if (!routed.image) {
    throw new Error(
      `No container image for "${routed.appName}" (${routed.role}). An image-runtime app pulls the ` +
        "image GitHub Actions pushes to GHCR; hatchkit reads its name from the compose file's " +
        "`${SERVER_IMAGE:-…}` / `${CLIENT_IMAGE:-…}` / `${APP_IMAGE:-…}` defaults.",
    );
  }
  const create = ora(`Creating image application ${routed.appName}`).start();
  try {
    const created = await api.createDockerImageApplication({
      projectUuid: args.projectUuid,
      serverUuid: args.serverUuid,
      environmentName: "production",
      name: routed.appName,
      description: args.description,
      image: routed.image,
      portsExposes: routed.portsExposes,
      domains: routed.flatDomains,
      healthCheck:
        routed.healthCheck ?? healthCheckFor(routed.role === "server" ? "server" : "app"),
      forceDomainOverride: args.forceDomainOverride,
      // The first deploy lands from GitHub Actions, once the image exists.
      instantDeploy: false,
    });
    create.succeed(
      `Application created: ${routed.appName} (${created.uuid}) — Docker Image, rolling deploys`,
    );
    if (routed.stripPrefix === false) {
      const strip = ora("Coolify: disabling path-prefix stripping").start();
      try {
        const result = await api.updateApplication(created.uuid, { isStripprefixEnabled: false });
        if (result.droppedFields.includes("is_stripprefix_enabled")) {
          strip.warn("Coolify: this build won't take the path-prefix setting over the API");
          printStripPrefixManualStep(routed.appName);
        } else {
          strip.succeed("Coolify: path-prefix stripping disabled (so /api reaches the server)");
        }
      } catch (err) {
        strip.fail(`Coolify: couldn't disable path-prefix stripping — ${(err as Error).message}`);
        printStripPrefixManualStep(routed.appName);
      }
    }
    return { uuid: created.uuid, name: routed.appName, role: routed.role, created: true };
  } catch (err) {
    if (create.isSpinning) create.fail();
    throw err;
  }
}

function printStripPrefixManualStep(appName: string): void {
  console.log(
    chalk.yellow(
      `  Turn "Strip Prefixes" OFF on ${appName} in Coolify (Configuration → Advanced), then redeploy,\n` +
        "  or every /api request reaches the server without its /api prefix and 404s.",
    ),
  );
}

/** Port every starter image binds inside its container (`PORT`, default
 *  3000 in both the server and client Dockerfiles). */
const STARTER_CONTAINER_PORT = 3000;

/** GHCR image per role for an image-runtime project.
 *
 *  The compose file's `${SERVER_IMAGE:-…}` / `${CLIENT_IMAGE:-…}` /
 *  `${APP_IMAGE:-…}` defaults are the source of truth — they name what
 *  the GitHub Actions workflow pushes. A default still carrying the
 *  starter's `OWNER/REPO` placeholder is ignored in favour of the repo
 *  slug, which is what the workflow's `${{ github.repository }}` expands
 *  to. GHCR names are lowercase. */
export function imageRefsForProject(args: {
  projectDir?: string;
  repoSlug?: string;
}): { app?: string; client?: string; server?: string } {
  const defaults = readImageEnvDefaults(args.projectDir);
  const usable = (ref: string | undefined): string | undefined =>
    ref && !/OWNER\/REPO/.test(ref) ? ref : undefined;
  const slug = args.repoSlug?.toLowerCase();
  const fromSlug = (suffix: string): string | undefined =>
    slug ? `ghcr.io/${slug}${suffix}:main` : undefined;
  const refs = {
    app: usable(defaults.APP_IMAGE),
    client: usable(defaults.CLIENT_IMAGE) ?? fromSlug("-client"),
    server: usable(defaults.SERVER_IMAGE) ?? fromSlug("-server"),
  };
  // Under the signed deploy the workflow promotes `:live`, and that is
  // the only tag an app may pull: nothing else moves on deploy.
  return args.projectDir && workflowsPromotingLive(args.projectDir).length > 0
    ? liveImageRefs(refs)
    : refs;
}

export interface ResolvedGithubAppSource {
  uuid: string;
  htmlUrl?: string;
}

/** Resolve (or walk the user through configuring) the Coolify GitHub App
 *  source used to clone a private repo. Designed to be called upfront in
 *  the create stepper as soon as the user picks `visibility: private`,
 *  so the deploy step can run unattended.
 *
 *  Returns `null` when Coolify isn't configured — the deploy step will
 *  surface a hard failure later, which is the right place for that
 *  diagnostic. Throws on any other error (no sources after walkthrough,
 *  user aborts) so the stepper fails loudly before scaffolding starts. */
export async function prefetchCoolifyGithubAppSource(): Promise<ResolvedGithubAppSource | null> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return null;
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  return resolveGithubAppSource(api, cfg.url);
}

async function resolveGithubAppSource(
  api: CoolifyApi,
  coolifyUrl: string,
): Promise<ResolvedGithubAppSource> {
  let sources = await api.listGithubSources();
  if (sources.length === 0) {
    // Just-in-time: the user asked for a private repo but never ran
    // the Coolify GitHub App walkthrough. Offer to run it inline so
    // they don't have to abort + rerun. The walkthrough is the same
    // one wired into `hatchkit setup` and
    // `hatchkit config add coolify-github-app`.
    const sourcesUrl = `${coolifyUrl.replace(/\/$/, "")}/sources`;
    const { select } = await import("@inquirer/prompts");
    console.log(
      chalk.yellow(`\n  Private repo selected, but Coolify has no GitHub App source configured.`),
    );
    const choice = await select<"walkthrough" | "abort">({
      message: "What now?",
      choices: [
        {
          name: "Run the GitHub App walkthrough now (recommended)",
          value: "walkthrough",
          description: `Opens ${sourcesUrl} + walks through registering & installing the App.`,
        },
        {
          name: "Abort the create and roll back",
          value: "abort",
          description:
            "Re-run with --public, OR run `hatchkit config add coolify-github-app`, then `hatchkit create` again.",
        },
      ],
      default: "walkthrough",
    });
    if (choice === "abort") {
      throw new Error(
        `Aborted by user: no Coolify GitHub App source configured. ` +
          `Run \`hatchkit config add coolify-github-app\` (or re-run with --public).`,
      );
    }
    const { ensureCoolifyGithubApp } = await import("./coolify-github-app.js");
    const result = await ensureCoolifyGithubApp();
    if (!result.ok) {
      throw new Error(
        `Coolify GitHub App walkthrough did not complete. ` +
          `Re-run \`hatchkit config add coolify-github-app\` (or re-run \`hatchkit create\` with --public).`,
      );
    }
    sources = await api.listGithubSources();
    if (sources.length === 0) {
      throw new Error(
        `Coolify still reports no GitHub sources after the walkthrough. ` +
          `Check ${sourcesUrl} manually.`,
      );
    }
  }
  if (sources.length === 1) {
    console.log(chalk.dim(`  Using Coolify GitHub source "${sources[0].name}".`));
    return { uuid: sources[0].uuid, htmlUrl: sources[0].html_url };
  }
  const { select } = await import("@inquirer/prompts");
  const picked = await select<ResolvedGithubAppSource>({
    message: "Pick the Coolify GitHub source for this private repo:",
    choices: sources.map((s) => ({
      name: `${s.name}${s.html_url ? `  ${chalk.dim(s.html_url)}` : ""}`,
      value: { uuid: s.uuid, htmlUrl: s.html_url },
    })),
  });
  return picked;
}

/** Best-effort: ensure the Coolify GitHub App can clone `repoSlug`.
 *  Logs the outcome but never throws — the retry/abort loop on app
 *  create is the authoritative gate. */
async function ensureRepoVisibleToCoolifyApp(input: {
  appHtmlUrl: string | undefined;
  repoSlug: string;
}): Promise<void> {
  const grant = await ensureCoolifyAppHasRepoAccess(input);
  switch (grant.kind) {
    case "granted":
      console.log(
        chalk.green(
          `  ✓ Granted Coolify GitHub App "${grant.appSlug}" access to ${input.repoSlug}`,
        ),
      );
      return;
    case "already-all-repos":
      console.log(
        chalk.dim(
          `  · Coolify GitHub App "${grant.appSlug}" already has access to all repos in ${grant.account}.`,
        ),
      );
      return;
    case "already-selected":
      console.log(
        chalk.dim(`  · Coolify GitHub App "${grant.appSlug}" already includes ${input.repoSlug}.`),
      );
      return;
    case "failed":
      console.log(
        chalk.yellow(
          `  · Couldn't auto-grant GitHub App access (${grant.reason}). ` +
            `If the next step 404s, grant access at ${grant.installSettingsUrl ?? grant.installUrl} and retry.`,
        ),
      );
      return;
  }
}

interface CreatePrivateAppArgs {
  api: CoolifyApi;
  createInput: ApplicationCreateInput;
  githubAppUuid: string;
  githubAppHtmlUrl: string | undefined;
  repoSlug: string;
  spinner: ReturnType<typeof ora>;
  appName: string;
}

/** Wrap `createApplicationFromPrivateGithubApp` in a retry loop. On a
 *  GitHub-App-access 404 the user gets a manual remediation prompt
 *  with the install URL; choosing "abort" throws so the create flow's
 *  existing rollback recipe + per-step confirmation runs.
 *
 *  Why a loop instead of one-shot: the proactive grant above succeeds
 *  in the common case, but org installs with branch-protection rules,
 *  installs the user can't admin from the CLI, and the half-second
 *  GitHub→Coolify propagation gap all show up here. Letting the user
 *  click + retry is much cheaper than a full create rerun. */
async function createPrivateAppWithRetry(
  args: CreatePrivateAppArgs,
): Promise<{ uuid: string; fqdn?: string }> {
  const { api, createInput, githubAppUuid, githubAppHtmlUrl, repoSlug, spinner, appName } = args;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await api.createApplicationFromPrivateGithubApp({
        ...createInput,
        githubAppUuid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isGithubAppAccessError(message)) throw err;

      spinner.fail(`Coolify can't see ${repoSlug} through the GitHub App.`);

      const { select } = await import("@inquirer/prompts");
      const appSlug = appSlugFromHtmlUrl(githubAppHtmlUrl);
      const fallbackInstallUrl = appSlug
        ? installUrlForSlug(appSlug)
        : "https://github.com/settings/installations";
      const grant = await ensureCoolifyAppHasRepoAccess({
        appHtmlUrl: githubAppHtmlUrl,
        repoSlug,
      });
      const remediationUrl =
        (grant.kind === "failed" && (grant.installSettingsUrl ?? grant.installUrl)) ||
        fallbackInstallUrl;

      console.log(
        chalk.yellow(
          `\n  Grant the Coolify GitHub App access to ${chalk.bold(repoSlug)}, then retry.\n` +
            `    Open: ${remediationUrl}\n` +
            `    On the installation page → "Repository access" → "Only select repositories" → add ${repoSlug}.\n`,
        ),
      );

      const choice = await select<"retry" | "abort">({
        message: `Coolify app create failed (attempt ${attempt}). What now?`,
        choices: [
          {
            name: "Retry — I've granted access in the GitHub UI",
            value: "retry",
            description: "Re-attempts the proactive grant + Coolify app create.",
          },
          {
            name: "Abort — roll back the partial create",
            value: "abort",
            description:
              "Stops the create. The existing rollback recipe + per-step confirmation will run.",
          },
        ],
        default: "retry",
      });

      if (choice === "abort") {
        throw new Error(
          `Aborted by user: Coolify GitHub App could not access ${repoSlug}. ` +
            `Grant access at ${remediationUrl} and re-run \`hatchkit create\` to resume.`,
        );
      }

      // Restart the spinner so the next attempt's success/fail line
      // looks like the first one.
      spinner.start(`Creating application ${appName} (attempt ${attempt + 1})`);
      // Loop body re-runs the create call.
    }
  }
}

function isGithubAppAccessError(message: string): boolean {
  // Coolify returns 404 with this exact body when the GitHub App can't
  // see the repo. Match defensively — older Coolify builds may phrase
  // it differently but always include "not accessible" or "not found".
  if (/Repository not found or not accessible by the GitHub App/i.test(message)) return true;
  if (/private-github-app failed:\s*404/i.test(message)) return true;
  return false;
}

function normalizeCoolifyGitRepository(
  remoteUrl: string,
  isPrivate: boolean,
): { gitRepository: string; webUrl?: string } {
  const slug = repoSlugFromRemote(remoteUrl);
  if (!slug) return { gitRepository: remoteUrl };
  const webUrl = `https://github.com/${slug}`;
  return { gitRepository: isPrivate ? slug : webUrl, webUrl };
}

/** Resolve the Coolify server uuid for this project. The prompt flow
 *  populates `config.serverUuid` for `existing` deploys; for new
 *  Hetzner deploys (or older cached configs) we fall back to ip- or
 *  first-server lookup. */
async function resolveServerUuid(api: CoolifyApi, config: ProjectConfig): Promise<string> {
  if (config.serverUuid) return config.serverUuid;

  if (config.serverIp) {
    const found = await api.findServer({ ip: config.serverIp });
    if (found) return found.uuid;
  }

  const servers = await api.listServers();
  const first = servers[0];
  if (!first) {
    throw new Error("No Coolify servers configured. Add one in the Coolify dashboard first.");
  }
  // listServers returns the numeric `id` only; resolve the uuid via
  // findServer (Coolify's /servers includes both fields, our typed
  // wrapper just doesn't expose uuid in the list shape).
  const found = await api.findServer({ ip: first.ip });
  if (!found) {
    throw new Error(`Couldn't resolve Coolify uuid for server "${first.name}" (${first.ip}).`);
  }
  return found.uuid;
}
