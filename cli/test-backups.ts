import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPlan, exportBackupBundle } from "./src/backups/command.js";
import { collectStatus } from "./src/status.js";
import { configureBackupProvider, backupCredentials } from "./src/backups/provider.js";
import { getConfig } from "./src/config.js";
import { getSecret, setSecret, SECRET_KEYS } from "./src/utils/secrets.js";
import { createBackupProject, registerBackupProject, saveBackupRegistration, shouldRegisterBackups } from "./src/backups/register.js";
import { installBackupHost } from "./src/backups/install.js";

const dir = mkdtempSync(join(tmpdir(), "hatchkit-backups-"));
try {
  const credentialsFile = join(dir, "credentials.json");
  const passwordFile = join(dir, "password");
  writeFileSync(credentialsFile, JSON.stringify({accessKeyId: "a".repeat(32), secretAccessKey: "b".repeat(64)}), {mode: 0o600});
  writeFileSync(passwordFile, "test-recovery-password-long-enough", {mode: 0o600});
  await setSecret(SECRET_KEYS.r2AdminToken, "existing-asset-provisioner");
  const configured = await configureBackupProvider({status: "configured", repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups", host: {transport: "tailscale",target: "root@backup-host",serverUuid: "server-uuid"},autoRegister: true, credentialsFile,passwordFile});
  assert.equal(configured.credentialStore, "OS keychain");
  assert.equal((await backupCredentials()).password, "test-recovery-password-long-enough");
  assert.equal(await getSecret(SECRET_KEYS.r2AdminToken), "existing-asset-provisioner");
  assert.ok(!JSON.stringify(getConfig()).includes("test-recovery-password-long-enough"));
  assert.ok(!JSON.stringify(getConfig()).includes("b".repeat(64)));
  const project = createBackupProject({name: "new-app", managed: [{uuid: "db-uuid", kind: "postgres"}], composeAppUuid: "app-uuid", composeServices: ["server", "redis"]});
  assert.deepEqual(project.sources.map(s => s.selector), [{project: "db-uuid", service: "db-uuid"}, {project: "app-uuid", service: "redis"}]);
  assert.throws(() => createBackupProject({name: "external", managed: []}), /No managed backup sources/);
  assert.ok(shouldRegisterBackups("server-uuid"));
  assert.ok(!shouldRegisterBackups("other-host"));
  assert.equal((await registerBackupProject(project, {serverUuid: "server-uuid", dryRun: true})).applied, false);
  await assert.rejects(registerBackupProject(project, {serverUuid: "other-host", dryRun: true}), /differs/);
  const registration = saveBackupRegistration(project, "server-uuid");
  assert.deepEqual(JSON.parse(readFileSync(registration, "utf8")).project, project);
  assert.equal((await installBackupHost(true)).applied, false);
  writeFileSync(passwordFile, "different-recovery-password-long-enough", {mode: 0o600});
  await assert.rejects(configureBackupProvider({...configured.provider, credentialsFile, passwordFile}), /Recovery password differs/);
  assert.equal((await backupCredentials()).password, "test-recovery-password-long-enough");
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
