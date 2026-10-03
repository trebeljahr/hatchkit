/**
 * Opt-in integration of a built scaffold's actual production server, Mongo,
 * Redis, authentication, HTTP mutations, room sockets and core sync client.
 * This test is deliberately absent from test-support/suite.json.
 *
 * Install the scaffold dependencies and build shared, core and server first.
 * The scaffold must include websocket + client-core and room protocol 2.
 * Keep mongo:7 and redis:7-alpine cached locally; the test never pulls images.
 *
 * Run through the fixture-credential test runner:
 *   HATCHKIT_ROLLING_TEST_APP=/path/to/built-scaffold pnpm --filter hatchkit exec node scripts/test.mjs test-rolling-app.ts
 * Optional report destination:
 *   HATCHKIT_ROLLING_TEST_REPORT=/tmp/rolling-app-result.json HATCHKIT_ROLLING_TEST_APP=/path/to/built-scaffold pnpm --filter hatchkit exec node scripts/test.mjs test-rolling-app.ts
 *
 * APP defaults to ../starter relative to this file. REPORT defaults to
 * tmpdir()/hatchkit-rolling-app-result.json. Compiled server code is copied
 * without dotenv files; child processes receive only fresh test credentials.
 * Dedicated disposable datastores bind checked random high loopback ports.
 * No production browser, image PID1, proxy or Coolify behavior is simulated.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pilot = resolve(
  process.env.HATCHKIT_ROLLING_TEST_APP || resolve(import.meta.dirname, "../starter"),
);
const reportPath = resolve(
  process.env.HATCHKIT_ROLLING_TEST_REPORT || join(tmpdir(), "hatchkit-rolling-app-result.json"),
);
const packageRoot = join(pilot, "packages/server");
for (const required of [
  "packages/server/package.json",
  "packages/server/node_modules",
  "packages/server/dist/index.js",
  "packages/core/dist/sync-client.js",
  "packages/shared/dist/index.js",
]) {
  assert.ok(
    existsSync(join(pilot, required)),
    `Missing ${required} in ${pilot}. Install scaffold dependencies, build shared/core/server, and set HATCHKIT_ROLLING_TEST_APP to the built scaffold.`,
  );
}
const requirePilot = createRequire(join(packageRoot, "package.json"));
const { WebSocket } = requirePilot("ws");
const { createSyncClient } = await import(
  pathToFileURL(join(pilot, "packages/core/dist/sync-client.js")).href
);
const scratch = mkdtempSync(join(tmpdir(), "hatchkit-actual-app-"));
const isolatedApp = join(scratch, "server");
mkdirSync(isolatedApp);
// config/env.js resolves dotenv files relative to this copy. Copy compiled code
// and dependencies only, so no generated .env.production or .env.keys is read.
cpSync(join(packageRoot, "dist"), join(isolatedApp, "dist"), { recursive: true });
copyFileSync(join(packageRoot, "package.json"), join(isolatedApp, "package.json"));
symlinkSync(join(packageRoot, "node_modules"), join(isolatedApp, "node_modules"), "dir");
const id = randomUUID();
const mongoName = `hatchkit-actual-mongo-${id}`;
const redisName = `hatchkit-actual-redis-${id}`;
const ownedContainers = new Set();
const processes = [];
const sockets = [];
const syncClients = [];
const authSecret = randomUUID() + randomUUID();
const deadline = new AbortController();
process.once("SIGINT", () => deadline.abort(new Error("Integration interrupted")));
process.once("SIGTERM", () => deadline.abort(new Error("Integration terminated")));
const reservedPorts = new Set();
const deadlineTimer = setTimeout(
  () => deadline.abort(new Error("Actual-app integration exceeded 105 seconds")),
  105_000,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  source: pilot,
  compiledServerSha256: createHash("sha256")
    .update(readFileSync(join(isolatedApp, "dist/index.js")))
    .digest("hex"),
  checks: [],
  limitations: [
    "Native compiled server processes; no client browser, TLS cookie policy, container PID1, or Coolify/proxy rollout tested.",
    "items.create has no idempotency-key contract. Repeated set-value updates are tested for state convergence, not exactly-once business actions.",
    "Bad candidate startup isolation is tested. Automated routing rollback and compatibility between different release binaries are not tested.",
  ],
};
let sampling = false;
let sampler: Promise<void> | undefined;
const statuses = [];
const command = (args, timeout = 15_000) =>
  new Promise((resolve, reject) => {
    execFile("docker", args, { timeout, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
async function eventually(label, check, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    deadline.signal.throwIfAborted();
    if (await check()) return;
    await sleep(80);
  }
  throw new Error(`Timed out: ${label}`);
}
function passed(label) {
  report.checks.push(label);
  console.log(`✓ ${label}`);
}
async function highPort() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = randomInt(49152, 65536);
    if (reservedPorts.has(port)) continue;
    const listener = createServer();
    try {
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => listener.close(resolve));
      reservedPorts.add(port);
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No free high port after three attempts");
}
async function fetchLocal(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(2500)]),
  });
}
async function health(server) {
  try {
    const response = await fetchLocal(`${server.url}/api/health`);
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: 0, body: {} };
  }
}
async function startServer(revision, port, mongoUri, redisUrl, apiOrigin, frontendOrigin) {
  const child = spawn(process.execPath, [join(isolatedApp, "dist/index.js")], {
    cwd: isolatedApp,
    env: {
      PATH: process.env.PATH || "",
      NODE_ENV: "production",
      HATCHKIT_KEYCHAIN_ACCESS: "deny",
      PORT: String(port),
      COMMIT_SHA: revision,
      MONGODB_URI: mongoUri,
      REDIS_URL: redisUrl,
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: apiOrigin,
      FRONTEND_URL: frontendOrigin,
      // Explicit synthetic-account policy; no email service or real account is used.
      AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
      SHUTDOWN_DRAIN_SECONDS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { child, port, url: `http://127.0.0.1:${port}`, revision, log: "" };
  server.exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  child.stdout.on("data", (value) => {
    server.log = (server.log + value).slice(-10000);
  });
  child.stderr.on("data", (value) => {
    server.log = (server.log + value).slice(-10000);
  });
  child.on("error", (error) => {
    server.log += error.message;
  });
  processes.push(server);
  return server;
}
async function ready(server) {
  await eventually(`${server.revision} ready`, async () => {
    if (server.child.exitCode !== null || server.child.signalCode !== null)
      throw new Error(`${server.revision} exited before readiness`);
    const state = await health(server);
    if (state.status === 200)
      assert.equal(
        state.body.roomProtocol,
        2,
        "The built server must expose roomProtocol 2; rebuild with current starter sources",
      );
    return state.status === 200 && state.body.db === true && state.body.redis === true;
  });
}
async function signup(server, suffix, frontendOrigin) {
  const response = await fetchLocal(`${server.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: frontendOrigin },
    body: JSON.stringify({
      name: `Pilot ${suffix}`,
      email: `${suffix}-${id}@example.invalid`,
      password: `Disposable-${id}-password`,
    }),
  });
  assert.equal(response.status, 200, `real signup ${suffix}`);
  const body = await response.json();
  assert.ok(body.user?.id, "signup returns synthetic user id");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie, "real signup issues session cookie");
  return { userId: body.user.id, cookie };
}
async function rpc(server, user, path, input, mutate = false) {
  const response = await fetchLocal(
    `${server.url}/api/trpc/${path}${mutate ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
    {
      method: mutate ? "POST" : "GET",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      ...(mutate ? { body: JSON.stringify(input) } : {}),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${body.error?.message || "unexpected status"}`);
  assert.ok(body.result && "data" in body.result, `${path} returned data`);
  return body.result.data;
}
function room(server, user, origin) {
  const socket = new WebSocket(`${server.url.replace("http:", "ws:")}/ws?roomId=actual-pilot`, {
    headers: { cookie: user.cookie },
    origin,
  });
  sockets.push(socket);
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  socket.on("error", () => {});
  const members = () =>
    messages
      .filter((message) => message.type === "room-state")
      .at(-1)
      ?.members?.map((member) => member.userId)
      .sort() ?? [];
  return { socket, messages, members };
}
function sync(server, user, origin) {
  const messages = [];
  const closeCodes = [];
  let opens = 0;
  class AuthenticatedSocket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { cookie: user.cookie }, origin });
      sockets.push(this);
      this.on("close", (code) => closeCodes.push(code));
    }
  }
  const client = createSyncClient({
    url: `${server.url.replace("http:", "ws:")}/api/sync`,
    WebSocketImpl: AuthenticatedSocket,
    minBackoffMs: 100,
    maxBackoffMs: 400,
    onEvent: (event) => messages.push(event),
    onStatus: (status) => {
      if (status === "open") opens += 1;
    },
  });
  syncClients.push(client);
  client.connect();
  return { client, messages, closeCodes, opens: () => opens };
}
async function rejectedSync(server, origin) {
  const socket = new WebSocket(`${server.url.replace("http:", "ws:")}/api/sync`, { origin });
  sockets.push(socket);
  let status = 0;
  socket.on("unexpected-response", (_request, response) => {
    status = response.statusCode;
    response.resume();
    socket.terminate();
  });
  socket.on("error", () => {});
  await eventually("anonymous sync refused", () => status > 0, 4000);
  assert.equal(status, 401);
}
try {
  const mongoPort = await highPort();
  const redisPort = await highPort();
  const oldPort = await highPort();
  const nextPort = await highPort();
  const frontendPort = await highPort();
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const apiOrigin = `http://127.0.0.1:${oldPort}`;
  const mongoUri = `mongodb://127.0.0.1:${mongoPort}/rolling_pilot?heartbeatFrequencyMS=500&serverSelectionTimeoutMS=1500&connectTimeoutMS=1000`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  ownedContainers.add(mongoName);
  await command([
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    mongoName,
    "--publish",
    `127.0.0.1:${mongoPort}:27017`,
    "mongo:7",
    "--bind_ip_all",
  ]);
  ownedContainers.add(redisName);
  await command([
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    redisName,
    "--publish",
    `127.0.0.1:${redisPort}:6379`,
    "redis:7-alpine",
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  await eventually("disposable Mongo starts", async () => {
    try {
      return (
        (
          await command(
            ["exec", mongoName, "mongosh", "--quiet", "--eval", "db.adminCommand({ping:1}).ok"],
            3000,
          )
        ).stdout.trim() === "1"
      );
    } catch {
      return false;
    }
  });
  await eventually("disposable Redis starts", async () => {
    try {
      return (
        (await command(["exec", redisName, "redis-cli", "ping"], 3000)).stdout.trim() === "PONG"
      );
    } catch {
      return false;
    }
  });
  const old = await startServer(
    "actual-old",
    oldPort,
    mongoUri,
    redisUrl,
    apiOrigin,
    frontendOrigin,
  );
  await ready(old);
  const next = await startServer(
    "actual-next",
    nextPort,
    mongoUri,
    redisUrl,
    apiOrigin,
    frontendOrigin,
  );
  await ready(next);
  passed("Two actual compiled servers ready against isolated Mongo and Redis");

  const preflight = await fetchLocal(`${next.url}/api/health`, {
    method: "OPTIONS",
    headers: {
      origin: frontendOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), frontendOrigin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  const alice = await signup(old, "alice", frontendOrigin);
  const bob = await signup(old, "bob", frontendOrigin);
  for (const server of [old, next]) {
    const response = await fetchLocal(`${server.url}/api/auth/get-session`, {
      headers: { cookie: alice.cookie, origin: frontendOrigin },
    });
    assert.equal((await response.json()).user?.id, alice.userId);
  }
  await rejectedSync(next, frontendOrigin);
  passed(
    "Real signup/session cookie works on both replicas; split-origin CORS; anonymous sync refused",
  );

  let roomA = room(old, alice, frontendOrigin);
  let roomB = room(next, bob, frontendOrigin);
  const expectedMembers = [alice.userId, bob.userId].sort();
  await eventually(
    "authenticated rooms share presence",
    () =>
      JSON.stringify(roomA.members()) === JSON.stringify(expectedMembers) &&
      JSON.stringify(roomB.members()) === JSON.stringify(expectedMembers),
  );
  roomA.socket.send(JSON.stringify({ type: "chat", text: "actual cross-replica chat" }));
  await eventually("authenticated cross-replica chat", () =>
    [roomA, roomB].every((connection) =>
      connection.messages.some((message) => message.type === "chat"),
    ),
  );
  await sleep(120);
  for (const connection of [roomA, roomB])
    assert.equal(connection.messages.filter((message) => message.type === "chat").length, 1);
  passed("Real authenticated WebSocket room presence and once-per-replica chat");

  // Alice subscribes only on the new replica. Her mutation reaches the old
  // replica, which has zero local Alice sync listeners.
  const syncAlice = sync(next, alice, frontendOrigin);
  const syncBob = sync(next, bob, frontendOrigin);
  await eventually(
    "real sync clients open",
    () => syncAlice.opens() === 1 && syncBob.opens() === 1,
  );
  const item = await rpc(
    old,
    alice,
    "items.create",
    { title: "Before replacement", description: "Disposable rolling test record" },
    true,
  );
  await eventually("durable create invalidation crosses replica boundary", () =>
    syncAlice.messages.some((event) => event.id === item.id),
  );
  assert.equal((await rpc(next, alice, "items.get", { id: item.id })).title, "Before replacement");
  assert.equal(
    syncBob.messages.some((event) => event.id === item.id),
    false,
  );
  await rpc(
    next,
    alice,
    "items.update",
    { id: item.id, title: "Changed during overlap", status: "published" },
    true,
  );
  await rpc(
    old,
    alice,
    "items.update",
    { id: item.id, title: "Changed during overlap", status: "published" },
    true,
  );
  const records = await rpc(next, alice, "items.list", { limit: 20 });
  assert.equal(records.items.length, 1);
  assert.equal(records.items[0].title, "Changed during overlap");
  assert.equal(records.items[0].status, "published");
  passed(
    "Durable create/update/refetch survives replicas; repeated set-value update converges; sync isolates users",
  );

  const beforeResetOpens = syncAlice.opens();
  await Promise.all([
    command(["restart", "--time", "0", redisName]),
    eventually("actual Redis failure fails readiness", async () => {
      const state = await health(next);
      return state.status === 503 && state.body.redis === false;
    }),
  ]);
  await ready(old);
  await ready(next);
  await eventually(
    "actual sync reconnects after Redis loss",
    () =>
      syncAlice.closeCodes.includes(1012) &&
      syncAlice.opens() > beforeResetOpens &&
      syncAlice.client.status() === "open",
  );
  roomA.socket.terminate();
  roomB.socket.terminate();
  roomA = room(old, alice, frontendOrigin);
  roomB = room(next, bob, frontendOrigin);
  await eventually(
    "real room rejoin after Redis reset",
    () =>
      JSON.stringify(roomA.members()) === JSON.stringify(expectedMembers) &&
      JSON.stringify(roomB.members()) === JSON.stringify(expectedMembers),
  );
  const beforeUpdate = syncAlice.messages.length;
  await rpc(
    old,
    alice,
    "items.update",
    { id: item.id, description: "After Redis reconnect" },
    true,
  );
  await eventually(
    "actual invalidations resume after Redis reset",
    () => syncAlice.messages.length > beforeUpdate,
  );
  assert.equal(
    (await rpc(next, alice, "items.get", { id: item.id })).description,
    "After Redis reconnect",
  );
  passed(
    "Actual Redis readiness failure/recovery, room rejoin, core SyncClient reconnect and durable refetch",
  );

  await Promise.all([
    command(["restart", "--time", "1", mongoName]),
    eventually("actual Mongo failure fails readiness", async () => {
      const state = await health(next);
      return state.status === 503 && state.body.db === false;
    }),
  ]);
  await ready(old);
  await ready(next);
  assert.equal(
    (await rpc(next, alice, "items.get", { id: item.id })).title,
    "Changed during overlap",
  );
  passed("Actual Mongo readiness failure/recovery preserves authenticated durable record");

  sampling = true;
  sampler = (async () => {
    while (sampling) {
      try {
        const response = await fetchLocal(
          `${next.url}/api/trpc/items.get?input=${encodeURIComponent(JSON.stringify({ id: item.id }))}`,
          { headers: { cookie: alice.cookie } },
        );
        statuses.push(response.status);
        await response.arrayBuffer();
      } catch {
        statuses.push(0);
      }
      await sleep(40);
    }
  })();
  const badPort = await highPort();
  const absentMongoPort = await highPort();
  const bad = await startServer(
    "bad-database-candidate",
    badPort,
    `mongodb://127.0.0.1:${absentMongoPort}/absent?serverSelectionTimeoutMS=1000&connectTimeoutMS=500`,
    redisUrl,
    apiOrigin,
    frontendOrigin,
  );
  await eventually("bad candidate exits before readiness", () => bad.child.exitCode !== null, 5000);
  assert.notEqual(bad.child.exitCode, 0);
  assert.equal((await health(bad)).status, 0);
  passed(
    "Actual bad-database candidate refuses startup while existing replica serves authenticated API",
  );

  let retiredCode = 0;
  roomA.socket.once("close", (code) => {
    retiredCode = code;
  });
  old.child.kill("SIGTERM");
  await eventually(
    "actual old replica drain readiness",
    async () => (await health(old)).status === 503,
    1500,
  );
  assert.equal((await rpc(old, alice, "items.get", { id: item.id })).id, item.id);
  await eventually(
    "actual old replica terminates cleanly",
    () => old.child.exitCode !== null || old.child.signalCode !== null,
    12_000,
  );
  assert.equal((await old.exited).code, 0);
  await eventually("actual room gets retryable restart close", () => retiredCode === 1001);
  roomA = room(next, alice, frontendOrigin);
  await eventually(
    "actual authenticated room rejoins replacement",
    () => JSON.stringify(roomA.members()) === JSON.stringify(expectedMembers),
  );
  assert.equal(
    (await rpc(next, alice, "items.get", { id: item.id })).title,
    "Changed during overlap",
  );
  sampling = false;
  await sampler;
  assert.ok(statuses.length >= 25);
  assert.equal(statuses.filter((status) => status !== 200).length, 0);
  report.authenticatedReplacementSamples = statuses.length;
  passed(
    `Actual server SIGTERM drain/rejoin preserves state; ${statuses.length} authenticated replacement-endpoint samples all 200`,
  );
  report.completed = true;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Result: ${reportPath}`);
  for (const limitation of report.limitations) console.log(`Scope: ${limitation}`);
} catch (error) {
  report.completed = false;
  report.failure = error.message;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  for (const server of processes)
    console.error(
      `Actual replica ${server.revision}, exit=${server.child.exitCode}:\n${server.log}`,
    );
  throw error;
} finally {
  clearTimeout(deadlineTimer);
  sampling = false;
  for (const client of syncClients) client.close();
  for (const socket of sockets) socket.terminate();
  await sampler?.catch(() => {});
  for (const server of processes)
    if (server.child.exitCode === null && server.child.signalCode === null)
      server.child.kill("SIGKILL");
  await Promise.race([Promise.all(processes.map((server) => server.exited)), sleep(3000)]);
  for (const container of ownedContainers)
    await command(["rm", "--force", container]).catch((error) => {
      console.error(`Cleanup failed for ${container}: ${error.message}`);
      process.exitCode = 1;
    });
  rmSync(scratch, { recursive: true, force: true });
}
