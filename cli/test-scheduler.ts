/**
 * `scheduler` server platform feature writer tests.
 *
 * Verifies that:
 *   1. A first run writes the eight server files + docs/scheduler.md,
 *      patches src/index.ts to start the loop after the DB connects and
 *      to stop it in shutdown(), and adds SCHEDULER_ENABLED to both
 *      src/config/env.ts and .env.example.
 *   2. A second run is a complete no-op — nothing written, nothing
 *      patched — which is what makes `create` and `update` the same call.
 *   3. A project with no server package reports `skipped` instead of
 *      writing a scheduler into thin air.
 *   4. The generated lease still obeys the two rules that fail quietly:
 *      the CLAIM moves nextRunAt forward, and the RELEASE filters on
 *      lockedBy and leaves nextRunAt alone.
 *
 * Run: pnpm --filter hatchkit test:scheduler
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { applyScheduler } from "./src/features/scheduler/index.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

/** Enough of a scaffolded project for `resolveServerDir` to find it and
 *  for every anchor the writer patches to be present. The index.ts and
 *  env.ts text is copied from starter/packages/server, because a fake
 *  that drifts from the real file is a test that passes while the
 *  feature silently stops patching anything. */
function fakeProject(root: string): void {
  const server = join(root, "packages", "server");
  write(
    join(server, "package.json"),
    `${JSON.stringify(
      {
        name: "@starter/server",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: { test: "node --import tsx --test src/tests/*.test.ts" },
        dependencies: { mongoose: "^9.6.2" },
      },
      null,
      2,
    )}\n`,
  );
  write(
    join(server, "src", "index.ts"),
    `// Sentry must be imported first
import "./instrument.js";

import { createServer } from "http";
import { createApp } from "./app.js";
import { connectToDB, disconnectFromDB } from "./db/connection.js";
import { connectRedis, disconnectRedis } from "./db/redis.js";
import { initAuth, disconnectAuth } from "./auth/auth.js";
import { setupWebSocket } from "./ws/handler.js";
import { warnStripeStatus } from "./services/stripe.js";
import { env } from "./config/env.js";

const app = createApp();
const server = createServer(app);
const wss = setupWebSocket(server);

async function start(): Promise<void> {
  try {
    // 1. Connect to databases
    await connectToDB();
    await connectRedis();

    // 2. Initialize auth (needs DB connection)
    await initAuth();

    // 3. Surface "Stripe is not configured" warnings before serving traffic
    warnStripeStatus();

    // 4. Start listening
    server.listen(env.PORT, () => {
      console.log(\`[server] Listening on http://127.0.0.1:\${env.PORT}\`);
    });
  } catch (err) {
    console.error("[server] Failed to start:", err);
    process.exit(1);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(\`\\n[server] \${signal} received, shutting down gracefully...\`);

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, "Server shutting down");
  }

  // Stop accepting new connections
  server.close();

  // Disconnect from databases and auth
  await disconnectAuth();
  await disconnectRedis();
  await disconnectFromDB();

  console.log("[server] Shutdown complete");
  process.exit(0);
}

start();
`,
  );
  write(
    join(server, "src", "config", "env.ts"),
    `function getOptional(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

export const env = {
  NODE_ENV: getOptional("NODE_ENV", "development"),
  PORT: parseInt(getOptional("PORT", "5000"), 10),

  isProduction: getOptional("NODE_ENV") === "production",
  isTest: getOptional("NODE_ENV") === "test",
} as const;
`,
  );
  write(join(server, ".env.example"), "PORT=5000\nMONGODB_URI=mongodb://127.0.0.1:27017/starter\n");
  write(join(root, "CLAUDE.md"), "# Starter\n\nProject memory.\n");
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf-8");

/** The body of one exported function, so an assertion about the release
 *  query can't accidentally match the claim's. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  if (start === -1) return "";
  const next = source.indexOf("\nexport ", start + 1);
  const end = next === -1 ? source.length : next;
  return source.slice(start, end);
}

const root = mkdtempSync(join(tmpdir(), "hatchkit-scheduler-"));
const empty = mkdtempSync(join(tmpdir(), "hatchkit-scheduler-empty-"));
try {
  fakeProject(root);
  const args = { projectDir: root, projectName: "demo-app" };

  // ── first run ────────────────────────────────────────────────────
  const first = applyScheduler(args);

  assert(first.skipped === undefined, `first run not skipped (got ${first.skipped})`);
  const expected = [
    "packages/server/src/models/ScheduledJob.ts",
    "packages/server/src/services/scheduler/registry.ts",
    "packages/server/src/services/scheduler/lease.ts",
    "packages/server/src/services/scheduler/scheduler.ts",
    "packages/server/src/services/scheduler/heartbeat.ts",
    "packages/server/src/services/scheduler/index.ts",
    "packages/server/src/tests/support/test-database.ts",
    "packages/server/src/tests/scheduler-lease.test.ts",
    "docs/scheduler.md",
  ];
  for (const file of expected) {
    assert(first.written.includes(file), `first run wrote ${file}`);
  }
  assert(
    first.written.length === expected.length,
    `first run wrote ${first.written.length} file(s), expected ${expected.length}`,
  );
  assert(first.conflicted.length === 0, `first run reported ${first.conflicted.length} conflicts`);

  // ── src/index.ts: start after the DB, stop in shutdown ───────────
  const index = read(root, "packages/server/src/index.ts");
  assert(
    first.patched.includes("packages/server/src/index.ts"),
    "first run reported src/index.ts as patched",
  );
  assert(
    index.includes(
      'import { registerBuiltInJobs, startScheduler, stopScheduler } from "./services/scheduler/index.js";',
    ),
    "src/index.ts imports the scheduler surface",
  );
  assert(
    index.includes("registerBuiltInJobs();") &&
      index.includes("startScheduler({ enabled: env.SCHEDULER_ENABLED, isTest: env.isTest });"),
    "src/index.ts starts the scheduler",
  );
  assert(
    index.indexOf("await connectToDB();") < index.indexOf("registerBuiltInJobs();"),
    "the scheduler starts AFTER the database connects",
  );
  assert(
    index.indexOf("registerBuiltInJobs();") < index.indexOf("server.listen(env.PORT"),
    "the scheduler starts BEFORE the first request is served",
  );
  assert(
    index.indexOf("registerBuiltInJobs();") < index.indexOf("startScheduler("),
    "jobs are registered before the loop starts",
  );
  assert(index.includes("await stopScheduler();"), "shutdown() stops the scheduler");
  assert(
    index.indexOf("server.close();") < index.indexOf("await stopScheduler();") &&
      index.indexOf("await stopScheduler();") < index.indexOf("await disconnectFromDB();"),
    "the loop is stopped after server.close() and before the DB goes away",
  );

  // ── the switch ───────────────────────────────────────────────────
  const envConfig = read(root, "packages/server/src/config/env.ts");
  assert(envConfig.includes("SCHEDULER_ENABLED"), "SCHEDULER_ENABLED lands in src/config/env.ts");
  assert(
    envConfig.indexOf("SCHEDULER_ENABLED") < envConfig.indexOf("isProduction:"),
    "SCHEDULER_ENABLED is inserted inside the env object literal",
  );
  assert(
    first.patched.includes("packages/server/src/config/env.ts"),
    "first run reported src/config/env.ts as patched",
  );
  const envExample = read(root, "packages/server/.env.example");
  assert(
    envExample.includes("SCHEDULER_ENABLED=true"),
    "SCHEDULER_ENABLED=true lands in .env.example",
  );
  assert(
    first.patched.includes("packages/server/.env.example"),
    "first run reported .env.example as patched",
  );
  assert(first.patched.includes("CLAUDE.md"), "first run appended the CLAUDE.md section");

  // ── the two rules that fail quietly ──────────────────────────────
  const lease = read(root, "packages/server/src/services/scheduler/lease.ts");
  const claim = functionBody(lease, "claimScheduledJob");
  const release = functionBody(lease, "releaseScheduledJob");

  assert(claim.length > 0 && release.length > 0, "lease.ts exports a claim and a release");
  assert(
    claim.includes("nextRunAt: new Date(now.getTime() + intervalMs)"),
    "the CLAIM moves nextRunAt one interval forward",
  );
  assert(claim.includes("nextRunAt: { $lte: now }"), "the CLAIM only matches a due row");
  assert(claim.includes("lockedBy: owner"), "the CLAIM writes the holder");
  assert(
    release.includes("{ name, lockedBy: owner }"),
    "the RELEASE filters on lockedBy, so a lapsed holder cannot clear its successor",
  );
  assert(
    !release.includes("nextRunAt"),
    "the RELEASE does NOT touch nextRunAt — scheduling happens at claim time",
  );

  // Registration has exactly one door.
  const registry = read(root, "packages/server/src/services/scheduler/registry.ts");
  assert(
    registry.includes("export function registerRecurringJob("),
    "registry.ts exports the single registration entry point",
  );

  // ── second run: a complete no-op ─────────────────────────────────
  const second = applyScheduler(args);
  assert(second.skipped === undefined, "second run not skipped");
  assert(second.written.length === 0, `second run wrote ${second.written.length} (expected 0)`);
  assert(second.patched.length === 0, `second run patched ${second.patched.length} (expected 0)`);
  assert(
    second.conflicted.length === 0,
    `second run reported ${second.conflicted.length} conflicts (expected 0)`,
  );
  assert(
    second.unchanged.length === expected.length,
    `second run reported ${second.unchanged.length} unchanged (expected ${expected.length})`,
  );
  assert(
    read(root, "packages/server/src/index.ts") === index,
    "second run left src/index.ts byte-identical",
  );
  assert(
    read(root, "packages/server/src/config/env.ts") === envConfig,
    "second run left src/config/env.ts byte-identical",
  );
  assert(
    read(root, "packages/server/.env.example") === envExample,
    "second run left .env.example byte-identical",
  );

  // ── no server package ────────────────────────────────────────────
  const none = applyScheduler({ projectDir: empty, projectName: "static-site" });
  assert(typeof none.skipped === "string", "a project with no server package is skipped");
  assert(none.written.length === 0, "a skipped project has nothing written");
  assert(none.patched.length === 0, "a skipped project has nothing patched");

  if (failed === 0) {
    console.log("test-scheduler: ok");
    process.exit(0);
  } else {
    console.error(`test-scheduler: ${failed} assertion(s) failed`);
    process.exit(1);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
}
