import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import Conf from "conf";
import ora from "ora";
import { verifyCoolify } from "./utils/coolify-api.js";
import { execOk } from "./utils/exec.js";
import { SECRET_KEYS, clearAllSecrets, getSecret, setSecret } from "./utils/secrets.js";
import { validateRequired, validateUrl } from "./utils/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  status: "configured" | "unconfigured";
  lastVerified?: string;
}

// === Metadata types — these are what the Conf JSON holds (no secrets). ===

export interface CoolifyMeta extends ProviderStatus {
  url: string;
  serversCache?: Array<{ id: number; name: string; ip: string }>;
}

export interface HetznerMeta extends ProviderStatus {}

export interface DnsMeta extends ProviderStatus {
  provider: "inwx" | "cloudflare" | "manual";
  username?: string;
}

export interface S3ProviderMeta extends ProviderStatus {
  location?: string;
  endpoint?: string;
  region?: string;
}

export interface GpuProviderMeta extends ProviderStatus {
  tokenId?: string;
  endpointId?: string;
}

export interface GlitchtipMeta extends ProviderStatus {
  url: string;
  /** Cached org slug so the CLI doesn't re-prompt on every provision. */
  organizationSlug?: string;
  /** Default team slug inside that org (GlitchTip requires a team to
   *  own each project). */
  teamSlug?: string;
}

export interface OpenpanelMeta extends ProviderStatus {
  url: string;
  /** Default organization slug, used as the "project group" when
   *  creating a new project/client via the dashboard. */
  organizationSlug?: string;
}

export interface ResendMeta extends ProviderStatus {
  /** Optional default region for new sending domains ("us-east-1", "eu-west-1"…). */
  defaultRegion?: string;
}

// === Full-config types — metadata + the associated secret. These are
//     what `ensureX` returns and what deploy code typically wants. ===

export interface CoolifyConfig extends CoolifyMeta {
  token: string;
}
export interface HetznerConfig extends HetznerMeta {
  token: string;
}
export interface DnsConfig extends DnsMeta {
  password?: string;
  apiToken?: string;
}
export interface S3ProviderConfig extends S3ProviderMeta {
  accessKey: string;
  secretKey: string;
}
export interface GpuProviderConfig extends GpuProviderMeta {
  apiKey?: string;
  tokenSecret?: string;
}

export interface GlitchtipConfig extends GlitchtipMeta {
  token: string;
}
export interface OpenpanelConfig extends OpenpanelMeta {
  token: string;
}
export interface ResendConfig extends ResendMeta {
  apiKey: string;
}

export interface MlServiceEntry {
  platform: string;
  endpoint: string;
  deployedAt: string;
  gpu: string;
  model: string;
}

export interface CliConfig {
  version: number;
  providers: {
    github: ProviderStatus;
    coolify?: CoolifyMeta;
    hetzner?: HetznerMeta;
    dns?: DnsMeta;
    s3: Record<string, S3ProviderMeta>;
    gpu: Record<string, GpuProviderMeta>;
    glitchtip?: GlitchtipMeta;
    openpanel?: OpenpanelMeta;
    resend?: ResendMeta;
  };
  mlServices: Record<string, MlServiceEntry>;
  /** Ports that are already assigned to scaffolded projects so the
   *  picker avoids collisions across `hatchkit create` invocations. */
  usedPorts: number[];
}

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

// Tests set HATCHKIT_CONF_DIR to a temp path so they don't pollute
// the real user config. In normal CLI runs this is unset and Conf
// falls back to its default OS-specific location.
//
// If the JSON store is corrupt on disk (malformed, truncated, bogus
// schema), Conf throws from the constructor. Catch that here and
// reset rather than bricking the CLI for every subsequent command —
// a fresh config is recoverable (re-run `init`), a crash at import
// time is not.
const STORE_DEFAULTS: CliConfig = {
  version: 1,
  providers: {
    github: { status: "unconfigured" },
    s3: {},
    gpu: {},
  },
  mlServices: {},
  usedPorts: [],
};

function createStore(): Conf<CliConfig> {
  try {
    return new Conf<CliConfig>({
      projectName: "hatchkit",
      cwd: process.env.HATCHKIT_CONF_DIR,
      clearInvalidConfig: true,
      defaults: STORE_DEFAULTS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      chalk.yellow(
        `  [config] existing CLI config was unreadable (${msg}). Falling back to defaults; re-run \`hatchkit init\` to restore providers.`,
      ),
    );
    // Last resort: an in-memory-only store so commands that don't
    // touch persistent state still work in this session.
    return new Conf<CliConfig>({
      projectName: "hatchkit",
      cwd: process.env.HATCHKIT_CONF_DIR,
      defaults: STORE_DEFAULTS,
      // `fileExtension: "json"` + a throwaway fallback file name so
      // Conf writes next to (not over) the broken original.
      fileExtension: "json",
      configName: `config.recovered-${Date.now()}`,
    });
  }
}

const store = createStore();

export function getConfig(): CliConfig {
  return store.store;
}

export function getConfigPath(): string {
  return store.path;
}

/** Reset all CLI config. Clears providers and ML registry, plus every
 *  secret this CLI has stored in the OS keychain. */
export async function resetConfig(): Promise<void> {
  await clearAllSecrets();
  store.clear();
}

// ---------------------------------------------------------------------------
// Migration — move legacy plaintext secrets from Conf JSON to keytar the
// first time they're seen. Runs lazily inside the relevant ensure/get
// call so we don't spin up keytar for every CLI invocation.
// ---------------------------------------------------------------------------

async function migrateSecret(keyInStore: string, keytarKey: string): Promise<void> {
  // Conf's typed API restricts keys to `keyof CliConfig`. Migration
  // reaches into arbitrary nested paths ("providers.coolify.token",
  // etc.) that Conf supports at runtime but not in the type. Cast
  // once to a permissive shape for just these two operations so the
  // rest of the file keeps the typed API.
  const rawStore = store as unknown as {
    get(key: string): string | undefined;
    delete(key: string): void;
  };
  const raw = rawStore.get(keyInStore);
  if (!raw) return;
  await setSecret(keytarKey, raw);
  rawStore.delete(keyInStore);
}

// ---------------------------------------------------------------------------
// Provider: GitHub
// ---------------------------------------------------------------------------

export async function ensureGitHub(): Promise<void> {
  const isAuthed = await execOk("gh", ["auth", "status"]);
  if (isAuthed) {
    store.set("providers.github", {
      status: "configured",
      lastVerified: new Date().toISOString(),
    } satisfies ProviderStatus);
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

export async function ensureCoolify(): Promise<CoolifyConfig> {
  await migrateSecret("providers.coolify.token", SECRET_KEYS.coolifyToken);
  const existing = store.get("providers.coolify") as CoolifyMeta | undefined;
  const existingToken = await getSecret(SECRET_KEYS.coolifyToken);

  if (existing?.status === "configured" && existingToken) {
    // Skip verification if checked within last 24 hours
    const lastVerified = existing.lastVerified ? new Date(existing.lastVerified).getTime() : 0;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (lastVerified > oneDayAgo) {
      return { ...existing, token: existingToken };
    }
    // Verify connection is still valid
    try {
      await verifyCoolify(existing.url, existingToken);
      store.set("providers.coolify.lastVerified", new Date().toISOString());
      return { ...existing, token: existingToken };
    } catch {
      console.log(chalk.yellow("  Coolify token expired or invalid. Let's reconfigure."));
    }
  }

  const url = (
    await input({
      message: "Coolify dashboard URL:",
      default: existing?.url,
      validate: (v) => validateUrl(v.trim()),
    })
  ).trim();

  // Loop on the token until it authenticates — pasting the wrong token
  // is easy, and re-running the whole onboarding just to retry is rude.
  let token = "";
  for (;;) {
    token = (
      await password({
        message: "Coolify API token (from Settings → API Tokens):",
      })
    ).trim();

    const spinner = ora("Testing Coolify connection...").start();
    try {
      const version = await verifyCoolify(url, token);
      spinner.succeed(`Connected to Coolify v${version}`);
      break;
    } catch (error) {
      spinner.fail("Could not connect to Coolify");
      console.log(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}`));
      const retry = await confirm({
        message: "Try a different token?",
        default: true,
      });
      if (!retry) throw error;
    }
  }

  const { CoolifyApi } = await import("./utils/coolify-api.js");
  const api = new CoolifyApi({ url, token });
  const servers = await api.listServers();

  const meta: CoolifyMeta = {
    status: "configured",
    url,
    serversCache: servers,
    lastVerified: new Date().toISOString(),
  };
  store.set("providers.coolify", meta);
  await setSecret(SECRET_KEYS.coolifyToken, token);
  console.log(chalk.green(`  ✓ Coolify: ${servers.length} server(s) found`));
  return { ...meta, token };
}

/** Read Coolify config (meta + token) from storage. Returns null if not
 *  configured or if the secret has been removed out-of-band. */
export async function getCoolifyConfig(): Promise<CoolifyConfig | null> {
  await migrateSecret("providers.coolify.token", SECRET_KEYS.coolifyToken);
  const meta = store.get("providers.coolify") as CoolifyMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const token = await getSecret(SECRET_KEYS.coolifyToken);
  if (!token) return null;
  return { ...meta, token };
}

// ---------------------------------------------------------------------------
// Provider: Hetzner
// ---------------------------------------------------------------------------

export async function ensureHetzner(): Promise<HetznerConfig> {
  await migrateSecret("providers.hetzner.token", SECRET_KEYS.hetznerToken);
  const existing = store.get("providers.hetzner") as HetznerMeta | undefined;
  const existingToken = await getSecret(SECRET_KEYS.hetznerToken);

  if (existing?.status === "configured" && existingToken) {
    return { ...existing, token: existingToken };
  }

  const token = await password({
    message: "Hetzner Cloud API token:",
  });

  const spinner = ora("Testing Hetzner connection...").start();
  try {
    const res = await fetch("https://api.hetzner.cloud/v1/servers", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spinner.succeed("Hetzner Cloud connected");
  } catch (error) {
    spinner.fail("Could not connect to Hetzner Cloud");
    throw error;
  }

  const meta: HetznerMeta = {
    status: "configured",
    lastVerified: new Date().toISOString(),
  };
  store.set("providers.hetzner", meta);
  await setSecret(SECRET_KEYS.hetznerToken, token);
  return { ...meta, token };
}

export async function getHetznerToken(): Promise<string | null> {
  await migrateSecret("providers.hetzner.token", SECRET_KEYS.hetznerToken);
  return getSecret(SECRET_KEYS.hetznerToken);
}

// ---------------------------------------------------------------------------
// Provider: DNS
// ---------------------------------------------------------------------------

export async function ensureDns(): Promise<DnsConfig> {
  await migrateSecret("providers.dns.password", SECRET_KEYS.dnsInwxPassword);
  await migrateSecret("providers.dns.apiToken", SECRET_KEYS.dnsCloudflareToken);
  const existing = store.get("providers.dns") as DnsMeta | undefined;
  if (existing?.status === "configured") {
    const password = await getSecret(SECRET_KEYS.dnsInwxPassword);
    const apiToken = await getSecret(SECRET_KEYS.dnsCloudflareToken);
    return {
      ...existing,
      password: password ?? undefined,
      apiToken: apiToken ?? undefined,
    };
  }

  const provider = await select({
    message: "DNS provider:",
    choices: [
      { name: "INWX (auto-configure DNS)", value: "inwx" as const },
      { name: "Cloudflare DNS", value: "cloudflare" as const },
      { name: "Manual (I'll set DNS records myself)", value: "manual" as const },
    ],
  });

  if (provider === "manual") {
    const meta: DnsMeta = { status: "configured", provider: "manual" };
    store.set("providers.dns", meta);
    return { ...meta };
  }

  if (provider === "inwx") {
    const username = await input({ message: "INWX username:", validate: validateRequired });
    const pwd = await password({ message: "INWX password:" });
    const meta: DnsMeta = {
      status: "configured",
      provider: "inwx",
      username,
    };
    store.set("providers.dns", meta);
    await setSecret(SECRET_KEYS.dnsInwxPassword, pwd);
    console.log(chalk.green("  ✓ INWX DNS configured"));
    return { ...meta, password: pwd };
  }

  // Cloudflare
  const apiToken = await password({ message: "Cloudflare API token:" });
  const meta: DnsMeta = {
    status: "configured",
    provider: "cloudflare",
  };
  store.set("providers.dns", meta);
  await setSecret(SECRET_KEYS.dnsCloudflareToken, apiToken);
  console.log(chalk.green("  ✓ Cloudflare DNS configured"));
  return { ...meta, apiToken };
}

export async function getDnsConfig(): Promise<DnsConfig | null> {
  await migrateSecret("providers.dns.password", SECRET_KEYS.dnsInwxPassword);
  await migrateSecret("providers.dns.apiToken", SECRET_KEYS.dnsCloudflareToken);
  const meta = store.get("providers.dns") as DnsMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const password = await getSecret(SECRET_KEYS.dnsInwxPassword);
  const apiToken = await getSecret(SECRET_KEYS.dnsCloudflareToken);
  return {
    ...meta,
    password: password ?? undefined,
    apiToken: apiToken ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider: S3
// ---------------------------------------------------------------------------

export async function ensureS3(provider: "hetzner" | "aws" | "r2"): Promise<S3ProviderConfig> {
  await migrateSecret(`providers.s3.${provider}.accessKey`, SECRET_KEYS.s3AccessKey(provider));
  await migrateSecret(`providers.s3.${provider}.secretKey`, SECRET_KEYS.s3SecretKey(provider));
  const existing = store.get(`providers.s3.${provider}`) as S3ProviderMeta | undefined;
  const accessKey = await getSecret(SECRET_KEYS.s3AccessKey(provider));
  const secretKey = await getSecret(SECRET_KEYS.s3SecretKey(provider));
  if (existing?.status === "configured" && accessKey && secretKey) {
    return { ...existing, accessKey, secretKey };
  }

  console.log(
    chalk.yellow(`\n  ${provider.toUpperCase()} S3 is not configured yet. Let's set it up.`),
  );

  const promptedAccessKey = await password({ message: `${provider} S3 access key:` });
  const promptedSecretKey = await password({ message: `${provider} S3 secret key:` });

  let endpoint: string | undefined;
  let region: string | undefined;
  let location: string | undefined;

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
  } else if (provider === "r2") {
    const accountId = await input({
      message: "Cloudflare account ID:",
      validate: validateRequired,
    });
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    region = "auto";
  } else {
    region = await input({ message: "AWS region:", default: "us-east-1" });
    endpoint = `https://s3.${region}.amazonaws.com`;
  }

  const meta: S3ProviderMeta = {
    status: "configured",
    endpoint,
    region,
    location,
    lastVerified: new Date().toISOString(),
  };
  store.set(`providers.s3.${provider}`, meta);
  await setSecret(SECRET_KEYS.s3AccessKey(provider), promptedAccessKey);
  await setSecret(SECRET_KEYS.s3SecretKey(provider), promptedSecretKey);
  console.log(chalk.green(`  ✓ ${provider} S3 configured`));
  return { ...meta, accessKey: promptedAccessKey, secretKey: promptedSecretKey };
}

export async function getS3Config(provider: string): Promise<S3ProviderConfig | null> {
  await migrateSecret(`providers.s3.${provider}.accessKey`, SECRET_KEYS.s3AccessKey(provider));
  await migrateSecret(`providers.s3.${provider}.secretKey`, SECRET_KEYS.s3SecretKey(provider));
  const meta = store.get(`providers.s3.${provider}`) as S3ProviderMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const accessKey = await getSecret(SECRET_KEYS.s3AccessKey(provider));
  const secretKey = await getSecret(SECRET_KEYS.s3SecretKey(provider));
  if (!accessKey || !secretKey) return null;
  return { ...meta, accessKey, secretKey };
}

// ---------------------------------------------------------------------------
// Provider: GPU (Modal, RunPod, etc.)
// ---------------------------------------------------------------------------

export async function ensureGpuProvider(
  platform: "modal" | "runpod" | "hf" | "replicate",
): Promise<GpuProviderConfig> {
  await migrateSecret(`providers.gpu.${platform}.apiKey`, SECRET_KEYS.gpuApiKey(platform));
  const existing = store.get(`providers.gpu.${platform}`) as GpuProviderMeta | undefined;
  const existingKey = await getSecret(SECRET_KEYS.gpuApiKey(platform));
  if (existing?.status === "configured" && (platform === "modal" || existingKey)) {
    return { ...existing, apiKey: existingKey ?? undefined };
  }

  console.log(chalk.yellow(`\n  ${platform} is not configured yet. Let's set it up.`));

  let apiKey: string | undefined;

  switch (platform) {
    case "modal": {
      // Modal uses its own CLI auth — no API key to store here.
      const hasModal = await execOk("modal", ["token", "peek"]);
      if (!hasModal) {
        console.log("  Running modal setup...");
        const { execStream } = await import("./utils/exec.js");
        await execStream("modal", ["setup"]);
      }
      break;
    }
    case "runpod":
      apiKey = await password({ message: "RunPod API key:" });
      break;
    case "hf":
      apiKey = await password({ message: "HuggingFace token (from hf.co/settings/tokens):" });
      break;
    case "replicate":
      apiKey = await password({ message: "Replicate API token:" });
      break;
  }

  const meta: GpuProviderMeta = {
    status: "configured",
    lastVerified: new Date().toISOString(),
  };
  store.set(`providers.gpu.${platform}`, meta);
  if (apiKey) await setSecret(SECRET_KEYS.gpuApiKey(platform), apiKey);
  console.log(chalk.green(`  ✓ ${platform} configured`));
  return { ...meta, apiKey };
}

export async function getGpuConfig(platform: string): Promise<GpuProviderConfig | null> {
  await migrateSecret(`providers.gpu.${platform}.apiKey`, SECRET_KEYS.gpuApiKey(platform));
  const meta = store.get(`providers.gpu.${platform}`) as GpuProviderMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const apiKey = await getSecret(SECRET_KEYS.gpuApiKey(platform));
  return { ...meta, apiKey: apiKey ?? undefined };
}

// ---------------------------------------------------------------------------
// Port registry (shared across all scaffolded projects)
// ---------------------------------------------------------------------------

export function getUsedPorts(): number[] {
  return store.get("usedPorts") ?? [];
}

export function addUsedPorts(ports: number[]): void {
  const existing = new Set(getUsedPorts());
  for (const p of ports) existing.add(p);
  store.set(
    "usedPorts",
    [...existing].sort((a, b) => a - b),
  );
}

/** Remove ports from the used-ports registry. Used for rollback when a
 *  scaffold that already claimed ports subsequently fails. */
export function removeUsedPorts(ports: number[]): void {
  const remove = new Set(ports);
  const remaining = getUsedPorts().filter((p) => !remove.has(p));
  store.set("usedPorts", remaining);
}

// ---------------------------------------------------------------------------
// ML Service Registry
// ---------------------------------------------------------------------------

export function getMlServices(): Record<string, MlServiceEntry> {
  return store.get("mlServices") || {};
}

export function registerMlService(name: string, entry: MlServiceEntry): void {
  store.set(`mlServices.${name}`, entry);
}

// ---------------------------------------------------------------------------
// Provider: GlitchTip (self-hosted error tracking, Sentry-compatible API)
// ---------------------------------------------------------------------------

export async function ensureGlitchtip(): Promise<GlitchtipConfig> {
  const existing = store.get("providers.glitchtip") as GlitchtipMeta | undefined;
  const existingToken = await getSecret(SECRET_KEYS.glitchtipToken);

  if (existing?.status === "configured" && existingToken) {
    return { ...existing, token: existingToken };
  }

  console.log(chalk.yellow("\n  GlitchTip is not configured yet. Let's set it up."));
  const url = (
    await input({
      message: "GlitchTip base URL:",
      default: existing?.url ?? "https://glitchtip.trebeljahr.com",
      validate: (v) => validateUrl(v.trim()),
    })
  ).trim();
  const token = (
    await password({
      message: "GlitchTip auth token (Profile → Auth Tokens, needs project:admin):",
    })
  ).trim();
  const organizationSlug = (
    await input({
      message: "GlitchTip organization slug:",
      default: existing?.organizationSlug,
      validate: validateRequired,
    })
  ).trim();
  const teamSlug = (
    await input({
      message: "GlitchTip team slug (must exist under that org):",
      default: existing?.teamSlug,
      validate: validateRequired,
    })
  ).trim();

  const meta: GlitchtipMeta = {
    status: "configured",
    url: url.replace(/\/$/, ""),
    organizationSlug,
    teamSlug,
    lastVerified: new Date().toISOString(),
  };
  store.set("providers.glitchtip", meta);
  await setSecret(SECRET_KEYS.glitchtipToken, token);
  console.log(chalk.green("  ✓ GlitchTip configured"));
  return { ...meta, token };
}

export async function getGlitchtipConfig(): Promise<GlitchtipConfig | null> {
  const meta = store.get("providers.glitchtip") as GlitchtipMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const token = await getSecret(SECRET_KEYS.glitchtipToken);
  if (!token) return null;
  return { ...meta, token };
}

// ---------------------------------------------------------------------------
// Provider: OpenPanel (self-hosted product analytics)
// ---------------------------------------------------------------------------

export async function ensureOpenpanel(): Promise<OpenpanelConfig> {
  const existing = store.get("providers.openpanel") as OpenpanelMeta | undefined;
  const existingToken = await getSecret(SECRET_KEYS.openpanelToken);

  if (existing?.status === "configured" && existingToken) {
    return { ...existing, token: existingToken };
  }

  console.log(chalk.yellow("\n  OpenPanel is not configured yet. Let's set it up."));
  const url = (
    await input({
      message: "OpenPanel base URL:",
      default: existing?.url ?? "https://analytics.trebeljahr.com",
      validate: (v) => validateUrl(v.trim()),
    })
  ).trim();
  const token = (
    await password({
      message: "OpenPanel personal access token (Settings → Access Tokens):",
    })
  ).trim();
  const organizationSlug = (
    await input({
      message: "OpenPanel organization slug:",
      default: existing?.organizationSlug,
      validate: validateRequired,
    })
  ).trim();

  const meta: OpenpanelMeta = {
    status: "configured",
    url: url.replace(/\/$/, ""),
    organizationSlug,
    lastVerified: new Date().toISOString(),
  };
  store.set("providers.openpanel", meta);
  await setSecret(SECRET_KEYS.openpanelToken, token);
  console.log(chalk.green("  ✓ OpenPanel configured"));
  return { ...meta, token };
}

export async function getOpenpanelConfig(): Promise<OpenpanelConfig | null> {
  const meta = store.get("providers.openpanel") as OpenpanelMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const token = await getSecret(SECRET_KEYS.openpanelToken);
  if (!token) return null;
  return { ...meta, token };
}

// ---------------------------------------------------------------------------
// Provider: Resend (transactional email SaaS)
// ---------------------------------------------------------------------------

export async function ensureResend(): Promise<ResendConfig> {
  const existing = store.get("providers.resend") as ResendMeta | undefined;
  const existingKey = await getSecret(SECRET_KEYS.resendApiKey);

  if (existing?.status === "configured" && existingKey) {
    return { ...existing, apiKey: existingKey };
  }

  console.log(chalk.yellow("\n  Resend is not configured yet. Let's set it up."));
  const apiKey = (
    await password({
      message: "Resend API key (resend.com/api-keys, needs 'full access'):",
    })
  ).trim();

  const spinner = ora("Verifying Resend API key...").start();
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spinner.succeed("Resend API key verified");
  } catch (error) {
    spinner.fail("Could not verify Resend API key");
    throw error;
  }

  const meta: ResendMeta = {
    status: "configured",
    lastVerified: new Date().toISOString(),
  };
  store.set("providers.resend", meta);
  await setSecret(SECRET_KEYS.resendApiKey, apiKey);
  console.log(chalk.green("  ✓ Resend configured"));
  return { ...meta, apiKey };
}

export async function getResendConfig(): Promise<ResendConfig | null> {
  const meta = store.get("providers.resend") as ResendMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const apiKey = await getSecret(SECRET_KEYS.resendApiKey);
  if (!apiKey) return null;
  return { ...meta, apiKey };
}

// ---------------------------------------------------------------------------
// First-time setup / onboarding
// ---------------------------------------------------------------------------

export async function isFirstRun(): Promise<boolean> {
  const config = getConfig();
  return config.providers.github.status === "unconfigured" && !config.providers.coolify;
}

export async function runOnboarding(): Promise<void> {
  console.log(chalk.bold("\n  Welcome! Let's set up your development infrastructure."));
  console.log(chalk.dim("  This is a one-time setup — metadata is stored locally in"));
  console.log(chalk.dim(`  ${getConfigPath()}`));
  console.log(chalk.dim(`  Secrets (tokens, passwords) go to your OS keychain.\n`));

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
        { name: "Hetzner Object Storage", value: "hetzner" as const },
        { name: "AWS S3", value: "aws" as const },
        { name: "Cloudflare R2", value: "r2" as const },
      ],
    });
    await ensureS3(s3Provider);
  } else {
    console.log(chalk.dim("  Skipped — will prompt when you first need S3 storage."));
  }

  // Observability & email — all skippable
  console.log(chalk.bold("\n  ── Observability & Email (configure as needed) ────────────\n"));

  const configGlitchtip = await confirm({
    message: "Configure GlitchTip (error tracking)?",
    default: false,
  });
  if (configGlitchtip) await ensureGlitchtip();

  const configOpenpanel = await confirm({
    message: "Configure OpenPanel (product analytics)?",
    default: false,
  });
  if (configOpenpanel) await ensureOpenpanel();

  const configResend = await confirm({
    message: "Configure Resend (transactional email)?",
    default: false,
  });
  if (configResend) await ensureResend();

  // GPU — all skippable
  console.log(chalk.bold("\n  ── GPU / ML Providers (configure when needed) ─────────────\n"));
  console.log(chalk.dim("  Skipped — will prompt when you first add an ML service.\n"));

  // Done
  console.log(chalk.bold("  ── Done! ──────────────────────────────────────────────────\n"));

  const configuredProviders: string[] = ["GitHub"];
  if (store.get("providers.coolify")) configuredProviders.push("Coolify");
  if (store.get("providers.hetzner")) configuredProviders.push("Hetzner Cloud");
  const dnsMeta = store.get("providers.dns") as DnsMeta | undefined;
  if (dnsMeta?.provider && dnsMeta.provider !== "manual") {
    configuredProviders.push(dnsMeta.provider.toUpperCase());
  }
  if (store.get("providers.glitchtip")) configuredProviders.push("GlitchTip");
  if (store.get("providers.openpanel")) configuredProviders.push("OpenPanel");
  if (store.get("providers.resend")) configuredProviders.push("Resend");

  console.log(chalk.green(`  ✓ Providers configured: ${configuredProviders.join(", ")}`));
  console.log(chalk.dim("  ✓ Skipped providers will be prompted when first needed.\n"));
}
