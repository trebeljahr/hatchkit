import { confirm, select } from "@inquirer/prompts";
import { backupHostExec } from "./provider.js";
import { backupProjectName } from "./scripts.js";

export interface BackupSnapshot {
  id: string;
  time: string;
}

export async function backupSnapshots(project: string): Promise<BackupSnapshot[]> {
  backupProjectName(project);
  const values: unknown = JSON.parse(
    await backupHostExec(
      `python3 /opt/hatchkit-backups/recovery.py snapshots --project ${project}`,
    ),
  );
  if (
    !Array.isArray(values) ||
    values.some(
      (value) =>
        !value ||
        !/^[a-f0-9]{64}$/.test(value.id) ||
        typeof value.time !== "string" ||
        !Number.isFinite(Date.parse(value.time)),
    )
  ) {
    throw new Error("Invalid snapshot list returned by backup host.");
  }
  return values.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export function selectBackupSnapshot(snapshots: BackupSnapshot[], id: string): BackupSnapshot {
  if (!/^[a-f0-9]{8,64}$/.test(id))
    throw new Error("Use a verified snapshot ID (8–64 hex characters).");
  const matches = snapshots.filter((snapshot) => snapshot.id.startsWith(id));
  if (matches.length !== 1) throw new Error("Snapshot is missing, unverified, or ambiguous.");
  return matches[0];
}

export async function restoreBackup(
  project: string,
  id: string | undefined,
  dryRun: boolean,
  json: boolean,
) {
  let selectedId = id;
  const snapshots = await backupSnapshots(project);
  if (!snapshots.length) throw new Error(`No verified backups available for ${project}.`);
  if (!selectedId) {
    if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Specify --snapshot <id> for non-interactive recovery. Use backup snapshots to list IDs.",
      );
    }
    selectedId = await select({
      message: `Choose a verified backup for ${project}`,
      choices: snapshots.map((snapshot) => ({
        name: `${new Date(snapshot.time).toLocaleString()} · ${snapshot.id.slice(0, 8)}`,
        value: snapshot.id,
      })),
    });
  }
  const snapshot = selectBackupSnapshot(snapshots, selectedId);
  const plan = {
    project,
    snapshot: snapshot.id,
    time: snapshot.time,
    mode: "isolated",
    productionChanged: false,
    destination: "/var/lib/hatchkit-backups/recovery/<new-private-directory>",
    nextStep: "Inspect recovered data and engine checks before planning a production cutover.",
  };
  if (dryRun) return { ...plan, applied: false };
  if (!json && process.stdin.isTTY && process.stdout.isTTY) {
    const approved = await confirm({
      message:
        "Restore into retained isolated containers and private files on the backup host? Production stays unchanged.",
      default: false,
    });
    if (!approved) return { ...plan, applied: false, cancelled: true };
  }
  return JSON.parse(
    await backupHostExec(
      `python3 /opt/hatchkit-backups/recovery.py restore --project ${project} --snapshot ${snapshot.id}`,
      undefined,
      7_200_000,
    ),
  );
}
