// The shape of one migration and of the row it leaves behind.
//
// Written by `hatchkit` for __HATCHKIT_PROJECT_NAME__. Safe to edit — the
// generator never overwrites a file you changed, it reports it instead.
import type { Db } from "mongodb";

export type Migration = {
  /**
   * Position in the sequence: 1, 2, 3 … with no gaps. The stored record is
   * keyed on it, so an id is never reused or renumbered once released.
   */
  id: number;
  /** One line for the log and `admin migrate --status`. */
  description: string;
  /**
   * The lowest `SCHEMA_VERSION` a build must have to still read the database
   * after this migration ran.
   *
   * Most migrations are additive (a backfill, a new index, a field older code
   * ignores) and keep this at a value every release you still run already has
   * — `0` means "any release, including those from before the runner existed".
   * Only a migration that changes a shape older code MISREADS raises it to its
   * own id.
   *
   * The trade-off, stated here because the number looks harmless: raising it
   * makes every older build refuse to start against this database. That is
   * exactly right for a breaking change — the alternative is an old replica
   * quietly corrupting the new shape — and it is a self-inflicted outage for
   * an additive one, because a rollback (or the old container still draining
   * during a deploy) can no longer boot. When in doubt, leave it at 0 and make
   * the new code tolerate both shapes.
   */
  minReaderSchema: number;
  /**
   * The change itself, against the raw MongoDB driver.
   *
   * Never against today's mongoose models: a migration outlives the model file
   * it was written next to, and the database it has to fix is the OLD one, not
   * the one today's schema describes. A model-based migration silently starts
   * applying validators, defaults and casts that did not exist when the rows
   * were written.
   *
   * MUST be idempotent. Two things re-run it: a process can die after `up`
   * finished and before the record was written, and a lease can lapse mid-run
   * so another process takes over. Both cases run `up` a second time.
   */
  up: (db: Db) => Promise<void>;
};

/** A row of `schema_migrations`. */
export type MigrationRecord = {
  _id: number;
  description: string;
  minReaderSchema: number;
  appliedAt: Date;
  /** The release that applied it (`env.RELEASE`); empty for a local build. */
  release: string;
};

export type MigrationLogger = {
  log: (message: string) => void;
  error: (message: string) => void;
};
