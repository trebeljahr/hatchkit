import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { createItemSchema, paginationSchema } from "__HATCHKIT_SHARED_PKG__";
import { Item } from "../../models/Item.js";
// ── client-core ──────────────────────────────────────────────────
import { updateItemSchema } from "__HATCHKIT_SHARED_PKG__";
import { publishSync } from "../../sync/feed.js";
// ── end client-core ──────────────────────────────────────────────

export const itemsRouter = router({
  list: protectedProcedure.input(paginationSchema).query(async ({ ctx, input }) => {
    const query: Record<string, unknown> = { ownerId: ctx.user.id };
    if (input.cursor) {
      query._id = { $lt: input.cursor };
    }

    const items = await Item.find(query)
      .sort({ _id: -1 })
      .limit(input.limit + 1)
      .lean();

    const hasMore = items.length > input.limit;
    if (hasMore) items.pop();

    return {
      items: items.map((item) => ({
        id: String(item._id),
        title: item.title,
        description: item.description,
        status: item.status,
        ownerId: item.ownerId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      nextCursor: hasMore ? String(items[items.length - 1]._id) : undefined,
    };
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const item = await Item.findById(input.id).lean();
      if (!item || item.ownerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return {
        id: String(item._id),
        title: item.title,
        description: item.description,
        status: item.status,
        ownerId: item.ownerId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    }),

  create: protectedProcedure
    .input(createItemSchema)
    .mutation(async ({ ctx, input }) => {
      const item = await Item.create({
        ...input,
        ownerId: ctx.user.id,
      });
      // ── client-core ──────────────────────────────────────────────
      // Tell this person's other devices, so a record created on a laptop
      // appears on a phone without the phone polling for it. Published with the
      // user id the mutation RAN AS — never a value off the input — because the
      // feed's room is the authenticated user and nothing else (sync/feed.ts).
      publishSync(ctx.user.id, { kind: "items.changed", id: String(item._id) });
      // ── end client-core ──────────────────────────────────────────
      return {
        id: String(item._id),
        title: item.title,
        description: item.description,
        status: item.status,
        ownerId: item.ownerId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const item = await Item.findById(input.id);
      if (!item || item.ownerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await item.deleteOne();
      // ── client-core ──────────────────────────────────────────────
      // A delete is the change a device most needs to hear about: a record that
      // is gone on the server and still on screen elsewhere is the one a person
      // will try to open.
      publishSync(ctx.user.id, { kind: "items.changed", id: input.id });
      // ── end client-core ──────────────────────────────────────────
      return { success: true };
    }),

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
   * Only the fields the request actually sent are applied. An absent field is
   * "leave it alone", never "clear it" — a partial update that nulls what it
   * omits deletes a description every time somebody renames a record from a
   * client that only sends the title.
   */
  update: protectedProcedure
    .input(updateItemSchema)
    .mutation(async ({ ctx, input }) => {
      const item = await Item.findById(input.id);
      // A record of somebody else's answers NOT_FOUND, not FORBIDDEN: a
      // FORBIDDEN would confirm the id exists. Same rule as `get` and `delete`.
      if (!item || item.ownerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (input.title !== undefined) item.title = input.title;
      if (input.description !== undefined) item.description = input.description;
      if (input.status !== undefined) item.status = input.status;
      await item.save();

      publishSync(ctx.user.id, { kind: "items.changed", id: String(item._id) });

      return {
        id: String(item._id),
        title: item.title,
        description: item.description,
        status: item.status,
        ownerId: item.ownerId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    }),
  // ── end client-core ────────────────────────────────────────────────
});
