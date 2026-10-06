import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureBackupAlerts } from "./src/backups/alerts.js";
import { backupPlan, exportBackupBundle } from "./src/backups/command.js";
import { installBackupHost } from "./src/backups/install.js";
import { backupCredentials, configureBackupProvider } from "./src/backups/provider.js";
import {
  createBackupProject,
  registerBackupProject,
  saveBackupRegistration,
  shouldRegisterBackups,
} from "./src/backups/register.js";
import {
  type SourceRow,
  attachFixes,
  policyWithout,
  sourceReferences,
  updateBackupSource,
} from "./src/backups/sources.js";
import { getConfig } from "./src/config.js";
import { collectStatus } from "./src/status.js";
import { SECRET_KEYS, getSecret, setSecret } from "./src/utils/secrets.js";

const dir = mkdtempSync(join(tmpdir(), "hatchkit-backups-"));
try {
  const credentialsFile = join(dir, "credentials.json");
  const passwordFile = join(dir, "password");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      accessKeyId: "a".repeat(32),
      secretAccessKey: "b".repeat(64),
    }),
    { mode: 0o600 },
  );
  writeFileSync(passwordFile, "test-recovery-password-long-enough", {
    mode: 0o600,
  });
  await setSecret(SECRET_KEYS.r2AdminToken, "existing-asset-provisioner");
  const configured = await configureBackupProvider({
    status: "configured",
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    host: {
      transport: "tailscale",
      target: "root@backup-host",
      serverUuid: "server-uuid",
    },
    autoRegister: true,
    credentialsFile,
    passwordFile,
  });
  assert.equal(configured.credentialStore, "OS keychain");
  assert.equal((await backupCredentials()).password, "test-recovery-password-long-enough");
  assert.equal(await getSecret(SECRET_KEYS.r2AdminToken), "existing-asset-provisioner");
  assert.ok(!JSON.stringify(getConfig()).includes("test-recovery-password-long-enough"));
  assert.ok(!JSON.stringify(getConfig()).includes("b".repeat(64)));
  const project = createBackupProject({
    name: "new-app",
    managed: [{ uuid: "db-uuid", kind: "postgres" }],
    composeAppUuid: "app-uuid",
    composeServices: ["server", "redis"],
  });
  assert.deepEqual(
    project.sources.map((s) => s.selector),
    [
      { project: "db-uuid", service: "db-uuid" },
      { project: "app-uuid", service: "redis" },
    ],
  );
  assert.throws(
    () => createBackupProject({ name: "external", managed: [] }),
    /No managed backup sources/,
  );
  assert.ok(shouldRegisterBackups("server-uuid"));
  assert.ok(!shouldRegisterBackups("other-host"));
  assert.equal(
    (
      await registerBackupProject(project, {
        serverUuid: "server-uuid",
        dryRun: true,
      })
    ).applied,
    false,
  );
  await assert.rejects(
    registerBackupProject(project, { serverUuid: "other-host", dryRun: true }),
    /differs/,
  );
  // Stale source fixes: the four hand edits from 2026-10-05/06, as data.
  const rows: SourceRow[] = [
    {
      project: "mood-magic",
      source: "app-mongo",
      kind: "mongo",
      state: "missing",
      selector: { project: "compose-uuid", service: "mongo" },
      matches: 0,
      candidates: [
        {
          container: "gbbs",
          selector: { project: "gbbs", service: "gbbs" },
          coolifyProject: "mood-magic",
          coolifyResource: "mood-magic-mongo",
          kinds: ["mongo"],
        },
        {
          container: "t32m",
          selector: { project: "t32m", service: "t32m" },
          coolifyProject: "streaks",
          coolifyResource: "streaks-mongo",
          kinds: ["mongo"],
        },
      ],
    },
    {
      project: "chess-app",
      source: "app-data",
      kind: "files",
      state: "ok",
      paths: ["/srv/chess"],
    },
    {
      project: "chess-app",
      source: "app-redis",
      kind: "redis",
      state: "missing",
      selector: { project: "chess-compose", service: "redis" },
      matches: 0,
      candidates: [],
    },
    {
      project: "glitchtip",
      source: "postgres",
      kind: "postgres",
      state: "missing",
      selector: { project: "gt-uuid", service: "postgres" },
      matches: 0,
      candidates: [],
    },
    {
      project: "glitchtip",
      source: "uploads",
      kind: "files",
      state: "missing",
      paths: ["/data/gt-uuid/uploads"],
      missingPaths: ["/data/gt-uuid/uploads"],
    },
  ];
  const fixed = attachFixes(rows);
  const fix = (project: string, source: string) =>
    fixed.find((r) => r.project === project && r.source === source)?.fix;
  assert.equal(fix("mood-magic", "app-mongo")?.action, "retarget");
  assert.equal(
    fix("mood-magic", "app-mongo")?.command,
    "hatchkit backup update-source --project mood-magic --source app-mongo --container gbbs",
  );
  assert.match(fix("mood-magic", "app-mongo")?.preview ?? "", / --dry-run$/);
  assert.equal(fix("chess-app", "app-redis")?.action, "remove-source");
  assert.equal(
    fix("chess-app", "app-redis")?.command,
    "hatchkit backup update-source --project chess-app --source app-redis --remove",
  );
  assert.equal(fix("chess-app", "app-data"), undefined);
  assert.equal(
    fix("glitchtip", "postgres")?.command,
    "hatchkit backup deregister --project glitchtip",
  );
  assert.equal(fix("glitchtip", "uploads")?.action, "deregister");
  assert.ok(sourceReferences(rows[4], ["gt-uuid"]));
  assert.ok(sourceReferences(rows[0], ["compose-uuid"]));
  assert.ok(!sourceReferences(rows[1], ["compose-uuid"]));
  const chessPolicy = {
    name: "chess-app",
    keepLast: 3 as const,
    sources: [
      { name: "app-data", kind: "files" as const, paths: ["/srv/chess"] },
      { name: "app-redis", kind: "redis" as const, selector: { project: "c", service: "redis" } },
    ],
  };
  assert.deepEqual(
    policyWithout(chessPolicy, ["app-redis"]).after?.sources.map((s) => s.name),
    ["app-data"],
  );
  assert.equal(policyWithout(chessPolicy, ["app-redis", "app-data"]).action, "deregister");
  await assert.rejects(
    updateBackupSource({
      project: "chess-app",
      source: "app-redis",
      container: "x",
      remove: true,
      dryRun: true,
    }),
    /exactly one of --container/,
  );
  const registration = saveBackupRegistration(project, "server-uuid");
  assert.deepEqual(JSON.parse(readFileSync(registration, "utf8")).project, project);
  assert.equal((await installBackupHost(true)).applied, false);
  assert.equal(
    (await configureBackupAlerts("owner@example.test", "backup@example.test", true)).applied,
    false,
  );
  await assert.rejects(
    configureBackupAlerts(
      "owner@example.test\nBcc: outsider@example.test",
      "backup@example.test",
      true,
    ),
    /single plain email/,
  );
  writeFileSync(passwordFile, "different-recovery-password-long-enough", {
    mode: 0o600,
  });
  await assert.rejects(
    configureBackupProvider({
      ...configured.provider,
      credentialsFile,
      passwordFile,
    }),
    /Recovery password differs/,
  );
  assert.equal((await backupCredentials()).password, "test-recovery-password-long-enough");
  const policy = { provider: "r2", schedule: "daily", keepLast: 3 };
  writeFileSync(
    join(dir, ".hatchkit.json"),
    JSON.stringify({
      version: 2,
      name: "demo",
      features: [],
      backups: policy,
    }),
  );
  assert.deepEqual(backupPlan(dir).policy, policy);
  assert.equal(backupPlan(dir).installed, "unknown");
  assert.deepEqual(collectStatus(dir).project?.backups, policy);
  assert.ok(
    collectStatus(dir).suggestions.some((item) => item.command === "hatchkit backup plan --json"),
  );
  const config = join(dir, "config.json");
  const value = {
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    credentialsFile: "/etc/hatchkit-backups/credentials.json",
    passwordFile: "/etc/hatchkit-backups/password",
    projects: [
      {
        name: "demo",
        sources: [{ name: "uploads", kind: "files", paths: ["/srv/data"] }],
      },
    ],
  };
  writeFileSync(config, JSON.stringify(value));
  const output = join(dir, "bundle");
  assert.equal(exportBackupBundle(config, output).installed, false);
  assert.ok(existsSync(join(output, "runner.py")));
  assert.ok(existsSync(join(output, "recovery.py")));
  assert.ok(existsSync(join(output, "alerts.py")));
  assert.ok(existsSync(join(output, "hatchkit-backup-alerts.timer")));
  assert.equal(
    JSON.parse(readFileSync(join(output, "config.json"), "utf8")).projects[0].name,
    "demo",
  );
  assert.throws(() => exportBackupBundle(config, output), /already exists/);
  value.repositoryBase = "s3:https://user:secret@account.r2.cloudflarestorage.com/backups";
  writeFileSync(config, JSON.stringify(value));
  assert.throws(() => exportBackupBundle(config, join(dir, "unsafe")), /credentials/);
  const help = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "backup", "bundle", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hatchkit backup bundle/);
  const runtime = spawnSync("python3", ["test-backup-runner.py"], {
    stdio: "inherit",
  });
  assert.equal(runtime.status, 0);
  const alertRuntime = spawnSync("python3", ["test-backup-alerts.py"], {
    stdio: "inherit",
  });
  assert.equal(alertRuntime.status, 0);
  console.log("Backup export safety and runtime recovery checks passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
