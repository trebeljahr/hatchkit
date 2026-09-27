/**
 * The three offline stores, bound to Raycast's one store.
 *
 * Nothing here implements a queue, an overlay or a cache. All three come from
 * the shared client core through the vendored barrel, and this module is only the
 * binding plus the two Raycast-specific facts: which storage they use, and what
 * this extension caches.
 *
 * Keeping it that way is the point of `packages/core` existing. A second copy
 * of the FIFO's format rules, the hold vocabulary or the overlay's precedence
 * would drift from the web app and the browser extension the first time one of
 * those rules changed — and it would drift silently, because a queue that
 * replays slightly differently still replays.
 *
 * The three answer different questions, which is why they are three:
 *
 *  - the QUEUE is what still has to be sent. Its rows are the only copy of work
 *    the person did with no answer from the server, so a sign-out never clears
 *    it;
 *  - the OVERLAY is what the screen should show right now — a queued create is
 *    a row in the queue and nothing on screen without it;
 *  - the CACHE is the last good answer to a read, which is what lets a command
 *    that renders nothing beforehand work with no network at all.
 */
import {
  type CachedRead,
  type Item,
  type LocalCache,
  type OfflineOverlay,
  type OfflineQueue,
  type VersionedSpec,
  createLocalCache,
  createOfflineQueue,
  decodeStoredOverlay,
  emptyOverlay,
  encodeStoredOverlay,
  OFFLINE_OVERLAY_STORAGE_KEY,
} from "../vendor";
import { raycastStorage } from "./storage";

/** The durable FIFO of unsent work. Never cleared by a sign-out. */
export const offlineQueue = (): OfflineQueue => createOfflineQueue({ storage: raycastStorage() });

/** The last good answer to each read. Cleared by a sign-out. */
export const localCache = (): LocalCache => createLocalCache({ storage: raycastStorage() });

/** The one key this extension caches under. */
export const ITEMS_CACHE_KEY = "items";

/** Everything the cache holds, for the sign-out that has to clear all of it. */
export const CACHE_KEYS: readonly string[] = [ITEMS_CACHE_KEY];

const isItemStatus = (value: unknown): value is Item["status"] =>
  value === "draft" || value === "published" || value === "archived";

const readItem = (value: unknown): Item | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  if (typeof row.title !== "string") return null;
  if (!isItemStatus(row.status)) return null;
  if (typeof row.ownerId !== "string") return null;
  if (typeof row.createdAt !== "string") return null;
  if (typeof row.updatedAt !== "string") return null;
  return {
    id: row.id,
    title: row.title,
    description: typeof row.description === "string" ? row.description : undefined,
    status: row.status,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/**
 * The cached item list.
 *
 * The version is this cache's own. Bumping it invalidates exactly these rows
 * and nothing else, and a value written by a newer build is a MISS — which for
 * a cache is the right answer, because the caller simply asks the server again.
 */
export const ITEMS_CACHE_SPEC: VersionedSpec<Item[]> = {
  version: 1,
  decode: (data) =>
    Array.isArray(data) ? data.map(readItem).filter((it): it is Item => it !== null) : null,
};

export type CachedItems = CachedRead<Item[]>;

/** What this device believes about rows the server has not seen yet. */
export async function readOverlay(): Promise<OfflineOverlay> {
  return decodeStoredOverlay(await raycastStorage().getItem(OFFLINE_OVERLAY_STORAGE_KEY));
}

export async function writeOverlay(overlay: OfflineOverlay): Promise<void> {
  await raycastStorage().setItem(OFFLINE_OVERLAY_STORAGE_KEY, encodeStoredOverlay(overlay));
}

export async function clearOverlay(): Promise<void> {
  await writeOverlay(emptyOverlay());
}
