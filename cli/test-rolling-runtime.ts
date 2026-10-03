/**
 * Real Redis + separate Node processes exercising unchanged starter modules.
 * Run explicitly through scripts/test.mjs; this is not in the fast test suite.
 *
 * Needs a locally cached redis:7-alpine image and installed starter server deps.
 * HATCHKIT_ROLLING_TEST_SERVER_PACKAGE may point to an installed scaffold's
 * packages/server directory. Only its node_modules is used; no env files or
 * application code from that scaffold are read. Nothing connects to live data.
 *
 * The HTTP proxy, authentication edge and signal wiring are fixtures. This
 * validates room state, Redis recovery and the production reconnect helper,
 * not production browser cookies, the app router, Docker stop or Coolify.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const run = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
const repo = resolve(import.meta.dirname, "..");
const dependencyPackage = resolve(
  process.env.HATCHKIT_ROLLING_TEST_SERVER_PACKAGE ?? join(repo, "starter/packages/server"),
);
assert.ok(
  existsSync(join(dependencyPackage, "node_modules")),
  "Install starter server dependencies, or set HATCHKIT_ROLLING_TEST_SERVER_PACKAGE to an installed scaffold's packages/server",
);
const requireDependencies = createRequire(join(dependencyPackage, "package.json"));
const { WebSocket } = requireDependencies("ws");
const tsx = pathToFileURL(requireDependencies.resolve("tsx")).href;
const scratch = mkdtempSync(join(tmpdir(), "hatchkit-rolling-runtime-"));
const container = `hatchkit-rolling-test-${randomUUID()}`;
const workers: Array<{
  child: ChildProcess;
  port: number;
  exited: Promise<number | null>;
  log: () => string;
}> = [];
const sockets: Array<InstanceType<typeof WebSocket>> = [];
let containerCreated = false;
let proxy: ReturnType<typeof createServer> | undefined;
let routingTimer: ReturnType<typeof setInterval> | undefined;
let sampler: Promise<void> | undefined;
let sample = true;
let reconnecting: { stop(): void } | undefined;
const syncClients: Array<{ close(): void }> = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const docker = (...args: string[]) =>
  run("docker", args, { timeout: 20_000, maxBuffer: 128 * 1024 });

async function freeHighPort(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = randomInt(49152, 65536);
    const reservation = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(candidate, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No free high port after three attempts");
}

async function eventually(
  label: string,
  check: () => boolean | Promise<boolean>,
  timeout = 8000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error(`Timed out: ${label}`);
}

async function status(port: number): Promise<number> {
  try {
    return (
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
    ).status;
  } catch {
    return 0;
  }
}

async function startWorker(revision: string, redisUrl: string) {
  const child = spawn(process.execPath, ["--import", tsx, join(scratch, "worker.ts")], {
    cwd: scratch,
    // Deliberately no inherited provider credentials or dotenvx keys.
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HATCHKIT_KEYCHAIN_ACCESS: "deny",
      FIXTURE_REVISION: revision,
      REDIS_URL: redisUrl,
      MONGODB_URI: "mongodb://127.0.0.1:1/unused-fixture",
      BETTER_AUTH_SECRET: "synthetic-local-rolling-runtime-fixture-only",
      BETTER_AUTH_URL: "http://127.0.0.1",
      FRONTEND_URL: "http://127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => {
    log = (log + chunk).slice(-16000);
  });
  child.stderr?.on("data", (chunk) => {
    log = (log + chunk).slice(-16000);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const worker = { child, port: 0, exited, log: () => log };
  workers.push(worker);
  child.on("message", (message: { event?: string; port?: number }) => {
    if (message.event === "ready") worker.port = message.port!;
  });
  await eventually(`${revision} starts (${log})`, () => {
    if (child.exitCode !== null) throw new Error(`${revision} exited: ${log}`);
    return worker.port > 0;
  });
  return worker;
}

function connect(port: number, userId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=rollout`, {
    headers: { "x-fixture-user": userId },
  });
  sockets.push(ws);
  const messages: any[] = [];
  ws.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
  ws.on("error", () => {});
  const members = () =>
    messages
      .filter((m) => m.type === "room-state")
      .at(-1)
      ?.members?.map((m: { userId: string }) => m.userId)
      .sort() ?? [];
  return { ws, messages, members };
}

try {
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
  mkdirSync(join(scratch, "node_modules"));
  for (const name of readdirSync(join(dependencyPackage, "node_modules"))) {
    if (name === "@starter" || name.startsWith(".")) continue;
    symlinkSync(
      join(dependencyPackage, "node_modules", name),
      join(scratch, "node_modules", name),
      "dir",
    );
  }
  // Resolve only the shared runtime protocols used by these production modules.
  // The files are copied byte-for-byte; no scaffold env or source is reused.
  const shared = join(scratch, "node_modules/@starter/shared");
  mkdirSync(shared, { recursive: true });
  writeFileSync(
    join(shared, "package.json"),
    '{"name":"@starter/shared","type":"module","exports":"./index.ts"}',
  );
  writeFileSync(
    join(shared, "index.ts"),
    'export * from "./sync-protocol.js"; export * from "./api-level.js";',
  );
  for (const file of ["sync-protocol.ts", "api-level.ts"]) {
    copyFileSync(join(repo, "starter/packages/shared/src", file), join(shared, file));
  }
  for (const file of [
    "ws/rooms.ts",
    "sync/feed.ts",
    "db/redis.ts",
    "config/env.ts",
    "drain.ts",
    "shutdown.ts",
  ]) {
    const dest = join(scratch, "src", file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(repo, "starter/packages/server/src", file), dest);
  }
  copyFileSync(
    join(repo, "starter/packages/client/src/lib/room-socket.ts"),
    join(scratch, "room-socket.ts"),
  );
  copyFileSync(
    join(repo, "starter/packages/core/src/sync-client.ts"),
    join(scratch, "sync-client.ts"),
  );
  copyFileSync(
    join(import.meta.dirname, "test-support/rolling-runtime-worker.ts"),
    join(scratch, "worker.ts"),
  );

  // No pull, host mounts or persistent volume. Explicitly retain a verified
  // random high port: Docker reallocates an auto-published port on restart.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const redisPort = await freeHighPort();
    containerCreated = true;
    try {
      await docker(
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        container,
        "--publish",
        `127.0.0.1:${redisPort}:6379`,
        "redis:7-alpine",
        "redis-server",
        "--save",
        "",
        "--appendonly",
        "no",
      );
      break;
    } catch (error) {
      if (!/already allocated|address already in use/i.test(String(error)) || attempt === 2)
        throw error;
      await docker("rm", "--force", container).catch(() => undefined);
      containerCreated = false;
    }
  }
  const portOutput = (await docker("port", container, "6379/tcp")).stdout.trim();
  assert.match(portOutput, /^127\.0\.0\.1:\d+$/);
  const redisUrl = `redis://${portOutput}`;
  const old = await startWorker("old", redisUrl);
  const next = await startWorker("next", redisUrl);
  await eventually(
    "both replicas ready",
    async () => (await status(old.port)) === 200 && (await status(next.port)) === 200,
  );

  const a = connect(old.port, "alice");
  let b = connect(next.port, "bob");
  await eventually(
    "cross-replica membership",
    () =>
      JSON.stringify(a.members()) === '["alice","bob"]' &&
      JSON.stringify(b.members()) === '["alice","bob"]',
  );
  a.ws.send(JSON.stringify({ type: "join-room", roomId: "rollout" }));
  await sleep(150);
  assert.deepEqual(a.members(), ["alice", "bob"], "repeated join is idempotent");
  a.ws.send(JSON.stringify({ type: "chat", text: "one-delivery" }));
  await eventually("chat reaches both replicas", () =>
    [a, b].every((c) => c.messages.some((m) => m.type === "chat" && m.text === "one-delivery")),
  );
  await sleep(100);
  for (const c of [a, b])
    assert.equal(
      c.messages.filter((m) => m.type === "chat" && m.text === "one-delivery").length,
      1,
    );
  a.ws.close();
  await eventually(
    "last local leave reaches other replica",
    () => JSON.stringify(b.members()) === '["bob"]',
  );
  console.log("✓ Shared presence, idempotent join, chat delivery once, final local leave");

  const { createSyncClient } = await import(pathToFileURL(join(scratch, "sync-client.ts")).href);
  function connectSync(port: number, userId: string) {
    const messages: Array<{ event: unknown; originId?: string }> = [];
    const closeCodes: number[] = [];
    let opens = 0;
    class FixtureSocket extends WebSocket {
      constructor(url: string, protocols?: string[]) {
        super(url, protocols, { headers: { "x-fixture-user": userId } });
        sockets.push(this);
        this.on("close", (code: number) => closeCodes.push(code));
      }
    }
    const client = createSyncClient({
      url: `ws://127.0.0.1:${port}/api/sync`,
      WebSocketImpl: FixtureSocket,
      minBackoffMs: 100,
      maxBackoffMs: 250,
      onEvent: (event: unknown, originId?: string) => messages.push({ event, originId }),
      // Real apps attach their authoritative refetch here. Count notifications,
      // not a fabricated durable-state guarantee from this synthetic fixture.
      onStatus: (status: string) => {
        if (status === "open") opens += 1;
      },
    });
    syncClients.push(client);
    client.connect();
    return { client, messages, closeCodes, opens: () => opens };
  }
  async function publishSync(port: number, userId: string, originId: string) {
    const response = await fetch(`http://127.0.0.1:${port}/publish-sync?originId=${originId}`, {
      headers: { "x-fixture-user": userId },
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ localSubscribers: number }>;
  }
  const syncOld = connectSync(old.port, "sync-alice");
  const syncNext = connectSync(next.port, "sync-alice");
  const syncOther = connectSync(next.port, "sync-bob");
  const syncRemoteOnly = connectSync(next.port, "sync-remote-only");
  const syncSessions = [syncOld, syncNext, syncOther, syncRemoteOnly];
  await eventually("sync subscribers open", () =>
    syncSessions.every((client) => client.opens() === 1),
  );
  assert.equal((await publishSync(old.port, "sync-alice", "sync-once")).localSubscribers, 1);
  assert.equal(
    (await publishSync(old.port, "sync-remote-only", "sync-remote")).localSubscribers,
    0,
  );
  await eventually(
    "sync delivery across replicas without local listener",
    () =>
      syncOld.messages.some((m) => m.originId === "sync-once") &&
      syncNext.messages.some((m) => m.originId === "sync-once") &&
      syncRemoteOnly.messages.some((m) => m.originId === "sync-remote"),
  );
  await sleep(100);
  assert.equal(syncOld.messages.filter((m) => m.originId === "sync-once").length, 1);
  assert.equal(syncNext.messages.filter((m) => m.originId === "sync-once").length, 1);
  assert.equal(syncRemoteOnly.messages.filter((m) => m.originId === "sync-remote").length, 1);
  assert.equal(syncOther.messages.length, 0, "another user receives no account events");
  assert.equal(
    syncRemoteOnly.messages.some((m) => m.originId === "sync-once"),
    false,
  );
  console.log("✓ SyncFeed remote-only listeners, user isolation, no duplicate local echo");

  const crashed = await startWorker("crashed", redisUrl);
  const ghost = connect(crashed.port, "ghost");
  await eventually("crash candidate joined", () => b.members().includes("ghost"));
  crashed.child.kill("SIGKILL");
  await crashed.exited;
  await eventually("crashed replica presence lease expires", () => !b.members().includes("ghost"));
  ghost.ws.terminate();
  console.log("✓ Crashed replica presence expires without graceful cleanup");

  // This Redis has no persistence: recovery must rebuild presence and force
  // clients to fetch a snapshot because pub/sub cannot replay missed messages.
  let redisRecoveryCode = 0;
  b.ws.once("close", (code: number) => {
    redisRecoveryCode = code;
  });
  await Promise.all([
    docker("restart", "--time", "0", container),
    eventually("Redis loss makes readiness fail", async () => (await status(next.port)) === 503),
  ]);
  await eventually(
    "Redis reconnect restores both replicas",
    async () => (await status(old.port)) === 200 && (await status(next.port)) === 200,
  );
  await eventually("Redis recovery asks clients to resync", () => redisRecoveryCode === 1012);
  b = connect(next.port, "bob");
  await eventually("presence rebuilt after Redis restart", () => b.members().includes("bob"));
  await eventually("production sync clients reconnect after Redis loss", () =>
    syncSessions.every(
      (client) =>
        client.closeCodes.includes(1012) &&
        client.opens() >= 2 &&
        client.client.status() === "open",
    ),
  );
  await publishSync(old.port, "sync-alice", "sync-after-restart");
  await eventually("sync fanout recovers after resubscription", () =>
    [syncOld, syncNext].every((client) =>
      client.messages.some((m) => m.originId === "sync-after-restart"),
    ),
  );
  await sleep(100);
  for (const client of [syncOld, syncNext]) {
    assert.equal(client.messages.filter((m) => m.originId === "sync-after-restart").length, 1);
  }
  assert.equal(syncOther.messages.length, 0);
  console.log("✓ Redis reconnect restores readiness and presence");
  console.log("✓ SyncClient receives retryable reset, reconnects, and resumes isolated delivery");
  // The remaining overlap case measures the room reconnect helper. Avoid
  // pinning this sync fixture to an intentionally retired direct server URL.
  for (const client of syncClients) client.close();

  const { RoomSocket } = await import(pathToFileURL(join(scratch, "room-socket.ts")).href);
  process.env.NEXT_PUBLIC_WS_URL = `ws://127.0.0.1:${old.port}`;
  let selected = old.port;
  let resyncs = 0;
  const roomMessages: any[] = [];
  reconnecting = new RoomSocket(
    "rollout",
    (message: unknown) => roomMessages.push(message),
    () => {
      resyncs += 1;
    },
    (url: string) => {
      const target = new URL(url);
      target.port = String(selected);
      const ws = new WebSocket(target, { headers: { "x-fixture-user": "reconnecting" } });
      sockets.push(ws);
      return ws;
    },
  );
  (reconnecting as InstanceType<typeof RoomSocket>).start();
  await eventually(
    "production client joins before resync",
    () => resyncs === 1 && roomMessages.some((m) => m.type === "room-state"),
  );
  console.log("✓ RoomSocket joined; starting HTTP overlap and shutdown check");

  let healthy = [old.port, next.port];
  let cursor = 0;
  proxy = createServer((req, res) => {
    const port = healthy[cursor++ % healthy.length];
    if (!port) {
      res.writeHead(503);
      res.end();
      return;
    }
    const upstream = request(
      { hostname: "127.0.0.1", port, path: req.url, method: req.method },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== "string");
  let updating = false;
  routingTimer = setInterval(() => {
    if (updating) return;
    updating = true;
    void Promise.all(
      [old.port, next.port].map(async (port) => ({ port, status: await status(port) })),
    )
      .then((values) => {
        healthy = values.filter((entry) => entry.status === 200).map((entry) => entry.port);
        if (!healthy.includes(old.port)) selected = next.port;
      })
      .finally(() => {
        updating = false;
      });
  }, 25);
  const samples: number[] = [];
  sampler = (async () => {
    while (sample) {
      try {
        samples.push(
          (
            await fetch(`http://127.0.0.1:${proxyAddress.port}/version`, {
              signal: AbortSignal.timeout(1500),
            })
          ).status,
        );
      } catch {
        samples.push(0);
      }
      await sleep(20);
    }
  })();
  let longRequestStarted = false;
  old.child.on("message", (message: { event?: string }) => {
    if (message.event === "long-request-started") longRequestStarted = true;
  });
  const longRequest = fetch(`http://127.0.0.1:${old.port}/slow?ms=1500`, {
    signal: AbortSignal.timeout(6000),
  }).then((res) => res.json());
  await eventually("long request accepted before drain", () => longRequestStarted);
  old.child.kill("SIGTERM");
  await eventually(
    "old health fails while still serving HTTP",
    async () => (await status(old.port)) === 503,
  );
  assert.equal((await fetch(`http://127.0.0.1:${old.port}/version`)).status, 200);
  assert.deepEqual(await longRequest, { revision: "old", completed: true });
  await eventually(
    "old replica exits after its accepted request finishes",
    () => old.child.exitCode !== null || old.child.signalCode !== null,
  );
  assert.equal(await old.exited, 0);
  await eventually(
    "client reconnects and resyncs on replacement",
    () => resyncs >= 2 && b.members().includes("reconnecting"),
  );
  await sleep(150);
  sample = false;
  await sampler;
  assert.ok(samples.length >= 20);
  assert.equal(samples.filter((code) => code !== 200).length, 0, JSON.stringify(samples));
  console.log(
    `✓ Client reconnect/resnapshot; long request finishes; ${samples.length} overlap HTTP samples, zero failures`,
  );
  console.log(
    "Fixture routing only: production auth/browser, image and Coolify rollout gates remain separate.",
  );
} catch (error) {
  // Workers receive only synthetic environment values. Keep their bounded logs
  // available when a dependency recovery assertion fails instead of hiding the
  // actual transport failure behind a polling timeout.
  for (const worker of workers) {
    console.error(
      `Fixture replica ${worker.port} (exit=${worker.child.exitCode}, signal=${worker.child.signalCode}):\n${worker.log()}`,
    );
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      const health = await fetch(`http://127.0.0.1:${worker.port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      })
        .then((response) => response.text())
        .catch(() => "unavailable");
      console.error(`Fixture readiness: ${health}`);
    }
  }
  if (containerCreated) {
    console.error(
      `Owned Redis published port: ${(await docker("port", container, "6379/tcp").catch(() => ({ stdout: "unavailable" }))).stdout.trim()}`,
    );
  }
  throw error;
} finally {
  sample = false;
  if (routingTimer) clearInterval(routingTimer);
  reconnecting?.stop();
  for (const client of syncClients) client.close();
  for (const socket of sockets) socket.terminate();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy!.close(() => resolve()));
  }
  await sampler;
  for (const worker of workers)
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      worker.child.kill("SIGKILL");
  await Promise.all(workers.map((worker) => worker.exited));
  if (containerCreated)
    await docker("rm", "--force", container).catch((error) =>
      console.error(`Cleanup failed for owned container ${container}: ${error.message}`),
    );
  rmSync(scratch, { recursive: true, force: true });
}
