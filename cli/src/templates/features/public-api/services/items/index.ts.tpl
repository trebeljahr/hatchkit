// Everything an item write or read actually does, extracted out of the tRPC
// resolvers so that there is exactly one copy of it.
//
// This module is the reason the REST surface never enters tRPC. A token
// request authenticates in `api/v1/auth.ts`, builds a `TenantScope`, and calls
// these functions — the same ones `trpc/routers/items.ts` calls. There is no
// synthetic tRPC context and no token path through `protectedProcedure`, so a
// token request never reaches a place where a tenant id could be read from
// input. "A token can never name a tenant of its own" is therefore structural:
// the code that would read one does not exist on that path.
//
// It also means the two surfaces cannot drift. A REST create runs the same
// ownership check, writes the same document and publishes the same event as a
// typed one, because it IS the same function.
//
// Errors are `TRPCError`s even though half the callers are not tRPC. One error
// taxonomy, mapped to HTTP in `api/v1/problem.ts` and to a tRPC code by the
// adapter — a second bespoke error class here would be a second mapping to
// keep in step, and the first refusal somebody forgets to map becomes a 500.
import { TRPCError } from "@trpc/server";
import type { Item as ItemWire } from "__HATCHKIT_SHARED_PKG__";
import { Item } from "../../models/Item.js";
import { has } from "../../auth/api-permissions.js";
import type { TenantScope } from "../tenancy.js";
import { publishItemEvent } from "./events.js";

/** The page size a caller gets when they ask for none. Matches `paginationSchema`. */
const DEFAULT_LIMIT = 20;

/** A lean `Item` document, as mongoose hands it back. */
type ItemRow = {
  _id: unknown;
  title: string;
  description?: string;
  status: ItemWire["status"];
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The wire shape, in one place.
 *
 * Both surfaces serialize through this, so a field added to the model appears
 * in both or in neither. The REST response schema in `routes-table.ts` is
 * pinned to the same `Item` type, so dropping a field here stops the build
 * there rather than quietly shrinking a documented response.
 */
export function toItemWire(row: ItemRow): ItemWire {
  return {
    id: String(row._id),
    title: row.title,
    description: row.description,
    status: row.status,
    ownerId: row.ownerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The owners whose rows this scope may READ.
 *
 * Without `items:view-others` that is the actor alone — and the effect is that
 * a colleague's item is absent from a list and 404s on a direct read, rather
 * than appearing with fields blanked out. Existence is the thing this
 * permission withholds; a 403 would confirm the id is real.
 */
function readableOwnerIds(scope: TenantScope): readonly string[] {
  return has(scope.permissions, "items:view-others") ? scope.memberIds : [scope.actorId];
}

/**
 * The refusal for an id this scope may not read.
 *
 * NOT_FOUND, always — for a row in another tenant, for a row this scope may
 * not see, and for an id that never existed. A 403 on a foreign id confirms
 * the id exists somewhere, which turns every read endpoint into an enumeration
 * oracle. 403 is reserved for a refusal on a row this tenant genuinely owns
 * and this caller can genuinely see.
 */
function notFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "No such item." });
}

export type ListItemsInput = {
  cursor?: string;
  limit?: number;
  status?: ItemWire["status"];
};

export type ItemPage = {
  items: ItemWire[];
  /** Always present. `null` on the last page, never omitted. */
  nextCursor: string | null;
};

/**
 * A page of items, newest first.
 *
 * Keyset paging on `_id`, not `skip`: an offset re-reads and re-sorts
 * everything it skips, and it silently drops or repeats a row whenever
 * something is inserted between two pages.
 */
export async function listItems(
  scope: TenantScope,
  input: ListItemsInput = {},
): Promise<ItemPage> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const query: Record<string, unknown> = { ownerId: { $in: readableOwnerIds(scope) } };
  if (input.status) query.status = input.status;
  if (input.cursor) query._id = { $lt: input.cursor };

  // One more than asked for: the extra row is how "is there another page"
  // is answered without a second count query over the same filter.
  const rows = (await Item.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean()) as unknown as ItemRow[];

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];

  return {
    items: rows.map(toItemWire),
    nextCursor: hasMore && last ? String(last._id) : null,
  };
}

export async function getItem(scope: TenantScope, id: string): Promise<ItemWire> {
  // A malformed id is a 404 and not a 500: `findById` throws a CastError on
  // anything that is not an ObjectId, and letting that reach the error handler
  // would turn "you guessed a bad id" into an internal error — and, outside
  // production, into a mongoose message in the response body.
  const row = (await Item.findById(id)
    .lean()
    .catch(() => null)) as ItemRow | null;
  if (!row) throw notFound();
  if (!readableOwnerIds(scope).includes(row.ownerId)) throw notFound();
  return toItemWire(row);
}

export type CreateItemInput = {
  title: string;
  description?: string;
};

export async function createItem(
  scope: TenantScope,
  input: CreateItemInput,
): Promise<ItemWire> {
  // Owned by the ACTOR, never by anything in the payload. There is no input
  // field an owner could be set from, on either surface.
  const created = await Item.create({ ...input, ownerId: scope.actorId });
  const item = toItemWire(created as unknown as ItemRow);
  publishItemEvent(scope, "item.created", { kind: "item", item });
  return item;
}

export type UpdateItemInput = {
  id: string;
  title?: string;
  description?: string;
  status?: ItemWire["status"];
};

/**
 * Edit an item.
 *
 * The two refusals are different on purpose. An item this scope may not READ
 * is a 404 — it may as well not exist. An item it may read but may not WRITE
 * is a 403: the tenant owns the row, the caller can see it, and what they are
 * being told about is a permission. That is the only honest 403 in the item
 * surface, and collapsing it into a 404 would have an integrator debug a
 * missing record that is sitting right there in their list response.
 */
export async function updateItem(
  scope: TenantScope,
  input: UpdateItemInput,
): Promise<ItemWire> {
  const existing = (await Item.findById(input.id)
    .lean()
    .catch(() => null)) as ItemRow | null;
  if (!existing) throw notFound();
  if (!readableOwnerIds(scope).includes(existing.ownerId)) throw notFound();
  if (existing.ownerId !== scope.actorId && !has(scope.permissions, "items:write-others")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This item belongs to another member and this caller may not edit it.",
    });
  }

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;

  const updated = (await Item.findByIdAndUpdate(input.id, { $set: patch }, { new: true })
    .lean()
    .catch(() => null)) as ItemRow | null;
  // Deleted between the read and the write. A 404 rather than a 500: the
  // caller's request is now simply about something that is gone.
  if (!updated) throw notFound();

  const item = toItemWire(updated);
  publishItemEvent(scope, "item.updated", { kind: "item", item });
  return item;
}

export type DeleteItemResult = { success: true; id: string };

export async function deleteItem(
  scope: TenantScope,
  id: string,
): Promise<DeleteItemResult> {
  const existing = (await Item.findById(id)
    .lean()
    .catch(() => null)) as ItemRow | null;
  if (!existing) throw notFound();
  if (!readableOwnerIds(scope).includes(existing.ownerId)) throw notFound();
  if (existing.ownerId !== scope.actorId && !has(scope.permissions, "items:write-others")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This item belongs to another member and this caller may not delete it.",
    });
  }

  await Item.deleteOne({ _id: id });
  // `ownerId` rides along on the event because the row is gone: at send time
  // the visibility projection still has to answer "may this subscriber be told
  // about this?", and the payload is the only place left to ask.
  publishItemEvent(scope, "item.deleted", {
    kind: "item-deleted",
    itemId: String(existing._id),
    ownerId: existing.ownerId,
  });
  return { success: true, id: String(existing._id) };
}
