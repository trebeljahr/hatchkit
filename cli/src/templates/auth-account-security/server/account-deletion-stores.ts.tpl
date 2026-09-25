/**
 * Where the cascade's steps actually land.
 *
 * Two stores, because the rows live in two places. App collections belong to
 * mongoose models. better-auth's own tables go through **its** adapter and
 * never through raw MongoDB — the adapter is what knows which of its fields it
 * stored as ObjectIds, and a raw query that guesses wrong silently matches
 * nothing, which in a deletion cascade reads as success.
 *
 * `routedRowStore` picks between them per collection so the plan never has to
 * care.
 */

__HATCHKIT_DELETION_MODEL_IMPORTS__
import {
  type AppCollection,
  type DeletionCollection,
  type DeletionFilterValue,
  isAuthCollection,
} from "./plan.js";
import type { DeletionRowStore } from "./delete-account.js";

/** Loose shape of better-auth's adapter — loose because the instance it comes
 *  from is typed `any` to keep two mongodb driver versions apart. */
export type AuthAdapterLike = {
  findMany: (args: {
    model: string;
    where: Array<{ field: string; value: unknown; operator?: string }>;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  deleteMany: (args: {
    model: string;
    where: Array<{ field: string; value: unknown; operator?: string }>;
  }) => Promise<unknown>;
};

// Rendered from the feature selection, so every name here has a model
// behind it. See plan.ts's APP_COLLECTIONS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const APP_MODELS: Record<AppCollection, any> = {
__HATCHKIT_DELETION_MODEL_MAP__
};

/** better-auth's model names for the tables the cascade reaches. */
const AUTH_MODELS = {
  authTwoFactors: "twoFactor",
  authVerifications: "verification",
} as const;

/** An empty filter matches the whole collection — every user's data. It is
 *  refused here rather than trusted never to be built, because the cost of
 *  being wrong once is unbounded and the cost of the check is nothing. */
function assertUsableFilter(filter: Record<string, DeletionFilterValue>): void {
  if (Object.keys(filter).length === 0) {
    throw new Error("account deletion: empty filter");
  }
}

export const mongooseRowStore: DeletionRowStore = {
  async find(collection, filter) {
    const model = appModel(collection);
    assertUsableFilter(filter);
    const rows = await model.find(filter).lean();
    return rows.map((row: Record<string, unknown>) => ({
      ...row,
      id: String(row._id ?? ""),
    }));
  },
  async deleteMany(collection, filter) {
    const model = appModel(collection);
    assertUsableFilter(filter);
    await model.deleteMany(filter);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appModel(collection: DeletionCollection): any {
  if (isAuthCollection(collection)) {
    throw new Error(`account deletion: ${collection} is an auth table`);
  }
  return APP_MODELS[collection];
}

export function authRowStore(adapter: AuthAdapterLike): DeletionRowStore {
  const model = (collection: DeletionCollection): string => {
    if (!isAuthCollection(collection)) {
      throw new Error(`account deletion: ${collection} is not an auth table`);
    }
    return AUTH_MODELS[collection];
  };

  const where = (
    collection: DeletionCollection,
    filter: Record<string, DeletionFilterValue>,
  ): Array<{ field: string; value: unknown; operator?: string }> => {
    assertUsableFilter(filter);
    return Object.entries(filter).map(([field, value]) => {
      if (value === null) {
        // Null filters express "not attached to anything", which is an app
        // modelling idea. Nothing in better-auth's tables uses one, so a null
        // here is a mistake rather than a query.
        throw new Error(`account deletion: null filter on auth field ${field}`);
      }
      if (typeof value === "object") {
        return { field, value: value.$in, operator: "in" };
      }
      return { field, value };
    });
  };

  return {
    async find(collection, filter) {
      return adapter.findMany({
        model: model(collection),
        where: where(collection, filter),
        limit: 10_000,
      });
    },
    async deleteMany(collection, filter) {
      await adapter.deleteMany({
        model: model(collection),
        where: where(collection, filter),
      });
    },
  };
}

export function routedRowStore(app: DeletionRowStore, auth: DeletionRowStore): DeletionRowStore {
  const pick = (collection: DeletionCollection): DeletionRowStore =>
    isAuthCollection(collection) ? auth : app;
  return {
    find: (collection, filter) => pick(collection).find(collection, filter),
    deleteMany: (collection, filter) => pick(collection).deleteMany(collection, filter),
  };
}
