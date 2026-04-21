import { join } from "node:path";
import chalk from "chalk";
import { getDnsConfig, getHetznerToken, getS3Config } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { exec, execStream } from "../utils/exec.js";

/** Run Terraform for the project. */
export async function runTerraform(config: ProjectConfig, repoRoot: string): Promise<void> {
  const hetznerToken = await getHetznerToken();
  const dnsConfig = await getDnsConfig();

  const stackDir =
    config.deployTarget === "new"
      ? join(repoRoot, "terraform", "stacks", "node-realtime")
      : join(repoRoot, "terraform", "stacks", "dns-only");

  const tfvarsFile = join(stackDir, `${config.name}.tfvars`);

  // Build env vars for Terraform
  const env: Record<string, string> = {};

  if (hetznerToken) {
    env.TF_VAR_hcloud_token = hetznerToken;
  }

  if (dnsConfig?.provider === "inwx") {
    env.TF_VAR_inwx_username = dnsConfig.username || "";
    env.TF_VAR_inwx_password = dnsConfig.password || "";
  }

  if (
    config.features.includes("s3") &&
    config.s3Provider !== "existing" &&
    config.s3Provider !== "none"
  ) {
    const s3 = await getS3Config(config.s3Provider);
    if (s3) {
      env.TF_VAR_s3_access_key = s3.accessKey;
      env.TF_VAR_s3_secret_key = s3.secretKey;
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
  const planExitCode = await execStream(
    "terraform",
    ["plan", `-var-file=${tfvarsFile}`, "-out=tfplan"],
    { cwd: stackDir, env },
  );
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
