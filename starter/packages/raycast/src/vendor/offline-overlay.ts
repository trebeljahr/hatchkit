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
 * What a device believes about records the server has not seen yet.
 *
 * The offline queue holds the *mutations*; this holds their visible
 * consequence. They are separate because they answer different questions: the
 * queue answers "what still has to be sent", and only this can answer "what
 * should the screen be showing right now". Without it, a record created with no
 * signal is a row in storage and nothing on screen — every surface would keep
 * drawing whatever the last successful read said, and the last successful read
 * happened before the record existed.
 *
 * Pure and host-free on purpose. The rules here — a queued deletion hides a row
 * the server still returns, a second edit builds on the first, a local record
 * outside the requested window is not shown in it — are the ones that go
 * quietly wrong, and a host that keeps them next to its own storage code is a
 * host where nothing can test them.
 */
import { z } from "zod";
import type { Item } from "./types";
import {
  decodeVersioned,
  encodeVersioned,
  type VersionedSpec,
} from "./versioned-storage";

export type OfflineOverlay = {
  /** Records invented locally. Their ids are temp ids until a replay lands. */
  items: Item[];
  /** Queued edits to records the server already has, by record id. */
  patches: Record<string, Partial<Item>>;
  /** Records queued for deletion, by record id. */
  removed: string[];
};

/** The key a host stores the overlay under. Keys are contracts: never renamed. */
export const OFFLINE_OVERLAY_STORAGE_KEY = "starter.offline-overlay";

export const emptyOverlay = (): OfflineOverlay => ({
  items: [],
  patches: {},
  removed: [],
});

export const isOverlayEmpty = (overlay: OfflineOverlay): boolean =>
  overlay.items.length === 0 &&
  overlay.removed.length === 0 &&
  Object.keys(overlay.patches).length === 0;

// ── stored rows ──────────────────────────────────────────────────────

/**
 * Readers for the rows an overlay carries.
 *
 * A row in local storage was written by whichever build was installed at the
 * time, and it reaches list rendering (`title.trim()`), status filters and
 * date grouping without passing a server again. So the policy is: check what
 * the cache's readers actually use, default what is only informational, pass
 * unknown fields through untouched — a row from a NEWER build that only added
 * something still renders — and drop a failing row on its own rather than
 * discarding the overlay around it.
 *
 * Pure and throw-free; pair them with `versioned-storage.ts`.
 */
const instant = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "not an instant");

const ITEM_STATUSES = ["draft", "published", "archived"] as const;

/**
 * The fields a stored record must carry correctly.
 *
 * `createdAt` is required and must parse, because {@link applyOverlay} both
 * sorts and window-filters on it: an unparseable one would sort a local record
 * to a random place and leak it into every window. `status` is required because
 * a filtered list decides membership from it, and `title` because a row draws
 * it. `updatedAt` is informational — nothing here branches on it — so it
 * defaults rather than costing the row.
 */
const itemFields = {
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(ITEM_STATUSES),
  ownerId: z.string(),
  createdAt: instant,
  updatedAt: z.string().catch(""),
};

const itemSchema = z.looseObject(itemFields);

/**
 * A queued edit's local copy: any subset of a record's fields, each of which
 * must have the right type when present. Nothing defaults — a patch that set a
 * field to a fallback value would be an edit nobody made, shown on screen and
 * then contradicted by the replay.
 */
const itemPatchSchema = z.looseObject({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  createdAt: instant.optional(),
  updatedAt: z.string().optional(),
});

/** A stored {@link Item}, or null when a field this build reads is wrong. */
export const readStoredItem = (value: unknown): Item | null => {
  const parsed = itemSchema.safeParse(value);
  return parsed.success ? (parsed.data as Item) : null;
};

/** A stored partial record, or null when a field it carries has the wrong type. */
export const readStoredItemPatch = (value: unknown): Partial<Item> | null => {
  const parsed = itemPatchSchema.safeParse(value);
  return parsed.success ? (parsed.data as Partial<Item>) : null;
};

/** Every readable row of a stored list; a non-array is an empty list. */
export const readStoredList = <T>(
  value: unknown,
  read: (row: unknown) => T | null,
): T[] => {
  if (!Array.isArray(value)) return [];
  const rows: T[] = [];
  for (const row of value) {
    const decoded = read(row);
    if (decoded !== null) rows.push(decoded);
  }
  return rows;
};

// ── storage ──────────────────────────────────────────────────────────

/**
 * Read an overlay back out of storage.
 *
 * Anything unrecognisable is an empty overlay rather than a throw: a device
 * that cannot parse its own scratch state must still render the server's
 * answer, and the queue — which is what actually holds the work — is stored
 * separately and unaffected.
 */
export const parseOverlay = (value: unknown): OfflineOverlay => {
  if (typeof value !== "object" || value === null) return emptyOverlay();
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.items) ||
    !Array.isArray(record.removed) ||
    typeof record.patches !== "object" ||
    record.patches === null ||
    Array.isArray(record.patches)
  ) {
    return emptyOverlay();
  }
  // Row by row: a local record or patch written by another build with a field
  // this one would misread (a numeric status is an empty filter bucket on
  // screen) is dropped on its own, and the replay puts the server's version in
  // its place.
  const patches: Record<string, Partial<Item>> = {};
  for (const [id, patch] of Object.entries(record.patches)) {
    const read = readStoredItemPatch(patch);
    if (read !== null) patches[id] = read;
  }
  return {
    items: readStoredList(record.items, readStoredItem),
    patches,
    removed: record.removed.filter(
      (id): id is string => typeof id === "string",
    ),
  };
};

/** Version 1 is the overlay itself; builds before the envelope wrote it bare. */
const OVERLAY_SPEC: VersionedSpec<OfflineOverlay> = {
  version: 1,
  decode: parseOverlay,
  legacy: parseOverlay,
};

/** A stored overlay string; an unknown version or garbage is an empty overlay. */
export const decodeStoredOverlay = (raw: string | null): OfflineOverlay =>
  decodeVersioned(raw, OVERLAY_SPEC) ?? emptyOverlay();

export const encodeStoredOverlay = (overlay: OfflineOverlay): string =>
  encodeVersioned(OVERLAY_SPEC.version, overlay);

// ── editing ──────────────────────────────────────────────────────────

/**
 * Record a row this device invented, or replace one it already had.
 *
 * Replacing by id rather than appending is what lets a second optimistic write
 * against the same local row — a status change on a record created a minute ago
 * with no signal — rewrite it instead of putting a second copy of it on screen.
 */
export const withOptimisticItem = (
  overlay: OfflineOverlay,
  item: Item,
): OfflineOverlay => ({
  ...overlay,
  items: [
    item,
    ...overlay.items.filter((existing) => existing.id !== item.id),
  ],
});

/**
 * Record a queued edit.
 *
 * An edit to a LOCAL record is applied to that record directly — there is no
 * server row for a patch to be applied over later, and keeping the two apart
 * would show the pre-edit values until it syncs. An edit to a SERVER row is
 * merged onto any earlier queued edit, because a second edit made before the
 * first has been sent is a patch on top of the first: seeding it from the
 * untouched server row would erase the earlier one from the screen while the
 * queue still replayed both.
 */
export const withOptimisticPatch = (
  overlay: OfflineOverlay,
  id: string,
  patch: Partial<Item>,
): OfflineOverlay => {
  if (overlay.items.some((item) => item.id === id)) {
    return {
      ...overlay,
      items: overlay.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    };
  }
  return {
    ...overlay,
    patches: { ...overlay.patches, [id]: { ...overlay.patches[id], ...patch } },
  };
};

/**
 * Record a queued deletion.
 *
 * A local record is simply forgotten — the caller drops its queued rows at the
 * same time, so nothing is left to replay. A server record is remembered as
 * removed until the delete actually lands, and remembered once: queuing the
 * same deletion twice would leave a second id here that nothing ever clears.
 */
export const withOptimisticRemoval = (
  overlay: OfflineOverlay,
  id: string,
): OfflineOverlay => {
  if (overlay.items.some((item) => item.id === id)) {
    return {
      ...overlay,
      items: overlay.items.filter((item) => item.id !== id),
    };
  }
  return {
    ...overlay,
    removed: overlay.removed.includes(id)
      ? overlay.removed
      : [...overlay.removed, id],
  };
};

/**
 * Forget the local copies of creates that have now reached the server.
 *
 * `resolved` maps a temp id to the real id its replayed create was given, so
 * the local row can go: the next read carries the server's own copy, which is
 * richer. Everything else waits for a fully drained queue, which is the one
 * condition under which server truth is strictly better than anything held
 * here and needs no per-row reasoning.
 */
export const withoutResolved = (
  overlay: OfflineOverlay,
  resolved: ReadonlyMap<string, string>,
): OfflineOverlay => {
  if (resolved.size === 0) return overlay;
  return {
    ...overlay,
    items: overlay.items.filter((item) => !resolved.has(item.id)),
  };
};

// ── reading ──────────────────────────────────────────────────────────

/** Newest first, the order every record list renders. */
const byCreatedAtDesc = (a: Item, b: Item): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * The server's records with this device's unsynced work folded in.
 *
 * `window` narrows the LOCAL records to the range the caller asked the server
 * for, so a filtered view does not sprout an unsynced record from outside it
 * merely because it has not synced yet. A local record whose id is already in
 * the server's page — which happens for the one read that races a replay — is
 * dropped rather than shown twice.
 */
export const applyOverlay = (
  items: readonly Item[],
  overlay: OfflineOverlay,
  window?: { from?: string; to?: string },
): Item[] => {
  const removed = new Set(overlay.removed);
  const patched = items
    .filter((item) => !removed.has(item.id))
    .map((item) => {
      const patch = overlay.patches[item.id];
      return patch ? { ...item, ...patch } : item;
    });

  const known = new Set(patched.map((item) => item.id));
  const fromMs = window?.from
    ? Date.parse(window.from)
    : Number.NEGATIVE_INFINITY;
  const toMs = window?.to ? Date.parse(window.to) : Number.POSITIVE_INFINITY;

  const local = overlay.items.filter((item) => {
    if (known.has(item.id)) return false;
    const createdMs = Date.parse(item.createdAt);
    return createdMs >= fromMs && createdMs <= toMs;
  });

  return [...local, ...patched].sort(byCreatedAtDesc);
};

/**
 * What the current state of this one record is, once this device's unsynced
 * work is applied over the server's answer.
 *
 * Three cases, and the middle one is the one that bites: a delete queued for a
 * server record leaves that record present as far as the server is concerned,
 * so a surface that trusted the read would keep showing a record the person
 * deleted ten minutes ago — and acting on it again would queue a second
 * mutation against it.
 *
 * A record this device invented and the server has never heard of has no
 * server answer to resolve against; it lives in `overlay.items`, where the
 * caller that holds its id can read it directly.
 */
export const resolveItem = <T extends { id: string }>(
  server: T | null,
  overlay: OfflineOverlay,
): T | Item | null => {
  if (server === null) return null;
  // A local copy of the same id wins: it carries this device's work, and the
  // server's page is the answer from before that work was sent.
  const local = overlay.items.find((item) => item.id === server.id);
  if (local) return local;
  if (overlay.removed.includes(server.id)) return null;
  const patch = overlay.patches[server.id];
  if (patch === undefined) return server;
  return { ...server, ...patch };
};
