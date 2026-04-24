import { join } from "node:path";
import chalk from "chalk";
import { type DnsConfig, getDnsConfig, getHetznerToken, getS3Config } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { exec, execStream } from "../utils/exec.js";
import { InwxApi } from "../utils/inwx-api.js";

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

  // DNS credentials. The stack's dns_provider variable decides which
  // provider actually *applies* records, but the INWX Terraform provider
  // calls account.login during Configure() regardless, so valid INWX
  // creds must always be passed through when we have them. Either the
  // primary DNS creds (provider = "inwx") or the registrar creds
  // (provider = "cloudflare" with INWX still holding the domain) satisfy
  // that requirement.
  if (dnsConfig?.provider === "inwx") {
    env.TF_VAR_inwx_username = dnsConfig.username || "";
    env.TF_VAR_inwx_password = dnsConfig.password || "";
  } else if (dnsConfig?.provider === "cloudflare") {
    env.TF_VAR_cloudflare_api_token = dnsConfig.apiToken || "";
    if (dnsConfig.registrarUsername && dnsConfig.registrarPassword) {
      env.TF_VAR_inwx_username = dnsConfig.registrarUsername;
      env.TF_VAR_inwx_password = dnsConfig.registrarPassword;
    }
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

  // Post-apply: if we just deployed to Cloudflare but the domain is
  // still registered at INWX, update INWX's delegated NS to point at
  // Cloudflare. This is the "auto-wire" step that would otherwise
  // require clicking through the INWX web UI for every domain.
  if (
    dnsConfig?.provider === "cloudflare" &&
    dnsConfig.registrarUsername &&
    dnsConfig.registrarPassword
  ) {
    await updateInwxNameserversFromTfOutput(stackDir, env, dnsConfig);
  }
}

/**
 * Read the stack's dns_provider + dns_domain + dns_nameservers outputs
 * and push them to INWX as the new delegated NS for that domain. No-op
 * if the stack didn't actually apply a Cloudflare zone (e.g. user kept
 * dns_provider = "inwx" in tfvars even though their CLI config says
 * Cloudflare).
 */
async function updateInwxNameserversFromTfOutput(
  stackDir: string,
  env: Record<string, string>,
  dnsConfig: DnsConfig,
): Promise<void> {
  const out = await exec("terraform", ["output", "-json"], {
    cwd: stackDir,
    env,
    silent: true,
  });
  if (out.exitCode !== 0) {
    console.log(chalk.yellow("  ! Could not read terraform outputs — skipping INWX NS update"));
    return;
  }

  type TfOutput<T> = { value: T };
  let parsed: {
    dns_provider?: TfOutput<string>;
    dns_domain?: TfOutput<string>;
    dns_nameservers?: TfOutput<string[]>;
  };
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    console.log(
      chalk.yellow("  ! terraform output -json was not valid JSON — skipping INWX NS update"),
    );
    return;
  }

  const appliedProvider = parsed.dns_provider?.value;
  const domain = parsed.dns_domain?.value;
  const nameservers = parsed.dns_nameservers?.value ?? [];

  if (appliedProvider !== "cloudflare") {
    // User explicitly picked INWX for this stack in tfvars — don't touch
    // the registrar even though their CLI config defaults to Cloudflare.
    return;
  }

  if (!domain || nameservers.length === 0) {
    console.log(
      chalk.yellow("  ! No Cloudflare nameservers in terraform output — skipping INWX NS update"),
    );
    return;
  }

  console.log(chalk.bold("\n  ── INWX registrar: pointing NS at Cloudflare ────────────\n"));
  console.log(chalk.dim(`  Domain:  ${domain}`));
  console.log(chalk.dim(`  New NS:  ${nameservers.join(", ")}`));

  // registrarUsername/Password presence is guaranteed by the caller's
  // guard — assert here to keep the types clean.
  if (!dnsConfig.registrarUsername || !dnsConfig.registrarPassword) {
    return;
  }

  const inwx = new InwxApi({
    username: dnsConfig.registrarUsername,
    password: dnsConfig.registrarPassword,
    sandbox: process.env.INWX_SANDBOX === "1",
  });

  try {
    await inwx.login();
    await inwx.setDomainNameservers(domain, nameservers);
    console.log(
      chalk.green(
        `  ✓ INWX: ${domain} now delegated to ${nameservers.length} Cloudflare nameservers`,
      ),
    );
    console.log(chalk.dim("    (TLD propagation can take 5 min to a few hours)"));
  } catch (error) {
    // Don't fail the whole deploy for an NS-update hiccup — the CF zone
    // is fine, the user can retry via `hatchkit dns link-to-cloudflare`.
    console.log(chalk.yellow(`  ! INWX NS update failed: ${(error as Error).message}`));
    console.log(chalk.dim(`    Retry with: hatchkit dns link-to-cloudflare ${domain}`));
  } finally {
    await inwx.logout().catch(() => {});
  }
}
