// Several backup hosts: config migration, host selection, and moving a
// project between hosts with the stale-policy guard. A fake `tailscale`
// on PATH plays both hosts from one state file; no network or keychain.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBackupCommand } from "./src/backups/command.js";
import { backupTimer, installBackupHost } from "./src/backups/install.js";
import {
  backupHost,
  backupHosts,
  backupProvider,
  configureBackupProvider,
} from "./src/backups/provider.js";
import {
  type BackupProject,
  registerBackupProject,
  registrationHost,
  shouldRegisterBackups,
} from "./src/backups/register.js";
import {
  fetchSourceReport,
  projectHost,
  reconcileBackupsAfterRemoval,
} from "./src/backups/sources.js";
import { getConfig, getStore } from "./src/config.js";
import { forHost, rowsFor } from "./src/host/integrity.js";
import { collectStatus } from "./src/status.js";

const dir = mkdtempSync(join(tmpdir(), "hatchkit-backup-hosts-"));
const originalPath = process.env.PATH;
const originalLog = console.log;

const REPO = "s3:https://account.eu.r2.cloudflarestorage.com/hatchkit-project-backups";
const DEDICATED = "root@dedicated-vps";
const SHARED = "root@shared-vps";

interface FakeHost {
  installed: boolean;
  projects: BackupProject[];
  down?: boolean;
  timer?: string;
  missing?: string[];
  stale?: string[];
}
interface FakeState {
  hosts: Record<string, FakeHost>;
  calls: { target: string; kind: string }[];
  /** Simulates someone editing that host's policy while a move runs. */
  mutateOnAdd?: { target: string; project: string };
}

const statePath = join(dir, "state.json");
const read = (): FakeState => JSON.parse(readFileSync(statePath, "utf8"));
const write = (state: FakeState) => writeFileSync(statePath, JSON.stringify(state));
const calls = () => read().calls;
const resetCalls = () => write({ ...read(), calls: [] });
const projectsOn = (target: string) => read().hosts[target].projects.map((p) => p.name);

// register.py's semantics, the runner's plan/sources/status, recovery
// snapshots, the installer and systemctl, keyed by Tailscale target.
const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const { isDeepStrictEqual } = require("node:util");
const statePath = ${JSON.stringify(statePath)};
const [, target, command] = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
// Hosts are asked in parallel. Two fakes writing the state at once tore
// it, and the reader's JSON.parse crashed as "command failed (exit 1)".
const lock = statePath + ".lock";
const pause = new Int32Array(new SharedArrayBuffer(4));
for (const start = Date.now(); ; ) {
  try { fs.mkdirSync(lock); break; } catch (error) {
    if (error.code !== "EEXIST" || Date.now() - start > 30000) throw error;
    Atomics.wait(pause, 0, 0, 5);
  }
}
process.on("exit", () => fs.rmdirSync(lock));
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const host = state.hosts[target];
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (value, code = 0) => { save(); console.log(typeof value === "string" ? value : JSON.stringify(value)); process.exit(code); };
const fail = (error) => out({ ok: false, error }, 1);
const code = (command.match(/b64decode\\("([^"]+)"\\)/) || [])[1];
const program = code ? Buffer.from(code, "base64").toString() : "";
const mode = (command.match(/sys\\.argv=\\["register\\.py","(\\w+)"\\]/) || [])[1];
const kind = mode ? "register-" + mode
  : program.includes("'installed':path.exists()") ? "projects"
  : program.includes("hatchkit-backup-install") ? "install"
  : command.startsWith("python3 - ") ? "runner-" + command.split(" ")[2]
  : command.includes("runner.py status") ? "status"
  : command.includes("recovery.py snapshots") ? "snapshots"
  : command.includes("restore-check.py") ? "restore-check"
  : command.includes("systemctl start") ? "run"
  : command.includes("systemctl enable") ? "timer-enable"
  : "other";
state.calls.push({ target, kind });
if (!host || host.down) { save(); process.stderr.write("tailscale: host unreachable\\n"); process.exit(255); }
const find = (name) => host.projects.find((p) => p.name === name);
if (mode === "add") {
  const project = JSON.parse(input);
  const existing = find(project.name);
  if (existing) {
    if (!isDeepStrictEqual(existing, project)) fail("Existing project policy differs; review it explicitly instead of replacing sources");
    out({ project: project.name, registered: true, existing: true });
  }
  host.projects.push(project);
  const m = state.mutateOnAdd;
  if (m) {
    const other = state.hosts[m.target].projects.find((p) => p.name === m.project);
    other.sources = other.sources.slice(0, 1);
    delete state.mutateOnAdd;
  }
  out({ project: project.name, registered: true, existing: false });
}
if (mode === "replace" || mode === "remove") {
  const payload = JSON.parse(input);
  const name = mode === "replace" ? payload.project.name : payload.name;
  const current = find(name);
  if (!current) fail("Project is not registered on this host");
  if (!isDeepStrictEqual(current, payload.expected)) fail("Host policy changed since it was read; re-run the command to review it");
  const i = host.projects.indexOf(current);
  if (mode === "replace") { host.projects[i] = payload.project; out({ project: name, replaced: true }); }
  host.projects.splice(i, 1);
  out({ project: name, deregistered: true, snapshotsKept: true });
}
if (kind === "projects") out({ installed: host.installed, projects: host.installed ? host.projects : [] });
if (kind === "install") {
  host.timer = JSON.parse(input).files["hatchkit-backups.timer"];
  host.installed = true;
  out({ installed: true, scheduleChanged: false, credentials: "root-only host files; recovery copy in OS keychain" });
}
const project = (command.match(/--project ([a-z0-9_-]+)/) || [])[1];
const scoped = host.projects.filter((p) => !project || p.name === project);
if (project && scoped.length === 0 && kind !== "restore-check") fail("Unknown project");
if (kind === "runner-plan") out({ repositoryBase: "repo", projects: scoped });
if (kind === "runner-sources") {
  const rows = scoped.flatMap((p) => p.sources.map((s) => {
    const missing = (host.missing || []).includes(p.name + "/" + s.name);
    return { project: p.name, source: s.name, kind: s.kind, state: missing ? "missing" : "ok",
      ...(s.selector ? { selector: s.selector, matches: missing ? 0 : 1, candidates: [] } : {}),
      ...(s.paths ? { paths: s.paths, ...(missing ? { missingPaths: s.paths } : {}) } : {}) };
  }));
  out({ sources: rows, stale: rows.filter((r) => r.state !== "ok").length });
}
if (kind === "status") {
  const results = scoped.map((p) => ({ project: p.name, ok: true, stale: (host.stale || []).includes(p.name) }));
  out({ results, healthy: results.every((r) => !r.stale), timerEnabled: false });
}
if (kind === "snapshots") out([{ id: "a".repeat(64), time: "2026-10-19T16:05:00Z" }]);
if (kind === "restore-check") out(scoped.map((p) => JSON.stringify({ project: p.name, ok: true })).join("\\n"));
if (kind === "run") out("");
if (kind === "timer-enable") out("Mon 2026-10-20 17:00:00 UTC");
fail("unexpected command");
`;

function project(name: string, uuid: string, kinds: ("postgres" | "files")[]): BackupProject {
  return {
    name,
    keepLast: 3,
    sources: kinds.map((kind) =>
      kind === "files"
        ? { name: "uploads", kind, paths: [`/var/lib/docker/volumes/${uuid}_uploads/_data`] }
        : { name: "postgres", kind, selector: { project: uuid, service: "postgres" } },
    ),
  };
}

/** runBackupCommand's printed JSON. */
async function cli(...args: string[]) {
  let printed = "";
  console.log = (text: string) => {
    printed += text;
  };
  try {
    await runBackupCommand([...args, "--json"], dir);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(printed);
}

try {
  // --- A config from before multi-host support reads as one host ---------
  getStore().set("providers.backups", {
    status: "configured",
    repositoryBase: REPO,
    host: { transport: "tailscale", target: DEDICATED, serverUuid: "dedicated-uuid" },
    autoRegister: true,
  });
  assert.deepEqual(backupHosts(), [
    {
      name: "dedicated-vps",
      transport: "tailscale",
      target: DEDICATED,
      serverUuid: "dedicated-uuid",
    },
  ]);
  assert.equal(backupHost().name, "dedicated-vps");
  // Reading never rewrites the file.
  assert.ok(getConfig().providers.backups?.host);
  assert.equal(getConfig().providers.backups?.hosts, undefined);
  assert.match(
    collectStatus(dir).providers.find((p) => p.key === "backups")?.detail ?? "",
    /root@dedicated-vps/,
  );
  assert.ok(shouldRegisterBackups("dedicated-uuid"));

  // --- add-host -----------------------------------------------------------
  const preview = await cli(
    "add-host",
    "--name",
    "shared-vps",
    "--target",
    SHARED,
    "--server-uuid",
    "shared-uuid",
    "--schedule",
    "17:00",
    "--dry-run",
  );
  assert.equal(preview.applied, false);
  assert.ok(getConfig().providers.backups?.host, "dry run leaves the file alone");
  const added = await cli(
    "add-host",
    "--name",
    "shared-vps",
    "--target",
    SHARED,
    "--server-uuid",
    "shared-uuid",
    "--schedule",
    "17:00",
  );
  assert.deepEqual(added.hosts, ["dedicated-vps", "shared-vps"]);
  const stored = getConfig().providers.backups;
  assert.equal(stored?.host, undefined, "the first write stores hosts only");
  assert.deepEqual(Object.keys(stored?.hosts ?? {}), ["dedicated-vps", "shared-vps"]);
  assert.equal(stored?.hosts["shared-vps"].schedule, "17:00");
  const addHost = (name: string, target: string, uuid: string, schedule?: string) =>
    cli(
      "add-host",
      "--name",
      name,
      "--target",
      target,
      "--server-uuid",
      uuid,
      ...(schedule ? ["--schedule", schedule] : []),
    );
  await assert.rejects(addHost("shared-vps", "root@x", "x"), /already configured/);
  await assert.rejects(addHost("third", "root@third", "shared-uuid"), /share one serverUuid/);
  await assert.rejects(addHost("third", SHARED, "third-uuid"), /share one target/);
  await assert.rejects(addHost("third", "third", "third-uuid"), /root@hostname/);
  await assert.rejects(addHost("third", "root@third", "third-uuid", "25:00"), /HH:MM/);
  await assert.rejects(addHost("Third Host", "root@third", "third-uuid"), /host names/);
  assert.match(
    collectStatus(dir).providers.find((p) => p.key === "backups")?.detail ?? "",
    /root@dedicated-vps, root@shared-vps/,
  );

  // Host-integrity hints name the host once a command would need --host.
  assert.equal(
    forHost(
      "Install (writes the script and a timer to the host): hatchkit host integrity install",
      "shared-vps",
    ),
    "Install (writes the script and a timer to the host): hatchkit host integrity install --host shared-vps",
  );
  assert.equal(
    forHost("Preview (reads only): hatchkit host integrity install --dry-run", "shared-vps"),
    "Preview (reads only): hatchkit host integrity install --host shared-vps --dry-run",
  );
  assert.equal(
    forHost("Re-check: hatchkit host integrity --json", "shared-vps"),
    "Re-check: hatchkit host integrity --host shared-vps --json",
  );
  assert.equal(
    forHost(
      "Needs the backup runner and its alert mail first: hatchkit backup install, then hatchkit backup alerts --to <email>",
      "shared-vps",
    ),
    "Needs the backup runner and its alert mail first: hatchkit backup install --host shared-vps, then hatchkit backup alerts --host shared-vps --to <email>",
  );
  assert.equal(
    forHost("Check from here any time: hatchkit doctor", "shared-vps"),
    "Check from here any time: hatchkit doctor",
  );
  assert.equal(
    forHost("hatchkit backup alert-test", "shared-vps"),
    "hatchkit backup alert-test --host shared-vps",
  );

  // Each row names its host once, whether or not the scan already did.
  const shared = {
    name: "shared-vps",
    transport: "tailscale" as const,
    target: SHARED,
    serverUuid: "shared-uuid",
  };
  assert.deepEqual(
    rowsFor(
      [
        { name: "Host integrity (shared-vps)", status: "ok" },
        {
          name: "Host integrity daily check",
          status: "warn",
          hint: ["hatchkit host integrity install"],
        },
      ],
      shared,
      true,
    ),
    [
      { name: "Host integrity (shared-vps)", status: "ok" },
      {
        name: "Host integrity daily check (shared-vps)",
        status: "warn",
        hint: ["hatchkit host integrity install --host shared-vps"],
      },
    ],
  );

  // --- configure with an old single-host file keeps the second host ------
  const credentialsFile = join(dir, "credentials.json");
  const passwordFile = join(dir, "password");
  writeFileSync(
    credentialsFile,
    JSON.stringify({ accessKeyId: "a".repeat(32), secretAccessKey: "b".repeat(64) }),
    { mode: 0o600 },
  );
  writeFileSync(passwordFile, "test-recovery-password-long-enough", { mode: 0o600 });
  await configureBackupProvider({
    status: "configured",
    repositoryBase: REPO,
    host: { transport: "tailscale", target: DEDICATED, serverUuid: "dedicated-uuid" },
    autoRegister: true,
    credentialsFile,
    passwordFile,
  });
  assert.deepEqual(Object.keys(backupProvider().hosts), ["dedicated-vps", "shared-vps"]);
  assert.equal(backupProvider().hosts["shared-vps"].schedule, "17:00");

  // --- several hosts: commands that touch one host need --host -----------
  assert.throws(() => backupHost(), /Several backup hosts .*dedicated-vps, shared-vps.*--host/);
  assert.throws(() => backupHost("nope"), /No backup host named nope/);
  await assert.rejects(installBackupHost(true), /--host/);
  await assert.rejects(cli("plan", "--host", "shared-vps"), /does not apply/);
  const installPreview = await installBackupHost(true, "shared-vps");
  assert.equal(installPreview.host.target, SHARED);
  assert.match(installPreview.schedule, /17:00 UTC/);
  assert.match((await installBackupHost(true, "dedicated-vps")).schedule, /16:00 UTC/);
  const template = readFileSync(
    fileURLToPath(new URL("./src/templates/backups/hatchkit-backups.timer", import.meta.url)),
    "utf8",
  );
  const timer = backupTimer(template, "17:00");
  assert.match(timer, /^OnCalendar=\*-\*-\* 17:00:00 UTC$/m);
  assert.equal(timer.match(/OnCalendar/g)?.length, 1);
  assert.match(timer, /RandomizedDelaySec=15m/);
  assert.throws(() => backupTimer("[Timer]\n", "17:00"), /exactly one OnCalendar/);

  // --- over Tailscale SSH, two fake hosts ----------------------------------
  const listmonkOld = project("listmonk", "old-listmonk", ["postgres", "files"]);
  const listmonkNew = project("listmonk", "3rlsm6ayxvgcuqtizvgwtgir", ["postgres", "files"]);
  const chess = project("chess-app", "chess", ["files"]);
  write({
    hosts: {
      [DEDICATED]: { installed: true, projects: [listmonkOld, chess] },
      [SHARED]: { installed: false, projects: [] },
    },
    calls: [],
  });
  writeFileSync(join(dir, "tailscale"), FAKE);
  chmodSync(join(dir, "tailscale"), 0o700);
  process.env.PATH = `${dir}:${originalPath}`;

  // install sends the host's own schedule, and only to that host.
  const installed = await installBackupHost(false, "shared-vps");
  assert.equal(installed.installed, true);
  assert.match(read().hosts[SHARED].timer ?? "", /^OnCalendar=\*-\*-\* 17:00:00 UTC$/m);
  assert.deepEqual(calls(), [{ target: SHARED, kind: "install" }]);

  // A project's host is found by asking every host; --host skips that.
  resetCalls();
  const snapshots = await cli("snapshots", "--project", "chess-app");
  assert.equal(snapshots.host, "dedicated-vps");
  assert.deepEqual(
    calls().filter((c) => c.kind === "snapshots"),
    [{ target: DEDICATED, kind: "snapshots" }],
  );
  assert.equal(calls().filter((c) => c.kind === "projects").length, 2);
  resetCalls();
  await cli("snapshots", "--project", "chess-app", "--host", "dedicated-vps");
  assert.deepEqual(calls(), [{ target: DEDICATED, kind: "snapshots" }]);
  await assert.rejects(projectHost("ghost"), /not registered on any backup host/);

  // --- register on host B moves the project off host A --------------------
  const sourcesFile = join(dir, "listmonk.json");
  writeFileSync(sourcesFile, JSON.stringify({ serverUuid: "shared-uuid", project: listmonkNew }));
  const movePreview = await cli("register", "--config", sourcesFile, "--dry-run");
  assert.equal(movePreview.applied, false);
  assert.equal(movePreview.host.name, "shared-vps");
  assert.deepEqual(movePreview.movedFrom, ["dedicated-vps"]);
  assert.deepEqual(projectsOn(DEDICATED), ["listmonk", "chess-app"]);
  assert.deepEqual(projectsOn(SHARED), []);
  // --replace swaps a policy on one host; it never moves one.
  await assert.rejects(
    cli("register", "--config", sourcesFile, "--replace"),
    /registered on dedicated-vps, not only on shared-vps.*without --replace/,
  );
  // --host must be the host of the project's Coolify server.
  await assert.rejects(
    cli("register", "--config", sourcesFile, "--host", "dedicated-vps"),
    /differs from backup host dedicated-vps/,
  );
  resetCalls();
  const moved = await cli("register", "--config", sourcesFile);
  assert.equal(moved.host, "shared-vps");
  assert.deepEqual(moved.movedFrom, ["dedicated-vps"]);
  assert.equal(moved.existing, false);
  assert.deepEqual(projectsOn(SHARED), ["listmonk"]);
  assert.deepEqual(projectsOn(DEDICATED), ["chess-app"]);
  assert.deepEqual(read().hosts[SHARED].projects[0], listmonkNew);
  // Added on B before it left A: never a moment with no host.
  assert.deepEqual(
    calls()
      .filter((c) => c.kind.startsWith("register-"))
      .map((c) => [c.target, c.kind]),
    [
      [SHARED, "register-add"],
      [DEDICATED, "register-remove"],
    ],
  );
  // Registering again on the same host is idempotent and moves nothing.
  const again = await cli("register", "--config", sourcesFile);
  assert.equal(again.existing, true);
  assert.deepEqual(again.movedFrom, []);

  // Host A's policy changed after it was read: the add on B is undone.
  write({
    ...read(),
    hosts: {
      [DEDICATED]: { installed: true, projects: [listmonkOld, chess] },
      [SHARED]: { installed: true, projects: [] },
    },
    mutateOnAdd: { target: DEDICATED, project: "listmonk" },
  });
  await assert.rejects(
    cli("register", "--config", sourcesFile),
    /Couldn't remove listmonk from dedicated-vps: Backup host dedicated-vps: Host policy changed since it was read.*registration on shared-vps was undone; nothing moved/,
  );
  assert.deepEqual(projectsOn(SHARED), []);
  assert.deepEqual(projectsOn(DEDICATED), ["listmonk", "chess-app"]);
  assert.equal(read().hosts[DEDICATED].projects[0].sources.length, 1, "the other edit stays");

  // A host that cannot be read blocks the registration: the move is unknown.
  write({
    ...read(),
    hosts: { ...read().hosts, [DEDICATED]: { ...read().hosts[DEDICATED], down: true } },
  });
  await assert.rejects(
    cli("register", "--config", sourcesFile),
    /Couldn't read backup host dedicated-vps to find listmonk's host/,
  );
  assert.deepEqual(projectsOn(SHARED), []);

  // A project in two policies is reported, not guessed.
  write({
    ...read(),
    hosts: {
      [DEDICATED]: { installed: true, projects: [listmonkOld, chess] },
      [SHARED]: { installed: true, projects: [listmonkNew] },
    },
  });
  await assert.rejects(
    projectHost("listmonk"),
    /registered on dedicated-vps and shared-vps.*deregister --project listmonk --host <name>/,
  );
  const dropped = await cli("deregister", "--project", "listmonk", "--host", "dedicated-vps");
  assert.equal(dropped.backupHost, "dedicated-vps");
  assert.equal(dropped.applied, true);
  assert.deepEqual(projectsOn(DEDICATED), ["chess-app"]);
  assert.equal((await projectHost("listmonk")).name, "shared-vps");

  // Auto-registration in `create` targets the host of the project's server.
  assert.ok(shouldRegisterBackups("shared-uuid"));
  assert.ok(!shouldRegisterBackups("other-uuid"));
  assert.equal(registrationHost({ serverUuid: "shared-uuid" }).name, "shared-vps");
  assert.throws(() => registrationHost({}), /--host/);
  await assert.rejects(
    registerBackupProject(chess, { serverUuid: "other-uuid", dryRun: true }),
    /differs/,
  );

  // --- status, sources and run cover every host ---------------------------
  const status = await cli("status");
  assert.deepEqual(
    status.hosts.map((h: { name: string }) => h.name),
    ["dedicated-vps", "shared-vps"],
  );
  assert.equal(status.hosts[1].schedule, "17:00 UTC");
  assert.deepEqual(
    status.hosts[1].status.results.map((r: { project: string }) => r.project),
    ["listmonk"],
  );
  const scoped = await cli("status", "--project", "listmonk");
  assert.deepEqual(
    scoped.hosts.map((h: { name: string }) => h.name),
    ["shared-vps"],
  );

  write({
    ...read(),
    hosts: {
      ...read().hosts,
      [SHARED]: { ...read().hosts[SHARED], missing: ["listmonk/postgres"] },
    },
  });
  const report = await fetchSourceReport();
  assert.deepEqual(report.hosts, ["dedicated-vps", "shared-vps"]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stale.length, 1);
  assert.equal(report.stale[0].host, "shared-vps");
  assert.equal(
    report.stale[0].fix?.command,
    "hatchkit backup update-source --project listmonk --source postgres --remove --host shared-vps",
  );

  // One unreachable host: the other still reports, and the gap is named.
  write({
    ...read(),
    hosts: { ...read().hosts, [DEDICATED]: { ...read().hosts[DEDICATED], down: true } },
  });
  const partial = await fetchSourceReport();
  assert.deepEqual(partial.hosts, ["shared-vps"]);
  assert.equal(partial.errors[0].host, "dedicated-vps");
  const statusDown = await cli("status");
  assert.match(statusDown.hosts[0].error, /Backup host dedicated-vps command failed/);
  assert.ok(statusDown.hosts[1].status);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  write({
    ...read(),
    hosts: { ...read().hosts, [DEDICATED]: { ...read().hosts[DEDICATED], down: false } },
  });

  resetCalls();
  const run = await cli("run");
  assert.deepEqual(run.hosts, ["dedicated-vps", "shared-vps"]);
  assert.deepEqual(
    calls().map((c) => c.target),
    [DEDICATED, SHARED],
  );
  resetCalls();
  await cli("run", "--host", "shared-vps");
  assert.deepEqual(calls(), [{ target: SHARED, kind: "run" }]);
  const checked = await cli("restore-check", "--project", "listmonk");
  assert.equal(checked.host, "shared-vps");
  assert.deepEqual(checked.results, [{ project: "listmonk", ok: true }]);

  // --- a deleted Coolify resource drops sources on the host that reads it -
  resetCalls();
  const reconciled = await reconcileBackupsAfterRemoval({
    uuids: ["3rlsm6ayxvgcuqtizvgwtgir"],
    dryRun: false,
  });
  assert.equal(reconciled.failed, false);
  assert.match(reconciled.lines.join("\n"), /uploads.*still resolves|still resolves/);
  assert.deepEqual(
    read().hosts[SHARED].projects[0].sources.map((s) => s.name),
    ["uploads"],
  );
  assert.deepEqual(
    calls()
      .filter((c) => c.kind.startsWith("register-"))
      .map((c) => [c.target, c.kind]),
    [[SHARED, "register-replace"]],
  );

  // --- timer: enabled only after a fresh verified capture -----------------
  write({
    ...read(),
    hosts: { ...read().hosts, [SHARED]: { ...read().hosts[SHARED], stale: ["listmonk"] } },
  });
  await assert.rejects(cli("timer", "--enable"), /--host/);
  await assert.rejects(
    cli("timer", "--enable", "--host", "shared-vps"),
    /no fresh verified capture for listmonk/,
  );
  write({
    ...read(),
    hosts: { ...read().hosts, [SHARED]: { ...read().hosts[SHARED], stale: [] } },
  });
  const timerPreview = await cli("timer", "--enable", "--host", "shared-vps", "--dry-run");
  assert.equal(timerPreview.applied, false);
  assert.match(timerPreview.schedule, /17:00 UTC/);
  const enabled = await cli("timer", "--enable", "--host", "shared-vps");
  assert.equal(enabled.timerEnabled, true);
  assert.equal(enabled.nextRun, "Mon 2026-10-20 17:00:00 UTC");

  // --- remove-host refuses while its policy holds a project ---------------
  await assert.rejects(
    cli("remove-host", "--host", "shared-vps"),
    /shared-vps's policy still holds listmonk/,
  );
  write({ ...read(), hosts: { ...read().hosts, [SHARED]: { installed: true, projects: [] } } });
  const removePreview = await cli("remove-host", "--host", "shared-vps", "--dry-run");
  assert.equal(removePreview.applied, false);
  assert.equal(backupHosts().length, 2);
  await cli("remove-host", "--host", "shared-vps");
  assert.deepEqual(
    backupHosts().map((h) => h.name),
    ["dedicated-vps"],
  );
  await assert.rejects(cli("remove-host", "--host", "dedicated-vps"), /only backup host/);
  // Back to one host: no --host and no lookup needed.
  resetCalls();
  await cli("snapshots", "--project", "chess-app");
  assert.deepEqual(calls(), [{ target: DEDICATED, kind: "snapshots" }]);

  console.log("Backup hosts: migration, selection and cross-host moves passed.");
} finally {
  console.log = originalLog;
  process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
}
