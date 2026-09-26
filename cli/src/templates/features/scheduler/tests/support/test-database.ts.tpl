// A real MongoDB for the few unit tests whose subject IS the database's
// behaviour: an atomic claim racing another, a unique index, a filter that has
// to match an absent field. A stub of `findOneAndUpdate` would only test the
// stub — and the scheduler's whole correctness argument is "Mongo applies the
// second update to the document the first one already changed".
//
// Opt-in through TEST_MONGODB_URI, because the rest of the unit suite needs no
// database at all. Without it these files skip with the reason printed, rather
// than failing on a machine with no Mongo running. Set it in CI:
//
//   TEST_MONGODB_URI=mongodb://127.0.0.1:27017 pnpm --filter __HATCHKIT_SERVER_PKG__ test
//
// Every file connects to a database of its OWN, named here and dropped after,
// so the URI may point at a shared server: nothing outside that database is
// read or written, and two files running in parallel processes never meet.
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

const uri = (process.env.TEST_MONGODB_URI ?? "").trim();

/** The prefix every throwaway database gets. `dropTestDatabase` refuses to
 *  drop anything without it, so a test that somehow ran against a real
 *  connection cannot delete a real database. */
const DB_PREFIX = "hatchkit-test-";

/**
 * `false` when a database is available, else the reason to skip. Pass it as
 * `describe(name, { skip: skipWithoutDatabase }, ...)`.
 */
export const skipWithoutDatabase: false | string = uri
  ? false
  : "TEST_MONGODB_URI is not set (e.g. mongodb://127.0.0.1:27017)";

/** Structural, so a caller passes `[ScheduledJob]` without casting through
 *  `mongoose.Model<never>` — the generic parameter differs per model and a
 *  cast in every test file is noise that hides a real type error. */
export type SyncableModel = { syncIndexes: () => Promise<unknown> };

/**
 * Connect mongoose to a fresh database for this file and build the indexes of
 * the given models, which the tests usually depend on (here: the unique job
 * name that makes the seeding upsert safe).
 */
export async function connectTestDatabase(
  label: string,
  models: readonly SyncableModel[] = [],
): Promise<void> {
  const dbName = `${DB_PREFIX}${label}-${randomUUID().slice(0, 8)}`;
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  for (const model of models) {
    await model.syncIndexes();
  }
}

/** Drop this file's database and disconnect. */
export async function dropTestDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const dbName = mongoose.connection.db?.databaseName ?? "";
  // The name was generated above; refuse anything else rather than trusting
  // that nothing reconnected mongoose somewhere in between.
  if (dbName.startsWith(DB_PREFIX)) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
}

/** Empty every collection, between cases. */
export async function clearTestDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const collection of await db.collections()) {
    await collection.deleteMany({});
  }
}
