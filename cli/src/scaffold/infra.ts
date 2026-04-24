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

  if (config.deployTarget === "new") {
    return renderString(TFVARS_TEMPLATE, {
      name: config.name,
      serverType: config.serverSize || "cpx21",
      serverLocation: config.serverLocation || "nbg1",
      domain: config.baseDomain,
      subdomains,
      s3Enabled: config.features.includes("s3") && config.s3Provider !== "existing",
      s3BucketName: `${config.name}-assets`,
      s3Location: config.serverLocation || "nbg1",
    });
  }

  // For existing server: DNS-only tfvars
  return renderString(DNS_ONLY_TFVARS_TEMPLATE, {
    domain: config.baseDomain,
    subdomains,
    targetIpv4: config.serverIp || "",
    targetIpv6: "",
  });
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

/** Write infra config files. */
export function scaffoldInfra(
  config: ProjectConfig,
  repoRoot: string,
  options: ScaffoldInfraOptions = {},
): void {
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
    return;
  }

  // Write Terraform tfvars
  const tfDir =
    config.deployTarget === "new"
      ? join(repoRoot, "terraform", "stacks", "node-realtime")
      : join(repoRoot, "terraform", "stacks", "dns-only");

  if (existsSync(tfDir)) {
    writeFileSync(join(tfDir, `${config.name}.tfvars`), tfvars, "utf-8");
    console.log(chalk.green(`  ✓ Terraform config: ${tfDir}/${config.name}.tfvars`));
  }

  // Write Coolify .env
  writeFileSync(join(stacksDir, `${config.name}.env`), coolifyEnv, "utf-8");
  console.log(chalk.green(`  ✓ Coolify config: stacks/${config.name}.env`));
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

const DNS_ONLY_TFVARS_TEMPLATE = `domain = "{{domain}}"
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
