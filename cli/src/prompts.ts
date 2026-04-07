import { input, select, checkbox, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { validateDomain, validateProjectName, parseDomain } from "./utils/validate.js";
import { CoolifyApi, type CoolifyServer } from "./utils/coolify-api.js";
import {
  getConfig,
  getMlServices,
  type CoolifyConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeployTarget = "existing" | "new";
export type DnsProvider = "inwx" | "cloudflare" | "manual";
export type S3Provider = "hetzner" | "r2" | "aws" | "existing" | "none";
export type GpuPlatform = "modal" | "runpod" | "hf" | "replicate";

export type Feature =
  | "websocket"
  | "stripe"
  | "analytics"
  | "s3";

export type MlService =
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
  gpuPlatform?: GpuPlatform;
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

export async function collectProjectConfig(options: {
  dryRun?: boolean;
}): Promise<ProjectConfig> {
  console.log(chalk.bold("\n  ── New Project ─────────────────────────────────────────────\n"));

  // Project basics
  const name = await input({
    message: "Project name:",
    validate: (v) => validateProjectName(v),
  });

  const domain = await input({
    message: "Domain:",
    default: `${name}.ricos.site`,
    validate: (v) => validateDomain(v),
  });

  const { baseDomain, subdomain } = parseDomain(domain);

  // Deploy target
  const deployTarget = await selectDeployTarget();

  let serverId: number | undefined;
  let serverIp: string | undefined;
  let serverSize: string | undefined;
  let serverLocation: string | undefined;

  if (deployTarget === "existing") {
    const server = await selectExistingServer();
    serverId = server.id;
    serverIp = server.ip;
  } else {
    serverSize = await select({
      message: "Server size:",
      choices: [
        { name: "cpx21 — 3 vCPU / 4 GB (€4.35/mo)", value: "cpx21" },
        { name: "cpx31 — 4 vCPU / 8 GB (€8.10/mo)", value: "cpx31" },
        { name: "cpx41 — 8 vCPU / 16 GB (€15.90/mo)", value: "cpx41" },
      ],
    });
    serverLocation = await select({
      message: "Server location:",
      choices: [
        { name: "Nuremberg (nbg1) — Central Europe", value: "nbg1" },
        { name: "Falkenstein (fsn1) — Eastern Germany", value: "fsn1" },
        { name: "Helsinki (hel1) — Northern Europe", value: "hel1" },
      ],
    });
  }

  // Features
  const features = await checkbox<Feature>({
    message: "Features:",
    choices: [
      { name: "WebSocket/realtime (includes Redis)", value: "websocket" },
      { name: "Stripe billing", value: "stripe" },
      { name: "S3 file storage", value: "s3" },
      { name: "Analytics (Plausible) + Error tracking (GlitchTip)", value: "analytics" },
    ],
  });

  // S3 provider (if selected)
  let s3Provider: S3Provider = "none";
  let s3ExistingEndpoint: string | undefined;
  let s3ExistingBucket: string | undefined;
  let s3ExistingAccessKey: string | undefined;
  let s3ExistingSecretKey: string | undefined;
  let s3ExistingRegion: string | undefined;

  if (features.includes("s3")) {
    s3Provider = await select<S3Provider>({
      message: "S3 storage provider:",
      choices: [
        { name: "Hetzner Object Storage", value: "hetzner" },
        { name: "Cloudflare R2 (zero egress)", value: "r2" },
        { name: "AWS S3", value: "aws" },
        { name: "Use existing bucket", value: "existing" },
      ],
    });

    if (s3Provider === "existing") {
      s3ExistingEndpoint = await input({ message: "S3 endpoint URL:" });
      s3ExistingBucket = await input({ message: "S3 bucket name:" });
      s3ExistingAccessKey = await input({ message: "S3 access key:" });
      s3ExistingSecretKey = await input({ message: "S3 secret key:" });
      s3ExistingRegion = await input({ message: "S3 region:", default: "us-east-1" });
    }
  }

  // ML services
  const mlServices = await checkbox<MlService>({
    message: "ML services:",
    choices: [
      { name: "3D model extraction (photo → GLB)", value: "3d-extraction" },
      { name: "Subtitle generation (audio/video → SRT)", value: "subtitles" },
      { name: "Image recognition", value: "image-recognition" },
      { name: "Background removal", value: "background-removal" },
      { name: "Custom HuggingFace model", value: "custom-hf" },
    ],
  });

  let gpuPlatform: GpuPlatform | undefined;
  let customHfModelId: string | undefined;
  let customHfGpuType: string | undefined;

  if (mlServices.length > 0) {
    // Check for existing services in registry
    const registry = getMlServices();
    const reusable = mlServices.filter((s) => registry[s]);
    if (reusable.length > 0) {
      console.log(chalk.dim(`\n  Found existing ML services: ${reusable.join(", ")}`));
      for (const svc of reusable) {
        const entry = registry[svc];
        console.log(
          chalk.dim(`    ${svc}: ${entry.endpoint} (${entry.platform}, deployed ${entry.deployedAt})`),
        );
      }
    }

    const needsDeploy = mlServices.filter((s) => !registry[s]);
    if (needsDeploy.length > 0) {
      gpuPlatform = await select<GpuPlatform>({
        message: "GPU platform for new ML services:",
        choices: [
          {
            name: "Modal (recommended — best DX, $30/mo free, 2-4s cold starts)",
            value: "modal",
          },
          {
            name: "RunPod Serverless (cheapest, Docker-native)",
            value: "runpod",
          },
          {
            name: "HuggingFace Inference Endpoints (simplest for HF models)",
            value: "hf",
          },
          {
            name: "Replicate (via Cog, good for sharing)",
            value: "replicate",
          },
        ],
      });
    }

    if (mlServices.includes("custom-hf")) {
      customHfModelId = await input({
        message: "HuggingFace model ID (e.g. meta-llama/Llama-3-8B):",
      });
      customHfGpuType = await select({
        message: "GPU type for custom model:",
        choices: [
          { name: "T4 (16GB VRAM, cheapest)", value: "T4" },
          { name: "A10G (24GB VRAM, good balance)", value: "A10G" },
          { name: "A100 (40/80GB VRAM, large models)", value: "A100" },
          { name: "H100 (80GB VRAM, fastest)", value: "H100" },
        ],
      });
    }
  }

  // Scaffold options
  const scaffoldRepo = await confirm({
    message: "Scaffold app repo?",
    default: true,
  });

  let createGithubRepo = false;
  if (scaffoldRepo) {
    createGithubRepo = await confirm({
      message: "Create GitHub remote repo?",
      default: true,
    });
  }

  const runDeployment = options.dryRun
    ? false
    : await confirm({
        message: "Run deployment now?",
        default: true,
      });

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
    gpuPlatform,
    customHfModelId,
    customHfGpuType,
    scaffoldRepo,
    createGithubRepo,
    runDeployment,
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
  const config = getConfig();
  const coolifyConfig = config.providers.coolify as CoolifyConfig;

  if (!coolifyConfig?.url || !coolifyConfig?.token) {
    throw new Error("Coolify is not configured. Run devops-cli init first.");
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
    throw new Error("No servers found in Coolify. Create one first or choose 'New Hetzner server'.");
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
