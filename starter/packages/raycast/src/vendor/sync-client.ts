// GENERATED — DO NOT EDIT.
//
// A byte-for-byte copy of a file in the shared client core, with its import
// specifiers rewritten for this flat directory. Written by
// `scripts/vendor-core.mjs`; `npm test` fails when it is stale.
//
// Edit the source package and re-run the generator. An edit made here is
// silently overwritten on the next run, and until then this surface behaves
// differently from every other client.

/**
 * The client end of the sync feed: a WebSocket that listens and nothing else.
 *
 * Three properties are the whole design, and each one is a security or
 * reliability bug if it drifts:
 *
 * **The room comes from the authenticated session and nothing else.** This client
 * passes no room, no tenant and no id — only its credential. A room a client can
 * name is a room a client can name *somebody else's*, and this feed carries every
 * change to that account's data, so the server deriving the room from the session
 * it authenticated is the only version of this that is safe. The only query
 * parameters are `apiLevel` and `clientVersion` ({@link withVersionQuery}), which
 * are neither a room nor a secret.
 *
 * **The socket is one-way and this client never sends a frame.** There is no
 * `send` on {@link SyncClient}, deliberately. A socket that accepts commands is a
 * second, unaudited write path beside the API, with its own parsing, its own
 * authorisation and therefore its own authorisation bugs. Everything a client
 * wants to *do* goes through the API; this only says what changed.
 *
 * **A bad frame is ignored, never fatal.** A malformed frame, a frame of a kind
 * this build has never heard of and a consumer that throws all leave the socket
 * open. A client that dropped its connection on a frame it did not recognise
 * would stop syncing the moment the protocol grew.
 */

import { API_LEVEL, parseClientVersion } from "./api-level";
import { SESSION_REVOKED_CLOSE_CODE, isSyncMessage } from "./sync-protocol";
import type { SyncEvent } from "./sync-protocol";

export type SyncStatus = "connecting" | "open" | "closed";

export type SyncClientOptions = {
  /** Full ws:// or wss:// URL, e.g. `wss://example.com/api/sync`. */
  url: string;
  /**
   * `tenantId` is the envelope's: the tenant the change happened in, or
   * undefined for a change about the account rather than any one tenant. One
   * socket carries every tenant the person belongs to, so a consumer showing one
   * tenant needs it to leave the others' events alone.
   *
   * An event kind this build does not know still arrives here, and the answer to
   * one is "refetch", never "ignore": a newer server tells this client that
   * something changed in words it cannot read, and refetching what is on screen
   * is always correct while ignoring it shows stale data with no way out.
   */
  onEvent: (event: SyncEvent, originId?: string, tenantId?: string) => void;
  onStatus?: (status: SyncStatus) => void;
  /**
   * Session token, for a client with no cookie (a launcher extension, a browser
   * extension's service worker, the native shells).
   *
   * A getter is read again on every `open()`, which is what a reconnect needs: a
   * client that captured the token once keeps offering a dead one after a
   * sign-out and sign-in within the same launch, and never picks up a token that
   * arrived from secure storage after the socket was created.
   */
  token?: string | (() => string | undefined);
  /**
   * The server closed this socket with `SESSION_REVOKED_CLOSE_CODE` — the session
   * behind it no longer exists (signed out from another device, expired, or
   * deleted). Called at most once per client.
   *
   * Reconnection stops before this fires, and stays stopped: the credential this
   * client was built with will never be accepted again, so a backoff is pure
   * noise and a sync indicator that never settles is a lie. That halt applies
   * whether or not a host passes this callback, which is why the hosts that do
   * not pass one still inherit the fix. What they cannot inherit is the clearing:
   * the token lives in the keychain, in `chrome.storage` or in a launcher's own
   * store depending on who is asking, so forgetting it is the host's job and this
   * is the notification that it needs doing.
   *
   * Recovery is by construction: every host builds a NEW client when its session
   * changes — a hook keyed on the token, an extension runtime that reloads, a
   * launcher command that is a fresh process — so nothing has to un-latch this
   * one.
   */
  onSessionRevoked?: () => void;
  /**
   * This build's release. Sent, with the API level, as the `clientVersion` and
   * `apiLevel` query parameters: a browser `WebSocket` cannot set headers, and
   * the subprotocol is the bearer token's. Neither is a secret.
   */
  clientVersion?: string;
  /** Injectable for Node tests and non-DOM hosts. */
  WebSocketImpl?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

export type SyncClient = {
  connect(): void;
  close(): void;
  /**
   * Drop the current socket and open a new one immediately, without waiting for a
   * close event or a backoff. The native shells call this on resume: the server
   * pings and terminates on the first missed pong, so the connection a
   * backgrounded phone comes back to is usually already gone server-side while
   * the client still believes it is open.
   */
  reconnect(): void;
  status(): SyncStatus;
};

/** Subprotocol prefix the server reads the session token from. */
const BEARER_SUBPROTOCOL_PREFIX = "bearer.";

/**
 * The `WebSocket` constructor cannot set an Authorization header, so the token
 * rides in the subprotocol rather than the query string — a URL is the one place
 * it could end up in an access log, a proxy's request log or a referrer, and a
 * token in a log is a token that outlives the session it belongs to.
 */
const subprotocols = (
  token?: string | (() => string | undefined),
): string[] | undefined => {
  const value = typeof token === "function" ? token() : token;
  return value
    ? [`${BEARER_SUBPROTOCOL_PREFIX}${encodeURIComponent(value)}`]
    : undefined;
};

/**
 * `url` with the handshake's query parameters. The server routes on the path
 * alone, so an older server ignores them. A URL that does not parse is returned
 * unchanged, and the constructor reports it as before.
 *
 * Note what is NOT here: no room, no tenant, no user id. The server derives the
 * room from the session it authenticated — see the module header.
 */
export const withVersionQuery = (
  url: string,
  clientVersion: string | undefined,
): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.searchParams.set("apiLevel", String(API_LEVEL));
  const version = parseClientVersion(clientVersion);
  if (version !== null) parsed.searchParams.set("clientVersion", version);
  return parsed.toString();
};

/**
 * WebSocket subscription to the signed-in account's sync feed.
 *
 * Reconnects with jittered exponential backoff and never throws on a malformed
 * frame — a bad message must not take down the socket that keeps every device's
 * view of the data in agreement.
 */
export const createSyncClient = ({
  url,
  onEvent,
  onStatus,
  token,
  onSessionRevoked,
  clientVersion,
  WebSocketImpl,
  minBackoffMs = 1000,
  maxBackoffMs = 30_000,
}: SyncClientOptions): SyncClient => {
  const SocketCtor =
    WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  const socketUrl = withVersionQuery(url, clientVersion);

  let socket: WebSocket | null = null;
  let status: SyncStatus = "closed";
  let attempt = 0;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;
  let closedByCaller = false;
  /**
   * Latched by a revoked-session close. Nothing clears it — see
   * `onSessionRevoked`. `connect()` and `reconnect()` become no-ops rather than
   * throwing, so a host's periodic "is the socket up?" nudge stays harmless.
   */
  let revoked = false;

  const setStatus = (next: SyncStatus): void => {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  };

  const backoffMs = (): number => {
    const exponential = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt);
    // Jitter so many devices waking at once don't reconnect in lockstep and
    // hand the server a thundering herd on every deploy.
    return Math.round(exponential * (0.5 + Math.random() * 0.5));
  };

  const scheduleReconnect = (): void => {
    if (closedByCaller || revoked || retryHandle) return;
    const delay = backoffMs();
    attempt += 1;
    retryHandle = setTimeout(() => {
      retryHandle = null;
      open();
    }, delay);
  };

  const handleMessage = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable: not a frame this build can act on, and not a reason to
      // close a working connection.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as { type?: unknown };
    if (!isSyncMessage(message)) return;
    try {
      onEvent(message.event, message.originId, message.tenantId);
    } catch {
      // A throwing consumer must not kill the socket: the next frame is still
      // worth delivering, and the socket is shared by every consumer.
    }
  };

  const open = (): void => {
    if (revoked) return;
    if (!SocketCtor) {
      setStatus("closed");
      return;
    }
    if (socket) return;

    setStatus("connecting");
    let created: WebSocket;
    try {
      // Read on every open, not once at construction: this is the reconnect's
      // chance to pick up a token that changed since the last attempt.
      const protocols = subprotocols(token);
      created = protocols
        ? new SocketCtor(socketUrl, protocols)
        : new SocketCtor(socketUrl);
      socket = created;
    } catch {
      socket = null;
      scheduleReconnect();
      return;
    }

    /*
     * Every handler checks that it still speaks for the live socket.
     *
     * `close()` followed immediately by `connect()` — what a native shell does on
     * resume, because a socket the OS froze is dead server-side within seconds
     * and may never deliver an `onclose` — leaves the OLD socket's close event
     * still in flight. Without this guard that event fires after the new socket
     * exists, nulls the reference to it, reports "closed" and schedules a
     * reconnect, which then opens a THIRD socket. Two live connections, and a
     * status that no longer describes either of them.
     */
    const isCurrent = (): boolean => socket === created;

    created.onopen = () => {
      if (!isCurrent()) return;
      attempt = 0;
      setStatus("open");
    };
    created.onmessage = (event: MessageEvent) => {
      if (!isCurrent()) return;
      handleMessage(event.data);
    };
    created.onerror = () => {
      /* the close handler drives reconnection */
    };
    created.onclose = (event?: { code?: number }) => {
      if (!isCurrent()) return;
      socket = null;

      /*
       * "You were signed out" is not "the network died".
       *
       * Everything else here — a dropped Wi-Fi, a server restart, a phone that
       * went into a tunnel — is worth retrying, and the backoff above exists for
       * exactly those. A revoked session is the one close this client can never
       * recover from on its own, so retrying it is a reconnect loop that no
       * amount of waiting resolves, hidden behind a sync dot that never settles.
       *
       * `event` is read defensively: a close event always carries a code in a
       * browser and in a Node WebSocket, but this handler is also driven by test
       * doubles and by hosts with their own socket shims, and an absent code must
       * mean "ordinary close" rather than "signed out".
       */
      if (event?.code === SESSION_REVOKED_CLOSE_CODE) {
        revoked = true;
        if (retryHandle) {
          clearTimeout(retryHandle);
          retryHandle = null;
        }
        setStatus("closed");
        try {
          onSessionRevoked?.();
        } catch {
          // A throwing host must not leave the latch half-applied.
        }
        return;
      }

      setStatus("closed");
      scheduleReconnect();
    };
  };

  return {
    connect: () => {
      if (revoked) return;
      closedByCaller = false;
      open();
    },
    reconnect: () => {
      if (revoked) return;
      closedByCaller = true;
      if (retryHandle) {
        clearTimeout(retryHandle);
        retryHandle = null;
      }
      const current = socket;
      socket = null;
      current?.close();
      // Straight back up: `attempt` is reset so the new connection is not
      // charged for the backoff the old one had accumulated.
      attempt = 0;
      closedByCaller = false;
      open();
    },
    close: () => {
      closedByCaller = true;
      if (retryHandle) {
        clearTimeout(retryHandle);
        retryHandle = null;
      }
      const current = socket;
      socket = null;
      current?.close();
      setStatus("closed");
    },
    status: () => status,
  };
};
