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
 *      FRONTEND_URL). App secrets and DB URLs go into encrypted
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
import { type ApplicationCreateInput, CoolifyApi } from "../utils/coolify-api.js";
import { repoSlugFromRemote } from "./gh-actions-secrets.js";
import {
  appSlugFromHtmlUrl,
  ensureCoolifyAppHasRepoAccess,
  installUrlForSlug,
} from "./github-app-access.js";

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
    const source = await resolveGithubAppSource(api, cfg.url);
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

  // Domain routing — surface-aware. Coolify's dockercompose build pack
  // rejects a flat `domains` field (422 — "Use docker_compose_domains
  // instead …") because routing is per-service.
  //
  //  · both        — `client` gets the bare hostname; `server` gets the
  //                  api subdomain + the path-based API/WS hosts.
  //  · server-only — no client service in the pruned compose, so the
  //                  bare hostname AND every API/WS host all point at
  //                  `server`. Browsers hitting `<domain>` reach the
  //                  Express app directly (which can still serve a 200
  //                  health page or redirect to the api host).
  //  · client-only — only the `client` service exists; nothing public
  //                  about the API is needed. Currently unreachable
  //                  from `hatchkit create` (the scaffold step throws
  //                  before we get here) but the branch is wired so
  //                  `hatchkit adopt`-driven client-only callers and a
  //                  future create-side implementation share one path.
  const apiDomain = `api.${config.domain}`;
  const frontendDomain = `https://${config.domain}`;
  const backendDomains = [
    `https://${apiDomain}`,
    `https://${config.domain}/api`,
    `https://${config.domain}/api/ws`,
    `https://${apiDomain}/ws`,
  ];
  const surfaces = config.surfaces ?? "fullstack";
  const dockerComposeDomains: Array<{ name: string; domain: string }> =
    surfaces === "static"
      ? [{ name: "client", domain: frontendDomain }]
      : surfaces === "backend"
        ? [
            { name: "server", domain: frontendDomain },
            ...backendDomains.map((domain) => ({ name: "server", domain })),
          ]
        : [
            { name: "client", domain: frontendDomain },
            ...backendDomains.map((domain) => ({ name: "server", domain })),
          ];

  console.log(chalk.dim("  Domain routing:"));
  if (surfaces === "static") {
    console.log(chalk.dim(`    Frontend (client): ${frontendDomain}`));
  } else if (surfaces === "backend") {
    console.log(
      chalk.dim(`    All hosts → server: ${[frontendDomain, ...backendDomains].join(", ")}`),
    );
  } else {
    console.log(chalk.dim(`    Frontend (client): ${frontendDomain}`));
    console.log(chalk.dim(`    Backend  (server): ${backendDomains.join(", ")}`));
  }

  // Application: reuse-by-name. `findApplicationByName` matches across
  // every project the user can see; first hit wins. Within a single
  // hatchkit-managed Coolify install, project names are unique enough
  // that a hit means "the same app" — same assumption coolify-mongo
  // makes when it resolves the project.
  const appName = config.name;
  let appUuid: string;
  let appCreated = false;
  const existingApp = await api.findApplicationByName(appName);
  if (existingApp) {
    appUuid = existingApp.uuid;
    console.log(chalk.dim(`  Using existing Coolify application ${appName} (${appUuid})`));
    const reconcile = ora("Reconciling Coolify app git source + routing").start();
    try {
      await api.updateApplication(appUuid, {
        buildPack: "dockercompose",
        portsExposes: String(options.serverPort ?? 3000),
        dockerComposeLocation: "/docker-compose.yml",
        gitBranch: "main",
        gitRepository: repoRef?.gitRepository,
        githubAppUuid: isPrivateRepo ? githubAppUuid : undefined,
        description,
        dockerComposeDomains,
      });
      reconcile.succeed("Coolify app source/routing reconciled");
    } catch (err) {
      reconcile.fail(`Coolify app reconcile failed: ${(err as Error).message}`);
      console.log(
        chalk.dim(
          "  Existing app kept. In Coolify, verify Build Pack = Docker Compose, Git source is the GitHub App source, and domains are attached to the right compose services.",
        ),
      );
    }
  } else {
    if (!repoRef) {
      throw new Error(
        "No GitHub repo URL — can't create the Coolify application. Did the GitHub step run?",
      );
    }
    const create = ora(`Creating application ${appName}`).start();
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
        // Coolify still requires a `ports_exposes` value even for
        // dockercompose apps — it's metadata once the compose file
        // takes over. The server's Express port is the conventional
        // pick.
        portsExposes: String(options.serverPort ?? 3000),
        name: appName,
        description,
        // Per-service routing (see comment above). Bypasses the
        // `domains`-flat translation in coolify-api.ts because the
        // starter's compose has more than one public service.
        dockerComposeDomains,
        // First deploy lands via GitHub Actions on first push, so we
        // don't need Coolify to start the (empty) container right now.
        instantDeploy: false,
      };
      const created = isPrivateRepo
        ? await createPrivateAppWithRetry({
            api,
            createInput,
            githubAppUuid: githubAppUuid as string,
            githubAppHtmlUrl,
            repoSlug: repoRef.gitRepository,
            spinner: create,
            appName,
          })
        : await api.createApplicationFromPublicRepo(createInput);
      appUuid = created.uuid;
      appCreated = true;
      create.succeed(`Application created: ${appName} (${appUuid})`);
    } catch (err) {
      // The private-repo path may have stopped the spinner itself with
      // a tailored message. Don't overwrite that with a generic fail.
      if (create.isSpinning) create.fail();
      throw err;
    }
  }

  // Env vars on the Coolify application. Keep this list minimal —
  // anything secret (DB URLs, S3 creds, JWT secrets, …) goes into
  // .env.production and is decrypted at runtime via the dotenvx
  // private key that `hatchkit keys push` puts on Coolify. That keeps
  // prod secrets out of Coolify's UI.
  //
  // Static scaffolds get only NODE_ENV — there's no server to honour
  // PORT (the Next.js standalone server already binds 3000) and
  // FRONTEND_URL is meaningless without a CORS-checking backend.
  const envs: Record<string, string> =
    surfaces === "static"
      ? { NODE_ENV: "production" }
      : {
          NODE_ENV: "production",
          PORT: String(options.serverPort ?? 3000),
          FRONTEND_URL: `https://${config.domain}`,
        };
  await api.setAppEnv(appUuid, envs);
  console.log(
    chalk.green(
      `  ✓ Set ${Object.keys(envs).length} env vars on application (${Object.keys(envs).join(", ")})`,
    ),
  );

  console.log(chalk.green("\n  ✓ Coolify app stack created"));

  return { appUuid, projectUuid, projectCreated, appCreated };
}

interface ResolvedGithubAppSource {
  uuid: string;
  htmlUrl?: string;
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
