/**
 * The socket contract, driven through an injected socket rather than a network.
 *
 * What is asserted here is the part that is easy to break in a way no type-check
 * catches and only a live client notices: where the credential goes, what the URL
 * is allowed to carry, that a bad frame is survivable, and that the reconnect
 * logic never ends up with two live sockets or with one it can never bring back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_LEVEL,
  SESSION_REVOKED_CLOSE_CODE,
  type SyncEvent,
} from "@starter/shared";
import { createSyncClient, type SyncClient } from "../sync-client.js";

const BEARER = "bearer.";

/**
 * A socket the test drives by hand.
 *
 * Nothing happens on its own: `open()`, `emit()` and `fireClose()` are the
 * test's, which is what lets the reconnect assertions be exact instead of timed.
 * `close()` deliberately does NOT fire `onclose` — a real close event arrives
 * later, from the event loop, and that lateness is the bug the `isCurrent` guard
 * exists for.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  closedByClient = false;

  readonly url: string;
  readonly protocols: string[];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols =
      protocols === undefined
        ? []
        : Array.isArray(protocols)
          ? [...protocols]
          : [protocols];
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  close(): void {
    this.closedByClient = true;
  }

  fireClose(code?: number): void {
    this.onclose?.(code === undefined ? {} : { code });
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    assert.ok(socket, "no socket was created");
    return socket;
  }
}

const SocketCtor = FakeSocket as unknown as typeof WebSocket;

const frame = (
  event: SyncEvent,
  extra: { originId?: string; tenantId?: string } = {},
): string => JSON.stringify({ type: "sync", event, ...extra });

/** Resolves once `predicate` holds, or rejects at the deadline. */
const until = (predicate: () => boolean, label: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const id = setInterval(() => {
      if (predicate()) {
        clearInterval(id);
        resolve();
        return;
      }
      if (Date.now() - started > 2000) {
        clearInterval(id);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 2);
  });

const idle = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type Harness = {
  client: SyncClient;
  events: Array<{ event: SyncEvent; originId?: string; tenantId?: string }>;
  revocations: () => number;
};

const harness = (
  overrides: Partial<Parameters<typeof createSyncClient>[0]> = {},
): Harness => {
  FakeSocket.reset();
  const events: Harness["events"] = [];
  let revocations = 0;
  const client = createSyncClient({
    url: "wss://app.example.com/api/sync",
    token: "tok en/+",
    onEvent: (event, originId, tenantId) => {
      events.push({ event, originId, tenantId });
    },
    onSessionRevoked: () => {
      revocations += 1;
    },
    WebSocketImpl: SocketCtor,
    // Tight, so a retry a test asserts the absence of has had several chances to
    // happen before the assertion runs.
    minBackoffMs: 5,
    maxBackoffMs: 5,
    ...overrides,
  });
  return { client, events, revocations: () => revocations };
};

test("the URL carries only the handshake, and the token rides in the subprotocol", () => {
  const { client } = harness({ clientVersion: "0.3.1" });
  client.connect();

  const socket = FakeSocket.last();
  const url = new URL(socket.url);
  assert.equal(url.searchParams.get("apiLevel"), String(API_LEVEL));
  assert.equal(url.searchParams.get("clientVersion"), "0.3.1");
  // No room, no tenant, no user: the server derives the room from the session it
  // authenticated. A room a client can name is one it can name somebody else's.
  assert.deepEqual([...url.searchParams.keys()].sort(), ["apiLevel", "clientVersion"]);
  // And the credential is never in the URL, where a log or a referrer could keep
  // it. Percent-encoded, because a raw token can hold characters a subprotocol
  // may not.
  assert.equal(url.search.includes("tok"), false);
  assert.deepEqual(socket.protocols, [`${BEARER}${encodeURIComponent("tok en/+")}`]);
  assert.equal(
    decodeURIComponent(socket.protocols[0]?.slice(BEARER.length) ?? ""),
    "tok en/+",
  );

  client.close();
});

test("the client is listen-only: there is no way to send a frame", () => {
  const { client } = harness();
  assert.equal(Object.hasOwn(client, "send"), false);
  assert.equal("send" in client, false);
  assert.deepEqual(Object.keys(client).sort(), [
    "close",
    "connect",
    "reconnect",
    "status",
  ]);
});

test("a sync frame reaches the consumer with its originId and tenantId", () => {
  const { client, events } = harness();
  client.connect();
  const socket = FakeSocket.last();
  socket.open();
  assert.equal(client.status(), "open");

  socket.emit(frame({ kind: "items.changed", id: "i1" }, { originId: "web-1", tenantId: "t1" }));
  assert.deepEqual(events, [
    { event: { kind: "items.changed", id: "i1" }, originId: "web-1", tenantId: "t1" },
  ]);

  // A frame about the account rather than any one tenant carries neither.
  socket.emit(frame({ kind: "profile.changed" }));
  assert.deepEqual(events[1], {
    event: { kind: "profile.changed" },
    originId: undefined,
    tenantId: undefined,
  });

  client.close();
});

test("a malformed frame and a throwing consumer both leave the socket open", () => {
  FakeSocket.reset();
  const seen: SyncEvent[] = [];
  const client = createSyncClient({
    url: "wss://app.example.com/api/sync",
    token: "t",
    onEvent: (event) => {
      seen.push(event);
      throw new Error("a consumer blew up");
    },
    WebSocketImpl: SocketCtor,
    minBackoffMs: 5,
    maxBackoffMs: 5,
  });
  client.connect();
  const socket = FakeSocket.last();
  socket.open();

  // Unparseable, valid JSON that is not a sync frame, a sync frame with no event,
  // a non-string payload — then the real thing. A client that closed on a frame
  // it did not recognise would stop syncing the moment the protocol grew.
  socket.emit("{not json");
  socket.emit(JSON.stringify({ type: "chat", text: "hi" }));
  socket.emit(JSON.stringify({ type: "sync" }));
  socket.emit(new Uint8Array([1, 2, 3]));
  socket.emit(frame({ kind: "items.changed" }));

  assert.deepEqual(seen, [{ kind: "items.changed" }]);
  assert.equal(client.status(), "open");
  assert.equal(socket.closedByClient, false);
  assert.equal(FakeSocket.instances.length, 1, "nothing reconnected");

  // An unknown kind still reaches the consumer: the answer to one is "refetch",
  // never "ignore".
  socket.emit(JSON.stringify({ type: "sync", event: { kind: "items.archived" } }));
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.kind, "items.archived");

  client.close();
});

test("an ordinary close schedules a reconnect and re-reads the token getter", async () => {
  const tokens = ["first", "second"];
  let index = 0;
  const { client, revocations } = harness({
    token: () => tokens[index++],
  });
  client.connect();
  const first = FakeSocket.last();
  first.open();
  assert.deepEqual(first.protocols, [`${BEARER}first`]);

  // 1001 "going away" — a server restart, a proxy recycling a connection.
  first.fireClose(1001);
  assert.equal(client.status(), "closed");

  await until(() => FakeSocket.instances.length === 2, "the automatic reconnect");
  const second = FakeSocket.last();
  // The getter is read again on every open. A client that captured the token once
  // keeps offering a dead one after a sign-out and sign-in in the same launch.
  assert.deepEqual(second.protocols, [`${BEARER}second`]);
  second.open();
  assert.equal(client.status(), "open");
  assert.equal(revocations(), 0, "an ordinary close is not a revocation");

  client.close();
});

test("a revoked-session close latches: told once, never reconnected", async () => {
  const { client, revocations } = harness();
  client.connect();
  const socket = FakeSocket.last();
  socket.open();

  socket.fireClose(SESSION_REVOKED_CLOSE_CODE);
  assert.equal(revocations(), 1);
  assert.equal(client.status(), "closed");

  // A host's periodic "is the socket up?" nudge must not resurrect a session the
  // server has thrown away.
  await idle(40);
  client.connect();
  client.reconnect();
  await idle(40);

  assert.equal(FakeSocket.instances.length, 1, "no socket was reopened");
  assert.equal(revocations(), 1, "the host was told exactly once");
  assert.equal(client.status(), "closed");
});

test("close() then connect() never leaves two live sockets", async () => {
  const { client, events } = harness();
  client.connect();
  const first = FakeSocket.last();
  first.open();

  // What a native shell does on resume: the frozen socket is dead server-side and
  // may never deliver a close event of its own in time.
  client.close();
  client.connect();
  const second = FakeSocket.last();
  second.open();
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(client.status(), "open");

  // The OLD socket's close event, still in flight. Without the `isCurrent` guard
  // it nulls the reference to the new socket, reports "closed" and schedules a
  // reconnect — which opens a THIRD.
  first.fireClose(1006);
  await idle(40);

  assert.equal(FakeSocket.instances.length, 2, "the late close opened a third socket");
  assert.equal(client.status(), "open", "the late close reported the wrong status");

  // And the new socket is still the live one: its frames still arrive.
  second.emit(frame({ kind: "items.changed" }));
  assert.deepEqual(events.map((it) => it.event.kind), ["items.changed"]);

  client.close();
});

test("a constructor that throws is retried, not propagated", async () => {
  FakeSocket.reset();
  let attempts = 0;
  const Throwing = function ThrowingSocket(this: unknown, url: string) {
    attempts += 1;
    if (attempts === 1) throw new Error("no network interface");
    return new FakeSocket(url);
  } as unknown as typeof WebSocket;

  const client = createSyncClient({
    url: "wss://app.example.com/api/sync",
    onEvent: () => undefined,
    WebSocketImpl: Throwing,
    minBackoffMs: 5,
    maxBackoffMs: 5,
  });
  client.connect();
  assert.equal(client.status(), "connecting");

  await until(() => attempts === 2, "the retry after a throwing constructor");
  client.close();
});
