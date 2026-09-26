import { z } from "zod";
import { createItemSchema } from "__HATCHKIT_SHARED_PKG__";
import {
  createItem,
  deleteItem,
  getItem,
  listItems,
} from "../../services/items/index.js";
import { scopeForSession } from "../../services/tenancy.js";
import { protectedProcedure, router } from "../trpc.js";
// ── client-core ──────────────────────────────────────────────────
// Both of these belong to the block below, so they are imported inside a
// marked block of their own. Left in the import lists above they would
// survive a strip as dangling names — which is the leftover the marker
// convention exists to prevent, and the starter splits its own
// `__HATCHKIT_SHARED_PKG__` import the same way.
import { updateItemSchema } from "__HATCHKIT_SHARED_PKG__";
import { updateItem } from "../../services/items/index.js";
// ── end client-core ──────────────────────────────────────────────

/**
 * The typed item API — a translation layer over `services/items/`, and nothing
 * more.
 *
 * The logic used to live here. It was extracted so that the public REST
 * surface (`src/api/v1/routes/items.ts`) could call the SAME functions instead
 * of re-implementing them, which is what stops the two from drifting: a REST
 * create runs the same ownership check, writes the same document and publishes
 * the same events as this one, because it is the same function.
 *
 * It also means a token request never enters tRPC. There is no synthetic
 * context and no token path through `protectedProcedure` — the REST layer
 * builds its own `TenantScope` from the token row and calls the service
 * directly, so it never reaches a place where a tenant id could come from
 * request input.
 *
 * Nothing here announces a change. `services/items/events.ts` does, so a
 * record written through `/api/v1` reaches this person's other devices exactly
 * as one written here does — a publish spelled out per resolver is a publish
 * the other surface does not make.
 *
 * Keep this file boring. A rule added here and not in the service is a rule
 * the REST surface does not have.
 */
export const itemsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        status: z.enum(["draft", "published", "archived"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = await listItems(scopeForSession(ctx.user), input);
      // `undefined` rather than the service's `null`, because that is the
      // shape this procedure has always returned and tRPC's infinite-query
      // helpers on the client are written against it. REST answers `null`,
      // where an always-present field is what a paging client needs.
      return { items: page.items, nextCursor: page.nextCursor ?? undefined };
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => getItem(scopeForSession(ctx.user), input.id)),

  create: protectedProcedure
    .input(createItemSchema)
    .mutation(async ({ ctx, input }) => createItem(scopeForSession(ctx.user), input)),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => deleteItem(scopeForSession(ctx.user), input.id)),

  // ── client-core ────────────────────────────────────────────────────
  /**
   * Edit a record's title, description or status.
   *
   * This procedure is the ADDITIVE change that API level 2 records in
   * `API_LEVEL_CHANGES` (packages/shared/src/api-level.ts), and the reason the
   * `items.update` capability exists: a client built against level 2 must not
   * call this on a self-hosted server still at level 1, which answers
   * NOT_FOUND for a path it has never heard of. `serverSupports("items.update",
   * level)` is how a client asks before it offers the button.
   *
   * Only the fields the request actually sent are applied — `updateItem`
   * enforces that, so the partial-update rule holds for the REST route too. An
   * absent field is "leave it alone", never "clear it": a partial update that
   * nulls what it omits deletes a description every time somebody renames a
   * record from a client that only sends the title.
   */
  update: protectedProcedure
    .input(updateItemSchema)
    .mutation(async ({ ctx, input }) => updateItem(scopeForSession(ctx.user), input)),
  // ── end client-core ────────────────────────────────────────────────
});
