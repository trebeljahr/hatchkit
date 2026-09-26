// Sending one webhook: claim, project, re-check the target, sign, POST, record.
//
// Nothing here is on a user's request path. `emitWebhookEvent` writes a
// pending row and returns; this module is the background half, so a customer
// endpoint that takes thirty seconds to answer costs nobody a create.
//
// The order of operations is load-bearing:
//   1. claim the row, so two sweeps cannot send it twice;
//   2. project against the owner's LIVE permissions, so a change since enqueue
//      is honoured;
//   3. re-resolve the URL, because a create-time-only SSRF check is decorative
//      against DNS rebinding;
//   4. serialize ONCE, sign that exact string, send that exact string.
import { ApiMember } from "../../models/ApiMember.js";
import { WebhookDelivery } from "../../models/WebhookDelivery.js";
import { WebhookSubscription } from "../../models/WebhookSubscription.js";
import type { ApiPermission } from "../../auth/api-permissions.js";
import { nextAttemptAt, shouldAutoDisable } from "./backoff.js";
import { projectWebhookEnvelope } from "./projection.js";
import { assertDeliverableUrl } from "./ssrf.js";
import {
  WEBHOOK_SIGNATURE_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
  signWebhookBody,
} from "./signature.js";
import type { WebhookEnvelope } from "./types.js";

/** How long a receiver gets to answer before the attempt counts as failed. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a claimed delivery stays claimed.
 *
 * The claim is written as a future `nextAttemptAt`, so a process that dies
 * mid-flight releases its rows by simply becoming due again. Longer than the
 * request timeout, or a slow endpoint would be picked up a second time while
 * the first attempt is still in the air.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;

/** Most deliveries one sweep will send. Keeps a backlog from monopolising it. */
export const WEBHOOK_SWEEP_BATCH = 20;

export type DeliveryTarget = { deliveryId: string; subscriptionId: string };

/** A failed attempt, described the way the delivery row records it. */
export type DeliveryFailure = { error: string; responseStatus: number | null };

/**
 * Turn an HTTP status into "delivered" (`null`) or a failure.
 *
 * A 3xx is a FAILURE, not a hop to follow. Following a redirect would hand the
 * SSRF check the wrong URL: every address behind the subscription's own host
 * was validated, and a `Location:` header pointing at 169.254.169.254 was
 * validated by nobody. `redirect: "manual"` on the request below is what makes
 * a 3xx arrive here as a status to record instead of a second destination.
 */
export function classifyResponseStatus(status: number): DeliveryFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) {
    return { error: "redirect_not_followed", responseStatus: status };
  }
  return { error: `http_${status}`, responseStatus: status };
}

/**
 * The permissions a subscription's deliveries are projected against.
 *
 * LIVE, read per delivery: the whole point of projecting at send time is that
 * this answer may have changed since the subscription was created. `null`
 * means the creator is no longer a member — which is not an error and not a
 * retry, it is "there is nobody left who may see this", so the delivery is
 * skipped. Fail closed: a subscription with an empty `createdBy` matches no
 * membership and is skipped rather than delivered unprojected.
 */
async function ownerPermissions(
  tenantId: string,
  userId: string,
): Promise<readonly ApiPermission[] | null> {
  if (!userId) return null;
  const member = await ApiMember.findOne({ tenantId, userId }).lean();
  if (!member) return null;
  return member.permissions ?? [];
}

/** Record a terminal outcome that is not a failure of the endpoint. */
async function markSkipped(deliveryId: string): Promise<void> {
  await WebhookDelivery.updateOne(
    { _id: deliveryId },
    {
      $set: {
        status: "skipped_visibility",
        nextAttemptAt: null,
        error: null,
        responseStatus: null,
      },
    },
  );
}

/**
 * Record a failed attempt and schedule the next one, or give up.
 *
 * `consecutiveFailures` is incremented ONLY when the delivery is exhausted,
 * never per attempt: the auto-disable threshold counts dead deliveries, and
 * counting attempts instead would switch a healthy endpoint off after two and
 * a half bad ones.
 */
async function recordFailure(
  target: DeliveryTarget,
  attemptsMade: number,
  failure: DeliveryFailure,
  now: Date,
): Promise<void> {
  const retryAt = nextAttemptAt(attemptsMade, now);
  await WebhookDelivery.updateOne(
    { _id: target.deliveryId },
    {
      $set: {
        status: retryAt ? "pending" : "failed",
        attempt: attemptsMade,
        error: failure.error,
        responseStatus: failure.responseStatus,
        nextAttemptAt: retryAt,
      },
    },
  );
  if (retryAt) return;

  const subscription = await WebhookSubscription.findOneAndUpdate(
    { _id: target.subscriptionId },
    { $inc: { consecutiveFailures: 1 }, $set: { lastDeliveryAt: now } },
    { returnDocument: "after" },
  ).lean();
  if (!subscription) return;
  if (!shouldAutoDisable(subscription.consecutiveFailures ?? 0)) return;
  if (!subscription.enabled) return;

  await WebhookSubscription.updateOne(
    { _id: target.subscriptionId },
    { $set: { enabled: false, disabledAt: now } },
  );
}

/** Record a success and clear the endpoint's failure streak. */
async function recordSuccess(
  target: DeliveryTarget,
  attemptsMade: number,
  status: number,
  now: Date,
): Promise<void> {
  await WebhookDelivery.updateOne(
    { _id: target.deliveryId },
    {
      $set: {
        status: "delivered",
        attempt: attemptsMade,
        error: null,
        responseStatus: status,
        nextAttemptAt: null,
      },
    },
  );
  await WebhookSubscription.updateOne(
    { _id: target.subscriptionId },
    { $set: { consecutiveFailures: 0, lastDeliveryAt: now } },
  );
}

/**
 * Send one delivery.
 *
 * Two callers cannot double-post the same row, and a plain status read is NOT
 * what stops them: nothing writes a non-`pending` status until the response
 * comes back, so two concurrent calls would both read `pending`, both pass and
 * both POST. What stops them is the attempt number being CLAIMED — one atomic
 * `findOneAndUpdate` that only matches while `attempt` is still the value that
 * was read. The loser matches nothing and returns having sent nothing.
 *
 * The attempt number therefore counts attempts STARTED, not finished: a
 * process that dies mid-flight has spent one, and the row becomes due again
 * when its lease expires rather than replaying that attempt for free.
 */
export async function deliverWebhook(deliveryId: string): Promise<void> {
  const pending = await WebhookDelivery.findById(deliveryId).lean();
  if (!pending || pending.status !== "pending") return;

  const attemptsMade = (pending.attempt ?? 0) + 1;
  const delivery = await WebhookDelivery.findOneAndUpdate(
    { _id: deliveryId, status: "pending", attempt: pending.attempt ?? 0 },
    { $set: { attempt: attemptsMade } },
    { returnDocument: "after" },
  ).lean();
  // Somebody else claimed this attempt between the read and the update.
  if (!delivery) return;

  const now = new Date();
  const target: DeliveryTarget = {
    deliveryId: String(delivery._id),
    subscriptionId: delivery.subscriptionId,
  };
  const subscription = await WebhookSubscription.findById(delivery.subscriptionId).lean();

  // A subscription deleted or switched off between enqueue and send has no
  // destination left. Terminal, and counted against nothing — there is no
  // endpoint to blame or to disable.
  if (!subscription || !subscription.enabled) {
    await WebhookDelivery.updateOne(
      { _id: target.deliveryId },
      {
        $set: {
          status: "failed",
          attempt: attemptsMade,
          error: subscription ? "subscription_disabled" : "subscription_deleted",
          nextAttemptAt: null,
        },
      },
    );
    return;
  }

  const permissions = await ownerPermissions(subscription.tenantId, subscription.createdBy);
  if (!permissions) {
    await markSkipped(target.deliveryId);
    return;
  }

  const envelope: WebhookEnvelope | null = projectWebhookEnvelope(delivery.envelope, {
    userId: subscription.createdBy,
    permissions,
  });
  // Withheld is a PERMISSION outcome, not a failure: it must not burn a retry
  // and must not count towards auto-disabling an endpoint that is working
  // perfectly well.
  if (!envelope) {
    await markSkipped(target.deliveryId);
    return;
  }

  // Re-resolved on EVERY attempt, not only at subscribe time. A name that
  // answered publicly when the subscription was created can answer
  // 169.254.169.254 now; that is DNS rebinding, and it is the whole reason
  // this call is here rather than only in the create path.
  let url: URL;
  try {
    url = await assertDeliverableUrl(subscription.url);
  } catch {
    await recordFailure(
      target,
      attemptsMade,
      { error: "blocked_target", responseStatus: null },
      now,
    );
    return;
  }

  // Serialized ONCE, into `rawBody`. The HMAC below covers these exact bytes
  // and the request sends this exact string — serializing the envelope a
  // second time for the body would sign one byte sequence and transmit
  // another, and every receiver that verifies would reject the delivery as
  // forged. There is deliberately exactly one serialization on this path.
  const rawBody = JSON.stringify(envelope);
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  const signature = signWebhookBody(subscription.secret, timestampSeconds, rawBody);

  try {
    const response = await fetch(url, {
      method: "POST",
      // `manual`, so a `Location:` header is recorded as a 3xx rather than
      // followed to a destination nothing validated.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADERS.event]: envelope.event,
        [WEBHOOK_SIGNATURE_HEADERS.delivery]: envelope.id,
        [WEBHOOK_SIGNATURE_HEADERS.timestamp]: String(timestampSeconds),
        [WEBHOOK_SIGNATURE_HEADERS.signature]: `${WEBHOOK_SIGNATURE_VERSION}=${signature}`,
      },
      // The same string the signature was computed over. Not a re-serialized
      // copy of `envelope`, and not a second object that happens to look like
      // it.
      body: rawBody,
    });
    // Drained and dropped: nothing reads a receiver's body — an error page can
    // be megabytes of HTML — but an unread body holds the connection open.
    await response.arrayBuffer().catch(() => undefined);

    const failure = classifyResponseStatus(response.status);
    if (failure) {
      await recordFailure(target, attemptsMade, failure, now);
      return;
    }
    await recordSuccess(target, attemptsMade, response.status, now);
  } catch (error) {
    // Transport level: DNS, TLS, connection refused, timeout. This server's
    // own text is stored, never the receiver's body.
    await recordFailure(
      target,
      attemptsMade,
      { error: error instanceof Error ? error.name : "request_failed", responseStatus: null },
      now,
    );
  }
}

/**
 * Take ownership of the deliveries that are due.
 *
 * Claimed one at a time with `findOneAndUpdate`, which is atomic: pushing
 * `nextAttemptAt` into the future is what stops a second sweep — in this
 * process or another replica — from picking the same row up. A plain `find`
 * here would double-post every delivery the moment a second instance exists.
 */
export async function claimDueDeliveries(now: Date, limit: number): Promise<string[]> {
  const claimed: string[] = [];
  const leaseUntil = new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS);

  for (let i = 0; i < limit; i += 1) {
    const row = await WebhookDelivery.findOneAndUpdate(
      { status: "pending", nextAttemptAt: { $ne: null, $lte: now } },
      { $set: { nextAttemptAt: leaseUntil } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after", projection: { _id: 1 } },
    ).lean();
    if (!row) break;
    claimed.push(String(row._id));
  }

  return claimed;
}

/**
 * One pass of the queue.
 *
 * Sequential rather than parallel: the batch is small, and a fan-out of
 * concurrent requests to a slow host is how a background loop becomes the
 * thing that exhausts the process's sockets.
 */
export async function runWebhookSweep(now: Date = new Date()): Promise<void> {
  const ids = await claimDueDeliveries(now, WEBHOOK_SWEEP_BATCH);
  for (const id of ids) {
    await deliverWebhook(id);
  }
}
