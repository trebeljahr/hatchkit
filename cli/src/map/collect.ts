/*
 * Live reads for `hatchkit map`. Every call is a GET, a local file read
 * or a read-only command (`launchctl list`, `tailscale status`, `gh repo
 * list`, `systemctl show` over `tailscale ssh`). Each collector is
 * best-effort: a failure becomes a `sources[]` row and the map is drawn
 * without that part.
 *
 * Addresses, account ids and UUIDs are used only to join one provider's
 * records to another's (a Coolify server to its Hetzner server by IPv4,
 * a backup host to its Coolify server by UUID) and never reach the facts.
 */

import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  type BackupHost,
  backupHostExec,
  backupHosts,
  backupProvider,
} from "../backups/provider.js";
import {
  getCloudflareDeployTokenRecords,
  getConfig,
  getConfiguredCloudflareAccountId,
  getCoolifyConfig,
  getHetznerToken,
  getProviderPauses,
} from "../config.js";
import { collectOverview } from "../overview.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { loadAllLedgers } from "../utils/run-ledger.js";
import { getCloudflareTokenValue } from "../utils/secrets.js";
import { getCliVersion } from "../utils/version.js";
import { HATCHKIT_LAUNCHD_PREFIX } from "./build.js";
import {
  discoverGithub,
  discoverLaunchd,
  discoverRepos,
  discoverTailscale,
  readTerraformState,
} from "./discover.js";
import { type MapExtras, expandHome } from "./extras.js";
import type {
  BackupFacts,
  CloudflareFacts,
  CoolifyFacts,
  FleetFacts,
  HetznerFacts,
  HostTimer,
  HostTimerFacts,
  MapSource,
} from "./model.js";
import { humanizeTimer } from "./schedule.js";

export interface CollectOptions {
  extras: MapExtras;
  /** Read hatchkit's timers on each backup host over `tailscale ssh`. */
  ssh: boolean;
  /** `infra/terraform/stacks` to read workspaces from. */
  stacksDir?: string;
  /** Count GitHub repos through `gh`. */
  github: boolean;
  /** Progress lines on stderr (never on stdout, which may carry JSON). */
  log?: (line: string) => void;
}

const firstLine = (err: unknown) =>
  ((err as Error)?.message ?? String(err)).split("\n")[0].slice(0, 240);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Hostnames in a Coolify `fqdn` (comma-separated URLs). */
export function fqdnHosts(fqdn: string | undefined): string[] {
  if (!fqdn) return [];
  return [
    ...new Set(
      fqdn
        .split(",")
        .map((p) =>
          p
            .trim()
            .replace(/^https?:\/\//, "")
            .replace(/[/:].*$/, ""),
        )
        .filter(Boolean),
    ),
  ];
}

/** `owner/repo` from a git URL or shorthand, else undefined. */
export function repoSlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m =
    /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/.exec(url) ??
    /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Upstream version of a Coolify service from its image list: only an
 *  image named after the service, only a numeric tag. Rebuilt images
 *  (registry paths carrying a resource id) give nothing. */
export function serviceVersion(name: string, images: readonly string[]): string | undefined {
  for (const image of images) {
    const [repo, tag = ""] = image.split("@")[0].split(/:(?=[^/]*$)/);
    if (!repo.toLowerCase().includes(name.toLowerCase().replace(/-/g, ""))) {
      if (!repo.toLowerCase().includes(name.toLowerCase())) continue;
    }
    if (/[a-z0-9]{20,}/.test(repo)) continue;
    const v = /^v?(\d+(?:\.\d+)+)/.exec(tag)?.[1];
    if (v) return v;
  }
  return undefined;
}

/** Blank-line separated `systemctl show` blocks → key/value records. */
export function parseSystemctlShow(text: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      if (Object.keys(cur).length) out.push(cur);
      cur = {};
      continue;
    }
    const i = line.indexOf("=");
    if (i <= 0) continue;
    // A timer prints one TimersMonotonic= line per trigger; keep them all.
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    cur[key] = cur[key] === undefined ? value : `${cur[key]} ; ${value}`;
  }
  if (Object.keys(cur).length) out.push(cur);
  return out;
}

/** Service results that are not a failure. `exec-condition`: the unit's
 *  ExecCondition= said there was nothing to do, and systemd skipped it. */
const NOT_FAILURES = ["success", "exec-condition"];

/** Timer blocks plus their service blocks → one row per timer. */
export function timersFromShow(text: string): HostTimer[] {
  const blocks = parseSystemctlShow(text);
  const services = new Map(blocks.filter((b) => b.Id?.endsWith(".service")).map((b) => [b.Id, b]));
  return blocks
    .filter((b) => b.Id?.endsWith(".timer"))
    .map((t) => {
      const svc = services.get(t.Id.replace(/\.timer$/, ".service"));
      const result = svc?.Result;
      return {
        unit: t.Id,
        description: svc?.Description || t.Description || undefined,
        when: humanizeTimer(t.TimersCalendar ?? "", t.TimersMonotonic ?? ""),
        active: t.ActiveState === "active",
        failed: svc?.ActiveState === "failed" || (!!result && !NOT_FAILURES.includes(result)),
      };
    })
    .sort((a, b) => a.unit.localeCompare(b.unit));
}

export const HOST_TIMERS_COMMAND =
  "u=$(systemctl list-unit-files --no-legend --no-pager --type=timer 'hatchkit-*' | awk '{print $1}'); " +
  'if [ -n "$u" ]; then s=$(echo "$u" | sed "s/\\.timer$/.service/"); ' +
  "systemctl show --no-pager -p Id -p Description -p ActiveState -p TimersCalendar -p TimersMonotonic $u; echo; " +
  "systemctl show --no-pager -p Id -p Description -p ActiveState -p Result $s; fi";

/** Configured provider keys from the config file, never their values. */
export function configuredProviders(
  providers: Record<string, unknown>,
  paused: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const isOn = (v: unknown) =>
    !!v && typeof v === "object" && (v as { status?: string }).status === "configured";
  for (const [key, value] of Object.entries(providers)) {
    if (paused.includes(key)) continue;
    if (isOn(value)) out.push(key);
    else if (value && typeof value === "object" && !("status" in value)) {
      for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
        if (isOn(v) || (v && typeof v === "object" && "endpoint" in v)) out.push(`${key}:${sub}`);
      }
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

interface CoolifyRead {
  facts: CoolifyFacts;
  /** Internal join keys; dropped before the facts leave this module. */
  serverIps: Map<string, string>;
  serverUuids: Map<string, string>;
}

async function readCoolify(): Promise<CoolifyRead | null> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return null;
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const [version, servers, placements, projects] = await Promise.all([
    api.getVersion().catch(() => undefined),
    api.listServers(),
    api.listPlacements(),
    api.listProjectsWithEnvironments().catch(() => []),
  ]);
  const projectOfEnv = new Map<number, string>();
  for (const p of projects) for (const e of p.environments) projectOfEnv.set(e.id, p.name);
  return {
    serverIps: new Map(servers.map((s) => [s.name, s.ip])),
    serverUuids: new Map(servers.filter((s) => s.uuid).map((s) => [s.uuid as string, s.name])),
    facts: {
      version: typeof version === "string" ? version.trim() : undefined,
      servers: servers.map((s) => ({
        name: s.name,
        coolifyHost: s.isCoolifyHost === true,
        reachable: s.isReachable,
      })),
      apps: placements.applications.map((a) => ({
        name: a.name,
        server: a.server,
        project: a.environmentId !== undefined ? projectOfEnv.get(a.environmentId) : undefined,
        status: a.status,
        buildPack: a.buildPack,
        domains: fqdnHosts(a.fqdn),
        repo: repoSlug(a.gitRepository),
      })),
      databases: placements.databases,
      services: placements.services.map((s) => ({
        name: s.name,
        server: s.server,
        status: s.status,
        versions: [serviceVersion(s.name, s.images)].filter((v): v is string => !!v),
      })),
      projects: projects.map((p) => p.name).sort(),
    },
  };
}

interface HetznerRead {
  facts: HetznerFacts;
  ips: Map<string, string>;
}

async function readHetzner(): Promise<HetznerRead | null> {
  const meta = getConfig().providers.hetzner as { status?: string } | undefined;
  if (meta?.status !== "configured") return null;
  const token = await getHetznerToken();
  if (!token) throw new Error("Hetzner token missing from keychain");
  const res = await fetch("https://api.hetzner.cloud/v1/servers?per_page=50", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Hetzner API HTTP ${res.status}`);
  const body = (await res.json()) as {
    servers?: Array<{
      name: string;
      status?: string;
      server_type?: { name?: string };
      datacenter?: { location?: { name?: string } };
      labels?: Record<string, string>;
      public_net?: { ipv4?: { ip?: string } };
    }>;
  };
  const servers = body.servers ?? [];
  return {
    ips: new Map(
      servers
        .filter((s) => s.public_net?.ipv4?.ip)
        .map((s) => [s.public_net?.ipv4?.ip as string, s.name]),
    ),
    facts: {
      servers: servers.map((s) => ({
        name: s.name,
        type: s.server_type?.name ?? "?",
        location: s.datacenter?.location?.name,
        status: s.status,
        role: s.labels?.role,
      })),
    },
  };
}

async function readCloudflare(): Promise<CloudflareFacts | null> {
  const accountId = getConfiguredCloudflareAccountId();
  const token = await getCloudflareTokenValue("dns");
  if (!token || !accountId) return null;
  const cf = new CloudflareApi({ token });
  const [zones, scripts, domains] = await Promise.all([
    cf.listZones(),
    cf.listWorkerScripts(accountId),
    cf.listWorkerCustomDomains(accountId).catch(() => []),
  ]);
  const r2Token = (await getCloudflareTokenValue("r2")) ?? token;
  const buckets = await new CloudflareApi({ token: r2Token })
    .listR2Buckets(accountId)
    .catch(() => [] as Array<{ name: string }>);
  const workers = await Promise.all(
    scripts.map(async (s) => {
      const crons = s.handlers?.includes("scheduled")
        ? await cf.getWorkerSchedules(accountId, s.id).catch(() => [])
        : [];
      const hosts = [
        ...(s.routes ?? []).map((r) =>
          (r.pattern ?? "").replace(/\/.*$/, "").replace(/^\*\.?/, ""),
        ),
        ...domains.filter((d) => d.service === s.id).map((d) => d.hostname),
      ].filter(Boolean);
      return {
        name: s.id,
        hasAssets: s.has_assets === true,
        crons,
        deployedFrom: s.last_deployed_from || undefined,
        hosts: [...new Set(hosts)],
      };
    }),
  );
  return {
    zones: zones.map((z) => z.name).sort(),
    buckets: buckets.map((b) => b.name).sort(),
    workers: workers.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function readBackups(
  coolifyUuids: Map<string, string> | undefined,
): { facts: BackupFacts; hosts: BackupHost[] } | null {
  const meta = getConfig().providers.backups as { status?: string } | undefined;
  if (meta?.status !== "configured") return null;
  const provider = backupProvider();
  const hosts = backupHosts();
  const repo = provider.repositoryBase ?? "";
  return {
    hosts,
    facts: {
      target: /r2\.cloudflarestorage\.com/.test(repo)
        ? "r2"
        : repo.startsWith("s3:")
          ? "s3"
          : "other",
      hosts: hosts.map((h) => ({
        name: h.name,
        server: h.serverUuid ? coolifyUuids?.get(h.serverUuid) : undefined,
        schedule: h.schedule,
      })),
    },
  };
}

async function readHostTimers(hosts: BackupHost[]): Promise<HostTimerFacts> {
  const out: HostTimerFacts = {};
  await Promise.all(
    hosts.map(async (h) => {
      try {
        const text = await backupHostExec(h, HOST_TIMERS_COMMAND, undefined, 25_000);
        out[h.name] = { timers: timersFromShow(text) };
      } catch (err) {
        out[h.name] = { error: firstLine(err) };
      }
    }),
  );
  return out;
}

export function defaultStacksDirs(assetRoot: string | undefined, configDir: string): string[] {
  const dirs: string[] = [];
  if (assetRoot) dirs.push(join(assetRoot, "infra", "terraform", "stacks"));
  dirs.push(join(configDir, "infra", "terraform", "stacks"));
  return dirs;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function collectFleetFacts(opts: CollectOptions): Promise<FleetFacts> {
  const log = opts.log ?? (() => {});
  const sources: MapSource[] = [];
  const note = (key: string, label: string, status: MapSource["status"], detail?: string) =>
    sources.push({ key, label, status, detail });
  const attempt = async <T>(key: string, label: string, fn: () => Promise<T | null>) => {
    log(`  reading ${label}…`);
    try {
      const v = await fn();
      if (v === null) note(key, label, "skip", "not configured");
      else note(key, label, "ok");
      return v ?? undefined;
    } catch (err) {
      note(key, label, "error", firstLine(err));
      return undefined;
    }
  };

  const config = getConfig();
  const providers = configuredProviders(
    config.providers as unknown as Record<string, unknown>,
    Object.keys(getProviderPauses()),
  );
  const extras = opts.extras;
  const prefixes = [HATCHKIT_LAUNCHD_PREFIX, ...(extras.launchdPrefixes ?? [])];
  const roots = (extras.projectRoots ?? []).map((r) => expandHome(r));

  // Local reads first: they never touch the keychain.
  const [launchd, repos, tailscale, github] = await Promise.all([
    attempt("launchd", "launchd jobs", async () =>
      process.platform === "darwin" ? discoverLaunchd(prefixes) : null,
    ),
    attempt("repos", "local repos", async () => (roots.length ? discoverRepos(roots) : null)),
    attempt("tailscale", "Tailscale", async () => {
      const r = await discoverTailscale(
        process.env.TAILSCALE_API_KEY ?? process.env.HATCHKIT_TAILSCALE_API_KEY,
      );
      if (!r.facts) throw new Error(r.error ?? "tailscale status failed");
      if (r.error) note("tailscale-policy", "tailnet policy", "error", r.error);
      return r.facts;
    }),
    attempt("github", "GitHub repos", async () => {
      if (!opts.github) return null;
      const r = await discoverGithub(extras.githubOwners);
      if (!r.facts) throw new Error(r.error ?? "gh failed");
      return r.facts;
    }),
  ]);

  const stacksDir = opts.stacksDir;
  const terraform = await attempt("terraform", "Terraform state", async () => {
    if (!stacksDir || !existsSync(stacksDir)) return null;
    return readTerraformState(stacksDir);
  });

  // Provider reads. The keychain serializes them; the HTTP calls overlap.
  const [overview, coolify, hetzner, cloudflare] = await Promise.all([
    attempt("overview", "hatchkit overview", async () => collectOverview()),
    attempt("coolify", "Coolify", readCoolify),
    attempt("hetzner", "Hetzner", readHetzner),
    attempt("cloudflare", "Cloudflare", readCloudflare),
  ]);

  // Joins that need addresses happen here, then the addresses are gone.
  if (coolify && hetzner) {
    for (const s of coolify.facts.servers) {
      const ip = coolify.serverIps.get(s.name);
      const byIp = ip ? hetzner.ips.get(ip) : undefined;
      const byName = hetzner.facts.servers.find((h) => h.name === s.name)?.name;
      s.hetznerName = byIp ?? byName;
    }
  }

  const backups = await attempt("backups", "backup hosts", async () =>
    readBackups(coolify?.serverUuids),
  );
  let hostTimers: HostTimerFacts | undefined;
  if (backups && opts.ssh) {
    log("  reading host timers over tailscale ssh…");
    hostTimers = await readHostTimers(backups.hosts);
    const failed = Object.entries(hostTimers).filter(([, v]) => "error" in v);
    note(
      "host-timers",
      "host timers",
      failed.length ? "error" : "ok",
      failed.length
        ? failed.map(([h, v]) => `${h}: ${(v as { error: string }).error}`).join("; ")
        : undefined,
    );
  } else if (backups) {
    note("host-timers", "host timers", "skip", "--no-ssh");
  }

  const crossReferenceWarnings: Array<{ headline: string; subjects: string[] }> = [];
  for (const k of overview?.crossReferenceKinds ?? []) {
    if (k.severity !== "warn") continue;
    const subjects =
      overview?.crossReferences.filter((c) => c.kind === k.kind).map((c) => c.subject) ?? [];
    if (subjects.length) crossReferenceWarnings.push({ headline: k.headline, subjects });
  }

  return {
    generatedAt: new Date().toISOString(),
    cliVersion: getCliVersion(),
    local: {
      name: tailscale?.self?.hostName ?? hostname().replace(/\.local$/, ""),
      os:
        process.platform === "darwin"
          ? "macOS"
          : process.platform === "linux"
            ? "Linux"
            : process.platform,
    },
    overview: overview
      ? {
          present: overview.providers
            .filter((p) => p.status === "present" || p.status === "empty")
            .map((p) => p.key),
          glitchtipProjects:
            overview.providers.find((p) => p.key === "glitchtip")?.resources?.length ?? 0,
          crossReferenceWarnings,
        }
      : undefined,
    providers,
    coolify: coolify?.facts,
    hetzner: hetzner?.facts,
    terraform,
    cloudflare,
    deployTokens: Object.values(getCloudflareDeployTokenRecords()).map((t) => ({
      worker: t.worker,
      repo: t.repo,
    })),
    backups: backups?.facts,
    hostTimers,
    tailscale,
    launchd,
    ledgers: loadAllLedgers().map((l) => ({
      name: l.name,
      kinds: [...new Set(l.steps.map((s) => (s as { kind?: string }).kind ?? "?"))],
    })),
    repos,
    github,
    macRunner: existsSync(join(homedir(), "Library", "Caches", "hatchkit", "mac-runner")),
    sources,
  };
}
