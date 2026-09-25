import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOverlay,
  decodeStoredOverlay,
  emptyOverlay,
  encodeStoredOverlay,
  isOverlayEmpty,
  OFFLINE_OVERLAY_STORAGE_KEY,
  parseOverlay,
  readStoredItem,
  readStoredItemPatch,
  readStoredList,
  resolveItem,
  withOptimisticItem,
  withOptimisticPatch,
  withOptimisticRemoval,
  withoutResolved,
  type OfflineOverlay,
} from "../offline-overlay.js";
import type { Item } from "@starter/shared";

const item = (
  id: string,
  createdAt: string,
  overrides: Partial<Item> = {},
): Item => ({
  id,
  title: id,
  status: "draft",
  ownerId: "u",
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

test("the storage key is the contract the hosts bind to", () => {
  assert.equal(OFFLINE_OVERLAY_STORAGE_KEY, "starter.offline-overlay");
});

test("an empty overlay leaves the server's records exactly as they came", () => {
  const server = [item("a", "2026-09-08T09:00:00.000Z")];
  assert.deepEqual(applyOverlay(server, emptyOverlay()), server);
  assert.ok(isOverlayEmpty(emptyOverlay()));
});

test("a queued deletion hides the record it names", () => {
  const server = [
    item("a", "2026-09-08T09:00:00.000Z"),
    item("b", "2026-09-08T10:00:00.000Z"),
  ];
  const overlay = withOptimisticRemoval(emptyOverlay(), "a");
  assert.deepEqual(
    applyOverlay(server, overlay).map((row) => row.id),
    ["b"],
  );
});

test("a queued edit is shown over the server's row", () => {
  const server = [item("a", "2026-09-08T09:00:00.000Z")];
  const overlay = withOptimisticPatch(emptyOverlay(), "a", {
    title: "renamed",
  });
  assert.equal(applyOverlay(server, overlay)[0]?.title, "renamed");
});

test("a second edit builds on the first rather than replacing it", () => {
  let overlay = withOptimisticPatch(emptyOverlay(), "a", { title: "one" });
  overlay = withOptimisticPatch(overlay, "a", { status: "published" });
  assert.deepEqual(overlay.patches.a, { title: "one", status: "published" });
});

test("an edit to a local record lands on the record, not in the patch map", () => {
  const local = item("temp-1", "2026-09-08T09:00:00.000Z");
  let overlay = withOptimisticItem(emptyOverlay(), local);
  overlay = withOptimisticPatch(overlay, "temp-1", { title: "renamed" });

  assert.deepEqual(overlay.patches, {});
  assert.equal(overlay.items[0]?.title, "renamed");
});

test("a local record written twice replaces the first copy", () => {
  const first = item("temp-1", "2026-09-08T09:00:00.000Z");
  const again = item("temp-1", "2026-09-08T09:00:00.000Z", {
    status: "published",
  });
  const overlay = withOptimisticItem(
    withOptimisticItem(emptyOverlay(), first),
    again,
  );
  assert.equal(overlay.items.length, 1);
  assert.equal(overlay.items[0]?.status, "published");
});

test("deleting a local record forgets it; deleting a server record remembers it", () => {
  const local = item("temp-1", "2026-09-08T09:00:00.000Z");
  const withLocal = withOptimisticItem(emptyOverlay(), local);

  const localGone = withOptimisticRemoval(withLocal, "temp-1");
  assert.deepEqual(localGone.items, []);
  assert.deepEqual(localGone.removed, []);

  const serverGone = withOptimisticRemoval(emptyOverlay(), "a");
  assert.deepEqual(serverGone.removed, ["a"]);
  // Queuing the same deletion twice must not queue it twice.
  assert.deepEqual(withOptimisticRemoval(serverGone, "a").removed, ["a"]);
});

test("local records are shown newest first alongside the server's", () => {
  const server = [item("a", "2026-09-08T09:00:00.000Z")];
  const overlay = withOptimisticItem(
    emptyOverlay(),
    item("temp-1", "2026-09-08T11:00:00.000Z"),
  );
  assert.deepEqual(
    applyOverlay(server, overlay).map((row) => row.id),
    ["temp-1", "a"],
  );
});

test("a local record outside the requested window is not shown in it", () => {
  const overlay = withOptimisticItem(
    emptyOverlay(),
    item("temp-1", "2026-09-01T09:00:00.000Z"),
  );
  const shown = applyOverlay([], overlay, {
    from: "2026-09-08T00:00:00.000Z",
    to: "2026-09-08T23:59:59.000Z",
  });
  assert.deepEqual(shown, []);
  // The same record is shown when the window does cover it.
  assert.equal(
    applyOverlay([], overlay, { from: "2026-09-01T00:00:00.000Z" }).length,
    1,
  );
});

test("a local record the server's page already carries is not shown twice", () => {
  const server = [item("temp-1", "2026-09-08T09:00:00.000Z")];
  const overlay = withOptimisticItem(
    emptyOverlay(),
    item("temp-1", "2026-09-08T09:00:00.000Z"),
  );
  assert.equal(applyOverlay(server, overlay).length, 1);
});

test("a local copy of a server row outranks the server's answer", () => {
  const server = item("a", "2026-09-08T09:00:00.000Z");
  const overlay = withOptimisticItem(
    emptyOverlay(),
    item("a", "2026-09-08T09:00:00.000Z", { title: "local" }),
  );
  assert.equal(resolveItem(server, overlay)?.id, "a");
  assert.equal((resolveItem(server, overlay) as Item).title, "local");
});

test("a queued deletion hides the server's record", () => {
  const server = item("a", "2026-09-08T09:00:00.000Z");
  const overlay = withOptimisticRemoval(emptyOverlay(), "a");
  assert.equal(resolveItem(server, overlay), null);
  assert.equal(resolveItem(null, overlay), null);
});

test("a queued edit keeps the record, edited", () => {
  const server = item("a", "2026-09-08T09:00:00.000Z");
  const untouched = resolveItem(server, emptyOverlay());
  assert.equal(untouched, server);

  const overlay = withOptimisticPatch(emptyOverlay(), "a", {
    title: "renamed",
  });
  const resolved = resolveItem(server, overlay);
  assert.equal(resolved?.id, "a");
  assert.equal((resolved as Item).title, "renamed");
});

test("a replayed create's local copy is dropped once it has a real id", () => {
  const overlay = withOptimisticItem(
    emptyOverlay(),
    item("temp-1", "2026-09-08T09:00:00.000Z"),
  );
  assert.equal(withoutResolved(overlay, new Map()), overlay);

  const after = withoutResolved(overlay, new Map([["temp-1", "real-1"]]));
  assert.deepEqual(after.items, []);
  assert.ok(isOverlayEmpty(after));
});

test("an unreadable stored overlay reads as no overlay at all", () => {
  assert.ok(isOverlayEmpty(parseOverlay(null)));
  assert.ok(isOverlayEmpty(parseOverlay("nonsense")));
  assert.ok(isOverlayEmpty(parseOverlay({ items: "no" })));
  // A partial object is missing the parts a reader walks, so it is empty too.
  assert.ok(isOverlayEmpty(parseOverlay({ items: [], removed: [] })));

  const real: OfflineOverlay = {
    items: [],
    patches: { a: { title: "x" } },
    removed: ["b"],
  };
  assert.deepEqual(parseOverlay(JSON.parse(JSON.stringify(real))), real);
});

test("a stored overlay round trips through the envelope and reads the bare shape", () => {
  const overlay = withOptimisticItem(
    emptyOverlay(),
    item("temp-1", "2026-09-08T09:00:00.000Z"),
  );
  const raw = encodeStoredOverlay(overlay);
  assert.equal((JSON.parse(raw) as { v: number }).v, 1);
  assert.deepEqual(decodeStoredOverlay(raw), overlay);
  // A build from before the envelope wrote the overlay bare.
  assert.deepEqual(decodeStoredOverlay(JSON.stringify(overlay)), overlay);
  assert.ok(isOverlayEmpty(decodeStoredOverlay(null)));
});

test("a newer build's overlay, or rows another build shaped wrongly, are dropped", () => {
  const good = item("temp-1", "2026-09-08T09:00:00.000Z");
  const overlay = { items: [good], patches: {}, removed: [] };
  assert.ok(
    isOverlayEmpty(
      decodeStoredOverlay(JSON.stringify({ v: 2, data: overlay })),
    ),
  );
  assert.ok(isOverlayEmpty(decodeStoredOverlay("{broken")));

  const mixed = decodeStoredOverlay(
    JSON.stringify({
      items: [
        good,
        { ...good, id: "temp-2", status: "whatever" },
        { ...good, id: "temp-3", createdAt: "yesterday" },
      ],
      patches: { a: { title: "x" }, b: { status: 7 }, c: 4 },
      removed: ["d", 5],
    }),
  );
  // Each bad row costs itself and nothing around it.
  assert.deepEqual(
    mixed.items.map((row) => row.id),
    ["temp-1"],
  );
  assert.deepEqual(mixed.patches, { a: { title: "x" } });
  assert.deepEqual(mixed.removed, ["d"]);
});

test("the row readers keep unknown fields and default only what is informational", () => {
  const stored = { ...item("a", "2026-09-08T09:00:00.000Z"), future: 1 };
  assert.deepEqual(readStoredItem(stored), stored);
  // `updatedAt` is informational: a build that dropped it still leaves a row.
  const { updatedAt: _updatedAt, ...withoutStamp } = stored;
  assert.equal(readStoredItem(withoutStamp)?.updatedAt, "");
  assert.equal(readStoredItem({ ...stored, title: 7 }), null);
  assert.equal(readStoredItem({ ...stored, id: "" }), null);

  // Nothing in a patch defaults — a defaulted field is an edit nobody made.
  assert.deepEqual(readStoredItemPatch({ status: "archived" }), {
    status: "archived",
  });
  assert.equal(readStoredItemPatch({ createdAt: "whenever" }), null);

  assert.deepEqual(
    readStoredList([stored, { id: 1 }, null], readStoredItem),
    [stored],
  );
  assert.deepEqual(readStoredList("nope", readStoredItem), []);
});
