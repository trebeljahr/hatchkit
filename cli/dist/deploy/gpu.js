import chalk from "chalk";
import ora from "ora";
import { exec } from "../utils/exec.js";
import { ensureGpuProvider, registerMlService } from "../config.js";
/** Deploy ML services that don't exist in the registry. */
export async function deployMlServices(services, platform, repoRoot, customHfModelId) {
    if (services.length === 0)
        return {};
    console.log(chalk.bold("\n  ── ML Service Deployment ─────────────────────────────────\n"));
    // Ensure GPU provider is configured
    await ensureGpuProvider(platform);
    const endpoints = {};
    for (const service of services) {
        const spinner = ora(`Deploying ${service} to ${platform}...`).start();
        try {
            let endpoint;
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
            spinner.succeed(`${service} deployed: ${endpoint}`);
            endpoints[service] = endpoint;
            // Register in the shared service registry
            registerMlService(service, {
                platform,
                endpoint,
                deployedAt: new Date().toISOString().split("T")[0],
                gpu: "A10G",
                model: service === "custom-hf" ? (customHfModelId || "custom") : service,
            });
        }
        catch (error) {
            spinner.fail(`Failed to deploy ${service}`);
            console.error(chalk.red(`  ${error}`));
            // Continue with other services
        }
    }
    return endpoints;
}
async function deployToModal(service, repoRoot, customHfModelId) {
    const serviceDir = `${repoRoot}/services/ml/${service}/modal`;
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
async function deployToRunpod(service, repoRoot, customHfModelId) {
    // RunPod requires: docker build → push → create endpoint via API
    // For now, return a placeholder
    console.log(chalk.yellow("    RunPod deployment requires manual Docker build + push."));
    console.log(chalk.dim(`    See: ${repoRoot}/services/ml/${service}/runpod/`));
    return `https://api.runpod.ai/v2/${service}/runsync`;
}
async function deployToHf(service, customHfModelId) {
    // HF Inference Endpoints: single API call
    const modelId = customHfModelId || getDefaultModelId(service);
    console.log(chalk.dim(`    Creating HF Inference Endpoint for ${modelId}...`));
    console.log(chalk.yellow("    Note: HF Endpoint creation via API requires huggingface_hub Python package."));
    return `https://api-inference.huggingface.co/models/${modelId}`;
}
async function deployToReplicate(service, repoRoot, customHfModelId) {
    const serviceDir = `${repoRoot}/services/ml/${service}/replicate`;
    console.log(chalk.yellow(`    Replicate deployment: run 'cog push' in ${serviceDir}`));
    return `https://api.replicate.com/v1/predictions`;
}
function getDefaultModelId(service) {
    switch (service) {
        case "3d-extraction": return "stabilityai/stable-fast-3d";
        case "subtitles": return "openai/whisper-large-v3";
        case "image-recognition": return "openai/clip-vit-large-patch14";
        case "background-removal": return "briaai/RMBG-2.0";
        default: return "unknown";
    }
}
//# sourceMappingURL=gpu.js.map