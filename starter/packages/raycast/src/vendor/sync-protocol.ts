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
 * The realtime sync feed's wire format.
 *
 * Separate from `protocol.ts`, which is the interactive room protocol (a client
 * joins a room it names and sends chat and actions into it). The sync feed is
 * the opposite shape on purpose:
 *
 *  - **Its room comes from the authenticated session and nothing else.** No
 *    query parameter, no first frame, no path segment picks it. A room a client
 *    can name is a room a client can name *somebody else's*, and the feed
 *    carries every change to that account's data.
 *  - **It is one-way.** The server never reads a frame from it. A socket that
 *    accepts commands is a second, unaudited write path beside tRPC, with its
 *    own parsing, its own authorisation and its own bugs. Everything a client
 *    wants to *do* goes through the API; this only says what changed.
 *
 * So a client's only job is to listen, and to refetch on what it hears.
 */

/** A change worth telling every device about. */
export const SYNC_EVENT_KINDS = ["items.changed", "profile.changed"] as const;

export type SyncEventKind = (typeof SYNC_EVENT_KINDS)[number];

/**
 * The kinds this build knows, for a runtime membership test.
 *
 * Kept beside {@link SyncEvent} and checked against it by the committed
 * contract snapshot: adding a kind means touching the union, this set and
 * `contract/sync-events.ts`, and `tsc` enforces the last two.
 */
export const SYNC_EVENT_KIND_SET: ReadonlySet<string> = new Set(SYNC_EVENT_KINDS);

export type SyncEvent =
  /** A record was created, edited or deleted. `id` names it when one row moved. */
  | { kind: "items.changed"; id?: string }
  /** The signed-in account's own profile or settings changed. */
  | { kind: "profile.changed" };

/**
 * One frame of the feed.
 *
 * `originId` is the id the mutating client stamped its request with, so a
 * client can recognise its own echo and skip a refetch it already applied.
 * `tenantId` is the tenant the change happened in, absent for a change about
 * the account rather than any one tenant: a socket carries every tenant the
 * person belongs to, so a consumer showing one needs it to leave the others
 * alone.
 */
export type SyncMessage = {
  type: "sync";
  event: SyncEvent;
  originId?: string;
  tenantId?: string;
};

/**
 * True when a decoded server frame is a sync frame this build can read.
 *
 * An unknown `kind` still passes: a consumer's answer to one is "refetch",
 * never "ignore" — see the note on the `never` defaults in the client's event
 * handling. What is rejected is a frame that is not a sync frame at all.
 */
export const isSyncMessage = (value: { type?: unknown }): value is SyncMessage => {
  if (value.type !== "sync") return false;
  const { event } = value as { event?: unknown };
  if (typeof event !== "object" || event === null) return false;
  return typeof (event as { kind?: unknown }).kind === "string";
};

/**
 * Close code for "the session behind this socket no longer exists".
 *
 * In the 4000–4999 application range. A client that sees it stops reconnecting
 * for good: the credential it was built with will never be accepted again, so a
 * backoff is pure noise and a sync indicator that never settles is a lie.
 */
export const SESSION_REVOKED_CLOSE_CODE = 4401;

/** Path the sync feed is mounted at, under the server's own `/api` prefix. */
export const SYNC_PATH = "/api/sync";
