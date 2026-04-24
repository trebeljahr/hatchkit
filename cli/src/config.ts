import { Separator, confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import Conf from "conf";
import ora from "ora";
import { verifyCoolify } from "./utils/coolify-api.js";
import { execOk } from "./utils/exec.js";
import { SECRET_KEYS, clearAllSecrets, deleteSecret, getSecret, setSecret } from "./utils/secrets.js";
import { validateRequired, validateUrl } from "./utils/validate.js";

/** Pretty-print "where to create this token" hint before a password prompt. */
function tokenHint(url: string, scope: string): void {
  console.log(chalk.dim(`  → Create at: ${chalk.cyan(url)}`));
  console.log(chalk.dim(`    Permissions: ${scope}`));
}

/** Sanitize pasted secret: strip bracketed-paste escapes + non-printable
 *  ASCII that some terminals inject on paste. Plain `.trim()` misses these. */
function sanitizePastedSecret(raw: string): string {
  return raw
    .replace(/\x1b\[2\d\d~/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
}

/** Prompt for a secret, show a masked preview (`abcd…wxyz, 50 chars`),
 *  and let the user re-enter if the paste looks wrong. Loops until the
 *  user confirms. Values are never echoed in full. */
async function confirmPastedSecret(label: string): Promise<string> {
  for (;;) {
    const raw = await password({ message: `${label}:` });
    const value = sanitizePastedSecret(raw);
    if (!value) {
      console.log(chalk.yellow("  (empty — please paste again)"));
      continue;
    }
    const preview =
      value.length <= 8
        ? `${"*".repeat(value.length)} (${value.length} chars — looks short?)`
        : `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
    const ok = await confirm({
      message: `Looks like: ${chalk.cyan(preview)} — use this?`,
      default: true,
    });
    if (ok) return value;
  }
}

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
  /** Root-mode credentials for the Management API. */
  rootClientId: string;
  rootClientSecret: string;
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

/** Exposed for internal modules that need raw access (e.g. the `doctor`
 *  command). External consumers should prefer the typed `getXConfig()`
 *  helpers. */
export function getStore() {
  return store;
}

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
  tokenHint(`${url.replace(/\/$/, "")}/security/api-tokens`, "root (full access)");
  for (;;) {
    token = await confirmPastedSecret("Coolify API token");

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

  tokenHint(
    "https://console.hetzner.cloud/projects → Security → API Tokens",
    "Read & Write (needed to create servers)",
  );
  const token = await confirmPastedSecret("Hetzner Cloud API token");

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

export async function getHetznerConfig(): Promise<HetznerConfig | null> {
  const meta = store.get("providers.hetzner") as HetznerMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const token = await getHetznerToken();
  if (!token) return null;
  return { ...meta, token };
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
    const pwd = await confirmPastedSecret("INWX password");
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
  tokenHint(
    "https://dash.cloudflare.com/profile/api-tokens → Create Token",
    "Zone:DNS:Edit + Zone:Zone:Read (scope to the zones you'll use)",
  );
  const apiToken = await confirmPastedSecret("Cloudflare API token");
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

  // For R2 we need the account id BEFORE showing the create-token URL, so
  // we can deep-link to the account-scoped page.
  let endpoint: string | undefined;
  let region: string | undefined;
  let location: string | undefined;
  let accountId: string | undefined;

  if (provider === "r2") {
    console.log(
      chalk.dim(
        "  Your Cloudflare account ID is in the dashboard URL:\n" +
          "    dash.cloudflare.com/<account-id>/home/overview",
      ),
    );
    accountId = (
      await input({
        message: "Cloudflare account ID:",
        validate: validateRequired,
      })
    ).trim();
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    region = "auto";
  }

  const s3Hints = {
    hetzner: {
      url: "https://console.hetzner.cloud → your project → Security → S3 credentials",
      scope: "any (credentials are per-project)",
    },
    aws: {
      url: "https://console.aws.amazon.com/iam → Users → Security credentials → Create access key",
      scope: "s3:PutObject, s3:GetObject, s3:DeleteObject on the target bucket",
    },
    r2: {
      url: `https://dash.cloudflare.com/${accountId ?? ""}/r2/api-tokens → Create Token`,
      scope: "Object Read & Write — then copy from the 'Use the following credentials for S3 clients' section (NOT the 'Token value' at the top)",
    },
  } as const;
  tokenHint(s3Hints[provider].url, s3Hints[provider].scope);

  const promptedAccessKey = await confirmPastedSecret(`${provider} S3 Access Key ID`);
  const promptedSecretKey = await confirmPastedSecret(`${provider} S3 Secret Access Key`);

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
  } else if (provider === "aws") {
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
      tokenHint("https://runpod.io/user/settings → API Keys", "Read & Write");
      apiKey = await confirmPastedSecret("RunPod API key");
      break;
    case "hf":
      tokenHint(
        "https://huggingface.co/settings/tokens",
        "Read (or Write if you'll push models)",
      );
      apiKey = await confirmPastedSecret("HuggingFace token");
      break;
    case "replicate":
      tokenHint("https://replicate.com/account/api-tokens", "any (account-scoped)");
      apiKey = await confirmPastedSecret("Replicate API token");
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
  tokenHint(
    `${url.replace(/\/$/, "")}/profile/auth-tokens`,
    "project:admin (read + write projects & teams)",
  );
  const token = await confirmPastedSecret("GlitchTip auth token");
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
  const existingId = await getSecret(SECRET_KEYS.openpanelRootClientId);
  const existingSecret = await getSecret(SECRET_KEYS.openpanelRootClientSecret);

  if (existing?.status === "configured" && existingId && existingSecret) {
    return { ...existing, rootClientId: existingId, rootClientSecret: existingSecret };
  }

  console.log(chalk.yellow("\n  OpenPanel is not configured yet. Let's set it up."));
  const url = (
    await input({
      message: "OpenPanel base URL:",
      default: existing?.url ?? "https://analytics.trebeljahr.com",
      validate: (v) => validateUrl(v.trim()),
    })
  ).trim();
  const organizationSlug = (
    await input({
      message: "OpenPanel organization slug:",
      default: existing?.organizationSlug,
      validate: validateRequired,
    })
  ).trim();

  console.log(
    chalk.dim(
      `\n  OpenPanel auth uses a client id/secret pair, not a bearer token.\n` +
        `  Create a root-mode client once so hatchkit can auto-create\n` +
        `  per-project clients via the Management API.`,
    ),
  );
  tokenHint(
    `${url.replace(/\/$/, "")}/${organizationSlug}/settings/clients`,
    "Type: root (Management API access — full org-wide)",
  );
  const rootClientId = (
    await input({
      message: "OpenPanel root clientId:",
      validate: validateRequired,
    })
  ).trim();
  const rootClientSecret = await confirmPastedSecret(
    "OpenPanel root clientSecret (shown once at creation)",
  );

  const meta: OpenpanelMeta = {
    status: "configured",
    url: url.replace(/\/$/, ""),
    organizationSlug,
    lastVerified: new Date().toISOString(),
  };
  store.set("providers.openpanel", meta);
  await setSecret(SECRET_KEYS.openpanelRootClientId, rootClientId);
  await setSecret(SECRET_KEYS.openpanelRootClientSecret, rootClientSecret);
  console.log(chalk.green("  ✓ OpenPanel configured"));
  return { ...meta, rootClientId, rootClientSecret };
}

export async function getOpenpanelConfig(): Promise<OpenpanelConfig | null> {
  const meta = store.get("providers.openpanel") as OpenpanelMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const rootClientId = await getSecret(SECRET_KEYS.openpanelRootClientId);
  const rootClientSecret = await getSecret(SECRET_KEYS.openpanelRootClientSecret);
  if (!rootClientId || !rootClientSecret) return null;
  return { ...meta, rootClientId, rootClientSecret };
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
  tokenHint("https://resend.com/api-keys", "Full access (needed to create domain-scoped keys)");
  const apiKey = await confirmPastedSecret("Resend API key");

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

// ---------------------------------------------------------------------------
// Stepper — hatchkit setup as a pickable menu of provider steps
// ---------------------------------------------------------------------------

/** One provider step in the setup stepper. A step knows its current status
 *  (rendered next to its name in the menu) and how to (re)configure itself. */
interface SetupStep {
  /** Stable id — used to keep the same step selected across reruns. */
  key: string;
  /** Human label shown in the menu. */
  label: string;
  /** Returns `{ configured, summary? }`. Called before every render. */
  status: () => { configured: boolean; summary?: string };
  /** Runs the provider setup, wiping any stored meta/secrets first so the
   *  ensureFn always re-prompts (otherwise it early-returns). */
  run: () => Promise<void>;
}

/** Wipe a provider's stored meta + secret keys so its ensureFn re-prompts. */
async function wipeProvider(storeKey: string, secretKeys: string[]): Promise<void> {
  store.delete(storeKey);
  for (const k of secretKeys) await deleteSecret(k);
}

type ReconfigurableProvider =
  | "coolify"
  | "hetzner"
  | "dns"
  | "glitchtip"
  | "openpanel"
  | "resend"
  | `s3.${"hetzner" | "aws" | "r2"}`
  | `gpu.${"modal" | "runpod" | "hf" | "replicate"}`;

/** Wipe + re-prompt for a single provider. Shared by the stepper and by
 *  `hatchkit config add <provider>` so both paths always re-prompt rather
 *  than silently no-op on already-configured providers. */
export async function reconfigureProvider(name: ReconfigurableProvider): Promise<void> {
  if (name === "coolify") {
    await wipeProvider("providers.coolify", [SECRET_KEYS.coolifyToken]);
    await ensureCoolify();
  } else if (name === "hetzner") {
    await wipeProvider("providers.hetzner", [SECRET_KEYS.hetznerToken]);
    await ensureHetzner();
  } else if (name === "dns") {
    await wipeProvider("providers.dns", [
      SECRET_KEYS.dnsInwxPassword,
      SECRET_KEYS.dnsCloudflareToken,
    ]);
    await ensureDns();
  } else if (name === "glitchtip") {
    await wipeProvider("providers.glitchtip", [SECRET_KEYS.glitchtipToken]);
    await ensureGlitchtip();
  } else if (name === "openpanel") {
    await wipeProvider("providers.openpanel", [
      SECRET_KEYS.openpanelRootClientId,
      SECRET_KEYS.openpanelRootClientSecret,
    ]);
    await ensureOpenpanel();
  } else if (name === "resend") {
    await wipeProvider("providers.resend", [SECRET_KEYS.resendApiKey]);
    await ensureResend();
  } else if (name.startsWith("s3.")) {
    const p = name.slice(3) as "hetzner" | "aws" | "r2";
    await wipeProvider(`providers.s3.${p}`, [
      SECRET_KEYS.s3AccessKey(p),
      SECRET_KEYS.s3SecretKey(p),
    ]);
    await ensureS3(p);
  } else if (name.startsWith("gpu.")) {
    const p = name.slice(4) as "modal" | "runpod" | "hf" | "replicate";
    await wipeProvider(`providers.gpu.${p}`, [SECRET_KEYS.gpuApiKey(p)]);
    await ensureGpuProvider(p);
  }
}

interface SetupGroup {
  title: string;
  steps: SetupStep[];
}

function buildSetupGroups(): SetupGroup[] {
  return [
    {
      title: "Core",
      steps: [
        {
          key: "github",
          label: "GitHub (gh CLI)",
          status: () => {
            const s = store.get("providers.github.status") as string | undefined;
            return { configured: s === "configured" };
          },
          run: async () => {
            store.set("providers.github.status", "unconfigured");
            await ensureGitHub();
          },
        },
        {
          key: "coolify",
          label: "Coolify",
          status: () => {
            const m = store.get("providers.coolify") as CoolifyMeta | undefined;
            return { configured: m?.status === "configured", summary: m?.url };
          },
          run: () => reconfigureProvider("coolify"),
        },
      ],
    },
    {
      title: "Infrastructure",
      steps: [
        {
          key: "hetzner",
          label: "Hetzner Cloud",
          status: () => {
            const m = store.get("providers.hetzner") as HetznerMeta | undefined;
            return { configured: m?.status === "configured" };
          },
          run: () => reconfigureProvider("hetzner"),
        },
        {
          key: "dns",
          label: "DNS",
          status: () => {
            const m = store.get("providers.dns") as DnsMeta | undefined;
            return {
              configured: m?.status === "configured",
              summary: m?.provider && m.provider !== "manual" ? m.provider : undefined,
            };
          },
          run: () => reconfigureProvider("dns"),
        },
      ],
    },
    {
      title: "S3 Storage",
      steps: (["hetzner", "aws", "r2"] as const).map((p) => ({
        key: `s3.${p}`,
        label: p === "hetzner" ? "Hetzner Object Storage" : p === "aws" ? "AWS S3" : "Cloudflare R2",
        status: () => {
          const m = store.get(`providers.s3.${p}`) as S3ProviderMeta | undefined;
          return { configured: m?.status === "configured", summary: m?.endpoint };
        },
        run: () => reconfigureProvider(`s3.${p}`),
      })),
    },
    {
      title: "Observability & Email",
      steps: [
        {
          key: "glitchtip",
          label: "GlitchTip (error tracking)",
          status: () => {
            const m = store.get("providers.glitchtip") as GlitchtipMeta | undefined;
            return { configured: m?.status === "configured", summary: m?.url };
          },
          run: () => reconfigureProvider("glitchtip"),
        },
        {
          key: "openpanel",
          label: "OpenPanel (product analytics)",
          status: () => {
            const m = store.get("providers.openpanel") as OpenpanelMeta | undefined;
            return { configured: m?.status === "configured", summary: m?.url };
          },
          run: () => reconfigureProvider("openpanel"),
        },
        {
          key: "resend",
          label: "Resend (transactional email)",
          status: () => {
            const m = store.get("providers.resend") as ResendMeta | undefined;
            return { configured: m?.status === "configured" };
          },
          run: () => reconfigureProvider("resend"),
        },
      ],
    },
    {
      title: "GPU / ML Providers",
      steps: (
        [
          { key: "modal", name: "Modal" },
          { key: "runpod", name: "RunPod" },
          { key: "hf", name: "HuggingFace Inference" },
          { key: "replicate", name: "Replicate" },
        ] as const
      ).map((p) => ({
        key: `gpu.${p.key}`,
        label: p.name,
        status: () => {
          const m = store.get(`providers.gpu.${p.key}`) as GpuProviderMeta | undefined;
          return { configured: m?.status === "configured" };
        },
        run: () => reconfigureProvider(`gpu.${p.key}`),
      })),
    },
  ];
}

function renderStepLabel(step: SetupStep): string {
  const { configured, summary } = step.status();
  const mark = configured ? chalk.green("✓") : chalk.dim("·");
  const tail = configured
    ? chalk.dim(` — ${summary ?? "configured"}`)
    : chalk.dim(" — not configured");
  return `${mark}  ${step.label}${tail}`;
}

function renderGroupHeader(group: SetupGroup): string {
  const total = group.steps.length;
  const done = group.steps.filter((s) => s.status().configured).length;
  const count = total > 1 ? chalk.dim(` ${done}/${total}`) : "";
  return chalk.bold(`── ${group.title} ──${count}`);
}

export async function runOnboarding(): Promise<void> {
  console.log(chalk.bold("\n  hatchkit setup"));
  console.log(chalk.dim(`  Metadata: ${getConfigPath()}`));
  console.log(chalk.dim("  Secrets: OS keychain"));
  console.log(chalk.dim("  Pick any step to (re)configure. Choose 'Done' to exit.\n"));

  const groups = buildSetupGroups();
  const allSteps = groups.flatMap((g) => g.steps);

  for (;;) {
    // Default the cursor to the first unconfigured step so Enter advances
    // naturally on a first-time setup.
    const firstUnconfigured = allSteps.find((s) => !s.status().configured);
    const defaultKey = firstUnconfigured?.key ?? "__done__";

    const choices: Array<
      Separator | { name: string; value: string; description?: string }
    > = [];
    for (const group of groups) {
      choices.push(new Separator(renderGroupHeader(group)));
      for (const step of group.steps) {
        choices.push({ name: renderStepLabel(step), value: step.key });
      }
    }
    choices.push(new Separator(" "));
    choices.push({ name: chalk.bold("Done — exit setup"), value: "__done__" });

    const picked = await select<string>({
      message: "Next step:",
      default: defaultKey,
      pageSize: Math.min(30, choices.length),
      choices,
    });

    if (picked === "__done__") break;
    const step = allSteps.find((s) => s.key === picked);
    if (!step) continue;

    console.log();
    try {
      await step.run();
    } catch (err) {
      console.log(
        chalk.red(
          `\n  ✗ ${step.label} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    console.log();
  }

  // Summary
  const configured = allSteps.filter((s) => s.status().configured);
  console.log(chalk.bold("\n  ── Done ───────────────────────────────────────────────────\n"));
  if (configured.length === 0) {
    console.log(chalk.yellow("  Nothing configured yet. Run `hatchkit setup` again anytime.\n"));
  } else {
    console.log(chalk.green(`  ✓ Configured: ${configured.map((s) => s.label).join(", ")}`));
    console.log(chalk.dim("  ✓ Run `hatchkit doctor` to verify all providers.\n"));
  }
}
