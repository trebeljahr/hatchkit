import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig, getConfigPath } from "../config.js";
import { type BackupHost, backupHost, backupHostForServer, backupHosts } from "./provider.js";
import {
  type ProjectLocation,
  applyPolicyChange,
  hostRegisterProject,
  locateBackupProject,
  policyWithout,
} from "./sources.js";

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
  if (provider?.status !== "configured" || !provider.autoRegister) return false;
  try {
    return !!backupHostForServer(serverUuid);
  } catch {
    return false;
  }
}

/** The host a registration targets: `--host`, the host of the project's
 *  Coolify server, or the only host. */
export function registrationHost(options: { serverUuid?: string; host?: string }): BackupHost {
  const differs =
    "Project server differs from the configured backup hosts. Configure that host before registration (hatchkit backup add-host).";
  if (options.host) {
    const host = backupHost(options.host);
    if (options.serverUuid && host.serverUuid !== options.serverUuid)
      throw new Error(
        `Project server differs from backup host ${host.name}'s Coolify server. Pass the host that runs the project.`,
      );
    return host;
  }
  if (options.serverUuid) {
    const host = backupHostForServer(options.serverUuid);
    if (!host) throw new Error(differs);
    return host;
  }
  return backupHost();
}

/** Other hosts holding `project`. With one host there is nothing to ask. */
export async function registeredElsewhere(
  project: string,
  host: BackupHost,
): Promise<ProjectLocation[]> {
  if (backupHosts().length === 1) return [];
  return (await locateBackupProject(project)).filter((found) => found.host.name !== host.name);
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

/**
 * Register `project` on its host. When another host's policy holds the
 * project, this is a move: add it here, then remove it there with the
 * policy read before the add as the guard. If that host's policy changed
 * in between, the add is undone and nothing moved.
 */
export async function registerBackupProject(
  project: BackupProject,
  options: { serverUuid?: string; host?: string; dryRun?: boolean } = {},
) {
  const host = registrationHost(options);
  const elsewhere = await registeredElsewhere(project.name, host);
  const movedFrom = elsewhere.map((found) => found.host.name);
  if (options.dryRun) return { project, host, movedFrom, applied: false };
  const added = await hostRegisterProject(host, project);
  for (const found of elsewhere) {
    const change = policyWithout(
      found.policy,
      found.policy.sources.map((source) => source.name),
    );
    try {
      await applyPolicyChange(found.host, change);
    } catch (error) {
      let undo = `${host.name} held the same policy before, so it stays registered on both hosts. Deregister it from one: hatchkit backup deregister --project ${project.name} --host <name> --dry-run`;
      if (!added.existing) {
        try {
          await applyPolicyChange(
            host,
            policyWithout(
              project,
              project.sources.map((s) => s.name),
            ),
          );
          undo = `The registration on ${host.name} was undone; nothing moved. Re-run to review ${found.host.name}'s current policy.`;
        } catch (undoError) {
          undo = `Undoing the registration on ${host.name} failed too (${(undoError as Error).message}), so ${project.name} is registered on both hosts. Deregister it from one: hatchkit backup deregister --project ${project.name} --host <name> --dry-run`;
        }
      }
      throw new Error(
        `Couldn't remove ${project.name} from ${found.host.name}: ${(error as Error).message} ${undo}`,
      );
    }
  }
  return { ...added, host: host.name, movedFrom, applied: true };
}
