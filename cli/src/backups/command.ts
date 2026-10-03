import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifestWithMigrationInfo } from "../scaffold/manifest.js";
import { installBackupHost } from "./install.js";
import { backupHostExec, backupProvider, configureBackupProvider } from "./provider.js";
import { registerBackupProject } from "./register.js";

export const BACKUP_USAGE = `Usage:
  hatchkit backup plan [--json]
  hatchkit backup bundle --config <host-config.json> --output <new-directory> [--json]
  hatchkit backup configure --config <provider-config.json> [--json]
  hatchkit backup status [--json]
  hatchkit backup install [--dry-run] [--json]
  hatchkit backup run [--json]
  hatchkit backup register --config <project-sources.json> [--dry-run] [--json]

plan reads the current project's backup intent. It does not claim that a job is installed.
bundle writes the maintained Python runner and systemd installer for an explicit host policy.
plan and bundle do not read credentials or change production.
configure stores backup-bucket keys and the recovery password in the OS keychain.
status reads the configured host through Tailscale; it never falls back to public SSH.
install reads the backup keys from keychain and installs the host runner through Tailscale.
It preserves registered projects and refuses a different recovery password or repository.
run starts a full host backup; inspect status for completion and failures.

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
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") {
      continue;
    }
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if ((flag === "--config" || flag === "--output") && args[i + 1]?.startsWith("--") === false) {
      flags.set(flag, args[++i]);
    } else {
      throw new Error(`Unknown or incomplete backup option: ${flag}`);
    }
  }
  let result: unknown;
  if (dryRun && !["register", "install"].includes(subcommand))
    throw new Error("--dry-run applies to backup register or install.");
  if (subcommand === "plan" && flags.size === 0) {
    result = backupPlan(cwd);
  } else if (subcommand === "configure" && flags.size === 1 && flags.has("--config")) {
    result = await configureBackupProvider(
      JSON.parse(readFileSync(resolve(cwd, flags.get("--config")!), "utf8")),
    );
  } else if (subcommand === "install" && flags.size === 0) {
    result = await installBackupHost(dryRun);
  } else if (subcommand === "run" && flags.size === 0) {
    await backupHostExec("systemctl start --no-block hatchkit-backups.service");
    result = { requested: true, nextStep: "hatchkit backup status --json" };
  } else if (subcommand === "status" && flags.size === 0) {
    result = {
      provider: backupProvider(),
      host: JSON.parse(await backupHostExec("python3 /opt/hatchkit-backups/runner.py status")),
    };
  } else if (subcommand === "register" && flags.size === 1 && flags.has("--config")) {
    const input = JSON.parse(readFileSync(resolve(cwd, flags.get("--config")!), "utf8"));
    if (!input.serverUuid || !input.project)
      throw new Error("Registration config requires serverUuid and project.");
    result = await registerBackupProject(input.project, { serverUuid: input.serverUuid, dryRun });
  } else if (subcommand === "bundle" && flags.has("--config") && flags.has("--output")) {
    result = exportBackupBundle(
      resolve(cwd, flags.get("--config")!),
      resolve(cwd, flags.get("--output")!),
    );
  } else {
    throw new Error(BACKUP_USAGE);
  }
  console.log(JSON.stringify(result, null, 2));
}
