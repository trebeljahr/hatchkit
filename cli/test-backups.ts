import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPlan, exportBackupBundle } from "./src/backups/command.js";
import { collectStatus } from "./src/status.js";

const dir = mkdtempSync(join(tmpdir(), "hatchkit-backups-"));
try {
  const policy = { provider: "r2", schedule: "daily", keepLast: 3 };
  writeFileSync(join(dir, ".hatchkit.json"), JSON.stringify({
    version: 2, name: "demo", features: [], backups: policy,
  }));
  assert.deepEqual(backupPlan(dir).policy, policy);
  assert.equal(backupPlan(dir).installed, "unknown");
  assert.deepEqual(collectStatus(dir).project?.backups, policy);
  assert.ok(collectStatus(dir).suggestions.some((item) => item.command === "hatchkit backup plan --json"));
  const config = join(dir, "config.json");
  const value = {
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    credentialsFile: "/etc/hatchkit-backups/credentials.json",
    passwordFile: "/etc/hatchkit-backups/password",
    projects: [{ name: "demo", sources: [{ name: "uploads", kind: "files", paths: ["/srv/data"] }] }],
  };
  writeFileSync(config, JSON.stringify(value));
  const output = join(dir, "bundle");
  assert.equal(exportBackupBundle(config, output).installed, false);
  assert.ok(existsSync(join(output, "runner.py")));
  assert.equal(JSON.parse(readFileSync(join(output, "config.json"), "utf8")).projects[0].name, "demo");
  assert.throws(() => exportBackupBundle(config, output), /already exists/);
  value.repositoryBase = "s3:https://user:secret@account.r2.cloudflarestorage.com/backups";
  writeFileSync(config, JSON.stringify(value));
  assert.throws(() => exportBackupBundle(config, join(dir, "unsafe")), /credentials/);
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "backup", "bundle", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hatchkit backup bundle/);
  const runtime = spawnSync("python3", ["test-backup-runner.py"], { stdio: "inherit" });
  assert.equal(runtime.status, 0);
  console.log("Backup export safety and runtime recovery checks passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
