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
 *   3. Application create-or-reuse (`<name>-web`, public-repo flavour).
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
import { CoolifyApi } from "../utils/coolify-api.js";

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
}

export interface RunCoolifySetupResult {
  /** Coolify uuid of the created (or reused) application. The caller
   *  records this in the run ledger so a partial-create rollback can
   *  delete it via `CoolifyApi.deleteApplication`. */
  appUuid: string;
  /** Coolify uuid of the project the app lives in. Recorded only for
   *  diagnostics — projects are NOT auto-deleted on rollback because
   *  they may already host other apps. */
  projectUuid: string;
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

  // Project: reuse one with the same name when present. The old bash
  // script always created a new one, which left orphan empty projects
  // behind on every retry.
  let projectUuid: string;
  const existingProject = await api.findProjectByName(config.name);
  if (existingProject) {
    projectUuid = existingProject.uuid;
    console.log(chalk.dim(`  Using existing Coolify project ${config.name} (${projectUuid})`));
  } else {
    const project = await api.createProject(config.name);
    projectUuid = project.uuid;
    console.log(chalk.green(`  ✓ Project created: ${config.name} (${projectUuid})`));
  }

  // Domain routing: five hosts on one container.
  //   · https://<domain>                — frontend
  //   · https://api.<domain>            — API subdomain
  //   · https://<domain>/api            — path-based API (same-origin → no CORS)
  //   · https://<domain>/api/ws         — websocket via path
  //   · https://api.<domain>/ws         — websocket via subdomain
  // Traefik forwards all five to the same Coolify app; the app's
  // Express router decides what to do based on Host + path.
  const apiDomain = `api.${config.domain}`;
  const domains = [
    `https://${config.domain}`,
    `https://${apiDomain}`,
    `https://${config.domain}/api`,
    `https://${config.domain}/api/ws`,
    `https://${apiDomain}/ws`,
  ];

  console.log(chalk.dim("  Domain routing:"));
  console.log(chalk.dim(`    Frontend: https://${config.domain}`));
  console.log(chalk.dim(`    Backend:  ${domains.slice(1).join(", ")}`));

  // Application: reuse-by-name. `findApplicationByName` matches across
  // every project the user can see; first hit wins. Within a single
  // hatchkit-managed Coolify install, project names are unique enough
  // that a hit means "the same app" — same assumption coolify-mongo
  // makes when it resolves the project.
  const appName = `${config.name}-web`;
  let appUuid: string;
  const existingApp = await api.findApplicationByName(appName);
  if (existingApp) {
    appUuid = existingApp.uuid;
    console.log(chalk.dim(`  Using existing Coolify application ${appName} (${appUuid})`));
  } else {
    if (!options.repoUrl) {
      throw new Error(
        "No GitHub repo URL — can't create the Coolify application. Did the GitHub step run?",
      );
    }
    const create = ora(`Creating application ${appName}`).start();
    try {
      const created = await api.createApplicationFromPublicRepo({
        projectUuid,
        serverUuid,
        environmentName: "production",
        gitRepository: options.repoUrl,
        gitBranch: "main",
        // Canonical pipeline: GitHub Actions builds → pushes to GHCR →
        // Coolify pulls via docker-compose.yml (scaffolded at the repo
        // root by `scaffoldBuildPipeline`). `dockerfile` here would
        // ignore that compose file and try to build the repo directly,
        // which fails on the monorepo layout.
        buildPack: "dockercompose",
        // Coolify exposes one container port. The starter's server
        // listens on `serverPort` and serves client assets in prod —
        // that's the right port to route to. The client dev port is a
        // build-time concern only.
        portsExposes: String(options.serverPort ?? 3000),
        name: appName,
        domains,
        // First deploy lands via GitHub Actions on first push, so we
        // don't need Coolify to start the (empty) container right now.
        instantDeploy: false,
      });
      appUuid = created.uuid;
      create.succeed(`Application created: ${appName} (${appUuid})`);
    } catch (err) {
      create.fail();
      throw err;
    }
  }

  // Env vars on the Coolify application. Keep this list minimal —
  // anything secret (DB URLs, S3 creds, JWT secrets, …) goes into
  // .env.production and is decrypted at runtime via the dotenvx
  // private key that `hatchkit keys push` puts on Coolify. That keeps
  // prod secrets out of Coolify's UI.
  const envs: Record<string, string> = {
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

  return { appUuid, projectUuid };
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
