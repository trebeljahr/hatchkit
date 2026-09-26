// Builds every declared index at boot and says which failed.
//
// Mongoose starts the same build when a model registers, but swallows the
// result (`Model.init()`'s rejection is caught with a no-op), so a unique index
// that could NOT be built — because duplicates already exist — leaves the
// invariant it was there to enforce unguarded, with nothing in the log. Here
// each index is created on its own, every failure is reported with the model,
// the key pattern and the reason, and a failure on an invariant the app relies
// on stops the boot.
//
// NEVER `syncIndexes()`. It drops every index the current schema does not
// declare, which includes every index a NEWER release added. One old container
// still draining during a deploy, or one rollback, and the new release's
// indexes are gone — and nothing reports it, because dropping succeeded.
//
// The builds run on the raw driver for the same reason migrations do: the
// options mongoose hands back from `schema.indexes()` are already in driver
// form, and going through the driver keeps one code path for building and one
// for inspecting.
import type { CreateIndexesOptions, Db, IndexSpecification } from "mongodb";
import type mongoose from "mongoose";

export type IndexKeys = Record<string, unknown>;

export type IndexOutcome = {
  model: string;
  collection: string;
  keys: IndexKeys;
  unique: boolean;
  /** A failure here stops the boot. */
  critical: boolean;
  /** Null when the index exists or was built. */
  error: string | null;
};

/**
 * The indexes whose absence corrupts data rather than slowing a query.
 *
 * Keep this list short and keep it honest. A unique index is the only thing
 * standing between "one profile per user" and two profiles that both claim to
 * be the current one; losing it is a wrong answer the app cannot detect, let
 * alone recover from, so the server refuses to serve. Every other index is a
 * performance promise: missing, the query is slow, and booting anyway is the
 * better outcome.
 *
 * Add an entry when a new unique index guards an invariant; do NOT add a
 * lookup index here, or one duplicate row somewhere takes the whole instance
 * down for a problem a warning would have described.
 */
export const CRITICAL_INDEXES: readonly { model: string; keys: IndexKeys }[] = [
  { model: "Profile", keys: { userId: 1 } },
];

export const sameKeys = (a: IndexKeys, b: IndexKeys): boolean =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

export function isCritical(
  model: string,
  keys: IndexKeys,
  critical: readonly { model: string; keys: IndexKeys }[] = CRITICAL_INDEXES,
): boolean {
  return critical.some((entry) => entry.model === model && sameKeys(entry.keys, keys));
}

/** Mongoose stores bookkeeping of its own alongside the driver options it
 *  passes through. Anything underscore-prefixed is its, not the driver's. */
function driverIndexOptions(options: Record<string, unknown>): CreateIndexesOptions {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key.startsWith("_")) continue;
    out[key] = value;
  }
  return out as CreateIndexesOptions;
}

/** Build each declared index of each model, one at a time, and collect what
 *  happened. Nothing throws: a caller decides which failures are fatal. */
export async function buildModelIndexes(
  db: Db,
  models: readonly mongoose.Model<unknown>[],
  critical: readonly { model: string; keys: IndexKeys }[] = CRITICAL_INDEXES,
): Promise<IndexOutcome[]> {
  const outcomes: IndexOutcome[] = [];
  for (const model of models) {
    // Let mongoose's own automatic build finish first, so two builds of one
    // index do not race. Its error is swallowed here and surfaces below as the
    // failure of the explicit build, which reports it properly.
    await model.init().catch(() => undefined);
    const collection = model.collection.collectionName;
    for (const [keys, options] of model.schema.indexes() as [
      IndexKeys,
      Record<string, unknown>,
    ][]) {
      let error: string | null = null;
      try {
        await db
          .collection(collection)
          .createIndex(keys as IndexSpecification, driverIndexOptions(options));
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      outcomes.push({
        model: model.modelName,
        collection,
        keys,
        unique: options.unique === true,
        critical: isCritical(model.modelName, keys, critical),
        error,
      });
    }
  }
  return outcomes;
}

export function describeIndex(outcome: Pick<IndexOutcome, "model" | "keys" | "unique">): string {
  return `${outcome.model} ${JSON.stringify(outcome.keys)}${outcome.unique ? " (unique)" : ""}`;
}

/** Log every failure. Returns the critical ones, for the caller to refuse the
 *  boot over. */
export function reportIndexOutcomes(
  outcomes: readonly IndexOutcome[],
  logger: { warn: (message: string) => void; error: (message: string) => void },
): IndexOutcome[] {
  const fatal: IndexOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.error === null) continue;
    if (outcome.critical) {
      fatal.push(outcome);
      logger.error(`[db] Index ${describeIndex(outcome)} could not be built: ${outcome.error}`);
    } else {
      logger.warn(
        `[db] Index ${describeIndex(outcome)} could not be built; queries still work, more ` +
          `slowly or without this guarantee: ${outcome.error}`,
      );
    }
  }
  return fatal;
}

/**
 * Which declared indexes exist, without building anything — `admin doctor`
 * diagnoses a database, it must not write to one.
 *
 * An index counts as present when one with the same key pattern and the same
 * uniqueness exists. The name is deliberately not compared: an operator may
 * have built the same index by hand under a name of their own, and reporting
 * that as missing sends them to fix something that is already right.
 */
export async function inspectModelIndexes(
  db: Db,
  models: readonly mongoose.Model<unknown>[],
  critical: readonly { model: string; keys: IndexKeys }[] = CRITICAL_INDEXES,
): Promise<IndexOutcome[]> {
  const outcomes: IndexOutcome[] = [];
  for (const model of models) {
    const collection = model.collection.collectionName;
    let existing: { key: IndexKeys; unique?: boolean }[] = [];
    try {
      existing = (await db.collection(collection).listIndexes().toArray()) as typeof existing;
    } catch (error) {
      // 26 NamespaceNotFound: a collection nothing has written to yet. Every
      // declared index is missing, which is what the loop below records.
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 26) throw error;
    }
    for (const [keys, options] of model.schema.indexes() as [
      IndexKeys,
      Record<string, unknown>,
    ][]) {
      const unique = options.unique === true;
      const present = existing.some(
        (index) => sameKeys(index.key, keys) && (index.unique === true) === unique,
      );
      outcomes.push({
        model: model.modelName,
        collection,
        keys,
        unique,
        critical: isCritical(model.modelName, keys, critical),
        error: present ? null : "missing",
      });
    }
  }
  return outcomes;
}
