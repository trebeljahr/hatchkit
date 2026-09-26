import type { Migration } from "./types.js";

/**
 * Records that a database existed when the runner was introduced.
 *
 * It changes nothing. Its job is to give every database a row, so `admin
 * migrate --status` on a pre-existing instance prints a history rather than
 * looking like a database nobody has ever migrated.
 *
 * `minReaderSchema: 0` — every release can read the result, including the ones
 * built before this runner existed. That is the value a migration keeps unless
 * it rewrites a shape older code would misread; see `types.ts`.
 *
 * Write the next one as `002-<what-it-does>.ts` and append it to
 * `registry.ts`. A template:
 *
 *     export const backfillItemSlugs: Migration = {
 *       id: 2,
 *       description: "backfill Item.slug from Item.title",
 *       minReaderSchema: 0,           // additive: older builds ignore the field
 *       up: async (db) => {
 *         // Raw driver, and idempotent: the filter excludes rows a previous,
 *         // interrupted run already did, so re-running is a no-op.
 *         const items = db.collection("items");
 *         for await (const item of items.find({ slug: { $exists: false } })) {
 *           await items.updateOne({ _id: item._id }, { $set: { slug: slugify(item.title) } });
 *         }
 *       },
 *     };
 */
export const baseline: Migration = {
  id: 1,
  description: "baseline: record the schema as of the first release with a migration runner",
  minReaderSchema: 0,
  up: async () => {},
};
