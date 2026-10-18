/*
 * Host integrity — read-only signs that a container on the Coolify host
 * has been taken over.
 *
 * On 2026-10-18 a cryptominer (`linuxsys`, XMRig) was found by accident in
 * the Plausible container on the shared host. It came in through Plausible
 * CE v3.0.1's unauthenticated /storybook RCE a month earlier, ran at
 * 80–95 % of one core for four days, and nothing alerted: Uptime Kuma
 * checks HTTP only. The five detectors in the host script would each have
 * named it (a deleted binary, a process Plausible's image does not run, a
 * file in /tmp, the CPU, and its pool connection).
 *
 * Two ways to run them, one script (templates/host-integrity/):
 *
 *  - `hatchkit doctor` and `hatchkit host integrity` send the CLI's own
 *    copy over Tailscale SSH stdin and print what it finds. The CPU check
 *    there samples a few seconds, so it only warns; the hour-long figure
 *    comes from the daily check's last result.
 *  - `hatchkit host integrity install` puts it next to the backup runner
 *    with a daily timer that averages CPU over one hour and mails findings
 *    through the backup-alert SMTP (`hatchkit backup alerts`).
 *
 * The script never prints environment values, command lines or file
 * contents. Exceptions go in /etc/hatchkit-backups/host-integrity.json on
 * the host; every finding carries the exact entry that would allow it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BackupHost, backupHost, backupHostExec, backupHosts } from "../backups/provider.js";

export const SITE_FILE = "/etc/hatchkit-backups/host-integrity.json";
const MAX_WINDOW = 3600;
/** A daily check older than this has missed a run. */
const STALE_HOURS = 36;
/** A live CPU sample shorter than this only warns: a build or a deploy
 *  can hold a core for a minute. */
const CONFIDENT_WINDOW = 3000;

export type Detector =
  | "deleted-binary"
  | "unexpected-process"
  | "temp-file"
  | "cpu"
  | "outbound-peer";

export interface IntegrityFinding {
  detector: Detector;
  container: string | null;
  image: string | null;
  summary: string;
  pid?: number | null;
  pids?: number[];
  process?: string | null;
  exe?: string;
  path?: string;
  peer?: string;
  percent?: number;
  windowSeconds?: number;
  /** The site-file entry that would allow this finding. */
  allow?: Record<string, unknown>;
  /** Set on the one finding that names everything past the per-container list. */
  overflow?: number;
}

export interface LastCheck {
  checkedAt: string;
  ok: boolean;
  error: string | null;
  containers: number | null;
  cpuWindowSeconds: number | null;
  findings: IntegrityFinding[];
  mailed: "findings" | "error" | "recovery" | null;
  mailError?: string;
  skipped?: string[];
}

export interface TimerState {
  installed: boolean;
  active?: boolean;
  serviceResult?: string | null;
  nextRun?: string | null;
  lastCheck: LastCheck | null;
}

export interface IntegrityReport {
  host: string;
  scannedAt: string;
  cpuWindowSeconds: number;
  cpuLimit: number;
  containers: number;
  processes: number;
  outboundConnections: number;
  networkNamespaces: number;
  cpuTop: { container: string; percent: number }[];
  peerSamples: number;
  findings: IntegrityFinding[];
  /** Checks that could not run this time (a docker diff failed, a container
   *  restarted inside the CPU window, host networking). */
  skipped: string[];
  notes: string[];
  siteFile: string | null;
  timer: TimerState;
}

/** The doctor row shape (doctor.ts keeps its own interface private). */
export interface IntegrityRow {
  name: string;
  status: "ok" | "fail" | "warn";
  detail?: string;
  hint?: string[];
}

function template(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../templates/host-integrity/${name}`, import.meta.url)),
    "utf8",
  );
}

function lastJson(stdout: string): unknown {
  return JSON.parse(stdout.trim().split("\n").pop() ?? "");
}

export function parseWindow(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_WINDOW)
    throw new Error(`--cpu-window takes whole seconds from 0 to ${MAX_WINDOW}.`);
  return seconds;
}

/** Read-only: run the CLI's copy of the script on the backup host. */
export async function fetchIntegrityReport(
  cpuWindow = 10,
  host: BackupHost = backupHost(),
): Promise<IntegrityReport> {
  parseWindow(String(cpuWindow), 10);
  return lastJson(
    await backupHostExec(
      host,
      `python3 - scan --cpu-window ${cpuWindow}`,
      template("host-integrity.py"),
      (cpuWindow + 150) * 1000,
    ),
  ) as IntegrityReport;
}

const DETECTORS: {
  detector: Exclude<Detector, "cpu">;
  name: string;
  count: (n: number) => string;
  next: (f: IntegrityFinding, ssh: string) => string[];
}[] = [
  {
    detector: "deleted-binary",
    name: "deleted binaries",
    count: (n) => `${n} process(es) run a binary that was deleted from disk`,
    next: (f, ssh) =>
      f.pid
        ? [
            `Save the binary first (the running process keeps it readable): ${ssh} 'mkdir -p /root/incident && cp /proc/${f.pid}/exe /root/incident/${f.container ?? "host"}-${f.pid}.bin'`,
          ]
        : [],
  },
  {
    detector: "unexpected-process",
    name: "unexpected processes",
    count: (n) => `${n} process name(s) that the container's image does not explain`,
    next: (f, ssh) =>
      f.container
        ? [
            `See the container's processes: ${ssh} docker top ${f.container} -eo pid,ppid,etime,comm`,
          ]
        : [],
  },
  {
    detector: "temp-file",
    name: "temp-dir files",
    count: (n) => `${n} new file(s) or binaries in /tmp, /var/tmp or /dev/shm`,
    next: (f, ssh) =>
      f.container ? [`List the writable layer: ${ssh} docker diff ${f.container}`] : [],
  },
  {
    detector: "outbound-peer",
    name: "outbound peers",
    count: (n) => `${n} outbound connection(s) outside private ranges and Cloudflare`,
    next: (f, ssh) =>
      f.pid ? [`See the container's sockets: ${ssh} nsenter -t ${f.pid} -n ss -tnp`] : [],
  },
];

/** One `allow` object for several findings: lists concatenated, maps merged. */
export function mergeAllow(findings: IntegrityFinding[]): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {};
  for (const finding of findings) {
    for (const [key, value] of Object.entries(finding.allow ?? {})) {
      if (Array.isArray(value)) {
        const list = (merged[key] as unknown[] | undefined) ?? [];
        merged[key] = [...new Set([...list, ...value])];
      } else if (value && typeof value === "object") {
        const map = (merged[key] as Record<string, unknown> | undefined) ?? {};
        for (const [glob, entry] of Object.entries(value)) {
          map[glob] =
            Array.isArray(entry) && Array.isArray(map[glob])
              ? [...new Set([...(map[glob] as unknown[]), ...entry])]
              : entry;
        }
        merged[key] = map;
      }
    }
  }
  return Object.keys(merged).length ? merged : null;
}

function allowHint(findings: IntegrityFinding[]): string[] {
  const allow = mergeAllow(findings);
  return allow
    ? [
        `Only once you know what causes it, merge into ${SITE_FILE} on the host (root-only JSON): ${JSON.stringify(allow)}${
          allow.peers
            ? " (peers apply to every container; peerContainers skips one container instead)"
            : ""
        }`,
      ]
    : [];
}

function hours(since: string, now: Date): number {
  return (now.getTime() - new Date(since).getTime()) / 3_600_000;
}

function timerRow(report: IntegrityReport, ssh: string, now: Date): IntegrityRow {
  const name = "Host integrity daily check";
  const { timer } = report;
  const install = [
    "Preview (reads only): hatchkit host integrity install --dry-run",
    "Install (writes the script and a timer to the host): hatchkit host integrity install",
  ];
  if (!timer.installed)
    return {
      name,
      status: "warn",
      detail: "not installed; nothing on the host mails these findings",
      hint: [
        ...install,
        "Needs the backup runner and its alert mail first: hatchkit backup install, then hatchkit backup alerts --to <email> --from <verified-ses-email>",
      ],
    };
  if (!timer.active)
    return {
      name,
      status: "fail",
      detail: "installed, but its timer is not active",
      hint: [`Start it: ${ssh} systemctl enable --now hatchkit-host-integrity.timer`, ...install],
    };
  const last = timer.lastCheck;
  const logs = `Logs: ${ssh} journalctl -u hatchkit-host-integrity.service -n 50`;
  // A run systemd stopped (timeout, memory limit) writes no status.
  if (timer.serviceResult && timer.serviceResult !== "success")
    return {
      name,
      status: "fail",
      detail: `the last run ended with systemd result "${timer.serviceResult}"`,
      hint: [logs],
    };
  if (!last)
    return {
      name,
      status: "ok",
      detail: `installed; first run ${timer.nextRun ?? "at the next 05:00 UTC"}`,
    };
  const age = hours(last.checkedAt, now);
  if (age > STALE_HOURS)
    return {
      name,
      status: "fail",
      detail: `last run ${last.checkedAt}, ${Math.round(age)} h ago`,
      hint: [
        logs,
        `Run one now (takes an hour): ${ssh} systemctl start --no-block hatchkit-host-integrity.service`,
      ],
    };
  if (last.error)
    return {
      name,
      status: "fail",
      detail: `last run could not finish: ${last.error}`,
      hint: [logs],
    };
  if (last.mailError)
    return {
      name,
      status: "fail",
      detail: `last run found ${last.findings.length} finding(s) but could not mail them: ${last.mailError}`,
      hint: [
        "Test the mail path: hatchkit host integrity test",
        "Re-send the SMTP settings: hatchkit backup alerts --to <email> --from <verified-ses-email>",
        logs,
      ],
    };
  const found = last.findings.length;
  return {
    name,
    status: "ok",
    detail: `last run ${last.checkedAt}: ${found ? `${found} finding(s), mailed` : "clean"}; next ${timer.nextRun ?? "unknown"}`,
  };
}

/** Pure: the doctor rows for one report. */
export function integrityRows(
  report: IntegrityReport,
  target: string,
  now = new Date(),
): IntegrityRow[] {
  const ssh = `tailscale ssh ${target}`;
  const rows: IntegrityRow[] = [];
  const rerun = "Re-check: hatchkit host integrity --json";
  for (const d of DETECTORS) {
    const found = report.findings.filter((f) => f.detector === d.detector);
    if (found.length === 0) continue;
    rows.push({
      name: `Host integrity: ${d.name}`,
      status: "fail",
      detail: d.count(found.length),
      hint: [
        ...found.map((f) => f.summary),
        ...new Set(found.flatMap((f) => d.next(f, ssh))),
        ...(d.detector === "deleted-binary"
          ? [
              "A system binary replaced by an upgrade clears when its container or service restarts.",
            ]
          : allowHint(found)),
        rerun,
      ],
    });
  }
  const cpu = report.findings.filter((f) => f.detector === "cpu");
  if (cpu.length) {
    const confident = report.cpuWindowSeconds >= CONFIDENT_WINDOW;
    rows.push({
      name: `Host integrity: CPU (${report.cpuWindowSeconds} s sample)`,
      status: confident ? "fail" : "warn",
      detail: `${cpu.length} container(s) above ${report.cpuLimit} % of one core`,
      hint: [
        ...cpu.map((f) => f.summary),
        ...(confident
          ? []
          : [
              "Confirm over an hour: hatchkit host integrity --cpu-window 3600 (runs about an hour)",
            ]),
        ...allowHint(cpu),
      ],
    });
  }
  const last = report.timer.lastCheck;
  const dailyCpu =
    last && hours(last.checkedAt, now) <= STALE_HOURS
      ? last.findings.filter((f) => f.detector === "cpu")
      : [];
  if (dailyCpu.length)
    rows.push({
      name: "Host integrity: CPU (daily check, 1 h)",
      status: "fail",
      detail: `${dailyCpu.length} container(s) above ${report.cpuLimit} % of one core at ${last!.checkedAt}`,
      hint: [
        ...dailyCpu.map((f) => f.summary),
        "A miner holds a core for days: compare with the live sample above, then docker top the container.",
        ...allowHint(dailyCpu),
      ],
    });
  if (rows.length === 0)
    rows.push({
      name: `Host integrity (${report.host})`,
      status: "ok",
      detail: `${report.containers} containers, ${report.processes} processes, ${report.outboundConnections} outbound connections; nothing found (CPU over ${report.cpuWindowSeconds} s)${
        report.notes.length
          ? `; ${report.notes.length} note(s): hatchkit host integrity --json`
          : ""
      }`,
    });
  if (report.skipped?.length)
    rows.push({
      name: "Host integrity: not checked",
      status: "warn",
      detail: `${report.skipped.length} check(s) could not run this time`,
      hint: [...report.skipped, rerun],
    });
  rows.push(timerRow(report, ssh, now));
  return rows;
}

/** doctor: every backup host, [] when none is configured; never throws.
 *  With several hosts each row names its host. */
export async function checkHostIntegrity(): Promise<IntegrityRow[]> {
  let hosts: BackupHost[];
  try {
    hosts = backupHosts();
  } catch {
    return [];
  }
  const several = hosts.length > 1;
  const perHost = await Promise.all(
    hosts.map(async (host): Promise<IntegrityRow[]> => {
      try {
        const rows = integrityRows(await fetchIntegrityReport(10, host), host.target);
        return several ? rows.map((row) => ({ ...row, name: `${row.name} (${host.name})` })) : rows;
      } catch (err) {
        return [
          {
            name: several ? `Host integrity (${host.name})` : "Host integrity",
            status: "warn",
            detail: `couldn't scan the host: ${(err as Error).message.split("\n")[0]}`,
            hint: [`Retry: hatchkit host integrity${several ? ` --host ${host.name}` : ""} --json`],
          },
        ];
      }
    }),
  );
  return perHost.flat();
}

const UNITS = [
  "hatchkit-host-integrity.service",
  "hatchkit-host-integrity.timer",
  "hatchkit-host-integrity-failed.service",
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
names=('host-integrity.py','hatchkit-host-integrity.service','hatchkit-host-integrity.timer','hatchkit-host-integrity-failed.service')
if sorted(payload['files'])!=sorted(names):
 fail('unexpected installer files')
if not (opt/'alerts.py').exists() or not (opt/'runner.py').exists():
 fail('the backup runner is not installed; run hatchkit backup install first')
try:
 config=json.loads(pathlib.Path('/etc/hatchkit-backups/config.json').read_text())
except (OSError,ValueError):
 fail('/etc/hatchkit-backups/config.json is missing; run hatchkit backup install first')
alerts=config.get('alerts') or {}
if not alerts.get('enabled') or not alerts.get('to') or not pathlib.Path(alerts.get('smtpFile','/nonexistent')).exists():
 fail('backup alert mail is not configured; run hatchkit backup alerts --to <email> --from <verified-ses-email> first')
probe=subprocess.run(['python3','-','scan','--cpu-window','0'],input=payload['files']['host-integrity.py'],capture_output=True,text=True,timeout=300)
try:
 report=json.loads(probe.stdout.strip().splitlines()[-1])
except (IndexError,ValueError):
 report={}
if probe.returncode!=0 or 'findings' not in report:
 fail('the first scan failed ('+str(report.get('error') or 'no report')+'); nothing was installed')
targets={name:(opt if name.endswith('.py') else units)/name for name in names}
result={'host':report['host'],'mailTo':alerts['to'],'alreadyInstalled':targets['hatchkit-host-integrity.timer'].exists(),
 'findingsNow':[f['summary'] for f in report['findings']],'skippedNow':report.get('skipped',[]),'files':[str(t) for t in targets.values()]}
if payload['dryRun']:
 print(json.dumps(dict(result,applied=False)));sys.exit(0)
for name,target in targets.items():
 temp=target.with_name(target.name+'.tmp')
 temp.write_text(payload['files'][name])
 temp.chmod(0o700 if name.endswith('.py') else 0o644)
 temp.replace(target)
 written.append(str(target))
try:
 subprocess.run(['systemctl','daemon-reload'],check=True,capture_output=True)
 subprocess.run(['systemctl','enable','--now','hatchkit-host-integrity.timer'],check=True,capture_output=True)
except subprocess.CalledProcessError as error:
 fail('systemctl '+error.cmd[1]+' failed; the files are in place, the timer may not be active. Undo: hatchkit host integrity uninstall')
next_run=subprocess.run(['systemctl','show','hatchkit-host-integrity.timer','--property=NextElapseUSecRealtime','--value'],capture_output=True,text=True).stdout.strip()
print(json.dumps(dict(result,applied=True,timerEnabled=True,nextRun=next_run or None)))
`;

const UNINSTALL = `import json,pathlib,subprocess,sys
dry=sys.argv[1]=='dry'
paths=['/etc/systemd/system/hatchkit-host-integrity.timer','/etc/systemd/system/hatchkit-host-integrity.service','/etc/systemd/system/hatchkit-host-integrity-failed.service','/opt/hatchkit-backups/host-integrity.py']
present=[p for p in paths if pathlib.Path(p).exists()]
kept=[p for p in ('/etc/hatchkit-backups/host-integrity.json','/var/lib/hatchkit-backups/host-integrity-status.json') if pathlib.Path(p).exists()]
if not dry:
 for unit in ('hatchkit-host-integrity.timer','hatchkit-host-integrity.service'):
  subprocess.run(['systemctl','disable','--now',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 for p in present:
  pathlib.Path(p).unlink()
 subprocess.run(['systemctl','daemon-reload'],check=True)
print(json.dumps({'applied':not dry,'removed':present,'kept':kept}))
`;

function hostPython(
  host: BackupHost,
  script: string,
  args: string,
  input?: string,
  timeoutMs?: number,
) {
  const encoded = Buffer.from(script).toString("base64");
  return backupHostExec(
    host,
    `python3 -c 'import base64,sys;sys.argv=["hatchkit"${args ? `,"${args}"` : ""}];exec(base64.b64decode("${encoded}"))'`,
    input,
    timeoutMs,
  );
}

export async function installHostIntegrity(dryRun: boolean, host: BackupHost = backupHost()) {
  const files = Object.fromEntries(
    ["host-integrity.py", ...UNITS].map((name) => [name, template(name)]),
  );
  const result = lastJson(
    await hostPython(host, INSTALL, "", JSON.stringify({ dryRun, files }), 360_000),
  ) as Record<string, unknown>;
  return {
    ...result,
    schedule: "daily 05:00 UTC (+ up to 15 min); CPU averaged over the following hour",
    mail: "through the backup-alert SMTP; findings every run, one all-clear after they clear",
    nextSteps: dryRun
      ? ["Install: hatchkit host integrity install"]
      : [
          "Send a test mail: hatchkit host integrity test",
          "Check from here any time: hatchkit doctor",
        ],
    rollback: "hatchkit host integrity uninstall (keeps the site file and the last status)",
  };
}

export async function uninstallHostIntegrity(dryRun: boolean, host: BackupHost = backupHost()) {
  return lastJson(await hostPython(host, UNINSTALL, dryRun ? "dry" : "apply"));
}

export async function sendHostIntegrityTest(host: BackupHost = backupHost()) {
  return lastJson(
    await backupHostExec(host, "python3 /opt/hatchkit-backups/host-integrity.py test"),
  );
}

export const HOST_USAGE = `Usage:
  hatchkit host integrity [--cpu-window <seconds>] [--host <name>] [--json]
  hatchkit host integrity install [--host <name>] [--dry-run] [--json]
  hatchkit host integrity uninstall [--host <name>] [--dry-run] [--json]
  hatchkit host integrity test [--host <name>] [--json]

--host picks one of the backup hosts (hatchkit backup hosts); it is needed once
there are several. doctor scans every backup host.

integrity scans the backup host (providers.backups.hosts, over Tailscale SSH)
for signs that a container was taken over, and changes nothing:
  - a process whose binary was deleted from disk
  - a container process whose name its image does not explain
  - a new file in /tmp, /var/tmp or /dev/shm of a container, or a binary run from there
  - a container above 50 % of one core over the CPU window (default 10 s;
    a short window only warns, --cpu-window 3600 averages over an hour)
  - an outbound TCP peer outside private ranges and Cloudflare's published
    ranges, connected in at least half of the samples (one a minute; both
    ends of a shorter window)
It never prints environment values, command lines or file contents. Exits 1
when it finds something. hatchkit doctor runs the same scan.

install puts the script next to the backup runner (/opt/hatchkit-backups) with
a daily timer (05:00 UTC) that averages CPU over one hour and mails findings
through the backup-alert SMTP (hatchkit backup alerts). It refuses a host
without the backup runner or its alert mail, and runs one read-only scan
before it writes. --dry-run runs only that scan and prints what the first
mail would list. uninstall removes the script and the timer.
test sends a test mail through the installed script.

Exceptions: ${SITE_FILE} on the host, keys processes,
tempFiles, peers, peerContainers, cpuLimits. Each finding in --json carries
the "allow" entry that would accept it.
`;

/** The host script escapes these already; a terminal is not the place to trust that. */
const printable = (text: string) =>
  Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : c;
  }).join("");

function printRows(rows: IntegrityRow[]) {
  for (const row of rows) {
    const icon = row.status === "ok" ? "✓" : row.status === "warn" ? "!" : "✗";
    console.log(printable(`  ${icon} ${row.name}${row.detail ? ` — ${row.detail}` : ""}`));
    if (row.status !== "ok")
      for (const line of row.hint ?? []) console.log(printable(`      → ${line}`));
  }
}

export async function runHostCommand(args: string[]): Promise<void> {
  if (args[0] !== "integrity") throw new Error(HOST_USAGE);
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const rest = args.slice(1).filter((a) => a !== "--json" && a !== "--dry-run");
  const action = rest[0] && !rest[0].startsWith("--") ? rest.shift() : "scan";
  if (dryRun && action !== "install" && action !== "uninstall")
    throw new Error("--dry-run applies to host integrity install and uninstall.");
  let window: number | undefined;
  let hostName: string | undefined;
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--cpu-window" && action === "scan" && window === undefined && rest.length)
      window = parseWindow(rest.shift(), 10);
    else if (flag === "--host" && hostName === undefined && rest[0] && !rest[0].startsWith("--"))
      hostName = rest.shift();
    else throw new Error(`Unknown or incomplete host integrity option: ${flag}\n\n${HOST_USAGE}`);
  }
  const host = backupHost(hostName);
  if (action === "scan") {
    const report = await fetchIntegrityReport(window ?? 10, host);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      printRows(integrityRows(report, host.target));
      for (const note of report.notes) console.log(printable(`  · ${note}`));
    }
    if (report.findings.length) process.exitCode = 1;
    return;
  }
  let result: unknown;
  if (action === "install") result = await installHostIntegrity(dryRun, host);
  else if (action === "uninstall") result = await uninstallHostIntegrity(dryRun, host);
  else if (action === "test") result = await sendHostIntegrityTest(host);
  else throw new Error(HOST_USAGE);
  console.log(JSON.stringify(result, null, 2));
}
