import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackupCommand } from "./src/backups/command.js";
import { backupSnapshots, restoreBackup, selectBackupSnapshot } from "./src/backups/recovery.js";
import { backupProjectName, installBackupScripts } from "./src/backups/scripts.js";
import { getStore } from "./src/config.js";

const root = mkdtempSync(join(tmpdir(), "backup-recovery-tests-"));
const originalPath = process.env.PATH;
const originalLog = console.log;
try {
  const pkg = join(root, "package.json");
  writeFileSync(
    pkg,
    JSON.stringify({ scripts: { "backup:restore": "custom-restore", test: "keep" } }),
  );
  const before = readFileSync(pkg, "utf8");
  const preview = installBackupScripts(root, "tracktime", true);
  assert.deepEqual(preview.added, ["backup:status", "backup:list"]);
  assert.deepEqual(preview.conflicts, ["backup:restore"]);
  assert.equal(readFileSync(pkg, "utf8"), before);
  installBackupScripts(root, "tracktime");
  const scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts;
  assert.equal(scripts["backup:restore"], "custom-restore");
  assert.equal(scripts["backup:list"], "hatchkit backup snapshots --project tracktime");
  assert.deepEqual(installBackupScripts(root, "tracktime").added, []);
  for (const name of ["../app", "app;echo", "app\n", "", "$(command)"]) {
    assert.throws(() => backupProjectName(name));
  }
  const values = [
    { id: "a".repeat(64), time: "2026-10-03T00:00:00Z" },
    { id: "b".repeat(64), time: "2026-10-04T00:00:00Z" },
  ];
  assert.equal(selectBackupSnapshot(values, "aaaaaaaa").id, values[0].id);
  assert.throws(() => selectBackupSnapshot(values, "latest"));
  assert.throws(() => selectBackupSnapshot(values, "cccccccc"));
  assert.throws(() => selectBackupSnapshot([...values, values[0]], "aaaaaaaa"));
  getStore().set("providers.backups", {
    status: "configured",
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    host: { transport: "tailscale", target: "root@fixture", serverUuid: "fixture" },
  });
  // Real child-process boundary, fake SSH. No network or keychain reads.
  const calls = join(root, "calls.jsonl");
  const fake = join(root, "tailscale");
  writeFileSync(
    fake,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconst command = process.argv.at(-1);\nif(command.includes('recovery.py snapshots')) console.log(${JSON.stringify(JSON.stringify(values))});\nelse if(command.includes('runner.py status')) console.log('{"results":[{"project":"tracktime"}]}');\nelse console.log('{"ok":true,"productionChanged":false}');\n`,
  );
  chmodSync(fake, 0o700);
  process.env.PATH = `${root}:${originalPath}`;
  assert.equal((await backupSnapshots("tracktime"))[0].id, values[1].id);
  await restoreBackup("tracktime", "aaaaaaaa", true, true);
  assert.ok(!readFileSync(calls, "utf8").includes("recovery.py restore"));
  await assert.rejects(restoreBackup("tracktime", undefined, false, true), /Specify --snapshot/);
  const restored = await restoreBackup("tracktime", "aaaaaaaa", false, true);
  assert.equal(restored.productionChanged, false);
  assert.ok(readFileSync(calls, "utf8").includes(`--snapshot ${values[0].id}`));
  console.log = () => {};
  await runBackupCommand(["status", "--project", "tracktime", "--json"], root);
  assert.ok(readFileSync(calls, "utf8").includes("runner.py status --project tracktime"));
  await assert.rejects(runBackupCommand(["restore", "--project", "a;bad"], root));
  console.log = originalLog;
  const runtime = spawnSync("python3", ["test-backup-recovery.py"], {
    stdio: "inherit",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(runtime.status, 0);
  console.log("Backup package scripts, verified selection and isolated recovery checks passed.");
} finally {
  console.log = originalLog;
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
}
