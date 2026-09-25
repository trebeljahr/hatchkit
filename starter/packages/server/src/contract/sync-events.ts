// The sync event union as zod schemas, for the contract snapshot only.
//
// `SyncEvent` in `@starter/shared` is a TypeScript type, and nothing validates
// a frame at runtime — clients cast a decoded frame after `isSyncMessage` has
// checked that it is a sync frame at all. The committed contract still has to
// see which kinds and which payload fields a server of this level can send, so
// this file mirrors the type as schemas the snapshot can serialise.
//
// A sync event kind is added in THREE places:
//
//   1. the `SyncEvent` union            (packages/shared/src/sync-protocol.ts)
//   2. `SYNC_EVENT_KIND_SET`            (same file, the runtime membership test)
//   3. `syncEventSchemas` below         (what the contract snapshot records)
//
// `tsc` enforces the last two: the `satisfies` clause below fails the build
// when a kind in the union has no schema here, and the mirror constants at the
// bottom fail it when a schema names a kind the union does not have. The first
// is the one a human has to remember — a kind that is in the union and not in
// the set is a frame every client treats as unknown, which is a refetch rather
// than a break, so nothing fails loudly. The module-load assertion at the
// bottom is there to make that failure loud anyway.
import { z } from "zod";
import {
  SYNC_EVENT_KIND_SET,
  type SyncEvent,
  type SyncEventKind,
} from "@starter/shared";

/**
 * Kind → the schema of that event object, whole (the `kind` literal included),
 * because the snapshot records the frame a client receives rather than a
 * payload with the discriminator stripped off.
 */
export const syncEventSchemas = {
  "items.changed": z.object({
    kind: z.literal("items.changed"),
    /** Present when one record moved, absent for a change of the whole list. */
    id: z.string().optional(),
  }),
  "profile.changed": z.object({
    kind: z.literal("profile.changed"),
  }),
} as const satisfies Record<SyncEventKind, z.ZodType>;

type Mirrored = z.infer<(typeof syncEventSchemas)[keyof typeof syncEventSchemas]>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Both directions, at compile time: every mirrored event is a `SyncEvent`, and
// every `SyncEvent` is mirrored. `true` is the only value either constant can
// hold, so a drift in either direction is a type error rather than a snapshot
// that quietly describes a feed the server does not have.
export const mirrorCoversSyncEvent: Exact<Mirrored, SyncEvent> = true;
export const mirrorKeysMatchKinds: Exact<keyof typeof syncEventSchemas, SyncEventKind> = true;

/**
 * And the third place, at module load: the runtime set and this mirror name the
 * same kinds.
 *
 * `SYNC_EVENT_KIND_SET` is a `ReadonlySet<string>`, so no type can check it —
 * and a kind missing from it is exactly the failure that produces no error
 * anywhere: the server publishes the event, `isSyncMessage` lets it through,
 * and every client falls into its unknown-kind branch and refetches. Correct
 * behaviour, and a permanent needless refetch. Throwing here turns it into a
 * failure at startup, where somebody sees it.
 */
for (const kind of Object.keys(syncEventSchemas)) {
  if (!SYNC_EVENT_KIND_SET.has(kind)) {
    throw new Error(
      `sync event kind "${kind}" has a contract schema but is missing from SYNC_EVENT_KIND_SET (packages/shared/src/sync-protocol.ts)`,
    );
  }
}
for (const kind of SYNC_EVENT_KIND_SET) {
  if (!(kind in syncEventSchemas)) {
    throw new Error(
      `sync event kind "${kind}" is in SYNC_EVENT_KIND_SET but has no contract schema (contract/sync-events.ts)`,
    );
  }
}
