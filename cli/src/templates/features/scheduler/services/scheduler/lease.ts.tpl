// The claim, run and release of one job row. Nothing in here knows what a job
// does; see scheduler.ts for the loop and registry.ts for the jobs themselves.
//
// The whole design is one atomic `findOneAndUpdate` whose filter only matches
// while the row is due, and whose update makes it not due. Two processes
// asking at the same instant cannot both match: Mongo applies the second
// update to the document the first one already changed. That is the entire
// mutual exclusion — there is no broker, no Redis lock and no leader election.
import { ScheduledJob, type ScheduledJobDocLike } from "../../models/ScheduledJob.js";

/** The longest `lastError` kept on the row. A stack trace is for the log. */
export const SCHEDULED_JOB_ERROR_MAX_LENGTH = 1000;

/**
 * Make sure the job has a row, due now if it is new.
 *
 * Also pulls a far-future `nextRunAt` back to one interval from now. Without
 * that, shortening a job's interval in a deploy would leave it waiting out the
 * old, longer one first.
 *
 * Two processes booting at once both reach the upsert. The unique index on
 * `name` makes one of the inserts fail with a duplicate key, and that failure
 * means the row exists, which is all this function promises.
 */
export async function ensureScheduledJob(
  name: string,
  intervalMs: number,
  now: Date,
): Promise<void> {
  // Wait for the unique index on `name` before the first upsert. On a fresh
  // database two processes booting together would otherwise both insert, and
  // then each claim a different row. Resolves at once after the first call.
  await ScheduledJob.init();
  try {
    await ScheduledJob.updateOne(
      { name },
      {
        $setOnInsert: {
          name,
          nextRunAt: now,
          lockedBy: null,
          lockedUntil: null,
          lastRunAt: null,
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const latest = new Date(now.getTime() + intervalMs);
  await ScheduledJob.updateOne(
    { name, nextRunAt: { $gt: latest } },
    { $set: { nextRunAt: latest } },
  );
}

/**
 * Take the next run of a job, or learn that it is not this process's to take.
 *
 * The row matches only when it is due AND nobody holds a live lease on it. The
 * update moves `nextRunAt` one interval forward at CLAIM time, not at release:
 * that is what makes a run once per interval rather than once per free moment.
 * A second process polling a second after this run finished still finds the
 * row not due.
 *
 * `lockedUntil` covers the other case, a run slower than its own interval. The
 * next slot comes due while the first run is still going, and the lease keeps
 * it from starting beside it. A process that dies mid-run frees the job when
 * its lease lapses; that run is lost, and the next one is due as normal. There
 * is deliberately no resurrection — a half-finished run is not replayed.
 */
export async function claimScheduledJob(args: {
  name: string;
  owner: string;
  intervalMs: number;
  leaseMs: number;
  now: Date;
}): Promise<ScheduledJobDocLike | null> {
  const { name, owner, intervalMs, leaseMs, now } = args;
  return ScheduledJob.findOneAndUpdate(
    {
      name,
      nextRunAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    {
      $set: {
        nextRunAt: new Date(now.getTime() + intervalMs),
        lockedBy: owner,
        lockedUntil: new Date(now.getTime() + leaseMs),
        lastRunAt: now,
      },
    },
    { returnDocument: "after" },
  ).lean<ScheduledJobDocLike | null>();
}

/**
 * Give the job back, recording how the run went.
 *
 * Filtered on `lockedBy`, so a process whose lease lapsed and was taken over
 * cannot clear the NEW holder's lease on its way out. Returns whether this
 * process still held it.
 *
 * Note what this does NOT touch: `nextRunAt`. Scheduling happens at claim
 * time. A release that also moved `nextRunAt` would schedule the next run from
 * the end of this one, turning "every 5 minutes" into "5 minutes after each
 * run finishes" — a drift nothing would ever report.
 */
export async function releaseScheduledJob(args: {
  name: string;
  owner: string;
  error: string | null;
}): Promise<boolean> {
  const { name, owner, error } = args;
  const result = await ScheduledJob.updateOne(
    { name, lockedBy: owner },
    {
      $set: {
        lockedBy: null,
        lockedUntil: null,
        lastError: error === null ? null : error.slice(0, SCHEDULED_JOB_ERROR_MAX_LENGTH),
      },
    },
  );
  return result.modifiedCount === 1;
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === 11000;
