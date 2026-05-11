/*
 * `hatchkit overview` — fleet-level survey of what's living on every
 * configured provider, with no project filter.
 *
 * Distinct from `inventory` (which is project-scoped — "what does THIS
 * project have?") and `doctor` (which validates credentials). Overview
 * answers "what does my whole hatchkit footprint look like across all
 * configured providers, in one glance?"
 *
 * For each configured provider it pulls the top-level resource list
 * (apps, projects, databases, zones, buckets, domains, webhooks) and
 * renders a compact tree. Read-only: every call is a GET.
 */

import chalk from "chalk";
import {
  getCoolifyConfig,
  getDnsConfig,
  getGlitchtipConfig,
  getOpenpanelConfig,
  getResendConfig,
  getS3Config,
  getStripeConfig,
} from "./config.js";
import { CloudflareApi } from "./utils/cloudflare-api.js";
import { CoolifyApi } from "./utils/coolify-api.js";
import { SECRET_KEYS, getSecret } from "./utils/secrets.js";
import { getCliVersion } from "./utils/version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverviewProvider {
  /** Stable key, e.g. "coolify", "dns:cloudflare", "s3:r2". */
  key: string;
  /** Display label, e.g. "Coolify", "Cloudflare DNS". */
  label: string;
  /**
   *  · `present` — provider configured, fetched, has resources to show.
   *  · `empty`   — provider configured + reachable, but has zero resources.
   *  · `skip`    — provider not configured at all.
   *  · `error`   — fetch failed (auth, network, etc.). `detail` has the cause.
   */
  status: "present" | "empty" | "skip" | "error";
  /** Single-line summary, e.g. "8 apps, 3 projects, 2 databases". */
  summary?: string;
  /** Up to a handful of resource names for the human renderer to show
   *  under the summary. Caller can request more via `--all`. */
  preview?: string[];
  /** Reason for skip/error (`detail` is human-readable). */
  detail?: string;
  /** Full raw resource list. JSON consumers parse this; the human
   *  renderer only shows `preview` unless `--all` is set. */
  resources?: Array<{ kind: string; identity: string; detail?: string }>;
}

export interface OverviewReport {
  cliVersion: string;
  providers: OverviewProvider[];
  summary: {
    configured: number;
    empty: number;
    skipped: number;
    errored: number;
    /** Sum of resources across every present provider. */
    totalResources: number;
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface RunOverviewOptions {
  json?: boolean;
  /** When true the human renderer lists ALL resources instead of the
   *  preview-only short form. */
  all?: boolean;
}

export async function runOverview(opts: RunOverviewOptions = {}): Promise<void> {
  const report = await collectOverview();
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderOverviewHuman(report, { all: opts.all ?? false }));
}

export async function collectOverview(): Promise<OverviewReport> {
  // Every probe is best-effort and returns its own OverviewProvider —
  // running them in parallel keeps wall-time close to the slowest one.
  const providers = await Promise.all([
    probeCoolify(),
    probeDns(),
    probeR2(),
    probeS3Other("hetzner"),
    probeS3Other("aws"),
    probeResend(),
    probeGlitchtip(),
    probeOpenpanel(),
    probeStripe(),
  ]);

  let configured = 0;
  let empty = 0;
  let skipped = 0;
  let errored = 0;
  let totalResources = 0;
  for (const p of providers) {
    switch (p.status) {
      case "present":
        configured++;
        totalResources += p.resources?.length ?? 0;
        break;
      case "empty":
        empty++;
        break;
      case "skip":
        skipped++;
        break;
      case "error":
        errored++;
        break;
    }
  }

  return {
    cliVersion: getCliVersion(),
    providers,
    summary: { configured, empty, skipped, errored, totalResources },
  };
}

// ---------------------------------------------------------------------------
// Provider probes
// ---------------------------------------------------------------------------

async function probeCoolify(): Promise<OverviewProvider> {
  const key = "coolify";
  const label = "Coolify";
  const cfg = await getCoolifyConfig();
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  try {
    const [apps, projects, databases] = await Promise.all([
      api.listApplications().catch(() => []),
      api.listProjects().catch(() => []),
      api.listDatabases().catch(() => []),
    ]);
    const resources = [
      ...apps.map((a) => ({ kind: "app", identity: a.name, detail: a.description })),
      ...projects.map((p) => ({ kind: "project", identity: p.name })),
      ...databases.map((d) => ({ kind: "database", identity: d.name, detail: d.type })),
    ];
    if (resources.length === 0) {
      return { key, label, status: "empty", detail: cfg.url, resources };
    }
    const summary = pluralized([
      [apps.length, "app", "apps"],
      [projects.length, "project", "projects"],
      [databases.length, "database", "databases"],
    ]);
    return {
      key,
      label,
      status: "present",
      summary: `${summary}  ${chalk.dim(`@ ${stripScheme(cfg.url)}`)}`,
      preview: apps.map((a) => a.name).slice(0, 6),
      resources,
    };
  } catch (err) {
    return {
      key,
      label,
      status: "error",
      detail: `Coolify request failed: ${(err as Error).message.split("\n")[0]}`,
    };
  }
}

async function probeDns(): Promise<OverviewProvider> {
  const key = "dns:cloudflare";
  const label = "Cloudflare DNS";
  const cfg = await getDnsConfig();
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  if (cfg.provider !== "cloudflare") {
    return {
      key: `dns:${cfg.provider}`,
      label: `${cfg.provider} DNS`,
      status: "skip",
      detail: "no list API exposed (Cloudflare only for now)",
    };
  }
  if (!cfg.apiToken) {
    return { key, label, status: "error", detail: "Cloudflare API token missing from keychain" };
  }
  const cf = new CloudflareApi({ token: cfg.apiToken });
  try {
    const zones = await cf.listZones();
    if (zones.length === 0) {
      return { key, label, status: "empty", resources: [] };
    }
    return {
      key,
      label,
      status: "present",
      summary: `${zones.length} zone${zones.length === 1 ? "" : "s"}`,
      preview: zones.map((z) => z.name).slice(0, 6),
      resources: zones.map((z) => ({ kind: "zone", identity: z.name })),
    };
  } catch (err) {
    return {
      key,
      label,
      status: "error",
      detail: `Cloudflare zones list failed: ${(err as Error).message.split("\n")[0]}`,
    };
  }
}

async function probeR2(): Promise<OverviewProvider> {
  const key = "s3:r2";
  const label = "R2";
  const cfg = await getS3Config("r2");
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    return {
      key,
      label,
      status: "error",
      detail: "R2 admin token not in keychain; can't list buckets",
    };
  }
  const accountId = cfg.endpoint?.match(
    /https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i,
  )?.[1];
  if (!accountId) {
    return { key, label, status: "error", detail: `endpoint ${cfg.endpoint} isn't an R2 endpoint` };
  }
  const cf = new CloudflareApi({ token: adminToken });
  try {
    const buckets = await cf.listR2Buckets(accountId);
    if (buckets.length === 0) {
      return {
        key,
        label,
        status: "empty",
        detail: `account ${accountId.slice(0, 6)}…`,
        resources: [],
      };
    }
    return {
      key,
      label,
      status: "present",
      summary: `${buckets.length} bucket${buckets.length === 1 ? "" : "s"}  ${chalk.dim(`(account ${accountId.slice(0, 6)}…)`)}`,
      preview: buckets.map((b) => b.name).slice(0, 6),
      resources: buckets.map((b) => ({
        kind: "bucket",
        identity: b.name,
        detail: b.storage_class,
      })),
    };
  } catch (err) {
    return {
      key,
      label,
      status: "error",
      detail: `R2 list failed: ${(err as Error).message.split("\n")[0]}`,
    };
  }
}

async function probeS3Other(provider: "hetzner" | "aws"): Promise<OverviewProvider> {
  const key = `s3:${provider}`;
  const label = provider === "hetzner" ? "Hetzner S3" : "AWS S3";
  const cfg = await getS3Config(provider);
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  // Bucket listing for AWS-compatible providers requires the AWS SDK
  // signature flow — out of scope for a quick fetch-based probe. We
  // surface "configured" without a list so the user knows where else
  // to look.
  return {
    key,
    label,
    status: "present",
    summary: `credentials present  ${chalk.dim(`@ ${cfg.endpoint}`)}`,
    detail: "bucket listing not implemented for this provider",
    resources: [],
  };
}

async function probeResend(): Promise<OverviewProvider> {
  const key = "resend";
  const label = "Resend";
  const cfg = await getResendConfig();
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: Array<{ name?: string; status?: string }>;
    };
    const domains = (body.data ?? []).filter(
      (d): d is { name: string; status?: string } => typeof d.name === "string",
    );
    if (domains.length === 0) return { key, label, status: "empty", resources: [] };
    return {
      key,
      label,
      status: "present",
      summary: `${domains.length} domain${domains.length === 1 ? "" : "s"}`,
      preview: domains.map((d) => `${d.name}${d.status ? ` (${d.status})` : ""}`).slice(0, 6),
      resources: domains.map((d) => ({
        kind: "verified-domain",
        identity: d.name,
        detail: d.status,
      })),
    };
  } catch (err) {
    return {
      key,
      label,
      status: "error",
      detail: `Resend list failed: ${(err as Error).message.split("\n")[0]}`,
    };
  }
}

async function probeGlitchtip(): Promise<OverviewProvider> {
  const key = "glitchtip";
  const label = "GlitchTip";
  const cfg = await getGlitchtipConfig();
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  try {
    const res = await fetch(
      `${cfg.url.replace(/\/$/, "")}/api/0/organizations/${cfg.organizationSlug}/projects/`,
      { headers: { Authorization: `Bearer ${cfg.token}` } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Array<{ name?: string; slug?: string; platform?: string }>;
    const projects = body.filter(
      (p): p is { name: string; slug?: string; platform?: string } => typeof p.name === "string",
    );
    if (projects.length === 0) return { key, label, status: "empty", resources: [] };
    return {
      key,
      label,
      status: "present",
      summary: `${projects.length} project${projects.length === 1 ? "" : "s"}  ${chalk.dim(`(org ${cfg.organizationSlug})`)}`,
      preview: projects.map((p) => p.slug ?? p.name).slice(0, 6),
      resources: projects.map((p) => ({
        kind: "project",
        identity: p.slug ?? p.name,
        detail: p.platform,
      })),
    };
  } catch (err) {
    return {
      key,
      label,
      status: "error",
      detail: `GlitchTip list failed: ${(err as Error).message.split("\n")[0]}`,
    };
  }
}

async function probeOpenpanel(): Promise<OverviewProvider> {
  const key = "openpanel";
  const label = "OpenPanel";
  const cfg = await getOpenpanelConfig();
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  try {
    const base = (cfg.apiUrl ?? cfg.url).replace(/\/$/, "");
    const res = await fetch(`${base}/manage/projects`, {
      headers: {
        "openpanel-client-id": cfg.rootClientId,
        "openpanel-client-secret": cfg.rootClientSecret,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as unknown;
    // Same shape duality as scanOpenpanel — bare array or `{ data }`.
    const projects: Array<{ name?: string; id?: string }> = Array.isArray(raw)
      ? (raw as Array<{ name?: string; id?: string }>)
      : ((raw as { data?: Array<{ name?: string; id?: string }> }).data ?? []);
    if (projects.length === 0) return { key, label, status: "empty", resources: [] };
    return {
      key,
      label,
      status: "present",
      summary: `${projects.length} project${projects.length === 1 ? "" : "s"}`,
      preview: projects.map((p) => p.name ?? p.id ?? "?").slice(0, 6),
      resources: projects.map((p) => ({
        kind: "project",
        identity: p.name ?? p.id ?? "?",
      })),
    };
  } catch (err) {
    return {
      key,
      label,
      status: "error",
      detail: `OpenPanel list failed: ${(err as Error).message.split("\n")[0]}`,
    };
  }
}

async function probeStripe(): Promise<OverviewProvider> {
  const key = "stripe";
  const label = "Stripe";
  const cfg = await getStripeConfig();
  if (!cfg) return { key, label, status: "skip", detail: "not configured" };
  const modes: Array<{ mode: "test" | "live"; key: string }> = [];
  if (cfg.testSecretKey) modes.push({ mode: "test", key: cfg.testSecretKey });
  if (cfg.liveSecretKey) modes.push({ mode: "live", key: cfg.liveSecretKey });
  if (modes.length === 0) {
    return { key, label, status: "skip", detail: "no master keys stored" };
  }
  const resources: Array<{ kind: string; identity: string; detail?: string }> = [];
  for (const m of modes) {
    try {
      const res = await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=100", {
        headers: { Authorization: `Bearer ${m.key}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: Array<{ id?: string; url?: string; status?: string }>;
      };
      for (const w of body.data ?? []) {
        if (!w.id || !w.url) continue;
        resources.push({
          kind: `webhook (${m.mode})`,
          identity: w.url,
          detail: `${w.id} · ${w.status ?? "?"}`,
        });
      }
    } catch (err) {
      return {
        key,
        label,
        status: "error",
        detail: `Stripe ${m.mode}-mode list failed: ${(err as Error).message.split("\n")[0]}`,
      };
    }
  }
  if (resources.length === 0) return { key, label, status: "empty", resources };
  const byMode = new Map<string, number>();
  for (const r of resources) byMode.set(r.kind, (byMode.get(r.kind) ?? 0) + 1);
  const summary = `${resources.length} webhook${resources.length === 1 ? "" : "s"} (${Array.from(
    byMode.entries(),
  )
    .map(([k, c]) => `${c} ${k.replace("webhook ", "")}`)
    .join(", ")})`;
  return {
    key,
    label,
    status: "present",
    summary,
    preview: resources.slice(0, 6).map((r) => r.identity),
    resources,
  };
}

// ---------------------------------------------------------------------------
// Helpers + renderer
// ---------------------------------------------------------------------------

function pluralized(parts: Array<[number, string, string]>): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, s, p]) => `${n} ${n === 1 ? s : p}`)
    .join(", ");
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function renderOverviewHuman(
  report: OverviewReport,
  opts: { all: boolean } = { all: false },
): string {
  const lines: string[] = [];
  lines.push(chalk.bold("  hatchkit overview"));
  lines.push(chalk.dim(`  v${report.cliVersion}  ·  read-only fleet survey`));
  lines.push("");

  for (const p of report.providers) {
    if (p.status === "skip") {
      lines.push(`  ${chalk.dim("·")} ${chalk.bold(p.label)}  ${chalk.dim(p.detail ?? "")}`);
      continue;
    }
    if (p.status === "error") {
      lines.push(`  ${chalk.red("✗")} ${chalk.bold(p.label)}  ${chalk.red(p.detail ?? "")}`);
      continue;
    }
    if (p.status === "empty") {
      lines.push(
        `  ${chalk.dim("◯")} ${chalk.bold(p.label)}  ${chalk.dim(p.detail ?? "no resources")}`,
      );
      continue;
    }
    // present
    lines.push(`  ${chalk.green("✓")} ${chalk.bold(p.label)}  ${chalk.dim(p.summary ?? "")}`);
    const items = opts.all
      ? (p.resources ?? []).map((r) => (r.detail ? `${r.identity} (${r.detail})` : r.identity))
      : (p.preview ?? []);
    const truncated =
      !opts.all && p.resources && p.resources.length > (p.preview?.length ?? 0)
        ? ` ${chalk.dim(`(+${p.resources.length - (p.preview?.length ?? 0)} more — pass --all)`)}`
        : "";
    if (items.length > 0) {
      lines.push(chalk.dim(`        ${items.join(", ")}${truncated}`));
    }
  }

  lines.push("");
  const s = report.summary;
  const parts = [
    `${chalk.green(`${s.configured} configured`)}`,
    s.empty ? chalk.dim(`${s.empty} empty`) : null,
    s.errored ? chalk.red(`${s.errored} error${s.errored === 1 ? "" : "s"}`) : null,
    chalk.dim(`${s.skipped} not configured`),
    chalk.dim(`${s.totalResources} total resource${s.totalResources === 1 ? "" : "s"}`),
  ].filter(Boolean);
  lines.push(`  ${parts.join("  ·  ")}`);
  lines.push("");
  return lines.join("\n");
}
