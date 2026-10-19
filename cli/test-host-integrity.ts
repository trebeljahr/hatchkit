// Host integrity: the detectors (Python, against fixture /proc trees), the
// doctor rows built from their report, and what goes over Tailscale SSH.
//
// 2026-10-18: a cryptominer ran for days in the Plausible container on the
// shared Coolify host and nothing alerted. The fixture report below is that
// container; every detector must name it, and a clean host must raise
// nothing but an ok row.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "./src/config.js";
import {
  type IntegrityFinding,
  type IntegrityReport,
  checkHostIntegrity,
  installHostIntegrity,
  integrityRows,
  mergeAllow,
  parseWindow,
  runHostCommand,
  uninstallHostIntegrity,
} from "./src/host/integrity.js";

const python = spawnSync("python3", ["test-host-integrity.py"], { stdio: "inherit" });
assert.equal(python.status, 0, "Python detector tests failed");

const now = new Date("2026-10-19T08:00:00Z");
const TARGET = "root@dedicated-vps";

function report(
  findings: IntegrityFinding[],
  extra: Partial<IntegrityReport> = {},
): IntegrityReport {
  return {
    host: "dedicated-vps",
    scannedAt: now.toISOString(),
    cpuWindowSeconds: 10,
    cpuLimit: 50,
    containers: 31,
    processes: 243,
    outboundConnections: 4,
    networkNamespaces: 20,
    peerSamples: 2,
    skipped: [],
    cpuTop: [],
    findings,
    notes: [],
    siteFile: null,
    timer: { installed: false, lastCheck: null },
    ...extra,
  };
}

const plausible = "plausible-c8378br07og1w4ta45uxh57l";
const image = "ghcr.io/plausible/community-edition:v3.0.1";
const miner: IntegrityFinding[] = [
  {
    detector: "deleted-binary",
    container: plausible,
    image,
    pid: 1002,
    process: "linuxsys",
    exe: "/tmp/.x/linuxsys (deleted)",
    summary: `${plausible}: process linuxsys (pid 1002) runs /tmp/.x/linuxsys, which was deleted from disk`,
  },
  {
    detector: "unexpected-process",
    container: plausible,
    image,
    process: "linuxsys",
    pids: [1002],
    summary: `${plausible}: unexpected process linuxsys`,
    allow: { processes: { "ghcr.io/plausible/community-edition*": ["linuxsys"] } },
  },
  {
    detector: "temp-file",
    container: plausible,
    image,
    path: "/tmp/.x/config.json",
    summary: `${plausible}: new file /tmp/.x/config.json`,
    allow: { tempFiles: ["/tmp/.x/config.json"] },
  },
  {
    detector: "temp-file",
    container: plausible,
    image,
    path: "/tmp/.x/linuxsys",
    pid: 1002,
    summary: `${plausible}: process linuxsys (pid 1002) runs a binary from a temp dir`,
  },
  {
    detector: "cpu",
    container: plausible,
    image,
    percent: 91,
    windowSeconds: 10,
    summary: `${plausible}: 91 % of one core averaged over 10 s (limit 50 %)`,
    allow: { cpuLimits: { "ghcr.io/plausible/community-edition*": 100 } },
  },
  {
    detector: "outbound-peer",
    container: plausible,
    image,
    peer: "103.189.234.47:80",
    pid: 1002,
    process: "linuxsys",
    summary: `${plausible}: outbound TCP connection to 103.189.234.47:80 from linuxsys (pid 1002)`,
    allow: { peers: ["103.189.234.47/32"] },
  },
];

const byName = (rows: ReturnType<typeof integrityRows>) =>
  Object.fromEntries(rows.map((r) => [r.name, r]));

// --- a clean host: one ok row, and the missing timer is a warning --------
{
  const rows = integrityRows(report([]), TARGET, now);
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    [
      ["Host integrity (dedicated-vps)", "ok"],
      ["Host integrity daily check", "warn"],
    ],
  );
  assert.match(
    rows[0].detail ?? "",
    /31 containers, 243 processes, 4 outbound connections; nothing found/,
  );
  assert.ok(
    rows[1].hint?.some(
      (h) =>
        h ===
        "Install (writes the script and a timer to the host): hatchkit host integrity install",
    ),
  );
  assert.ok(rows[1].hint?.some((h) => h.includes("hatchkit backup alerts --to <email>")));
}

// --- the miner: one failing row per detector, with exact next steps ------
{
  const rows = byName(integrityRows(report(miner), TARGET, now));
  const ssh = `tailscale ssh ${TARGET}`;
  assert.equal(rows["Host integrity: deleted binaries"].status, "fail");
  assert.ok(
    rows["Host integrity: deleted binaries"].hint?.includes(
      `Save the binary first (the running process keeps it readable): ${ssh} 'mkdir -p /root/incident && cp /proc/1002/exe /root/incident/${plausible}-1002.bin'`,
    ),
  );
  const processes = rows["Host integrity: unexpected processes"];
  assert.equal(processes.status, "fail");
  assert.ok(
    processes.hint?.includes(
      `See the container's processes: ${ssh} docker top ${plausible} -eo pid,ppid,etime,comm`,
    ),
  );
  assert.ok(
    processes.hint?.includes(
      'Only once you know what causes it, merge into /etc/hatchkit-backups/host-integrity.json on the host (root-only JSON): {"processes":{"ghcr.io/plausible/community-edition*":["linuxsys"]}}',
    ),
  );
  const files = rows["Host integrity: temp-dir files"];
  assert.equal(files.detail, "2 new file(s) or binaries in /tmp, /var/tmp or /dev/shm");
  assert.equal(
    files.hint?.filter((h) => h.includes("docker diff")).length,
    1,
    "one command per container",
  );
  assert.ok(files.hint?.some((h) => h.endsWith('{"tempFiles":["/tmp/.x/config.json"]}')));
  assert.ok(
    rows["Host integrity: outbound peers"].hint?.includes(
      `See the container's sockets: ${ssh} nsenter -t 1002 -n ss -tnp`,
    ),
  );
  // A 10 s CPU sample is a warning with the command that confirms it.
  const cpu = rows["Host integrity: CPU (10 s sample)"];
  assert.equal(cpu.status, "warn");
  assert.ok(
    cpu.hint?.includes(
      "Confirm over an hour: hatchkit host integrity --cpu-window 3600 (runs about an hour)",
    ),
  );
  assert.equal(rows["Host integrity (dedicated-vps)"], undefined);
}

// --- an hour-long sample, and the daily check's CPU ------------------------
{
  const hour = report(
    miner.filter((f) => f.detector === "cpu"),
    { cpuWindowSeconds: 3600 },
  );
  assert.equal(
    byName(integrityRows(hour, TARGET, now))["Host integrity: CPU (3600 s sample)"].status,
    "fail",
  );
  const lastCheck = (checkedAt: string) => ({
    installed: true,
    active: true,
    serviceResult: "success",
    nextRun: "Tue 2026-10-20 05:04:11 UTC",
    lastCheck: {
      checkedAt,
      ok: false,
      error: null,
      containers: 31,
      cpuWindowSeconds: 3600,
      findings: miner.filter((f) => f.detector === "cpu"),
      mailed: "findings" as const,
    },
  });
  const fresh = byName(
    integrityRows(report([], { timer: lastCheck("2026-10-19T06:02:00+00:00") }), TARGET, now),
  );
  assert.equal(fresh["Host integrity: CPU (daily check, 1 h)"].status, "fail");
  assert.equal(fresh["Host integrity daily check"].status, "ok");
  assert.match(
    fresh["Host integrity daily check"].detail ?? "",
    /1 finding\(s\), mailed; next Tue 2026-10-20/,
  );
  const stale = byName(
    integrityRows(report([], { timer: lastCheck("2026-10-17T06:02:00+00:00") }), TARGET, now),
  );
  assert.equal(
    stale["Host integrity: CPU (daily check, 1 h)"],
    undefined,
    "a stale check is not current CPU",
  );
  assert.equal(stale["Host integrity daily check"].status, "fail");
  assert.match(stale["Host integrity daily check"].detail ?? "", /50 h ago/);
  // Staleness counts from checkedAt, the end of the run: one that began
  // 37 h ago and finished an hour later is still current.
  const late = lastCheck("2026-10-17T20:00:13+00:00");
  const ended = byName(
    integrityRows(
      report([], {
        timer: {
          ...late,
          lastCheck: { ...late.lastCheck, startedAt: "2026-10-17T19:00:00+00:00" },
        },
      }),
      TARGET,
      now,
    ),
  );
  assert.equal(ended["Host integrity daily check"].status, "ok");
  assert.equal(ended["Host integrity: CPU (daily check, 1 h)"].status, "fail");
}

// --- timer states ------------------------------------------------------------
{
  const timer = (t: IntegrityReport["timer"]) =>
    integrityRows(report([], { timer: t }), TARGET, now).find(
      (r) => r.name === "Host integrity daily check",
    )!;
  const base = {
    checkedAt: "2026-10-19T06:00:00+00:00",
    ok: false,
    containers: 31,
    cpuWindowSeconds: 3600,
    findings: [],
    mailed: null,
  };
  assert.equal(timer({ installed: true, active: false, lastCheck: null }).status, "fail");
  assert.match(
    timer({ installed: true, active: true, nextRun: "Tue 05:03", lastCheck: null }).detail ?? "",
    /first run Tue 05:03/,
  );
  const error = timer({
    installed: true,
    active: true,
    lastCheck: { ...base, error: "docker ps failed" },
  });
  assert.equal(error.status, "fail");
  assert.equal(error.detail, "last run could not finish: docker ps failed");
  const mail = timer({
    installed: true,
    active: true,
    lastCheck: { ...base, error: null, mailError: "OSError" },
  });
  assert.equal(mail.status, "fail");
  assert.ok(mail.hint?.includes("Test the mail path: hatchkit host integrity test"));
}

// --- a run systemd stopped, and checks that could not run ---------------------
{
  const killed = integrityRows(
    report([], {
      timer: { installed: true, active: true, serviceResult: "timeout", lastCheck: null },
    }),
    TARGET,
    now,
  ).find((r) => r.name === "Host integrity daily check");
  assert.equal(killed?.status, "fail");
  assert.equal(killed?.detail, 'the last run ended with systemd result "timeout"');
  const rows = byName(
    integrityRows(
      report([], { skipped: ["coolify: docker diff failed; writable layer not checked."] }),
      TARGET,
      now,
    ),
  );
  assert.equal(rows["Host integrity (dedicated-vps)"].status, "ok");
  assert.equal(rows["Host integrity: not checked"].status, "warn");
  assert.ok(
    rows["Host integrity: not checked"].hint?.[0].startsWith("coolify: docker diff failed"),
  );
  const peers = byName(integrityRows(report(miner), TARGET, now))["Host integrity: outbound peers"];
  assert.ok(peers.hint?.some((h) => h.includes("peers apply to every container")));
}

// --- allow entries merge, windows are bounded -------------------------------
assert.deepEqual(
  mergeAllow([
    {
      detector: "temp-file",
      container: "a",
      image: "i",
      summary: "",
      allow: { tempFiles: ["/tmp/a"] },
    },
    {
      detector: "temp-file",
      container: "a",
      image: "i",
      summary: "",
      allow: { tempFiles: ["/tmp/a", "/tmp/b"] },
    },
    {
      detector: "unexpected-process",
      container: "a",
      image: "i",
      summary: "",
      allow: { processes: { "i*": ["x"] } },
    },
    {
      detector: "unexpected-process",
      container: "a",
      image: "i",
      summary: "",
      allow: { processes: { "i*": ["y"] } },
    },
  ]),
  { tempFiles: ["/tmp/a", "/tmp/b"], processes: { "i*": ["x", "y"] } },
);
assert.equal(
  mergeAllow([{ detector: "deleted-binary", container: null, image: null, summary: "" }]),
  null,
);
assert.equal(parseWindow(undefined, 10), 10);
assert.equal(parseWindow("3600", 10), 3600);
for (const bad of ["-1", "3601", "1.5", "x"])
  assert.throws(() => parseWindow(bad, 10), /0 to 3600/);

// --- over Tailscale SSH (a fake tailscale on PATH) --------------------------
const dir = mkdtempSync(join(tmpdir(), "hatchkit-host-integrity-"));
try {
  // Without a backup host, doctor stays quiet.
  assert.deepEqual(await checkHostIntegrity(), []);
  getStore().set("providers.backups", {
    status: "configured",
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    host: { transport: "tailscale", target: TARGET, serverUuid: "server-uuid" },
    autoRegister: false,
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const fake = (body: string) => {
    writeFileSync(
      join(bin, "tailscale"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n${body}\n`,
    );
    chmodSync(join(bin, "tailscale"), 0o755);
  };
  const argv = () => readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
  const stdin = () => readFileSync(join(dir, "stdin"), "utf8");
  const script = readFileSync("src/templates/host-integrity/host-integrity.py", "utf8");

  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report(miner))}\n`);
  fake(`cat "${dir}/report.json"`);
  const rows = await checkHostIntegrity();
  assert.deepEqual(argv(), ["ssh", TARGET, "python3 - scan --cpu-window 10"]);
  assert.equal(stdin(), script, "the CLI's own copy of the script runs on the host");
  assert.equal(rows.filter((r) => r.status === "fail").length, 4);

  fake(`printf '{"ok": false, "error": "docker ps failed"}\\n'\nexit 1`);
  assert.deepEqual(await checkHostIntegrity(), [
    {
      name: "Host integrity",
      status: "warn",
      detail: "couldn't scan the host: Backup host dedicated-vps: docker ps failed",
      hint: ["Retry: hatchkit host integrity --json"],
    },
  ]);

  // Two hosts through doctor: each scan row names its host once (the
  // 2026-10-19 drill printed "Host integrity (dedicated-vps) (dedicated-vps)").
  const single = getStore().get("providers.backups");
  const meta = { transport: "tailscale" as const, target: TARGET, serverUuid: "server-uuid" };
  getStore().set("providers.backups", {
    status: "configured",
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    hosts: {
      "dedicated-vps": meta,
      "shared-vps": { ...meta, target: "root@shared-vps", serverUuid: "shared-uuid" },
    },
    autoRegister: false,
  });
  for (const host of ["dedicated-vps", "shared-vps"])
    writeFileSync(join(dir, `root@${host}.json`), `${JSON.stringify(report([], { host }))}\n`);
  fake(`cat "${dir}/$2.json"`);
  assert.deepEqual(
    (await checkHostIntegrity()).map((r) => r.name),
    [
      "Host integrity (dedicated-vps)",
      "Host integrity daily check (dedicated-vps)",
      "Host integrity (shared-vps)",
      "Host integrity daily check (shared-vps)",
    ],
  );
  getStore().set("providers.backups", single);

  // install --dry-run: the payload is the three files, and the host script
  // stops after its read-only first scan.
  fake(`printf '{"host": "dedicated-vps", "applied": false, "findingsNow": []}\\n'`);
  const preview = await installHostIntegrity(true);
  assert.equal(preview.applied, false);
  assert.equal(
    preview.rollback,
    "hatchkit host integrity uninstall (keeps the site file and the last status)",
  );
  const payload = JSON.parse(stdin());
  assert.equal(payload.dryRun, true);
  assert.deepEqual(Object.keys(payload.files).sort(), [
    "hatchkit-host-integrity-failed.service",
    "hatchkit-host-integrity.service",
    "hatchkit-host-integrity.timer",
    "host-integrity.py",
  ]);
  assert.match(
    payload.files["hatchkit-host-integrity.service"],
    /OnFailure=hatchkit-host-integrity-failed\.service/,
  );
  assert.match(
    payload.files["hatchkit-host-integrity-failed.service"],
    /host-integrity\.py failed/,
  );
  assert.equal(payload.files["host-integrity.py"], script);
  assert.match(payload.files["hatchkit-host-integrity.timer"], /OnCalendar=\*-\*-\* 05:00:00 UTC/);
  assert.match(payload.files["hatchkit-host-integrity.service"], /TimeoutStartSec=3h/);
  const command = argv()[2];
  const installer = Buffer.from(command.match(/b64decode\("([^"]+)"\)/)![1], "base64").toString();
  const dryExit = installer.indexOf("if payload['dryRun']:");
  assert.ok(dryExit > installer.indexOf("probe=subprocess.run"), "dry-run reports the first scan");
  assert.ok(dryExit < installer.indexOf("temp.write_text"), "dry-run exits before any write");
  assert.ok(
    installer.indexOf("fail('backup alert mail is not configured") <
      installer.indexOf("temp.write_text"),
  );
  assert.ok(
    installer.indexOf("fail('unexpected installer files')") < installer.indexOf("temp.write_text"),
    "every file name is checked before the first write",
  );
  // No credential travels: mail uses the SMTP file already on the host.
  assert.deepEqual(Object.keys(payload).sort(), ["dryRun", "files"]);

  fake(`printf '{"applied": false, "removed": [], "kept": []}\\n'`);
  assert.deepEqual(await uninstallHostIntegrity(true), { applied: false, removed: [], kept: [] });
  assert.match(argv()[2], /sys\.argv=\["hatchkit","dry"\]/);

  // Arguments.
  await assert.rejects(
    runHostCommand(["integrity", "--dry-run"]),
    /applies to host integrity install/,
  );
  await assert.rejects(runHostCommand(["integrity", "--cpu-window", "9999"]), /0 to 3600/);
  await assert.rejects(runHostCommand(["integrity", "--cpu-window"]), /Unknown or incomplete/);
  await assert.rejects(
    runHostCommand(["integrity", "install", "--cpu-window", "5"]),
    /Unknown or incomplete/,
  );
  await assert.rejects(runHostCommand(["integrity", "nope"]), /Usage:/);
  await assert.rejects(runHostCommand(["status"]), /Usage:/);
  const help = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "host", "integrity", "install", "--help"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hatchkit host integrity install \[--host <name>\] \[--dry-run\]/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Host integrity detectors, doctor rows and host payloads passed.");
