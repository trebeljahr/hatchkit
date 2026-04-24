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
} from "./config.js";
import { verifyCoolify } from "./utils/coolify-api.js";
import { execOk } from "./utils/exec.js";
import { SECRET_KEYS, getSecret } from "./utils/secrets.js";

interface CheckResult {
  name: string;
  status: "ok" | "fail" | "skip";
  detail?: string;
}

async function check(name: string, fn: () => Promise<string | void>): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, status: "ok", detail: detail || undefined };
  } catch (err) {
    return { name, status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkGitHub(): Promise<CheckResult> {
  if (!(await execOk("gh", ["--version"]))) {
    return { name: "GitHub (gh CLI)", status: "fail", detail: "gh CLI not installed" };
  }
  if (!(await execOk("gh", ["auth", "status"]))) {
    return { name: "GitHub (gh CLI)", status: "fail", detail: "not authenticated — run `gh auth login`" };
  }
  return { name: "GitHub (gh CLI)", status: "ok" };
}

async function checkCoolify(): Promise<CheckResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return { name: "Coolify", status: "skip" };
  return check("Coolify", async () => {
    const v = await verifyCoolify(cfg.url, cfg.token);
    return `v${v}`;
  });
}

async function checkHetzner(): Promise<CheckResult> {
  const cfg = await getHetznerConfig();
  if (!cfg) return { name: "Hetzner Cloud", status: "skip" };
  return check("Hetzner Cloud", async () => {
    const res = await fetch("https://api.hetzner.cloud/v1/servers?per_page=1", {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { meta?: { pagination?: { total_entries?: number } } };
    return `${body.meta?.pagination?.total_entries ?? "?"} server(s)`;
  });
}

async function checkDns(): Promise<CheckResult> {
  const cfg = await getDnsConfig();
  if (!cfg || cfg.provider === "manual") return { name: "DNS", status: "skip" };
  if (cfg.provider === "cloudflare") {
    return check("DNS (Cloudflare)", async () => {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { status?: string } };
      return body.result?.status ?? "active";
    });
  }
  // INWX uses XML-RPC login — skip active-verify (cheap check would require a login call).
  return { name: "DNS (INWX)", status: "ok", detail: "credentials stored (not test-authenticated)" };
}

async function checkS3(provider: "hetzner" | "aws" | "r2"): Promise<CheckResult> {
  const name = `S3 (${provider})`;
  const cfg = await getS3Config(provider);
  if (!cfg) return { name, status: "skip" };
  // Stored creds only — a real verify would require an AWS SDK call.
  return { name, status: "ok", detail: "credentials stored (endpoint set)" };
}

async function checkGpu(platform: string): Promise<CheckResult> {
  const store = getStore();
  const meta = store.get(`providers.gpu.${platform}`) as { status?: string } | undefined;
  const name = `GPU (${platform})`;
  if (meta?.status !== "configured") return { name, status: "skip" };
  if (platform === "modal") {
    return check(name, async () => {
      if (!(await execOk("modal", ["token", "current"]))) throw new Error("`modal token current` failed");
      return "authenticated";
    });
  }
  const key = await getSecret(SECRET_KEYS.gpuApiKey(platform));
  if (!key) return { name, status: "fail", detail: "API key missing from keychain" };
  if (platform === "hf") {
    return check(name, async () => {
      const res = await fetch("https://huggingface.co/api/whoami-v2", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { name?: string };
      return body.name ?? "authenticated";
    });
  }
  if (platform === "replicate") {
    return check(name, async () => {
      const res = await fetch("https://api.replicate.com/v1/account", {
        headers: { Authorization: `Token ${key}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "authenticated";
    });
  }
  if (platform === "runpod") {
    return check(name, async () => {
      const res = await fetch("https://rest.runpod.io/v1/user", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "authenticated";
    });
  }
  return { name, status: "ok", detail: "credentials stored" };
}

async function checkGlitchtip(): Promise<CheckResult> {
  const cfg = await getGlitchtipConfig();
  if (!cfg) return { name: "GlitchTip", status: "skip" };
  return check("GlitchTip", async () => {
    const res = await fetch(`${cfg.url}/api/0/organizations/${cfg.organizationSlug}/`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return `org: ${cfg.organizationSlug}`;
  });
}

async function checkOpenpanel(): Promise<CheckResult> {
  const cfg = await getOpenpanelConfig();
  if (!cfg) return { name: "OpenPanel", status: "skip" };
  return check("OpenPanel", async () => {
    const res = await fetch(`${cfg.url}/api/manage/projects`, {
      headers: {
        "openpanel-client-id": cfg.rootClientId,
        "openpanel-client-secret": cfg.rootClientSecret,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return `root client OK`;
  });
}

async function checkResend(): Promise<CheckResult> {
  const cfg = await getResendConfig();
  if (!cfg) return { name: "Resend", status: "skip" };
  return check("Resend", async () => {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return "API key valid";
  });
}

export async function runDoctor(): Promise<void> {
  console.log(chalk.bold("\n  hatchkit doctor — checking configured providers\n"));
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

  for (const r of results) {
    const icon =
      r.status === "ok" ? chalk.green("✓") : r.status === "fail" ? chalk.red("✗") : chalk.dim("·");
    const name = r.status === "fail" ? chalk.red(r.name) : r.name;
    const detail = r.detail ? chalk.dim(` — ${r.detail}`) : "";
    console.log(`  ${icon} ${name}${detail}`);
  }
  const okCount = results.filter((r) => r.status === "ok").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  console.log(
    `\n  ${chalk.green(`${okCount} ok`)}  ${failCount ? chalk.red(`${failCount} failing`) : chalk.dim("0 failing")}  ${chalk.dim(`${skipCount} not configured`)}\n`,
  );
  if (failCount > 0) process.exit(1);
}
