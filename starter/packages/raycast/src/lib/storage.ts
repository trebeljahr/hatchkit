/**
 * Raycast's encrypted per-extension store, bound to the shared client core's
 * one storage seam — and the cross-process echo of the authoritative state.
 *
 * ============================================================
 * WHY THIS IS THE ONLY HOST-SPECIFIC PIECE
 * ============================================================
 *
 * The shared client core opens no store of its own: a host passes one in, because only
 * the host knows which of its stores answers which question. Raycast has
 * exactly one, `LocalStorage`, and it is encrypted and scoped to this
 * extension — which is why the credential may live in it at all. Everything
 * core-owned that this extension persists (the durable queue, the optimistic
 * overlay, the read cache, the per-origin capability cache) therefore goes
 * through {@link raycastStorage} and nothing else. A piece of that state that
 * grows a Raycast-specific copy drifts from every other client the first time
 * a core rule changes, and nothing fails to say so.
 *
 * Raycast keys this store by the extension's (name, author) pair. Both are
 * permanent after the first publish — see PUBLISHING.md.
 *
 * ============================================================
 * WHY THERE IS AN ECHO AT ALL
 * ============================================================
 *
 * Every Raycast command is its own short-lived process with no shared memory.
 * The menu bar command cannot be told by the capture command that an item was
 * just created; storage is the only channel between them. So the single piece
 * of authoritative session-scoped state — which item this session touched last
 * — is written here the instant the server confirms a mutation, from the one
 * API choke point in `api.ts`, and every surface re-reads it once a second.
 *
 * That read is local: no network, so it is the only rung of the freshness
 * ladder that works offline, and it is the fastest one.
 *
 * The echo carries no TTL and needs none, because {@link echoOutranks} compares
 * the echo against WHEN THE SNAPSHOT WAS FETCHED rather than against the clock.
 * A record of a change made here can therefore never mask a newer change that
 * originated on another device: that change arrives in a snapshot fetched after
 * the echo was written, and the snapshot wins.
 */
import { LocalStorage } from "@raycast/api";
import type { KeyValueStorage } from "../vendor";

/**
 * Raycast's store as the shared seam.
 *
 * Every read and write is guarded. A store that cannot be read must not take
 * down the surface the person is looking at, and a value that will not decode
 * reads as absent rather than throwing — which for the cache and the capability
 * cache is the correct answer, and for the queue is handled by the queue's own
 * reader.
 */
export const raycastStorage = (): KeyValueStorage => ({
  async getItem(key: string): Promise<string | null> {
    try {
      return (await LocalStorage.getItem<string>(key)) ?? null;
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      await LocalStorage.setItem(key, value);
    } catch {
      /* the store is unavailable — a slower next launch, never a crash */
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      await LocalStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
});

/** Where the echo is filed. Keys are contracts: never renamed. */
const STATE_ECHO_KEY = "starter.state-echo";

/** The one piece of authoritative session-scoped state, as other processes see it. */
export type StateEcho = {
  /** The item this session touched last. */
  id: string;
  /** ISO instant the SERVER confirmed it — not when the person asked. */
  at: string;
};

const decodeEcho = (raw: string | null): StateEcho | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { id, at } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id === "") return null;
    if (typeof at !== "string" || at === "") return null;
    return { id, at };
  } catch {
    return null;
  }
};

export async function readStateEcho(): Promise<StateEcho | null> {
  return decodeEcho(await raycastStorage().getItem(STATE_ECHO_KEY));
}

/**
 * Record a confirmed mutation.
 *
 * Called from `api.ts`'s choke point and from nowhere else. Writing it at a
 * call site instead means the next command somebody adds forgets it, and the
 * menu bar then shows the state as it was before that command ran — with
 * nothing failing.
 */
export async function writeStateEcho(echo: StateEcho): Promise<void> {
  await raycastStorage().setItem(STATE_ECHO_KEY, JSON.stringify(echo));
}

export async function clearStateEcho(): Promise<void> {
  await raycastStorage().removeItem(STATE_ECHO_KEY);
}

/**
 * Whether the echo is newer than the snapshot it would override.
 *
 * `fetchedAt` is when the snapshot was FETCHED, not when the server said its
 * rows were last modified. That is the whole reconciliation: a change made from
 * this install is confirmed at a known instant, and any snapshot pulled after
 * that instant already contains it — including a snapshot that contains
 * somebody else's newer change instead. Comparing against a TTL would keep
 * replacing a fresh remote answer with a stale local one for as long as the TTL
 * lasted.
 *
 * An unparseable stamp on either side means "cannot say", and the snapshot wins:
 * the server's answer is the one with a second copy.
 */
export function echoOutranks(echo: StateEcho | null, fetchedAt: string | null): boolean {
  if (echo === null) return false;
  if (fetchedAt === null || fetchedAt === "") return true;
  const echoMs = Date.parse(echo.at);
  const fetchedMs = Date.parse(fetchedAt);
  if (Number.isNaN(echoMs) || Number.isNaN(fetchedMs)) return false;
  return echoMs > fetchedMs;
}
