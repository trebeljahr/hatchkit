/*
 * `hatchkit doctor` — health check for every configured provider.
 *
 * Runs the cheapest idempotent verification call that proves the stored
 * credential still works (GET-only, no writes). Reports a summary.
 */

import chalk from "chalk";
import {
  getCoolifyConfig,
  getDnsConfig,
  getGlitchtipConfig,
  getHetznerConfig,
  getOpenpanelConfig,
  getResendConfig,
  getS3Config,
  getStore,
  validateS3KeyPair,
} from "./config.js";
import { verifyCoolify } from "./utils/coolify-api.js";
import { execOk } from "./utils/exec.js";
import { SECRET_KEYS, getSecret } from "./utils/secrets.js";

interface CheckResult {
  name: string;
  status: "ok" | "fail" | "skip";
  detail?: string;
  /** Multi-line troubleshooting hint, shown under a failing check. */
  hint?: string[];
}

type HintFn = (detail: string) => string[] | undefined;

async function check(
  name: string,
  fn: () => Promise<string | undefined>,
  hintFn?: HintFn,
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, status: "ok", detail: detail || undefined };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { name, status: "fail", detail, hint: hintFn?.(detail) };
  }
}

/** Pull the HTTP status code out of a "HTTP 401 ..." style error message. */
function httpCode(detail: string): number | undefined {
  const m = detail.match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : undefined;
}

async function checkGitHub(): Promise<CheckResult> {
  if (!(await execOk("gh", ["--version"]))) {
    return {
      name: "GitHub (gh CLI)",
      status: "fail",
      detail: "gh CLI not installed",
      hint: [
        "Install: `brew install gh` (macOS) or see https://cli.github.com",
        "Then authenticate: `gh auth login`",
      ],
    };
  }
  if (!(await execOk("gh", ["auth", "status"]))) {
    return {
      name: "GitHub (gh CLI)",
      status: "fail",
      detail: "not authenticated",
      hint: ["Run `gh auth login` and pick GitHub.com → HTTPS → browser."],
    };
  }
  return { name: "GitHub (gh CLI)", status: "ok" };
}

async function checkCoolify(): Promise<CheckResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return { name: "Coolify", status: "skip" };
  return check(
    "Coolify",
    async () => {
      const v = await verifyCoolify(cfg.url, cfg.token);
      return `v${v}`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401 || code === 403) {
        return [
          "API token invalid or expired.",
          `Create a new one: ${cfg.url.replace(/\/$/, "")}/security/api-tokens`,
          "Then re-run: `hatchkit config add coolify`",
        ];
      }
      if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(detail)) {
        return [
          `Can't reach Coolify at ${cfg.url}.`,
          "Check the URL is reachable from this machine, or re-run `hatchkit config add coolify`.",
        ];
      }
      return undefined;
    },
  );
}

async function checkHetzner(): Promise<CheckResult> {
  const cfg = await getHetznerConfig();
  if (!cfg) return { name: "Hetzner Cloud", status: "skip" };
  return check(
    "Hetzner Cloud",
    async () => {
      const res = await fetch("https://api.hetzner.cloud/v1/servers?per_page=1", {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { meta?: { pagination?: { total_entries?: number } } };
      return `${body.meta?.pagination?.total_entries ?? "?"} server(s)`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "Hetzner API token is invalid or was revoked.",
          "Create a new one: https://console.hetzner.cloud/ → project → Security → API tokens (Read & Write)",
          "Then re-run: `hatchkit config add hetzner`",
        ];
      }
      if (code === 403) {
        return [
          "Token lacks permissions — needs Read & Write on the project.",
          "Re-create it and re-run `hatchkit config add hetzner`.",
        ];
      }
      return undefined;
    },
  );
}

async function checkDns(): Promise<CheckResult> {
  const cfg = await getDnsConfig();
  if (!cfg) return { name: "DNS", status: "skip" };
  return check(
    "DNS (Cloudflare)",
    async () => {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { status?: string } };
      return body.result?.status ?? "active";
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "Cloudflare API token is invalid, expired, or revoked.",
          "Create a new one: https://dash.cloudflare.com/profile/api-tokens",
          "Required permissions: Zone:DNS:Edit + Zone:Zone:Read (scope to the zones you'll use).",
          "Then re-run: `hatchkit config add dns`",
        ];
      }
      if (code === 403) {
        return [
          "Token authenticates but lacks Zone:DNS:Edit + Zone:Zone:Read on the target zones.",
          "Edit the token at https://dash.cloudflare.com/profile/api-tokens or create a new one, then `hatchkit config add dns`.",
        ];
      }
      return undefined;
    },
  );
}

async function checkS3(provider: "hetzner" | "aws" | "r2"): Promise<CheckResult> {
  const name = `S3 (${provider})`;
  const cfg = await getS3Config(provider);
  if (!cfg) return { name, status: "skip" };

  // Account-wide access/secret pair only applies to non-R2 providers
  // (Hetzner, AWS). Validate shape there to catch the paste-collision
  // bug (access === secret) where users dual-paste the same value.
  // R2's account-wide pair is no longer the source of truth — per-
  // project pairs live under `s3:r2:<project>:access-key` instead.
  if (provider !== "r2") {
    const issue = validateS3KeyPair(provider, cfg.accessKey, cfg.secretKey);
    if (issue) {
      return {
        name,
        status: "fail",
        detail: issue,
        hint: [
          "Re-paste the Access Key ID + Secret Access Key from the dashboard.",
          "Run: `hatchkit config add s3` for a full re-config.",
        ],
      };
    }
    return { name, status: "ok", detail: "credentials stored (endpoint set)" };
  }

  // R2: verify the admin Bearer token can do BOTH jobs it's responsible
  // for — bucket admin (Account > Workers R2 Storage > Edit) AND
  // minting per-project account tokens (Account > Account Settings >
  // Edit). The legacy `User > API Tokens > Edit` perm is no longer
  // sufficient on its own (provision switched to account-owned tokens
  // via POST /accounts/{id}/tokens), but is still useful during
  // migration of pre-account-tokens projects, so we probe it as a
  // non-fatal hint. Either of the required perms failing tells the
  // user exactly which one to add. Per-project access/secret pairs are
  // checked separately by `checkProjectR2CredsState`, which runs from
  // `collectDoctorResults` when invoked inside a hatchkit project.
  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    return {
      name,
      status: "ok",
      detail: "configured; admin token not set (bucket provisioning will prompt)",
      hint: [
        "Optional unless you want bucket auto-create / public-URL setup.",
        "When ready: `hatchkit config add s3 r2` to store + verify the admin token globally.",
      ],
    };
  }
  const accountId = cfg.endpoint?.match(
    /https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i,
  )?.[1];
  if (!accountId) {
    return {
      name,
      status: "fail",
      detail: `endpoint ${cfg.endpoint} doesn't look like an R2 endpoint`,
    };
  }
  return check(
    name,
    async () => {
      const verifyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!verifyRes.ok) throw new Error(`HTTP ${verifyRes.status} (token verify)`);

      const r2Res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      if (!r2Res.ok) {
        const body = (await r2Res.json().catch(() => null)) as {
          errors?: Array<{ code: number; message: string }>;
        } | null;
        const code = body?.errors?.[0]?.code;
        throw new Error(`HTTP ${r2Res.status}${code ? ` (CF code ${code})` : ""} (r2 list)`);
      }
      const body = (await r2Res.json()) as { result?: { buckets?: unknown[] } };
      const n = body.result?.buckets?.length ?? 0;

      // Account-tokens permission probe. Hatchkit provisions per-project
      // R2 credentials via `POST /accounts/{id}/tokens` (visible in
      // `R2 → Manage R2 API Tokens`); that endpoint needs
      // `Account Settings:Edit` on the calling token. Hitting the
      // permission-groups list is the cheapest probe and matches what
      // `createR2AccountToken` does first — a 9109/403 here means
      // provision would fail at the same call.
      const accountTokenRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/permission_groups?per_page=1`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      if (!accountTokenRes.ok) {
        const aBody = (await accountTokenRes.json().catch(() => null)) as {
          errors?: Array<{ code: number; message: string }>;
        } | null;
        const aCode = aBody?.errors?.[0]?.code;
        throw new Error(
          `HTTP ${accountTokenRes.status}${aCode ? ` (CF code ${aCode})` : ""} (account-tokens list — needs Account Settings:Edit)`,
        );
      }

      // Legacy probe: best-effort, not fatal. Used during migration to
      // revoke pre-account-tokens user-tokens. If it fails, surface as
      // a hint in the OK detail so users know one perm is missing
      // without flagging the whole check as a fail.
      const legacyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens?per_page=1", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const legacyNote = legacyRes.ok
        ? "; legacy User>API Tokens also OK"
        : "; legacy User>API Tokens missing (migration of pre-account-tokens projects may leave orphans)";

      return `R2 perm OK (${n} bucket(s)); Account Settings:Edit OK (can mint per-project tokens)${legacyNote}`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "R2 admin Bearer token is invalid or revoked.",
          "Create a new one: https://dash.cloudflare.com/profile/api-tokens → Custom token",
          "Permissions:    Account > Workers R2 Storage > Edit",
          "                Account > Account Settings   > Edit",
          "Then re-run: `hatchkit config add s3 r2` to re-paste + verify globally.",
        ];
      }
      if (/account-tokens list/i.test(detail)) {
        return [
          "Admin token has R2 perm but lacks `Account > Account Settings > Edit`.",
          "Without it, hatchkit can't mint per-project R2 credentials via account tokens",
          "(POST /accounts/{id}/tokens). Provision will revoke any legacy token first and",
          "then fail to mint its replacement, leaving the project without working creds.",
          "Edit at https://dash.cloudflare.com/profile/api-tokens, add the perm, save —",
          "or re-run `hatchkit config add s3 r2` to paste a fresh token.",
        ];
      }
      if (code === 403 || /10000|10001|9109/.test(detail)) {
        return [
          "Token verifies but lacks `Account > Workers R2 Storage > Edit`.",
          "Edit at https://dash.cloudflare.com/profile/api-tokens, add the perm, save —",
          "or re-run `hatchkit config add s3 r2` to paste a fresh token.",
        ];
      }
      return undefined;
    },
  );
}

async function checkGpu(platform: string): Promise<CheckResult> {
  const store = getStore();
  const meta = store.get(`providers.gpu.${platform}`) as { status?: string } | undefined;
  const name = `GPU (${platform})`;
  if (meta?.status !== "configured") return { name, status: "skip" };
  if (platform === "modal") {
    return check(name, async () => {
      if (!(await execOk("modal", ["token", "current"])))
        throw new Error("`modal token current` failed");
      return "authenticated";
    });
  }
  const key = await getSecret(SECRET_KEYS.gpuApiKey(platform));
  if (!key) {
    return {
      name,
      status: "fail",
      detail: "API key missing from keychain",
      hint: [`Re-run: \`hatchkit config add gpu\` and pick ${platform}.`],
    };
  }
  const gpuHint =
    (label: string, createUrl: string): HintFn =>
    (detail) => {
      const code = httpCode(detail);
      if (code === 401 || code === 403) {
        return [
          `${label} API key is invalid or expired.`,
          `Create a new one: ${createUrl}`,
          "Then re-run: `hatchkit config add gpu`",
        ];
      }
      return undefined;
    };
  if (platform === "hf") {
    return check(
      name,
      async () => {
        const res = await fetch("https://huggingface.co/api/whoami-v2", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { name?: string };
        return body.name ?? "authenticated";
      },
      gpuHint("Hugging Face", "https://huggingface.co/settings/tokens"),
    );
  }
  if (platform === "replicate") {
    return check(
      name,
      async () => {
        const res = await fetch("https://api.replicate.com/v1/account", {
          headers: { Authorization: `Token ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return "authenticated";
      },
      gpuHint("Replicate", "https://replicate.com/account/api-tokens"),
    );
  }
  if (platform === "runpod") {
    return check(
      name,
      async () => {
        const res = await fetch("https://rest.runpod.io/v1/user", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return "authenticated";
      },
      gpuHint("RunPod", "https://www.runpod.io/console/user/settings"),
    );
  }
  return { name, status: "ok", detail: "credentials stored" };
}

async function checkGlitchtip(): Promise<CheckResult> {
  const cfg = await getGlitchtipConfig();
  if (!cfg) return { name: "GlitchTip", status: "skip" };
  return check(
    "GlitchTip",
    async () => {
      const res = await fetch(`${cfg.url}/api/0/organizations/${cfg.organizationSlug}/`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `org: ${cfg.organizationSlug}`;
    },
    (detail) => {
      const code = httpCode(detail);
      const base = cfg.url.replace(/\/$/, "");
      if (code === 401) {
        return [
          "Auth token is invalid or expired.",
          `Create a new one: ${base}/profile/auth-tokens`,
          "Then re-run: `hatchkit config add glitchtip`",
        ];
      }
      if (code === 404) {
        return [
          `Organization "${cfg.organizationSlug}" not found — slug may be wrong.`,
          `Check at ${base}/ and re-run: \`hatchkit config add glitchtip\``,
        ];
      }
      return undefined;
    },
  );
}

async function checkOpenpanel(): Promise<CheckResult> {
  const cfg = await getOpenpanelConfig();
  if (!cfg) return { name: "OpenPanel", status: "skip" };
  const manageBase = `${(cfg.apiUrl ?? cfg.url).replace(/\/$/, "")}/manage`;
  return check(
    "OpenPanel",
    async () => {
      const res = await fetch(`${manageBase}/projects`, {
        headers: {
          "openpanel-client-id": cfg.rootClientId,
          "openpanel-client-secret": cfg.rootClientSecret,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `root client OK`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401 || code === 403) {
        return [
          "Root client credentials rejected — may have been rotated or lack `write` access.",
          "Re-run: `hatchkit config add openpanel` and paste the root client id/secret.",
        ];
      }
      if (/Only HTML requests|<html/i.test(detail) || code === 404) {
        return [
          `Management API base URL looks wrong — response isn't JSON.`,
          `Current: ${manageBase}`,
          "Self-hosted OpenPanel puts the API on a separate subdomain (typically `api.<dashboard>`).",
          "Re-run: `hatchkit config add openpanel` and set the API URL explicitly.",
        ];
      }
      return undefined;
    },
  );
}

async function checkResend(): Promise<CheckResult> {
  const cfg = await getResendConfig();
  if (!cfg) return { name: "Resend", status: "skip" };
  return check(
    "Resend",
    async () => {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "API key valid";
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "Resend API key is invalid or was deleted.",
          "Create a new one (full access): https://resend.com/api-keys",
          "Then re-run: `hatchkit config add resend`",
        ];
      }
      if (code === 403) {
        return [
          "API key lacks permissions — needs `Full access` to list/create domains and keys.",
          "Re-create at https://resend.com/api-keys and re-run `hatchkit config add resend`.",
        ];
      }
      return undefined;
    },
  );
}

async function checkStripeMode(mode: "test" | "live", secretKey: string): Promise<CheckResult> {
  return check(
    `Stripe (${mode} master)`,
    async () => {
      const res = await fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The webhook_endpoints:write scope can't be cheaply tested with
      // a GET, so /balance is the proxy: it proves the key is live and
      // the account is reachable. A scope-mismatched key still passes
      // /balance — at provision time, POST /v1/webhook_endpoints will
      // surface the scope error inline (and `hatchkit create` already
      // soft-fails to a manual fallback when that happens).
      return "master key valid";
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          `Stripe ${mode} master key is invalid or was rotated.`,
          `Create a new restricted key (${mode} mode) at https://dashboard.stripe.com/apikeys`,
          "Required scope: Webhook Endpoints — Write",
          "Then re-run: `hatchkit config add stripe`",
        ];
      }
      return undefined;
    },
  );
}

async function checkStripe(): Promise<CheckResult[]> {
  const { getStripeConfig } = await import("./config.js");
  const cfg = await getStripeConfig();
  if (!cfg) return [{ name: "Stripe", status: "skip" }];
  const out: CheckResult[] = [];
  if (cfg.testSecretKey) out.push(await checkStripeMode("test", cfg.testSecretKey));
  if (cfg.liveSecretKey) out.push(await checkStripeMode("live", cfg.liveSecretKey));
  if (out.length === 0) return [{ name: "Stripe", status: "skip" }];
  return out;
}

export async function collectDoctorResults(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(await checkGitHub());
  results.push(await checkCoolify());
  results.push(await checkHetzner());
  results.push(await checkDns());
  for (const p of ["hetzner", "aws", "r2"] as const) results.push(await checkS3(p));
  for (const p of ["modal", "runpod", "hf", "replicate"]) results.push(await checkGpu(p));
  results.push(await checkGlitchtip());
  results.push(await checkOpenpanel());
  results.push(await checkResend());
  for (const r of await checkStripe()) results.push(r);
  // Project-local checks — only run when doctor was invoked inside a
  // hatchkit-managed project (manifest at cwd). Globally they're a
  // no-op, so `hatchkit doctor` from $HOME stays clean.
  const projectChecks = await checkProjectKeyState(process.cwd());
  for (const r of projectChecks) results.push(r);
  const corsChecks = await checkProjectS3CorsState(process.cwd());
  for (const r of corsChecks) results.push(r);
  const credChecks = await checkProjectR2CredsState(process.cwd());
  for (const r of credChecks) results.push(r);
  return results;
}

/** Project-local key hygiene checks, gated on the presence of
 *  `.hatchkit.json` in the cwd:
 *
 *    1. `.env.keys` is NOT tracked by git. (If it is, the dotenvx
 *       private key has either already leaked or is one push away.)
 *    2. The keychain copy of DOTENV_PRIVATE_KEY_PRODUCTION matches
 *       the value in `.env.keys`. After `dotenvx rotate` the file
 *       updates but the keychain doesn't — `keys set` fixes that;
 *       this check surfaces the drift before a deploy goes wrong.
 *
 *  Exported so tests can invoke it directly with a fixture dir
 *  instead of munging `process.cwd()`. */
export async function checkProjectKeyState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const manifestPath = `${projectDir}/.hatchkit.json`;
  const { existsSync, readFileSync } = await import("node:fs");
  if (!existsSync(manifestPath)) return out;

  let projectName: string;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: string };
    if (!m.name) return out;
    projectName = m.name;
  } catch {
    return out;
  }

  const { locateEnvKeysFile, parsePrivateKeyValue } = await import("./deploy/keys.js");
  const envKeysPath = locateEnvKeysFile(projectDir);
  if (!envKeysPath) {
    // No `.env.keys` on disk → nothing to verify against. Common in
    // CI checkouts where dotenvx setup hasn't run; not a problem.
    return out;
  }

  // Check 1: tracked-by-git status. Pass the path relative to
  // projectDir so `git ls-files --error-unmatch` resolves it inside
  // the repo regardless of where the user invoked `hatchkit doctor`
  // from. `--error-unmatch` exits 1 when the path is untracked, 0
  // when tracked — so execOk's true/false maps directly to "tracked".
  const { relative } = await import("node:path");
  const relEnvKeys = relative(projectDir, envKeysPath);
  const tracked = await execOk("git", ["ls-files", "--error-unmatch", relEnvKeys], {
    cwd: projectDir,
  });
  if (tracked) {
    out.push({
      name: `Project ${projectName} (.env.keys leak)`,
      status: "fail",
      detail: ".env.keys is tracked by git",
      hint: [
        "The dotenvx private key may already be in your git history.",
        "Treat as a credential leak: rotate immediately.",
        `  git rm --cached ${envKeysPath}`,
        `  echo .env.keys >> .gitignore`,
        `  hatchkit keys rotate ${projectName} --push-coolify`,
        "Then check the remote (e.g. GitHub) for any commits that include .env.keys and force-purge if necessary.",
      ],
    });
  } else {
    out.push({
      name: `Project ${projectName} (.env.keys hygiene)`,
      status: "ok",
      detail: ".env.keys present on disk and not tracked by git",
    });
  }

  // Check 2: keychain matches `.env.keys`.
  const fileKey = parsePrivateKeyValue(readFileSync(envKeysPath, "utf-8"));
  if (!fileKey) {
    // .env.keys exists but has no DOTENV_PRIVATE_KEY_PRODUCTION line —
    // unusual but not necessarily wrong (e.g., only dev keys present).
    return out;
  }
  const keychainKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName));
  if (!keychainKey) {
    out.push({
      name: `Project ${projectName} (keychain drift)`,
      status: "fail",
      detail: "DOTENV_PRIVATE_KEY_PRODUCTION is missing from the OS keychain",
      hint: [
        "The keychain copy was wiped (e.g. by `config reset`) but `.env.keys` still has the value.",
        `Restore it from disk: hatchkit keys set ${projectName}`,
      ],
    });
  } else if (keychainKey !== fileKey) {
    out.push({
      name: `Project ${projectName} (keychain drift)`,
      status: "fail",
      detail: "OS keychain holds a different DOTENV_PRIVATE_KEY_PRODUCTION than .env.keys",
      hint: [
        "Likely cause: `dotenvx rotate` ran but the keychain wasn't updated.",
        `Sync from .env.keys: hatchkit keys set ${projectName}`,
        `(Or, if you want the OLD key: hatchkit keys show ${projectName} > .env.keys.bak)`,
      ],
    });
  } else {
    out.push({
      name: `Project ${projectName} (keychain sync)`,
      status: "ok",
      detail: "OS keychain matches .env.keys",
    });
  }

  return out;
}

/** Compare the manifest's recorded CORS rule for the assets bucket
 *  against the live policy on Cloudflare. Drifts are common when a
 *  user hand-edits the bucket CORS in the dashboard or when the project
 *  domain changed without re-running provision. The fix hint always
 *  points at `hatchkit provision s3` because that's the single
 *  reconcile path; we don't try to diff at field granularity.
 *
 *  Skipped silently when:
 *    · no manifest at cwd (running outside a hatchkit project)
 *    · manifest has no `s3Buckets.assets` (project never provisioned R2)
 *    · `cors.skipped === true` (user opted out via --no-cors;
 *      they're managing CORS out-of-band)
 *    · admin token / accountId not available (config gap is its own
 *      check above; no need to double-fail) */
export async function checkProjectS3CorsState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    domain?: string;
    s3Buckets?: {
      accountId?: string;
      assets?: {
        name?: string;
        cors?: {
          origins?: string[];
          methods?: string[];
          maxAgeSeconds?: number;
          extraOrigins?: string[];
          skipped?: boolean;
        };
      };
    };
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.s3Buckets?.assets?.name) return out;
  if (manifest.s3Buckets.assets.cors?.skipped === true) return out;

  const accountId = manifest.s3Buckets.accountId;
  if (!accountId) {
    // Pre-CORS-era manifest. Doctor's checkS3("r2") already nags about
    // global config; here we just point at provision to record state.
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "skip",
      detail: "manifest has no recorded accountId; provision s3 hasn't run since CORS landed",
    });
    return out;
  }

  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "skip",
      detail: "R2 admin token not in keychain — can't read bucket CORS",
    });
    return out;
  }

  const { CloudflareApi } = await import("./utils/cloudflare-api.js");
  const cf = new CloudflareApi({ token: adminToken });

  let live: Awaited<ReturnType<typeof cf.getR2BucketCors>>;
  try {
    live = await cf.getR2BucketCors(accountId, manifest.s3Buckets.assets.name);
  } catch (err) {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "fail",
      detail: `couldn't read bucket CORS: ${(err as Error).message.split("\n")[0]}`,
      hint: [
        "The R2 admin token may be missing `Workers R2 Storage: Edit`.",
        "Edit at https://dash.cloudflare.com/profile/api-tokens, then re-run.",
      ],
    });
    return out;
  }

  const recordedOrigins = manifest.s3Buckets.assets.cors?.origins ?? [];
  const liveOrigins = live?.[0]?.allowed?.origins ?? [];
  const liveSorted = [...liveOrigins].sort();
  const recordedSorted = [...recordedOrigins].sort();

  if (recordedSorted.length === 0) {
    // Manifest pre-dates the cors field. Only flag if there's actually
    // a live policy mismatch worth surfacing — otherwise stay quiet
    // until the user runs provision.
    if (liveSorted.length === 0) {
      out.push({
        name: `Project ${manifest.name} (R2 CORS)`,
        status: "fail",
        detail:
          "no CORS policy on the assets bucket — browser fetch() / crossOrigin will be blocked",
        hint: [
          "Apply hatchkit's default policy:",
          `  hatchkit provision s3       (reconciles CORS using ${manifest.domain ?? "<project domain>"} + localhost)`,
        ],
      });
    } else {
      out.push({
        name: `Project ${manifest.name} (R2 CORS)`,
        status: "skip",
        detail: `live policy has ${liveSorted.length} origin(s) but manifest has no cors record yet`,
      });
    }
    return out;
  }

  const same =
    liveSorted.length === recordedSorted.length &&
    liveSorted.every((o, i) => o === recordedSorted[i]);
  if (same) {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "ok",
      detail: `bucket CORS matches manifest (${recordedSorted.length} origin(s))`,
    });
  } else {
    out.push({
      name: `Project ${manifest.name} (R2 CORS)`,
      status: "fail",
      detail: `bucket CORS drift — live ${liveSorted.length} origin(s), manifest ${recordedSorted.length}`,
      hint: [
        `manifest: ${recordedSorted.join(", ") || "(empty)"}`,
        `live:     ${liveSorted.join(", ") || "(empty)"}`,
        "Reconcile by re-running:",
        "  hatchkit provision s3",
      ],
    });
  }
  return out;
}

/** Verify the per-project R2 access/secret pair (minted by `provision s3`)
 *  still has the perms it claims. We do a HeadBucket against each bucket
 *  recorded in the manifest — cheapest GET on the S3 protocol, returns
 *  200 when the token is valid AND scoped to that bucket, 403/404/etc
 *  otherwise. The admin token check above doesn't catch this: a user can
 *  revoke a per-project token from the dashboard without touching the
 *  global admin token, leaving CORS / deploys broken at runtime.
 *
 *  Skipped silently when:
 *    · no manifest at cwd
 *    · manifest has no `s3Buckets.assets` (project never provisioned R2)
 *    · per-project access/secret aren't in the keychain (legacy project
 *      still on the deprecated account-wide pair — checkS3('r2') above
 *      already covers that case) */
export async function checkProjectR2CredsState(projectDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const manifestPath = `${projectDir}/.hatchkit.json`;
  if (!existsSync(manifestPath)) return out;

  let manifest: {
    name?: string;
    s3Buckets?: {
      accountId?: string;
      assets?: { name?: string };
      state?: { name?: string };
    };
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return out;
  }
  if (!manifest.name || !manifest.s3Buckets?.accountId) return out;

  const buckets = [manifest.s3Buckets.assets?.name, manifest.s3Buckets.state?.name].filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  if (buckets.length === 0) return out;

  const accessKey = await getSecret(SECRET_KEYS.s3ProjectAccessKey("r2", manifest.name));
  const secretKey = await getSecret(SECRET_KEYS.s3ProjectSecretKey("r2", manifest.name));
  if (!accessKey || !secretKey) {
    out.push({
      name: `Project ${manifest.name} (R2 per-project creds)`,
      status: "skip",
      detail: "no per-project R2 access/secret in keychain — legacy project on account-wide pair",
    });
    return out;
  }

  const { HeadBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${manifest.s3Buckets.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  try {
    for (const name of buckets) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: name }));
        out.push({
          name: `Project ${manifest.name} (R2 ${name})`,
          status: "ok",
          detail: "per-project token reaches bucket",
        });
      } catch (err) {
        const msg = (err as Error).message.split("\n")[0];
        out.push({
          name: `Project ${manifest.name} (R2 ${name})`,
          status: "fail",
          detail: `per-project token can't reach bucket: ${msg}`,
          hint: [
            "Token was likely revoked in the Cloudflare dashboard.",
            `Re-mint: hatchkit provision s3   (reuses ${manifest.name}'s manifest)`,
          ],
        });
      }
    }
  } finally {
    client.destroy();
  }
  return out;
}

export async function runDoctor(opts: { json?: boolean } = {}): Promise<void> {
  const results = await collectDoctorResults();
  const okCount = results.filter((r) => r.status === "ok").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const skipCount = results.filter((r) => r.status === "skip").length;

  if (opts.json) {
    const payload = {
      summary: { ok: okCount, failing: failCount, not_configured: skipCount },
      checks: results.map((r) => ({
        name: r.name,
        status: r.status,
        detail: r.detail,
        hint: r.hint,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    if (failCount > 0) process.exit(1);
    return;
  }

  console.log(chalk.bold("  hatchkit doctor — checking configured providers\n"));
  for (const r of results) {
    const icon =
      r.status === "ok" ? chalk.green("✓") : r.status === "fail" ? chalk.red("✗") : chalk.dim("·");
    const name = r.status === "fail" ? chalk.red(r.name) : r.name;
    const detail = r.detail ? chalk.dim(` — ${r.detail}`) : "";
    console.log(`  ${icon} ${name}${detail}`);
  }
  console.log(
    `\n  ${chalk.green(`${okCount} ok`)}  ${failCount ? chalk.red(`${failCount} failing`) : chalk.dim("0 failing")}  ${chalk.dim(`${skipCount} not configured`)}\n`,
  );

  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    console.log(chalk.bold("  How to fix"));
    for (const r of failed) {
      console.log(`\n  ${chalk.red("✗")} ${chalk.bold(r.name)}`);
      const lines = r.hint ?? [
        "No specific hint — try re-running the relevant `hatchkit config add <provider>` to re-enter credentials.",
      ];
      for (const line of lines) console.log(`    ${chalk.dim("→")} ${line}`);
    }
    console.log();
    process.exit(1);
  }
}
