import Conf from "conf";
import { input, password, select, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { verifyCoolify } from "./utils/coolify-api.js";
import { execOk } from "./utils/exec.js";
import { validateUrl, validateRequired } from "./utils/validate.js";
// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------
const store = new Conf({
    projectName: "devops-cli",
    defaults: {
        version: 1,
        providers: {
            github: { status: "unconfigured" },
            s3: {},
            gpu: {},
        },
        mlServices: {},
    },
});
export function getConfig() {
    return store.store;
}
export function setConfig(config) {
    Object.assign(store.store, config);
}
export function getConfigPath() {
    return store.path;
}
// ---------------------------------------------------------------------------
// Provider: GitHub
// ---------------------------------------------------------------------------
export async function ensureGitHub() {
    const isAuthed = await execOk("gh", ["auth", "status"]);
    if (isAuthed) {
        store.set("providers.github", {
            status: "configured",
            lastVerified: new Date().toISOString(),
        });
        console.log(chalk.green("  ✓ GitHub: Authenticated via gh CLI"));
        return;
    }
    console.log(chalk.yellow("  GitHub: Not authenticated. Running gh auth login..."));
    const { execStream } = await import("./utils/exec.js");
    const exitCode = await execStream("gh", ["auth", "login"]);
    if (exitCode !== 0) {
        throw new Error("GitHub authentication failed. Install gh CLI and try again.");
    }
    store.set("providers.github", {
        status: "configured",
        lastVerified: new Date().toISOString(),
    });
}
// ---------------------------------------------------------------------------
// Provider: Coolify
// ---------------------------------------------------------------------------
export async function ensureCoolify() {
    const existing = store.get("providers.coolify");
    if (existing?.status === "configured") {
        // Skip verification if checked within last 24 hours
        const lastVerified = existing.lastVerified ? new Date(existing.lastVerified).getTime() : 0;
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        if (lastVerified > oneDayAgo) {
            return existing;
        }
        // Verify connection is still valid
        try {
            await verifyCoolify(existing.url, existing.token);
            store.set("providers.coolify.lastVerified", new Date().toISOString());
            return existing;
        }
        catch {
            console.log(chalk.yellow("  Coolify token expired or invalid. Let's reconfigure."));
        }
    }
    const url = await input({
        message: "Coolify dashboard URL:",
        default: existing?.url,
        validate: (v) => validateUrl(v),
    });
    const token = await password({
        message: "Coolify API token (from Settings → API Tokens):",
    });
    const spinner = ora("Testing Coolify connection...").start();
    try {
        const version = await verifyCoolify(url, token);
        spinner.succeed(`Connected to Coolify v${version}`);
    }
    catch (error) {
        spinner.fail("Could not connect to Coolify");
        throw error;
    }
    // Cache server list
    const { CoolifyApi } = await import("./utils/coolify-api.js");
    const api = new CoolifyApi({ url, token });
    const servers = await api.listServers();
    const config = {
        status: "configured",
        url,
        token,
        serversCache: servers,
        lastVerified: new Date().toISOString(),
    };
    store.set("providers.coolify", config);
    console.log(chalk.green(`  ✓ Coolify: ${servers.length} server(s) found`));
    return config;
}
// ---------------------------------------------------------------------------
// Provider: Hetzner
// ---------------------------------------------------------------------------
export async function ensureHetzner() {
    const existing = store.get("providers.hetzner");
    if (existing?.status === "configured") {
        return existing;
    }
    const token = await password({
        message: "Hetzner Cloud API token:",
    });
    const spinner = ora("Testing Hetzner connection...").start();
    try {
        const res = await fetch("https://api.hetzner.cloud/v1/servers", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        spinner.succeed("Hetzner Cloud connected");
    }
    catch (error) {
        spinner.fail("Could not connect to Hetzner Cloud");
        throw error;
    }
    const config = {
        status: "configured",
        token,
        lastVerified: new Date().toISOString(),
    };
    store.set("providers.hetzner", config);
    return config;
}
// ---------------------------------------------------------------------------
// Provider: DNS
// ---------------------------------------------------------------------------
export async function ensureDns() {
    const existing = store.get("providers.dns");
    if (existing?.status === "configured") {
        return existing;
    }
    const provider = await select({
        message: "DNS provider:",
        choices: [
            { name: "INWX (auto-configure DNS)", value: "inwx" },
            { name: "Cloudflare DNS", value: "cloudflare" },
            { name: "Manual (I'll set DNS records myself)", value: "manual" },
        ],
    });
    if (provider === "manual") {
        const config = { status: "configured", provider: "manual" };
        store.set("providers.dns", config);
        return config;
    }
    if (provider === "inwx") {
        const username = await input({ message: "INWX username:", validate: validateRequired });
        const pwd = await password({ message: "INWX password:" });
        const config = {
            status: "configured",
            provider: "inwx",
            username,
            password: pwd,
        };
        store.set("providers.dns", config);
        console.log(chalk.green("  ✓ INWX DNS configured"));
        return config;
    }
    // Cloudflare
    const apiToken = await password({ message: "Cloudflare API token:" });
    const config = {
        status: "configured",
        provider: "cloudflare",
        apiToken,
    };
    store.set("providers.dns", config);
    console.log(chalk.green("  ✓ Cloudflare DNS configured"));
    return config;
}
// ---------------------------------------------------------------------------
// Provider: S3
// ---------------------------------------------------------------------------
export async function ensureS3(provider) {
    const existing = store.get(`providers.s3.${provider}`);
    if (existing?.status === "configured") {
        return existing;
    }
    console.log(chalk.yellow(`\n  ${provider.toUpperCase()} S3 is not configured yet. Let's set it up.`));
    const accessKey = await password({ message: `${provider} S3 access key:` });
    const secretKey = await password({ message: `${provider} S3 secret key:` });
    let endpoint;
    let region;
    let location;
    if (provider === "hetzner") {
        location = await select({
            message: "Hetzner Object Storage location:",
            choices: [
                { name: "Nuremberg (nbg1)", value: "nbg1" },
                { name: "Falkenstein (fsn1)", value: "fsn1" },
                { name: "Helsinki (hel1)", value: "hel1" },
            ],
        });
        endpoint = `https://${location}.your-objectstorage.com`;
        region = location;
    }
    else if (provider === "r2") {
        const accountId = await input({ message: "Cloudflare account ID:", validate: validateRequired });
        endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
        region = "auto";
    }
    else {
        region = await input({ message: "AWS region:", default: "us-east-1" });
        endpoint = `https://s3.${region}.amazonaws.com`;
    }
    const config = {
        status: "configured",
        accessKey,
        secretKey,
        endpoint,
        region,
        location,
        lastVerified: new Date().toISOString(),
    };
    store.set(`providers.s3.${provider}`, config);
    console.log(chalk.green(`  ✓ ${provider} S3 configured`));
    return config;
}
// ---------------------------------------------------------------------------
// Provider: GPU (Modal, RunPod, etc.)
// ---------------------------------------------------------------------------
export async function ensureGpuProvider(platform) {
    const existing = store.get(`providers.gpu.${platform}`);
    if (existing?.status === "configured") {
        return existing;
    }
    console.log(chalk.yellow(`\n  ${platform} is not configured yet. Let's set it up.`));
    let config;
    switch (platform) {
        case "modal": {
            // Modal uses its own CLI auth
            const hasModal = await execOk("modal", ["token", "peek"]);
            if (!hasModal) {
                console.log("  Running modal setup...");
                const { execStream } = await import("./utils/exec.js");
                await execStream("modal", ["setup"]);
            }
            config = { status: "configured", lastVerified: new Date().toISOString() };
            break;
        }
        case "runpod": {
            const apiKey = await password({ message: "RunPod API key:" });
            config = { status: "configured", apiKey, lastVerified: new Date().toISOString() };
            break;
        }
        case "hf": {
            const apiKey = await password({ message: "HuggingFace token (from hf.co/settings/tokens):" });
            config = { status: "configured", apiKey, lastVerified: new Date().toISOString() };
            break;
        }
        case "replicate": {
            const apiKey = await password({ message: "Replicate API token:" });
            config = { status: "configured", apiKey, lastVerified: new Date().toISOString() };
            break;
        }
    }
    store.set(`providers.gpu.${platform}`, config);
    console.log(chalk.green(`  ✓ ${platform} configured`));
    return config;
}
// ---------------------------------------------------------------------------
// ML Service Registry
// ---------------------------------------------------------------------------
export function getMlServices() {
    return store.get("mlServices") || {};
}
export function registerMlService(name, entry) {
    store.set(`mlServices.${name}`, entry);
}
// ---------------------------------------------------------------------------
// First-time setup / onboarding
// ---------------------------------------------------------------------------
export async function isFirstRun() {
    const config = getConfig();
    return config.providers.github.status === "unconfigured" && !config.providers.coolify;
}
export async function runOnboarding() {
    console.log(chalk.bold("\n  Welcome! Let's set up your development infrastructure."));
    console.log(chalk.dim("  This is a one-time setup — credentials are stored locally in"));
    console.log(chalk.dim(`  ${getConfigPath()}\n`));
    // Core providers
    console.log(chalk.bold("  ── Core Providers (required) ──────────────────────────────\n"));
    await ensureGitHub();
    await ensureCoolify();
    // Infrastructure providers
    console.log(chalk.bold("\n  ── Infrastructure Providers ───────────────────────────────\n"));
    const configHetzner = await confirm({
        message: "Configure Hetzner Cloud? (needed for new servers)",
        default: true,
    });
    if (configHetzner) {
        await ensureHetzner();
    }
    await ensureDns();
    // Storage — all skippable
    console.log(chalk.bold("\n  ── Storage Providers (configure as needed) ────────────────\n"));
    const configStorage = await confirm({
        message: "Configure any S3 storage provider now?",
        default: false,
    });
    if (configStorage) {
        const s3Provider = await select({
            message: "Which S3 provider?",
            choices: [
                { name: "Hetzner Object Storage", value: "hetzner" },
                { name: "AWS S3", value: "aws" },
                { name: "Cloudflare R2", value: "r2" },
            ],
        });
        await ensureS3(s3Provider);
    }
    else {
        console.log(chalk.dim("  Skipped — will prompt when you first need S3 storage."));
    }
    // GPU — all skippable
    console.log(chalk.bold("\n  ── GPU / ML Providers (configure when needed) ─────────────\n"));
    console.log(chalk.dim("  Skipped — will prompt when you first add an ML service.\n"));
    // Done
    console.log(chalk.bold("  ── Done! ──────────────────────────────────────────────────\n"));
    const configuredProviders = ["GitHub"];
    if (store.get("providers.coolify"))
        configuredProviders.push("Coolify");
    if (store.get("providers.hetzner"))
        configuredProviders.push("Hetzner Cloud");
    if (store.get("providers.dns")?.provider !== "manual") {
        configuredProviders.push(store.get("providers.dns").provider.toUpperCase());
    }
    console.log(chalk.green(`  ✓ Providers configured: ${configuredProviders.join(", ")}`));
    console.log(chalk.dim("  ✓ Skipped providers will be prompted when first needed.\n"));
}
//# sourceMappingURL=config.js.map