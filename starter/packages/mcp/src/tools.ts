/*
 * The tool list, derived from the route table rather than restated beside it.
 *
 * Every tool names a row of `routes.ts` by identity — `route("get", "/items")`
 * throws when no such row exists — and the client builds its URL from that row
 * and nothing else. So a tool cannot address a path the public API does not
 * have, and `src/tests/tools.test.ts` can assert it structurally rather than
 * by matching strings.
 *
 * ── Input schemas come from the shared validators ───────────────────
 *
 * `@starter/shared` is the module the SERVER validates these requests with. A
 * hand-written tool schema would be a second place a limit or a format goes
 * stale, and the drift shows up as a model confidently sending an argument the
 * server rejects — the model then reports its own argument as the user's
 * mistake. So each shape below is assembled from those exported objects, and
 * the only schemas declared here are the ones the server also declares in its
 * route table (the id path parameter, the list filter, the webhook body).
 *
 * ── Two traps in that assembly ──────────────────────────────────────
 *
 *  1. `.default()` SURVIVES `.optional()`. `paginationSchema.limit` carries
 *     `.default(20)`, and a shape that passes it through pins the page size at
 *     this build's idea of the default forever: the model omits `limit`, zod
 *     fills 20, and the tool sends `limit=20` explicitly — so the server's own
 *     default can never apply again, and raising it changes nothing for any
 *     model. {@link optionalWithoutDefault} unwraps it first, which is what
 *     makes "omitted" mean "let the server decide".
 *  2. A refined object refuses `.omit()`. None of these are refined today, so
 *     they are read through `.shape` anyway — the field map is the only access
 *     that keeps working when one of them gains a cross-field rule.
 *
 * ── Ambiguous boundary values ───────────────────────────────────────
 *
 * The invariant this file would otherwise implement — resolve a loosely-typed
 * `from`/`to` boundary IN THE TOOL, in the caller's zone, and send fully
 * qualified timestamps, because two routes can read a bare date differently —
 * has nothing to apply to. No route in `routes.ts` takes a date boundary: the
 * only filters the surface exposes are a cursor, a page size and an item
 * status. Shipping the resolver anyway would be untested, unreachable code
 * that the first real date route would not use.
 *
 * What stops that from going unnoticed is the pin test: `cli/test-mcp.ts`
 * fails on any route the server has that this file does not account for, so a
 * `from`/`to` parameter appearing on the REST surface stops the build, and the
 * rule to apply then is the one stated here — read the ROUTE's documented
 * convention (the server's own routes may disagree about whether a bare `to`
 * is midnight or end-of-day) and convert to it in the tool, never forward the
 * bare value.
 */

import { createItemSchema, paginationSchema, updateItemSchema } from "@starter/shared";
import { z } from "zod";
import type { RestClient } from "./client.js";
import {
  API_TOKEN_SCOPES,
  type ApiRoute,
  type ApiTokenScope,
  WEBHOOK_EVENTS,
  route,
} from "./routes.js";

/* ================================================================== */
/* Schema fragments                                                   */
/* ================================================================== */

/**
 * A field that may be omitted, with any default stripped first.
 *
 * See trap (1) in the header. `.unwrap()` on a `ZodDefault` returns the schema
 * the default wraps; anything else is passed through untouched.
 */
function optionalWithoutDefault<T extends z.ZodTypeAny>(schema: T): z.ZodTypeAny {
  const inner = schema instanceof z.ZodDefault ? (schema.unwrap() as z.ZodTypeAny) : schema;
  return inner.optional();
}

/** `{ id }`, the server's `idPathSchema`. */
const idField = z.string().min(1).describe("The record's id, as a read returned it.");

const cursorField = optionalWithoutDefault(paginationSchema.shape.cursor).describe(
  "Continue from the `nextCursor` of a previous page. Omit for the first page.",
);

const limitField = optionalWithoutDefault(paginationSchema.shape.limit).describe(
  "How many records to return. Omit to let the server choose; it caps the value.",
);

/** The list filter: the shared pagination plus the status the server's table adds. */
const itemListShape = {
  cursor: cursorField,
  limit: limitField,
  // Read off the shared validator rather than re-spelled, so a new status
  // reaches the tool list without anybody editing this file.
  status: updateItemSchema.shape.status.describe("Only items in this state."),
};

const paginationShape = { cursor: cursorField, limit: limitField };

/* ================================================================== */
/* Tool definitions                                                   */
/* ================================================================== */

export type ToolContext = {
  client: RestClient;
  /**
   * The scopes the credential is KNOWN to carry, or null when the probe
   * failed. Null means "unknown", never "none": a tool reads it only to decide
   * whether an optional enrichment lookup is worth attempting.
   */
  scopes: readonly ApiTokenScope[] | null;
};

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Every one of these reaches a server this process does not control. */
  openWorldHint: true;
};

export type ToolDefinition = {
  name: string;
  title: string;
  /** The row this tool calls. Identity-equal to an entry in `API_ROUTES`. */
  route: ApiRoute;
  annotations: ToolAnnotations;
  inputShape: z.ZodRawShape;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
};

/** Build a definition with a typed `run`, then erase the shape for the list. */
function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  route: ApiRoute;
  annotations: ToolAnnotations;
  inputShape: S;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** True when the credential is KNOWN to carry `scope`. Unknown is not true. */
function canUse(ctx: ToolContext, scope: ApiTokenScope): boolean {
  return ctx.scopes?.includes(scope) === true;
}

/**
 * Read an item's title before it is deleted, or give up quietly.
 *
 * An optional enrichment, and it carries both halves of that word. It is
 * GATED on the probed capability set, because a write-only credential cannot
 * read and attempting it would spend a request to produce a refusal nobody
 * asked for. And its failure is DROPPED rather than reported: the delete is
 * what the caller asked for, the delete succeeded, and a result that led with
 * "could not read the title" would be paraphrased to the user as a failure.
 *
 * It runs BEFORE the delete for the obvious reason — afterwards the row is
 * gone — which is also why it cannot be shared with `delete_webhook`: the
 * public surface has no single-subscription read, and paging the tenant's
 * whole subscription list to decorate one delete is not a lookup, it is a
 * scan.
 */
async function titleBeforeDelete(ctx: ToolContext, id: string): Promise<string | undefined> {
  if (!canUse(ctx, "items:read")) return undefined;
  try {
    const answer = await ctx.client.request<{ data?: { title?: unknown } }>({
      route: route("get", "/items/:id"),
      params: { id },
    });
    return typeof answer.data?.title === "string" ? answer.data.title : undefined;
  } catch {
    return undefined;
  }
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  defineTool({
    name: "get_token_info",
    title: "Token info",
    route: route("get", "/me"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    run: (ctx) => ctx.client.request({ route: route("get", "/me") }),
  }),

  defineTool({
    name: "list_items",
    title: "List items",
    route: route("get", "/items"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: itemListShape,
    run: (ctx, args) =>
      ctx.client.request({
        route: route("get", "/items"),
        query: { cursor: args.cursor, limit: args.limit, status: args.status },
      }),
  }),

  defineTool({
    name: "get_item",
    title: "Get one item",
    route: route("get", "/items/:id"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: { id: idField },
    run: (ctx, args) =>
      ctx.client.request({ route: route("get", "/items/:id"), params: { id: args.id } }),
  }),

  defineTool({
    name: "create_item",
    title: "Create an item",
    route: route("post", "/items"),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Two identical calls create two records, which is what a model has to
      // know before it retries one that timed out.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: createItemSchema.shape,
    run: (ctx, args) => ctx.client.request({ route: route("post", "/items"), body: args }),
  }),

  defineTool({
    name: "update_item",
    title: "Edit an item",
    route: route("patch", "/items/:id"),
    annotations: {
      readOnlyHint: false,
      // It overwrites fields, but the record survives and the change can be
      // made again — that is what `destructive` asks about.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: updateItemSchema.shape,
    run: (ctx, args) =>
      // The id travels in the path AND stays in the body: the server's own
      // validator requires it there (tRPC has no path to carry it), and the
      // route hands the PATH id the final say, so the two can never disagree.
      ctx.client.request({
        route: route("patch", "/items/:id"),
        params: { id: args.id },
        body: args,
      }),
  }),

  defineTool({
    name: "delete_item",
    title: "Delete an item",
    route: route("delete", "/items/:id"),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: { id: idField },
    run: async (ctx, args) => {
      const title = await titleBeforeDelete(ctx, args.id);
      const answer = await ctx.client.request<Record<string, unknown>>({
        route: route("delete", "/items/:id"),
        params: { id: args.id },
      });
      return title === undefined ? answer : { ...answer, deletedTitle: title };
    },
  }),

  defineTool({
    name: "list_webhooks",
    title: "List webhook subscriptions",
    route: route("get", "/webhooks"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: paginationShape,
    run: (ctx, args) =>
      ctx.client.request({
        route: route("get", "/webhooks"),
        query: { cursor: args.cursor, limit: args.limit },
      }),
  }),

  defineTool({
    name: "create_webhook",
    title: "Create a webhook subscription",
    route: route("post", "/webhooks"),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      url: z.url().max(2000).describe("HTTPS endpoint this tenant's events are posted to."),
      events: z
        .array(z.string().min(1))
        .min(1)
        .describe(`One or more of: ${WEBHOOK_EVENTS.join(", ")}.`),
    },
    run: (ctx, args) =>
      ctx.client.request({
        route: route("post", "/webhooks"),
        body: { url: args.url, events: args.events },
      }),
  }),

  defineTool({
    name: "list_webhook_deliveries",
    title: "List delivery attempts",
    route: route("get", "/webhooks/:id/deliveries"),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: { id: idField, ...paginationShape },
    run: (ctx, args) =>
      ctx.client.request({
        route: route("get", "/webhooks/:id/deliveries"),
        params: { id: args.id },
        query: { cursor: args.cursor, limit: args.limit },
      }),
  }),

  defineTool({
    name: "delete_webhook",
    title: "Delete a webhook subscription",
    route: route("delete", "/webhooks/:id"),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: { id: idField },
    run: (ctx, args) =>
      ctx.client.request({ route: route("delete", "/webhooks/:id"), params: { id: args.id } }),
  }),
];

/**
 * The capability-to-tool table, as the README publishes it.
 *
 * Generated from {@link TOOL_DEFINITIONS} and compared against the README by
 * `src/tests/docs.test.ts`, because that table is what a person reads when
 * deciding which capabilities to put on a token. Overstate it and they grant
 * more than they need; understate it and a correctly minted token looks
 * broken. Neither failure shows up anywhere except in their hands.
 *
 * A capability with no tools gets no row: a line claiming a capability that
 * unlocks nothing is a reason to grant it for no benefit.
 */
export function renderCapabilityTable(): string {
  const lines = ["| Capability | Tools |", "| --- | --- |"];
  const named = (scope: ApiTokenScope | null): string[] =>
    TOOL_DEFINITIONS.filter((tool) => tool.route.scope === scope).map(
      (tool) => `\`${tool.name}\``,
    );

  const free = named(null);
  if (free.length > 0) lines.push(`| _none — any valid token_ | ${free.join(", ")} |`);
  for (const scope of API_TOKEN_SCOPES) {
    const tools = named(scope);
    if (tools.length > 0) lines.push(`| \`${scope}\` | ${tools.join(", ")} |`);
  }
  return lines.join("\n");
}

/**
 * Routes this server deliberately offers no tool for, and why.
 *
 * Not a comment: `cli/test-mcp.ts` requires every row of the real route table
 * to be either a tool or an entry here, so a route added to the REST surface
 * stops the build until somebody decides which of the two it is. Without that,
 * a new route would simply never get a tool and nobody would notice.
 */
export const UNTOOLED_ROUTES: readonly { method: string; path: string; reason: string }[] = [
  {
    method: "get",
    path: "/openapi.json",
    reason:
      "The spec document describes the surface instead of carrying data, and this server's own tool list is the description a model needs. Offering it would spend a turn and a large result to tell the model what it already has.",
  },
];
