import assert from "node:assert/strict";
import { test } from "node:test";
import { createOfflineQueue, type QueuedMutation } from "../offline-queue.js";
import {
  describeQueuedMutation,
  HELD_RETRY_MS,
  heldReasons,
  holdBlocksReplay,
  holdReasonOf,
  HOLD_RELEASE,
  OFFLINE_QUEUE_STORAGE_KEY,
  tempIdOf,
} from "../offline-ops.js";
import { memoryStorage } from "../storage.js";

const KEY = OFFLINE_QUEUE_STORAGE_KEY;

const createPayload = (tempId?: string): unknown => ({
  input: {
    title: "Invoicing",
    createdAt: "2026-09-14T09:00:00.000Z",
    timeZone: "UTC",
    originId: "o",
  },
  ...(tempId ? { tempId } : {}),
});

const updatePayload = (tempId?: string): unknown => ({
  input: { id: "temp-1", title: "edited", originId: "o" },
  ...(tempId ? { tempId } : {}),
});

const row = (overrides: Partial<QueuedMutation> = {}): QueuedMutation => ({
  id: "r",
  op: "items.create",
  payload: createPayload(),
  createdAt: "2026-09-14T09:00:00.000Z",
  ...overrides,
});

// ── hold helpers ─────────────────────────────────────────────────────

test("every hold reason says what can end it", () => {
  // The `Record` is the point: a new reason without a release is a type error,
  // and a reason nothing releases is a row nobody can ever send.
  assert.deepEqual(HOLD_RELEASE, {
    "unknown-op": "new-build",
    "unknown-procedure": "server",
    "server-too-old": "server",
  });
});

test("a row this build cannot decode is held unknown-op, and a newer build releases it", () => {
  // An op a newer build added, and a payload in a shape this build cannot read.
  const futureOp = row({ op: "items.archive" });
  const futurePayload = row({ payload: { input: 7 } });
  assert.equal(holdReasonOf(futureOp), "unknown-op");
  assert.equal(holdReasonOf(futurePayload), "unknown-op");
  // Nothing about the row changed but the op this build knows: the reason is
  // recomputed on every read, which is exactly what the upgrade releases.
  assert.equal(holdReasonOf({ ...futureOp, op: "items.create" }), null);
  assert.equal(holdReasonOf(row()), null);
  // Nothing this build can do ends it, so even an explicit retry keeps it.
  assert.equal(holdBlocksReplay(futureOp, { retryHeld: true }), true);

  const summary = describeQueuedMutation(futureOp);
  assert.equal(summary.op, null);
  assert.equal(summary.description, null);
  assert.equal(summary.at, futureOp.createdAt);
  assert.equal(summary.hold, "unknown-op");
});

test("an unknown-procedure hold is retried hourly, or when asked", () => {
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  const recent = row({
    hold: { reason: "unknown-procedure", at: new Date(now - 60_000).toISOString() },
  });
  const old = row({
    hold: { reason: "unknown-procedure", at: new Date(now - HELD_RETRY_MS).toISOString() },
  });
  assert.equal(holdBlocksReplay(recent, { now }), true);
  // A launch or a resume is when a server upgrade most likely happened unseen.
  assert.equal(holdBlocksReplay(recent, { now, retryHeld: true }), false);
  assert.equal(holdBlocksReplay(old, { now }), false);
  assert.equal(holdBlocksReplay(row(), { now }), false);
  // An unparseable `at` is no clock to measure from, so it never blocks.
  assert.equal(
    holdBlocksReplay(row({ hold: { reason: "unknown-procedure", at: "soon" } }), { now }),
    false,
  );
});

test("server-too-old is decided by the server's level, not by the clock", () => {
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  const held = row({
    apiLevel: 4,
    hold: { reason: "server-too-old", at: new Date(now - 60_000).toISOString() },
  });
  // Freshly held by the clock, but the server now reports enough: sent.
  assert.equal(holdBlocksReplay(held, { now, serverApiLevel: 4 }), false);
  assert.equal(holdBlocksReplay(held, { now, serverApiLevel: 9 }), false);
  // Still too old, and no amount of waiting changes that.
  assert.equal(holdBlocksReplay(held, { now, serverApiLevel: 3 }), true);
  assert.equal(
    holdBlocksReplay(held, { now: now + HELD_RETRY_MS * 10, serverApiLevel: 3 }),
    true,
  );
  // A server of unknown level falls back to the clock.
  assert.equal(holdBlocksReplay(held, { now }), true);
  assert.equal(holdBlocksReplay(held, { now, serverApiLevel: null }), true);
  // A row of unknown level is sent as it always was.
  assert.equal(
    holdBlocksReplay(
      row({ hold: { reason: "server-too-old", at: new Date(now).toISOString() } }),
      { now, serverApiLevel: 1 },
    ),
    false,
  );
});

test("heldReasons follows a temp-id chain in order, and only forwards", () => {
  const rows: QueuedMutation[] = [
    // Queued before the create it depends on: nothing behind it yet to hold it.
    row({ id: "update-before", op: "items.update", payload: updatePayload("t1") }),
    row({ id: "create", op: "items.archive", payload: createPayload("t1") }),
    row({ id: "update", op: "items.update", payload: updatePayload("t1") }),
    row({ id: "other", op: "items.update", payload: updatePayload("t2") }),
  ];
  const held = heldReasons(rows);
  assert.deepEqual(
    [...held.entries()],
    [
      ["create", "unknown-op"],
      ["update", "unknown-op"],
    ],
  );
  assert.equal(tempIdOf(rows[3]), "t2");
  assert.equal(tempIdOf({ payload: { input: {} } }), undefined);
  assert.equal(tempIdOf({ payload: null }), undefined);
});

// ── the queue ────────────────────────────────────────────────────────

test("a hold verdict keeps the row, stamps it and carries on, holding its chain", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue({ storage });
  const create = await queue.enqueue("items.create", createPayload("t1"));
  const chained = await queue.enqueue("items.update", updatePayload("t1"));
  const next = await queue.enqueue("items.create", createPayload("t2"));

  const ran: string[] = [];
  const result = await queue.flush(
    async (mutation) => {
      ran.push(mutation.id);
      if (mutation.id === create.id) return { hold: "unknown-procedure" };
    },
    { chainOf: tempIdOf },
  );

  // The held row's chain is never even offered to the runner.
  assert.deepEqual(ran, [create.id, next.id]);
  assert.equal(result.flushed, 1);
  assert.equal(result.held, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.remaining, 2);
  const rows = await queue.list();
  assert.deepEqual(
    rows.map((it) => it.id),
    [create.id, chained.id],
  );
  assert.equal(rows[0].hold?.reason, "unknown-procedure");
  const heldAt = rows[0].hold?.at;
  assert.ok(typeof heldAt === "string" && !Number.isNaN(Date.parse(heldAt)));
  // The chained row is held by its chain, not stamped: the chain may release.
  assert.equal(rows[1].hold, undefined);
});

test("an unknown-op verdict is not written onto the row", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("items.archive", createPayload());
  const result = await queue.flush(async () => ({ hold: "unknown-op" }));
  assert.equal(result.held, 1);
  assert.equal(result.skipped, 1);
  const [only] = await queue.list();
  assert.equal(only.hold, undefined);
  // Recomputed instead, so the build that understands the op releases it.
  assert.equal(holdReasonOf(only), "unknown-op");
});

test("a filtered row strands its chain without calling it held", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const create = await queue.enqueue("items.create", createPayload("t1"));
  await queue.enqueue("items.update", updatePayload("t1"));
  const result = await queue.flush(async () => undefined, {
    filter: (mutation) => mutation.id !== create.id,
    chainOf: tempIdOf,
  });
  assert.equal(result.flushed, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.held, 0);
});

test("a stored hold with a reason this build does not know is dropped on read", async () => {
  const storage = memoryStorage();
  await storage.setItem(
    KEY,
    JSON.stringify({
      v: 1,
      data: [
        { ...row({ id: "a" }), hold: { reason: "some-future-reason", at: "2026-09-14T09:00:00Z" } },
        // Never stored by this build, and ignored when something else stores it.
        { ...row({ id: "b" }), hold: { reason: "unknown-op", at: "2026-09-14T09:00:00Z" } },
        { ...row({ id: "c" }), hold: { reason: "unknown-procedure", at: "2026-09-14T09:00:00Z" } },
        { ...row({ id: "d" }), hold: { reason: "unknown-procedure", at: 7 } },
      ],
    }),
  );
  const rows = await createOfflineQueue({ storage }).list();
  assert.deepEqual(
    rows.map((it) => it.hold?.reason ?? null),
    [null, null, "unknown-procedure", null],
  );
});
