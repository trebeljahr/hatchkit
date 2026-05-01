import { Separator, confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import Conf from "conf";
import ora from "ora";
import { verifyCoolify } from "./utils/coolify-api.js";
import { execOk } from "./utils/exec.js";
import {
  SECRET_KEYS,
  clearAllSecrets,
  deleteSecret,
  getSecret,
  setSecret,
} from "./utils/secrets.js";
import { validateRequired, validateUrl } from "./utils/validate.js";

/** Sanity-check an S3 access/secret pair against shape rules. Returns
 *  a human-readable problem description, or null when the pair is fine.
 *
 *  Caught real failures:
 *    · access === secret  → user pasted the same value into both
 *      prompts (very common with R2 because both fields are hex).
 *    · R2 access key length != 32 → user pasted the secret into the
 *      access slot (R2 access keys are exactly 32 hex chars).
 *    · R2 secret length != 64 → user truncated paste / pasted token id.
 *
 *  Hetzner/AWS skip the per-provider length check because their access
 *  key shapes vary across IAM versions and we'd rather accept than
 *  false-positive — only the equality check applies there. */
export function validateS3KeyPair(
  provider: string,
  accessKey: string,
  secretKey: string,
): string | null {
  if (accessKey === secretKey) {
    return "Access Key ID and Secret Access Key are the same value. They should be different.";
  }
  if (provider === "r2") {
    if (!/^[0-9a-f]{32}$/i.test(accessKey)) {
      return `R2 Access Key ID should be 32 hex chars (got ${accessKey.length}). Did you paste the Secret Access Key into the wrong field?`;
    }
    if (!/^[0-9a-f]{64}$/i.test(secretKey)) {
      return `R2 Secret Access Key should be 64 hex chars (got ${secretKey.length}).`;
    }
  }
  return null;
}

/** Pretty-print "where to create this token" hint before a password prompt.
 *  Optional `notes` lines render below the permissions line at the same
 *  indent — used by the Cloudflare branches to explain why the token has
 *  to be a User API Token (vs Account-owned) and that DNS + R2 deliberately
 *  use two separate tokens that both live at /profile/api-tokens. */
function tokenHint(url: string, scope: string, ...notes: string[]): void {
  console.log(chalk.dim(`  → Create at: ${chalk.cyan(url)}`));
  console.log(chalk.dim(`    Permissions: ${scope}`));
  for (const note of notes) {
    console.log(chalk.dim(`    ${note}`));
  }
}

/** Verify an R2 admin Bearer token has BOTH perms hatchkit needs:
 *
 *   1. `Account > Workers R2 Storage > Edit` — bucket admin (for
 *      `hatchkit provision s3` to create/list/configure buckets).
 *   2. `User > API Tokens > Edit` — child-token issuance (for minting
 *      per-project scoped S3 credentials at provision-time).
 *
 *  This is the same set of calls `hatchkit doctor` makes, kept in sync
 *  on purpose: the config-time and health-check verdicts must match so
 *  doctor never fails on a token we just accepted. Returns a structured
 *  verdict so the caller can render a precise error and decide whether
 *  to retry. */
export async function verifyR2AdminToken(
  token: string,
  accountId: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  try {
    const verifyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!verifyRes.ok) {
      return {
        ok: false,
        detail: `Token rejected by Cloudflare (HTTP ${verifyRes.status}). Likely invalid or revoked.`,
      };
    }
    const r2Res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r2Res.ok) {
      const body = (await r2Res.json().catch(() => null)) as {
        errors?: Array<{ code: number; message: string }>;
      } | null;
      const code = body?.errors?.[0]?.code;
      return {
        ok: false,
        detail: `Token lacks \`Account > Workers R2 Storage > Edit\` (HTTP ${r2Res.status}${code ? ` / CF code ${code}` : ""}).`,
      };
    }
    const body = (await r2Res.json()) as { result?: { buckets?: unknown[] } };
    const bucketCount = body.result?.buckets?.length ?? 0;

    const tokenRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens?per_page=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!tokenRes.ok) {
      return {
        ok: false,
        detail: `Token has R2 perm but lacks \`User > API Tokens > Edit\` (HTTP ${tokenRes.status}). Without it hatchkit can't mint per-project R2 credentials.`,
      };
    }
    return {
      ok: true,
      detail: `${bucketCount} bucket(s) visible; can mint per-project tokens`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Network error verifying token: ${(err as Error).message}`,
    };
  }
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
export async function confirmPastedSecret(label: string): Promise<string> {
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
  /** INWX username when provider === "inwx". */
  username?: string;
  /** Optional Cloudflare account id — scopes API calls to one account
   *  when the token spans multiple. Non-sensitive; lives in metadata. */
  accountId?: string;
  /** INWX username for the *registrar* case: provider is Cloudflare but
   *  the domain is still registered at INWX, so we need creds to flip the
   *  delegated NS after deploys. Non-sensitive. */
  registrarUsername?: string;
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
  /** Dashboard URL (where the user logs in / manages projects). */
  url: string;
  /** Management API URL — typically a separate subdomain in self-hosted
   *  setups (e.g. `https://api.op.example.com`). Falls back to
   *  `https://api.openpanel.dev` for cloud. Paths under this base are
   *  `/manage/projects`, `/manage/clients`, etc. */
  apiUrl?: string;
  /** Default organization slug, used as the "project group" when
   *  creating a new project/client via the dashboard. */
  organizationSlug?: string;
}

export interface ResendMeta extends ProviderStatus {
  /** Optional default region for new sending domains ("us-east-1", "eu-west-1"…). */
  defaultRegion?: string;
}

export interface StripeMeta extends ProviderStatus {
  /** "test" → sk_test_… / pk_test_…  vs  "live" → sk_live_… / pk_live_…
   *  Used as a sanity check before provisioning a webhook on the wrong
   *  account, and to label per-project webhook descriptions. */
  mode?: "test" | "live";
}

export interface GhcrMeta extends ProviderStatus {
  /** GitHub login the PAT belongs to. Surfaced in `hatchkit config`
   *  status and used as the username for Coolify's private-registry
   *  entry — GHCR's anonymous-looking `_json_key`-style placeholder
   *  isn't accepted by docker login. Captured at validation time
   *  (`gh api /user --jq .login` while we already have the token in
   *  hand) so adopt's Path B doesn't need a second round-trip. */
  username?: string;
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
  /** Paired with `registrarUsername` — from the keychain. Present only
   *  when provider === "cloudflare" AND the user told us INWX is their
   *  registrar during onboarding. */
  registrarPassword?: string;
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
export interface StripeConfig extends StripeMeta {
  /** Server-side API key — `sk_test_…` or `sk_live_…`. */
  secretKey: string;
  /** Public-safe key for the browser bundle — `pk_test_…` / `pk_live_…`. */
  publishableKey: string;
}
export interface GhcrConfig extends GhcrMeta {
  /** PAT with `read:packages` (and optionally `write:packages` for the
   *  Path-A visibility flip path). Stored in the OS keychain. */
  pullToken: string;
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
    stripe?: StripeMeta;
    ghcr?: GhcrMeta;
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
    const registrarPassword = await getSecret(SECRET_KEYS.dnsInwxRegistrarPassword);
    return {
      ...existing,
      password: password ?? undefined,
      apiToken: apiToken ?? undefined,
      registrarPassword: registrarPassword ?? undefined,
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
    "Note: User API Token. Lives at /profile/api-tokens alongside the R2 admin token",
    "      (hatchkit deliberately uses one token per concern — DNS vs R2 — both visible",
    "      together so you can audit and rotate them in one place).",
  );
  const apiToken = await confirmPastedSecret("Cloudflare API token");
  const accountId = await input({
    message: "Cloudflare account ID (optional — leave blank to span all accounts):",
    default: "",
  });

  // Cross-provider case: DNS on Cloudflare, but the domain is still
  // registered at INWX. Offer to store INWX registrar creds so deploys
  // (and the `dns link-to-cloudflare` command) can flip the delegated NS
  // to Cloudflare automatically without a UI click-through per domain.
  const wireInwxRegistrar = await confirm({
    message:
      "Is INWX your domain registrar? (if yes, hatchkit will auto-point NS at Cloudflare on deploy)",
    default: false,
  });
  let registrarUsername: string | undefined;
  let registrarPassword: string | undefined;
  if (wireInwxRegistrar) {
    registrarUsername = await input({
      message: "INWX username (registrar):",
      validate: validateRequired,
    });
    registrarPassword = await confirmPastedSecret("INWX password (registrar)");
  }

  const meta: DnsMeta = {
    status: "configured",
    provider: "cloudflare",
    accountId: accountId.trim() || undefined,
    registrarUsername,
  };
  store.set("providers.dns", meta);
  await setSecret(SECRET_KEYS.dnsCloudflareToken, apiToken);
  if (registrarPassword) {
    await setSecret(SECRET_KEYS.dnsInwxRegistrarPassword, registrarPassword);
  }
  console.log(chalk.green("  ✓ Cloudflare DNS configured"));
  if (registrarUsername) {
    console.log(chalk.green("  ✓ INWX registrar wired for auto-NS updates"));
  }
  return { ...meta, apiToken, registrarPassword };
}

/**
 * Prompt for INWX *registrar* credentials and persist them. Used when the
 * primary DNS provider is Cloudflare but the domain is still registered
 * at INWX, and we discovered late (during `runTerraform` preflight) that
 * the registrar NS-flip can't proceed without creds.
 *
 * Mirrors the inline branch in `ensureDns` ([config.ts] cloudflare path).
 * Updates the existing dns metadata in place (preserves provider, token,
 * accountId) and writes the password to the keychain.
 */
export async function promptAndSaveInwxRegistrarCreds(): Promise<{
  username: string;
  password: string;
}> {
  console.log(chalk.dim("\n  → Find these at: https://www.inwx.com → My Account"));
  const username = await input({
    message: "INWX username (registrar):",
    validate: validateRequired,
  });
  const pwd = await confirmPastedSecret("INWX password (registrar)");

  const meta = store.get("providers.dns") as DnsMeta | undefined;
  if (meta) {
    store.set("providers.dns", { ...meta, registrarUsername: username });
  }
  await setSecret(SECRET_KEYS.dnsInwxRegistrarPassword, pwd);
  console.log(chalk.green("  ✓ INWX registrar credentials saved"));
  return { username, password: pwd };
}

export async function getDnsConfig(): Promise<DnsConfig | null> {
  await migrateSecret("providers.dns.password", SECRET_KEYS.dnsInwxPassword);
  await migrateSecret("providers.dns.apiToken", SECRET_KEYS.dnsCloudflareToken);
  const meta = store.get("providers.dns") as DnsMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const password = await getSecret(SECRET_KEYS.dnsInwxPassword);
  const apiToken = await getSecret(SECRET_KEYS.dnsCloudflareToken);
  const registrarPassword = await getSecret(SECRET_KEYS.dnsInwxRegistrarPassword);
  return {
    ...meta,
    password: password ?? undefined,
    apiToken: apiToken ?? undefined,
    registrarPassword: registrarPassword ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider: S3
// ---------------------------------------------------------------------------

export async function ensureS3(provider: "hetzner" | "aws" | "r2"): Promise<S3ProviderConfig> {
  await migrateSecret(`providers.s3.${provider}.accessKey`, SECRET_KEYS.s3AccessKey(provider));
  await migrateSecret(`providers.s3.${provider}.secretKey`, SECRET_KEYS.s3SecretKey(provider));
  const existing = store.get(`providers.s3.${provider}`) as S3ProviderMeta | undefined;

  // R2 path: no access/secret prompts. The admin Bearer token is
  // the global "key to the kingdom" — it gates bucket admin AND the
  // minting of per-project scoped credentials at provision-time.
  // Once it's stored + verified here, every project-level flow
  // (`hatchkit create`, `adopt`, `provision s3`) consumes it without
  // re-prompting. The recovery path when doctor flags it as
  // invalid/revoked is `hatchkit config add s3 r2` — which clears the
  // token and re-runs this branch.
  if (provider === "r2") {
    const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
    if (existing?.status === "configured" && adminToken) {
      return {
        ...existing,
        accessKey: "",
        secretKey: "",
      };
    }

    // Pre-fill the account ID prompt from any existing endpoint so
    // the rotation-only flow (token wiped, meta kept) doesn't make
    // the user re-type the account ID. Extracted by regex rather than
    // imported from `provision/s3-buckets.ts` so config.ts stays a
    // leaf module.
    const previousAccountId = existing?.endpoint?.match(
      /^https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i,
    )?.[1];
    const reconfiguring = !!existing && !adminToken;
    if (reconfiguring) {
      console.log(chalk.yellow("\n  Rotating R2 admin token."));
    } else {
      console.log(chalk.yellow("\n  R2 is not configured yet. Let's set it up."));
      console.log(
        chalk.dim(
          "  Your Cloudflare account ID is in the dashboard URL:\n" +
            "    dash.cloudflare.com/<account-id>/home/overview",
        ),
      );
    }
    const accountId = (
      await input({
        message: "Cloudflare account ID:",
        default: previousAccountId,
        validate: validateRequired,
      })
    ).trim();
    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    const region = "auto";

    tokenHint(
      "https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token",
      "Account > Workers R2 Storage > Edit  +  User > API Tokens > Edit  (+ optional Zone > Zone > Read)",
      "  • R2 Storage:Edit  — create and manage the project buckets.",
      "  • API Tokens:Edit  — mint per-project bucket-scoped tokens at provision time.",
      "  • Zone:Read        — optional, only for attaching a custom domain (assets.example.com).",
      "Note: must be a User API Token. Account API Tokens can't carry API Tokens:Edit",
      "      (it's a User-scoped permission), so they can't mint per-project credentials.",
      "      DNS uses a separate User API Token; both live at /profile/api-tokens.",
    );

    // Loop on the token until it passes BOTH permission checks
    // (the same calls `hatchkit doctor` makes). Pasting a token with
    // only one of the two perms is the most common misconfiguration —
    // catch it here while the dashboard is still open instead of
    // letting it surface during a 5-minute deploy or, worse, a silent
    // half-provisioned project.
    let verifiedToken: string;
    for (;;) {
      const candidate = await confirmPastedSecret("R2 admin Bearer token");
      const spinner = ora("Verifying R2 admin token (both perms)...").start();
      const verdict = await verifyR2AdminToken(candidate, accountId);
      if (verdict.ok) {
        spinner.succeed(`R2 admin token verified — ${verdict.detail}`);
        verifiedToken = candidate;
        break;
      }
      spinner.fail(verdict.detail);
      console.log(chalk.dim(`  Fix at https://dash.cloudflare.com/profile/api-tokens.`));
      const retry = await confirm({ message: "Try a different token?", default: true });
      if (!retry) {
        throw new Error(`R2 admin token rejected: ${verdict.detail}`);
      }
    }
    await setSecret(SECRET_KEYS.r2AdminToken, verifiedToken);

    const meta: S3ProviderMeta = {
      status: "configured",
      endpoint,
      region,
      lastVerified: new Date().toISOString(),
    };
    store.set(`providers.s3.${provider}`, meta);
    console.log(
      chalk.green(
        "  ✓ R2 admin configured — `hatchkit create`/`adopt` will mint per-project bucket credentials automatically.",
      ),
    );
    return { ...meta, accessKey: "", secretKey: "" };
  }

  const accessKey = await getSecret(SECRET_KEYS.s3AccessKey(provider));
  const secretKey = await getSecret(SECRET_KEYS.s3SecretKey(provider));
  if (existing?.status === "configured" && accessKey && secretKey) {
    return { ...existing, accessKey, secretKey };
  }

  console.log(
    chalk.yellow(`\n  ${provider.toUpperCase()} S3 is not configured yet. Let's set it up.`),
  );

  let endpoint: string | undefined;
  let region: string | undefined;
  let location: string | undefined;

  const s3Hints = {
    hetzner: {
      url: "https://console.hetzner.cloud → your project → Security → S3 credentials",
      scope: "any (credentials are per-project)",
    },
    aws: {
      url: "https://console.aws.amazon.com/iam → Users → Security credentials → Create access key",
      scope: "s3:PutObject, s3:GetObject, s3:DeleteObject on the target bucket",
    },
  } as const;
  tokenHint(s3Hints[provider].url, s3Hints[provider].scope);

  // Loop on the access/secret pair until both pass validation. Real
  // bug we hit in the wild: the user fast-clicks through the dashboard
  // and pastes the same value into BOTH prompts. The runtime then
  // fails at S3-API time with a confusing 400 InvalidArgument. Catch
  // it here while the user still has the dashboard open.
  let promptedAccessKey: string;
  let promptedSecretKey: string;
  for (;;) {
    promptedAccessKey = await confirmPastedSecret(`${provider} S3 Access Key ID`);
    promptedSecretKey = await confirmPastedSecret(`${provider} S3 Secret Access Key`);
    const issue = validateS3KeyPair(provider, promptedAccessKey, promptedSecretKey);
    if (!issue) break;
    console.log(chalk.yellow(`  ${issue}`));
    console.log(chalk.dim("  Re-paste both values."));
  }

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

  // R2 path: account-wide access/secret pair is no longer the source
  // of truth (per-project pairs live under s3ProjectAccessKey instead).
  // Treat presence of the admin token as "configured", with empty
  // access/secret strings on the returned shape so callers that don't
  // care about per-project context still get a meta-only object.
  if (provider === "r2") {
    const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
    if (!adminToken) return null;
    return { ...meta, accessKey: "", secretKey: "" };
  }

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
      tokenHint("https://huggingface.co/settings/tokens", "Read (or Write if you'll push models)");
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

  // Short-circuit only if *every* field is present. `apiUrl` was added
  // after 0.1.x — configs written by earlier versions lack it, which is
  // why a previously-"configured" setup now hits the dashboard URL
  // instead of the API host. Fall through to the prompt flow so we can
  // top it up without losing the rest of the config.
  if (existing?.status === "configured" && existing.apiUrl && existingId && existingSecret) {
    return { ...existing, rootClientId: existingId, rootClientSecret: existingSecret };
  }

  if (existing?.status === "configured" && !existing.apiUrl) {
    console.log(
      chalk.yellow("\n  OpenPanel config is missing the Management API URL — let's fill that in."),
    );
  } else {
    console.log(chalk.yellow("\n  OpenPanel is not configured yet. Let's set it up."));
  }
  const url = (
    await input({
      message: "OpenPanel dashboard URL:",
      default: existing?.url ?? "https://analytics.trebeljahr.com",
      validate: (v) => validateUrl(v.trim()),
    })
  ).trim();
  // Self-hosted OpenPanel exposes the Management API on a separate
  // subdomain (e.g. `api.op.example.com`). Default by prepending `api.`
  // to the dashboard host, which matches the docs' recommended layout.
  const defaultApiUrl =
    existing?.apiUrl ?? url.replace(/^https?:\/\//, (m) => `${m}api.`).replace(/\/$/, "");
  const apiUrl = (
    await input({
      message: "OpenPanel API URL (Management API base — usually api.<dashboard>):",
      default: defaultApiUrl,
      validate: (v) => validateUrl(v.trim()),
    })
  )
    .trim()
    .replace(/\/$/, "");
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
        `  per-project clients via the Management API.\n\n` +
        `  Where to create it:\n` +
        `    1. Open ${chalk.cyan(`${url.replace(/\/$/, "")}/${organizationSlug}`)}\n` +
        `    2. Pick any project (or create a placeholder "hatchkit-root" project)\n` +
        `    3. Project → Settings → Clients → New client\n` +
        `    4. Type: ${chalk.cyan("root")} (Management API access — full org-wide)\n` +
        `    5. Copy the clientId and clientSecret (secret is shown once)\n`,
    ),
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
    apiUrl,
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
// Provider: Stripe (payments — used to auto-provision per-project webhooks)
// ---------------------------------------------------------------------------

export async function ensureStripe(): Promise<StripeConfig> {
  const existing = store.get("providers.stripe") as StripeMeta | undefined;
  const existingSecret = await getSecret(SECRET_KEYS.stripeSecretKey);
  const existingPublishable = await getSecret(SECRET_KEYS.stripePublishableKey);

  if (existing?.status === "configured" && existingSecret && existingPublishable) {
    return { ...existing, secretKey: existingSecret, publishableKey: existingPublishable };
  }

  console.log(chalk.yellow("\n  Stripe is not configured yet. Let's set it up."));
  console.log(
    chalk.dim(
      "  One-time setup — these keys go in your OS keychain and are reused for\n" +
        "  every future `hatchkit create`. Per-project, hatchkit only auto-provisions\n" +
        "  the webhook signing secret. You can re-run anytime via `hatchkit config add stripe`.\n",
    ),
  );
  tokenHint(
    "https://dashboard.stripe.com/apikeys",
    "Standard restricted key with `webhook_endpoints:write` (or use the Secret key)",
  );
  console.log(
    chalk.dim(
      "  Use the test-mode pair (sk_test_… / pk_test_…) for non-prod work,\n" +
        "  the live-mode pair for real charges. Hatchkit infers the mode from\n" +
        "  the `sk_` prefix.\n",
    ),
  );

  const secretKey = await confirmPastedSecret("Stripe secret key (sk_test_… or sk_live_…)");
  if (!/^sk_(test|live)_/.test(secretKey)) {
    throw new Error(
      "Stripe secret key must start with `sk_test_` or `sk_live_`. Re-run `hatchkit config add stripe`.",
    );
  }
  const mode: "test" | "live" = secretKey.startsWith("sk_live_") ? "live" : "test";

  const publishableKey = (
    await input({
      message: "Stripe publishable key (pk_test_… or pk_live_…):",
      validate: (v) => {
        const t = v.trim();
        if (!/^pk_(test|live)_/.test(t)) return "Must start with pk_test_ or pk_live_.";
        if (t.startsWith("pk_live_") !== (mode === "live"))
          return "Publishable key mode doesn't match the secret key mode.";
        return true;
      },
    })
  ).trim();

  // Sanity check: hit /v1/balance — cheapest authenticated GET that
  // proves the secret key is valid before storing it.
  const verify = ora("Verifying Stripe secret key...").start();
  try {
    const res = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    verify.succeed(`Stripe secret key verified (${mode} mode)`);
  } catch (err) {
    verify.fail("Could not verify Stripe secret key");
    throw err;
  }

  const meta: StripeMeta = {
    status: "configured",
    mode,
    lastVerified: new Date().toISOString(),
  };
  store.set("providers.stripe", meta);
  await setSecret(SECRET_KEYS.stripeSecretKey, secretKey);
  await setSecret(SECRET_KEYS.stripePublishableKey, publishableKey);
  console.log(chalk.green(`  ✓ Stripe configured (${mode} mode)`));
  return { ...meta, secretKey, publishableKey };
}

export async function getStripeConfig(): Promise<StripeConfig | null> {
  const meta = store.get("providers.stripe") as StripeMeta | undefined;
  if (!meta || meta.status !== "configured") return null;
  const secretKey = await getSecret(SECRET_KEYS.stripeSecretKey);
  const publishableKey = await getSecret(SECRET_KEYS.stripePublishableKey);
  if (!secretKey || !publishableKey) return null;
  return { ...meta, secretKey, publishableKey };
}

// ---------------------------------------------------------------------------
// Provider: GHCR (GitHub Container Registry pull credentials)
// ---------------------------------------------------------------------------
//
// Used by `hatchkit adopt` Path B: when the user adopts a private repo,
// GHCR's auto-created package inherits the privacy and Coolify can't pull
// it without auth. Hatchkit registers this PAT with Coolify's private-
// registries store so every adopted private app on this Coolify install
// pulls authenticated. One PAT per machine — there's no per-project
// state in here.
//
// Token requirements:
//   · Minimum scope: `read:packages`. Hatchkit only ever uses it to pull.
//   · The matching `username` is the token owner's GitHub login (we look
//     it up via `gh api /user --jq .login` while we have the token in
//     hand). Coolify stores it alongside the password — it's what its
//     `docker login ghcr.io` ultimately sends.
//
// Token validation:
//   · `GET /user` succeeds → token works, login captured.
//   · 401/403 → wrong scope or revoked PAT; surface a precise error
//     instead of letting it fail downstream during a 5-minute deploy.

export async function ensureGhcr(): Promise<GhcrConfig> {
  const existing = store.get("providers.ghcr") as GhcrMeta | undefined;
  const existingToken = await getSecret(SECRET_KEYS.ghcrPullToken);

  if (existing?.status === "configured" && existingToken && existing.username) {
    return { ...existing, pullToken: existingToken };
  }

  console.log(chalk.yellow("\n  GHCR is not configured yet. Let's set it up."));
  console.log(
    chalk.dim(
      "  Used by `hatchkit adopt` for private repos — Coolify needs a PAT to pull\n" +
        "  the published GHCR image. One PAT per machine covers every adopted private\n" +
        "  app on this Coolify install.\n",
    ),
  );
  tokenHint(
    "https://github.com/settings/tokens?type=beta",
    "Fine-grained PAT, scope `read:packages` (no other access required)",
  );
  const pullToken = await confirmPastedSecret("GHCR pull token");

  const spinner = ora("Verifying GHCR token (gh API /user)...").start();
  let username: string;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${pullToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "hatchkit",
      },
    });
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} — token rejected by GitHub. Check it has \`read:packages\` and isn't expired.`,
      );
    }
    const body = (await res.json()) as { login?: string };
    if (!body.login) {
      throw new Error("GitHub returned no `login` for this token — is it a user PAT?");
    }
    username = body.login;
    spinner.succeed(`GHCR token verified (user: ${username})`);
  } catch (error) {
    spinner.fail("Could not verify GHCR token");
    throw error;
  }

  const meta: GhcrMeta = {
    status: "configured",
    lastVerified: new Date().toISOString(),
    username,
  };
  store.set("providers.ghcr", meta);
  await setSecret(SECRET_KEYS.ghcrPullToken, pullToken);
  console.log(chalk.green(`  ✓ GHCR configured (${username})`));
  return { ...meta, pullToken };
}

export async function getGhcrConfig(): Promise<GhcrConfig | null> {
  const meta = store.get("providers.ghcr") as GhcrMeta | undefined;
  if (!meta || meta.status !== "configured" || !meta.username) return null;
  const pullToken = await getSecret(SECRET_KEYS.ghcrPullToken);
  if (!pullToken) return null;
  return { ...meta, pullToken };
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
  | "stripe"
  | "ghcr"
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
  } else if (name === "stripe") {
    await wipeProvider("providers.stripe", [
      SECRET_KEYS.stripeSecretKey,
      SECRET_KEYS.stripePublishableKey,
    ]);
    await ensureStripe();
  } else if (name === "ghcr") {
    await wipeProvider("providers.ghcr", [SECRET_KEYS.ghcrPullToken]);
    await ensureGhcr();
  } else if (name.startsWith("s3.")) {
    const p = name.slice(3) as "hetzner" | "aws" | "r2";
    if (p === "r2") {
      // R2 reconfigure = "rotate the admin Bearer token". Keep the
      // meta (so the account ID survives — user re-pastes only the
      // token) and clear the admin token + any legacy keys. Per-
      // project minted access/secret pairs are NOT touched here —
      // they're scoped to bucket-level resources and stay valid even
      // after the admin token rotates.
      await deleteSecret(SECRET_KEYS.r2AdminToken);
      await deleteSecret(SECRET_KEYS.s3AccessKey(p));
      await deleteSecret(SECRET_KEYS.s3SecretKey(p));
    } else {
      await wipeProvider(`providers.s3.${p}`, [
        SECRET_KEYS.s3AccessKey(p),
        SECRET_KEYS.s3SecretKey(p),
      ]);
    }
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
        {
          key: "ghcr",
          label: "GHCR (private-package pulls)",
          status: () => {
            const m = store.get("providers.ghcr") as GhcrMeta | undefined;
            return { configured: m?.status === "configured", summary: m?.username };
          },
          run: () => reconfigureProvider("ghcr"),
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
        label:
          p === "hetzner" ? "Hetzner Object Storage" : p === "aws" ? "AWS S3" : "Cloudflare R2",
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
        {
          key: "stripe",
          label: "Stripe (payments)",
          status: () => {
            const m = store.get("providers.stripe") as StripeMeta | undefined;
            return { configured: m?.status === "configured", summary: m?.mode };
          },
          run: () => reconfigureProvider("stripe"),
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

    const choices: Array<Separator | { name: string; value: string; description?: string }> = [];
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

  // Summary — show both what's configured and what's still missing so
  // the user notices optional-but-important steps (GlitchTip / OpenPanel
  // / Resend) they may have skipped.
  const configured = allSteps.filter((s) => s.status().configured);
  const unconfigured = allSteps.filter((s) => !s.status().configured);
  console.log(chalk.bold("\n  ── Done ───────────────────────────────────────────────────\n"));
  if (configured.length === 0) {
    console.log(chalk.yellow("  Nothing configured yet. Run `hatchkit setup` again anytime.\n"));
  } else {
    console.log(chalk.green(`  ✓ Configured: ${configured.map((s) => s.label).join(", ")}`));
  }
  if (unconfigured.length > 0) {
    console.log(
      chalk.dim(`  · Still unconfigured: ${unconfigured.map((s) => s.label).join(", ")}`),
    );
    console.log(
      chalk.dim(
        "    (optional — add later via `hatchkit setup` or `hatchkit config add <provider>`)",
      ),
    );
  }
  console.log(chalk.dim("\n  ✓ Run `hatchkit doctor` to verify every configured provider.\n"));
}
