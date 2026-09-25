import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLocalCache,
  drainThenRead,
  writingThroughQueue,
} from "../local-cache.js";
import { memoryStorage } from "../storage.js";
import type { VersionedSpec } from "../versioned-storage.js";
import type { FlushResult } from "../offline-queue.js";

type Row = { n: number };

const readRow = (data: unknown): Row | null => {
  if (typeof data !== "object" || data === null) return null;
  const { n } = data as { n?: unknown };
  return typeof n === "number" ? { n } : null;
};

const spec: VersionedSpec<Row> = { version: 2, decode: readRow };
/** The same value, one shape later: what the next build reads with. */
const nextSpec: VersionedSpec<Row> = { version: 3, decode: readRow };

const drained: FlushResult = { flushed: 1, remaining: 0, skipped: 0, held: 0 };

/** A transport failure is a type test in real hosts; here it is one class. */
class Offline extends Error {}
const isTransportFailure = (error: unknown): boolean =>
  error instanceof Offline;

test("a written value reads back with the time it was written", async () => {
  const cache = createLocalCache({ storage: memoryStorage() });
  assert.equal(await cache.read("items", spec), null);

  await cache.write("items", spec, { n: 1 });
  const read = await cache.read("items", spec);
  assert.deepEqual(read?.value, { n: 1 });
  assert.ok(read && !Number.isNaN(Date.parse(read.at)));
});

test("a value the next build wrote, and one this build outgrew, are both misses", async () => {
  const storage = memoryStorage();
  const cache = createLocalCache({ storage });

  await cache.write("items", nextSpec, { n: 1 });
  // A HIGHER version is a miss: a newer build wrote it and this one cannot know
  // what the fields mean now. The caller refetches, which is always correct.
  assert.equal(await cache.read("items", spec), null);

  await cache.write("items", spec, { n: 1 });
  assert.equal(await cache.read("items", nextSpec), null);

  // A shape the decoder refuses is a miss too, not a bad render.
  await storage.setItem(
    "starter.cache.items",
    JSON.stringify({ v: 2, data: { at: "", value: { n: "1" } } }),
  );
  assert.equal(await cache.read("items", spec), null);
});

test("garbage in the store is a miss and does not throw", async () => {
  const storage = memoryStorage();
  const cache = createLocalCache({ storage });
  for (const raw of ["{broken", "", "null", "[]", '"x"', "42"]) {
    await storage.setItem("starter.cache.items", raw);
    assert.equal(await cache.read("items", spec), null, raw);
  }
});

test("a store that throws on every call is a miss, never a crash", async () => {
  const throwing = {
    getItem: async (): Promise<string | null> => {
      throw new Error("store");
    },
    setItem: async (): Promise<void> => {
      throw new Error("store");
    },
    removeItem: async (): Promise<void> => {
      throw new Error("store");
    },
  };
  const cache = createLocalCache({ storage: throwing });
  await cache.write("items", spec, { n: 1 });
  assert.equal(await cache.read("items", spec), null);
  await cache.drop("items");
  await cache.clear(["items", "profile"]);
});

test("a bare value from before the envelope reads through `legacy` only", async () => {
  const storage = memoryStorage();
  await storage.setItem("starter.cache.items", JSON.stringify({ n: 5 }));

  const withoutLegacy = createLocalCache({ storage });
  assert.equal(await withoutLegacy.read("items", spec), null);

  const legacySpec: VersionedSpec<Row> = { ...spec, legacy: readRow };
  const read = await withoutLegacy.read("items", legacySpec);
  // No stamp was ever written beside it, and that is not a reason to drop it.
  assert.deepEqual(read, { value: { n: 5 }, at: "" });
});

test("drop forgets one key and clear forgets the list a sign-out hands it", async () => {
  const storage = memoryStorage();
  const cache = createLocalCache({ storage, prefix: "app." });
  await cache.write("items", spec, { n: 1 });
  await cache.write("profile", spec, { n: 2 });
  assert.ok((await storage.getItem("app.items")) !== null);

  await cache.drop("items");
  assert.equal(await cache.read("items", spec), null);
  assert.deepEqual((await cache.read("profile", spec))?.value, { n: 2 });

  await cache.clear(["items", "profile"]);
  assert.equal(await cache.read("profile", spec), null);
});

test("a read drains the queue before it reads, and answers with the fresh value", async () => {
  const order: string[] = [];
  const result = await drainThenRead({
    queue: { size: async () => 2 },
    flush: async () => {
      order.push("flush");
      return drained;
    },
    read: async () => {
      order.push("read");
      return { n: 1 };
    },
    fallback: async () => null,
    isTransportFailure,
  });
  assert.deepEqual(order, ["flush", "read"]);
  assert.deepEqual(result.value, { n: 1 });
  assert.equal(result.fromCache, false);
  assert.deepEqual(result.flush, drained);
});

test("an empty queue is not drained, and a drain that throws still lets the read happen", async () => {
  const empty = await drainThenRead({
    queue: { size: async () => 0 },
    flush: async () => {
      throw new Error("must not be called");
    },
    read: async () => ({ n: 1 }),
    fallback: async () => null,
    isTransportFailure,
  });
  assert.equal(empty.flush, null);
  assert.deepEqual(empty.value, { n: 1 });

  const brokenStore = await drainThenRead({
    queue: { size: async () => 1 },
    flush: async () => {
      throw new Error("store");
    },
    read: async () => ({ n: 1 }),
    fallback: async () => null,
    isTransportFailure,
  });
  assert.equal(brokenStore.flush, null);
  assert.deepEqual(brokenStore.value, { n: 1 });
});

test("a read with no answer falls back to the cache and says so", async () => {
  const result = await drainThenRead<Row>({
    queue: { size: async () => 0 },
    flush: async () => drained,
    read: async () => {
      throw new Offline("fetch failed");
    },
    fallback: async () => ({ n: 9 }),
    isTransportFailure,
  });
  assert.deepEqual(result.value, { n: 9 });
  assert.equal(result.fromCache, true);

  // A device that has never had a successful read has nothing to fall back on;
  // `fromCache` still says the answer did not come from the server.
  const cold = await drainThenRead<Row>({
    queue: { size: async () => 0 },
    flush: async () => drained,
    read: async () => {
      throw new Offline("fetch failed");
    },
    fallback: async () => null,
    isTransportFailure,
  });
  assert.equal(cold.value, null);
  assert.equal(cold.fromCache, true);
});

test("a read the server answered with an error is never papered over", async () => {
  await assert.rejects(
    drainThenRead<Row>({
      queue: { size: async () => 0 },
      flush: async () => drained,
      read: async () => {
        throw new Error("UNAUTHORIZED");
      },
      fallback: async () => {
        throw new Error("the fallback must not be reached");
      },
      isTransportFailure,
    }),
    /UNAUTHORIZED/,
  );
});

test("a write with nothing waiting goes straight to the server", async () => {
  const order: string[] = [];
  const result = await writingThroughQueue({
    flush: async () => {
      order.push("flush");
      return drained;
    },
    pending: async () => 0,
    send: async () => {
      order.push("send");
      return { ok: true };
    },
    queue: async () => {
      throw new Error("must not queue");
    },
    isTransportFailure,
  });
  assert.deepEqual(order, ["flush", "send"]);
  assert.deepEqual(result, { sent: true });
});

test("a write behind rows the drain left is queued, in order", async () => {
  let queued = 0;
  const result = await writingThroughQueue({
    flush: async () => ({ flushed: 0, remaining: 2, skipped: 0, held: 0 }),
    pending: async () => 2,
    send: async () => {
      throw new Error("must not send ahead of the queue");
    },
    queue: async () => {
      queued += 1;
    },
    isTransportFailure,
  });
  assert.deepEqual(result, { sent: false });
  assert.equal(queued, 1);
});

test("a drain that throws is read as 'something may be waiting'", async () => {
  let queued = 0;
  const result = await writingThroughQueue({
    flush: async () => {
      throw new Error("store");
    },
    pending: async () => 0,
    send: async () => {
      throw new Error("must not send on a guess");
    },
    queue: async () => {
      queued += 1;
    },
    isTransportFailure,
  });
  assert.deepEqual(result, { sent: false });
  assert.equal(queued, 1);
});

test("a write with no answer is queued; one the server refused is not", async () => {
  let queued = 0;
  const offline = await writingThroughQueue({
    flush: async () => drained,
    pending: async () => 0,
    send: async () => {
      throw new Offline("fetch failed");
    },
    queue: async () => {
      queued += 1;
    },
    isTransportFailure,
  });
  assert.deepEqual(offline, { sent: false });
  assert.equal(queued, 1);

  await assert.rejects(
    writingThroughQueue({
      flush: async () => drained,
      pending: async () => 0,
      send: async () => {
        throw new Error("BAD_REQUEST");
      },
      queue: async () => {
        queued += 1;
      },
      isTransportFailure,
    }),
    /BAD_REQUEST/,
  );
  // Replaying a refused mutation would only be refused again, forever.
  assert.equal(queued, 1);
});
