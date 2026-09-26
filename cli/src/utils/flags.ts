/*
 * Command-line flag parsing for `hatchkit create`.
 *
 * Every question the interactive stepper asks has a matching flag. A
 * flag that is supplied lands in `presets`, and the corresponding
 * prompt is skipped (see the `skip:` guards in `collectProjectConfig`).
 * Anything left unsupplied is still prompted for — partial flag sets
 * are the normal case, not an all-or-nothing switch.
 *
 * `--yes` / `--non-interactive` additionally accepts defaults for
 * everything still unset and hard-fails (naming the missing flag)
 * instead of prompting, so the command is CI-safe.
 *
 * `--config <path>` stays as the bulk escape hatch: a JSON file
 * matching Partial<ProjectConfig>. Precedence is
 * flags > --config > prompt defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Topology } from "../deploy/routing.js";
import type {
  AnalyticsProvider,
  DeployTarget,
  DeploymentMode,
  EmailIntent,
  Feature,
  GitHubRepoVisibility,
  GpuPlatform,
  MlService,
  ProjectConfig,
  S3Provider,
  Surface,
} from "../prompts.js";
import type { ProvisionService } from "../provision/index.js";

export interface ParsedCreateFlags {
  /** Non-interactive: accept defaults, fail if a required value with
   *  no default is missing rather than prompting. */
  yes: boolean;
  /** --dry-run — already handled in index.ts but re-parsed here so
   *  one place knows the full set of supported flags. */
  dryRun: boolean;
  /** Preset values parsed from individual flags + --config file. */
  presets: Partial<ProjectConfig>;
  /** --no-github / --no-deploy / --no-install hard-disable those steps
   *  regardless of what the preset / prompts would say. */
  forceNoGithub: boolean;
  forceNoDeploy: boolean;
  forceNoInstall: boolean;
  /** --no-local-dev hard-disables the Tailscale dev URL opt-in even when
   *  `--local-dev` / a preset would have enabled it. Distinct from the
   *  absence of `--local-dev`: a fresh `hatchkit create` without flags
   *  still defaults to enabling the integration. */
  forceNoLocalDev: boolean;
}

// ---------------------------------------------------------------------------
// Allowed value sets — the single source of truth shared by the parser,
// the `printHelp("create")` text, and the flag tests.
// ---------------------------------------------------------------------------

export const KNOWN_FEATURES: readonly Feature[] = [
  "websocket",
  "stripe",
  "analytics",
  "s3",
  "workspaces",
  "desktop",
  "mobile",
  "release",
  "client-core",
  "extension",
];
export const KNOWN_ML_SERVICES: readonly MlService[] = [
  "3d-sam-objects",
  "3d-sam-body",
  "3d-hunyuan",
  "3d-trellis",
  "3d-extraction",
  "subtitles",
  "image-recognition",
  "background-removal",
  "custom-hf",
];
export const KNOWN_SURFACES: readonly Surface[] = ["fullstack", "split", "backend", "static"];
export const KNOWN_TOPOLOGIES: readonly Topology[] = ["single-origin", "split"];
export const KNOWN_DEPLOYMENT_MODES: readonly DeploymentMode[] = [
  "coolify",
  "gh-pages",
  "scaffold-only",
];
export const KNOWN_DEPLOY_TARGETS: readonly DeployTarget[] = ["existing", "new"];
export const KNOWN_SERVER_SIZES: readonly string[] = ["cpx21", "cpx31", "cpx41"];
export const KNOWN_SERVER_LOCATIONS: readonly string[] = ["nbg1", "fsn1", "hel1"];
export const KNOWN_S3_PROVIDERS: readonly S3Provider[] = [
  "hetzner",
  "r2",
  "aws",
  "existing",
  "none",
];
export const KNOWN_DB_ENGINES: readonly ("mongodb" | "postgres")[] = ["mongodb", "postgres"];
export const KNOWN_DB_PROVIDERS: readonly ("coolify" | "external")[] = ["coolify", "external"];
export const KNOWN_GITHUB_VISIBILITIES: readonly GitHubRepoVisibility[] = ["private", "public"];
export const KNOWN_ANALYTICS_PROVIDERS: readonly AnalyticsProvider[] = [
  "glitchtip",
  "openpanel",
  "plausible",
];
export const KNOWN_PROVISION_SERVICES: readonly ProvisionService[] = [
  "glitchtip",
  "openpanel",
  "plausible",
  "listmonk-ses",
  "s3",
  "email",
  "search-console",
];
export const KNOWN_GPU_PLATFORMS: readonly GpuPlatform[] = ["modal", "runpod", "hf", "replicate"];
/** `--email` is asked as one question in the stepper ("what does this
 *  project need to send?"), so it gets one flag with the same four
 *  answers rather than a provider-per-need pair. */
export const KNOWN_EMAIL_INTENTS: readonly string[] = [
  "none",
  "transactional",
  "mailing-list",
  "both",
];

/** Local-parts accepted by `--email-forwarding` (Cloudflare Email
 *  Routing addresses). Deliberately narrow — these become
 *  `<local>@<domain>` routing rules. */
const EMAIL_LOCAL_PART = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseCreateFlags(argv: string[]): ParsedCreateFlags {
  const get = (name: string): string | undefined => {
    // Accept both `--name value` and `--name=value`.
    const equalsIdx = argv.findIndex((a) => a.startsWith(`--${name}=`));
    if (equalsIdx !== -1) return argv[equalsIdx].slice(name.length + 3);
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1 || idx === argv.length - 1) return undefined;
    const next = argv[idx + 1];
    return next.startsWith("--") ? undefined : next;
  };

  /** Is the flag present at all, with or without a value? */
  const has = (name: string): boolean =>
    argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));

  /** Enum-valued flag. Returns undefined when absent; throws listing
   *  the valid values when supplied with something unrecognised. */
  const pickEnum = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
    const raw = get(name);
    if (raw === undefined) {
      if (!has(name)) return undefined;
      throw new Error(`--${name} needs a value. Valid: ${allowed.join(", ")}`);
    }
    const value = raw.trim();
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`--${name} invalid: '${value}'. Valid: ${allowed.join(", ")}`);
    }
    return value as T;
  };

  /** Comma-separated multi-value flag. An empty value (`--features=`)
   *  is a deliberate "none" answer, not a missing one. */
  const pickList = <T extends string>(name: string, allowed: readonly T[]): T[] | undefined => {
    const raw = get(name);
    if (raw === undefined) {
      if (!has(name)) return undefined;
      // Bare `--features` with no value reads as "none of them".
      return [];
    }
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = list.filter((v) => !(allowed as readonly string[]).includes(v));
    if (invalid.length > 0) {
      throw new Error(
        `Unknown --${name} values: ${invalid.join(", ")}. Valid: ${allowed.join(", ")}`,
      );
    }
    return [...new Set(list)] as T[];
  };

  /** Free-text flag. Present-with-empty-value is meaningful for
   *  `--description=` ("no description, don't ask me"). */
  const pickString = (name: string): string | undefined => {
    const raw = get(name);
    if (raw !== undefined) return raw;
    return has(name) ? "" : undefined;
  };

  const yes = argv.includes("--yes") || argv.includes("-y") || argv.includes("--non-interactive");
  const dryRun = argv.includes("--dry-run");
  const forceNoGithub = argv.includes("--no-github");
  const forceNoDeploy = argv.includes("--no-deploy");
  const forceNoInstall = argv.includes("--no-install");
  const forceNoLocalDev = argv.includes("--no-local-dev");

  // Start from --config <path> if present, then layer individual flags on top.
  const presets: Partial<ProjectConfig> = {};
  const configPath = get("config");
  if (configPath) {
    const absPath = resolve(configPath);
    if (!existsSync(absPath)) {
      throw new Error(`--config file not found: ${absPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(absPath, "utf-8"));
    } catch (err) {
      throw new Error(`--config file is not valid JSON: ${absPath} (${(err as Error).message})`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`--config file must be a JSON object: ${absPath}`);
    }
    Object.assign(presets, parsed as Partial<ProjectConfig>);
  }

  // ── Identity ──────────────────────────────────────────────────────
  const name = get("name");
  if (name) presets.name = name;

  const domain = get("domain");
  if (domain) presets.domain = domain;

  const description = pickString("description");
  if (description !== undefined) presets.description = description;

  // ── Layout + deployment ───────────────────────────────────────────
  const surfaces = pickEnum("surfaces", KNOWN_SURFACES);
  if (surfaces) presets.surfaces = surfaces;

  const topology = pickEnum("topology", KNOWN_TOPOLOGIES);
  if (topology) presets.topology = topology;

  const deploymentMode = pickEnum("deployment-mode", KNOWN_DEPLOYMENT_MODES);
  if (deploymentMode) presets.deploymentMode = deploymentMode;

  const deployTarget = pickEnum("deploy-target", KNOWN_DEPLOY_TARGETS);
  if (deployTarget) presets.deployTarget = deployTarget;

  const serverSize = pickEnum("server-size", KNOWN_SERVER_SIZES);
  if (serverSize) presets.serverSize = serverSize;

  const serverLocation = pickEnum("server-location", KNOWN_SERVER_LOCATIONS);
  if (serverLocation) presets.serverLocation = serverLocation;

  const serverId = get("server-id");
  if (serverId !== undefined) {
    const parsedId = Number(serverId);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      throw new Error(`--server-id must be a positive integer (got '${serverId}')`);
    }
    presets.serverId = parsedId;
  }
  const serverIp = get("server-ip");
  if (serverIp) {
    presets.serverIp = serverIp;
    presets.serverIpv4 ??= serverIp;
  }

  // ── Stack ─────────────────────────────────────────────────────────
  const features = pickList("features", KNOWN_FEATURES);
  if (features) presets.features = features;

  const analyticsProviders = pickList("analytics-providers", KNOWN_ANALYTICS_PROVIDERS);
  if (analyticsProviders) presets.analyticsProviders = analyticsProviders;

  const services = pickList("services", KNOWN_PROVISION_SERVICES);
  if (services) presets.provisionServices = services;

  const mlServices = pickList("ml-services", KNOWN_ML_SERVICES);
  if (mlServices) presets.mlServices = mlServices;

  const gpuPlatforms = pickList("gpu-platforms", KNOWN_GPU_PLATFORMS);
  if (gpuPlatforms) {
    if (gpuPlatforms.length === 0) {
      throw new Error(
        `--gpu-platforms needs at least one value. Valid: ${KNOWN_GPU_PLATFORMS.join(", ")}`,
      );
    }
    presets.gpuPlatforms = gpuPlatforms;
  }

  const customHfModel = get("custom-hf-model");
  if (customHfModel) presets.customHfModelId = customHfModel;
  const customHfGpuType = get("custom-hf-gpu-type");
  if (customHfGpuType) presets.customHfGpuType = customHfGpuType;

  const dbEngine = pickEnum("db-engine", KNOWN_DB_ENGINES);
  if (dbEngine) presets.dbEngine = dbEngine;

  const dbProvider = pickEnum("db-provider", KNOWN_DB_PROVIDERS);
  if (dbProvider) {
    presets.dbProvider = dbProvider;
    // Keep the deprecated alias in sync so manifest / preset readers
    // that still look at `mongodbProvider` see the same answer.
    presets.mongodbProvider = dbProvider;
  }

  // ── S3 ────────────────────────────────────────────────────────────
  const s3Provider = pickEnum("s3-provider", KNOWN_S3_PROVIDERS);
  if (s3Provider) presets.s3Provider = s3Provider;

  const s3Endpoint = get("s3-endpoint");
  if (s3Endpoint) presets.s3ExistingEndpoint = s3Endpoint;
  const s3Bucket = get("s3-bucket");
  if (s3Bucket) presets.s3ExistingBucket = s3Bucket;
  const s3AccessKey = get("s3-access-key");
  if (s3AccessKey) presets.s3ExistingAccessKey = s3AccessKey;
  const s3SecretKey = get("s3-secret-key");
  if (s3SecretKey) presets.s3ExistingSecretKey = s3SecretKey;
  const s3Region = get("s3-region");
  if (s3Region) presets.s3ExistingRegion = s3Region;

  // ── Email ─────────────────────────────────────────────────────────
  const emailIntent = pickEnum("email", KNOWN_EMAIL_INTENTS);
  if (emailIntent) presets.email = emailIntentFromFlag(emailIntent);

  const emailForwarding = get("email-forwarding");
  const catchAllOn = argv.includes("--email-catch-all");
  const catchAllOff = argv.includes("--no-email-catch-all");
  if (catchAllOn && catchAllOff) {
    throw new Error("--email-catch-all and --no-email-catch-all are mutually exclusive.");
  }
  if (emailForwarding !== undefined || has("email-forwarding")) {
    presets.emailForwarding = parseEmailForwarding(emailForwarding, catchAllOn, catchAllOff);
  } else if (catchAllOn || catchAllOff) {
    throw new Error(
      "--email-catch-all / --no-email-catch-all require --email-forwarding=<addresses|off>.",
    );
  }

  // ── Repo / run ────────────────────────────────────────────────────
  const githubVisibility = pickEnum("github-visibility", KNOWN_GITHUB_VISIBILITIES);
  if (githubVisibility) {
    presets.githubRepoVisibility = githubVisibility;
    presets.createGithubRepo = true;
  }
  if (argv.includes("--public")) {
    presets.githubRepoVisibility = "public";
    presets.createGithubRepo = true;
  }
  if (argv.includes("--private")) {
    presets.githubRepoVisibility = "private";
    presets.createGithubRepo = true;
  }

  if (argv.includes("--scaffold")) presets.scaffoldRepo = true;
  if (argv.includes("--no-scaffold")) presets.scaffoldRepo = false;
  if (argv.includes("--github")) presets.createGithubRepo = true;
  if (argv.includes("--install")) presets.installDeps = true;
  if (argv.includes("--deploy")) presets.runDeployment = true;

  if (forceNoGithub) presets.createGithubRepo = false;
  if (forceNoDeploy) presets.runDeployment = false;
  if (forceNoInstall) presets.installDeps = false;
  if (forceNoLocalDev) presets.localDev = undefined;

  // --local-dev=<slug> sets an explicit slug; --local-dev with no value
  // signals "yes, enable, derive slug from project name" — that arrives
  // as an empty slug the prompt layer fills in from the project name.
  // Conflicts with --no-local-dev resolve in favour of --no-local-dev
  // (it's the safer choice).
  if (has("local-dev") && !forceNoLocalDev) {
    presets.localDev = { slug: get("local-dev") ?? "" };
  }

  return { yes, dryRun, presets, forceNoGithub, forceNoDeploy, forceNoInstall, forceNoLocalDev };
}

/** `--email <none|transactional|mailing-list|both>` → the manifest's
 *  per-need provider pair. Hatchkit only wires Listmonk + SES, so the
 *  mapping is a straight fan-out of the one answer. */
function emailIntentFromFlag(value: string): EmailIntent {
  return {
    transactional: value === "transactional" || value === "both" ? "listmonk-ses" : "none",
    mailingList: value === "mailing-list" || value === "both" ? "listmonk-ses" : "none",
  };
}

/** `--email-forwarding <off|addr[,addr…]>` → the Cloudflare Email
 *  Routing answer the stepper would have collected. `off` (or an empty
 *  value) disables forwarding; anything else is a list of local parts.
 *  Catch-all defaults to on for an enabled list, matching the prompt's
 *  default, and is overridable via `--no-email-catch-all`. */
function parseEmailForwarding(
  raw: string | undefined,
  catchAllOn: boolean,
  catchAllOff: boolean,
): NonNullable<ProjectConfig["emailForwarding"]> {
  const value = (raw ?? "").trim();
  if (value === "" || value === "off" || value === "none") {
    if (catchAllOn) {
      // Catch-all with no explicit addresses is a valid setup: *@domain
      // forwards, nothing else is enumerated.
      return { enabled: true, addresses: [], catchAll: true };
    }
    return { enabled: false, addresses: [], catchAll: false };
  }
  const addresses = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const invalid = addresses.filter((a) => !EMAIL_LOCAL_PART.test(a));
  if (invalid.length > 0) {
    throw new Error(
      `--email-forwarding invalid address local-part(s): ${invalid.join(", ")}. Use [a-z0-9._-], or 'off' to disable.`,
    );
  }
  return {
    enabled: true,
    addresses: [...new Set(addresses)],
    // Catch-all matches the prompt's default (on) unless explicitly waived.
    catchAll: !catchAllOff,
  };
}
