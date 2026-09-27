/**
 * The one place this extension talks to the server.
 *
 * ============================================================
 * ONE CHOKE POINT, AND WHY IT IS NOT NEGOTIABLE
 * ============================================================
 *
 * Every surface goes through the functions below, so the offline path lives
 * inside them rather than at each call site. A single command that built its
 * own `createApiClient` and called it directly would be a mutation that
 * vanishes when the network is down: no error, no queued row, nothing to
 * retry. The same goes for the state echo — written here, so the next command
 * somebody adds cannot forget it.
 *
 * ============================================================
 * WHAT IS BOUND HERE AND WHAT IS ALREADY WRITTEN
 * ============================================================
 *
 * The drain-before-read rule, the queue-behind-writes rule, the replay
 * classifier, the temp-id chain and the permanent-rejection set all come from
 * the shared client core through the vendored barrel. Nothing here decides any
 * of them. `drainThenRead` and `writingThroughQueue` ARE the rules; this module
 * supplies the four seams they ask for (read, fallback, send, queue) and the
 * Raycast-specific storage underneath.
 *
 * The queue drains FROM THE READS, never from a background loop, because
 * Raycast has no long-lived process to own one — each command is its own
 * process, and a `setInterval` dies with it.
 */
import {
  type FlushResult,
  type Item,
  type OfflineMutation,
  type OfflineOverlay,
  type OfflineReplayMutators,
  type QueuedMutation,
  type ReplayIdMap,
  ApiError,
  applyOverlay,
  classifyReplayOutcome,
  createApiClient,
  createTempId,
  decodeOfflineMutation,
  deviceTimeZone,
  drainThenRead,
  flushVerdictFor,
  holdBlocksReplay,
  isQueuedOn,
  isReplayableBy,
  isTransportFailure,
  replayOfflineMutation,
  tempIdOf,
  withOptimisticItem,
  withOptimisticPatch,
  withOptimisticRemoval,
  withoutResolved,
  writingThroughQueue,
} from "../vendor";
import { loadSession, originId } from "./auth";
import { capabilityCache } from "./capabilities";
import { CLIENT_ID } from "./client-id";
import { apiOrigin } from "./preferences";
import {
  ITEMS_CACHE_KEY,
  ITEMS_CACHE_SPEC,
  localCache,
  offlineQueue,
  readOverlay,
  writeOverlay,
} from "./queue";
import { writeStateEcho } from "./storage";
import { EXTENSION_VERSION } from "./version";

/** Raised before a request exists, so it is not a transport failure. */
export class NotPairedError extends Error {
  constructor() {
    super("This extension is not paired with the server yet.");
    this.name = "NotPairedError";
  }
}

/**
 * A caller's own errors are excluded from the transport test.
 *
 * `isTransportFailure` is "not an `ApiError`", which is exactly right for an
 * error that came back from a request — but {@link NotPairedError} is raised
 * before one is made, and treating it as "no answer came back" would queue a
 * mutation nobody can ever replay and fall back to a cache that is empty
 * anyway.
 */
const transportFailed = (error: unknown): boolean =>
  !(error instanceof NotPairedError) && isTransportFailure(error);

/** The authenticated caller, or `NotPairedError` when there is no credential. */
async function client() {
  const session = await loadSession();
  if (session === null) throw new NotPairedError();
  return createApiClient({
    baseUrl: apiOrigin(),
    token: session.token,
    clientId: CLIENT_ID,
    clientVersion: EXTENSION_VERSION,
  });
}

/* ================================================================== */
/* Flush                                                              */
/* ================================================================== */

/** What a flush pass came to, plus the ids it resolved for the overlay. */
export type FlushSummary = FlushResult & { resolved: number };

/**
 * Replay what is queued, in order, against the configured origin.
 *
 * `retryHeld` is for the first flush of a command: a held row waits an hour
 * between attempts otherwise, and a command start is the moment a server
 * upgrade is most likely to have happened unobserved.
 */
export async function flushQueue(options: { retryHeld?: boolean } = {}): Promise<FlushSummary> {
  const session = await loadSession();
  const origin = apiOrigin();
  const owner = session?.userId ?? null;
  const queue = offlineQueue();

  if (session === null) {
    // Nobody may replay anything while signed out — a row carries an owner and
    // this process cannot say whether it is theirs.
    const remaining = await queue.size();
    return { flushed: 0, remaining, skipped: remaining, held: 0, resolved: 0 };
  }

  const api = await client();
  const levels = await capabilityCache();
  const serverApiLevel = levels.apiLevel(origin);
  const resolved: ReplayIdMap = new Map();
  /** The id of the last row the server confirmed in this flush, for the echo. */
  let lastTouched: string | null = null;

  const mutators: OfflineReplayMutators = {
    "items.create": (input) => api.mutate<Item>("items.create", input),
    "items.update": (input) => api.mutate<Item>("items.update", input),
    // The op is `items.remove` and the procedure is `items.delete`. The op
    // names are the shared offline contract and are the same on every client;
    // the procedure name is this server's. Mapping them here is the only place
    // the two have to agree.
    "items.remove": (input) => api.mutate<{ success: boolean }>("items.delete", input),
  };

  const result = await queue.flush(
    async (row: QueuedMutation) => {
      const decoded = decodeOfflineMutation(row);
      // A row this build cannot read is held, never dropped: a newer build
      // wrote it, and it is somebody's work.
      if (decoded === null) return { hold: "unknown-op" as const };
      try {
        await replayOfflineMutation(mutators, decoded, { createdAt: row.createdAt, resolved });
        // The server has now confirmed this row, so it is the newest thing
        // this session touched. Recorded here rather than after the flush,
        // because only here is it known WHICH row landed last — a create's
        // real id exists for the first time in `resolved`, and an update or a
        // remove already carries one.
        lastTouched = touchedIdOf(decoded, resolved) ?? lastTouched;
        return;
      } catch (error) {
        const outcome = await classifyReplayOutcome(error, row, { serverApiLevel });
        return flushVerdictFor(outcome, error);
      }
    },
    {
      filter: (row) =>
        isReplayableBy(row, owner) &&
        isQueuedOn(row, origin, origin) &&
        !holdBlocksReplay(row, { retryHeld: options.retryHeld, serverApiLevel }),
      // A create and the edits to the item it invented stand or fall together:
      // an update replayed without its create names an id the server has never
      // seen.
      chainOf: tempIdOf,
    },
  );

  if (resolved.size > 0) {
    // The optimistic copies of rows that have now landed are dropped; the
    // server's answer is the truth from here on.
    await writeOverlay(withoutResolved(await readOverlay(), resolved));
  }
  if (lastTouched !== null) {
    await writeStateEcho({ id: lastTouched, at: new Date().toISOString() });
  }
  return { ...result, resolved: resolved.size };
}

/**
 * The real id a replayed row touched, or null when this build cannot say.
 *
 * A create's id only exists once the server has answered, and it is in
 * `resolved` under the temp id the row was queued with. An update or a remove
 * already names an id — unless that id is itself a temp id, in which case the
 * create that minted the real one landed earlier in this same flush.
 *
 * Null rather than a guess: an echo naming an id no surface can find reads as
 * "nothing is current", which is wrong but harmless, while an echo naming the
 * WRONG id puts somebody else's row in the menu bar as the thing you are
 * working on.
 */
function touchedIdOf(mutation: OfflineMutation, resolved: ReplayIdMap): string | null {
  if (mutation.op === "items.create") {
    const tempId = mutation.tempId;
    return tempId === undefined ? null : (resolved.get(tempId) ?? null);
  }
  const { id } = mutation.input;
  if (!idIsTemp(id)) return id;
  return resolved.get(id) ?? (mutation.tempId ? (resolved.get(mutation.tempId) ?? null) : null);
}

/**
 * Claim every queued row that predates having an account.
 *
 * **Called BEFORE a flush, never after.** The flush filter refuses a row it
 * cannot attribute (`isReplayableBy` says no for an unowned row when nobody is
 * signed in, and a row owned by somebody else is never this account's), so the
 * rows that pairing exists to rescue — the ones written before there was an
 * account to stamp them with — are exactly the ones a flush-first order
 * strands. They would sit in the queue counted as somebody else's forever.
 *
 * The server stamp is claimed at the same time and for the same reason: a row
 * written before the extension was pointed anywhere belongs to the origin it
 * was written against, which is the one in use now.
 */
export async function claimQueuedWork(owner: string, server: string): Promise<number> {
  const queue = offlineQueue();
  const owned = await queue.adoptUnowned(owner);
  const served = await queue.adoptUnserved(server);
  return Math.max(owned, served);
}

/* ================================================================== */
/* Reads                                                              */
/* ================================================================== */

export type ItemsRead = {
  items: Item[];
  /** True when the answer did not come from the server. */
  fromCache: boolean;
  /** ISO instant this answer was fetched, for the echo's reconciliation. */
  fetchedAt: string | null;
  flush: FlushResult | null;
};

/**
 * The item list, with this device's unsent work applied over it.
 *
 * Drain first, then read, so the answer already carries the replayed work
 * rather than showing the person their own change as still pending. The
 * fallback is taken on a TRANSPORT failure only: a 401 is a real answer and has
 * to reach the pairing handling, never be papered over with a cached page.
 */
export async function readItems(limit = 50): Promise<ItemsRead> {
  const queue = offlineQueue();
  const cache = localCache();
  let fetchedAt: string | null = null;

  const outcome = await drainThenRead<Item[]>({
    queue,
    flush: () => flushQueue({ retryHeld: true }),
    read: async () => {
      const api = await client();
      const page = await api.query<{ items: Item[] }>("items.list", { limit });
      fetchedAt = new Date().toISOString();
      await cache.write(ITEMS_CACHE_KEY, ITEMS_CACHE_SPEC, page.items);
      return page.items;
    },
    fallback: async () => {
      const cached = await cache.read(ITEMS_CACHE_KEY, ITEMS_CACHE_SPEC);
      if (cached === null) return null;
      fetchedAt = cached.at === "" ? null : cached.at;
      return cached.value;
    },
    isTransportFailure: transportFailed,
  });

  const overlay = await readOverlay();
  return {
    items: applyOverlay(outcome.value ?? [], overlay),
    fromCache: outcome.fromCache,
    fetchedAt,
    flush: outcome.flush,
  };
}

/* ================================================================== */
/* Writes                                                             */
/* ================================================================== */

/** What a write came to, for a surface that has to say which happened. */
export type WriteOutcome = { sent: boolean; id: string };

/**
 * Create an item, or queue it.
 *
 * `writingThroughQueue` drains first and routes even a perfectly online write
 * into the queue when anything is still waiting, because sending a new mutation
 * ahead of older queued ones lands it out of order.
 */
export async function createItem(input: {
  title: string;
  description?: string;
}): Promise<WriteOutcome> {
  const tempId = createTempId();
  const session = await loadSession();
  const origin = apiOrigin();
  const who = await originId();
  const createdAt = new Date().toISOString();
  let landedId = tempId;

  await writingThroughQueue({
    flush: () => flushQueue(),
    pending: () => offlineQueue().size(),
    send: async () => {
      const api = await client();
      const item = await api.mutate<Item>("items.create", input);
      landedId = item.id;
      // The echo is written the instant the SERVER confirms, from here and
      // nowhere else.
      await writeStateEcho({ id: item.id, at: new Date().toISOString() });
      await bumpCachedItem(item);
    },
    queue: async () => {
      await offlineQueue().enqueue(
        "items.create",
        {
          input: {
            ...input,
            status: "draft",
            createdAt,
            // The zone the work was recorded in, replayed unchanged, so a
            // queued row keeps the zone it was made in rather than the zone it
            // syncs from.
            timeZone: deviceTimeZone(),
            originId: who,
          },
          tempId,
        },
        session?.userId ?? undefined,
        origin,
      );
      await writeOverlay(
        withOptimisticItem(await readOverlay(), {
          id: tempId,
          title: input.title,
          description: input.description,
          status: "draft",
          ownerId: session?.userId ?? "",
          createdAt,
          updatedAt: createdAt,
        }),
      );
    },
    isTransportFailure: transportFailed,
  });

  return { sent: landedId !== tempId, id: landedId };
}

/** Edit an item, or queue the edit. */
export async function updateItem(input: {
  id: string;
  title?: string;
  description?: string;
  status?: Item["status"];
}): Promise<WriteOutcome> {
  const session = await loadSession();
  const origin = apiOrigin();
  const who = await originId();

  await writingThroughQueue({
    flush: () => flushQueue(),
    pending: () => offlineQueue().size(),
    send: async () => {
      const api = await client();
      const item = await api.mutate<Item>("items.update", input);
      await writeStateEcho({ id: item.id, at: new Date().toISOString() });
      await bumpCachedItem(item);
    },
    queue: async () => {
      await offlineQueue().enqueue(
        "items.update",
        // A row addressing an item this device invented and has not synced
        // rides that item's temp id, which is what lets the replay target the
        // item the create produces.
        { input: { ...input, originId: who }, tempId: idIsTemp(input.id) ? input.id : undefined },
        session?.userId ?? undefined,
        origin,
      );
      const { id, ...patch } = input;
      await writeOverlay(withOptimisticPatch(await readOverlay(), id, patch));
    },
    isTransportFailure: transportFailed,
  });

  return { sent: true, id: input.id };
}

/** Delete an item, or queue the deletion. */
export async function removeItem(id: string): Promise<WriteOutcome> {
  const session = await loadSession();
  const origin = apiOrigin();
  const who = await originId();

  await writingThroughQueue({
    flush: () => flushQueue(),
    pending: () => offlineQueue().size(),
    send: async () => {
      const api = await client();
      await api.mutate<{ success: boolean }>("items.delete", { id });
      await writeStateEcho({ id, at: new Date().toISOString() });
      await dropCachedItem(id);
    },
    queue: async () => {
      await offlineQueue().enqueue(
        "items.remove",
        { input: { id, originId: who }, tempId: idIsTemp(id) ? id : undefined },
        session?.userId ?? undefined,
        origin,
      );
      await writeOverlay(withOptimisticRemoval(await readOverlay(), id));
    },
    isTransportFailure: transportFailed,
  });

  return { sent: true, id };
}

const idIsTemp = (id: string): boolean => id.startsWith("temp-");

/** Keep the read cache in step with a confirmed write. */
async function bumpCachedItem(item: Item): Promise<void> {
  const cache = localCache();
  const cached = await cache.read(ITEMS_CACHE_KEY, ITEMS_CACHE_SPEC);
  const rows = cached?.value ?? [];
  await cache.write(ITEMS_CACHE_KEY, ITEMS_CACHE_SPEC, [
    item,
    ...rows.filter((row) => row.id !== item.id),
  ]);
}

async function dropCachedItem(id: string): Promise<void> {
  const cache = localCache();
  const cached = await cache.read(ITEMS_CACHE_KEY, ITEMS_CACHE_SPEC);
  if (cached === null) return;
  await cache.write(
    ITEMS_CACHE_KEY,
    ITEMS_CACHE_SPEC,
    cached.value.filter((row) => row.id !== id),
  );
}

/* ================================================================== */
/* Saying what went wrong                                             */
/* ================================================================== */

/**
 * One sentence a surface can show, naming what to change.
 *
 * A person reading a launcher's toast cannot open a console, so "Request
 * failed" is not an answer. Each case names the thing that is wrong and where
 * it is set.
 */
export function describeFailure(error: unknown, origin = apiOrigin()): string {
  if (error instanceof NotPairedError) {
    return "Not paired with the server yet. Run a command and choose Pair with the web app.";
  }
  if (error instanceof ApiError) {
    if (error.httpStatus === 401) {
      return `${origin} no longer accepts this session. Pair again from any command's empty state.`;
    }
    if (error.versionRefusal !== null) {
      return `${origin} does not serve this version of the extension any more. Update it from the Raycast Store.`;
    }
    if (error.httpStatus === 403) {
      return "The server refused this change. Your account may no longer have access to it.";
    }
    if (error.httpStatus === 404) {
      return "That item is gone on the server.";
    }
    return error.message;
  }
  // No answer came back at all: unreachable host, refused connection, bad DNS
  // and a laptop on a plane are indistinguishable here, and all mean the same
  // thing for a queue.
  return `Could not reach ${origin}. Your work is queued and will be sent when it answers.`;
}

/** The overlay, for a surface that wants to count unsent work itself. */
export async function currentOverlay(): Promise<OfflineOverlay> {
  return readOverlay();
}
