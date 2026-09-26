// What one subscription is allowed to be told.
//
// A webhook is a STANDING grant: authorised once, then delivering for months.
// So "may this person see this?" cannot be answered at subscribe time and
// frozen — it is re-asked here, at SEND time, against the subscription owner's
// live permissions. A member demoted this morning stops receiving colleagues'
// rows this afternoon.
//
// The envelope stored on the delivery row is deliberately UNPROJECTED (see
// `models/WebhookDelivery.ts`). This function is the only thing standing
// between it and the wire, which is why it is pure, exported and unit-tested
// with the negative cases spelled out.
import { has, type ApiPermission } from "../../auth/api-permissions.js";
import type { WebhookEnvelope } from "./types.js";

/**
 * The envelope as this subscription's owner may see it, or `null` when they
 * may not be told about the event at all — the caller then records
 * `skipped_visibility`, which is a permission outcome and not a failure.
 *
 * Withheld, never stripped. Without `items:view-others` the EXISTENCE of a
 * colleague's item is itself what the permission hides, so delivering a
 * blanked-out envelope would leak the fact that something happened, when it
 * happened, and to how many rows.
 *
 * The switch is exhaustive with NO `default` arm. A new `WebhookEventData`
 * kind must fail to COMPILE here, because the alternative is a new event shape
 * defaulting into "deliverable" and shipping somebody else's data the first
 * time a feature is added by somebody who never read this file.
 */
export function projectWebhookEnvelope(
  envelope: WebhookEnvelope,
  owner: { userId: string; permissions: readonly ApiPermission[] },
): WebhookEnvelope | null {
  const data = envelope.data;
  const mayViewOthers = has(owner.permissions, "items:view-others");

  switch (data.kind) {
    case "item": {
      if (data.item.ownerId !== owner.userId && !mayViewOthers) return null;
      return envelope;
    }
    case "item-deleted": {
      // The row is gone, so `ownerId` on the payload is the only thing left to
      // ask the question about — which is exactly why the envelope carries it.
      if (data.ownerId !== owner.userId && !mayViewOthers) return null;
      return envelope;
    }
  }

  // No `default:`, deliberately. A default gives a newly added event kind a
  // behaviour by accident; this assignment gives it a type error. `data` is
  // `never` here only while every arm above returns.
  const unreachable: never = data;
  return unreachable;
}
