// Synthetic HTTP/auth edges around the actual starter room and Redis modules.
// This fixture deliberately does not claim to test Better Auth or Coolify.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { connectRedis, disconnectRedis, getRedis, isRedisReady } from "./src/db/redis.js";
import { isDraining, startDraining } from "./src/drain.js";
import { closeHttpServer } from "./src/shutdown.js";
import { SyncFeed } from "./src/sync/feed.js";
import { RoomManager } from "./src/ws/rooms.js";

const rooms = new RoomManager({ presenceLeaseMs: 1500, heartbeatMs: 250 });
const syncFeed = new SyncFeed();
const revision = process.env.FIXTURE_REVISION!;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/health") {
    res.statusCode = isDraining() || !isRedisReady() ? 503 : 200;
    res.end(
      JSON.stringify({
        revision,
        redis: isRedisReady(),
        draining: isDraining(),
        publisher: getRedis()?.status,
        roomsReady: Reflect.get(rooms, "ready"),
        roomSubscriber: Reflect.get(rooms, "subscriber")?.status,
        syncReady: Reflect.get(syncFeed, "transportReady"),
        syncSubscriber: Reflect.get(syncFeed, "subscriber")?.status,
      }),
    );
  } else if (url.pathname === "/members") {
    try {
      res.end(JSON.stringify(await rooms.getMembers("rollout")));
    } catch {
      res.statusCode = 503;
      res.end("{}");
    }
  } else if (url.pathname === "/slow") {
    const delay = Math.min(Number(url.searchParams.get("ms")) || 1500, 5000);
    process.send?.({ event: "long-request-started" });
    setTimeout(() => res.end(JSON.stringify({ revision, completed: true })), delay);
  } else if (url.pathname === "/publish-sync") {
    const userId = String(req.headers["x-fixture-user"] ?? "fixture-user");
    const localSubscribers = syncFeed.count(userId);
    syncFeed.publish(
      userId,
      { kind: "items.changed" },
      {
        originId: url.searchParams.get("originId") ?? "fixture-origin",
      },
    );
    res.end(JSON.stringify({ localSubscribers }));
  } else {
    res.end(JSON.stringify({ revision }));
  }
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  const userId = String(req.headers["x-fixture-user"] ?? "fixture-user");
  if (url.pathname === "/api/sync") {
    if (!isRedisReady()) {
      socket.close(1013, "Redis unavailable");
      return;
    }
    const unsubscribe = syncFeed.subscribe({
      userId,
      send: (message) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(message));
      },
      resync: () => socket.close(1012, "Sync transport reset"),
    });
    socket.on("message", () => {});
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
    return;
  }
  let work = Promise.resolve();
  const enqueue = (task: () => Promise<unknown>) => {
    work = work
      .then(task)
      .then(() => {})
      .catch(() => socket.close(1013, "Redis unavailable"));
  };
  if (url.searchParams.get("roomId")) {
    enqueue(() => rooms.join(url.searchParams.get("roomId")!, userId, userId, socket));
  }
  socket.on("message", (payload) => {
    enqueue(async () => {
      const message = JSON.parse(payload.toString());
      if (message.type === "join-room") {
        await rooms.join(message.roomId, userId, userId, socket);
      } else {
        await rooms.handleMessage(socket, message);
      }
    });
  });
  socket.on("close", () => enqueue(() => rooms.leave(socket)));
});

await connectRedis();
await rooms.connectPubSub(getRedis()!);
await syncFeed.connectPubSub(getRedis()!);
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    process.send?.({ event: "ready", port: address.port });
});

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  startDraining();
  console.log("[fixture] drain started");
  setTimeout(async () => {
    // Match the starter's bounded shutdown phase without allowing a broken
    // helper to leave test workers running indefinitely.
    setTimeout(() => {
      console.error("[fixture] forced exit after shutdown deadline");
      process.exit(1);
    }, 8000).unref();
    console.log(`[fixture] closing ${wss.clients.size} WebSockets and HTTP listener`);
    for (const socket of wss.clients) socket.close(1001, "Server replacement");
    // Keep Redis alive until all accepted HTTP requests have completed.
    await closeHttpServer(server);
    console.log("[fixture] accepted HTTP requests finished; closing room pub/sub");
    await rooms.disconnectPubSub();
    console.log("[fixture] closing sync pub/sub");
    await syncFeed.disconnectPubSub();
    console.log("[fixture] closing Redis publisher");
    await disconnectRedis();
    console.log("[fixture] shutdown complete");
    process.exit(0);
  }, 800);
});
