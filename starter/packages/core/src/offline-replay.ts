/**
 * How a decoded queue row is turned back into a real API call, what has to be
 * repaired once it lands, and — the point of the file — what a failed replay
 * means.
 *
 * Shared rather than client-local for two reasons. The repair is identical
 * everywhere a queue is replayed: a create's temp id has to be renamed to the
 * id the server minted, and an update or remove whose temp id was never renamed
 * has to be refused rather than guessed at. And the classification has to be
 * identical too — `classifyReplayOutcome` is THE single classifier, so a 404
 * means the same thing in the web app, in a browser extension's service worker,
 * in a launcher extension and on the phone. Every host supplies only its own
 * transport test and its own membership re-check; `holdRefusal` is the seam for
 * a hold that depends on the row rather than on the error. Getting any of this
 * wrong in one client corrupts items the other clients then have to look at.
 *
 * Nothing here binds an API: the caller supplies one call per op, so one host
 * can pass tRPC mutations and another its bearer client.
 *
 * Note on 412: a version refusal (the server rejecting this build's declared
 * API level) is deliberately NOT in the permanent set, so a row refused that
 * way is kept for the build that can send it rather than deleted for being
 * ahead of its server.
 */
import { isTempId } from "./offline-ops.js";
import type {
  OfflineMutation,
  OfflineOp,
  OfflinePayloadMap,
} from "./offline-ops.js";
import {
  ApiError,
  isPermanentRejectionStatus,
  isTransportFailure,
} from "./api-client.js";
import type { FlushVerdict, HoldReason } from "./offline-queue.js";
import type { Item } from "@starter/shared";

/**
 * What a replayed call is handed: the queued input, plus the tenant the row was
 * queued in when it carries one.
 */
export type ReplayInput<K extends OfflineOp> = OfflinePayloadMap[K] & {
  tenantId?: string;
};

/** One call per queued op. The caller binds these to its own API. */
export type OfflineReplayMutators = {
  [K in OfflineOp]: (input: ReplayInput<K>) => Promise<unknown>;
};

/**
 * `input` addressed to the tenant the row was queued in.
 *
 * Explicit, and set over anything already there, because every client also
 * injects its CURRENT tenant into requests that name none (a tRPC link, an api
 * client's `tenantId` getter). Those injections only fill a gap; a row that says
 * where it was made must never leave one for them to fill — that gap is exactly
 * how a row queued in tenant A would land in B after a switch. An unstamped
 * (legacy) row is sent as it always was.
 */
const inTenant = <K extends OfflineOp>(
  mutation: { tenantId?: string },
  input: OfflinePayloadMap[K]
): ReplayInput<K> =>
  mutation.tenantId === undefined
    ? input
    : { ...input, tenantId: mutation.tenantId };

/**
 * An update or remove whose temp id was never resolved to a real one.
 *
 * The row names an item the server has never seen, because the `items.create`
 * that would have minted its id is not in this flush — it was held, filtered,
 * dropped, or it failed and took the flush's ordering with it. Sending the row
 * anyway has two outcomes and both are wrong: the server refuses an id it does
 * not know, or (once ids are reused or the client strips the prefix) it applies
 * the change to a completely different row.
 *
 * Thrown rather than returned so it travels the same path as a server refusal:
 * the row is dropped, and the caller tells the user rather than silently
 * editing or deleting something else.
 */
export class UnresolvedTempIdError extends Error {
  readonly tempId: string;
  readonly queuedAt: string;

  constructor(tempId: string, queuedAt: string) {
    super(`Queued mutation names an unsynced item (${tempId})`);
    this.name = "UnresolvedTempIdError";
    this.tempId = tempId;
    this.queuedAt = queuedAt;
  }
}

/**
 * Temp id → the real id its `items.create` was given on replay.
 *
 * Held for the length of one flush. A create and the update that edits the item
 * it invented are queued as a chain, and the chain only becomes targetable once
 * the create has actually landed — which is a few milliseconds earlier, in the
 * same loop.
 */
export type ReplayIdMap = Map<string, string>;

/** The id of the item a replayed create produced, read defensively. */
const replayedId = (result: unknown): string | null => {
  if (typeof result !== "object" || result === null) return null;
  const { id } = result as Partial<Pick<Item, "id">>;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/** What one replay needs to know beyond the mutation itself. */
export type ReplayContext = {
  /** When the row was queued — `QueuedMutation.createdAt`, for the refusal. */
  createdAt: string;
  /** Temp ids this flush has already resolved, shared across its rows. */
  resolved: ReplayIdMap;
  /**
   * Called when a create's temp id becomes a real one.
   *
   * Anything a host claimed against the temp id — an open editor, a pending
   * upload, a notification, a selection — has to be renamed, and it can only be
   * renamed here: the temp id is the only id that item ever had, and the real
   * one exists for the first time in this call. A host that has nothing claimed
   * against temp ids leaves this out.
   *
   * Optional, and a seam rather than a concrete dependency, because what is
   * claimed differs per host and core must not know about any of it.
   */
  onTempIdResolved?: (tempId: string, realId: string) => void;
};

/**
 * Give an update or remove the item it means, when that is knowable.
 *
 * A row is enqueued with a real `id` whenever the item it addresses already had
 * one. It carries a temp id only for an item that was itself created offline,
 * whose id at that moment is one the server has never seen — and the replayed
 * create is what mints the real one, just above in the same flush.
 */
const targetedId = (
  input: { id: string },
  tempId: string | undefined,
  resolved: ReplayIdMap,
  queuedAt: string
): string => {
  if (!isTempId(input.id)) return input.id;
  // Either key can carry the rename: the row's own `id` is the temp id in the
  // common case, and `tempId` is what a host stamped the chain with.
  const realId = resolved.get(input.id) ?? (tempId ? resolved.get(tempId) : undefined);
  if (realId !== undefined) return realId;
  throw new UnresolvedTempIdError(input.id, queuedAt);
};

/**
 * Replay one queued mutation against the server.
 *
 * Rejections are the caller's problem — a flush classifies them into "still
 * offline, keep the queue in order" and "the server refused it, drop it" — so
 * nothing is caught here.
 */
export const replayOfflineMutation = async (
  mutators: OfflineReplayMutators,
  mutation: OfflineMutation,
  context: ReplayContext = {
    createdAt: new Date().toISOString(),
    resolved: new Map(),
  }
): Promise<void> => {
  switch (mutation.op) {
    case "items.create": {
      // The result is not discarded, unlike every other op below: an item
      // created while offline exists only under its temp id, and the real id
      // only exists now. Without the rename every later row of the chain
      // addresses an id the server has never seen, and whatever the host
      // claimed against the temp id stays pointed at a dead name.
      const item = await mutators["items.create"](
        inTenant<"items.create">(mutation, mutation.input)
      );
      const { tempId } = mutation;
      const realId = replayedId(item);
      if (tempId !== undefined && realId !== null && realId !== tempId) {
        context.resolved.set(tempId, realId);
        context.onTempIdResolved?.(tempId, realId);
      }
      return;
    }
    case "items.update": {
      const id = targetedId(
        mutation.input,
        mutation.tempId,
        context.resolved,
        context.createdAt
      );
      await mutators["items.update"](
        inTenant<"items.update">(mutation, { ...mutation.input, id })
      );
      return;
    }
    case "items.remove": {
      const id = targetedId(
        mutation.input,
        mutation.tempId,
        context.resolved,
        context.createdAt
      );
      await mutators["items.remove"](
        inTenant<"items.remove">(mutation, { ...mutation.input, id })
      );
      return;
    }
  }
};

// ── what a failed replay means ───────────────────────────────────────

/**
 * What became of one queued row's replay. Every client acts on exactly this,
 * so a 404 means the same thing on the phone, in a service worker and in a
 * launcher extension.
 *
 * - `applied`: the server took it. The row is removed.
 * - `retry-later`: no verdict on the row. The flush stops here and this row
 *   and everything behind it keep their places. `unauthorized` is its own
 *   reason because clients say it differently ("sign in to sync").
 * - `hold`: the row cannot be sent by this build to this server, and may be
 *   later. Kept in place, never replayed until its hold may have ended
 *   (`holdBlocksReplay`), never deleted without a person deciding. The flush
 *   carries on past it.
 * - `drop`: the server refused this row on the merits, or it names an unsynced
 *   item that will never be synced. Removed, and said out loud.
 */
export type ReplayOutcome =
  | { kind: "applied" }
  | {
      kind: "retry-later";
      reason: "transport" | "unauthorized" | "server" | "membership";
    }
  | { kind: "hold"; reason: HoldReason }
  | { kind: "drop"; reason: "unresolved-temp-id" | "refused" };

/** What a client could read from a server's answer. */
export type ReplayErrorFacts = {
  /** The tRPC code, or null when the body was no tRPC envelope. */
  code: string | null;
  httpStatus: number | null;
  message: string;
};

/** The least a classifier needs of a row; a caller's own row type flows through. */
export type ReplayRow = { op: string; tenantId?: string; apiLevel?: number };

export type ReplayClassifyContext<R extends ReplayRow = ReplayRow> = {
  /**
   * True when no answer came back. Defaults to core's `isTransportFailure`
   * (anything that is not an `ApiError`); a host whose errors are tRPC client
   * errors passes its own.
   */
  isTransportFailure?: (error: unknown) => boolean;
  /**
   * Read the server's answer. Defaults to `ApiError` and to anything carrying
   * tRPC's `data: { code, httpStatus }`. Null means the error is no answer this
   * client understands — kept, never dropped.
   */
  readFacts?: (error: unknown) => ReplayErrorFacts | null;
  /**
   * Asked on a NOT_FOUND for a row stamped with a tenant: is the person still
   * in it? "Removed from the tenant" and "that item is gone" answer alike.
   * Anything but a confirmed yes keeps the row. Must not touch the queue — the
   * flush calling this holds it. Omitted, every NOT_FOUND on the merits is a
   * refusal.
   */
  stillMember?: (tenantId: string) => Promise<boolean>;
  /**
   * The seam for holds decided by what the row needs of the server rather
   * than by the error alone — a 400 from a server older than the row's API
   * level, say. Consulted only for a refusal on the merits, before it drops.
   */
  holdRefusal?: (facts: ReplayErrorFacts, row: R) => HoldReason | null;
  /**
   * The server's API level, when the client knows it. A 400 on a row queued by
   * a build of a higher level is then held `server-too-old` rather than
   * dropped: the server refused a field it does not know yet, which says
   * nothing about the row.
   */
  serverApiLevel?: number | null;
};

/**
 * Whether a row must wait for its server to be updated, decided before it is
 * sent: the server's level is known and below the level of the build that
 * queued the row. A row of unknown level (queued before the stamp) and a
 * server of unknown level are never held here.
 */
export const serverLevelHold = (
  row: { apiLevel?: number },
  serverApiLevel: number | null | undefined
): HoldReason | null =>
  row.apiLevel !== undefined &&
  serverApiLevel !== undefined &&
  serverApiLevel !== null &&
  serverApiLevel < row.apiLevel
    ? "server-too-old"
    : null;

/**
 * tRPC's own answer for a path its router does not have — v11's
 * `No procedure found on path "items.update"`, as NOT_FOUND/404.
 *
 * Told apart from an application NOT_FOUND ("that item is gone") by the
 * message, which is the only thing that differs: both carry the same code and
 * status. Application messages never start this way.
 */
export const isUnknownProcedure = (facts: ReplayErrorFacts): boolean =>
  (facts.code === "NOT_FOUND" || facts.httpStatus === 404) &&
  /^No procedure found on path\b/.test(facts.message);

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_CONTENT: 422,
};

/** `ApiError`, or anything shaped like a tRPC client error. */
export const readReplayErrorFacts = (error: unknown): ReplayErrorFacts | null => {
  if (error instanceof ApiError) {
    return { code: error.code, httpStatus: error.httpStatus, message: error.message };
  }
  if (typeof error !== "object" || error === null) return null;
  const { data, message } = error as { data?: unknown; message?: unknown };
  if (typeof data !== "object" || data === null) return null;
  const { code, httpStatus } = data as { code?: unknown; httpStatus?: unknown };
  if (typeof code !== "string") return null;
  return {
    code,
    httpStatus: typeof httpStatus === "number" ? httpStatus : STATUS_BY_CODE[code] ?? null,
    message: typeof message === "string" ? message : "",
  };
};

/**
 * Decide what a replay that threw means for its row.
 *
 * The order is the policy:
 * 1. A row naming an unsynced item that never got a real id is dropped — it
 *    would address the wrong row, or none.
 * 2. No answer at all keeps the row.
 * 3. UNAUTHORIZED keeps it: "we do not know who you are" is no verdict.
 * 4. A server without the procedure holds it. Before the permanent set, which
 *    a 404 is in — a newer client replaying `items.update` against an older
 *    self-hosted server would otherwise delete the work.
 * 5. Anything outside the permanent set (5xx, 429, a proxy's HTML page) keeps
 *    it.
 * 6. A 400 on a row of a higher API level than the server's holds it
 *    `server-too-old`; otherwise `holdRefusal` may hold a refusal on the merits.
 * 7. A NOT_FOUND on a stamped row is kept unless the membership is confirmed.
 * 8. The rest is a refusal on the merits — 400, 403, 404, 409, 410, 422.
 */
export const classifyReplayOutcome = async <R extends ReplayRow>(
  error: unknown,
  row: R,
  context: ReplayClassifyContext<R> = {}
): Promise<ReplayOutcome> => {
  if (error instanceof UnresolvedTempIdError) {
    return { kind: "drop", reason: "unresolved-temp-id" };
  }
  const transport = context.isTransportFailure ?? isTransportFailure;
  if (transport(error)) return { kind: "retry-later", reason: "transport" };

  const facts = (context.readFacts ?? readReplayErrorFacts)(error);
  if (facts === null) return { kind: "retry-later", reason: "server" };
  if (facts.code === "UNAUTHORIZED" || facts.httpStatus === 401) {
    return { kind: "retry-later", reason: "unauthorized" };
  }
  if (isUnknownProcedure(facts)) return { kind: "hold", reason: "unknown-procedure" };

  const status = facts.httpStatus ?? (facts.code ? STATUS_BY_CODE[facts.code] : undefined);
  if (status === undefined || !isPermanentRejectionStatus(facts.code ?? "PARSE_ERROR", status)) {
    return { kind: "retry-later", reason: "server" };
  }

  const tooOld =
    (facts.code === "BAD_REQUEST" || status === 400) &&
    serverLevelHold(row, context.serverApiLevel) !== null;
  if (tooOld) return { kind: "hold", reason: "server-too-old" };

  const held = context.holdRefusal?.(facts, row) ?? null;
  if (held !== null) return { kind: "hold", reason: held };

  if (
    row.tenantId !== undefined &&
    context.stillMember !== undefined &&
    (facts.code === "NOT_FOUND" || status === 404)
  ) {
    const confirmed = await context.stillMember(row.tenantId).catch(() => false);
    if (!confirmed) return { kind: "retry-later", reason: "membership" };
  }

  return { kind: "drop", reason: "refused" };
};

/**
 * What a flush runner hands back to `OfflineQueue.flush` for an outcome: a
 * hold verdict, nothing (the row is done with), or the error rethrown so the
 * flush stops in order.
 */
export const flushVerdictFor = (
  outcome: ReplayOutcome,
  error: unknown
): FlushVerdict | undefined => {
  switch (outcome.kind) {
    case "applied":
    case "drop":
      return undefined;
    case "hold":
      return { hold: outcome.reason };
    case "retry-later":
      throw error;
  }
};
