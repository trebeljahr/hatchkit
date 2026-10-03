/**
 * The WebSocket upgrade for the sync feed (`SYNC_PATH`, `/api/sync`).
 *
 * Shaped like `ws/handler.ts` — the same `ws` package, the same manual
 * `server.on("upgrade")` with path and origin validation, the same ping/pong
 * heartbeat — and different from it in four ways that are the point of this
 * file. The room socket is an interactive room a client joins by name and
 * talks into; this is a one-way authenticated stream of "something of yours
 * changed". Each difference is commented where it is enforced:
 *
 *  1. Authentication is MANDATORY. No session, no socket.
 *  2. The room is `session.user.id`, and nothing on the wire can change it.
 *  3. Every client frame is discarded, unparsed and unanswered.
 *  4. A revoked session's sockets are closed with a code the client latches on.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { fromNodeHeaders } from "better-auth/node";
import { SESSION_REVOKED_CLOSE_CODE, SYNC_EVENT_KINDS, SYNC_PATH } from "@starter/shared";
import { getAuth } from "../auth/auth.js";
import { syncFeed } from "./feed.js";
import { isRedisReady } from "../db/redis.js";
import { env, getTrustedOrigins } from "../config/env.js";

/**
 * Heartbeat, on the same interval as the room socket so both feeds behave
 * alike on a flaky network.
 *
 * The server terminates on the FIRST missed pong, so a backgrounded client is
 * dead server-side within about two intervals. That matters more here than it
 * looks: a frozen socket — a phone whose radio went away, a laptop that slept
 * — delivers no close event at either end, so the client still believes it is
 * connected and shows a sync indicator that is lying. The server cleaning up
 * fast is half the fix; the other half is that clients expose an explicit
 * `reconnect()` to call when they come back to the foreground, rather than
 * waiting for a close that never arrives.
 */
const PING_INTERVAL_MS = 10_000;

/** Subprotocol prefix a host with no cookie jar carries its session token in. */
const BEARER_SUBPROTOCOL_PREFIX = "bearer.";

/** A socket that has been through the upgrade's authentication. */
type SyncSocket = WebSocket & { userId?: string };

/**
 * Live sync sockets, so a session revocation can reach them.
 *
 * Kept here rather than in `feed.ts` because the feed deals in subscribers and
 * knows nothing about sockets — which is what lets a Redis-backed feed drop in
 * behind the same interface.
 */
const liveSockets = new Set<SyncSocket>();

/** Every `bearer.<token>` value a browser offered on this upgrade. */
function bearerSubprotocolToken(req: IncomingMessage): string | null {
  const offered = req.headers["sec-websocket-protocol"];
  const protocols = (Array.isArray(offered) ? offered.join(",") : offered)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const carrier = protocols?.find((value) => value.startsWith(BEARER_SUBPROTOCOL_PREFIX));
  if (!carrier) return null;
  const token = carrier.slice(BEARER_SUBPROTOCOL_PREFIX.length);
  if (!token) return null;
  try {
    return decodeURIComponent(token);
  } catch {
    // A token that is not valid percent-encoding is not a token.
    return null;
  }
}

/**
 * Resolve the session cookie on an upgrade request into a session.
 *
 * The room socket in `ws/` has a function of exactly this shape, and this file
 * deliberately does NOT import it. `ws/` belongs to the `websocket` feature and
 * `sync/` belongs to `client-core`; the two are selected independently, so a
 * project with the sync feed and no room socket has no `ws/` directory at all —
 * and an import across that line is a TS2307 the moment somebody picks the one
 * without the other. Fifteen lines of better-auth is a cheaper thing to own
 * twice than a dependency between two features that are meant to be separable.
 */
async function sessionFromCookie(req: IncomingMessage): Promise<{ user: { id: string } } | null> {
  try {
    const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user?.id ? { user: { id: session.user.id } } : null;
  } catch {
    // A failed lookup is an unauthenticated upgrade, never a thrown request.
    return null;
  }
}

/**
 * Resolve a `bearer.<token>` subprotocol into a session.
 *
 * The browser `WebSocket` constructor cannot set a header but CAN set a
 * subprotocol, so this is the only way in for a host with no cookie jar — a
 * launcher extension, a native shell, a browser extension's service worker.
 * It is resolved through better-auth's own `getSession` with an
 * `Authorization` header, exactly as an HTTP request with the same token would
 * be: one credential, one verification path. A second way to check a token is
 * a second way to get it wrong.
 */
async function sessionFromBearerSubprotocol(
  req: IncomingMessage,
): Promise<{ user: { id: string } } | null> {
  const token = bearerSubprotocolToken(req);
  if (!token) return null;
  try {
    const headers = fromNodeHeaders(req.headers);
    headers.set("authorization", `Bearer ${token}`);
    const session = await getAuth().api.getSession({ headers });
    return session?.user?.id ? { user: { id: session.user.id } } : null;
  } catch {
    // A failed lookup is an unauthenticated upgrade, never a thrown request:
    // a bad token must not be able to take the server down.
    return null;
  }
}

/** Close every sync socket of one user, and answer how many that was. */
export function revokeSyncSockets(userId: string): number {
  let closed = 0;
  for (const socket of [...liveSockets]) {
    if (socket.userId !== userId) continue;
    // A dedicated code, not 1000 and not 1008: "you were signed out" is not
    // "the network died". A client latches on this one and stops reconnecting
    // for good, because the credential it holds will never be accepted again —
    // a backoff loop against it is pure noise, and a sync indicator that never
    // settles is worse than an honest "signed out".
    socket.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
    closed += 1;
  }
  return closed;
}

export function setupSyncFeed(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    /**
     * A browser closes the socket unless the server echoes back one of the
     * subprotocols it offered. Echo the `bearer.<token>` carrier and refuse
     * everything else — the token is read from the request, never from what is
     * echoed, so this is a compatibility answer and not a decision.
     */
    handleProtocols: (protocols) => {
      for (const protocol of protocols) {
        if (protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX)) return protocol;
      }
      return false;
    },
  });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Not ours: return, and DO NOT destroy the socket.
    //
    // Every `upgrade` listener on the HTTP server runs for every upgrade, and
    // the first one to `destroy()` wins. A listener that destroys unknown
    // paths therefore kills the other feed's sockets depending on which was
    // registered first — a bug that looks like "the socket connects and
    // immediately closes with no code" and points at neither feature. So this
    // listener claims exactly one path and ignores the rest.
    if (url.pathname !== SYNC_PATH) return;
    if (!isRedisReady()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n");
      return;
    }

    // Origin validation in production, same rule as the room socket. A
    // WebSocket is not subject to CORS and its constructor has no
    // `credentials` option, so a session cookie that is eligible cross-site
    // rides along on the upgrade whether the caller wants it or not — this
    // check is the only thing standing in for CORS here. Answered with a
    // status rather than dropped: a silent destroy reaches a browser as a bare
    // close with no code, indistinguishable from a network failure.
    if (env.isProduction) {
      const trusted = getTrustedOrigins();
      const origin = req.headers.origin;
      if (origin && trusted.length > 0 && !trusted.includes(origin)) {
        console.warn(`[sync] upgrade refused: untrusted origin ${origin}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    // Authentication is mandatory. This feed carries one account's data, so a socket
    // with no session has no room it may be placed in and nothing it may be
    // sent. It is refused at the upgrade rather than accepted and left idle:
    // an accepted-but-roomless socket is a connection that looks healthy to
    // the client and delivers nothing forever.
    //
    // The cookie path first (the web app), then the `bearer.<token>`
    // subprotocol for hosts with no cookie jar.
    const authenticated =
      (await sessionFromCookie(req)) ?? (await sessionFromBearerSubprotocol(req));

    if (socket.destroyed) return;
    if (!server.listening) {
      socket.destroy();
      return;
    }
    if (!isRedisReady()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n");
      return;
    }

    if (!authenticated) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // THE ROOM IS THE AUTHENTICATED USER ID. It is attached here, from the
      // session the upgrade just resolved, and it is the only value the
      // connection handler below reads. Nothing in the URL, the subprotocol or
      // any frame is consulted — structurally, not by convention: the query
      // string is never parsed past the pathname, and `ws.on("message")`
      // discards without decoding.
      (ws as SyncSocket).userId = authenticated.user.id;
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: SyncSocket) => {
    const userId = ws.userId;
    if (!userId) {
      // Unreachable through the upgrade above, which refuses a session with no
      // user. A socket that arrived some other way has no room it may be put
      // in, so it is closed rather than left connected and silent.
      ws.close(1008, "unauthenticated");
      return;
    }

    liveSockets.add(ws);

    // The person's own room, and only theirs. `subscribe` takes the id the
    // upgrade authenticated; the feed has no API that would accept another.
    const unsubscribe = syncFeed.subscribe({
      userId,
      send: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
      resync: () => ws.close(1012, "Sync transport reset"),
    });

    const invalidate = () => {
      if (ws.readyState !== ws.OPEN) return;
      for (const kind of SYNC_EVENT_KINDS) {
        ws.send(JSON.stringify({ type: "sync", event: { kind } }));
      }
    };
    // A reconnect is a new subscription, not replay. Ask every consumer to fetch
    // authoritative state even when its adapter ignores connection status.
    invalidate();

    let isAlive = true;
    let heartbeatCount = 0;
    ws.on("pong", () => {
      isAlive = true;
    });

    const pingInterval = setInterval(() => {
      if (!isAlive) {
        clearInterval(pingInterval);
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
      // Pub/sub can lose a frame even without this subscriber disconnecting.
      // Bound stale state to 30 seconds by invalidating authoritative queries.
      if (++heartbeatCount % 3 === 0 && ws.readyState === ws.OPEN) {
        invalidate();
      }
    }, PING_INTERVAL_MS);

    // EVERY client frame is discarded. The handler is registered only so the
    // frame is read off the socket and dropped — it is never parsed.
    //
    // The feed is one-way on purpose. A socket that accepts commands is a
    // second, unaudited write path beside tRPC, with its own JSON parsing, its
    // own authorisation and its own bugs, reached by a transport that no CORS
    // policy and no request log covers as well as HTTP. So there is nothing to
    // parse here, and no error is sent back either: a reply is an invitation,
    // and a client that gets an error frame learns that frames are read. A
    // frame from an older build must also not close this socket — that client
    // is still a perfectly good receiver of its own events, and closing would
    // only put it into a reconnect loop.
    ws.on("message", () => {});

    ws.on("close", () => {
      clearInterval(pingInterval);
      liveSockets.delete(ws);
      unsubscribe();
    });

    // An `error` with no `close` leaves a subscriber in the feed forever, and
    // `unsubscribe` is idempotent, so both paths run it.
    ws.on("error", () => {
      clearInterval(pingInterval);
      liveSockets.delete(ws);
      unsubscribe();
    });
  });

  return wss;
}
