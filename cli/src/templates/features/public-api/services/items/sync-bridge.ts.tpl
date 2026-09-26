// Item changes, onto the `client-core` sync feed.
//
// Written by the `public-api` feature ONLY when `src/sync/feed.ts` exists — it
// is the one file here that imports the feed, which is what keeps
// `events.ts` and the whole service layer resolvable in a project that
// declined `client-core`.
//
// It exists because the extraction moved the publish. The starter called
// `publishSync` from inside each tRPC resolver; those resolvers now delegate
// to `services/items/`, and a publish written per resolver is a publish the
// REST surface does not make. Registering one listener here means a record
// created through `/api/v1` reaches this person's other devices exactly as one
// created through tRPC does — which is the property the whole extraction is
// for.
import { publishSync } from "../../sync/feed.js";
import { onItemEvent } from "./events.js";

/**
 * Publish to the room of the user the write RAN AS.
 *
 * `scope.actorId` came off the session or off the token row, never off request
 * input — the same rule the starter's resolvers stated when they passed
 * `ctx.user.id`. The feed's room is the authenticated user and nothing else,
 * so a value a caller could choose must never reach it.
 *
 * A consequence worth knowing before you grow a second member: in a tenant
 * with several members, editing a colleague's record notifies YOUR devices and
 * not theirs. Fanning out to the owner as well means publishing into another
 * person's room, which is a decision `sync/feed.ts` owns rather than this
 * bridge — add it there, deliberately, when a shared tenant is a real thing in
 * this product.
 */
export function registerItemSyncBridge(): () => void {
  return onItemEvent((_event, data, scope) => {
    // Every item event carries an id, whether the row still exists or not:
    // `item-deleted` is precisely the change a device most needs to hear
    // about, because a record that is gone on the server and still on screen
    // elsewhere is the one somebody will try to open.
    const id = data.kind === "item" ? data.item.id : data.itemId;
    publishSync(scope.actorId, { kind: "items.changed", id });
  });
}
