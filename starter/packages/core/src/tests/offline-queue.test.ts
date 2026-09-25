import assert from "node:assert/strict";
import { test } from "node:test";
import { API_LEVEL } from "@starter/shared";
import {
  adoptUnstampedTenant,
  corruptQueueKey,
  createOfflineQueue,
  isForeignTenant,
  isForeignTo,
  isQueuedOn,
  isReplayableBy,
  isReplayableIn,
  OfflineQueueLockedError,
  type QueuedMutation,
} from "../offline-queue.js";
import {
  describeQueuedMutation,
  heldReasons,
  holdReasonOf,
  OFFLINE_QUEUE_STORAGE_KEY,
} from "../offline-ops.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";

const KEY = OFFLINE_QUEUE_STORAGE_KEY;

const CLOUD = "https://api.example.com";
const OWN = "https://starter.example.org";

const A = "tenant-a";
const B = "tenant-b";

const createPayload = (title: string, tempId?: string): unknown => ({
  input: {
    title,
    createdAt: "2026-09-14T09:00:00.000Z",
    timeZone: "UTC",
    originId: "o",
  },
  ...(tempId ? { tempId } : {}),
});

const updatePayload = (id: string, tempId?: string): unknown => ({
  input: { id, title: "edited", originId: "o" },
  ...(tempId ? { tempId } : {}),
});

/** A store that lets a test look at every key, not just the queue's. */
const recordingStorage = (): KeyValueStorage & {
  keys: () => string[];
  raw: Map<string, string>;
} => {
  const raw = new Map<string, string>();
  return {
    raw,
    keys: () => [...raw.keys()],
    getItem: async (key) => raw.get(key) ?? null,
    setItem: async (key, value) => {
      raw.set(key, value);
    },
    removeItem: async (key) => {
      raw.delete(key);
    },
  };
};

// ── the basics ───────────────────────────────────────────────────────

test("the queue is FIFO, and remove and clear leave nothing behind", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const first = await queue.enqueue("items.create", createPayload("one"));
  const second = await queue.enqueue("items.create", createPayload("two"));
  const third = await queue.enqueue("items.remove", updatePayload("i-1"));

  assert.equal(await queue.size(), 3);
  assert.deepEqual(
    (await queue.list()).map((row) => row.id),
    [first.id, second.id, third.id],
  );

  await queue.remove(second.id);
  assert.deepEqual(
    (await queue.list()).map((row) => row.id),
    [first.id, third.id],
  );

  await queue.clear();
  assert.deepEqual(await queue.list(), []);
  assert.equal(await queue.size(), 0);
});

test("concurrent enqueues all survive the read-modify-write window", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const titles = ["a", "b", "c", "d", "e"];
  await Promise.all(
    titles.map((title) => queue.enqueue("items.create", createPayload(title))),
  );
  const rows = await queue.list();
  assert.equal(rows.length, titles.length);
  // Order is the order the calls were serialized in, and every row is distinct.
  assert.equal(new Set(rows.map((row) => row.id)).size, titles.length);
});

test("enqueue stamps the API level of the build that wrote the row", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const row = await queue.enqueue("items.create", createPayload("x"));
  assert.equal(row.apiLevel, API_LEVEL);
  assert.equal((await queue.list())[0]?.apiLevel, API_LEVEL);
});

// ── the stored envelope ──────────────────────────────────────────────

test("the queue is written as a versioned envelope and reads the legacy array", async () => {
  const storage = memoryStorage();
  await storage.setItem(
    KEY,
    JSON.stringify([
      {
        id: "legacy",
        op: "items.create",
        payload: createPayload("from before the envelope"),
        createdAt: "2026-09-01T00:00:00Z",
      },
    ]),
  );
  const queue = createOfflineQueue({ storage });
  assert.deepEqual(
    (await queue.list()).map((row) => row.id),
    ["legacy"],
  );

  await queue.enqueue("items.remove", updatePayload("i-1"));
  const stored = JSON.parse((await storage.getItem(KEY)) ?? "null") as {
    v: number;
    data: unknown[];
  };
  assert.equal(stored.v, 1);
  assert.equal(stored.data.length, 2);
  assert.equal((await queue.list()).length, 2);
});

test("an unreadable queue is copied aside before it is reset", async () => {
  for (const garbage of [
    "{not json",
    JSON.stringify({ data: [] }),
    JSON.stringify("x"),
    JSON.stringify({ v: 1, data: 3 }),
  ]) {
    const storage = recordingStorage();
    storage.raw.set(KEY, garbage);
    const queue = createOfflineQueue({ storage });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.deepEqual(await queue.list(), []);
    } finally {
      console.warn = warn;
    }
    const copies = storage.keys().filter((key) => key.startsWith(`${KEY}.corrupt.`));
    assert.equal(copies.length, 1, garbage);
    assert.equal(storage.raw.get(copies[0]), garbage);
    assert.equal(corruptQueueKey(KEY, 5), `${KEY}.corrupt.5`);

    await queue.enqueue("items.create", createPayload("after the reset"));
    assert.equal(storage.raw.get(copies[0]), garbage, "the copy survives the next enqueue");
  }
});

test("a queue in a newer format is listed as held and never overwritten", async () => {
  const storage = recordingStorage();
  const stored = JSON.stringify({
    v: 2,
    data: [
      {
        id: "n",
        op: "items.create",
        payload: createPayload("written by a newer build", "t"),
        createdAt: "2026-09-14T09:00:00Z",
        level: 9,
      },
    ],
    extra: true,
  });
  storage.raw.set(KEY, stored);
  const queue = createOfflineQueue({ storage });

  const rows = await queue.list();
  assert.equal(rows.length, 1);
  assert.equal(holdReasonOf(rows[0]), "unknown-op");
  assert.equal(heldReasons(rows).get("n"), "unknown-op");

  let ran = false;
  const result = await queue.flush(async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(result.remaining, 1);

  await assert.rejects(
    queue.enqueue("items.remove", updatePayload("i-1")),
    OfflineQueueLockedError,
  );
  await assert.rejects(queue.remove("n"), OfflineQueueLockedError);
  // Housekeeping does nothing rather than throw, and destroys nothing.
  await queue.clear();
  assert.equal(await queue.adoptUnowned("u"), 0);
  assert.equal(await queue.adoptUnserved(OWN), 0);
  assert.equal(await queue.adoptUnstampedTenant(A), 0);
  assert.equal(storage.raw.get(KEY), stored);
  assert.equal((await queue.list()).length, 1);
});

test("a malformed stamp reads as no stamp at all", async () => {
  const storage = memoryStorage();
  await storage.setItem(
    KEY,
    JSON.stringify([
      {
        id: "a",
        op: "items.remove",
        payload: {},
        createdAt: "2026-09-13T00:00:00Z",
        owner: 42,
        server: 42,
        tenantId: 7,
        apiLevel: "two",
      },
      {
        id: "b",
        op: "items.remove",
        payload: {},
        createdAt: "2026-09-13T00:00:00Z",
        owner: "",
        server: "",
        tenantId: "",
      },
    ]),
  );
  const rows = await createOfflineQueue({ storage }).list();
  assert.deepEqual(
    rows.map((row) => [row.owner, row.server, row.apiLevel]),
    [
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ],
  );
  assert.deepEqual(
    rows.map((row) => "tenantId" in row),
    [false, false],
  );
});

// ── owner, server and tenant stamps ──────────────────────────────────

test("enqueue stamps owner, server and tenant, and a legacy row stays unstamped", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const stamped = await queue.enqueue("items.create", createPayload("x"), "u1", OWN, A);
  const legacy = await queue.enqueue("items.create", createPayload("y"), "u1");

  assert.deepEqual(
    [stamped.owner, stamped.server, stamped.tenantId],
    ["u1", OWN, A],
  );
  assert.equal("tenantId" in legacy, false);
  const rows = await queue.list();
  assert.deepEqual(
    rows.map((row) => row.tenantId),
    [A, undefined],
  );
});

test("adoptUnowned claims only unowned rows, and can be limited to one server", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("items.create", createPayload("cloud"), undefined, CLOUD);
  await queue.enqueue("items.create", createPayload("own"), undefined, OWN);
  await queue.enqueue("items.create", createPayload("mine"), "u1", OWN);

  const adopted = await queue.adoptUnowned("u-own", (row) => isQueuedOn(row, OWN, CLOUD));
  assert.equal(adopted, 1);
  assert.deepEqual(
    (await queue.list()).map((row) => [row.server, row.owner]),
    [
      [CLOUD, undefined],
      [OWN, "u-own"],
      [OWN, "u1"],
    ],
  );
});

test("adoptUnserved claims unstamped rows for one server, once", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("items.create", createPayload("a"), "u1");
  await queue.enqueue("items.create", createPayload("b"), "u1", CLOUD);

  assert.equal(await queue.adoptUnserved(OWN), 1);
  assert.equal(await queue.adoptUnserved(CLOUD), 0);
  assert.deepEqual(
    (await queue.list()).map((row) => row.server),
    [OWN, CLOUD],
  );
});

test("adoptUnstampedTenant claims only unstamped rows, and only once", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("items.create", createPayload("a"), "u1");
  await queue.enqueue("items.create", createPayload("b"), "u1", undefined, B);

  assert.equal(await queue.adoptUnstampedTenant(A), 1);
  // A later switch must not carry already-adopted rows along.
  assert.equal(await queue.adoptUnstampedTenant(B), 0);
  assert.deepEqual(
    (await queue.list()).map((row) => row.tenantId),
    [A, B],
  );
});

test("the pure adoption respects its filter and never moves a stamped row", () => {
  const rows: QueuedMutation[] = [
    { id: "1", op: "items.create", payload: {}, createdAt: "t", server: OWN },
    { id: "2", op: "items.create", payload: {}, createdAt: "t", server: CLOUD },
    { id: "3", op: "items.create", payload: {}, createdAt: "t", tenantId: B },
  ];
  const next = adoptUnstampedTenant(rows, A, (row) => row.server === OWN);
  assert.deepEqual(
    next.map((row) => row.tenantId),
    [A, undefined, B],
  );
  // Untouched rows keep their identity.
  assert.equal(next[1], rows[1]);
});

// ── who may replay what ──────────────────────────────────────────────

test("isReplayableBy and isForeignTo differ only on an unowned row", () => {
  assert.equal(isReplayableBy({ owner: "u1" }, "u1"), true);
  assert.equal(isReplayableBy({ owner: "u2" }, "u1"), false);
  assert.equal(isReplayableBy({}, "u1"), true);
  // Nobody replays anything while signed out.
  assert.equal(isReplayableBy({}, null), false);

  assert.equal(isForeignTo({ owner: "u1" }, "u1"), false);
  assert.equal(isForeignTo({ owner: "u2" }, "u1"), true);
  // An unowned row is not somebody else's, even to a caller with no account.
  assert.equal(isForeignTo({}, null), false);
});

test("a row replays only against the server it was queued on", () => {
  assert.equal(isQueuedOn({ server: OWN }, OWN, CLOUD), true);
  assert.equal(isQueuedOn({ server: OWN }, CLOUD, CLOUD), false);
  assert.equal(isQueuedOn({ server: CLOUD }, OWN, CLOUD), false);
  // The comparison ignores case and a trailing slash.
  assert.equal(isQueuedOn({ server: "https://Starter.Example.org/" }, OWN, CLOUD), true);
  // Made before the stamp existed, when the default was the only server.
  assert.equal(isQueuedOn({}, CLOUD, CLOUD), true);
  assert.equal(isQueuedOn({}, OWN, CLOUD), false);
});

test("isReplayableIn and isForeignTenant", () => {
  const members = new Set([A]);
  assert.equal(isReplayableIn({ tenantId: A }, members), true);
  assert.equal(isReplayableIn({ tenantId: B }, members), false);
  assert.equal(isReplayableIn({}, members), true);

  assert.equal(isForeignTenant({ tenantId: A }, members), false);
  assert.equal(isForeignTenant({ tenantId: B }, members), true);
  // Unstamped names no tenant to be foreign to.
  assert.equal(isForeignTenant({}, members), false);
  // No memberships known at all: every stamped row is held.
  assert.equal(isReplayableIn({ tenantId: A }, new Set()), false);
});

test("a flush filtered by membership holds a left tenant's rows in place", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("items.create", createPayload("gone"), "u1", OWN, B);
  await queue.enqueue("items.create", createPayload("here"), "u1", OWN, A);

  const members = new Set([A]);
  const ran: string[] = [];
  const result = await queue.flush(
    async (row) => {
      ran.push(row.tenantId ?? "");
    },
    { filter: (row) => isReplayableIn(row, members) },
  );
  assert.deepEqual(ran, [A]);
  assert.equal(result.flushed, 1);
  assert.equal(result.skipped, 1);
  const kept = await queue.list();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.tenantId, B);
});

// ── flushing ─────────────────────────────────────────────────────────

test("a flush that throws stops there and keeps the rest in order", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const a = await queue.enqueue("items.create", createPayload("a"));
  const b = await queue.enqueue("items.create", createPayload("b"));
  const c = await queue.enqueue("items.create", createPayload("c"));

  const boom = new Error("offline");
  const ran: string[] = [];
  const result = await queue.flush(async (row) => {
    ran.push(row.id);
    if (row.id === b.id) throw boom;
  });

  assert.deepEqual(ran, [a.id, b.id]);
  assert.equal(result.flushed, 1);
  assert.equal(result.failed?.id, b.id);
  assert.equal(result.error, boom);
  assert.equal(result.remaining, 2);
  assert.deepEqual(
    (await queue.list()).map((row) => row.id),
    [b.id, c.id],
  );
});

test("a filtered row is neither run nor dropped, and keeps its place", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const a = await queue.enqueue("items.create", createPayload("theirs"), "u2");
  const b = await queue.enqueue("items.create", createPayload("mine"), "u1");

  const ran: string[] = [];
  const result = await queue.flush(
    async (row) => {
      ran.push(row.id);
    },
    { filter: (row) => isReplayableBy(row, "u1") },
  );

  assert.deepEqual(ran, [b.id]);
  assert.equal(result.flushed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.held, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(
    (await queue.list()).map((row) => row.id),
    [a.id],
  );
});

// ── describing a row ─────────────────────────────────────────────────

test("a described row names the work, the server and the tenant", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const inA = await queue.enqueue("items.create", createPayload("Invoicing"), "u1", OWN, A);
  const left = await queue.enqueue("items.create", createPayload("Old"), "u1", OWN, B);
  const legacy = await queue.enqueue("items.create", createPayload("Legacy"), "u1", OWN);
  const names = new Map([[A, "Acme"]]);
  const lookup = (id: string): string | null => names.get(id) ?? null;

  const a = describeQueuedMutation(inA, lookup);
  assert.equal(a.op, "items.create");
  assert.equal(a.description, "Invoicing");
  assert.equal(a.at, "2026-09-14T09:00:00.000Z");
  assert.equal(a.server, OWN);
  assert.equal(a.tenantId, A);
  assert.equal(a.tenantName, "Acme");
  assert.equal(a.hold, null);

  // A tenant the person has left is never given a guessed name.
  const b = describeQueuedMutation(left, lookup);
  assert.equal(b.tenantId, B);
  assert.equal(b.tenantName, null);

  const l = describeQueuedMutation(legacy);
  assert.equal(l.tenantId, null);
  assert.equal(l.tenantName, null);
});

test("a row with no payload createdAt falls back to when it was queued", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const row = await queue.enqueue("items.update", updatePayload("i-1"));
  const summary = describeQueuedMutation(row);
  assert.equal(summary.op, "items.update");
  assert.equal(summary.description, "edited");
  // Only a create carries its own `createdAt`; an update is dated by the row.
  assert.equal(summary.at, row.createdAt);
});
