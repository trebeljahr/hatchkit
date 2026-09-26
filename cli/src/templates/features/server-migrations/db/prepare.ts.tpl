// Everything the database needs between connecting and serving: migrations,
// then indexes. Both finish before `listen`, so no request ever runs against a
// schema this build has not checked.
//
// The order is not cosmetic. A migration may be the thing that removes the
// duplicate rows a unique index below would otherwise fail to build on, so
// migrations run first; and both run before Redis, auth and the HTTP server,
// because a build that must not read this database should find that out
// before it opens anything else.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { allModels } from "../models/registry.js";
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from "../services/migrations/index.js";
import { buildModelIndexes, describeIndex, reportIndexOutcomes } from "./indexes.js";

/**
 * A reason the server must not start, stated for whoever reads the log. The
 * caller prints only the message for these — a stack trace buries the one
 * sentence that says what to do.
 */
export class BootRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootRefusedError";
  }
}

export async function prepareDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("prepareDatabase() needs a connected mongoose");

  const applied = await runMigrations({
    db,
    migrations: MIGRATIONS,
    schemaVersion: SCHEMA_VERSION,
    // Unique per process: the lock records who holds it, and two containers of
    // the same release booting together must not look like one another.
    owner: `${hostname()}:${process.pid}:${randomUUID()}`,
    release: env.RELEASE,
    logger: console,
  });
  console.log(
    applied.length > 0
      ? `[migrations] Schema ${SCHEMA_VERSION}; applied ${applied.join(", ")}`
      : `[migrations] Schema ${SCHEMA_VERSION}; nothing to apply`,
  );

  const fatal = reportIndexOutcomes(await buildModelIndexes(db, allModels()), console);
  if (fatal.length > 0) {
    throw new BootRefusedError(
      `[db] Refusing to start: ${fatal.map(describeIndex).join("; ")} could not be built, so ` +
        "the invariant it enforces is not guaranteed. The usual cause is duplicate documents " +
        "written before the index existed; see docs/server-migrations.md.",
    );
  }
}
