import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifestWithMigrationInfo } from "../scaffold/manifest.js";
import { configureBackupAlerts } from "./alerts.js";
import { installBackupHost } from "./install.js";
import {
  type BackupHost,
  DEFAULT_BACKUP_SCHEDULE,
  addBackupHost,
  backupHost,
  backupHostExec,
  backupHosts,
  backupProvider,
  configureBackupProvider,
  forgetBackupHost,
} from "./provider.js";
import { backupSnapshots, restoreBackup } from "./recovery.js";
import { registerBackupProject, registeredElsewhere, registrationHost } from "./register.js";
import { backupProjectName, installBackupScripts } from "./scripts.js";
import {
  applyPolicyChange,
  deregisterBackupProject,
  fetchSourceReport,
  hostPolicy,
  hostProjects,
  projectHost,
  updateBackupSource,
} from "./sources.js";

export const BACKUP_USAGE = `Usage:
  hatchkit backup plan [--json]
  hatchkit backup bundle --config <host-config.json> --output <new-directory> [--json]
  hatchkit backup configure --config <provider-config.json> [--json]
  hatchkit backup hosts [--json]
  hatchkit backup add-host --name <name> --target root@<tailscale-host> --server-uuid <coolify-server> [--schedule HH:MM] [--dry-run] [--json]
  hatchkit backup remove-host --host <name> [--dry-run] [--json]
  hatchkit backup status [--project <name>] [--host <name>] [--json]
  hatchkit backup snapshots --project <name> [--host <name>] [--json]
  hatchkit backup restore --project <name> [--snapshot <id>] [--host <name>] [--dry-run] [--json]
  hatchkit backup restore-check [--project <name>] [--host <name>] [--json]
  hatchkit backup scripts [--project <name>] [--dry-run] [--json]
  hatchkit backup install [--host <name>] [--dry-run] [--json]
  hatchkit backup timer (--enable | --disable) [--host <name>] [--dry-run] [--json]
  hatchkit backup run [--host <name>] [--json]
  hatchkit backup alerts --to <email> --from <verified-ses-email> [--host <name>] [--dry-run] [--json]
  hatchkit backup alert-test [--host <name>] [--json]
  hatchkit backup register --config <project-sources.json> [--host <name>] [--replace] [--dry-run] [--json]
  hatchkit backup sources [--project <name>] [--host <name>] [--json]
  hatchkit backup update-source --project <name> --source <source> (--container <name> | --remove) [--host <name>] [--dry-run] [--json]
  hatchkit backup deregister --project <name> [--host <name>] [--dry-run] [--json]

Backup hosts share one R2 bucket and one keychain credential. Each project lives
in exactly one host's policy (one restic repository per project; two hosts
writing it would prune each other's snapshots). --host picks the host. Without
it, a command with --project asks every host which one holds the project;
install, timer, alerts and alert-test need --host once several hosts exist;
status, sources and run cover every host.
hosts lists them. add-host adds one to the local config (no host access);
--schedule sets its daily start in UTC (default ${DEFAULT_BACKUP_SCHEDULE}). remove-host refuses
while the host's policy still holds a project. A config from before multi-host
support (one "host") reads as one host named after its Tailscale hostname.

plan reads the current project's backup intent. It does not claim that a job is installed.
bundle writes the maintained Python runner and systemd installer for an explicit host policy.
plan and bundle do not read credentials or change production.
configure stores backup-bucket keys and the recovery password in the OS keychain.
status reads the configured host through Tailscale; it never falls back to public SSH.
install reads the backup keys from keychain and installs the host runner through Tailscale.
It preserves registered projects and refuses a different recovery password or repository.
It writes the host's schedule into the timer but never enables it.
timer --enable starts the daily schedule once every registered project has a fresh
verified capture (see status); --disable stops it and keeps every snapshot.
run starts a full host backup; inspect status for completion and failures.
restore-check restores the newest verified snapshot of each project into disposable,
network-less containers on the host and checks it. Production is not touched.
alerts uses the existing SES keychain credential to configure failure/overdue email alerts.
alert-test sends a test email to the configured recipient without triggering a backup failure.

sources resolves every registered source against the host's running containers
(read-only) and prints the exact fix for each one that moved or was removed.
status includes the same check. A missing source still fails that project's run:
the host cannot tell a removed database from a crashed one.
update-source points one source at another running container of the same engine,
or removes it. deregister drops a project from the schedule; snapshots stay in the
bucket. register --replace swaps an existing policy on the same host. register on
another host moves the project: it is added there and removed from the old host in
the same step, and the add is undone if the old host's policy changed meanwhile.
All of them refuse when the host policy changed since it was read.
hatchkit destroy and migrate-runtime --cleanup remove sources of deleted resources.

snapshots lists verified recovery points, newest first.
restore selects a verified snapshot and restores into retained isolated containers and
private files on the backup host. It never overwrites production. --dry-run previews.
scripts adds missing backup:status, backup:list and backup:restore package scripts.
Existing custom scripts are preserved. Commands require Hatchkit on PATH.

The runner captures native PostgreSQL, MongoDB, ClickHouse and Redis backups and
SQLite-safe file copies. It encrypts each project with restic, downloads and verifies
the new archive, then retains the latest three snapshots. See the bundle README.
`;

export function backupPlan(cwd: string) {
  const manifest = readManifestWithMigrationInfo(cwd)?.manifest;
  if (!manifest) throw new Error("No .hatchkit.json found in the current directory.");
  return {
    project: manifest.name,
    policy: manifest.backups ?? null,
    installed: "unknown",
    providerConfigured: !!getBackupProviderOrNull(),
    nextStep: "Register the project's live database and file sources in the host backup config.",
  };
}

export function exportBackupBundle(configPath: string, outputPath: string) {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (
    typeof config.repositoryBase !== "string" ||
    !config.repositoryBase.startsWith("s3:https://") ||
    typeof config.credentialsFile !== "string" ||
    typeof config.passwordFile !== "string" ||
    !Array.isArray(config.projects) ||
    config.projects.length === 0
  ) {
    throw new Error(
      "Host config requires repositoryBase, credentialsFile, passwordFile, and projects.",
    );
  }
  const endpoint = new URL(config.repositoryBase.slice(3));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Repository URL must not contain credentials, a query, or a fragment.");
  }
  if (existsSync(outputPath))
    throw new Error("Output directory already exists; choose a new path.");
  const templateDir = fileURLToPath(new URL("../templates/backups/", import.meta.url));
  mkdirSync(outputPath, { recursive: true, mode: 0o700 });
  cpSync(templateDir, outputPath, {
    recursive: true,
    filter: (path) => !path.includes("__pycache__"),
  });
  writeFileSync(resolve(outputPath, "config.json"), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    directory: outputPath,
    projects: config.projects.length,
    installed: false,
  };
}

function getBackupProviderOrNull() {
  try {
    return backupProvider();
  } catch {
    return null;
  }
}

const TIMER_ENABLE = `systemctl enable --now hatchkit-backups.timer >/dev/null && systemctl show --property=NextElapseUSecRealtime --value hatchkit-backups.timer`;
const TIMER_DISABLE = `systemctl disable --now hatchkit-backups.timer >/dev/null && systemctl is-enabled hatchkit-backups.timer || true`;

/** Runner status of one host, never throwing: a status read across hosts
 *  reports the host it could not reach next to the ones it could. */
async function hostStatus(host: BackupHost, project?: string) {
  const row: Record<string, unknown> = {
    name: host.name,
    target: host.target,
    serverUuid: host.serverUuid,
    schedule: `${host.schedule ?? DEFAULT_BACKUP_SCHEDULE} UTC`,
  };
  try {
    row.status = JSON.parse(
      await backupHostExec(
        host,
        `python3 /opt/hatchkit-backups/runner.py status${project ? ` --project ${project}` : ""}`,
      ),
    );
  } catch (error) {
    row.error = (error as Error).message;
  }
  try {
    const report = await fetchSourceReport(project, host.name);
    row.sources = { checked: report.sources.length, stale: report.stale };
  } catch (error) {
    row.sources = { error: (error as Error).message };
  }
  return row;
}

/** Each JSON line restore-check.py printed. */
function jsonLines(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
}

const HOST_COMMANDS = new Set([
  "status",
  "snapshots",
  "restore",
  "restore-check",
  "install",
  "timer",
  "run",
  "alerts",
  "alert-test",
  "register",
  "sources",
  "update-source",
  "deregister",
  "remove-host",
]);

export async function runBackupCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const subcommand = args[0] ?? "plan";
  const flags = new Map<string, string>();
  let dryRun = false;
  const switches = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") {
      continue;
    }
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (["--remove", "--replace", "--enable", "--disable"].includes(flag)) {
      switches.add(flag);
      continue;
    }
    if (
      [
        "--config",
        "--output",
        "--to",
        "--from",
        "--project",
        "--snapshot",
        "--source",
        "--container",
        "--host",
        "--name",
        "--target",
        "--server-uuid",
        "--schedule",
      ].includes(flag) &&
      args[i + 1]?.startsWith("--") === false
    ) {
      flags.set(flag, args[++i]);
    } else {
      throw new Error(`Unknown or incomplete backup option: ${flag}`);
    }
  }
  let result: unknown;
  if (
    dryRun &&
    ![
      "register",
      "install",
      "timer",
      "alerts",
      "restore",
      "scripts",
      "update-source",
      "deregister",
      "add-host",
      "remove-host",
    ].includes(subcommand)
  )
    throw new Error(
      "--dry-run applies to backup register, update-source, deregister, install, timer, alerts, restore, scripts, add-host or remove-host.",
    );
  if (switches.has("--remove") && subcommand !== "update-source")
    throw new Error("--remove applies to backup update-source.");
  if (switches.has("--replace") && subcommand !== "register")
    throw new Error("--replace applies to backup register.");
  if ((switches.has("--enable") || switches.has("--disable")) && subcommand !== "timer")
    throw new Error("--enable and --disable apply to backup timer.");
  const host = flags.get("--host");
  if (host && !HOST_COMMANDS.has(subcommand))
    throw new Error(`--host does not apply to backup ${subcommand}.`);
  // Option count without --host, which every host command accepts.
  const given = flags.size - (host ? 1 : 0);
  const project = flags.get("--project");
  if (project) backupProjectName(project);
  if (subcommand === "snapshots" && project && given === 1) {
    const on = await projectHost(project, host);
    result = { project, host: on.name, snapshots: await backupSnapshots(project, on) };
  } else if (subcommand === "restore" && project && given === (flags.has("--snapshot") ? 2 : 1)) {
    result = await restoreBackup(
      project,
      flags.get("--snapshot"),
      dryRun,
      args.includes("--json"),
      host,
    );
  } else if (subcommand === "restore-check" && given === (project ? 1 : 0)) {
    const on = project ? await projectHost(project, host) : backupHost(host);
    const stdout = await backupHostExec(
      on,
      `python3 /opt/hatchkit-backups/restore-check.py${project ? ` --project ${project}` : ""}`,
      undefined,
      7_200_000,
    );
    result = { host: on.name, results: jsonLines(stdout), productionChanged: false };
  } else if (subcommand === "scripts" && flags.size === (project ? 1 : 0)) {
    const name = project ?? readManifestWithMigrationInfo(cwd)?.manifest.name;
    if (!name) throw new Error("Specify --project <name> or run from a Hatchkit project.");
    result = installBackupScripts(cwd, name, dryRun);
  } else if (subcommand === "plan" && flags.size === 0) {
    result = backupPlan(cwd);
  } else if (subcommand === "configure" && flags.size === 1 && flags.has("--config")) {
    result = await configureBackupProvider(
      JSON.parse(readFileSync(resolve(cwd, flags.get("--config")!), "utf8")),
    );
  } else if (subcommand === "hosts" && flags.size === 0) {
    result = {
      hosts: backupHosts().map((h) => ({ ...h, schedule: h.schedule ?? DEFAULT_BACKUP_SCHEDULE })),
    };
  } else if (
    subcommand === "add-host" &&
    flags.has("--name") &&
    flags.has("--target") &&
    flags.has("--server-uuid") &&
    flags.size === (flags.has("--schedule") ? 4 : 3)
  ) {
    result = addBackupHost({
      name: flags.get("--name")!,
      target: flags.get("--target")!,
      serverUuid: flags.get("--server-uuid")!,
      schedule: flags.get("--schedule"),
      dryRun,
    });
  } else if (subcommand === "remove-host" && host && given === 0) {
    const target = backupHost(host);
    if (backupHosts().length === 1)
      throw new Error(`${host} is the only backup host. Configure another one first.`);
    const held = await hostProjects(target);
    if (held.projects.length)
      throw new Error(
        `${host}'s policy still holds ${held.projects.map((p) => p.name).join(", ")}. Register them on another host (that moves them) or deregister them first.`,
      );
    if (!dryRun) forgetBackupHost(host);
    result = {
      host: target,
      installed: held.installed,
      applied: !dryRun,
      leftOnHost: `The runner, its timer and the root-only credential files stay on ${target.target}. Stop its timer before removing the host: hatchkit backup timer --disable --host ${host}`,
    };
  } else if (subcommand === "install" && given === 0) {
    result = await installBackupHost(dryRun, host);
  } else if (
    subcommand === "timer" &&
    given === 0 &&
    switches.has("--enable") !== switches.has("--disable")
  ) {
    const on = backupHost(host);
    const enable = switches.has("--enable");
    const schedule = `daily ${on.schedule ?? DEFAULT_BACKUP_SCHEDULE} UTC (+ up to 15 min)`;
    if (enable) {
      // The README's order: verified captures and a restore drill before the schedule.
      const status = JSON.parse(
        await backupHostExec(on, "python3 /opt/hatchkit-backups/runner.py status"),
      ) as { healthy?: boolean; results?: { project: string; ok?: boolean; stale?: boolean }[] };
      const pending = (status.results ?? []).filter((r) => !r.ok || r.stale).map((r) => r.project);
      if (!status.results?.length)
        throw new Error(`${on.name} has no registered project yet; register and run one first.`);
      if (pending.length)
        throw new Error(
          `${on.name} has no fresh verified capture for ${pending.join(", ")}. Run hatchkit backup run --host ${on.name}, check hatchkit backup status --host ${on.name}, then enable the timer.`,
        );
    }
    if (dryRun) result = { host: on.name, schedule, enable, applied: false };
    else {
      const out = (await backupHostExec(on, enable ? TIMER_ENABLE : TIMER_DISABLE)).trim();
      result = enable
        ? { host: on.name, schedule, timerEnabled: true, nextRun: out, applied: true }
        : { host: on.name, timerEnabled: false, state: out, snapshotsKept: true, applied: true };
    }
  } else if (subcommand === "alerts" && given === 2 && flags.has("--to") && flags.has("--from")) {
    result = await configureBackupAlerts(flags.get("--to")!, flags.get("--from")!, dryRun, host);
  } else if (subcommand === "alert-test" && given === 0) {
    const on = backupHost(host);
    result = {
      host: on.name,
      ...JSON.parse(await backupHostExec(on, "python3 /opt/hatchkit-backups/alerts.py test")),
    };
  } else if (subcommand === "run" && given === 0) {
    const hosts = host ? [backupHost(host)] : backupHosts();
    for (const on of hosts)
      await backupHostExec(on, "systemctl start --no-block hatchkit-backups.service");
    result = {
      requested: true,
      hosts: hosts.map((on) => on.name),
      nextStep: "hatchkit backup status --json",
    };
  } else if (subcommand === "status" && given === (project ? 1 : 0)) {
    const hosts = project
      ? [await projectHost(project, host)]
      : host
        ? [backupHost(host)]
        : backupHosts();
    const rows = await Promise.all(hosts.map((on) => hostStatus(on, project)));
    result = { provider: backupProvider(), hosts: rows };
    if (rows.some((row) => row.error)) process.exitCode = 1;
  } else if (subcommand === "sources" && given === (project ? 1 : 0)) {
    const report = await fetchSourceReport(project, host);
    result = report;
    if (report.stale.length || report.errors.length) process.exitCode = 1;
  } else if (
    subcommand === "update-source" &&
    project &&
    flags.has("--source") &&
    given === (flags.has("--container") ? 3 : 2)
  ) {
    result = await updateBackupSource({
      project,
      source: flags.get("--source")!,
      container: flags.get("--container"),
      remove: switches.has("--remove"),
      host,
      dryRun,
    });
  } else if (subcommand === "deregister" && project && given === 1) {
    result = await deregisterBackupProject({ project, host, dryRun });
  } else if (subcommand === "register" && given === 1 && flags.has("--config")) {
    const input = JSON.parse(readFileSync(resolve(cwd, flags.get("--config")!), "utf8"));
    if (!input.serverUuid || !input.project)
      throw new Error("Registration config requires serverUuid and project.");
    if (switches.has("--replace")) {
      const on = registrationHost({ serverUuid: input.serverUuid, host });
      const elsewhere = await registeredElsewhere(input.project.name, on);
      if (elsewhere.length)
        throw new Error(
          `${input.project.name} is registered on ${elsewhere.map((f) => f.host.name).join(", ")}, not only on ${on.name}. --replace swaps a policy on one host; to move the project, run register without --replace.`,
        );
      const before = await hostPolicy(on, input.project.name);
      const change = {
        project: input.project.name,
        action: "replace" as const,
        before,
        after: input.project,
        removedSources: before.sources
          .map((s) => s.name)
          .filter((name) => !input.project.sources?.some((s: { name: string }) => s.name === name)),
      };
      result = dryRun
        ? { ...change, backupHost: on.name, applied: false }
        : {
            ...change,
            backupHost: on.name,
            applied: true,
            host: await applyPolicyChange(on, change),
          };
    } else {
      result = await registerBackupProject(input.project, {
        serverUuid: input.serverUuid,
        host,
        dryRun,
      });
    }
  } else if (subcommand === "bundle" && flags.has("--config") && flags.has("--output")) {
    result = exportBackupBundle(
      resolve(cwd, flags.get("--config")!),
      resolve(cwd, flags.get("--output")!),
    );
  } else {
    throw new Error(BACKUP_USAGE);
  }
  console.log(JSON.stringify(result, null, 2));
  if (subcommand === "restore" && (result as { ok?: boolean }).ok === false) process.exitCode = 1;
}
