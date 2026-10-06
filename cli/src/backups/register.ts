import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig, getConfigPath } from "../config.js";
import { backupProvider } from "./provider.js";
import { hostRegisterProject } from "./sources.js";

export interface BackupSource {
  name: string;
  kind: "postgres" | "mongo" | "redis" | "clickhouse" | "kuma-mariadb" | "files";
  selector?: { container?: string; project?: string; service?: string };
  paths?: string[];
  exclude?: string[];
}
export interface BackupProject {
  name: string;
  keepLast: 3;
  sources: BackupSource[];
}

export function createBackupProject(input: {
  name: string;
  managed: Array<{ uuid: string; kind: "postgres" | "mongo" | "redis" }>;
  composeAppUuid?: string;
  composeServices?: string[];
}): BackupProject {
  const sources: BackupSource[] = input.managed.map((db) => ({
    name: `managed-${db.kind}`,
    kind: db.kind,
    selector: { project: db.uuid, service: db.uuid },
  }));
  if (input.composeAppUuid) {
    for (const kind of ["postgres", "mongo", "redis"] as const) {
      if (input.composeServices?.includes(kind))
        sources.push({
          name: `app-${kind}`,
          kind,
          selector: { project: input.composeAppUuid, service: kind },
        });
    }
  }
  if (!sources.length)
    throw new Error(
      "No managed backup sources found. Register external databases and persistent files explicitly.",
    );
  return { name: input.name, keepLast: 3, sources };
}

export function shouldRegisterBackups(serverUuid: string): boolean {
  const provider = getConfig().providers.backups;
  return (
    provider?.status === "configured" &&
    provider.autoRegister &&
    provider.host.serverUuid === serverUuid
  );
}

export function saveBackupRegistration(project: BackupProject, serverUuid: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(project.name))
    throw new Error("Invalid backup project name.");
  const directory = join(dirname(getConfigPath()), "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${project.name}.json`);
  writeFileSync(path, `${JSON.stringify({ serverUuid, project }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function registerBackupProject(
  project: BackupProject,
  options: { serverUuid?: string; dryRun?: boolean } = {},
) {
  const provider = backupProvider();
  if (options.serverUuid && provider.host.serverUuid !== options.serverUuid)
    throw new Error(
      "Project server differs from the configured backup host. Configure that host before registration.",
    );
  if (options.dryRun) return { project, host: provider.host, applied: false };
  return hostRegisterProject(project);
}
