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
 * The last good answer to every read, and the choke point that drains the
 * queue on the way to making one.
 *
 * This is the third of the three stores a client that works offline keeps, and
 * each answers a different question:
 *
 *  - **The durable queue** (`offline-queue.ts`) — *what still has to be sent*.
 *    Its rows are the only copy of work the person did with no signal.
 *  - **The optimistic overlay** (`offline-overlay.ts`) — *what should the screen
 *    be showing right now*, which the queue cannot answer because a mutation is
 *    not a rendered row.
 *  - **This cache** — *what the last successful read said*. It is what lets a
 *    surface with no rendered state at all work with no signal: a launcher
 *    extension's hotkey that opens straight into an action and renders nothing
 *    beforehand, or a browser extension's service worker woken to handle one
 *    message. And it is what gives an optimistic shape the defaults it needs to
 *    guess what the server is about to write, so the row on screen is the row
 *    that lands rather than a placeholder that changes under the person's eyes
 *    when the queue finally drains.
 *
 * ## What is cleared on sign-out, and what is not
 *
 * This cache, and any per-account state derived from it, are CLEARED on
 * sign-out — the next person to use the device must see nothing of the last
 * one's data, and every row in here can be fetched again by whoever signs in
 * next. The offline QUEUE is NOT cleared: its rows are work that exists nowhere
 * else, and dropping them to tidy up a sign-out destroys it. That contrast is
 * the point of keeping the two in separate stores: anything a host puts in the
 * cache is disposable by definition, and anything that is not disposable
 * belongs in the queue.
 *
 * Every value is stored behind a {@link VersionedSpec}, so a shape written by
 * another build is a MISS rather than a bad render, and a miss makes the caller
 * refetch — which is the correct answer for a cache and the wrong one for the
 * queue.
 */
import type { FlushResult, OfflineQueue } from "./offline-queue";
import type { KeyValueStorage } from "./storage";
import {
  decodeVersioned,
  encodeVersioned,
  type VersionedSpec,
} from "./versioned-storage";

/** A cached value and when it was written, for a surface that says how stale it is. */
export type CachedRead<T> = { value: T; at: string };

export type LocalCache = {
  /** The last good answer under this key, or null when there is none this build can read. */
  read<T>(key: string, spec: VersionedSpec<T>): Promise<CachedRead<T> | null>;
  /** Remember an answer that just came back. */
  write<T>(key: string, spec: VersionedSpec<T>, value: T): Promise<void>;
  /** Forget one key, for a row the server has confirmed is gone. */
  drop(key: string): Promise<void>;
  /** Forget several keys at once — what a sign-out calls with everything it cached. */
  clear(keys: readonly string[]): Promise<void>;
};

/**
 * Read one stored row: `{ at, value }` inside the version envelope.
 *
 * `at` is informational — nothing branches on it — so a row that lost it still
 * reads, with an empty stamp. Throwing away a good answer because this build
 * cannot say when it was written would turn a working offline surface into an
 * empty one.
 */
const rowReader =
  <T>(read: (data: unknown) => T | null) =>
  (data: unknown): CachedRead<T> | null => {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    const row = data as { at?: unknown; value?: unknown };
    const value = read(row.value);
    if (value === null) return null;
    return { value, at: typeof row.at === "string" ? row.at : "" };
  };

/**
 * Lift a caller's spec for `T` into a spec for the stored `{ at, value }` row.
 *
 * The versions are the caller's own, so bumping a spec invalidates exactly its
 * own cached rows and nothing else. `legacy` is the one asymmetric case: a value
 * written before this envelope existed is a bare `T` with no stamp beside it, so
 * it is read by the caller's own legacy reader and given an empty one.
 */
const rowSpec = <T>(spec: VersionedSpec<T>): VersionedSpec<CachedRead<T>> => {
  const older: Record<number, (data: unknown) => CachedRead<T> | null> = {};
  for (const [version, read] of Object.entries(spec.older ?? {})) {
    older[Number(version)] = rowReader(read);
  }
  const legacy = spec.legacy;
  return {
    version: spec.version,
    decode: rowReader(spec.decode),
    legacy: (value) => {
      if (legacy === undefined) return null;
      const decoded = legacy(value);
      return decoded === null ? null : { value: decoded, at: "" };
    },
    older,
  };
};

/**
 * Bind a cache to a host's store.
 *
 * The prefix keeps every cached key in one namespace a sign-out can enumerate,
 * and keeps it out of the way of the queue and the credential, which live in
 * different stores for the reasons at the top of `storage.ts`.
 */
export const createLocalCache = ({
  storage,
  prefix = "starter.cache.",
}: {
  storage: KeyValueStorage;
  prefix?: string;
}): LocalCache => {
  const at = (key: string): string => `${prefix}${key}`;

  return {
    read: async <T>(
      key: string,
      spec: VersionedSpec<T>,
    ): Promise<CachedRead<T> | null> => {
      try {
        // A stale shape, a newer build's shape and outright garbage are all the
        // same answer here — null — because the caller's response to each is
        // identical: ask the server.
        return decodeVersioned(await storage.getItem(at(key)), rowSpec(spec));
      } catch {
        // Only the store itself can throw here; a store that cannot be read
        // must not take down a surface that was merely trying to paint faster.
        return null;
      }
    },

    write: async <T>(
      key: string,
      spec: VersionedSpec<T>,
      value: T,
    ): Promise<void> => {
      try {
        await storage.setItem(
          at(key),
          encodeVersioned(spec.version, {
            at: new Date().toISOString(),
            value,
          }),
        );
      } catch {
        /* store full or unavailable — reads still work, offline ones get less right */
      }
    },

    drop: async (key: string): Promise<void> => {
      try {
        await storage.removeItem(at(key));
      } catch {
        /* ignore: a key that cannot be removed is still only a cached copy */
      }
    },

    clear: async (keys: readonly string[]): Promise<void> => {
      // Sequential and individually guarded, so one key that refuses to be
      // removed cannot leave the rest of the last account's data on the device.
      for (const key of keys) {
        try {
          await storage.removeItem(at(key));
        } catch {
          /* ignore */
        }
      }
    },
  };
};

// ── the choke point ──────────────────────────────────────────────────

export type DrainOnReadOptions<T> = {
  /** Only `size` is used: how many rows are still waiting to be sent. */
  queue: Pick<OfflineQueue, "size">;
  /** Replay what is queued. Never rejects for a refused mutation; see below. */
  flush: () => Promise<FlushResult>;
  /** The live read. */
  read: () => Promise<T>;
  /** The cached answer, or null when this device has never had one. */
  fallback: () => Promise<T | null>;
  /**
   * A type test, not a string test: true only when no answer came back at all.
   * Everything the server answered — a 401, a 404, a validation refusal — is a
   * real answer and must reach the code that handles it.
   */
  isTransportFailure: (error: unknown) => boolean;
};

/**
 * Drain the queue, then read — the pattern for a host with NO long-lived
 * process.
 *
 * The queue drains from the READS, not from a background loop, because such a
 * host has no process to own one: a launcher extension is a new process per
 * command, a browser extension's service worker is woken and killed around each
 * message, and the phone build is suspended the moment it leaves the screen. So
 * the drain rides along with the work the person is already asking for.
 *
 * It happens BEFORE the read, so the answer comes back already carrying the
 * replayed work rather than showing the person their own change as still
 * pending. A surface that refreshes on an interval therefore drains on its own
 * refresh, and a revalidation the instant the sync feed connects is the earliest
 * and clearest proof available that the network is back — earlier than any
 * poll, and unambiguous in a way that a successful request to one endpoint is
 * not.
 *
 * The fallback is taken on a TRANSPORT failure only. A failed read is not an
 * error the person has to act on — a surface that renders yesterday's list is
 * strictly better than one that renders a red banner — but a 401 is a real
 * answer and has to reach the sign-in handling, never be papered over with a
 * cached page.
 */
export const drainThenRead = async <T>(
  options: DrainOnReadOptions<T>,
): Promise<{ value: T | null; fromCache: boolean; flush: FlushResult | null }> => {
  let flushed: FlushResult | null = null;
  try {
    // Asking first keeps a read on an empty queue from paying for a replay pass
    // it has no work for; a queue that cannot even be counted is treated as
    // non-empty by `writingThroughQueue`, but a READ is safe either way — order
    // only matters for what is sent.
    if ((await options.queue.size()) > 0) {
      flushed = await options.flush();
    }
  } catch {
    // A drain that throws is a storage failure, not a refused mutation: the
    // queue folds every server and transport error into its result. The read
    // still happens — the person asked for it, and the rows are still there.
    flushed = null;
  }

  try {
    return { value: await options.read(), fromCache: false, flush: flushed };
  } catch (error) {
    if (!options.isTransportFailure(error)) throw error;
    // `fromCache` is true even when the fallback comes back null: it says the
    // answer did not come from the server, which is what a surface needs to
    // decide whether to show a stale marker or an empty state.
    return { value: await options.fallback(), fromCache: true, flush: flushed };
  }
};

/**
 * Send a mutation, or queue it — the WRITE side of the same choke point.
 *
 * Writes DRAIN FIRST and then QUEUE if anything is still waiting, because
 * sending a new mutation ahead of older queued ones lands it out of order: a
 * delete arriving before the create it removes, an edit before the row it
 * edits. A mutation that resolves against "whatever the current state is" is the
 * worst case, since it resolves against whatever it finds at the moment it
 * arrives rather than the state the person was looking at. So a non-empty queue
 * routes even a perfectly online mutation into the queue, where the order is
 * kept.
 *
 * A drain that throws means this device no longer knows the queue is empty, so
 * the safe reading is "something may be waiting" and the new mutation goes
 * behind it. Sending it live on a guess is what breaks the ordering.
 *
 * And the rule that makes any of this work: **one API choke point per host.**
 * Every surface goes through the same wrappers, so the offline path lives inside
 * them rather than in each call site. A single call site that bypasses it is a
 * mutation that vanishes with no signal — no error, no queued row, nothing to
 * retry.
 */
export const writingThroughQueue = async <T>(options: {
  flush: () => Promise<FlushResult>;
  /** How many rows are still waiting after the drain. */
  pending: () => Promise<number>;
  send: () => Promise<T>;
  /** Write the mutation to the queue instead, with its optimistic consequence. */
  queue: () => Promise<void>;
  isTransportFailure: (error: unknown) => boolean;
}): Promise<{ sent: boolean }> => {
  let waiting: number;
  try {
    await options.flush();
    waiting = await options.pending();
  } catch {
    waiting = 1;
  }
  if (waiting > 0) {
    await options.queue();
    return { sent: false };
  }

  try {
    await options.send();
    return { sent: true };
  } catch (error) {
    // Same asymmetry as the read side, for the opposite reason: no answer came
    // back, so the mutation may or may not have been applied and the queue is
    // where it waits. An answer that refused it must NOT be queued — replaying
    // it would only be refused again, forever.
    if (!options.isTransportFailure(error)) throw error;
    await options.queue();
    return { sent: false };
  }
};
