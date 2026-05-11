import { promises as dnsPromises } from "node:dns";
import { select } from "@inquirer/prompts";
import chalk from "chalk";
import {
  type DnsConfig,
  getDnsConfig,
  getHetznerToken,
  getS3Config,
  promptAndSaveInwxRegistrarCreds,
} from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { resolveStackDir } from "../scaffold/infra.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { exec, execStream } from "../utils/exec.js";
import { InwxApi } from "../utils/inwx-api.js";

/**
 * Outcome of the registrar-flip preflight. Decided before plan; consumed
 * after apply to decide whether to call INWX.
 *
 *  - flip:  perform the NS-flip post-apply with these creds
 *  - skip:  no-op post-apply (already pointed, or user opted out)
 */
type RegistrarPlan =
  | { action: "flip"; registrarUsername: string; registrarPassword: string }
  | { action: "skip"; reason: string };

/** Result of `runTerraform`. Returns metadata the caller can record in
 *  the run ledger so a later rollback knows which stack to destroy. */
export interface RunTerraformResult {
  /** Set when an apply actually ran. Undefined for manual-DNS or skip. */
  applied?: { stackDir: string; tfvarsPath: string };
}

/** Run Terraform for the project. */
export async function runTerraform(
  config: ProjectConfig,
  repoRoot: string,
): Promise<RunTerraformResult> {
  const hetznerToken = await getHetznerToken();
  const dnsConfig = await getDnsConfig();
  // DNS is Cloudflare-only as of v2. Older stacks (`dns-only-inwx`) are
  // gone — `resolveStackDir` always returns the cloudflare-flavour path.
  const dnsProvider = "cloudflare" as const;

  console.log(chalk.bold("\n  ── Terraform ──────────────────────────────────────────────\n"));

  const stackDir = resolveStackDir(repoRoot, config.deployTarget, dnsProvider);
  if (!stackDir) {
    console.log(chalk.dim("  No matching Terraform stack — skipping."));
    return {};
  }
  const tfvarsFile = `${stackDir}/${config.name}.tfvars`;

  // Build env vars for Terraform — only what the chosen stack needs.
  const env: Record<string, string> = {};

  if (hetznerToken) {
    env.TF_VAR_hcloud_token = hetznerToken;
  }

  // Preflight + DNS creds. Cloudflare-only path; INWX creds flow through
  // only when the user told us their domain is *registered* at INWX
  // (registrarUsername present), and only for the post-apply NS flip.
  let registrarPlan: RegistrarPlan | null = null;
  if (!dnsConfig?.apiToken) {
    throw new Error(
      "Cloudflare API token is missing from the keychain. Re-run `hatchkit config add dns`.",
    );
  }
  env.TF_VAR_cloudflare_api_token = dnsConfig.apiToken;

  if (config.deployTarget === "new") {
    if (dnsConfig.registrarUsername && dnsConfig.registrarPassword) {
      env.TF_VAR_inwx_username = dnsConfig.registrarUsername;
      env.TF_VAR_inwx_password = dnsConfig.registrarPassword;
    }
  } else {
    // dns-only-cloudflare: figure out whether a registrar NS-flip is
    // even needed *before* terraform runs, and prompt for INWX creds
    // inline if it is. We only block on a working answer here so that
    // the post-apply step has what it needs (or knows to skip).
    registrarPlan = await preflightRegistrarFlip(config.baseDomain, dnsConfig);
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

  // Post-apply: NS-flip if dns-only-cloudflare path decided one was
  // needed and we now have creds. Both decisions live in registrarPlan
  // so this code doesn't re-derive intent.
  if (registrarPlan?.action === "flip") {
    await updateInwxNameserversFromTfOutput(stackDir, env, {
      username: registrarPlan.registrarUsername,
      password: registrarPlan.registrarPassword,
    });
  } else if (registrarPlan?.action === "skip") {
    console.log(chalk.dim(`  (registrar NS-flip skipped — ${registrarPlan.reason})`));
  } else if (
    config.deployTarget === "new" &&
    dnsProvider === "cloudflare" &&
    dnsConfig?.registrarUsername &&
    dnsConfig.registrarPassword
  ) {
    // Legacy node-realtime path — preserve the original behavior.
    await updateInwxNameserversFromTfOutput(stackDir, env, {
      username: dnsConfig.registrarUsername,
      password: dnsConfig.registrarPassword,
    });
  }

  return { applied: { stackDir, tfvarsPath: tfvarsFile } };
}

/**
 * Decide whether the registrar NS-flip is worth doing for this deploy:
 *
 *   1. Look the domain up in Cloudflare → its assigned name_servers.
 *   2. Resolve the current public NS for the domain.
 *   3. If they already match → skip (NS already pointed at Cloudflare).
 *   4. If they don't match → a flip is needed. Use saved INWX registrar
 *      creds if present; otherwise prompt for them inline (with an
 *      "I'll do it manually" escape hatch).
 *
 * Returns a plan describing what post-apply should do. Network errors
 * during the lookup (CF API down, no internet) degrade gracefully into
 * "skip" with a note — the user can re-run `hatchkit dns
 * link-to-cloudflare` later.
 */
async function preflightRegistrarFlip(
  domain: string,
  dnsConfig: DnsConfig,
): Promise<RegistrarPlan> {
  console.log(chalk.dim("\n  Checking whether the registrar NS-flip is needed..."));

  // Strip subdomain — registrar delegation is at the apex.
  const apex = apexDomain(domain);

  let expectedNs: string[];
  try {
    if (!dnsConfig.apiToken) {
      return { action: "skip", reason: "no Cloudflare token to look up zone" };
    }
    const cf = new CloudflareApi({ token: dnsConfig.apiToken, accountId: dnsConfig.accountId });
    const zone = await cf.getZoneByName(apex);
    if (!zone) {
      return {
        action: "skip",
        reason: `${apex} isn't in your Cloudflare account yet — add the zone, then re-run`,
      };
    }
    expectedNs = zone.name_servers.map((n) => n.toLowerCase()).sort();
  } catch (err) {
    return { action: "skip", reason: `Cloudflare lookup failed: ${(err as Error).message}` };
  }

  let currentNs: string[];
  try {
    const ns = await dnsPromises.resolveNs(apex);
    currentNs = ns.map((n) => n.toLowerCase()).sort();
  } catch {
    // ENOTFOUND on a brand-new domain just means "no NS yet" — we
    // definitely need the flip.
    currentNs = [];
  }

  const same =
    currentNs.length === expectedNs.length && currentNs.every((n, i) => n === expectedNs[i]);
  if (same) {
    return { action: "skip", reason: "NS already point at Cloudflare" };
  }

  console.log(chalk.dim(`    expected NS: ${expectedNs.join(", ")}`));
  console.log(chalk.dim(`    current NS:  ${currentNs.length ? currentNs.join(", ") : "(none)"}`));

  // Need a flip. Try saved creds first.
  if (dnsConfig.registrarUsername && dnsConfig.registrarPassword) {
    return {
      action: "flip",
      registrarUsername: dnsConfig.registrarUsername,
      registrarPassword: dnsConfig.registrarPassword,
    };
  }

  // No saved creds — ask inline.
  console.log(
    chalk.yellow(
      `\n  ${apex} needs its registrar NS pointed at Cloudflare, but INWX registrar creds aren't configured.`,
    ),
  );
  const choice = await select<"provide" | "skip">({
    message: "How would you like to proceed?",
    choices: [
      {
        name: "Provide INWX registrar credentials now (saved to keychain for reuse)",
        value: "provide",
      },
      {
        name: "Skip — I'll point NS at Cloudflare manually (or my registrar isn't INWX)",
        value: "skip",
      },
    ],
  });

  if (choice === "skip") {
    return { action: "skip", reason: "user opted to flip NS manually" };
  }

  const creds = await promptAndSaveInwxRegistrarCreds();
  return {
    action: "flip",
    registrarUsername: creds.username,
    registrarPassword: creds.password,
  };
}

/** "ai.example.com" → "example.com". TLDs with second-level domains
 *  (".co.uk") aren't auto-detected — registrar lookups only happen on
 *  the apex anyway, so we just take the last two labels. Good enough
 *  for >99% of cases; users with country-code 2LDs can pre-configure
 *  registrar creds. */
function apexDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

/**
 * Read the stack's dns_provider + dns_domain + dns_nameservers outputs
 * and push them to INWX as the new delegated NS for that domain. No-op
 * if the stack didn't actually apply a Cloudflare zone (e.g. legacy
 * node-realtime stack with dns_provider = "inwx" in tfvars). Caller is
 * responsible for the decision to call this — the registrar plan in
 * `runTerraform` handles preflight + creds.
 */
async function updateInwxNameserversFromTfOutput(
  stackDir: string,
  env: Record<string, string>,
  registrarCreds: { username: string; password: string },
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

  const inwx = new InwxApi({
    username: registrarCreds.username,
    password: registrarCreds.password,
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
