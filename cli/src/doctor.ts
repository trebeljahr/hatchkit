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
  if (!cfg || cfg.provider === "manual") return { name: "DNS", status: "skip" };
  if (cfg.provider === "cloudflare") {
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
  // INWX uses XML-RPC login — skip active-verify (cheap check would require a login call).
  return {
    name: "DNS (INWX)",
    status: "ok",
    detail: "credentials stored (not test-authenticated)",
  };
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
  // for — bucket admin (Workers R2 Storage:Edit) AND minting per-project
  // child tokens (User > API Tokens:Edit). Either failing tells the
  // user which perm to add. Per-project access/secret pairs aren't
  // checked here; that's per-project doctor territory (TODO).
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

      // GET /user/tokens lists tokens the caller can manage —
      // requires User > API Tokens > Read (implied by Edit). Without
      // it we'd 9109 / 403 here, signalling we can't mint per-project
      // child tokens.
      const tokenRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens?per_page=1", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!tokenRes.ok) {
        throw new Error(`HTTP ${tokenRes.status} (api-tokens list — needs API Tokens:Edit)`);
      }
      return `R2 perm OK (${n} bucket(s)); API Tokens perm OK (can mint scoped child tokens)`;
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "R2 admin Bearer token is invalid or revoked.",
          "Create a new one: https://dash.cloudflare.com/profile/api-tokens → Custom token",
          "Permissions:    Account > Workers R2 Storage > Edit",
          "                User    > API Tokens         > Edit",
          "Then re-run: `hatchkit config add s3 r2` to re-paste + verify globally.",
        ];
      }
      if (/api-tokens list/i.test(detail)) {
        return [
          "Admin token has R2 perm but lacks `User > API Tokens > Edit`.",
          "Without it, hatchkit can't mint per-project R2 credentials at provision-time.",
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

async function checkStripe(): Promise<CheckResult> {
  const { getStripeConfig } = await import("./config.js");
  const cfg = await getStripeConfig();
  if (!cfg) return { name: "Stripe", status: "skip" };
  return check(
    `Stripe (${cfg.mode})`,
    async () => {
      const res = await fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${cfg.secretKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "secret key valid";
    },
    (detail) => {
      const code = httpCode(detail);
      if (code === 401) {
        return [
          "Stripe secret key is invalid or was rotated.",
          "Find the current pair at https://dashboard.stripe.com/apikeys",
          "Then re-run: `hatchkit config add stripe`",
        ];
      }
      return undefined;
    },
  );
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
  results.push(await checkStripe());
  return results;
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
