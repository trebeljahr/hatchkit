// The route table. One array, and BOTH the Express wiring and the OpenAPI
// document are built from it.
//
// That is the whole point of the file. A route cannot exist undocumented,
// because `index.ts` mounts nothing that is not listed here; and it cannot be
// documented but unimplemented, because mounting THROWS AT BOOT when a listed
// route has no handler. The alternative — a hand-written spec beside
// hand-written wiring — drifts within one release, and nobody notices until an
// integration has been built against a route that never existed.
//
// Request schemas are the SAME objects the tRPC procedures validate with,
// imported from `__HATCHKIT_SHARED_PKG__`. Response schemas are declared here
// and pinned to the shared TYPES via `z.ZodType<T>`, so dropping a field from
// a wire type stops the build instead of quietly shrinking the documented
// response.
import { z } from "zod";
import {
  createItemSchema,
  paginationSchema,
  updateItemSchema,
  type Item,
} from "__HATCHKIT_SHARED_PKG__";
import {
  API_PERMISSIONS,
  API_TOKEN_SCOPES,
  type ApiPermission,
  type ApiTokenScope,
} from "../../auth/api-permissions.js";
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENTS } from "../../services/webhooks/types.js";

/**
 * ISO-8601, UTC. Every timestamp this API emits is one of these.
 *
 * No offset form is admitted, because every value here is produced by
 * `.toISOString()` and therefore ends in `Z`. A schema looser than the runtime
 * is worse than one that is merely wrong: the client generated from it
 * validates a shape the server never sends, and its author only finds out when
 * they try to round-trip one.
 */
const isoDateTime = z.iso.datetime();

// ── request fragments the tRPC side has no equivalent of ─────────────

/** `GET /items/:id`, `DELETE /items/:id` and the other path-only routes. */
export const idPathSchema = z.object({ id: z.string().min(1) });

/**
 * `GET /items`.
 *
 * The shared pagination schema, extended rather than re-spelled: `limit` must
 * mean the same number on both surfaces, and a second literal `.max(100)` is a
 * second number to forget when one of them is tuned.
 */
export const itemListSchema = paginationSchema.extend({
  status: z.enum(["draft", "published", "archived"]).optional(),
});

export const createWebhookSchema = z.object({
  url: z.url().max(2000),
  /**
   * At least one. A subscription for no events is an endpoint that will never
   * be called, which reads to its owner as "webhooks are broken".
   */
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

// ── response schemas, pinned to the shared wire types ────────────────

const itemShape = {
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(["draft", "published", "archived"]),
  ownerId: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

/** `z.ZodType<Item>` is the pin: a field removed from the shared type breaks here. */
export const itemSchema: z.ZodType<Item> = z.object(itemShape);

const deletedSchema = z.object({
  success: z.literal(true),
  id: z.string(),
});

/** What `GET /me` answers. Exported so the handler cannot invent a field. */
export type ApiIdentity = {
  tokenId: string;
  tenantId: string;
  userId: string;
  scopes: ApiTokenScope[];
  permissions: ApiPermission[];
};

const identitySchema: z.ZodType<ApiIdentity> = z.object({
  tokenId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)),
  /** EFFECTIVE: live membership intersected with the token's frozen ceiling. */
  permissions: z.array(z.enum(API_PERMISSIONS)),
});

const webhookShape = {
  id: z.string(),
  tenantId: z.string(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  enabled: z.boolean(),
  consecutiveFailures: z.number(),
  lastDeliveryAt: isoDateTime.nullable(),
  disabledAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

const webhookSchema = z.object(webhookShape);

/**
 * The create response, and the ONLY response that carries the secret.
 *
 * Shown once, at creation. A subsequent read that echoed it would make every
 * `webhooks:read` token a way to mint valid signatures for somebody else's
 * endpoint.
 */
const webhookWithSecretSchema = z.object({
  ...webhookShape,
  secret: z.string(),
});

const deliverySchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  event: z.enum(WEBHOOK_EVENTS),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  /** Attempts STARTED, not finished. */
  attempt: z.number(),
  responseStatus: z.number().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

// ── response envelopes ───────────────────────────────────────────────
//
// `output` on a route is the WHOLE response body, envelope included, not the
// resource inside it. That is what keeps the generated document honest: a
// generator that had to infer "this one is a list, so wrap it" is a generator
// that gets one route wrong the day somebody adds a list-shaped read.

/** `{ data }` — one resource. */
function dataOf<T extends z.ZodType>(schema: T): z.ZodType {
  return z.object({ data: schema });
}

/**
 * `{ data: [...], nextCursor }` — a page.
 *
 * `nextCursor` is `.nullable()` and NOT `.optional()`: it is always present,
 * and null only on the last page. Documenting it as optional would tell a
 * generated client that its absence is normal, and such a client stops paging
 * early whenever a serializer drops the field.
 */
function listOf<T extends z.ZodType>(schema: T): z.ZodType {
  return z.object({
    data: z.array(schema),
    nextCursor: z.string().nullable(),
  });
}

// ── the table ────────────────────────────────────────────────────────

export type ApiRoute = {
  method: "get" | "post" | "patch" | "delete";
  /** Express-style, relative to `/api/v1`. `:id` becomes `{id}` in OpenAPI. */
  path: string;
  /** The scope this route requires, or null when any valid token may call it. */
  scope: ApiTokenScope | null;
  summary: string;
  input: { source: "query" | "body" | "path"; schema: z.ZodType } | null;
  output: z.ZodType | null;
  /**
   * Callable with no token at all. Only the spec document is: everything else
   * is somebody's data. Declared per route so `index.ts` decides what to mount
   * from the table alone and never from a hard-coded exception.
   */
  isPublic?: true;
};

/**
 * Order matters for the Express wiring. A literal segment must precede the
 * parameterised route that would also match it, or Express matches the
 * parameter first and the literal is looked up as an id.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  // ── meta ───────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/openapi.json",
    scope: null,
    summary: "This API's OpenAPI 3.1 document.",
    input: null,
    output: null,
    // Deliberately public: it describes shapes and never data, and a client
    // generator that needs a credential before it can see the route list is a
    // client generator nobody runs.
    isPublic: true,
  },
  {
    method: "get",
    path: "/me",
    scope: null,
    summary: "This token's own tenant, scopes and effective permissions.",
    input: null,
    output: dataOf(identitySchema),
  },
  // ── items ──────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/items",
    scope: "items:read",
    summary: "List items, newest first. Excludes other members' items without `items:view-others`.",
    input: { source: "query", schema: itemListSchema },
    output: listOf(itemSchema),
  },
  {
    method: "get",
    path: "/items/:id",
    scope: "items:read",
    summary: "One item. 404 for an id in another tenant, never 403.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(itemSchema),
  },
  {
    method: "post",
    path: "/items",
    scope: "items:write",
    summary: "Create an item, owned by the member this token acts as.",
    input: { source: "body", schema: createItemSchema },
    output: dataOf(itemSchema),
  },
  {
    method: "patch",
    path: "/items/:id",
    scope: "items:write",
    summary: "Edit an item. 403 for another member's item without `items:write-others`.",
    input: { source: "body", schema: updateItemSchema },
    output: dataOf(itemSchema),
  },
  {
    method: "delete",
    path: "/items/:id",
    scope: "items:write",
    summary: "Delete an item. Same refusals as the edit.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(deletedSchema),
  },
  // ── webhooks ───────────────────────────────────────────────────────
  {
    method: "get",
    path: "/webhooks",
    scope: "webhooks:read",
    summary: "List this tenant's webhook subscriptions. Secrets are never echoed.",
    input: { source: "query", schema: paginationSchema },
    output: listOf(webhookSchema),
  },
  {
    method: "post",
    path: "/webhooks",
    scope: "webhooks:write",
    summary: "Create a subscription. The signing secret is returned once, here, and never again.",
    input: { source: "body", schema: createWebhookSchema },
    output: dataOf(webhookWithSecretSchema),
  },
  {
    method: "get",
    path: "/webhooks/:id/deliveries",
    scope: "webhooks:read",
    summary: "Recent delivery attempts for one subscription, newest first.",
    input: { source: "query", schema: paginationSchema },
    output: listOf(deliverySchema),
  },
  {
    method: "delete",
    path: "/webhooks/:id",
    scope: "webhooks:write",
    summary: "Delete a subscription. Queued deliveries for it stop at their next attempt.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(deletedSchema),
  },
];
