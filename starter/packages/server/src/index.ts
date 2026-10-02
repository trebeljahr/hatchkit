// Sentry must be imported first
import "./instrument.js";

import { createServer } from "http";
import { createApp } from "./app.js";
import { connectToDB, disconnectFromDB } from "./db/connection.js";
import { connectRedis, disconnectRedis, getRedis } from "./db/redis.js";
import { initAuth, disconnectAuth } from "./auth/auth.js";
// ── client-core ──────────────────────────────────────────────────
// Above the `./ws/handler.js` import, not below it, and the same goes for the
// other two blocks in this file: `hatchkit update` puts a block back by
// anchoring on the line above it, and a project without the `websocket`
// feature has no `ws/` lines at all — every anchor below one would miss, and
// the sync feed would be handed to a manual checklist for a project hatchkit
// generated itself.
import { setupSyncFeed } from "./sync/handler.js";
// ── end client-core ──────────────────────────────────────────────
import { roomManager, setupWebSocket } from "./ws/handler.js";
import { warnStripeStatus } from "./services/stripe.js";
import { env } from "./config/env.js";
import { isDraining, startDraining } from "./drain.js";

const app = createApp();
const server = createServer(app);
// ── client-core ──────────────────────────────────────────────────
// The one-way sync feed, on `/api/sync`, beside the interactive room socket on
// `/ws` and `/api/ws`. Registered on the same HTTP server and set up the same
// way, at module scope, so both exist before `server.listen` accepts anything.
//
// IMPORTANT, and it fails in a way that points at neither feature: EVERY
// `upgrade` listener on an HTTP server runs for EVERY upgrade, and the first one
// to `socket.destroy()` wins. So each listener must IGNORE a path that is not
// its own — return, and leave the socket to the listener that owns it — rather
// than destroying it as "unknown". `setupSyncFeed` does that. A listener that
// destroys unknown paths kills the other feature's sockets depending only on
// which was registered first, and the symptom is a socket that connects and
// closes immediately with no code. Which is also why registering BEFORE the
// room socket costs nothing: neither listener may act on the other's path.
const syncWss = setupSyncFeed(server);
// ── end client-core ──────────────────────────────────────────────
const wss = setupWebSocket(server);

async function start(): Promise<void> {
  try {
    // 1. Connect to databases
    await connectToDB();
    await connectRedis();
    const redis = getRedis();
    if (redis) await roomManager.connectPubSub(redis);

    // 2. Initialize auth (needs DB connection)
    await initAuth();

    // 3. Surface "Stripe is not configured" warnings before serving
    //    traffic so the gap is visible in dev terminals AND prod logs.
    //    Non-fatal — non-Stripe features keep working.
    warnStripeStatus();

    // 4. Start listening
    server.listen(env.PORT, () => {
      console.log(`[server] Listening on http://127.0.0.1:${env.PORT}`);
      console.log(`[server] Environment: ${env.NODE_ENV}`);
    });
  } catch (err) {
    console.error("[server] Failed to start:", err);
    process.exit(1);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────

// Force exit when closing hangs. Counted from the start of shutdown, after
// any drain: 20 s of drain plus this stays under the 30 s `docker stop`
// allows before it kills the process.
const FORCE_EXIT_MS = 8_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    console.error("[server] Forced exit after timeout");
    process.exit(1);
  }, FORCE_EXIT_MS).unref();

  console.log(`\n[server] ${signal} received, shutting down gracefully...`);

  // ── client-core ────────────────────────────────────────────────
  // The sync feed's sockets, with 1001 (going away) and NOT
  // `SESSION_REVOKED_CLOSE_CODE`: a client latches on the revoked code and
  // stops reconnecting for good, so using it for a restart would leave every
  // device permanently disconnected from a server that came back seconds later.
  for (const client of syncWss.clients) {
    client.close(1001, "Server shutting down");
  }
  // ── end client-core ────────────────────────────────────────────

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, "Server shutting down");
  }

  // Stop accepting new connections
  server.close();

  // Disconnect from databases and auth
  await disconnectAuth();
  await roomManager.disconnectPubSub();
  await disconnectRedis();
  await disconnectFromDB();

  console.log("[server] Shutdown complete");
  process.exit(0);
}

// SIGTERM is `docker stop` — in production, a deploy replacing this
// container. Drain first: fail the health probe so Traefik stops routing
// here, keep serving what it still sends, and only then shut down (see
// ./drain.ts). SHUTDOWN_DRAIN_SECONDS comes from the Dockerfile; unset (dev,
// tests) or 0 skips the wait, and so does a second SIGTERM. SIGINT (Ctrl-C)
// never waits.
process.on("SIGTERM", () => {
  if (env.SHUTDOWN_DRAIN_SECONDS > 0 && !isDraining()) {
    startDraining();
    console.log(
      `[server] SIGTERM received, failing the health check for ${env.SHUTDOWN_DRAIN_SECONDS}s before shutting down`,
    );
    setTimeout(() => shutdown("SIGTERM"), env.SHUTDOWN_DRAIN_SECONDS * 1000);
    return;
  }
  shutdown("SIGTERM");
});
process.on("SIGINT", () => shutdown("SIGINT"));

start();
