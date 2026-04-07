import { join } from "node:path";
import chalk from "chalk";
import { exec, execStream } from "../utils/exec.js";
import { getConfig } from "../config.js";
/** Run Terraform for the project. */
export async function runTerraform(config, repoRoot) {
    const hetznerConfig = getConfig().providers.hetzner;
    const dnsConfig = getConfig().providers.dns;
    const s3Config = getConfig().providers.s3;
    const stackDir = config.deployTarget === "new"
        ? join(repoRoot, "terraform", "stacks", "node-realtime")
        : join(repoRoot, "terraform", "stacks", "dns-only");
    const tfvarsFile = join(stackDir, `${config.name}.tfvars`);
    // Build env vars for Terraform
    const env = {};
    if (hetznerConfig?.token) {
        env.TF_VAR_hcloud_token = hetznerConfig.token;
    }
    if (dnsConfig?.provider === "inwx") {
        env.TF_VAR_inwx_username = dnsConfig.username || "";
        env.TF_VAR_inwx_password = dnsConfig.password || "";
    }
    if (config.features.includes("s3") && config.s3Provider !== "existing") {
        const provider = s3Config[config.s3Provider];
        if (provider) {
            env.TF_VAR_s3_access_key = provider.accessKey;
            env.TF_VAR_s3_secret_key = provider.secretKey;
        }
    }
    console.log(chalk.bold("\n  ── Terraform ──────────────────────────────────────────────\n"));
    // Init
    const initResult = await exec("terraform", ["init"], {
        cwd: stackDir,
        env,
        spinner: "Initializing Terraform...",
    });
    if (initResult.exitCode !== 0) {
        throw new Error("Terraform init failed");
    }
    // Plan
    console.log(chalk.dim("\n  Running terraform plan...\n"));
    const planExitCode = await execStream("terraform", ["plan", `-var-file=${tfvarsFile}`, "-out=tfplan"], { cwd: stackDir, env });
    if (planExitCode !== 0) {
        throw new Error("Terraform plan failed");
    }
    // Apply
    console.log();
    const applyExitCode = await execStream("terraform", ["apply", "tfplan"], { cwd: stackDir, env });
    if (applyExitCode !== 0) {
        throw new Error("Terraform apply failed");
    }
    console.log(chalk.green("\n  ✓ Terraform apply complete"));
}
//# sourceMappingURL=terraform.js.map