// Managing this tenant's webhook subscriptions.
//
// The subscription surface lives in v1 rather than in tRPC on purpose: a token
// that receives events should be able to set up where they go, without a human
// opening a browser. It is gated on its own scopes, so a token minted for
// reading items cannot quietly add an endpoint that then receives them.
import { paginationSchema } from "__HATCHKIT_SHARED_PKG__";
import { has } from "../../../auth/api-permissions.js";
import { WebhookDelivery } from "../../../models/WebhookDelivery.js";
import { WebhookSubscription } from "../../../models/WebhookSubscription.js";
import { mintWebhookSecret } from "../../../services/webhooks/signature.js";
import { assertDeliverableUrl } from "../../../services/webhooks/ssrf.js";
import type { ApiHandlers, AuthedRequest } from "../auth.js";
import { sendData, sendList } from "../envelope.js";
import { ApiProblemError } from "../problem.js";
import { asObject, coerceQuery, parseWith } from "../query.js";
import { createWebhookSchema, idPathSchema } from "../routes-table.js";

const DEFAULT_LIMIT = 20;

/** A lean subscription row, as mongoose hands it back. */
type SubscriptionRow = {
  _id: unknown;
  tenantId: string;
  url: string;
  events: string[];
  enabled: boolean;
  consecutiveFailures: number;
  lastDeliveryAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The wire shape. The `secret` is NOT in it.
 *
 * It is returned exactly once, by the create route, from the value that was
 * just generated. Echoing it from a read would make every `webhooks:read`
 * token a way to forge signatures for somebody else's endpoint — and a leaked
 * read token is the cheapest kind to leak.
 */
function toWire(row: SubscriptionRow): Record<string, unknown> {
  return {
    id: String(row._id),
    tenantId: row.tenantId,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    lastDeliveryAt: row.lastDeliveryAt ? row.lastDeliveryAt.toISOString() : null,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Managing endpoints is a PERMISSION, not only a scope.
 *
 * The scope says the credential was minted for this; `webhooks:manage` says
 * the member behind it is still allowed to do it. A member demoted after the
 * token was minted loses the second one on their next request, which is the
 * whole point of reading permissions live.
 *
 * A genuine 403: the tenant owns these subscriptions and the caller can see
 * them. Nothing about existence is being withheld.
 */
function requireManage(req: AuthedRequest): void {
  if (has(req.apiScope.permissions, "webhooks:manage")) return;
  throw new ApiProblemError(
    "permission-required",
    403,
    "This token's member may not manage webhook subscriptions.",
  );
}

/**
 * One subscription of THIS tenant, or the 404 a foreign id gets.
 *
 * Filtered on `tenantId` in the query rather than fetched and then compared:
 * a comparison is a line somebody can delete, and the failure is silent.
 */
async function ownedSubscription(
  req: AuthedRequest,
  id: string,
): Promise<SubscriptionRow> {
  const row = (await WebhookSubscription.findOne({ _id: id, tenantId: req.apiScope.tenantId })
    .lean()
    .catch(() => null)) as SubscriptionRow | null;
  // 404 and never 403: a 403 on a foreign id confirms the id exists somewhere.
  if (!row) {
    throw new ApiProblemError("not-found", 404, "No such webhook subscription.");
  }
  return row;
}

export const webhookHandlers: ApiHandlers = {
  "get /webhooks": async (req, res) => {
    const input = parseWith(paginationSchema, coerceQuery(req.apiQuery, paginationSchema));
    const limit = input.limit ?? DEFAULT_LIMIT;
    const query: Record<string, unknown> = { tenantId: req.apiScope.tenantId };
    if (input.cursor) query._id = { $lt: input.cursor };

    const rows = (await WebhookSubscription.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean()) as unknown as SubscriptionRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const last = rows[rows.length - 1];

    sendList(res, rows.map(toWire), hasMore && last ? String(last._id) : null);
  },

  "post /webhooks": async (req, res) => {
    requireManage(req);
    const input = parseWith(createWebhookSchema, asObject(req.body));
    // Checked here AND again before every delivery. This call is the friendly
    // half — it tells the caller their URL is unusable while they are looking
    // at the response. The one in `delivery.ts` is the one that matters, since
    // a name that resolves publicly today can resolve to 169.254.169.254
    // tomorrow.
    const url = await assertDeliverableUrl(input.url);

    const secret = mintWebhookSecret();
    const created = await WebhookSubscription.create({
      tenantId: req.apiScope.tenantId,
      // Whose live permissions every delivery is projected against.
      createdBy: req.apiScope.actorId,
      url: url.toString(),
      secret,
      events: input.events,
    });

    // The one and only time the secret is on the wire.
    sendData(res, { ...toWire(created as unknown as SubscriptionRow), secret });
  },

  "get /webhooks/:id/deliveries": async (req, res) => {
    const { id } = parseWith(idPathSchema, { id: req.params.id });
    const subscription = await ownedSubscription(req, id);
    const input = parseWith(paginationSchema, coerceQuery(req.apiQuery, paginationSchema));
    const limit = input.limit ?? DEFAULT_LIMIT;

    const query: Record<string, unknown> = { subscriptionId: String(subscription._id) };
    if (input.cursor) query._id = { $lt: input.cursor };

    type DeliveryRow = {
      _id: unknown;
      subscriptionId: string;
      event: string;
      status: string;
      attempt: number;
      responseStatus: number | null;
      error: string | null;
      nextAttemptAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };

    const rows = (await WebhookDelivery.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      // The stored envelope is the UNPROJECTED event. It is never served here:
      // the delivery log is an operational view, and handing back the payload
      // would route around the send-time visibility projection entirely.
      .select({ envelope: 0 })
      .lean()) as unknown as DeliveryRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const last = rows[rows.length - 1];

    sendList(
      res,
      rows.map((row) => ({
        id: String(row._id),
        subscriptionId: row.subscriptionId,
        event: row.event,
        status: row.status,
        attempt: row.attempt ?? 0,
        responseStatus: row.responseStatus ?? null,
        error: row.error ?? null,
        nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      hasMore && last ? String(last._id) : null,
    );
  },

  "delete /webhooks/:id": async (req, res) => {
    requireManage(req);
    const { id } = parseWith(idPathSchema, req.params);
    const subscription = await ownedSubscription(req, id);
    await WebhookSubscription.deleteOne({ _id: String(subscription._id) });
    // Queued deliveries are left where they are. The sweeper finds the
    // subscription gone on their next attempt and marks them terminal, which
    // keeps the delivery log honest about what was pending when the endpoint
    // was removed.
    sendData(res, { success: true as const, id: String(subscription._id) });
  },
};
