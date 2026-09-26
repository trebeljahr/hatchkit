// Reads the stored schema state, refuses a database this build cannot read,
// and applies pending migrations under the lock.
//
// Takes a raw `Db` rather than reaching for mongoose, so the server (which
// hands it mongoose's connection) and the admin CLI (which opens its own) run
// the identical code against the identical state.
import type { Db } from "mongodb";
import {
  claimMigrationLock,
  ensureMigrationLock,
  isDuplicateKeyError,
  releaseMigrationLock,
  renewMigrationLock,
} from "./lease.js";
import { assertMigrationSequence } from "./registry.js";
import type { Migration, MigrationLogger, MigrationRecord } from "./types.js";

export const SCHEMA_MIGRATIONS_COLLECTION = "schema_migrations";

/** How long a claim lasts without renewal. Renewed every third of it, so two
 *  missed renewals still leave a third attempt before the lease lapses. */
export const MIGRATION_LEASE_MS = 60_000;
/** How often a process waiting on another's migrations looks again. */
export const MIGRATION_POLL_MS = 1_000;

const records = (db: Db) => db.collection<MigrationRecord>(SCHEMA_MIGRATIONS_COLLECTION);

export type MigrationState = {
  applied: MigrationRecord[];
  /** The highest `minReaderSchema` of any applied migration; 0 when none. */
  requiredReaderSchema: number;
  /** The applied migration that set `requiredReaderSchema`, if any did. */
  raisedBy: MigrationRecord | null;
};

export async function readMigrationState(db: Db): Promise<MigrationState> {
  const applied = await records(db).find({}).sort({ _id: 1 }).toArray();
  let raisedBy: MigrationRecord | null = null;
  for (const record of applied) {
    if (record.minReaderSchema > (raisedBy?.minReaderSchema ?? 0)) raisedBy = record;
  }
  return { applied, requiredReaderSchema: raisedBy?.minReaderSchema ?? 0, raisedBy };
}

/** The database needs a newer build than this one. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly requiredReaderSchema: number,
    readonly schemaVersion: number,
    readonly raisedBy: MigrationRecord | null,
  ) {
    const release = raisedBy?.release ? `v${raisedBy.release}` : "an unknown release";
    super(
      `This database was migrated by a newer build of __HATCHKIT_PROJECT_NAME__ (${release}): ` +
        `it needs schema ${requiredReaderSchema}, and this build reads up to schema ` +
        `${schemaVersion}. Deploy that release or later, or restore the dump taken before ` +
        "the upgrade.",
    );
    this.name = "SchemaTooNewError";
  }
}

export function assertReadable(state: MigrationState, schemaVersion: number): void {
  if (state.requiredReaderSchema > schemaVersion) {
    throw new SchemaTooNewError(state.requiredReaderSchema, schemaVersion, state.raisedBy);
  }
}

export function pendingMigrations(
  state: MigrationState,
  migrations: readonly Migration[],
): Migration[] {
  const done = new Set(state.applied.map((record) => record._id));
  return migrations.filter((migration) => !done.has(migration.id));
}

export type MigrationStatus = MigrationState & {
  schemaVersion: number;
  pending: Migration[];
  /** Applied ids this build has never heard of: a newer, still-compatible
   *  release ran them. Not an error — `minReaderSchema` is what decides
   *  whether this build may read the result. */
  unknownApplied: MigrationRecord[];
  readable: boolean;
};

/** Everything `admin migrate --status` and `admin doctor` print. Read-only:
 *  the doctor must never write to the database it is diagnosing. */
export async function migrationStatus(
  db: Db,
  migrations: readonly Migration[],
  schemaVersion: number,
): Promise<MigrationStatus> {
  const state = await readMigrationState(db);
  const known = new Set(migrations.map((migration) => migration.id));
  return {
    ...state,
    schemaVersion,
    pending: pendingMigrations(state, migrations),
    unknownApplied: state.applied.filter((record) => !known.has(record._id)),
    readable: state.requiredReaderSchema <= schemaVersion,
  };
}

export type RunMigrationsOptions = {
  db: Db;
  migrations: readonly Migration[];
  schemaVersion: number;
  /** Unique per process; written into the lock so a lapsed holder can be
   *  told apart from the one that took over. */
  owner: string;
  /** Recorded on each migration this run applies. */
  release: string;
  logger: MigrationLogger;
  leaseMs?: number;
  pollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Refuse an unreadable database, then apply every pending migration in order,
 * recording each as it finishes. Returns the ids this call applied.
 *
 * A migration that throws is NOT recorded, the lock is released and the error
 * propagates: the server does not start, and the next boot retries it. Half a
 * migration that nobody knows ran is the one failure mode worth crashing for.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<number[]> {
  const {
    db,
    migrations,
    schemaVersion,
    owner,
    release,
    logger,
    leaseMs = MIGRATION_LEASE_MS,
    pollMs = MIGRATION_POLL_MS,
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  assertMigrationSequence(migrations);

  // Checked BEFORE any lock, so a too-old build exits without touching the
  // database — and without blocking on a lock the newer build is holding
  // while it migrates. A rolled-back container should fail in seconds with a
  // sentence an operator can act on, not hang in a restart loop.
  let state = await readMigrationState(db);
  assertReadable(state, schemaVersion);
  if (pendingMigrations(state, migrations).length === 0) return [];

  await ensureMigrationLock(db);
  let waiting = false;
  while (!(await claimMigrationLock(db, { owner, leaseMs, now: now() }))) {
    if (!waiting) {
      logger.log("[migrations] Another process is migrating; waiting for it to finish");
      waiting = true;
    }
    await sleep(pollMs);
  }

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    renewMigrationLock(db, { owner, leaseMs, now: now() })
      .then((held) => {
        if (!held) leaseLost = true;
      })
      .catch(() => {
        // One failed renewal is not a lost lease; the next tick tries again.
      });
  }, Math.max(1, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  const applied: number[] = [];
  try {
    // Read again under the lock: the process we waited on has probably
    // applied everything already, and may have been a newer release whose
    // migrations now make this build unreadable.
    state = await readMigrationState(db);
    assertReadable(state, schemaVersion);

    for (const migration of pendingMigrations(state, migrations)) {
      if (leaseLost) {
        throw new Error(
          "[migrations] Lost the migration lock (renewal failed for longer than the lease); " +
            "stopping before the next migration",
        );
      }
      logger.log(`[migrations] Applying ${migration.id}: ${migration.description}`);
      const started = Date.now();
      try {
        await migration.up(db);
      } catch (error) {
        logger.error(
          `[migrations] Migration ${migration.id} failed and was not recorded; it runs again ` +
            `on the next start: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      await recordMigration(db, migration, release, now());
      applied.push(migration.id);
      logger.log(`[migrations] Applied ${migration.id} in ${Date.now() - started} ms`);
    }
  } finally {
    clearInterval(heartbeat);
    await releaseMigrationLock(db, owner).catch(() => undefined);
  }
  return applied;
}

async function recordMigration(
  db: Db,
  migration: Migration,
  release: string,
  appliedAt: Date,
): Promise<void> {
  try {
    await records(db).insertOne({
      _id: migration.id,
      description: migration.description,
      minReaderSchema: migration.minReaderSchema,
      appliedAt,
      release,
    });
  } catch (error) {
    // Already recorded by a process whose lease lapsed mid-run. The migration
    // is idempotent, so both having run it is harmless and the first record
    // stands as the history.
    if (!isDuplicateKeyError(error)) throw error;
  }
}
