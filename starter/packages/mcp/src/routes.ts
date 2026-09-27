/*
 * The public REST surface this server speaks, as data.
 *
 * ── Why this is a MIRROR and not an import ──────────────────────────
 *
 * `packages/server/src/api/v1/routes-table.ts` is the real table: Express
 * mounts from it and the OpenAPI document is generated from it, so a route
 * cannot exist in one and not the other. Importing THAT table here would be
 * strictly better and it is not possible:
 *
 *  - the REST surface is an OPT-IN feature. A workspace that has not enabled
 *    it has no `packages/server/src/api/v1/` at all, so an import would not
 *    resolve and this package would not compile in the very workspace it
 *    ships in;
 *  - `@starter/server` exports only its tRPC router type. Reaching past that
 *    into `dist/api/v1/routes-table.js` would make this package depend on the
 *    server's build output, which is the opposite of "a client of the public
 *    API" — the whole point of this server is that it holds no server code and
 *    can be pointed at a deployment it was not built beside;
 *  - the table's rows carry live zod schemas that import the server's own
 *    permission vocabulary, so the import would drag server modules into a
 *    process that must never contain any.
 *
 * So the route METADATA is mirrored here, and the drift is closed by a test
 * rather than by the type system: `cli/test-mcp.ts` parses the real table out
 * of the feature template and fails when any field below disagrees, and when a
 * route exists there that is neither a tool nor a listed exclusion. Without
 * that test this file would go stale silently — a model would call a tool for
 * a route that no longer exists and report the 404 as the user's mistake.
 *
 * The request SCHEMAS are not mirrored. They are imported from
 * `@starter/shared` in `tools.ts`, which is the same module the server
 * validates with, so a tightened limit reaches the tool list by itself.
 *
 * This module has no imports, on purpose: `cli/test-mcp.ts` runs outside this
 * workspace and must be able to load it without zod or the shared package
 * resolving.
 */

/** A scope gates a ROUTE. It is chosen when the token is minted and frozen. */
export type ApiTokenScope = "items:read" | "items:write" | "webhooks:read" | "webhooks:write";

/**
 * Every scope the API defines, in the order the server declares them.
 *
 * Not "every scope a tool needs": the two differ the moment the REST surface
 * grows a route this server has no tool for, and the README's capability table
 * documents what a credential can be minted with, not what this binary uses.
 */
export const API_TOKEN_SCOPES: readonly ApiTokenScope[] = [
  "items:read",
  "items:write",
  "webhooks:read",
  "webhooks:write",
];

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return typeof value === "string" && (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * Every event a webhook subscription can ask for.
 *
 * Mirrored for the same reason the table is, and from the same file the
 * server's `createWebhookSchema` reads it from
 * (`packages/server/src/services/webhooks/types.ts`) — it is server-side
 * vocabulary that `@starter/shared` does not carry, so there is nothing to
 * import. `cli/test-mcp.ts` pins it: without that, a model would be offered an
 * event name the server stopped accepting and every subscription it created
 * would be refused as invalid.
 */
export const WEBHOOK_EVENTS: readonly string[] = ["item.created", "item.updated", "item.deleted"];

export type ApiRoute = {
  method: "get" | "post" | "patch" | "delete";
  /** Express-style, relative to the versioned base path. */
  path: string;
  /** The scope the route requires, or null when any valid token may call it. */
  scope: ApiTokenScope | null;
  /** The server's own one-line summary, reused verbatim as the tool's description. */
  summary: string;
  /**
   * Where the request carries its input, and the NAME of the schema the server
   * validates it with. The name is what the pin test compares; the schema
   * itself is rebuilt in `tools.ts` from the shared validators.
   */
  input: { source: "query" | "body" | "path"; schema: string } | null;
  /** Callable with no token at all. */
  isPublic?: true;
};

/**
 * The table, in the server's own order.
 *
 * Order is not meaningful here — nothing is mounted from this copy — but it is
 * kept identical to the server's so a diff between the two is readable.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  {
    method: "get",
    path: "/openapi.json",
    scope: null,
    summary: "This API's OpenAPI 3.1 document.",
    input: null,
    isPublic: true,
  },
  {
    method: "get",
    path: "/me",
    scope: null,
    summary: "This token's own tenant, scopes and effective permissions.",
    input: null,
  },
  {
    method: "get",
    path: "/items",
    scope: "items:read",
    summary: "List items, newest first. Excludes other members' items without `items:view-others`.",
    input: { source: "query", schema: "itemListSchema" },
  },
  {
    method: "get",
    path: "/items/:id",
    scope: "items:read",
    summary: "One item. 404 for an id in another tenant, never 403.",
    input: { source: "path", schema: "idPathSchema" },
  },
  {
    method: "post",
    path: "/items",
    scope: "items:write",
    summary: "Create an item, owned by the member this token acts as.",
    input: { source: "body", schema: "createItemSchema" },
  },
  {
    method: "patch",
    path: "/items/:id",
    scope: "items:write",
    summary: "Edit an item. 403 for another member's item without `items:write-others`.",
    input: { source: "body", schema: "updateItemSchema" },
  },
  {
    method: "delete",
    path: "/items/:id",
    scope: "items:write",
    summary: "Delete an item. Same refusals as the edit.",
    input: { source: "path", schema: "idPathSchema" },
  },
  {
    method: "get",
    path: "/webhooks",
    scope: "webhooks:read",
    summary: "List this tenant's webhook subscriptions. Secrets are never echoed.",
    input: { source: "query", schema: "paginationSchema" },
  },
  {
    method: "post",
    path: "/webhooks",
    scope: "webhooks:write",
    summary: "Create a subscription. The signing secret is returned once, here, and never again.",
    input: { source: "body", schema: "createWebhookSchema" },
  },
  {
    method: "get",
    path: "/webhooks/:id/deliveries",
    scope: "webhooks:read",
    summary: "Recent delivery attempts for one subscription, newest first.",
    input: { source: "query", schema: "paginationSchema" },
  },
  {
    method: "delete",
    path: "/webhooks/:id",
    scope: "webhooks:write",
    summary: "Delete a subscription. Queued deliveries for it stop at their next attempt.",
    input: { source: "path", schema: "idPathSchema" },
  },
];

/** Look a route up by its method and path, or throw — a miss is a typo. */
export function route(method: ApiRoute["method"], path: string): ApiRoute {
  const found = API_ROUTES.find((row) => row.method === method && row.path === path);
  if (!found) throw new Error(`No route ${method.toUpperCase()} ${path} in the mirrored table.`);
  return found;
}
