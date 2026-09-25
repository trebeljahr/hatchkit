import assert from "node:assert/strict";
import { test } from "node:test";
import {
  memoryStorage,
  migrateStore,
  migrationMarkerKey,
  webStorage,
  type SyncStorageLike,
} from "../storage.js";

/** A `localStorage` that refuses everything — privacy mode, or a full quota. */
const throwingBacking = (): SyncStorageLike => ({
  getItem: () => {
    throw new Error("storage disabled");
  },
  setItem: () => {
    throw new Error("quota exceeded");
  },
  removeItem: () => {
    throw new Error("storage disabled");
  },
});

const mapBacking = (): SyncStorageLike => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
};

test("memory storage reads back what it was given and forgets what was removed", async () => {
  const store = memoryStorage();
  assert.equal(await store.getItem("k"), null);
  await store.setItem("k", "v");
  assert.equal(await store.getItem("k"), "v");
  await store.setItem("k", "w");
  assert.equal(await store.getItem("k"), "w");
  await store.removeItem("k");
  assert.equal(await store.getItem("k"), null);
  // Removing a key that was never there is not an error.
  await store.removeItem("k");
});

test("web storage adapts a synchronous store", async () => {
  const store = webStorage(mapBacking());
  await store.setItem("k", "v");
  assert.equal(await store.getItem("k"), "v");
  await store.removeItem("k");
  assert.equal(await store.getItem("k"), null);
});

test("a backing store that throws is silent on all three methods", async () => {
  // A store that cannot be written must not crash the surface the person is
  // looking at — which is also why nothing with no other copy belongs here.
  const store = webStorage(throwingBacking());
  await store.setItem("k", "v");
  assert.equal(await store.getItem("k"), null);
  await store.removeItem("k");
});

test("a value moves once, behind its marker", async () => {
  const from = memoryStorage();
  const to = memoryStorage();
  await from.setItem("queue", "rows");

  assert.deepEqual(await migrateStore({ from, to, key: "queue" }), {
    moved: true,
  });
  assert.equal(await to.getItem("queue"), "rows");
  assert.notEqual(await to.getItem(migrationMarkerKey("queue")), null);
  // The source is left in place by default, so a rollback to the previous
  // build still finds the rows.
  assert.equal(await from.getItem("queue"), "rows");

  // Second call: nothing is read and nothing is written, so a person who
  // emptied the queue after upgrading is not handed the old rows back.
  await to.removeItem("queue");
  assert.deepEqual(await migrateStore({ from, to, key: "queue" }), {
    moved: false,
    reason: "already-migrated",
  });
  assert.equal(await to.getItem("queue"), null);
});

test("`removeSource` is the only way the old copy goes", async () => {
  const from = memoryStorage();
  const to = memoryStorage();
  await from.setItem("queue", "rows");
  await migrateStore({ from, to, key: "queue", removeSource: true });
  assert.equal(await from.getItem("queue"), null);
  assert.equal(await to.getItem("queue"), "rows");
});

test("a target that already holds the key keeps its own value", async () => {
  const from = memoryStorage();
  const to = memoryStorage();
  await from.setItem("queue", "old");
  await to.setItem("queue", "new");

  assert.deepEqual(await migrateStore({ from, to, key: "queue" }), {
    moved: false,
    reason: "target-occupied",
  });
  assert.equal(await to.getItem("queue"), "new");
  // Marked all the same: the value is already where it belongs, and asking
  // again on every launch is a read of a store that may be slow.
  assert.notEqual(await to.getItem(migrationMarkerKey("queue")), null);
});

test("nothing to move still marks the migration as done", async () => {
  const from = memoryStorage();
  const to = memoryStorage();
  assert.deepEqual(await migrateStore({ from, to, key: "queue" }), {
    moved: false,
    reason: "nothing-to-move",
  });
  assert.notEqual(await to.getItem(migrationMarkerKey("queue")), null);
});

test("a renamed key is marked under its new name", async () => {
  const from = memoryStorage();
  const to = memoryStorage();
  await from.setItem("old.queue", "rows");
  await migrateStore({ from, to, key: "old.queue", toKey: "new.queue" });
  assert.equal(await to.getItem("new.queue"), "rows");
  assert.notEqual(await to.getItem(migrationMarkerKey("new.queue")), null);
});

test("a migration never throws, and an unfinished one is tried again", async () => {
  const from: ReturnType<typeof memoryStorage> = {
    getItem: async () => {
      throw new Error("source unreadable");
    },
    setItem: async () => {},
    removeItem: async () => {},
  };
  const to = memoryStorage();
  const result = await migrateStore({ from, to, key: "queue" });
  assert.equal(result.moved, false);
  // The marker is not set, so the next launch tries again rather than
  // concluding there was nothing to move.
  assert.equal(await to.getItem(migrationMarkerKey("queue")), null);
});
