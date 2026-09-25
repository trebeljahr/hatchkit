/**
 * The verified deploy: a generated deploy that undoes itself, and the
 * manual rollback workflow that shares its script.
 *
 * Each property below encodes a failure that shipped green through a
 * deploy pipeline whose final assertion was an HTTP 200 from a queue
 * call:
 *
 *   1. Check ORDER. A commit check failing means "not deployed yet" and
 *      is worth waiting minutes for; everything else means "deployed and
 *      broken" and gets seconds. An origin that answers NOTHING has to
 *      fail its commit check, or the poll takes the first silent look as
 *      a landing and hands a server it never heard from to the gate.
 *   2. The gate is more than a health check. The client bakes its API
 *      origin in at BUILD time, so the right commit can carry the wrong
 *      URL; `db: true` does not prove the auth handler can read that
 *      database; and under a split topology nothing else in CI exercises
 *      the cross-origin preflight.
 *   3. A rollback target is only a value pinned to a full commit sha. A
 *      moving tag already points at the build that just failed, and a
 *      value the token may not read is unknown, not empty.
 *   4. The migration guard. A migration can raise the minimum reader
 *      above the previous build, which would then refuse to start —
 *      so the server stays and only the client moves. Unknown counts as
 *      blocked: a commit missing from a shallow checkout is not a yes.
 *   5. Nothing loops. No rollback target, and a rollback that fails its
 *      own gate, both end the run with one error naming which it was.
 *   6. The generated lib takes its dependencies as parameters, so a
 *      whole deploy — success, rollback, no target, failed rollback,
 *      migration-blocked — runs here against a fake platform with no
 *      network and no clock. That property is the point: a change that
 *      breaks the sequence fails here rather than in production.
 *   7. The push deploy and the manual rollback share ONE concurrency
 *      group, neither cancels in progress, and the deploy job checks out
 *      with full history.
 *   8. The two ledger invariants, which are non-negotiable because
 *      `update` re-applies the whole operational layer on every run: a
 *      second apply writes nothing, and a dry run leaves the disk alone
 *      while still describing everything it would have done.
 *
 * No test touches the network, a real platform, or the user's config.
 *
 * Run: `pnpm exec tsx test-verified-deploy.ts`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// scaffold/deploy-verification.ts is pulled in through plan.ts; keep any
// config store it reaches away from the user's real one.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "verified-deploy-conf-"));

const { applicableChecks, evaluateGate, isWaiting } = await import(
  "./src/features/verified-deploy/gate.js"
);
const { findEnvValue, selectRollbackTarget, shaFromImageRef, isFullSha } = await import(
  "./src/features/verified-deploy/rollback-target.js"
);
const {
  DEFAULT_ID_FIELD,
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_MIN_READER_FIELD,
  breakingMigrations,
  canRollBackServer,
  readMigrationRegistry,
} = await import("./src/features/verified-deploy/migration-guard.js");
const { planVerifiedDeploy, DEPLOY_CONCURRENCY_GROUP } = await import(
  "./src/features/verified-deploy/plan.js"
);
const { renderDeployEntry, renderDeployLib, DEPLOY_ENTRY_REL_PATH, DEPLOY_LIB_REL_PATH } =
  await import("./src/features/verified-deploy/script.js");
const {
  renderRollbackWorkflow,
  verifiedDeployRetrofits,
  withDeployCheckoutHistory,
  withDeployJobConcurrency,
  withVerifiedDeployStep,
  withoutPushCancellation,
  ROLLBACK_WORKFLOW_REL_PATH,
} = await import("./src/features/verified-deploy/workflow.js");
const { applyVerifiedDeploy } = await import("./src/features/verified-deploy/index.js");
const { FeatureLedger } = await import("./src/features/contract.js");

import type { FileAction, LedgerEntry } from "./src/features/contract.js";
import type { OperationalContext, OperationalProject } from "./src/features/operational-context.js";
import type {
  GateExpectations,
  GateProbes,
  MigrationRegistry,
  PlatformEnvEntry,
} from "./src/features/verified-deploy/types.js";

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const NEW_SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const API = "https://api.test.example";
const WEB = "https://test.example";

const split: GateExpectations = {
  serverSha: NEW_SHA,
  clientSha: NEW_SHA,
  apiOrigin: API,
  webOrigin: WEB,
  crossOrigin: true,
};

function probes(overrides: Partial<GateProbes> = {}): GateProbes {
  return {
    health: { status: "ok", db: true, commit: NEW_SHA },
    buildInfo: { commit: NEW_SHA, apiUrl: API },
    sessionStatus: 200,
    corsAllowOrigin: WEB,
    ...overrides,
  };
}

// ── The gate ─────────────────────────────────────────────────────────

console.log("\nthe gate\n");

check("a healthy split deployment passes every check", () => {
  assert.deepEqual(evaluateGate(probes(), split), { ok: true });
});

check("the commit checks come before the health checks", () => {
  // Both are wrong. The run must report the one that means "wait", not
  // the one that means "give up".
  const verdict = evaluateGate(
    probes({ health: { status: "down", db: false, commit: OLD_SHA } }),
    split,
  );
  assert.equal(verdict.failed, "api-commit");
  assert.ok(isWaiting(verdict));
});

check("an origin that answers nothing fails its COMMIT check, not its health check", () => {
  const verdict = evaluateGate(probes({ health: null }), split);
  assert.equal(verdict.failed, "api-commit");
  assert.ok(isWaiting(verdict), "a silent origin must keep the poll waiting");
});

check("a silent origin with no commit expected still fails, as api-status", () => {
  const verdict = evaluateGate(probes({ health: null }), { ...split, serverSha: null });
  assert.equal(verdict.failed, "api-status");
  assert.ok(!isWaiting(verdict));
});

check("`version` is accepted as the commit field, so an older image can be restored", () => {
  const verdict = evaluateGate(
    probes({ health: { status: "ok", db: true, version: NEW_SHA } }),
    split,
  );
  assert.equal(verdict.ok, true);
});

check("a wrong status is api-status", () => {
  const verdict = evaluateGate(
    probes({ health: { status: "degraded", db: true, commit: NEW_SHA } }),
    split,
  );
  assert.equal(verdict.failed, "api-status");
  assert.match(verdict.detail ?? "", /degraded/);
});

check("a database that is not up is api-db", () => {
  const verdict = evaluateGate(
    probes({ health: { status: "ok", db: false, commit: NEW_SHA } }),
    split,
  );
  assert.equal(verdict.failed, "api-db");
});

check("the right commit built against the wrong API is web-api-url", () => {
  const verdict = evaluateGate(
    probes({ buildInfo: { commit: NEW_SHA, apiUrl: "https://api.old.example" } }),
    split,
  );
  assert.equal(verdict.failed, "web-api-url");
  assert.match(verdict.detail ?? "", /api\.old\.example/);
});

check("an empty baked API URL is reported as <none>, not as undefined", () => {
  const verdict = evaluateGate(probes({ buildInfo: { commit: NEW_SHA, apiUrl: "" } }), split);
  assert.equal(verdict.failed, "web-api-url");
  assert.match(verdict.detail ?? "", /<none>/);
});

check("a session call that is not 200 is auth-session", () => {
  const verdict = evaluateGate(probes({ sessionStatus: 500 }), split);
  assert.equal(verdict.failed, "auth-session");
});

check("a refused preflight is cors, and is the last check", () => {
  const verdict = evaluateGate(probes({ corsAllowOrigin: null }), split);
  assert.equal(verdict.failed, "cors");
});

check("single-origin has no preflight to check", () => {
  const same = { ...split, apiOrigin: WEB, crossOrigin: false };
  assert.ok(!applicableChecks(same).includes("cors"));
  const sameOrigin = probes({ corsAllowOrigin: null, buildInfo: { commit: NEW_SHA, apiUrl: WEB } });
  assert.equal(evaluateGate(sameOrigin, same).ok, true);
});

check("a backend project checks no web half", () => {
  const backend: GateExpectations = {
    ...split,
    webOrigin: "",
    clientSha: null,
    crossOrigin: false,
  };
  assert.deepEqual(applicableChecks(backend), [
    "api-commit",
    "api-status",
    "api-db",
    "auth-session",
  ]);
  assert.equal(evaluateGate(probes({ buildInfo: null }), backend).ok, true);
});

check("a static project checks no API half", () => {
  const isStatic: GateExpectations = {
    ...split,
    apiOrigin: "",
    serverSha: null,
    crossOrigin: false,
  };
  assert.deepEqual(applicableChecks(isStatic), ["web-commit"]);
  assert.equal(evaluateGate(probes({ health: null, sessionStatus: null }), isStatic).ok, true);
});

check("a client-only move still gates the server on being up", () => {
  const clientOnly: GateExpectations = { ...split, serverSha: null };
  const checks = applicableChecks(clientOnly);
  assert.ok(!checks.includes("api-commit"));
  assert.ok(checks.includes("api-db"));
});

// ── Rollback targets ─────────────────────────────────────────────────

console.log("\nrollback targets\n");

const pinnedRow: PlatformEnvEntry[] = [
  { key: "SERVER_IMAGE", value: `ghcr.io/acme/app-server:${OLD_SHA}` },
];

check("a value pinned to a full sha is a target", () => {
  const target = selectRollbackTarget(pinnedRow, "SERVER_IMAGE");
  assert.equal(target.kind, "target");
  assert.equal(target.kind === "target" && target.sha, OLD_SHA);
});

check("a moving tag is NOT a target — it already points at the failed build", () => {
  const target = selectRollbackTarget(
    [{ key: "SERVER_IMAGE", value: "ghcr.io/acme/app-server:main" }],
    "SERVER_IMAGE",
  );
  assert.equal(target.kind, "none");
  assert.match(target.kind === "none" ? target.reason : "", /moving tag/);
});

check("an abbreviated sha is not a target either", () => {
  assert.equal(shaFromImageRef("ghcr.io/acme/app-server:abc1234"), null);
  assert.equal(isFullSha(OLD_SHA.slice(0, 7)), false);
});

check("a registry port does not read as a tag", () => {
  assert.equal(shaFromImageRef(`registry.example.com:5000/app:${OLD_SHA}`), OLD_SHA);
  assert.equal(shaFromImageRef("registry.example.com:5000/app"), null);
});

check("a value the token may not read is unknown, not empty", () => {
  const target = selectRollbackTarget([{ key: "SERVER_IMAGE" }], "SERVER_IMAGE");
  assert.equal(target.kind, "none");
  assert.match(target.kind === "none" ? target.reason : "", /may not read variable values/);
});

check("a missing variable says so, and names the first-deploy case", () => {
  const target = selectRollbackTarget([], "SERVER_IMAGE");
  assert.equal(target.kind, "none");
  assert.match(target.kind === "none" ? target.reason : "", /first deploy/);
});

check("the preview copy of a variable is never the target", () => {
  const value = findEnvValue(
    [
      { key: "SERVER_IMAGE", value: "preview-image", is_preview: true },
      { key: "SERVER_IMAGE", value: `ghcr.io/acme/app-server:${OLD_SHA}` },
    ],
    "SERVER_IMAGE",
  );
  assert.equal(value, `ghcr.io/acme/app-server:${OLD_SHA}`);
});

// ── The migration guard ──────────────────────────────────────────────

console.log("\nthe migration guard\n");

const reg = (migrations: Array<{ id: number; minReader: number }>): MigrationRegistry => ({
  migrations: migrations.map((m) => ({ ...m, file: `${m.id}-migration.ts` })),
  schemaVersion: migrations.length === 0 ? 0 : migrations[migrations.length - 1].id,
});

check("safe: nothing new raises the minimum reader", () => {
  const verdict = canRollBackServer({
    newRegistry: {
      ok: true,
      registry: reg([
        { id: 1, minReader: 1 },
        { id: 2, minReader: 1 },
      ]),
    },
    previousRegistry: { ok: true, registry: reg([{ id: 1, minReader: 1 }]) },
    newSha: NEW_SHA,
    previousSha: OLD_SHA,
  });
  assert.equal(verdict.allowed, true);
});

check("blocked: the new commit carries a migration the previous build cannot read", () => {
  const verdict = canRollBackServer({
    newRegistry: {
      ok: true,
      registry: reg([
        { id: 1, minReader: 1 },
        { id: 2, minReader: 2 },
      ]),
    },
    previousRegistry: { ok: true, registry: reg([{ id: 1, minReader: 1 }]) },
    newSha: NEW_SHA,
    previousSha: OLD_SHA,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /refuse to start/);
  assert.match(verdict.reason, /2-migration\.ts/);
});

check("unknown is blocked, and says a shallow checkout is the usual cause", () => {
  const verdict = canRollBackServer({
    newRegistry: { ok: false, error: "commit is not in this checkout" },
    previousRegistry: { ok: true, registry: reg([]) },
    newSha: NEW_SHA,
    previousSha: OLD_SHA,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /fetch-depth: 0/);
});

check("a project with no migrations at all is the easy case", () => {
  const verdict = canRollBackServer({
    newRegistry: { ok: true, registry: reg([]) },
    previousRegistry: { ok: true, registry: reg([]) },
  });
  assert.equal(verdict.allowed, true);
});

check("a migration the old build already knows about is not breaking", () => {
  assert.equal(
    breakingMigrations(reg([{ id: 3, minReader: 3 }]), reg([{ id: 3, minReader: 3 }])).length,
    0,
  );
});

check("an absent registry directory reads as empty; an unreadable one reads as an error", () => {
  const absent = readMigrationRegistry(
    () => null,
    () => [],
  );
  assert.equal(absent.ok, true);
  const unreadable = readMigrationRegistry(
    () => null,
    () => null,
  );
  assert.equal(unreadable.ok, false);
});

check("a migration file with no readable fields is an error, not an empty registry", () => {
  const read = readMigrationRegistry(
    () => "export const migration = { name: 'whatever' };",
    () => ["001-add-index.ts"],
  );
  assert.equal(read.ok, false);
  assert.match(read.ok === false ? read.error : "", /minReaderSchema/);
});

check("the registry location and field names are parameters, not literals", () => {
  const read = readMigrationRegistry(
    (path) => (path === "db/steps/001.sql" ? "-- step: 4, needs: 4" : null),
    (dir) => (dir === "db/steps" ? ["001.sql"] : null),
    { dir: "db/steps", idField: "step", minReaderField: "needs" },
  );
  assert.equal(read.ok, true);
  assert.equal(read.ok === true && read.registry.schemaVersion, 4);
});

// ── A whole deploy, against a fake platform ──────────────────────────

console.log("\na whole deploy against a fake platform\n");

const project: OperationalProject = {
  name: "testapp",
  domain: "test.example",
  topology: "split",
  surfaces: "fullstack",
  features: [],
  repoSlug: "acme/app",
};

/** A context rooted at `projectDir`, with a real ledger.
 *
 *  A real {@link FeatureLedger} rather than a stub, because the two
 *  invariants these tests pin — idempotency and an untouched disk under
 *  `--dry-run` — live in the ledger's compare-before-write, and a stub
 *  would assert against a reimplementation of the thing under test. */
function contextFor(
  projectDir: string,
  overrides: Partial<OperationalProject> = {},
  opts: { dryRun?: boolean } = {},
): OperationalContext {
  return {
    projectDir,
    project: { ...project, ...overrides },
    mode: "update",
    ledger: new FeatureLedger(projectDir, opts.dryRun === true),
    log: () => undefined,
  };
}

/** Files of the ledger whose entry has one of `actions`. */
function filesWith(entries: readonly LedgerEntry[], ...actions: FileAction[]): string[] {
  return entries.filter((e) => actions.includes(e.action)).map((e) => e.file);
}

const plan = planVerifiedDeploy(
  { projectDir: "/nonexistent", project },
  { imageBase: { server: "ghcr.io/acme/app-server", client: "ghcr.io/acme/app-client" } },
);

const libDir = mkdtempSync(join(tmpdir(), "verified-deploy-lib-"));
const libPath = join(libDir, "hatchkit-deploy.mjs");
writeFileSync(libPath, renderDeployLib(plan), "utf-8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib = await import(pathToFileURL(libPath).href);

const SRV = "srv-uuid";
const CLI = "cli-uuid";

interface FakeOptions {
  /** Starting image value on each application. */
  serverImage?: string | null;
  clientImage?: string | null;
  /** Commits whose SERVER fails the gate (health db false). */
  badServer?: string[];
  /** Commits whose CLIENT fails the gate (built against the wrong API). */
  badClient?: string[];
  /** Make every platform write fail, to model a rollback that cannot
   *  even be queued. */
  breakWritesAfter?: number;
  /** Return no readable value for the image variables. */
  hideValues?: boolean;
}

function fakePlatform(options: FakeOptions) {
  const envs: Record<string, Record<string, string>> = {
    [SRV]:
      options.serverImage === null
        ? {}
        : { SERVER_IMAGE: options.serverImage ?? `ghcr.io/acme/app-server:${OLD_SHA}` },
    [CLI]:
      options.clientImage === null
        ? {}
        : { CLIENT_IMAGE: options.clientImage ?? `ghcr.io/acme/app-client:${OLD_SHA}` },
  };
  const serving = { server: OLD_SHA, client: OLD_SHA };
  const lines: string[] = [];
  let writes = 0;

  const shaOf = (value: string | undefined): string => {
    if (!value) return "";
    const tag = value.slice(value.lastIndexOf(":") + 1);
    return /^[0-9a-f]{40}$/.test(tag) ? tag : "";
  };

  const json = (body: unknown, status = 200) => ({
    status,
    ok: status < 400,
    headers: { get: () => null as string | null },
    text: async () => JSON.stringify(body),
  });

  const fetchImpl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const method = init?.method ?? "GET";
    const path = parsed.pathname;

    if (path.startsWith("/api/v1/applications/")) {
      const uuid = path.split("/")[4];
      if (method === "GET") {
        return json(
          Object.entries(envs[uuid] ?? {}).map(([key, value]) => ({
            key,
            value: options.hideValues ? undefined : value,
          })),
        );
      }
      writes += 1;
      if (options.breakWritesAfter !== undefined && writes > options.breakWritesAfter) {
        return json({ message: "no" }, 500);
      }
      return json({ ok: true });
    }
    if (path === "/api/v1/deploy") {
      writes += 1;
      if (options.breakWritesAfter !== undefined && writes > options.breakWritesAfter) {
        return json({ message: "no" }, 500);
      }
      const uuid = parsed.searchParams.get("uuid") ?? "";
      if (uuid === SRV) serving.server = shaOf(envs[SRV].SERVER_IMAGE);
      if (uuid === CLI) serving.client = shaOf(envs[CLI].CLIENT_IMAGE);
      return json({ ok: true });
    }

    if (origin === API && path === "/api/health") {
      return json({
        status: "ok",
        db: !(options.badServer ?? []).includes(serving.server),
        commit: serving.server,
      });
    }
    if (origin === WEB && path === "/version.json") {
      return json({
        commit: serving.client,
        apiUrl: (options.badClient ?? []).includes(serving.client) ? "" : API,
      });
    }
    if (origin === API && path === "/api/auth/get-session") {
      if (method === "OPTIONS") {
        return {
          status: 204,
          ok: true,
          headers: { get: (name: string) => (name === "access-control-allow-origin" ? WEB : null) },
          text: async () => "",
        };
      }
      return json(null);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  // The PATCH body carries the new value; apply it so a read-back sees it.
  const fetchWithWrites = async (url: string, init?: { method?: string; body?: string }) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/v1/applications/") && init?.method === "PATCH") {
      const uuid = parsed.pathname.split("/")[4];
      const body = JSON.parse(init.body ?? "{}");
      const before = writes;
      const response = await fetchImpl(url, init);
      if (response.ok && writes > before) envs[uuid][body.key] = body.value;
      return response;
    }
    return fetchImpl(url, init);
  };

  return {
    envs,
    serving,
    lines,
    deps: {
      fetch: fetchWithWrites,
      sleep: async () => {},
      log: (line: string) => lines.push(line),
      readRegistry: () => ({ ok: true, registry: { migrations: [], schemaVersion: 0 } }),
    },
    config: {
      baseUrl: "https://platform.test",
      token: "t",
      uuids: { server: SRV, client: CLI },
      imageBase: { server: "ghcr.io/acme/app-server", client: "ghcr.io/acme/app-client" },
      webOrigin: WEB,
      apiOrigin: API,
      timing: { pollAttempts: 3, pollIntervalMs: 0, gateAttempts: 2, gateIntervalMs: 0 },
    },
  };
}

await checkAsync("a healthy deploy pins both halves and passes", async () => {
  const fake = fakePlatform({});
  const result = await lib.runDeploy(fake.deps, fake.config, {
    targetSha: NEW_SHA,
    apps: ["server", "client"],
    rollback: true,
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(fake.envs[SRV].SERVER_IMAGE, `ghcr.io/acme/app-server:${NEW_SHA}`);
  assert.equal(fake.envs[CLI].CLIENT_IMAGE, `ghcr.io/acme/app-client:${NEW_SHA}`);
});

await checkAsync("a failed gate rolls back, and the run still FAILS", async () => {
  const fake = fakePlatform({ badServer: [NEW_SHA] });
  const result = await lib.runDeploy(fake.deps, fake.config, {
    targetSha: NEW_SHA,
    apps: ["server", "client"],
    rollback: true,
  });
  assert.equal(result.ok, false, "a rollback is never a green run");
  const text = result.errors.join("\n");
  assert.match(text, /api-db/, "the error must name the failed check");
  assert.ok(text.includes(NEW_SHA), "the error must name the new commit");
  assert.ok(text.includes(OLD_SHA), "the error must name the restored commit");
  assert.match(text, /rolled back to .*which passed the gate/);
  assert.equal(fake.envs[SRV].SERVER_IMAGE, `ghcr.io/acme/app-server:${OLD_SHA}`);
});

await checkAsync(
  "no rollback target: the run fails, says which, and leaves the new pin",
  async () => {
    const fake = fakePlatform({
      badServer: [NEW_SHA],
      serverImage: "ghcr.io/acme/app-server:main",
      clientImage: "ghcr.io/acme/app-client:main",
    });
    const result = await lib.runDeploy(fake.deps, fake.config, {
      targetSha: NEW_SHA,
      apps: ["server", "client"],
      rollback: true,
    });
    assert.equal(result.ok, false);
    const text = result.errors.join("\n");
    assert.match(text, /nothing was rolled back/);
    assert.match(text, /moving tag/);
    assert.equal(fake.envs[SRV].SERVER_IMAGE, `ghcr.io/acme/app-server:${NEW_SHA}`);
  },
);

await checkAsync(
  "a token that cannot read the values is a hard failure, not a silent skip",
  async () => {
    const fake = fakePlatform({ badServer: [NEW_SHA], hideValues: true });
    const result = await lib.runDeploy(fake.deps, fake.config, {
      targetSha: NEW_SHA,
      apps: ["server", "client"],
      rollback: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /may not read variable values/);
  },
);

await checkAsync("a rollback that fails its own gate is named, and never retried", async () => {
  const fake = fakePlatform({ badServer: [NEW_SHA, OLD_SHA] });
  const result = await lib.runDeploy(fake.deps, fake.config, {
    targetSha: NEW_SHA,
    apps: ["server", "client"],
    rollback: true,
  });
  assert.equal(result.ok, false);
  const text = result.errors.join("\n");
  assert.match(text, /FAILED its own gate/);
  assert.match(text, /needs a person now/);
  const restores = fake.lines.filter((line) => line.startsWith("rolling back to"));
  assert.equal(restores.length, 1, "exactly one rollback attempt, ever");
});

await checkAsync(
  "a platform write that fails while restoring is named, and never retried",
  async () => {
    // Four writes get the new pin in place and deployed; the fifth, which
    // is the restore, fails.
    const fake = fakePlatform({ badServer: [NEW_SHA], breakWritesAfter: 4 });
    const result = await lib.runDeploy(fake.deps, fake.config, {
      targetSha: NEW_SHA,
      apps: ["server", "client"],
      rollback: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /FAILED while pinning or deploying/);
  },
);

await checkAsync("a migration the previous build cannot read moves only the client", async () => {
  const fake = fakePlatform({ badClient: [NEW_SHA] });
  fake.deps.readRegistry = ((sha: string) => ({
    ok: true,
    registry:
      sha === NEW_SHA
        ? { migrations: [{ id: 2, file: "002-split-users.ts", minReader: 2 }], schemaVersion: 2 }
        : { migrations: [], schemaVersion: 0 },
  })) as typeof fake.deps.readRegistry;

  const result = await lib.runDeploy(fake.deps, fake.config, {
    targetSha: NEW_SHA,
    apps: ["server", "client"],
    rollback: true,
  });
  assert.equal(result.ok, false);
  const text = result.errors.join("\n");
  assert.match(text, /web-api-url/);
  assert.match(text, /002-split-users\.ts/);
  assert.match(text, /refuse to start/);
  assert.equal(
    fake.envs[SRV].SERVER_IMAGE,
    `ghcr.io/acme/app-server:${NEW_SHA}`,
    "the server stays",
  );
  assert.equal(
    fake.envs[CLI].CLIENT_IMAGE,
    `ghcr.io/acme/app-client:${OLD_SHA}`,
    "the client moves",
  );
});

await checkAsync("an unreadable registry blocks the server rollback too", async () => {
  const fake = fakePlatform({ badClient: [NEW_SHA] });
  fake.deps.readRegistry = (() => {
    throw new Error("commit is not in this checkout");
  }) as typeof fake.deps.readRegistry;
  const result = await lib.runDeploy(fake.deps, fake.config, {
    targetSha: NEW_SHA,
    apps: ["server", "client"],
    rollback: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /could not be compared/);
  assert.equal(fake.envs[SRV].SERVER_IMAGE, `ghcr.io/acme/app-server:${NEW_SHA}`);
});

await checkAsync("without --rollback a failed gate leaves the new images pinned", async () => {
  const fake = fakePlatform({ badServer: [NEW_SHA] });
  const result = await lib.runDeploy(fake.deps, fake.config, {
    targetSha: NEW_SHA,
    apps: ["server", "client"],
    rollback: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /no rollback was requested/);
  assert.equal(fake.envs[SRV].SERVER_IMAGE, `ghcr.io/acme/app-server:${NEW_SHA}`);
});

await checkAsync(
  "deploying an older server past a migration is refused before anything changes",
  async () => {
    const fake = fakePlatform({
      serverImage: `ghcr.io/acme/app-server:${NEW_SHA}`,
      clientImage: `ghcr.io/acme/app-client:${NEW_SHA}`,
    });
    fake.deps.readRegistry = ((sha: string) => ({
      ok: true,
      registry:
        sha === NEW_SHA
          ? { migrations: [{ id: 2, file: "002-split-users.ts", minReader: 2 }], schemaVersion: 2 }
          : { migrations: [], schemaVersion: 0 },
    })) as typeof fake.deps.readRegistry;

    const result = await lib.runDeploy(fake.deps, fake.config, {
      targetSha: OLD_SHA,
      apps: ["server", "client"],
      rollback: false,
      guardServerDowngrade: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /refusing to deploy the server/);
    assert.equal(
      fake.envs[SRV].SERVER_IMAGE,
      `ghcr.io/acme/app-server:${NEW_SHA}`,
      "nothing changed",
    );
  },
);

await checkAsync(
  "force-server deploys it anyway, for an operator who restored a dump",
  async () => {
    const fake = fakePlatform({
      serverImage: `ghcr.io/acme/app-server:${NEW_SHA}`,
      clientImage: `ghcr.io/acme/app-client:${NEW_SHA}`,
    });
    fake.deps.readRegistry = ((sha: string) => ({
      ok: true,
      registry:
        sha === NEW_SHA
          ? { migrations: [{ id: 2, file: "002-split-users.ts", minReader: 2 }], schemaVersion: 2 }
          : { migrations: [], schemaVersion: 0 },
    })) as typeof fake.deps.readRegistry;

    const result = await lib.runDeploy(fake.deps, fake.config, {
      targetSha: OLD_SHA,
      apps: ["server", "client"],
      rollback: false,
      guardServerDowngrade: true,
      forceServer: true,
    });
    assert.equal(result.ok, true, result.errors.join("\n"));
  },
);

await checkAsync("an abbreviated sha is refused before any platform call", async () => {
  const fake = fakePlatform({});
  const result = await lib.runDeploy(fake.deps, fake.config, {
    targetSha: NEW_SHA.slice(0, 7),
    apps: ["server"],
    rollback: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /not a full 40-character commit sha/);
});

check("the generated lib mirrors the gate's check order", () => {
  assert.deepEqual(
    [...lib.GATE_CHECK_ORDER],
    ["api-commit", "web-commit", "api-status", "api-db", "web-api-url", "auth-session", "cors"],
  );
});

check("the generated lib takes its dependencies as parameters", () => {
  const source = readFileSync(libPath, "utf-8");
  assert.ok(!/\bawait fetch\(/.test(source), "no direct fetch in the logic module");
  assert.ok(!/setTimeout\(/.test(source), "no direct clock in the logic module");
  assert.ok(!/execFileSync/.test(source), "no direct git in the logic module");
});

check("the generated entry is the only file that reads argv, env and git", () => {
  const entry = renderDeployEntry(plan);
  assert.match(entry, /execFileSync/);
  assert.match(entry, /parseArgs/);
  assert.match(entry, /fetch-depth: 0/, "it must say what the full history is for");
});

// ── The workflows ────────────────────────────────────────────────────

console.log("\nthe workflows\n");

const starterWorkflow = readFileSync(
  join(import.meta.dirname, "..", "starter", ".github", "workflows", "build-and-deploy.yml"),
  "utf-8",
);
const retrofit = verifiedDeployRetrofits(plan)[0][2];
const retrofitted = retrofit(starterWorkflow);
const rollbackWorkflow = renderRollbackWorkflow(plan);

check("the deploy job gets the shared concurrency group", () => {
  assert.match(retrofitted, new RegExp(`group: ${DEPLOY_CONCURRENCY_GROUP}`));
});

check("both workflows carry the same group", () => {
  assert.match(rollbackWorkflow, new RegExp(`group: ${DEPLOY_CONCURRENCY_GROUP}`));
  assert.equal(
    (retrofitted.match(new RegExp(`group: ${DEPLOY_CONCURRENCY_GROUP}`, "g")) ?? []).length,
    1,
  );
});

check("neither workflow cancels a run in progress", () => {
  assert.ok(!/cancel-in-progress: true/.test(retrofitted));
  assert.ok(!/cancel-in-progress: true/.test(rollbackWorkflow));
  assert.match(rollbackWorkflow, /cancel-in-progress: false/);
});

check("the deploy job checks out the full history, and says what for", () => {
  const deployJob = retrofitted.slice(retrofitted.indexOf("\n  deploy:"));
  assert.match(deployJob, /fetch-depth: 0/);
  assert.match(deployJob, /migration/i);
});

check("the deploy job runs the generated script, and the steps it replaces are gone", () => {
  assert.match(retrofitted, /- name: Deploy, gate and roll back on failure/);
  assert.match(retrofitted, new RegExp(`node ${DEPLOY_ENTRY_REL_PATH} deploy`));
  assert.match(retrofitted, /--rollback/);
  assert.ok(!retrofitted.includes("- name: Pin image tags to this commit"));
  assert.ok(!retrofitted.includes("- name: Verify the deployment is actually live"));
  // The native-client sign-in probe is a different concern and stays.
  assert.match(retrofitted, /- name: Verify native clients can sign in/);
});

check("the retrofit is idempotent", () => {
  assert.equal(retrofit(retrofitted), retrofitted);
});

check("each retrofit no-ops on a file missing its anchor", () => {
  const bare =
    "name: something\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";
  assert.equal(withoutPushCancellation(bare), bare);
  assert.equal(withDeployJobConcurrency(bare, DEPLOY_CONCURRENCY_GROUP), bare);
  assert.equal(withDeployCheckoutHistory(bare), bare);
  assert.equal(withVerifiedDeployStep(bare, plan), bare);
  assert.equal(retrofit(bare), bare);
});

check("a deploy job with its own checkout keeps it and gains the history", () => {
  const withCheckout = [
    "name: x",
    "",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: Deploy via Coolify API",
    "        run: curl -X POST https://example.test",
    "",
  ].join("\n");
  const after = withDeployCheckoutHistory(withCheckout);
  assert.match(after, /- uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0/);
  assert.equal(withDeployCheckoutHistory(after), after, "idempotent");
});

check("the manual rollback refuses a commit that is not on the default branch", () => {
  assert.match(rollbackWorkflow, /merge-base --is-ancestor/);
  assert.match(rollbackWorkflow, /rev-parse --verify/);
  assert.match(rollbackWorkflow, /\{7,40\}/, "an abbreviated sha is resolved");
});

check("the manual rollback offers force_server and opt-in restore_on_failure", () => {
  assert.match(rollbackWorkflow, /force_server:/);
  assert.match(rollbackWorkflow, /restore_on_failure:/);
  assert.match(rollbackWorkflow, /--guard-server-downgrade/);
  assert.match(rollbackWorkflow, /default: false/);
});

check("the manual rollback says a queued run has to be watched", () => {
  assert.match(rollbackWorkflow, /gh run watch/);
  assert.match(rollbackWorkflow, /run waits per group/i);
});

// ── Writing it all into a project ────────────────────────────────────

console.log("\nwriting into a project\n");

const projectDir = mkdtempSync(join(tmpdir(), "verified-deploy-project-"));
mkdirSync(dirname(join(projectDir, ".github/workflows/build-and-deploy.yml")), { recursive: true });
writeFileSync(join(projectDir, ".github/workflows/build-and-deploy.yml"), starterWorkflow, "utf-8");

const ctx = contextFor(projectDir);
const applied = applyVerifiedDeploy(ctx);

check("applying writes the script, its logic module and the rollback workflow", () => {
  const written = filesWith(ctx.ledger.entries, "written");
  assert.ok(written.includes(DEPLOY_LIB_REL_PATH), written.join(", "));
  assert.ok(written.includes(DEPLOY_ENTRY_REL_PATH), written.join(", "));
  assert.ok(written.includes(ROLLBACK_WORKFLOW_REL_PATH), written.join(", "));
  assert.ok(written.includes(".github/workflows/build-and-deploy.yml"), written.join(", "));
  assert.equal(applied.skipped, undefined);
});

check("every file the module owns says that hatchkit owns it", () => {
  // An owned file that does not announce itself is a file somebody edits
  // and then loses on the next `hatchkit update`.
  for (const relPath of [DEPLOY_LIB_REL_PATH, DEPLOY_ENTRY_REL_PATH, ROLLBACK_WORKFLOW_REL_PATH]) {
    assert.match(readFileSync(join(projectDir, relPath), "utf-8"), /OWNED by hatchkit/, relPath);
  }
});

check("both generated scripts are valid JavaScript", () => {
  // The logic module is proved by the import above; the entry is never
  // executed by these tests, so a quoting mistake in the generator would
  // otherwise only show up on the next real deploy.
  for (const relPath of [DEPLOY_LIB_REL_PATH, DEPLOY_ENTRY_REL_PATH]) {
    execFileSync(process.execPath, ["--check", join(projectDir, relPath)], { stdio: "pipe" });
  }
});

check("applying twice writes nothing", () => {
  // The invariant `update` depends on: it re-applies the whole
  // operational layer on every run, so a module that writes on the
  // second pass churns the repo a little more each time.
  const second = contextFor(projectDir);
  applyVerifiedDeploy(second);
  assert.deepEqual(
    filesWith(second.ledger.entries, "written"),
    [],
    filesWith(second.ledger.entries, "written").join(", "),
  );
  for (const entry of second.ledger.entries) {
    assert.ok(
      entry.action === "unchanged" || entry.action === "absent",
      `${entry.file}: ${entry.action}`,
    );
  }
});

check("the generated files are regenerated when the plan changes", () => {
  // They are OWNED, not copy-if-absent: a project whose domain moved has
  // to get a deploy script that gates against the new origin, and the
  // first apply must not freeze the old one in place for good.
  const moved = contextFor(projectDir, { domain: "moved.example" });
  applyVerifiedDeploy(moved);
  assert.ok(filesWith(moved.ledger.entries, "written").includes(DEPLOY_LIB_REL_PATH));
  assert.match(readFileSync(join(projectDir, DEPLOY_LIB_REL_PATH), "utf-8"), /moved\.example/);
  // Put the fixture back, so the checks below read the split project.
  applyVerifiedDeploy(contextFor(projectDir));
});

check("a dry run touches nothing and still says what it would write", () => {
  const dryDir = mkdtempSync(join(tmpdir(), "verified-deploy-dry-"));
  try {
    const dry = contextFor(dryDir, {}, { dryRun: true });
    applyVerifiedDeploy(dry);
    const wouldWrite = filesWith(dry.ledger.entries, "would-write");
    for (const relPath of [
      DEPLOY_LIB_REL_PATH,
      DEPLOY_ENTRY_REL_PATH,
      ROLLBACK_WORKFLOW_REL_PATH,
    ]) {
      assert.ok(wouldWrite.includes(relPath), `${relPath} not reported: ${wouldWrite.join(", ")}`);
      assert.ok(!existsSync(join(dryDir, relPath)), `${relPath} was written anyway`);
    }
    assert.deepEqual(filesWith(dry.ledger.entries, "written"), []);
  } finally {
    rmSync(dryDir, { recursive: true, force: true });
  }
});

check("a retrofit whose file is absent is recorded, not an error", () => {
  const bareDir = mkdtempSync(join(tmpdir(), "verified-deploy-bare-"));
  try {
    const bare = contextFor(bareDir);
    applyVerifiedDeploy(bare);
    assert.ok(
      filesWith(bare.ledger.entries, "absent").includes(".github/workflows/build-and-deploy.yml"),
    );
    assert.deepEqual(bare.ledger.conflicts(), []);
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
  }
});

check("a static project still gets a deploy, without the API checks", () => {
  const staticDir = mkdtempSync(join(tmpdir(), "verified-deploy-static-"));
  const result = applyVerifiedDeploy(
    contextFor(staticDir, { surfaces: "static", topology: "single-origin" }),
  );
  assert.equal(result.skipped, undefined);
  const lib = readFileSync(join(staticDir, DEPLOY_LIB_REL_PATH), "utf-8");
  assert.match(lib, /ORIGINS = Object\.freeze\(\{ web: "https:\/\/test\.example", api: "" \}\)/);
  assert.match(lib, /CROSS_ORIGIN = false/);
  rmSync(staticDir, { recursive: true, force: true });
});

check("a single-origin project checks no preflight and carries both image variables", () => {
  const singleDir = mkdtempSync(join(tmpdir(), "verified-deploy-single-"));
  applyVerifiedDeploy(contextFor(singleDir, { topology: "single-origin" }));
  const lib = readFileSync(join(singleDir, DEPLOY_LIB_REL_PATH), "utf-8");
  assert.match(lib, /CROSS_ORIGIN = false/);
  assert.match(lib, /APPS = Object\.freeze\(\["server","client"\]\)/);
  rmSync(singleDir, { recursive: true, force: true });
});

check("a project with no half at all is skipped with a reason", () => {
  const noneDir = mkdtempSync(join(tmpdir(), "verified-deploy-none-"));
  try {
    const none = contextFor(noneDir);
    const result = applyVerifiedDeploy(none, { apps: [] });
    assert.match(result.skipped ?? "", /neither a server nor a client half/);
    assert.deepEqual(none.ledger.entries, []);
  } finally {
    rmSync(noneDir, { recursive: true, force: true });
  }
});

check("the notes name the one manual step that makes the pin work", () => {
  // Only steps a person has to take: the ledger reports what changed on
  // disk, so a note that restated a file write would be noise.
  assert.ok(applied.notes.some((note) => /SERVER_IMAGE once/.test(note)));
  assert.ok(applied.notes.some((note) => /concurrency group/.test(note)));
});

rmSync(projectDir, { recursive: true, force: true });
rmSync(libDir, { recursive: true, force: true });
rmSync(process.env.HATCHKIT_CONF_DIR as string, { recursive: true, force: true });

check("the guard's defaults match what the server-migrations feature generates", () => {
  // This agreement fails in the dangerous direction. A guard pointed at
  // the wrong directory finds no registry; an absent registry is the
  // easy case that blocks nothing; and the job then rolls the server
  // back past a migration the previous build cannot read, which is the
  // outage the guard exists to prevent. So it is pinned against the
  // feature's own templates rather than trusted to stay in step.
  const featureSrc = readFileSync(
    new URL("./src/features/server-migrations/index.ts", import.meta.url),
    "utf-8",
  );
  assert.ok(
    featureSrc.includes("src/services/migrations/registry.ts"),
    "server-migrations no longer writes its registry where the guard looks",
  );
  assert.equal(DEFAULT_MIGRATIONS_DIR, "packages/server/src/services/migrations");

  const types = readFileSync(
    new URL(
      "./src/templates/features/server-migrations/services/migrations/types.ts.tpl",
      import.meta.url,
    ),
    "utf-8",
  );
  // The two field names the reader looks for must be the two the
  // generated Migration type actually declares.
  assert.match(types, new RegExp(`\\b${DEFAULT_MIN_READER_FIELD}\\b`));
  assert.match(types, new RegExp(`\\b${DEFAULT_ID_FIELD}:`));
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all verified-deploy checks passed\n");
