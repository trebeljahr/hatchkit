import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifestWithMigrationInfo } from "../scaffold/manifest.js";
import { configureBackupAlerts } from "./alerts.js";
import { installBackupHost } from "./install.js";
import { backupHostExec, backupProvider, configureBackupProvider } from "./provider.js";
import { backupSnapshots, restoreBackup } from "./recovery.js";
import { registerBackupProject } from "./register.js";
import { backupProjectName, installBackupScripts } from "./scripts.js";
import {
  applyPolicyChange,
  deregisterBackupProject,
  fetchSourceReport,
  hostPolicy,
  updateBackupSource,
} from "./sources.js";

export const BACKUP_USAGE = `Usage:
  hatchkit backup plan [--json]
  hatchkit backup bundle --config <host-config.json> --output <new-directory> [--json]
  hatchkit backup configure --config <provider-config.json> [--json]
  hatchkit backup status [--project <name>] [--json]
  hatchkit backup snapshots --project <name> [--json]
  hatchkit backup restore --project <name> [--snapshot <id>] [--dry-run] [--json]
  hatchkit backup scripts [--project <name>] [--dry-run] [--json]
  hatchkit backup install [--dry-run] [--json]
  hatchkit backup run [--json]
  hatchkit backup alerts --to <email> --from <verified-ses-email> [--dry-run] [--json]
  hatchkit backup alert-test [--json]
  hatchkit backup register --config <project-sources.json> [--replace] [--dry-run] [--json]
  hatchkit backup sources [--project <name>] [--json]
  hatchkit backup update-source --project <name> --source <source> (--container <name> | --remove) [--dry-run] [--json]
  hatchkit backup deregister --project <name> [--dry-run] [--json]

plan reads the current project's backup intent. It does not claim that a job is installed.
bundle writes the maintained Python runner and systemd installer for an explicit host policy.
plan and bundle do not read credentials or change production.
configure stores backup-bucket keys and the recovery password in the OS keychain.
status reads the configured host through Tailscale; it never falls back to public SSH.
install reads the backup keys from keychain and installs the host runner through Tailscale.
It preserves registered projects and refuses a different recovery password or repository.
run starts a full host backup; inspect status for completion and failures.
alerts uses the existing SES keychain credential to configure failure/overdue email alerts.
alert-test sends a test email to the configured recipient without triggering a backup failure.

sources resolves every registered source against the host's running containers
(read-only) and prints the exact fix for each one that moved or was removed.
status includes the same check. A missing source still fails that project's run:
the host cannot tell a removed database from a crashed one.
update-source points one source at another running container of the same engine,
or removes it. deregister drops a project from the schedule; snapshots stay in the
bucket. register --replace swaps an existing policy. All three refuse when the host
policy changed since it was read.
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
    if (flag === "--remove" || flag === "--replace") {
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
      "alerts",
      "restore",
      "scripts",
      "update-source",
      "deregister",
    ].includes(subcommand)
  )
    throw new Error(
      "--dry-run applies to backup register, update-source, deregister, install, alerts, restore, or scripts.",
    );
  if (switches.has("--remove") && subcommand !== "update-source")
    throw new Error("--remove applies to backup update-source.");
  if (switches.has("--replace") && subcommand !== "register")
    throw new Error("--replace applies to backup register.");
  const project = flags.get("--project");
  if (project) backupProjectName(project);
  if (subcommand === "snapshots" && project && flags.size === 1) {
    result = { project, snapshots: await backupSnapshots(project) };
  } else if (
    subcommand === "restore" &&
    project &&
    flags.size === (flags.has("--snapshot") ? 2 : 1)
  ) {
    result = await restoreBackup(project, flags.get("--snapshot"), dryRun, args.includes("--json"));
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
  } else if (subcommand === "install" && flags.size === 0) {
    result = await installBackupHost(dryRun);
  } else if (
    subcommand === "alerts" &&
    flags.size === 2 &&
    flags.has("--to") &&
    flags.has("--from")
  ) {
    result = await configureBackupAlerts(flags.get("--to")!, flags.get("--from")!, dryRun);
  } else if (subcommand === "alert-test" && flags.size === 0) {
    result = JSON.parse(await backupHostExec("python3 /opt/hatchkit-backups/alerts.py test"));
  } else if (subcommand === "run" && flags.size === 0) {
    await backupHostExec("systemctl start --no-block hatchkit-backups.service");
    result = { requested: true, nextStep: "hatchkit backup status --json" };
  } else if (subcommand === "status" && flags.size === (project ? 1 : 0)) {
    const host = JSON.parse(
      await backupHostExec(
        `python3 /opt/hatchkit-backups/runner.py status${project ? ` --project ${project}` : ""}`,
      ),
    );
    let sources: unknown;
    try {
      const report = await fetchSourceReport(project);
      sources = { checked: report.sources.length, stale: report.stale };
    } catch (error) {
      sources = { error: (error as Error).message };
    }
    result = { provider: backupProvider(), host, sources };
  } else if (subcommand === "sources" && flags.size === (project ? 1 : 0)) {
    const report = await fetchSourceReport(project);
    result = report;
    if (report.stale.length) process.exitCode = 1;
  } else if (
    subcommand === "update-source" &&
    project &&
    flags.has("--source") &&
    flags.size === (flags.has("--container") ? 3 : 2)
  ) {
    result = await updateBackupSource({
      project,
      source: flags.get("--source")!,
      container: flags.get("--container"),
      remove: switches.has("--remove"),
      dryRun,
    });
  } else if (subcommand === "deregister" && project && flags.size === 1) {
    result = await deregisterBackupProject({ project, dryRun });
  } else if (subcommand === "register" && flags.size === 1 && flags.has("--config")) {
    const input = JSON.parse(readFileSync(resolve(cwd, flags.get("--config")!), "utf8"));
    if (!input.serverUuid || !input.project)
      throw new Error("Registration config requires serverUuid and project.");
    if (switches.has("--replace")) {
      if (backupProvider().host.serverUuid !== input.serverUuid)
        throw new Error(
          "Project server differs from the configured backup host. Configure that host before registration.",
        );
      const before = await hostPolicy(input.project.name);
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
        ? { ...change, applied: false }
        : { ...change, applied: true, host: await applyPolicyChange(change) };
    } else {
      result = await registerBackupProject(input.project, {
        serverUuid: input.serverUuid,
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
