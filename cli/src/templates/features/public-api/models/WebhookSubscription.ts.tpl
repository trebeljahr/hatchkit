import mongoose, { Schema, type Document } from "mongoose";
import type { WebhookEvent } from "../services/webhooks/types.js";

/**
 * How many consecutive DEAD DELIVERIES switch an endpoint off.
 *
 * Counted in deliveries, not attempts: one delivery is already six attempts
 * spread over ~8 hours, so fifteen of them is days of an unreachable host
 * rather than one bad afternoon. Lives here, next to the field it governs, and
 * is imported everywhere else — two copies of a number like this drift the
 * first time somebody tunes one.
 */
export const WEBHOOK_AUTO_DISABLE_AFTER = 15;

export interface IWebhookSubscription extends Document {
  tenantId: string;
  /**
   * The member whose LIVE permissions every delivery is projected against.
   *
   * A webhook is a standing grant: authorised once, then delivering for
   * months. Storing who authorised it — rather than what they could see when
   * they did — is what lets a demotion this morning stop colleagues' rows
   * going out this afternoon.
   */
  createdBy: string;
  url: string;
  /** The HMAC key. Shown once at creation and never again. */
  secret: string;
  events: WebhookEvent[];
  enabled: boolean;
  consecutiveFailures: number;
  lastDeliveryAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const webhookSubscriptionSchema = new Schema<IWebhookSubscription>(
  {
    tenantId: { type: String, required: true, index: true },
    createdBy: { type: String, required: true },
    url: { type: String, required: true, maxlength: 2000 },
    secret: { type: String, required: true },
    events: { type: [String], required: true },
    enabled: { type: Boolean, default: true },
    consecutiveFailures: { type: Number, default: 0 },
    lastDeliveryAt: { type: Date, default: null },
    disabledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The fan-out query on every mutation: "enabled subscriptions in this tenant
// that asked for this event". Unindexed it is a collection scan on the write
// path of every create, update and delete in the product.
webhookSubscriptionSchema.index({ tenantId: 1, enabled: 1, events: 1 });

export const WebhookSubscription = mongoose.model<IWebhookSubscription>(
  "WebhookSubscription",
  webhookSubscriptionSchema,
);
