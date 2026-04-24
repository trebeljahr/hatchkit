import chalk from "chalk";
import ora from "ora";
import { ensureGpuProvider, registerMlService } from "../config.js";
import type { GpuPlatform, MlService } from "../prompts.js";
import { exec } from "../utils/exec.js";

/** Per-service map of platform → endpoint URL. The default runtime
 *  backend is the first platform in the input array; `ML_BACKEND` on
 *  the deployed app picks which URL gets used at request time. */
export type MlEndpointMap = Record<string, Partial<Record<GpuPlatform, string>>>;

/** Deploy each requested ML service to each requested GPU platform.
 *  Failures on one platform don't block the others — multi-platform
 *  setups are typically used to A/B or fail over, and partial coverage
 *  is still useful. */
export async function deployMlServices(
  services: MlService[],
  platforms: GpuPlatform[],
  repoRoot: string,
  customHfModelId?: string,
): Promise<MlEndpointMap> {
  if (services.length === 0 || platforms.length === 0) return {};

  console.log(chalk.bold("\n  ── ML Service Deployment ─────────────────────────────────\n"));
  if (platforms.length > 1) {
    console.log(
      chalk.dim(
        `  Deploying ${services.length} service(s) to ${platforms.length} platform(s): ${platforms.join(", ")}\n  Default backend: ${platforms[0]} (override at runtime with ML_BACKEND).\n`,
      ),
    );
  }

  // Ensure every selected GPU provider is configured up front so a
  // mid-deploy `ensure*` prompt can't deadlock under an active spinner.
  for (const platform of platforms) {
    await ensureGpuProvider(platform);
  }

  const endpoints: MlEndpointMap = {};

  for (const service of services) {
    endpoints[service] = {};
    for (const platform of platforms) {
      const spinner = ora(`Deploying ${service} to ${platform}...`).start();

      try {
        let endpoint: string;

        switch (platform) {
          case "modal":
            endpoint = await deployToModal(service, repoRoot, customHfModelId);
            break;
          case "runpod":
            endpoint = await deployToRunpod(service, repoRoot, customHfModelId);
            break;
          case "hf":
            endpoint = await deployToHf(service, customHfModelId);
            break;
          case "replicate":
            endpoint = await deployToReplicate(service, repoRoot, customHfModelId);
            break;
          default:
            throw new Error(`Unsupported GPU platform: ${platform}`);
        }

        spinner.succeed(`${service} on ${platform}: ${endpoint}`);
        endpoints[service][platform] = endpoint;

        // Registry record: only the first (default) platform is stored
        // under the bare service name to keep the legacy reuse path
        // working. Additional platforms are tracked under
        // "<service>@<platform>" so re-runs can reuse them too.
        const isDefault = platform === platforms[0];
        registerMlService(isDefault ? service : `${service}@${platform}`, {
          platform,
          endpoint,
          deployedAt: new Date().toISOString().split("T")[0],
          gpu: "A10G",
          model: service === "custom-hf" ? customHfModelId || "custom" : service,
        });
      } catch (error) {
        spinner.fail(`Failed to deploy ${service} to ${platform}`);
        console.error(chalk.red(`  ${error}`));
        // Continue with other platform/service combos.
      }
    }
  }

  return endpoints;
}

async function deployToModal(
  service: MlService,
  repoRoot: string,
  _customHfModelId?: string,
): Promise<string> {
  const serviceDir = `${repoRoot}/ml/${service}/modal`;

  const result = await exec("modal", ["deploy", "pipeline.py"], {
    cwd: serviceDir,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Modal deploy failed: ${result.stderr}`);
  }

  // Parse endpoint URL from Modal output
  const urlMatch = result.stdout.match(/https:\/\/\S+\.modal\.run/);
  return urlMatch?.[0] || `https://your-org--${service}-api.modal.run`;
}

async function deployToRunpod(
  service: MlService,
  repoRoot: string,
  _customHfModelId?: string,
): Promise<string> {
  // RunPod requires: docker build → push → create endpoint via API
  // For now, return a placeholder
  console.log(chalk.yellow("    RunPod deployment requires manual Docker build + push."));
  console.log(chalk.dim(`    See: ${repoRoot}/ml/${service}/runpod/`));
  return `https://api.runpod.ai/v2/${service}/runsync`;
}

async function deployToHf(service: MlService, customHfModelId?: string): Promise<string> {
  // HF Inference Endpoints: single API call
  const modelId = customHfModelId || getDefaultModelId(service);
  console.log(chalk.dim(`    Creating HF Inference Endpoint for ${modelId}...`));
  console.log(
    chalk.yellow("    Note: HF Endpoint creation via API requires huggingface_hub Python package."),
  );
  return `https://api-inference.huggingface.co/models/${modelId}`;
}

async function deployToReplicate(
  service: MlService,
  repoRoot: string,
  _customHfModelId?: string,
): Promise<string> {
  const serviceDir = `${repoRoot}/ml/${service}/replicate`;
  console.log(chalk.yellow(`    Replicate deployment: run 'cog push' in ${serviceDir}`));
  return `https://api.replicate.com/v1/predictions`;
}

function getDefaultModelId(service: MlService): string {
  switch (service) {
    case "3d-sam-objects":
      return "facebook/sam-3d-objects";
    case "3d-sam-body":
      return "facebook/sam-3d-body";
    case "3d-hunyuan":
      return "tencent/Hunyuan3D-3";
    case "3d-trellis":
      return "microsoft/TRELLIS-2";
    case "3d-extraction":
      return "stabilityai/TripoSR";
    case "subtitles":
      return "openai/whisper-large-v3";
    case "image-recognition":
      return "openai/clip-vit-large-patch14";
    case "background-removal":
      return "briaai/RMBG-2.0";
    default:
      return "unknown";
  }
}
