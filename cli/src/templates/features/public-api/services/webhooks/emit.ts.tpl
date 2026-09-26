// Where a mutation says "this happened". Nothing here talks to the network.
//
// Emission ENQUEUES: it writes one pending `WebhookDelivery` per interested
// subscription and returns. The POST is the sweeper's job, on its own retry
// schedule. Splitting the two is what keeps a slow or dead customer endpoint
// from becoming latency on the request that created an item.
import mongoose from "mongoose";
import { WebhookDelivery } from "../../models/WebhookDelivery.js";
import { WebhookSubscription } from "../../models/WebhookSubscription.js";
import type { WebhookEnvelope, WebhookEvent, WebhookEventData } from "./types.js";

/**
 * Fan an event out to every enabled subscription that asked for it.
 *
 * Fire-and-forget with a swallowed catch: an integration is a side effect of a
 * mutation, never a precondition of it. A webhook collection that is down must
 * not make creating an item fail. NEVER await this into a mutation's failure
 * path.
 *
 * The FULL, unprojected envelope is stored. The visibility projection happens
 * at SEND time against the subscription owner's live permissions, so a
 * permission change between enqueue and send is honoured rather than frozen
 * in here.
 */
export function emitWebhookEvent(
  tenantId: string,
  event: WebhookEvent,
  data: WebhookEventData,
): void {
  if (!tenantId) return;

  void (async () => {
    const subscriptions = await WebhookSubscription.find({
      tenantId,
      enabled: true,
      events: event,
    })
      .select({ _id: 1 })
      .lean();
    if (subscriptions.length === 0) return;

    const now = new Date();
    const rows = subscriptions.map((subscription) => {
      // The row's `_id` is minted HERE rather than by the insert, so the
      // envelope can carry it. There is exactly one delivery id in the
      // product: this value is the envelope's `id`, the `X-Webhook-Delivery`
      // header, and the id of the row the delivery log lists. A separate
      // random id for the wire would hand an integrator a dedup key that
      // matches nothing they can look up when a delivery fails.
      const id = new mongoose.Types.ObjectId();
      const envelope: WebhookEnvelope = {
        id: id.toHexString(),
        event,
        tenantId,
        createdAt: now.toISOString(),
        data,
      };
      return {
        _id: id,
        tenantId,
        subscriptionId: String(subscription._id),
        event,
        envelope,
        status: "pending" as const,
        // Written explicitly rather than left to the schema default: claiming
        // a delivery is a compare-and-swap on this field, and a Mongo equality
        // filter does not match a document that is missing it.
        attempt: 0,
        responseStatus: null,
        error: null,
        // Due immediately; the sweeper picks it up on its next pass.
        nextAttemptAt: now,
      };
    });

    await WebhookDelivery.insertMany(rows, { ordered: false });
  })().catch(() => {
    // Best-effort, always. See the doc comment.
  });
}
