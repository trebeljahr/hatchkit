import mongoose, { Schema, type Document } from "mongoose";
import type {
  WebhookDeliveryStatus,
  WebhookEnvelope,
  WebhookEvent,
} from "../services/webhooks/types.js";

/**
 * One queued attempt to tell one subscription about one event.
 *
 * The stored `envelope` is UNPROJECTED — the full event, before any visibility
 * rule. That is deliberate and it is the whole reason the projection can be
 * honest: the row is written when the mutation happens and sent minutes or
 * hours later, and freezing "what the owner could see" into it at write time
 * would deliver a permission that has since been revoked. `projection.ts` is
 * the only thing between this field and the wire.
 */
export interface IWebhookDelivery extends Document {
  tenantId: string;
  subscriptionId: string;
  event: WebhookEvent;
  envelope: WebhookEnvelope;
  status: WebhookDeliveryStatus;
  /** Attempts STARTED, not finished. Claimed before the request goes out. */
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  /** When this row next becomes due. `null` once it is terminal. */
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const webhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    tenantId: { type: String, required: true, index: true },
    subscriptionId: { type: String, required: true, index: true },
    event: { type: String, required: true },
    // `Schema.Types.Mixed`: the envelope is a discriminated union whose shape
    // varies per event, and a strict sub-schema here would have to be edited
    // — and migrated — every time an event is added. Nothing queries inside it.
    envelope: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true, default: "pending" },
    // `default: 0` AND written explicitly by the emitter. Claiming a delivery
    // is a compare-and-swap on this field, and a Mongo equality filter does
    // NOT match a document that is missing the field — a row without it could
    // never be claimed and would sit pending forever.
    attempt: { type: Number, required: true, default: 0 },
    responseStatus: { type: Number, default: null },
    error: { type: String, default: null },
    nextAttemptAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The sweeper's only query: the oldest due, pending row. Every field it
// filters or sorts on is in this one index.
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

export const WebhookDelivery = mongoose.model<IWebhookDelivery>(
  "WebhookDelivery",
  webhookDeliverySchema,
);
