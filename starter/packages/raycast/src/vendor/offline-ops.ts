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
 * The op/payload contract for item mutations that were queued offline.
 *
 * `offline-queue.ts` stores opaque rows; this module is what gives those rows
 * meaning. It lives in core rather than the web client because every client
 * that can mutate items — the web app, a browser extension's service worker, a
 * launcher extension, the phone build — must agree on the op names and payload
 * shapes, or one of them writes rows another cannot replay. Everything here is
 * pure: no window, no React, no tRPC. The replay runner that actually calls the
 * API stays with whichever client owns the API binding.
 */

import { createId } from "./ids";
import type { HoldReason, QueuedMutation } from "./offline-queue";
import type { ItemStatus } from "./types";

export const OFFLINE_QUEUE_STORAGE_KEY = "starter.offline-queue";

/**
 * Where the last account to own the queue is remembered.
 *
 * Beside the queue, in the same store and with the same durability, because
 * it is what a row is stamped with when a mutation is made before the session
 * has resolved — a cold offline launch on a phone, which is the launch the
 * queue exists for. Losing it would put those rows back to unowned, i.e.
 * claimable by the next account to sign in.
 *
 * It is an id, not a credential: the token lives in the keychain, this lives
 * beside the data it describes.
 */
export const OFFLINE_QUEUE_OWNER_STORAGE_KEY = "starter.offline-queue-owner";

/** Items invented client-side carry this prefix until the server replies. */
export const TEMP_ID_PREFIX = "temp-";

/** Id for an item that exists only in the cache and the offline queue. */
export const createTempId = (): string => `${TEMP_ID_PREFIX}${createId()}`;

export const isTempId = (id: string): boolean => id.startsWith(TEMP_ID_PREFIX);

// ── payloads ─────────────────────────────────────────────────────────

/**
 * The optional fields on these payloads are optional on purpose, and the
 * asymmetry is the contract: rows written by a build that predates a field
 * decode without it, and replaying one must not fail. The server reads an
 * absent `description` or `status` as "the default" on create and as "leave it
 * alone" on update — exactly what those old rows meant when they were written.
 * On update, `description: null` is the way to clear one, which is a different
 * statement from leaving the field out.
 */
export type OfflineCreateInput = {
  title: string;
  description?: string;
  status?: ItemStatus;
  createdAt: string;
  /** IANA zone this was recorded in. Replayed unchanged, so a queued item
   *  keeps the zone it was created in rather than the zone it syncs from. */
  timeZone: string;
  originId: string;
};

export type OfflineUpdateInput = {
  id: string;
  title?: string;
  /** Absent leaves the description alone; `null` clears it. */
  description?: string | null;
  status?: ItemStatus;
  originId: string;
};

export type OfflineIdInput = {
  id: string;
  originId: string;
};

export type OfflinePayloadMap = {
  "items.create": OfflineCreateInput;
  "items.update": OfflineUpdateInput;
  "items.remove": OfflineIdInput;
};

export type OfflineOp = keyof OfflinePayloadMap;

/**
 * The op names as values, for the runtime membership test below. Typed as
 * `readonly string[]` rather than `readonly OfflineOp[]` so `isOfflineOp` can
 * narrow an arbitrary stored string — a row's `op` is whatever some build
 * wrote, not something this build's types can promise.
 */
export const OFFLINE_OPS: readonly string[] = [
  "items.create",
  "items.update",
  "items.remove",
];

export const isOfflineOp = (value: string): value is OfflineOp =>
  OFFLINE_OPS.includes(value);

/** A queued mutation, narrowed back to its typed input. */
export type OfflineMutation = {
  [K in OfflineOp]: {
    /** Queue row id, not the item id. */
    queueId: string;
    op: K;
    input: OfflinePayloadMap[K];
    /**
     * Temp id of the item this mutation invented, or of the not-yet-synced
     * item it addresses. A create invents one; an update or remove against
     * that same unsynced item rides the same value, which is what lets the
     * replay target the item the create produces.
     */
    tempId?: string;
    /**
     * The tenant the row was queued in (`QueuedMutation.tenantId`). Present
     * only when the row carries a stamp, so a decoded legacy row has exactly
     * the shape it always had.
     */
    tenantId?: string;
    /**
     * The API level of the build that queued the row
     * (`QueuedMutation.apiLevel`). Present only when the row carries one.
     */
    apiLevel?: number;
  };
}[OfflineOp];

/** The envelope an offline enqueue writes into a queue row's payload. */
export type StoredOfflinePayload = { input: unknown; tempId?: string };

const readStored = (payload: unknown): StoredOfflinePayload | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as { input?: unknown; tempId?: unknown };
  if (typeof record.input !== "object" || record.input === null) return null;
  return {
    input: record.input,
    tempId: typeof record.tempId === "string" ? record.tempId : undefined,
  };
};

/**
 * Narrow a raw queue row back into a typed mutation. Returns null for a row
 * this build cannot read — an op a newer build added, or a payload in a shape
 * it does not know. Such a row is never replayed blind, and never dropped
 * either: it is held `unknown-op` (`holdReasonOf`) until a build that can read
 * it runs, or a person discards it.
 */
export const decodeOfflineMutation = (
  mutation: QueuedMutation
): OfflineMutation | null => {
  if (!isOfflineOp(mutation.op)) return null;
  const stored = readStored(mutation.payload);
  if (stored === null) return null;

  const decoded = decodeOp(mutation.id, mutation.op, stored);
  const inTenant =
    mutation.tenantId === undefined
      ? decoded
      : { ...decoded, tenantId: mutation.tenantId };
  return mutation.apiLevel === undefined
    ? inTenant
    : { ...inTenant, apiLevel: mutation.apiLevel };
};

const decodeOp = (
  queueId: string,
  op: OfflineOp,
  stored: StoredOfflinePayload
): OfflineMutation => {
  const tempId = stored.tempId;

  switch (op) {
    case "items.create":
      return {
        queueId,
        tempId,
        op: "items.create",
        input: stored.input as OfflineCreateInput,
      };
    case "items.update":
      return {
        queueId,
        tempId,
        op: "items.update",
        input: stored.input as OfflineUpdateInput,
      };
    case "items.remove":
      return {
        queueId,
        tempId,
        op: "items.remove",
        input: stored.input as OfflineIdInput,
      };
  }
};

// ── held rows ────────────────────────────────────────────────────────

/**
 * How long a hold that can end on the server's side waits before a flush asks
 * again. A self-hosted server is upgraded on its admin's schedule, not ours,
 * and asking on every flush would send the same doomed request on every
 * socket reconnect.
 */
export const HELD_RETRY_MS = 60 * 60 * 1000;

/**
 * When each hold may end. A new reason must pick one — the `Record` makes
 * forgetting a type error.
 *
 * - `new-build`: nothing this build can do ends it. Never replayed here.
 * - `server`: the server may change. Asked again after `HELD_RETRY_MS`, or
 *   sooner when the caller says so (a launch, a resume).
 */
export const HOLD_RELEASE: Readonly<Record<HoldReason, "new-build" | "server">> = {
  "unknown-op": "new-build",
  "unknown-procedure": "server",
  "server-too-old": "server",
};

/**
 * The temp id a row's payload carries, read without decoding — so a row this
 * build cannot read still chains to the rows that depend on it.
 */
export const tempIdOf = (row: Pick<QueuedMutation, "payload">): string | undefined => {
  if (typeof row.payload !== "object" || row.payload === null) return undefined;
  const { tempId } = row.payload as { tempId?: unknown };
  return typeof tempId === "string" && tempId.length > 0 ? tempId : undefined;
};

/** Why this row on its own is held, or null. Chains are `heldReasons`. */
export const holdReasonOf = (row: QueuedMutation): HoldReason | null => {
  if (row.hold?.reason === "unknown-op") return "unknown-op";
  // Recomputed rather than read from the row: this is a fact about the build
  // doing the reading, so a newer build that can decode the row releases it.
  if (decodeOfflineMutation(row) === null) return "unknown-op";
  return row.hold?.reason ?? null;
};

/**
 * True when a flush must not send `row` now.
 *
 * `retryHeld` asks again whatever the clock says — for the first flush after a
 * launch or a resume, the moments a server upgrade is most likely to have
 * happened unobserved.
 */
export const holdBlocksReplay = (
  row: QueuedMutation,
  options: {
    now?: number;
    retryHeld?: boolean;
    /**
     * The server's API level, when the client knows it. A `server-too-old`
     * hold is then decided by the level alone — released the moment the
     * server reports enough, kept while it does not, whatever the clock says.
     */
    serverApiLevel?: number | null;
  } = {}
): boolean => {
  const reason = holdReasonOf(row);
  if (reason === null) return false;
  if (HOLD_RELEASE[reason] === "new-build") return true;
  if (
    reason === "server-too-old" &&
    options.serverApiLevel !== undefined &&
    options.serverApiLevel !== null
  ) {
    return row.apiLevel !== undefined && options.serverApiLevel < row.apiLevel;
  }
  if (options.retryHeld === true) return false;
  const at = Date.parse(row.hold?.at ?? "");
  if (Number.isNaN(at)) return false;
  return (options.now ?? Date.now()) - at < HELD_RETRY_MS;
};

/**
 * Every held row in `rows` and why, following temp-id chains in queue order:
 * an update whose create is held is held with it, for the create's reason,
 * because replaying it alone would address an item the server has never seen
 * — or, once the id has been reused, the wrong one.
 *
 * `rows` should be the rows one account may send; another account's chain is
 * its own business.
 */
export const heldReasons = (
  rows: readonly QueuedMutation[]
): Map<string, HoldReason> => {
  const held = new Map<string, HoldReason>();
  const chains = new Map<string, HoldReason>();
  for (const row of rows) {
    const link = tempIdOf(row);
    const reason =
      holdReasonOf(row) ?? (link === undefined ? null : chains.get(link) ?? null);
    if (reason === null) continue;
    held.set(row.id, reason);
    if (link !== undefined && !chains.has(link)) chains.set(link, reason);
  }
  return held;
};

// ── describing a row ─────────────────────────────────────────────────

/**
 * A queued row as something a person can recognise.
 *
 * Needed wherever a client offers to destroy queued work: rows another account
 * left behind are kept and never replayed, which on its own makes them
 * immortal, and a permanent count nobody can act on is a scold. The way out
 * has to name what it is destroying — deleting "3 changes" is not a decision
 * anybody can make, and deleting two items called "Invoicing" from 21 Aug is.
 * Shared so every surface describes the same row the same way, which is what
 * keeps two of them from asking a person to approve two different deletions.
 */
export type QueuedMutationSummary = {
  queueId: string;
  /** Null when the row was written by a build whose ops we no longer know. */
  op: OfflineOp | null;
  description: string | null;
  /** When the work happened — the payload's own `createdAt`, else the row's. */
  at: string;
  /** The server origin it was queued against, when the row says. */
  server: string | null;
  /** The tenant it was queued in, when the row says. */
  tenantId: string | null;
  /**
   * That tenant's name, when the caller's lookup knows it. Null for an
   * unstamped row, and for a tenant the person has left — which is the case a
   * client names differently ("a tenant you left"), so the two are never
   * collapsed into a guessed name.
   */
  tenantName: string | null;
  /**
   * Why the row is held, when it is — the row's own reason only. A client
   * listing a chain passes the chain's reason through `heldReasons`.
   */
  hold: HoldReason | null;
};

/** Tenant id → name, for the tenants the caller still knows about. */
export type TenantNameLookup = (tenantId: string) => string | null;

export const describeQueuedMutation = (
  row: QueuedMutation,
  tenantName?: TenantNameLookup
): QueuedMutationSummary => {
  const tenantId = row.tenantId ?? null;
  const tenant = {
    tenantId,
    tenantName:
      tenantId === null || tenantName === undefined ? null : tenantName(tenantId),
  };
  const decoded = decodeOfflineMutation(row);
  const hold = holdReasonOf(row);
  if (decoded === null) {
    return {
      queueId: row.id,
      op: null,
      description: null,
      at: row.createdAt,
      server: row.server ?? null,
      ...tenant,
      hold,
    };
  }
  // Read off the payload rather than the union: only a create carries a title
  // and a `createdAt`, and a summary of an update has to say something too.
  const input = decoded.input as { title?: string; createdAt?: string };
  return {
    queueId: row.id,
    op: decoded.op,
    description: typeof input.title === "string" ? input.title : null,
    at: typeof input.createdAt === "string" ? input.createdAt : row.createdAt,
    server: row.server ?? null,
    ...tenant,
    hold,
  };
};
