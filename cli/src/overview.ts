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
  getS3Config,
  getStripeConfig,
} from "./config.js";
import { CloudflareApi, type CloudflareZone } from "./utils/cloudflare-api.js";
import { CoolifyApi, type CoolifyApplication } from "./utils/coolify-api.js";
import { execOk } from "./utils/exec.js";
import { listS3Buckets } from "./utils/s3-admin.js";
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

/** A cross-provider inconsistency found by overview's post-pass:
 *  orphan buckets with no matching app, Coolify apps deploying from
 *  deleted GitHub repos, zones with no consumer, etc. These are the
 *  fleet equivalent of inventory's drift findings.
 *
 *  Shape note: many findings of the same `kind` (e.g. 10 orphan
 *  GlitchTip projects) share identical explanatory text. The renderer
 *  groups by `kind` and surfaces the category explanation once with a
 *  bulleted list of `subject`s underneath — far less noisy than
 *  printing the full headline per finding. */
export interface OverviewCrossReference {
  /** Stable category — e.g. "orphan-r2-bucket", "coolify-repo-gone". */
  kind: string;
  /**
   *  · `warn` — likely a real issue (dead deploy, orphan that should be cleaned up).
   *  · `info` — observation worth surfacing but could be intentional. */
  severity: "warn" | "info";
  /** Human-readable label for the affected resource, e.g.
   *  `"extinction-protocol-3"` or `"acme/foo"`. Listed under the kind
   *  header in the human renderer. */
  subject: string;
  /** Per-finding context, when the subject alone doesn't tell the
   *  whole story — e.g. for `coolify-repo-gone`, the Coolify app names
   *  that share the dead repo. Optional; most findings don't need it. */
  context?: string;
}

/** Category-level metadata shared across every finding of a given
 *  `kind` — the headline template + the canonical explanation. Lives
 *  on the report alongside the findings so the renderer (and JSON
 *  consumers) can pretty-print without restating boilerplate. */
export interface OverviewCrossReferenceKind {
  kind: string;
  severity: "warn" | "info";
  /** One-line headline, e.g. "Orphan GlitchTip projects". Shown as
   *  the section header before the list of subjects. */
  headline: string;
  /** Multi-line explanation of what this category means + how to act
   *  on it. Shown once per kind, not per finding. */
  description: string[];
}

export interface OverviewReport {
  cliVersion: string;
  providers: OverviewProvider[];
  /** Fleet-level inconsistencies (orphans, dead links) found by
   *  cross-referencing data across providers. Empty when everything's
   *  in order. */
  crossReferences: OverviewCrossReference[];
  /** Per-kind metadata — explanation + severity for each cross-ref
   *  category that has at least one finding. Lets renderers show the
   *  description once instead of repeating it per finding. */
  crossReferenceKinds: OverviewCrossReferenceKind[];
  summary: {
    configured: number;
    empty: number;
    skipped: number;
    errored: number;
    /** Sum of resources across every present provider. */
    totalResources: number;
    /** Count of cross-references with severity === "warn". */
    crossRefWarnings: number;
  };
}

/** Each probe's output. `provider` is the serializable per-provider
 *  summary; the optional `raw*` fields hold detailed data that the
 *  cross-reference engine reads but the report JSON doesn't include
 *  (avoids leaking hydrated Coolify app blobs into stdout). */
interface ProbeOutput {
  provider: OverviewProvider;
  rawCoolifyApps?: CoolifyApplication[];
  rawZones?: CloudflareZone[];
  rawR2Buckets?: Array<{ name: string }>;
  rawGlitchtipProjects?: Array<{ slug?: string; name?: string }>;
  rawOpenpanelProjects?: Array<{ name?: string; id?: string }>;
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
  // Every probe is best-effort. Running them in parallel keeps wall-time
  // close to the slowest single provider.
  const probes = await Promise.all([
    probeCoolify(),
    probeDns(),
    probeR2(),
    probeS3Other("hetzner"),
    probeS3Other("aws"),
    probeGlitchtip(),
    probeOpenpanel(),
    probeStripe(),
  ]);

  const providers = probes.map((p) => p.provider);

  // Cross-reference engine reads raw probe outputs to flag fleet-level
  // orphans + dead links (e.g. Coolify app deploys from a repo that no
  // longer exists). Best-effort: each check returns `[]` when it can't
  // run.
  const crossReferences = await runCrossReferences(probes);
  // Include kind metadata only for kinds that actually have findings —
  // keeps the JSON small.
  const crossReferenceKinds = CROSS_REFERENCE_KINDS.filter((k) =>
    crossReferences.some((c) => c.kind === k.kind),
  );

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
  const crossRefWarnings = crossReferences.filter((c) => c.severity === "warn").length;

  return {
    cliVersion: getCliVersion(),
    providers,
    crossReferences,
    crossReferenceKinds,
    summary: {
      configured,
      empty,
      skipped,
      errored,
      totalResources,
      crossRefWarnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider probes
// ---------------------------------------------------------------------------

async function probeCoolify(): Promise<ProbeOutput> {
  const key = "coolify";
  const label = "Coolify";
  const cfg = await getCoolifyConfig();
  if (!cfg) return { provider: { key, label, status: "skip", detail: "not configured" } };
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  try {
    const [apps, projects, databases] = await Promise.all([
      api.listApplications().catch(() => []),
      api.listProjects().catch(() => []),
      api.listDatabases().catch(() => []),
    ]);

    // Hydrate each app via getApplication to surface fqdn +
    // gitRepository. These are what the cross-reference engine needs
    // — without them we can't detect orphan zones or repo-gone deploys.
    // Parallel to keep wall-time tolerable for fleets with many apps;
    // failures degrade gracefully (the cross-ref using that app skips).
    const hydrated = (
      await Promise.all(apps.map((a) => api.getApplication(a.uuid).catch(() => null)))
    ).filter((a): a is CoolifyApplication => a !== null);

    const resources = [
      ...apps.map((a) => ({ kind: "app", identity: a.name, detail: a.description })),
      ...projects.map((p) => ({ kind: "project", identity: p.name })),
      ...databases.map((d) => ({ kind: "database", identity: d.name, detail: d.type })),
    ];
    if (resources.length === 0) {
      return {
        provider: { key, label, status: "empty", detail: cfg.url, resources },
        rawCoolifyApps: hydrated,
      };
    }
    const summary = pluralized([
      [apps.length, "app", "apps"],
      [projects.length, "project", "projects"],
      [databases.length, "database", "databases"],
    ]);
    return {
      provider: {
        key,
        label,
        status: "present",
        summary: `${summary}  ${chalk.dim(`@ ${stripScheme(cfg.url)}`)}`,
        preview: apps.map((a) => a.name).slice(0, 6),
        resources,
      },
      rawCoolifyApps: hydrated,
    };
  } catch (err) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: `Coolify request failed: ${(err as Error).message.split("\n")[0]}`,
      },
    };
  }
}

async function probeDns(): Promise<ProbeOutput> {
  const key = "dns:cloudflare";
  const label = "Cloudflare DNS";
  const cfg = await getDnsConfig();
  if (!cfg) return { provider: { key, label, status: "skip", detail: "not configured" } };
  if (cfg.provider !== "cloudflare") {
    return {
      provider: {
        key: `dns:${cfg.provider}`,
        label: `${cfg.provider} DNS`,
        status: "skip",
        detail: "no list API exposed (Cloudflare only for now)",
      },
    };
  }
  if (!cfg.apiToken) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: "Cloudflare API token missing from keychain",
      },
    };
  }
  const cf = new CloudflareApi({ token: cfg.apiToken });
  try {
    const zones = await cf.listZones();
    if (zones.length === 0) {
      return { provider: { key, label, status: "empty", resources: [] }, rawZones: zones };
    }
    return {
      provider: {
        key,
        label,
        status: "present",
        summary: `${zones.length} zone${zones.length === 1 ? "" : "s"}`,
        preview: zones.map((z) => z.name).slice(0, 6),
        resources: zones.map((z) => ({ kind: "zone", identity: z.name })),
      },
      rawZones: zones,
    };
  } catch (err) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: `Cloudflare zones list failed: ${(err as Error).message.split("\n")[0]}`,
      },
    };
  }
}

async function probeR2(): Promise<ProbeOutput> {
  const key = "s3:r2";
  const label = "R2";
  const cfg = await getS3Config("r2");
  if (!cfg) return { provider: { key, label, status: "skip", detail: "not configured" } };
  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: "R2 admin token not in keychain; can't list buckets",
      },
    };
  }
  const accountId = cfg.endpoint?.match(
    /https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i,
  )?.[1];
  if (!accountId) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: `endpoint ${cfg.endpoint} isn't an R2 endpoint`,
      },
    };
  }
  const cf = new CloudflareApi({ token: adminToken });
  try {
    const buckets = await cf.listR2Buckets(accountId);
    if (buckets.length === 0) {
      return {
        provider: {
          key,
          label,
          status: "empty",
          detail: `account ${accountId.slice(0, 6)}…`,
          resources: [],
        },
        rawR2Buckets: buckets,
      };
    }
    return {
      provider: {
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
      },
      rawR2Buckets: buckets,
    };
  } catch (err) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: `R2 list failed: ${(err as Error).message.split("\n")[0]}`,
      },
    };
  }
}

async function probeS3Other(provider: "hetzner" | "aws"): Promise<ProbeOutput> {
  const key = `s3:${provider}`;
  const label = provider === "hetzner" ? "Hetzner S3" : "AWS S3";
  const cfg = await getS3Config(provider);
  if (!cfg) return { provider: { key, label, status: "skip", detail: "not configured" } };
  try {
    const buckets = await listS3Buckets(cfg);
    if (buckets.length === 0) {
      return {
        provider: {
          key,
          label,
          status: "empty",
          detail: `endpoint ${cfg.endpoint}`,
          resources: [],
        },
      };
    }
    return {
      provider: {
        key,
        label,
        status: "present",
        summary: `${buckets.length} bucket${buckets.length === 1 ? "" : "s"}  ${chalk.dim(`@ ${cfg.endpoint}`)}`,
        preview: buckets.map((b) => b.name).slice(0, 6),
        resources: buckets.map((b) => ({
          kind: "bucket",
          identity: b.name,
          detail: b.creationDate ? b.creationDate.toISOString().slice(0, 10) : undefined,
        })),
      },
    };
  } catch (err) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: `ListBuckets failed: ${(err as Error).message.split("\n")[0]}`,
      },
    };
  }
}

async function probeGlitchtip(): Promise<ProbeOutput> {
  const key = "glitchtip";
  const label = "GlitchTip";
  const cfg = await getGlitchtipConfig();
  if (!cfg) return { provider: { key, label, status: "skip", detail: "not configured" } };
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
    if (projects.length === 0) {
      return {
        provider: { key, label, status: "empty", resources: [] },
        rawGlitchtipProjects: [],
      };
    }
    return {
      provider: {
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
      },
      rawGlitchtipProjects: projects,
    };
  } catch (err) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: `GlitchTip list failed: ${(err as Error).message.split("\n")[0]}`,
      },
    };
  }
}

async function probeOpenpanel(): Promise<ProbeOutput> {
  const key = "openpanel";
  const label = "OpenPanel";
  const cfg = await getOpenpanelConfig();
  if (!cfg) return { provider: { key, label, status: "skip", detail: "not configured" } };
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
    if (projects.length === 0) {
      return {
        provider: { key, label, status: "empty", resources: [] },
        rawOpenpanelProjects: [],
      };
    }
    return {
      provider: {
        key,
        label,
        status: "present",
        summary: `${projects.length} project${projects.length === 1 ? "" : "s"}`,
        preview: projects.map((p) => p.name ?? p.id ?? "?").slice(0, 6),
        resources: projects.map((p) => ({
          kind: "project",
          identity: p.name ?? p.id ?? "?",
        })),
      },
      rawOpenpanelProjects: projects,
    };
  } catch (err) {
    return {
      provider: {
        key,
        label,
        status: "error",
        detail: `OpenPanel list failed: ${(err as Error).message.split("\n")[0]}`,
      },
    };
  }
}

async function probeStripe(): Promise<ProbeOutput> {
  const key = "stripe";
  const label = "Stripe";
  const cfg = await getStripeConfig();
  if (!cfg) return { provider: { key, label, status: "skip", detail: "not configured" } };
  const modes: Array<{ mode: "test" | "live"; key: string }> = [];
  if (cfg.testSecretKey) modes.push({ mode: "test", key: cfg.testSecretKey });
  if (cfg.liveSecretKey) modes.push({ mode: "live", key: cfg.liveSecretKey });
  if (modes.length === 0) {
    return { provider: { key, label, status: "skip", detail: "no master keys stored" } };
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
        provider: {
          key,
          label,
          status: "error",
          detail: `Stripe ${m.mode}-mode list failed: ${(err as Error).message.split("\n")[0]}`,
        },
      };
    }
  }
  if (resources.length === 0) {
    return { provider: { key, label, status: "empty", resources } };
  }
  const byMode = new Map<string, number>();
  for (const r of resources) byMode.set(r.kind, (byMode.get(r.kind) ?? 0) + 1);
  const summary = `${resources.length} webhook${resources.length === 1 ? "" : "s"} (${Array.from(
    byMode.entries(),
  )
    .map(([k, c]) => `${c} ${k.replace("webhook ", "")}`)
    .join(", ")})`;
  return {
    provider: {
      key,
      label,
      status: "present",
      summary,
      preview: resources.slice(0, 6).map((r) => r.identity),
      resources,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers + renderer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-reference engine
// ---------------------------------------------------------------------------
//
// Runs after every probe completes. Reads each probe's raw data and
// looks for inconsistencies that a single-provider lens can't see:
//
//   · `coolify-repo-gone`        — Coolify app deploys from a repo
//                                  that `gh repo view` can't find
//   · `coolify-fqdn-no-zone`     — app fqdn references an apex with
//                                  no Cloudflare zone configured
//   · `orphan-r2-bucket`         — bucket name doesn't prefix-match
//                                  any Coolify app or project
//   · `orphan-glitchtip-project` — GlitchTip project name has no
//                                  Coolify app counterpart
//   · `orphan-openpanel-project` — same for OpenPanel
//   · `unused-cloudflare-zone`   — zone with no Coolify app fqdn
//                                  pointing into it
//
// Every check is best-effort. Missing prerequisite data (e.g. no
// hydrated Coolify apps because Coolify isn't configured) just skips
// the cross-references that need it; nothing here can fail loudly.

/** Canonical metadata for every cross-reference category. Single
 *  source of truth — `runCrossReferences` consults this when emitting
 *  findings, and the renderer prints each kind's `description` once. */
const CROSS_REFERENCE_KINDS: OverviewCrossReferenceKind[] = [
  {
    kind: "coolify-repo-gone",
    severity: "warn",
    headline: "Coolify apps deploying from a missing GitHub repo",
    description: [
      "The Coolify app's git source points at a repo that `gh` can't find.",
      "Either the repo was deleted/renamed, or it's private and `gh` lacks access.",
      "Update the source in Coolify, or destroy the app if it's dead.",
    ],
  },
  {
    kind: "coolify-fqdn-no-zone",
    severity: "warn",
    headline: "Coolify app fqdn with no Cloudflare zone",
    description: [
      "The fqdn's apex isn't in your Cloudflare account, so DNS isn't managed by hatchkit.",
      "Either add the zone to Cloudflare, or move DNS for this app to wherever the apex lives.",
    ],
  },
  {
    kind: "orphan-r2-bucket",
    severity: "info",
    headline: "R2 buckets with no matching Coolify app",
    description: [
      "Bucket follows the `<project>-<role>` naming convention but no app of that name exists.",
      "Could be an orphan from a destroyed project, or a hand-created bucket — review + delete if dead.",
    ],
  },
  {
    kind: "orphan-glitchtip-project",
    severity: "info",
    headline: "GlitchTip projects with no matching Coolify app",
    description: [
      "Could be orphans from destroyed apps, or projects for something hatchkit doesn't manage.",
    ],
  },
  {
    kind: "orphan-openpanel-project",
    severity: "info",
    headline: "OpenPanel projects with no matching Coolify app",
    description: [
      "Could be orphans from destroyed apps, or projects for something hatchkit doesn't manage.",
    ],
  },
  {
    kind: "unused-cloudflare-zone",
    severity: "info",
    headline: "Cloudflare zones with no Coolify app pointing into them",
    description: [
      "Could host a static site (gh-pages, Vercel) or be reserved — hatchkit can only check Coolify.",
    ],
  },
];

async function runCrossReferences(probes: ProbeOutput[]): Promise<OverviewCrossReference[]> {
  const out: OverviewCrossReference[] = [];

  const coolifyApps = probes.flatMap((p) => p.rawCoolifyApps ?? []);
  const zones = probes.flatMap((p) => p.rawZones ?? []);
  const r2Buckets = probes.flatMap((p) => p.rawR2Buckets ?? []);
  const glitchtipProjects = probes.flatMap((p) => p.rawGlitchtipProjects ?? []);
  const openpanelProjects = probes.flatMap((p) => p.rawOpenpanelProjects ?? []);

  const appNames = new Set(coolifyApps.map((a) => a.name));
  // Strip a single trailing `-<role>` segment so "foo-server" + "foo-client"
  // both alias to "foo" — that's what the inventory scans match against
  // and what most R2/obs project naming conventions use.
  const projectStems = new Set(
    Array.from(appNames).map((n) => n.replace(/-(server|client|web|api|backend|frontend)$/, "")),
  );

  // CR1: Coolify app deploys from a gone GitHub repo. Run `gh repo view`
  // per unique repo (dedupe across apps that share one). Skipped when
  // `gh` isn't authenticated.
  const ghAvailable =
    (await execOk("gh", ["auth", "status"])) && (await execOk("gh", ["--version"]));
  if (ghAvailable) {
    const repoSlugs = new Map<string, string[]>(); // slug → [appNames]
    for (const app of coolifyApps) {
      if (!app.gitRepository) continue;
      const slug = repoSlugFromUrl(app.gitRepository);
      if (!slug) continue;
      const existing = repoSlugs.get(slug) ?? [];
      existing.push(app.name);
      repoSlugs.set(slug, existing);
    }
    const checks = await Promise.all(
      Array.from(repoSlugs.entries()).map(async ([slug, apps]) => ({
        slug,
        apps,
        exists: await execOk("gh", ["repo", "view", slug, "--json", "name"]),
      })),
    );
    for (const c of checks) {
      if (c.exists) continue;
      out.push({
        kind: "coolify-repo-gone",
        severity: "warn",
        subject: c.slug,
        context: `via ${c.apps.join(", ")}`,
      });
    }
  }

  // CR2: Coolify app fqdn references an apex with no Cloudflare zone.
  // Only meaningful when both Coolify hydration AND zones list ran.
  if (coolifyApps.length > 0 && zones.length > 0) {
    const zoneNames = new Set(zones.map((z) => z.name.toLowerCase()));
    for (const app of coolifyApps) {
      const fqdns = collectFqdns(app);
      for (const f of fqdns) {
        const apex = apexOf(f);
        if (!apex) continue;
        if (zoneNames.has(apex.toLowerCase())) continue;
        // Skip Coolify's auto-assigned sslip.io hosts — they don't need a zone.
        if (/\.sslip\.io$/i.test(f)) continue;
        out.push({
          kind: "coolify-fqdn-no-zone",
          severity: "warn",
          subject: f,
          context: `app ${app.name} (apex ${apex})`,
        });
      }
    }
  }

  // CR3: Orphan R2 bucket — name doesn't prefix-match any Coolify app or stem.
  if (r2Buckets.length > 0 && appNames.size > 0) {
    for (const b of r2Buckets) {
      const prefix = b.name.replace(/-(assets|state|public|private|backups?)$/, "");
      if (appNames.has(prefix) || projectStems.has(prefix)) continue;
      // Skip buckets that don't follow the `<project>-<role>` convention
      // — they may be hand-created and unrelated to hatchkit projects.
      if (prefix === b.name) continue;
      out.push({
        kind: "orphan-r2-bucket",
        severity: "info",
        subject: b.name,
        context: `looked for app "${prefix}"`,
      });
    }
  }

  // CR4 + CR5: orphan obs projects (GlitchTip + OpenPanel). Match by
  // name OR slug against Coolify app names + stems.
  for (const p of glitchtipProjects) {
    const label = p.slug ?? p.name;
    if (!label) continue;
    const stem = label.replace(/-(server|client|web|api|prod|dev|staging)$/, "");
    if (appNames.has(label) || appNames.has(stem) || projectStems.has(stem)) continue;
    out.push({
      kind: "orphan-glitchtip-project",
      severity: "info",
      subject: label,
    });
  }
  for (const p of openpanelProjects) {
    const label = p.name ?? p.id;
    if (!label) continue;
    const stem = label.replace(/-(server|client|web|api|prod|dev|staging)$/, "");
    if (appNames.has(label) || appNames.has(stem) || projectStems.has(stem)) continue;
    out.push({
      kind: "orphan-openpanel-project",
      severity: "info",
      subject: label,
    });
  }

  // CR6: Cloudflare zone with no consumer — no Coolify app fqdn ends
  // inside it. Info-only because the zone might be for a static site
  // (gh-pages, Vercel, etc.) that hatchkit doesn't track.
  if (zones.length > 0 && coolifyApps.length > 0) {
    const consumed = new Set<string>();
    for (const app of coolifyApps) {
      for (const f of collectFqdns(app)) {
        const apex = apexOf(f);
        if (apex) consumed.add(apex.toLowerCase());
      }
    }
    for (const z of zones) {
      if (consumed.has(z.name.toLowerCase())) continue;
      out.push({
        kind: "unused-cloudflare-zone",
        severity: "info",
        subject: z.name,
      });
    }
  }

  return out;
}

function collectFqdns(app: CoolifyApplication): string[] {
  const fqdns: string[] = [];
  if (app.fqdn) {
    for (const part of app.fqdn.split(",")) {
      const trimmed = part
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
      if (trimmed) fqdns.push(trimmed);
    }
  }
  if (app.dockerComposeDomains) {
    for (const d of app.dockerComposeDomains) {
      const stripped = d.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (stripped) fqdns.push(stripped);
    }
  }
  return Array.from(new Set(fqdns));
}

function apexOf(domain: string): string | undefined {
  const parts = domain.replace(/\.$/, "").split(".");
  if (parts.length < 2) return undefined;
  return parts.slice(-2).join(".");
}

function repoSlugFromUrl(url: string): string | undefined {
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  // Some Coolify configs store just `owner/repo` (shorthand for the
  // GitHub App clone path). Accept that form too.
  if (/^[^/\s]+\/[^/\s]+$/.test(url)) return url;
  return undefined;
}

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

  // Cross-references block — grouped by `kind` so the explanation is
  // printed once and the affected subjects list under it. Warns first,
  // then info-level observations.
  if (report.crossReferences.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  Cross-references"));
    const byKind = new Map<string, OverviewCrossReference[]>();
    for (const c of report.crossReferences) {
      const existing = byKind.get(c.kind);
      if (existing) existing.push(c);
      else byKind.set(c.kind, [c]);
    }
    // Order: warns first, then infos. Within each tier, follow the
    // CROSS_REFERENCE_KINDS declaration order so output is stable.
    const ordered = [...report.crossReferenceKinds]
      .filter((k) => byKind.has(k.kind))
      .sort((a, b) => {
        if (a.severity === b.severity) return 0;
        return a.severity === "warn" ? -1 : 1;
      });
    for (const k of ordered) {
      const findings = byKind.get(k.kind) ?? [];
      const icon = k.severity === "warn" ? chalk.yellow("⚠") : chalk.dim("·");
      lines.push("");
      lines.push(`    ${icon} ${chalk.bold(k.headline)} ${chalk.dim(`(${findings.length})`)}`);
      for (const line of k.description) {
        lines.push(chalk.dim(`        ${line}`));
      }
      for (const f of findings) {
        const ctx = f.context ? chalk.dim(`  — ${f.context}`) : "";
        lines.push(`        · ${f.subject}${ctx}`);
      }
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
    s.crossRefWarnings > 0
      ? chalk.yellow(
          `${s.crossRefWarnings} cross-ref warning${s.crossRefWarnings === 1 ? "" : "s"}`,
        )
      : null,
  ].filter(Boolean);
  lines.push(`  ${parts.join("  ·  ")}`);
  lines.push("");
  return lines.join("\n");
}
