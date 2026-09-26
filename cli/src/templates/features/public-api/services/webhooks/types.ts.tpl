// What goes on the wire when this server tells somebody else that something
// happened.
//
// One envelope shape for every event, with the variant part behind a `kind`
// discriminant. A receiver can therefore parse `id`, `event`, `tenantId` and
// `createdAt` without knowing which events exist yet, which is what lets a new
// event ship without every integration redeploying first.
import type { Item } from "__HATCHKIT_SHARED_PKG__";

/**
 * Every event a subscription can ask for.
 *
 * `<resource>.<past-tense-verb>`, always. The names are part of the published
 * contract — a receiver filters on them — so renaming one is a breaking change
 * and adding one is not.
 */
export const WEBHOOK_EVENTS = ["item.created", "item.updated", "item.deleted"] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * The payload, discriminated so the visibility projection can be exhaustive.
 *
 * `item-deleted` carries `ownerId` even though the row is gone: at send time
 * the projection has to answer "may this subscriber be told about this?", and
 * with the document deleted the payload is the only place left to ask.
 */
export type WebhookEventData =
  | { kind: "item"; item: Item }
  | { kind: "item-deleted"; itemId: string; ownerId: string };

export type WebhookEnvelope = {
  /**
   * The delivery id — also the `X-Webhook-Delivery` header and the id of the
   * row the delivery log lists. One id space on purpose: an integrator handed
   * a dedup key that matches nothing they can look up cannot debug a failure.
   */
  id: string;
  event: WebhookEvent;
  tenantId: string;
  /** ISO-8601, UTC. */
  createdAt: string;
  data: WebhookEventData;
};

/** Where a delivery ended up. `skipped_visibility` is not a failure. */
export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  /**
   * The subscription's owner may not see this event any more. A permission
   * outcome, terminal, and NOT counted against the endpoint — there is nothing
   * wrong with the endpoint, and disabling it over this would punish a
   * receiver for somebody else's demotion.
   */
  "skipped_visibility",
] as const;

export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
