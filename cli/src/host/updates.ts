/*
 * Update watch — a shared service running a version that a known high or
 * critical advisory covers.
 *
 * Plausible CE v3.0.1 ran on the shared Coolify host four months past a
 * critical RCE fix (GHSA-mhcv-h7gf-57cf) and was taken over on 2026-09-17.
 * Coolify, Traefik, Listmonk and Uptime Kuma were behind too, and Coolify's
 * own nightly auto-update had failed every night for three weeks. Nothing
 * compared the running versions with upstream advisories.
 *
 * One script (templates/update-watch/) reads, on each backup host over
 * Tailscale SSH, the running version of Coolify, Traefik, Plausible CE,
 * Listmonk, Uptime Kuma, GlitchTip and ClickHouse (a floating tag such as
 * traefik:v3.6 is resolved to the release it runs), compares it with the
 * GitHub repository advisories and the latest release, and reads Coolify's
 * upgrade logs. It also compares Cloudflare's published IP ranges with the
 * snapshot the origin firewalls were built from and with each host's
 * HATCHKIT-CF chain: both hosts drop non-Cloudflare traffic on 80/443, so a
 * new Cloudflare edge would be dropped. doctor adds the Hetzner firewalls
 * that restrict 80/443 (read with the Hetzner token). Two ways to run it:
 *
 *  - `hatchkit doctor` and `hatchkit host updates` send the CLI's copy,
 *    with GitHub's answers read here through the local `gh` login (a doctor
 *    run would otherwise spend the host's 60 unauthenticated requests an
 *    hour). One doctor row covers every host.
 *  - `hatchkit host updates install --host <name>` puts it next to the
 *    backup runner with a weekly timer that mails findings through the
 *    backup-alert SMTP, so an advisory is flagged within a week.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BackupHost, backupHost, backupHostExec, backupHosts } from "../backups/provider.js";
import { getHetznerConfig, getProviderPause } from "../config.js";
import { exec } from "../utils/exec.js";

/** A weekly check older than this has missed a run. */
const STALE_DAYS = 8;
const GITHUB = "https://api.github.com";

export interface ServiceSpec {
  key: string;
  name: string;
  images: string[];
  github?: string;
  gitlab?: string;
}

export interface AdvisoryHit {
  id: string;
  severity: "critical" | "high";
  summary: string;
  url: string;
  published: string;
  fixed: string | null;
}

export interface WatchedService {
  service: string;
  name: string;
  version: string;
  versionSource: string;
  /** The tag when it names a line (traefik:v3.6), not the running release. */
  floatingTag?: string | null;
  containers: string[];
  images: string[];
  digests: string[];
  latest: { version: string; publishedAt: string | null } | null;
  /** "github:<repo>", or null when upstream publishes no advisories. */
  advisorySource: string | null;
  advisoriesChecked: number;
  findings: AdvisoryHit[];
  unknown: (Omit<AdvisoryHit, "fixed"> & { range: string })[];
  feedError: string | null;
}

export interface UpdateFinding {
  kind: "advisory" | "auto-update" | "cloudflare-ranges" | "cloudflare-chain";
  service: string;
  name: string;
  summary: string;
  version?: string;
  containers?: string[];
  id?: string;
  severity?: string;
  fixed?: string | null;
  latest?: string | null;
  url?: string;
  etag?: string;
  pinnedEtag?: string;
  added?: string[];
  removed?: string[];
  missing?: string[];
  extra?: string[];
}

/** Cloudflare's live ranges against the pinned snapshot and this host's chain. */
export interface CloudflareState {
  pinnedEtag: string;
  etag: string | null;
  ranges?: number;
  added: string[];
  removed: string[];
  chain: { name: string; families: string[]; missing: string[]; extra: string[] } | null;
  error: string | null;
}

/** Hetzner firewalls that allow 80/443 only from a source list, against Cloudflare's. */
export interface FirewallCheck {
  checked: string[];
  mismatches: { name: string; port: string; missing: string[]; extra: string[] }[];
  error?: string;
}

export interface AutoUpdateState {
  lastRun: string | null;
  log: string;
  ok: boolean;
  running: boolean;
  target: string | null;
  registry: string | null;
  error: string | null;
  failedRuns: number;
  failingSince: string | null;
}

export interface LastCheck {
  checkedAt: string;
  ok: boolean;
  error: string | null;
  services: { service: string; version: string; latest: string | null }[];
  findings: UpdateFinding[];
  skipped: string[];
  mailed: "findings" | "incomplete" | "error" | "recovery" | null;
  mailError?: string;
}

export interface TimerState {
  installed: boolean;
  active?: boolean;
  serviceResult?: string | null;
  nextRun?: string | null;
  lastCheck: LastCheck | null;
}

export interface UpdateReport {
  host: string;
  scannedAt: string;
  services: WatchedService[];
  findings: UpdateFinding[];
  autoUpdate: AutoUpdateState | null;
  cloudflare: CloudflareState | null;
  /** Checks that could not be made: a feed that failed, a version that no
   *  label, tag or binary names, an advisory range nobody can read. */
  skipped: string[];
  notes: string[];
  timer: TimerState;
}

/** One host's scan, or why it could not run. */
export interface HostScan {
  host: BackupHost;
  report?: UpdateReport;
  error?: string;
}

/** The doctor row shape (doctor.ts keeps its own interface private). */
export interface UpdateRow {
  name: string;
  status: "ok" | "fail" | "warn";
  detail?: string;
  hint?: string[];
}

function template(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../templates/update-watch/${name}`, import.meta.url)),
    "utf8",
  );
}

export function watchedServices(): ServiceSpec[] {
  return JSON.parse(template("update-watch-services.json")) as ServiceSpec[];
}

/** The Cloudflare ranges the origin firewalls were built from. */
export function pinnedCloudflare(): { etag: string; ipv4: string[]; ipv6: string[] } {
  return JSON.parse(template("update-watch-cloudflare.json"));
}

function lastJson(stdout: string): unknown {
  return JSON.parse(stdout.trim().split("\n").pop() ?? "");
}

// The URLs the host script asks for (advisories_url, latest_url): a
// prefetched answer is used only under the exact same key.
export const advisoriesUrl = (repo: string) =>
  `${GITHUB}/repos/${repo}/security-advisories?per_page=100&state=published`;
export const latestUrl = (repo: string) => `${GITHUB}/repos/${repo}/releases/latest`;

interface Advisory {
  ghsa_id: string;
  severity: string;
  summary: string;
  html_url: string;
  published_at: string;
  withdrawn_at: string | null;
  vulnerabilities:
    | {
        package?: { ecosystem?: string | null; name?: string | null } | null;
        vulnerable_version_range?: string | null;
        patched_versions?: string | null;
      }[]
    | null;
}

/** The fields the matcher reads; the rest (descriptions, credits) stays here. */
function trimAdvisory(a: Advisory) {
  return {
    ghsa_id: a.ghsa_id,
    severity: a.severity,
    summary: a.summary,
    html_url: a.html_url,
    published_at: a.published_at,
    withdrawn_at: a.withdrawn_at,
    vulnerabilities: (a.vulnerabilities ?? []).map((v) => ({
      package: { ecosystem: v.package?.ecosystem ?? null, name: v.package?.name ?? null },
      vulnerable_version_range: v.vulnerable_version_range ?? null,
      patched_versions: v.patched_versions ?? null,
    })),
  };
}

async function ghJson(url: string, paginate: boolean): Promise<unknown> {
  const path = url.slice(GITHUB.length);
  const r = await exec("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), path], {
    silent: true,
  });
  if (r.exitCode !== 0) return null;
  try {
    const data = JSON.parse(r.stdout) as unknown;
    return paginate && Array.isArray(data) ? data.flat() : data;
  } catch {
    return null;
  }
}

/**
 * GitHub's answers for every watched service, read through the local `gh`
 * login. A URL that fails here (no gh, no login, a GitHub error) is left
 * out, and the host reads it itself.
 */
export async function prefetchFeeds(specs = watchedServices()): Promise<Record<string, unknown>> {
  const feeds: Record<string, unknown> = {};
  await Promise.all(
    specs.flatMap((s) =>
      s.github
        ? [
            ghJson(advisoriesUrl(s.github), true).then((data) => {
              if (Array.isArray(data))
                feeds[advisoriesUrl(s.github!)] = (data as Advisory[]).map(trimAdvisory);
            }),
            ghJson(latestUrl(s.github), false).then((data) => {
              const release = data as { tag_name?: string; published_at?: string } | null;
              if (release?.tag_name)
                feeds[latestUrl(s.github!)] = {
                  tag_name: release.tag_name,
                  published_at: release.published_at ?? null,
                };
            }),
          ]
        : [],
    ),
  );
  return feeds;
}

// `python3 -c` with the script, the services and the feeds as JSON on stdin.
// No single quote: the remote shell sees it inside one.
const BOOT =
  'import json,sys;p=json.load(sys.stdin);sys.argv=["update-watch.py"]+sys.argv[1:];exec(compile(p["script"],"update-watch.py","exec"),{"__name__":"__main__","PAYLOAD":p})';

/** Read-only: run the CLI's copy of the script on one host. */
export async function fetchUpdateReport(
  host: BackupHost,
  feeds: Record<string, unknown> = {},
): Promise<UpdateReport> {
  const payload = JSON.stringify({
    script: template("update-watch.py"),
    services: watchedServices(),
    cloudflare: pinnedCloudflare(),
    feeds,
  });
  return lastJson(
    await backupHostExec(host, `python3 -c '${BOOT}' scan`, payload, 180_000),
  ) as UpdateReport;
}

const covers = (port: string | null | undefined, wanted: number) => {
  const [low, high = low] = String(port ?? "")
    .split("-")
    .map(Number);
  return low <= wanted && wanted <= high;
};

/** Cloudflare's live list, from any host that read it: pinned + added - removed. */
export function liveCloudflare(scans: HostScan[]): string[] | null {
  const state = scans.find((s) => s.report?.cloudflare?.etag)?.report?.cloudflare;
  if (!state) return null;
  const pinned = pinnedCloudflare();
  const removed = new Set(state.removed);
  return [...pinned.ipv4, ...pinned.ipv6, ...state.added].filter((c) => !removed.has(c));
}

/**
 * Every Hetzner firewall rule that allows TCP 80 or 443 from a source list
 * (not from anywhere), against Cloudflare's live ranges. shared-vps filters
 * there, not in iptables, so the host cannot see it. null when Hetzner is
 * not configured or paused.
 */
export async function compareHetznerFirewalls(
  live: string[] | null,
): Promise<FirewallCheck | null> {
  if (getProviderPause("hetzner")) return null;
  let token: string;
  try {
    const cfg = await getHetznerConfig();
    if (!cfg) return null;
    token = cfg.token;
  } catch (err) {
    return {
      checked: [],
      mismatches: [],
      // The keychain's refusal is three sentences; the first names the cause.
      error: `couldn't read the Hetzner token: ${(err as Error).message.split("\n")[0].replace(/(\.)\s.*$/, "$1")}`,
    };
  }
  if (!live) return { checked: [], mismatches: [], error: "Cloudflare's ranges could not be read" };
  let body: {
    firewalls?: {
      name: string;
      rules?: {
        direction: string;
        protocol: string;
        port?: string | null;
        source_ips?: string[];
      }[];
    }[];
  };
  try {
    const res = await fetch("https://api.hetzner.cloud/v1/firewalls?per_page=50", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { checked: [], mismatches: [], error: `Hetzner API HTTP ${res.status}` };
    body = (await res.json()) as typeof body;
  } catch (err) {
    return { checked: [], mismatches: [], error: `Hetzner API: ${(err as Error).message}` };
  }
  const want = new Set(live.map((c) => c.toLowerCase()));
  const check: FirewallCheck = { checked: [], mismatches: [] };
  for (const fw of body.firewalls ?? []) {
    for (const rule of fw.rules ?? []) {
      if (rule.direction !== "in" || rule.protocol !== "tcp") continue;
      const port = [80, 443].filter((p) => covers(rule.port, p)).join(",");
      const sources = (rule.source_ips ?? []).map((c) => c.toLowerCase());
      if (!port || sources.includes("0.0.0.0/0") || sources.includes("::/0")) continue;
      if (!check.checked.includes(fw.name)) check.checked.push(fw.name);
      const have = new Set(sources);
      const missing = [...want].filter((c) => !have.has(c)).sort();
      const extra = [...have].filter((c) => !want.has(c)).sort();
      if (missing.length || extra.length)
        check.mismatches.push({ name: fw.name, port: rule.port ?? port, missing, extra });
    }
  }
  return check;
}

/** Every backup host, scanned in parallel; one host's failure is its own. */
export async function scanHosts(hosts: BackupHost[]): Promise<HostScan[]> {
  const feeds = await prefetchFeeds();
  return Promise.all(
    hosts.map(async (host) => {
      try {
        return { host, report: await fetchUpdateReport(host, feeds) };
      } catch (err) {
        return { host, error: (err as Error).message.split("\n")[0] };
      }
    }),
  );
}

function days(since: string, now: Date): number {
  return (now.getTime() - new Date(since).getTime()) / 86_400_000;
}

/** The weekly timer on one host: null when healthy, else what is wrong. */
function timerProblem(
  scan: HostScan & { report: UpdateReport },
  now: Date,
): { status: "warn" | "fail"; line: string; hint: string[] } | null {
  const { host, report } = scan;
  const { timer } = report;
  const ssh = `tailscale ssh ${host.target}`;
  const logs = `Logs: ${ssh} journalctl -u hatchkit-update-watch.service -n 50`;
  const preview = `Preview (reads only): hatchkit host updates install --host ${host.name} --dry-run`;
  if (!timer.installed)
    return {
      status: "warn",
      line: `weekly check not installed on ${host.name}`,
      hint: [
        preview,
        `Install (writes the script and a timer to the host): hatchkit host updates install --host ${host.name}`,
      ],
    };
  if (!timer.active)
    return {
      status: "fail",
      line: `weekly check on ${host.name} is installed, but its timer is not active`,
      hint: [`Start it: ${ssh} systemctl enable --now hatchkit-update-watch.timer`],
    };
  if (timer.serviceResult && timer.serviceResult !== "success")
    return {
      status: "fail",
      line: `weekly check on ${host.name}: last run ended with systemd result "${timer.serviceResult}"`,
      hint: [logs],
    };
  const last = timer.lastCheck;
  if (!last) return null;
  const age = days(last.checkedAt, now);
  if (age > STALE_DAYS)
    return {
      status: "fail",
      line: `weekly check on ${host.name}: last run ${last.checkedAt}, ${Math.round(age)} days ago`,
      hint: [logs, `Run one now: ${ssh} systemctl start --no-block hatchkit-update-watch.service`],
    };
  if (last.mailError)
    return {
      status: "fail",
      line: `weekly check on ${host.name} could not mail its result: ${last.mailError}`,
      hint: [
        `Test the mail path: hatchkit host updates test --host ${host.name}`,
        "Re-send the SMTP settings: hatchkit backup alerts --to <email> --from <verified-ses-email>",
        logs,
      ],
    };
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Pure: the one doctor row for every host's scan. */
export function updateRow(
  scans: HostScan[],
  now = new Date(),
  firewalls: FirewallCheck | null = null,
): UpdateRow {
  const name = "Shared service updates";
  const several = scans.length > 1;
  const on = (host: BackupHost) => (several ? ` on ${host.name}` : "");
  const failures: string[] = [];
  const warnings: string[] = [];
  const hints: string[] = [];
  const clean: string[] = [];
  const behind: string[] = [];
  let status: UpdateRow["status"] = "ok";
  const raise = (to: "warn" | "fail") => {
    if (to === "fail" || status === "ok") status = to;
  };
  for (const scan of scans) {
    if (!scan.report) {
      raise("warn");
      warnings.push(`couldn't scan ${scan.host.name}: ${scan.error}`);
      hints.push(`Retry one host: hatchkit host updates --host ${scan.host.name} --json`);
      continue;
    }
    const { host, report } = scan;
    const fine: string[] = [];
    for (const svc of report.services) {
      const label = `${svc.name} ${svc.version}`;
      if (svc.latest && svc.latest.version.replace(/-.*/, "") !== svc.version.replace(/-.*/, ""))
        behind.push(`${label}${on(host)} (latest ${svc.latest.version})`);
      if (!svc.findings.length) {
        fine.push(label);
        continue;
      }
      raise("fail");
      const worst = svc.findings.some((f) => f.severity === "critical") ? "critical" : "high";
      const fixes = svc.findings.map((f) => f.fixed).filter((f): f is string => !!f);
      const highest = fixes.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).pop();
      failures.push(
        `${label}${on(host)}: ${plural(svc.findings.length, "advisory", "advisories")} (${worst})`,
      );
      hints.push(
        `${label}${on(host)} (${svc.containers.join(", ")}): ${svc.findings
          .map((f) => `${f.id} ${f.severity}${f.fixed ? ` fixed in ${f.fixed}` : " no fix yet"}`)
          .join(
            "; ",
          )}. Upgrade to ${highest ?? "a fixed release"} or the latest ${svc.latest?.version ?? "release"}.`,
      );
    }
    if (fine.length) clean.push(several ? `${host.name}: ${fine.join(", ")}` : fine.join(", "));
    const auto = report.findings.find((f) => f.kind === "auto-update");
    if (auto) {
      raise("fail");
      failures.push(`Coolify auto-update failing${on(host)}`);
      hints.push(auto.summary);
      if (/toomanyrequests/.test(auto.summary))
        hints.push(
          "GHCR rate-limits anonymous pulls: keep REGISTRY_URL=docker.io in /data/coolify/source/.env (upgrade.sh merges .env.production into .env on each run), or docker login ghcr.io on the host with a read-only token.",
        );
      hints.push(
        `Newest log: tailscale ssh ${host.target} 'tail -5 "$(ls -t /data/coolify/source/upgrade-*.log | head -1)"'`,
      );
    }
    const ranges = report.findings.find((f) => f.kind === "cloudflare-ranges");
    if (ranges && !failures.some((f) => f.startsWith("Cloudflare IP ranges changed"))) {
      raise("fail");
      failures.push(`Cloudflare IP ranges changed (etag ${ranges.etag})`);
      hints.push(
        ranges.summary,
        "Origins drop every non-Cloudflare source on 80/443: allow the new list in chain HATCHKIT-CF (iptables and ip6tables, persisted) on each host that has it, in http_source_ips of each Hetzner firewall stack (terraform plan, then apply), then pin it in cli/src/templates/update-watch/update-watch-cloudflare.json. Source: https://api.cloudflare.com/client/v4/ips",
      );
    }
    const chain = report.findings.find((f) => f.kind === "cloudflare-chain");
    if (chain) {
      raise("fail");
      failures.push(
        `chain HATCHKIT-CF${on(host) || " on the host"} does not match Cloudflare's ranges`,
      );
      hints.push(`${chain.summary} Rules: tailscale ssh ${host.target} iptables -S HATCHKIT-CF`);
    }
    if (report.skipped.length) {
      raise("warn");
      warnings.push(`${plural(report.skipped.length, "check")} not made${on(host)}`);
      hints.push(...report.skipped.map((s) => `Not checked${on(host)}: ${s}`));
    }
    const timer = timerProblem({ host, report }, now);
    if (timer) {
      raise(timer.status);
      (timer.status === "fail" ? failures : warnings).push(timer.line);
      hints.push(...timer.hint);
    }
  }
  if (firewalls?.error) {
    raise("warn");
    warnings.push(`Hetzner firewalls not compared with Cloudflare's ranges: ${firewalls.error}`);
    if (/keychain/i.test(firewalls.error))
      hints.push(
        "Run hatchkit doctor in a terminal, or with HATCHKIT_KEYCHAIN_ACCESS=allow when reading the Hetzner token is intended.",
      );
  }
  for (const m of firewalls?.mismatches ?? []) {
    raise("fail");
    failures.push(`Hetzner firewall ${m.name} (port ${m.port}) does not match Cloudflare's ranges`);
    hints.push(
      `Hetzner firewall ${m.name}, port ${m.port}: missing ${m.missing.join(", ") || "none"} (dropped); not Cloudflare's ${m.extra.join(", ") || "none"}. Fix http_source_ips in that stack's tfvars, read the terraform plan, then apply.`,
    );
  }
  const verdict = failures.length
    ? failures
    : clean.length
      ? [`no high/critical advisory covers ${clean.join("; ")}`]
      : scans.some((s) => s.report)
        ? ["no watched service is running"]
        : [];
  const lastRuns = scans
    .map(({ host, report }) => {
      const last = report?.timer.lastCheck;
      return last ? `${several ? `${host.name} ` : ""}${last.checkedAt.slice(0, 10)}` : null;
    })
    .filter(Boolean);
  const info = [
    ...(behind.length && !failures.length
      ? [`behind the latest release: ${behind.join(", ")}`]
      : []),
    ...(lastRuns.length && status === "ok" ? [`weekly check last ran ${lastRuns.join(", ")}`] : []),
  ];
  const cloudflare = scans.find((s) => s.report?.cloudflare?.etag)?.report?.cloudflare;
  if (cloudflare && !failures.length) {
    const enforced = [
      ...scans
        .filter((s) => s.report?.cloudflare?.chain)
        .map((s) => `HATCHKIT-CF${several ? ` on ${s.host.name}` : ""}`),
      ...(firewalls?.checked ?? []).map((name) => `Hetzner firewall ${name}`),
    ];
    info.unshift(
      `Cloudflare ranges unchanged (etag ${(cloudflare.etag ?? "").slice(0, 8)})${enforced.length ? `, matched by ${enforced.join(", ")}` : ""}`,
    );
  }
  return {
    name,
    status,
    detail: [...verdict, ...warnings, ...info].join("; "),
    ...(status === "ok" ? {} : { hint: [...hints, "Re-check: hatchkit host updates --json"] }),
  };
}

/** doctor: [] when no backup host is configured; never throws. */
export async function checkUpdateWatch(): Promise<UpdateRow[]> {
  let hosts: BackupHost[];
  try {
    hosts = backupHosts();
  } catch {
    return [];
  }
  try {
    const scans = await scanHosts(hosts);
    return [updateRow(scans, new Date(), await compareHetznerFirewalls(liveCloudflare(scans)))];
  } catch (err) {
    return [
      {
        name: "Shared service updates",
        status: "warn",
        detail: `couldn't check: ${(err as Error).message.split("\n")[0]}`,
        hint: ["Retry: hatchkit host updates --json"],
      },
    ];
  }
}

const FILES = [
  "update-watch.py",
  "update-watch-services.json",
  "update-watch-cloudflare.json",
  "hatchkit-update-watch.service",
  "hatchkit-update-watch.timer",
  "hatchkit-update-watch-failed.service",
];

// Runs as root on the host, files on stdin over Tailscale SSH. It checks the
// prerequisites and every file name, then runs the new script once
// (read-only), all before it writes: a host it cannot scan gets no timer.
const INSTALL = `import json,os,pathlib,subprocess,sys
os.umask(0o077)
written=[]
def fail(message):
 print(json.dumps({'ok':False,'error':message,'written':written}));sys.exit(1)
payload=json.load(sys.stdin)
opt=pathlib.Path('/opt/hatchkit-backups')
units=pathlib.Path('/etc/systemd/system')
names=('update-watch.py','update-watch-services.json','update-watch-cloudflare.json','hatchkit-update-watch.service','hatchkit-update-watch.timer','hatchkit-update-watch-failed.service')
if sorted(payload['files'])!=sorted(names):
 fail('unexpected installer files')
if not (opt/'alerts.py').exists():
 fail('the backup runner is not installed; run hatchkit backup install first')
try:
 config=json.loads(pathlib.Path('/etc/hatchkit-backups/config.json').read_text())
except (OSError,ValueError):
 fail('/etc/hatchkit-backups/config.json is missing; run hatchkit backup install first')
alerts=config.get('alerts') or {}
if not alerts.get('enabled') or not alerts.get('to') or not pathlib.Path(alerts.get('smtpFile','/nonexistent')).exists():
 fail('backup alert mail is not configured; run hatchkit backup alerts --to <email> --from <verified-ses-email> first')
probe=subprocess.run(['python3','-c',payload['boot'],'scan'],input=json.dumps({'script':payload['files']['update-watch.py'],'services':json.loads(payload['files']['update-watch-services.json']),'cloudflare':json.loads(payload['files']['update-watch-cloudflare.json']),'feeds':payload.get('feeds') or {}}),capture_output=True,text=True,timeout=300)
try:
 report=json.loads(probe.stdout.strip().splitlines()[-1])
except (IndexError,ValueError):
 report={}
if probe.returncode!=0 or 'findings' not in report:
 fail('the first scan failed ('+str(report.get('error') or 'no report')+'); nothing was installed')
targets={name:(opt if name.startswith('update-watch') else units)/name for name in names}
result={'host':report['host'],'mailTo':alerts['to'],'alreadyInstalled':targets['hatchkit-update-watch.timer'].exists(),
 'services':[s['name']+' '+s['version'] for s in report['services']],
 'findingsNow':[f['summary'] for f in report['findings']],'skippedNow':report.get('skipped',[]),'files':[str(t) for t in targets.values()]}
if payload['dryRun']:
 print(json.dumps(dict(result,applied=False)));sys.exit(0)
for name,target in targets.items():
 temp=target.with_name(target.name+'.tmp')
 temp.write_text(payload['files'][name])
 temp.chmod(0o700 if name.endswith('.py') else 0o600 if name.endswith('.json') else 0o644)
 temp.replace(target)
 written.append(str(target))
try:
 subprocess.run(['systemctl','daemon-reload'],check=True,capture_output=True)
 subprocess.run(['systemctl','enable','--now','hatchkit-update-watch.timer'],check=True,capture_output=True)
except subprocess.CalledProcessError as error:
 fail('systemctl '+error.cmd[1]+' failed; the files are in place, the timer may not be active. Undo: hatchkit host updates uninstall')
next_run=subprocess.run(['systemctl','show','hatchkit-update-watch.timer','--property=NextElapseUSecRealtime','--value'],capture_output=True,text=True).stdout.strip()
print(json.dumps(dict(result,applied=True,timerEnabled=True,nextRun=next_run or None)))
`;

const UNINSTALL = `import json,pathlib,subprocess,sys
dry=sys.argv[1]=='dry'
paths=['/etc/systemd/system/hatchkit-update-watch.timer','/etc/systemd/system/hatchkit-update-watch.service','/etc/systemd/system/hatchkit-update-watch-failed.service','/opt/hatchkit-backups/update-watch.py','/opt/hatchkit-backups/update-watch-services.json','/opt/hatchkit-backups/update-watch-cloudflare.json']
present=[p for p in paths if pathlib.Path(p).exists()]
kept=[p for p in ('/var/lib/hatchkit-backups/update-watch-status.json',) if pathlib.Path(p).exists()]
if not dry:
 for unit in ('hatchkit-update-watch.timer','hatchkit-update-watch.service'):
  subprocess.run(['systemctl','disable','--now',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 for p in present:
  pathlib.Path(p).unlink()
 subprocess.run(['systemctl','daemon-reload'],check=True)
print(json.dumps({'applied':not dry,'removed':present,'kept':kept}))
`;

function hostPython(
  host: BackupHost,
  script: string,
  arg: string,
  input?: string,
  timeoutMs?: number,
) {
  const encoded = Buffer.from(script).toString("base64");
  return backupHostExec(
    host,
    `python3 -c 'import base64,sys;sys.argv=["hatchkit"${arg ? `,"${arg}"` : ""}];exec(base64.b64decode("${encoded}"))'`,
    input,
    timeoutMs,
  );
}

export async function installUpdateWatch(host: BackupHost, dryRun: boolean) {
  const files = Object.fromEntries(FILES.map((name) => [name, template(name)]));
  const feeds = await prefetchFeeds();
  const result = lastJson(
    await hostPython(
      host,
      INSTALL,
      "",
      JSON.stringify({ dryRun, boot: BOOT, files, feeds }),
      360_000,
    ),
  ) as Record<string, unknown>;
  return {
    backupHost: host.name,
    ...result,
    schedule: "weekly, Monday 06:00 UTC (+ up to 30 min)",
    mail: "through the backup-alert SMTP; findings and checks it could not make every run, one all-clear after they clear",
    nextSteps: dryRun
      ? [`Install: hatchkit host updates install --host ${host.name}`]
      : [
          `Send a test mail: hatchkit host updates test --host ${host.name}`,
          "Check from here any time: hatchkit doctor",
        ],
    rollback: `hatchkit host updates uninstall --host ${host.name} (keeps the last status)`,
  };
}

export async function uninstallUpdateWatch(host: BackupHost, dryRun: boolean) {
  return lastJson(await hostPython(host, UNINSTALL, dryRun ? "dry" : "apply"));
}

export async function sendUpdateWatchTest(host: BackupHost) {
  return lastJson(await backupHostExec(host, "python3 /opt/hatchkit-backups/update-watch.py test"));
}

export const UPDATES_USAGE = `Usage:
  hatchkit host updates [--host <name>] [--json]
  hatchkit host updates install --host <name> [--dry-run]
  hatchkit host updates uninstall --host <name> [--dry-run]
  hatchkit host updates test --host <name>

updates reads, on every backup host (or the one --host names) over Tailscale
SSH, the running version of Coolify, Traefik, Plausible CE, Listmonk, Uptime
Kuma, GlitchTip and ClickHouse, and changes nothing. A floating tag such as
traefik:v3.6 is resolved from the image label or the binary. It reports:
  - every high or critical GitHub security advisory whose vulnerable range
    covers the running version, with its fixed version and the latest release
    (GlitchTip publishes no advisories; it is compared with its latest tag)
  - Coolify's auto-update failing (the newest /data/coolify/source/upgrade-*.log
    ends in an error)
  - Cloudflare's IP ranges (api.cloudflare.com/client/v4/ips) differing from
    the pinned snapshot the origin firewalls were built from, from the host's
    HATCHKIT-CF chain, or from a Hetzner firewall that allows 80/443 only from
    a source list (read with the Hetzner token): new edges would be dropped
  - anything it could not check (a feed error, a version nothing names)
GitHub is read here through gh; what fails here the host reads itself. Exits 1
on a finding. hatchkit doctor shows the same as one row.

install puts the script next to the backup runner (/opt/hatchkit-backups) with
a weekly timer (Monday 06:00 UTC) that mails findings through the backup-alert
SMTP (hatchkit backup alerts), so a new advisory is flagged within a week. It
refuses a host without the backup runner or its alert mail, and runs one
read-only scan before it writes. --dry-run runs only that scan and prints what
the first mail would list. uninstall removes the script and the timer.
test sends a test mail through the installed script.
`;

/** The host script escapes these already; a terminal is not the place to trust that. */
const printable = (text: string) =>
  Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : c;
  }).join("");

function printRow(row: UpdateRow, scans: HostScan[]) {
  const icon = row.status === "ok" ? "✓" : row.status === "warn" ? "!" : "✗";
  console.log(printable(`  ${icon} ${row.name}${row.detail ? ` — ${row.detail}` : ""}`));
  for (const { host, report } of scans)
    for (const s of report?.services ?? [])
      console.log(
        printable(
          `      · ${host.name}  ${s.name} ${s.version}${s.floatingTag ? ` (tag ${s.floatingTag})` : ""}, latest ${s.latest?.version ?? "unknown"}, ${s.findings.length} high/critical`,
        ),
      );
  if (row.status !== "ok")
    for (const line of row.hint ?? []) console.log(printable(`      → ${line}`));
}

export async function runUpdatesCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--json" && a !== "--dry-run");
  const action = rest[0] && !rest[0].startsWith("--") ? rest.shift() : "scan";
  if (dryRun && action !== "install" && action !== "uninstall")
    throw new Error("--dry-run applies to host updates install and uninstall.");
  let name: string | undefined;
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--host" && name === undefined && rest.length && !rest[0].startsWith("--"))
      name = rest.shift();
    else throw new Error(`Unknown or incomplete host updates option: ${flag}\n\n${UPDATES_USAGE}`);
  }
  if (action === "scan") {
    const scans = await scanHosts(name ? [backupHost(name)] : backupHosts());
    const firewalls = await compareHetznerFirewalls(liveCloudflare(scans));
    if (json)
      console.log(
        JSON.stringify(
          {
            hosts: scans.map(({ host, report, error }) => ({
              backupHost: host.name,
              ...(report ?? { error }),
            })),
            hetznerFirewalls: firewalls,
          },
          null,
          2,
        ),
      );
    else printRow(updateRow(scans, new Date(), firewalls), scans);
    if (scans.some((s) => s.report?.findings.length) || firewalls?.mismatches.length)
      process.exitCode = 1;
    return;
  }
  if (action !== "install" && action !== "uninstall" && action !== "test")
    throw new Error(UPDATES_USAGE);
  // A write names its host: several hosts and no --host is refused.
  const host = backupHost(name);
  let result: unknown;
  if (action === "install") result = await installUpdateWatch(host, dryRun);
  else if (action === "uninstall") result = await uninstallUpdateWatch(host, dryRun);
  else result = await sendUpdateWatchTest(host);
  console.log(JSON.stringify(result, null, 2));
}
