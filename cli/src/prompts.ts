import { checkbox, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { getCoolifyConfig, getMlServices } from "./config.js";
import { CoolifyApi, type CoolifyServer } from "./utils/coolify-api.js";
import { parseDomain, validateDomain, validateProjectName } from "./utils/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeployTarget = "existing" | "new";
export type DnsProvider = "inwx" | "cloudflare" | "manual";
export type S3Provider = "hetzner" | "r2" | "aws" | "existing" | "none";
export type GpuPlatform = "modal" | "runpod" | "hf" | "replicate";

export type Feature = "websocket" | "stripe" | "analytics" | "s3" | "desktop" | "mobile";

export type MlService =
  | "3d-sam-objects"
  | "3d-sam-body"
  | "3d-hunyuan"
  | "3d-trellis"
  | "3d-extraction"
  | "subtitles"
  | "image-recognition"
  | "background-removal"
  | "custom-hf";

export interface ProjectConfig {
  name: string;
  domain: string;
  baseDomain: string;
  subdomain: string;

  deployTarget: DeployTarget;
  serverId?: number;
  serverIp?: string;
  serverSize?: string;
  serverLocation?: string;

  features: Feature[];
  s3Provider: S3Provider;
  s3ExistingEndpoint?: string;
  s3ExistingBucket?: string;
  s3ExistingAccessKey?: string;
  s3ExistingSecretKey?: string;
  s3ExistingRegion?: string;

  mlServices: MlService[];
  /** Subset of mlServices the user wants to redeploy even though the
   *  registry has them. Used to recover from stale entries (upstream
   *  service was deleted) or platform migrations. */
  forceRedeployMl: MlService[];
  /** Optional key→value map supplied for .env.production seeding
   *  (STRIPE_SECRET_KEY, SENTRY_DSN, etc.). Anything unsupplied lands
   *  as a plaintext CHANGE_ME_<KEY> placeholder that the user can
   *  encrypt later with `dotenvx set`. */
  envValues?: Record<string, string>;
  /** Where the production MongoDB lives:
   *    "coolify"  — hatchkit will provision a per-project MongoDB
   *                 container on Coolify after the app deploys, and
   *                 encrypt the resulting URL into .env.production.
   *    "external" — the user provides MONGODB_URI themselves
   *                 (Atlas, self-hosted, etc.).
   *  Defaults to "coolify" when runDeployment is true, "external"
   *  otherwise. */
  mongodbProvider?: "coolify" | "external";
  /** GPU platforms to deploy each ML service to. The first entry is
   *  the default backend at runtime; switch by setting `ML_BACKEND` on
   *  the deploy. Multi-select lets you side-by-side benchmark or fail
   *  over between Modal / RunPod / HF / Replicate. */
  gpuPlatforms?: GpuPlatform[];
  customHfModelId?: string;
  customHfGpuType?: string;

  scaffoldRepo: boolean;
  createGithubRepo: boolean;
  runDeployment: boolean;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Main prompt flow
// ---------------------------------------------------------------------------

/** If a preset value is provided, use it. In non-interactive mode,
 *  fall back to the provided default (or throw if none). Otherwise
 *  run the interactive prompt. */
async function presetOrPrompt<T>(
  preset: T | undefined,
  nonInteractive: boolean,
  prompt: () => Promise<T>,
  fallback?: T,
): Promise<T> {
  if (preset !== undefined) return preset;
  if (nonInteractive) {
    if (fallback !== undefined) return fallback;
    throw new Error(
      "Required value missing in --config / flags and no default is available. Re-run without --yes to be prompted.",
    );
  }
  return prompt();
}

export interface CollectOptions {
  dryRun?: boolean;
  /** Preset values to skip prompts for. Values here override defaults
   *  and skip the corresponding prompt entirely. */
  presets?: Partial<ProjectConfig>;
  /** Non-interactive mode: any missing value falls back to its
   *  default if one exists, else throws. */
  nonInteractive?: boolean;
}

export async function collectProjectConfig(options: CollectOptions): Promise<ProjectConfig> {
  const presets = options.presets ?? {};
  const nonInteractive = options.nonInteractive ?? false;

  if (!nonInteractive) {
    console.log(chalk.bold("\n  ── New Project ─────────────────────────────────────────────\n"));
  }

  // Project basics
  const name = await presetOrPrompt(presets.name, nonInteractive, () =>
    input({ message: "Project name:", validate: (v) => validateProjectName(v) }),
  );
  // Validate preset name since we skipped the prompt's built-in check.
  const nameErr = validateProjectName(name);
  if (nameErr !== true) throw new Error(`--name invalid: ${nameErr}`);

  const domain = await presetOrPrompt(
    presets.domain,
    nonInteractive,
    () =>
      input({
        message: "Domain:",
        default: `${name}.ricos.site`,
        validate: (v) => validateDomain(v),
      }),
    `${name}.ricos.site`,
  );
  const domainErr = validateDomain(domain);
  if (domainErr !== true) throw new Error(`--domain invalid: ${domainErr}`);

  const { baseDomain, subdomain } = parseDomain(domain);

  // Deploy target. Non-interactive default is "new" rather than
  // "existing": "existing" has no sensible default (it needs a real
  // serverId + serverIp that only make sense with a configured
  // Coolify), while "new" provisions a Hetzner server with defaults
  // (cpx21, nbg1). Users who want existing pass `--deploy-target
  // existing` + serverId/serverIp via --config.
  const deployTarget = await presetOrPrompt(
    presets.deployTarget,
    nonInteractive,
    selectDeployTarget,
    "new",
  );

  let serverId: number | undefined;
  let serverIp: string | undefined;
  let serverSize: string | undefined;
  let serverLocation: string | undefined;

  if (deployTarget === "existing") {
    if (presets.serverId !== undefined && presets.serverIp !== undefined) {
      serverId = presets.serverId;
      serverIp = presets.serverIp;
    } else if (nonInteractive) {
      throw new Error(
        "--deploy-target existing requires serverId + serverIp in --config (or remove --yes to pick interactively).",
      );
    } else {
      const server = await selectExistingServer();
      serverId = server.id;
      serverIp = server.ip;
    }
  } else {
    serverSize = await presetOrPrompt(
      presets.serverSize,
      nonInteractive,
      () =>
        select({
          message: "Server size:",
          choices: [
            { name: "cpx21 — 3 vCPU / 4 GB (€4.35/mo)", value: "cpx21" },
            { name: "cpx31 — 4 vCPU / 8 GB (€8.10/mo)", value: "cpx31" },
            { name: "cpx41 — 8 vCPU / 16 GB (€15.90/mo)", value: "cpx41" },
          ],
        }),
      "cpx21",
    );
    serverLocation = await presetOrPrompt(
      presets.serverLocation,
      nonInteractive,
      () =>
        select({
          message: "Server location:",
          choices: [
            { name: "Nuremberg (nbg1) — Central Europe", value: "nbg1" },
            { name: "Falkenstein (fsn1) — Eastern Germany", value: "fsn1" },
            { name: "Helsinki (hel1) — Northern Europe", value: "hel1" },
          ],
        }),
      "nbg1",
    );
  }

  // Features
  const features = await presetOrPrompt(
    presets.features,
    nonInteractive,
    () =>
      checkbox<Feature>({
        message: "Features:",
        choices: [
          { name: "WebSocket/realtime (includes Redis)", value: "websocket" },
          { name: "Stripe billing", value: "stripe" },
          { name: "S3 file storage", value: "s3" },
          { name: "Analytics (OpenPanel) + Error tracking (GlitchTip)", value: "analytics" },
          { name: "Desktop app (Electron + itch.io release)", value: "desktop" },
          { name: "Mobile app (Capacitor / iOS + Android)", value: "mobile" },
        ],
      }),
    [],
  );

  // S3 provider (if selected)
  let s3Provider: S3Provider = "none";
  let s3ExistingEndpoint: string | undefined;
  let s3ExistingBucket: string | undefined;
  let s3ExistingAccessKey: string | undefined;
  let s3ExistingSecretKey: string | undefined;
  let s3ExistingRegion: string | undefined;

  if (features.includes("s3")) {
    s3Provider = await presetOrPrompt(
      presets.s3Provider,
      nonInteractive,
      () =>
        select<S3Provider>({
          message: "S3 storage provider:",
          choices: [
            { name: "Hetzner Object Storage", value: "hetzner" },
            { name: "Cloudflare R2 (zero egress)", value: "r2" },
            { name: "AWS S3", value: "aws" },
            { name: "Use existing bucket", value: "existing" },
          ],
        }),
      "hetzner",
    );

    if (s3Provider === "existing") {
      // Existing-bucket credentials are never defaulted — these are
      // secrets and infrastructure coords that must be explicit.
      if (nonInteractive && (!presets.s3ExistingEndpoint || !presets.s3ExistingBucket)) {
        throw new Error(
          "--s3-provider existing requires s3ExistingEndpoint/Bucket/AccessKey/SecretKey/Region in --config.",
        );
      }
      s3ExistingEndpoint = await presetOrPrompt(presets.s3ExistingEndpoint, nonInteractive, () =>
        input({ message: "S3 endpoint URL:" }),
      );
      s3ExistingBucket = await presetOrPrompt(presets.s3ExistingBucket, nonInteractive, () =>
        input({ message: "S3 bucket name:" }),
      );
      s3ExistingAccessKey = await presetOrPrompt(presets.s3ExistingAccessKey, nonInteractive, () =>
        input({ message: "S3 access key:" }),
      );
      s3ExistingSecretKey = await presetOrPrompt(presets.s3ExistingSecretKey, nonInteractive, () =>
        input({ message: "S3 secret key:" }),
      );
      s3ExistingRegion = await presetOrPrompt(
        presets.s3ExistingRegion,
        nonInteractive,
        () => input({ message: "S3 region:", default: "us-east-1" }),
        "us-east-1",
      );
    }
  }

  // ML services
  const mlServices = await presetOrPrompt(
    presets.mlServices,
    nonInteractive,
    () =>
      checkbox<MlService>({
        message: "ML services:",
        choices: [
          {
            name: "3D — SAM 3D Objects (Meta, single image → mesh; SOTA real-image textures)",
            value: "3d-sam-objects",
          },
          {
            name: "3D — SAM 3D Body (Meta, single image → posed human body; apparel/try-on)",
            value: "3d-sam-body",
          },
          {
            name: "3D — Hunyuan3D 3.0 (Tencent, 8K PBR textures, open weights)",
            value: "3d-hunyuan",
          },
          {
            name: "3D — TRELLIS 2 (Microsoft, sparse-voxel geometry, strong topology)",
            value: "3d-trellis",
          },
          {
            name: "3D — TripoSR (legacy, fast but lower quality)",
            value: "3d-extraction",
          },
          { name: "Subtitle generation (audio/video → SRT)", value: "subtitles" },
          { name: "Image recognition", value: "image-recognition" },
          { name: "Background removal", value: "background-removal" },
          { name: "Custom HuggingFace model", value: "custom-hf" },
        ],
      }),
    [],
  );

  let gpuPlatforms: GpuPlatform[] | undefined;
  let customHfModelId: string | undefined;
  let customHfGpuType: string | undefined;

  const forceRedeploy = new Set<MlService>();
  if (mlServices.length > 0) {
    // Check for existing services in registry
    const registry = getMlServices();
    const reusable = mlServices.filter((s) => registry[s]);
    if (reusable.length > 0) {
      console.log(chalk.dim(`\n  Found existing ML services in registry:`));
      for (const svc of reusable) {
        const entry = registry[svc];
        console.log(
          chalk.dim(
            `    ${svc}: ${entry.endpoint} (${entry.platform}, deployed ${entry.deployedAt})`,
          ),
        );
      }
      // Let the user force re-deploy — covers stale entries (service
      // was deleted upstream) or platform changes.
      const toRedeploy = await checkbox<MlService>({
        message: "Redeploy any of these (leave empty to reuse all)?",
        choices: reusable.map((s) => ({ name: s, value: s })),
      });
      for (const s of toRedeploy) forceRedeploy.add(s);
    }

    const needsDeploy = mlServices.filter((s) => !registry[s] || forceRedeploy.has(s));
    if (needsDeploy.length > 0) {
      gpuPlatforms = await presetOrPrompt(
        presets.gpuPlatforms,
        nonInteractive,
        () =>
          checkbox<GpuPlatform>({
            message:
              "GPU platforms to deploy to (multi-select — first becomes default ML_BACKEND):",
            choices: [
              {
                name: "Modal (recommended — best DX, $30/mo free, 2-4s cold starts)",
                value: "modal",
                checked: true,
              },
              { name: "RunPod Serverless (cheapest, Docker-native)", value: "runpod" },
              { name: "HuggingFace Inference Endpoints (simplest for HF models)", value: "hf" },
              { name: "Replicate (via Cog, good for sharing)", value: "replicate" },
            ],
            required: true,
          }),
        ["modal"],
      );
    }

    if (mlServices.includes("custom-hf")) {
      customHfModelId = await presetOrPrompt(presets.customHfModelId, nonInteractive, () =>
        input({ message: "HuggingFace model ID (e.g. meta-llama/Llama-3-8B):" }),
      );
      customHfGpuType = await presetOrPrompt(
        presets.customHfGpuType,
        nonInteractive,
        () =>
          select({
            message: "GPU type for custom model:",
            choices: [
              { name: "T4 (16GB VRAM, cheapest)", value: "T4" },
              { name: "A10G (24GB VRAM, good balance)", value: "A10G" },
              { name: "A100 (40/80GB VRAM, large models)", value: "A100" },
              { name: "H100 (80GB VRAM, fastest)", value: "H100" },
            ],
          }),
        "A10G",
      );
    }
  }

  // Scaffold options
  const scaffoldRepo = await presetOrPrompt(
    presets.scaffoldRepo,
    nonInteractive,
    () => confirm({ message: "Scaffold app repo?", default: true }),
    true,
  );

  let createGithubRepo = false;
  if (scaffoldRepo) {
    createGithubRepo = await presetOrPrompt(
      presets.createGithubRepo,
      nonInteractive,
      () =>
        confirm({
          message: "Create GitHub remote repo?",
          default: true,
        }),
      true,
    );
  }

  const runDeployment = options.dryRun
    ? false
    : await presetOrPrompt(
        presets.runDeployment,
        nonInteractive,
        () =>
          confirm({
            message: "Run deployment now?",
            default: true,
          }),
        true,
      );

  // MongoDB strategy: provisioned by Coolify (recommended for the
  // self-hosted path) vs. an external URI (Atlas, existing self-hosted
  // Mongo, etc.). When "coolify", we DON'T ask for MONGODB_URI here —
  // hatchkit provisions the container after the app deploys and writes
  // the encrypted URL into .env.production automatically.
  const mongodbProvider = await presetOrPrompt<"coolify" | "external">(
    presets.mongodbProvider,
    nonInteractive,
    () =>
      select<"coolify" | "external">({
        message: "Prod MongoDB:",
        choices: [
          {
            name: "Provision a dedicated container on Coolify (recommended)",
            value: "coolify",
          },
          {
            name: "I'll provide a URI (Atlas, self-hosted, …)",
            value: "external",
          },
        ],
        default: runDeployment ? "coolify" : "external",
      }),
    runDeployment ? "coolify" : "external",
  );

  // Production env values. Anything not supplied gets a plaintext
  // CHANGE_ME_<KEY> placeholder the user can encrypt later with
  // `dotenvx set`. In non-interactive mode we only take presets —
  // don't prompt. BETTER_AUTH_SECRET is auto-generated by the
  // dotenvx seed helper, not prompted.
  //
  // URLs are auto-derived from the chosen domain: the frontend lives
  // at the bare domain, the API at `/api` on the same domain. No
  // separate `api.<domain>` subdomain is required for Better Auth or
  // the SPA; the starter's server mounts at `/api/*` and the auth
  // library uses the bare URL as its base.
  const envValues: Record<string, string> = { ...(presets.envValues ?? {}) };
  envValues.FRONTEND_URL ??= `https://${domain}`;
  envValues.BETTER_AUTH_URL ??= `https://${domain}`;
  if (!nonInteractive) {
    if (scaffoldRepo) {
      console.log(chalk.bold("\n  ── Production env (press enter to leave as CHANGE_ME) ──────"));
      console.log(
        chalk.dim(
          `  FRONTEND_URL    https://${domain}\n  BETTER_AUTH_URL https://${domain}\n  ${chalk.italic("(auto-derived — both use the bare domain; the API is mounted at /api)")}`,
        ),
      );
      const askOptional = async (key: string, label: string): Promise<void> => {
        if (envValues[key]) return;
        const v = await input({
          message: `${label} [${key}]:`,
          default: "",
        });
        if (v.trim()) envValues[key] = v.trim();
      };
      // Only ask for MONGODB_URI when the user opted out of Coolify
      // provisioning — otherwise hatchkit fills it in post-deploy.
      if (mongodbProvider === "external") {
        await askOptional("MONGODB_URI", "MongoDB URI");
      }
      // Stripe values: only prompt for the secret key here. The webhook
      // secret is generated by hatchkit at deploy time when it
      // registers the webhook endpoint, so we no longer ask the user
      // to paste it.
      if (features.includes("stripe")) {
        await askOptional("STRIPE_SECRET_KEY", "Stripe secret key (sk_live_...)");
      }
      // GLITCHTIP_DSN / SENTRY_DSN are NOT prompted: when `analytics`
      // is selected, hatchkit creates a per-project GlitchTip project
      // post-scaffold and writes the DSN encrypted into .env.production.
      // Setup must already have GlitchTip configured — checked in the
      // pre-flight in index.ts.
      if (features.includes("s3") && s3Provider === "existing") {
        await askOptional("S3_ENDPOINT", "S3 endpoint");
        await askOptional("S3_BUCKET_NAME", "S3 bucket");
        await askOptional("AWS_ACCESS_KEY_ID", "AWS access key id");
        await askOptional("AWS_SECRET_ACCESS_KEY", "AWS secret access key");
      }
    }
  }

  return {
    name,
    domain,
    baseDomain,
    subdomain,
    deployTarget,
    serverId,
    serverIp,
    serverSize,
    serverLocation,
    features,
    s3Provider,
    s3ExistingEndpoint,
    s3ExistingBucket,
    s3ExistingAccessKey,
    s3ExistingSecretKey,
    s3ExistingRegion,
    mlServices,
    forceRedeployMl: [...forceRedeploy],
    mongodbProvider,
    gpuPlatforms,
    customHfModelId,
    customHfGpuType,
    scaffoldRepo,
    createGithubRepo,
    runDeployment,
    envValues,
    dryRun: options.dryRun || false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function selectDeployTarget(): Promise<DeployTarget> {
  return select({
    message: "Deploy to:",
    choices: [
      { name: "Existing Coolify server", value: "existing" as const },
      { name: "New Hetzner server", value: "new" as const },
    ],
  });
}

async function selectExistingServer(): Promise<CoolifyServer> {
  const coolifyConfig = await getCoolifyConfig();

  if (!coolifyConfig?.url || !coolifyConfig?.token) {
    throw new Error("Coolify is not configured. Run hatchkit init first.");
  }

  // Use cached server list if available, otherwise fetch live
  let servers: CoolifyServer[];
  if (coolifyConfig.serversCache && coolifyConfig.serversCache.length > 0) {
    servers = coolifyConfig.serversCache;
  } else {
    const api = new CoolifyApi({ url: coolifyConfig.url, token: coolifyConfig.token });
    servers = await api.listServers();
  }

  if (servers.length === 0) {
    throw new Error(
      "No servers found in Coolify. Create one first or choose 'New Hetzner server'.",
    );
  }

  if (servers.length === 1) {
    console.log(chalk.dim(`  Auto-selected server: ${servers[0].name} (${servers[0].ip})`));
    return servers[0];
  }

  const serverId = await select({
    message: "Select server:",
    choices: servers.map((s) => ({
      name: `${s.name} (${s.ip})`,
      value: s.id,
    })),
  });

  return servers.find((s) => s.id === serverId)!;
}
