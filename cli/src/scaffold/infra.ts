import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { type S3ProviderMeta, getConfig } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { renderString } from "../utils/template.js";

/** Generate Terraform tfvars for the project. */
export function generateTfvars(config: ProjectConfig): string {
  // Avoid silent duplicate-key drop when the user's chosen subdomain
  // collides with a reserved name ("admin", "api.<sub>"). Build the map
  // iteratively and skip duplicates.
  const subdomains: Record<string, string> = {};
  const addSubdomain = (key: string, description: string) => {
    if (!key) return;
    if (subdomains[key]) return;
    subdomains[key] = description;
  };
  addSubdomain(config.subdomain, "Web app + API paths");
  addSubdomain(`api.${config.subdomain}`, "REST API");
  addSubdomain("admin", "Coolify dashboard");

  // The user's CLI DNS config decides which stack we target.
  // "manual" returns "" — caller skips writing tfvars entirely because
  // neither dns-only stack runs in that case.
  const cfgProvider = getConfig().providers.dns?.provider ?? "inwx";

  if (config.deployTarget === "new") {
    // node-realtime still uses the dual-provider stack (count-gated
    // modules). The same INWX-eager-auth footgun exists there — split
    // is deferred to a follow-up.
    const stackDnsProvider = cfgProvider === "cloudflare" ? "cloudflare" : "inwx";
    return renderString(TFVARS_TEMPLATE, {
      name: config.name,
      serverType: config.serverSize || "cpx21",
      serverLocation: config.serverLocation || "nbg1",
      domain: config.baseDomain,
      subdomains,
      dnsProvider: stackDnsProvider,
      cloudflareProxied: true,
      s3Enabled: config.features.includes("s3") && config.s3Provider !== "existing",
      s3BucketName: `${config.name}-assets`,
      s3Location: config.serverLocation || "nbg1",
    });
  }

  // For existing server: DNS-only tfvars, per-provider template.
  // `serverIpv4` is the validated public IPv4 we discovered up front
  // (via /servers/{uuid}/domains or DNS resolution of the dashboard
  // hostname). Falling back to the raw `serverIp` is only correct
  // when it happens to already be a routable IPv4 — but the same
  // validation Terraform performs would reject anything else, so the
  // empty-string fallback is harmless: tfvars renders `target_ipv4 = ""`,
  // terraform plan fails fast with a clear message, and the user
  // re-runs after the discovery issue is resolved (e.g. by setting
  // public_ipv4 in the Coolify dashboard).
  if (cfgProvider === "manual") return "";
  if (cfgProvider === "cloudflare") {
    return renderString(DNS_ONLY_CLOUDFLARE_TFVARS_TEMPLATE, {
      domain: config.baseDomain,
      subdomains,
      cloudflareProxied: true,
      targetIpv4: config.serverIpv4 || "",
      targetIpv6: config.serverIpv6 || "",
    });
  }
  return renderString(DNS_ONLY_INWX_TFVARS_TEMPLATE, {
    domain: config.baseDomain,
    subdomains,
    targetIpv4: config.serverIpv4 || "",
    targetIpv6: config.serverIpv6 || "",
  });
}

/**
 * Resolve the terraform stack directory for a project. Mirrored by
 * `runTerraform` in deploy/terraform.ts and by `rename-domain.ts`.
 *
 * For deployTarget === "existing" the dns-only stack is split per
 * provider (dns-only-cloudflare / dns-only-inwx) so each only configures
 * the one provider it actually needs. Returns null for manual DNS — no
 * Terraform stack runs.
 */
export function resolveStackDir(
  repoRoot: string,
  deployTarget: "new" | "existing",
  dnsProvider: "inwx" | "cloudflare" | "manual",
): string | null {
  if (deployTarget === "new") {
    return join(repoRoot, "terraform", "stacks", "node-realtime");
  }
  if (dnsProvider === "manual") return null;
  const name = dnsProvider === "cloudflare" ? "dns-only-cloudflare" : "dns-only-inwx";
  return join(repoRoot, "terraform", "stacks", name);
}

/** Generate Coolify stack .env for the project. */
export function generateCoolifyEnv(
  config: ProjectConfig,
  extras: { repoUrl?: string; serverPort?: number; clientPort?: number } = {},
): string {
  const coolifyConfig = getConfig().providers.coolify;
  const s3Config = getS3Config(config);

  return renderString(COOLIFY_ENV_TEMPLATE, {
    coolifyUrl: coolifyConfig?.url || "https://admin.example.com",
    name: config.name,
    domain: config.domain,
    repoUrl: extras.repoUrl ?? "",
    serverPort: extras.serverPort ?? 3000,
    clientPort: extras.clientPort ?? 3000,
    mongoEnabled: true,
    redisEnabled: config.features.includes("websocket"),
    s3Provider: config.s3Provider === "existing" ? "custom" : config.s3Provider,
    s3Bucket: s3Config?.bucket || "",
    s3Endpoint: s3Config?.endpoint || "",
    s3Region: s3Config?.region || "",
    stripe: config.features.includes("stripe"),
    analytics: config.features.includes("analytics"),
    mlServices: config.mlServices,
  });
}

export interface ScaffoldInfraOptions {
  repoUrl?: string;
  serverPort?: number;
  clientPort?: number;
}

export interface ScaffoldInfraResult {
  /** Absolute path of the tfvars file written, if any (omitted for
   *  manual DNS or when the stack dir doesn't exist). */
  tfvarsPath?: string;
  /** Absolute path of the Coolify stack .env written. */
  coolifyEnvPath?: string;
  /** The stack dir the tfvars went into — needed for the rollback
   *  ledger so we can run `terraform destroy` from the right place. */
  stackDir?: string;
}

/** Write infra config files. */
export function scaffoldInfra(
  config: ProjectConfig,
  repoRoot: string,
  options: ScaffoldInfraOptions = {},
): ScaffoldInfraResult {
  // Fail early with a clear message if the infra submodule isn't
  // populated — otherwise Terraform writes are silently skipped and the
  // later terraform/coolify exec steps crash cryptically.
  if (!config.dryRun && !existsSync(join(repoRoot, "terraform"))) {
    throw new Error(
      `Infra submodule is empty at ${repoRoot}. Run 'git submodule update --init' in the monorepo root before deploying.`,
    );
  }
  const stacksDir = join(repoRoot, "stacks");
  if (!existsSync(stacksDir)) mkdirSync(stacksDir, { recursive: true });

  const tfvars = generateTfvars(config);
  const coolifyEnv = generateCoolifyEnv(config, {
    repoUrl: options.repoUrl,
    serverPort: options.serverPort,
    clientPort: options.clientPort,
  });

  if (config.dryRun) {
    console.log(chalk.bold("\n  [dry-run] Infra config:\n"));
    console.log(chalk.dim("  --- terraform.tfvars ---"));
    console.log(chalk.dim(tfvars));
    console.log(chalk.dim("  --- coolify .env ---"));
    console.log(chalk.dim(coolifyEnv));
    return {};
  }

  const result: ScaffoldInfraResult = {};

  // Write Terraform tfvars (skipped for manual DNS — no stack runs).
  const cfgProvider = (getConfig().providers.dns?.provider ?? "inwx") as
    | "inwx"
    | "cloudflare"
    | "manual";
  const tfDir = resolveStackDir(repoRoot, config.deployTarget, cfgProvider);

  if (tfDir && tfvars && existsSync(tfDir)) {
    const tfvarsPath = join(tfDir, `${config.name}.tfvars`);
    writeFileSync(tfvarsPath, tfvars, "utf-8");
    console.log(chalk.green(`  ✓ Terraform config: ${tfDir}/${config.name}.tfvars`));
    result.tfvarsPath = tfvarsPath;
    result.stackDir = tfDir;
  } else if (cfgProvider === "manual") {
    console.log(
      chalk.dim("  (manual DNS — no Terraform stack to write; set DNS records yourself)"),
    );
  }

  // Write Coolify .env
  const coolifyEnvPath = join(stacksDir, `${config.name}.env`);
  writeFileSync(coolifyEnvPath, coolifyEnv, "utf-8");
  console.log(chalk.green(`  ✓ Coolify config: stacks/${config.name}.env`));
  result.coolifyEnvPath = coolifyEnvPath;

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getS3Config(
  config: ProjectConfig,
): { bucket: string; endpoint: string; region: string } | null {
  if (!config.features.includes("s3")) return null;

  if (config.s3Provider === "existing") {
    return {
      bucket: config.s3ExistingBucket || "",
      endpoint: config.s3ExistingEndpoint || "",
      region: config.s3ExistingRegion || "",
    };
  }

  const providerConfig = getConfig().providers.s3[config.s3Provider] as S3ProviderMeta | undefined;
  return {
    bucket: `${config.name}-assets`,
    endpoint: providerConfig?.endpoint || "",
    region: providerConfig?.region || "",
  };
}

// ---------------------------------------------------------------------------
// Templates (inline — small enough to not warrant separate files)
// ---------------------------------------------------------------------------

const TFVARS_TEMPLATE = `server_name     = "{{name}}-prod"
server_type     = "{{serverType}}"
server_location = "{{serverLocation}}"
ssh_key_name    = "deploy-key"
ssh_public_key  = "ssh-ed25519 CHANGE_ME"

dns_provider       = "{{dnsProvider}}"
cloudflare_proxied = {{cloudflareProxied}}

domain = "{{domain}}"
subdomains = {
{{#each subdomains}}
  "{{@key}}" = "{{this}}"
{{/each}}
}
dns_ttl = 300

firewall_enabled = true

{{#if s3Enabled}}
s3_enabled     = true
s3_bucket_name = "{{s3BucketName}}"
s3_bucket_acl  = "private"
s3_location    = "{{s3Location}}"
{{else}}
s3_enabled     = false
{{/if}}
`;

const DNS_ONLY_CLOUDFLARE_TFVARS_TEMPLATE = `cloudflare_proxied = {{cloudflareProxied}}

domain = "{{domain}}"
subdomains = {
{{#each subdomains}}
  "{{@key}}" = "{{this}}"
{{/each}}
}
target_ipv4 = "{{targetIpv4}}"
target_ipv6 = "{{targetIpv6}}"
dns_ttl = 300
`;

const DNS_ONLY_INWX_TFVARS_TEMPLATE = `domain = "{{domain}}"
subdomains = {
{{#each subdomains}}
  "{{@key}}" = "{{this}}"
{{/each}}
}
target_ipv4 = "{{targetIpv4}}"
target_ipv6 = "{{targetIpv6}}"
dns_ttl = 300
`;

const COOLIFY_ENV_TEMPLATE = `COOLIFY_URL="{{coolifyUrl}}"

PROJECT_NAME="{{name}}"
ENVIRONMENT_NAME="production"

APP_NAME="{{name}}-web"
GITHUB_REPO_URL="{{repoUrl}}"
APP_PORT="{{clientPort}}"
SERVER_PORT="{{serverPort}}"

APP_DOMAIN="{{domain}}"

MONGO_ENABLED="yes"
REDIS_ENABLED="{{#if redisEnabled}}yes{{else}}no{{/if}}"

S3_PROVIDER="{{s3Provider}}"
S3_BUCKET="{{s3Bucket}}"
S3_ENDPOINT="{{s3Endpoint}}"
S3_ACCESS_KEY=""
S3_SECRET_KEY=""
S3_REGION="{{s3Region}}"

{{#if stripe}}
STRIPE_SECRET_KEY=""
STRIPE_PUBLISHABLE_KEY=""
STRIPE_WEBHOOK_SECRET=""
{{/if}}

{{#if analytics}}
GLITCHTIP_DSN=""
OPENPANEL_API_URL=""
OPENPANEL_CLIENT_ID=""
OPENPANEL_CLIENT_SECRET=""
{{/if}}

{{#each mlServices}}
ML_{{this}}_ENDPOINT=""
{{/each}}

TOKEN_SECRET=""
`;
