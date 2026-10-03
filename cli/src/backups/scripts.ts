import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function backupProjectName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(name)) {
    throw new Error("Backup project names must contain lowercase letters, digits, - or _.");
  }
  return name;
}

/** Add only missing scripts. Never overwrite a project's custom recovery command. */
export function installBackupScripts(directory: string, project: string, dryRun = false) {
  backupProjectName(project);
  const path = join(directory, "package.json");
  if (!existsSync(path)) throw new Error("No package.json found in the project directory.");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.scripts ??= {};
  const added: string[] = [];
  const conflicts: string[] = [];
  for (const [name, command] of Object.entries({
    "backup:status": "status",
    "backup:list": "snapshots",
    "backup:restore": "restore",
  })) {
    const value = `hatchkit backup ${command} --project ${project}`;
    if (Object.hasOwn(pkg.scripts, name)) {
      if (pkg.scripts[name] !== value) conflicts.push(name);
    } else {
      pkg.scripts[name] = value;
      added.push(name);
    }
  }
  if (!dryRun && added.length) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return { project, added, conflicts, applied: !dryRun && added.length > 0 };
}
