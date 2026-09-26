// One place a change to an item is announced, so every surface announces it.
//
// The item service calls this and nothing else calls it. That is what makes
// "a REST write publishes the same events as a typed one" true by
// construction rather than by two code paths that happen to agree today. The
// starter used to publish from inside each tRPC resolver, which is precisely
// the shape that leaves the second caller silent.
//
// Listeners are REGISTERED rather than imported. Two of the things that want
// to hear about an item change — the websocket layer and the `client-core`
// sync feed — are optional parts of the scaffold and may not exist in this
// project at all. Importing either from a service would make an optional
// feature a hard dependency of the public API: the module would fail to
// resolve, and the server would not boot.
import { emitWebhookEvent } from "../webhooks/emit.js";
import type { WebhookEvent, WebhookEventData } from "../webhooks/types.js";
import type { TenantScope } from "../tenancy.js";

/**
 * `scope` is passed through because a listener usually needs to know WHO the
 * write ran as, not only what changed. The sync feed's room is the
 * authenticated user, so it publishes to `scope.actorId` — a value that came
 * off the session or the token row, never off request input.
 */
export type ItemEventListener = (
  event: WebhookEvent,
  data: WebhookEventData,
  scope: TenantScope,
) => void;

/**
 * A LIST, not a single slot.
 *
 * A project can legitimately want several: the sync feed for this person's
 * own devices, a websocket room for a shared view, a log. With one slot the
 * second registration silently replaces the first, and the symptom is a
 * feature that stops working weeks later when an unrelated one is installed.
 */
const listeners = new Set<ItemEventListener>();

/**
 * Subscribe to item changes. Returns the unsubscribe.
 *
 * Call it once at boot. For the websocket layer, from `src/index.ts`:
 *
 *   onItemEvent((event, data, scope) => {
 *     roomManager.broadcast(scope.tenantId, { type: "item-event", event, data });
 *   });
 *
 * The `client-core` sync feed has its own adapter — see `./sync-bridge.ts`,
 * which this feature writes only when that feed exists.
 */
export function onItemEvent(listener: ItemEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam, and the reset a hot reload needs so listeners do not stack. */
export function clearItemEventListeners(): void {
  listeners.clear();
}

/**
 * Announce one change. Never throws, never awaited by a mutation.
 *
 * Each listener is isolated: a broken one must not stop the next, and none of
 * them may turn a successful create into a 500 for the person who made it. An
 * integration is a side effect of a write, never a precondition of it.
 */
export function publishItemEvent(
  scope: TenantScope,
  event: WebhookEvent,
  data: WebhookEventData,
): void {
  for (const listener of listeners) {
    try {
      listener(event, data, scope);
    } catch (error) {
      // Logged rather than swallowed silently: a listener that throws on every
      // write is a real bug, and one nobody would ever see otherwise.
      console.error(
        JSON.stringify({
          scope: "items.events",
          level: "error",
          event: "listener_failed",
          itemEvent: event,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  emitWebhookEvent(scope.tenantId, event, data);
}
