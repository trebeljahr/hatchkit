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
  // For static there's no backend to receive traffic at api.<sub>, so
  // leave that record out entirely — provisioning it just clutters DNS
  // with a name that resolves to a server hosting nothing useful. The
  // "Web app + API paths" label is reused for fullstack/split/backend
  // (where the bare domain ALSO serves /api paths) and "Web app" for
  // static (just the web app).
  addSubdomain(
    config.subdomain || "@",
    config.surfaces === "static" ? "Web app" : "Web app + API paths",
  );
  if (config.surfaces !== "static") {
    addSubdomain(config.subdomain ? `api.${config.subdomain}` : "api", "REST API");
  }
  // Only provision admin.<domain> when we're spinning up a fresh Coolify
  // alongside the project. An existing Coolify already has its own
  // dashboard hostname (often on an unrelated domain), so pointing
  // admin.<thisproject> at the same IP just creates a stray record.
  if (config.deployTarget === "new") {
    addSubdomain("admin", "Coolify dashboard");
  }

  // DNS is Cloudflare-only as of v2.
  if (config.deployTarget === "new") {
    return renderString(TFVARS_TEMPLATE, {
      name: config.name,
      serverType: config.serverSize || "cpx21",
      serverLocation: config.serverLocation || "nbg1",
      domain: config.baseDomain,
      subdomains,
      dnsProvider: "cloudflare",
      cloudflareProxied: true,
      s3Enabled: config.features.includes("s3") && config.s3Provider !== "existing",
      s3BucketName: `${config.name}-assets`,
      s3Location: config.serverLocation || "nbg1",
    });
  }

  return renderString(DNS_ONLY_CLOUDFLARE_TFVARS_TEMPLATE, {
    domain: config.baseDomain,
    subdomains,
    cloudflareProxied: true,
    targetIpv4: config.serverIpv4 || "",
    targetIpv6: config.serverIpv6 || "",
  });
}

/**
 * Resolve the terraform stack directory for a project. Mirrored by
 * `runTerraform` in deploy/terraform.ts and by `rename-domain.ts`.
 *
 * DNS is Cloudflare-only as of v2 (the legacy INWX-DNS stack has been
 * removed). `dnsProvider` is retained as an argument so existing call
 * sites compile, but it has only one valid value.
 */
export function resolveStackDir(
  repoRoot: string,
  deployTarget: "new" | "existing",
  _dnsProvider: "cloudflare",
): string | null {
  if (deployTarget === "new") {
    return join(repoRoot, "terraform", "stacks", "node-realtime");
  }
  return join(repoRoot, "terraform", "stacks", "dns-only-cloudflare");
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
    mongoEnabled: config.surfaces !== "static" && (config.dbEngine ?? "mongodb") === "mongodb",
    postgresEnabled: config.surfaces !== "static" && config.dbEngine === "postgres",
    redisEnabled: config.features.includes("websocket") && config.surfaces !== "static",
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
  // Fail early with a clear message if infra/ is missing — otherwise
  // Terraform writes are silently skipped and the later terraform /
  // coolify exec steps crash cryptically.
  if (!config.dryRun && !existsSync(join(repoRoot, "terraform"))) {
    throw new Error(
      `Infra tree empty at ${repoRoot}. Your hatchkit checkout looks incomplete — re-clone or pull the latest main.`,
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

  // Write Terraform tfvars. DNS is Cloudflare-only.
  const tfDir = resolveStackDir(repoRoot, config.deployTarget, "cloudflare");

  if (tfDir && tfvars && existsSync(tfDir)) {
    const tfvarsPath = join(tfDir, `${config.name}.tfvars`);
    writeFileSync(tfvarsPath, tfvars, "utf-8");
    console.log(chalk.green(`  ✓ Terraform config: ${tfDir}/${config.name}.tfvars`));
    result.tfvarsPath = tfvarsPath;
    result.stackDir = tfDir;
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

const COOLIFY_ENV_TEMPLATE = `COOLIFY_URL="{{coolifyUrl}}"

PROJECT_NAME="{{name}}"
ENVIRONMENT_NAME="production"

APP_NAME="{{name}}"
GITHUB_REPO_URL="{{repoUrl}}"
APP_PORT="{{clientPort}}"
SERVER_PORT="{{serverPort}}"

APP_DOMAIN="{{domain}}"

MONGO_ENABLED="{{#if mongoEnabled}}yes{{else}}no{{/if}}"
POSTGRES_ENABLED="{{#if postgresEnabled}}yes{{else}}no{{/if}}"
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
PLAUSIBLE_DOMAIN=""
PLAUSIBLE_SCRIPT_URL=""
{{/if}}

{{#each mlServices}}
ML_{{this}}_ENDPOINT=""
{{/each}}

TOKEN_SECRET=""
`;
