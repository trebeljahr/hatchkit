// The jobs this process knows how to run.
//
// A job is registered once, at boot, by name. The name is the key of its row
// in the ScheduledJob collection, so it is shared by every process running the
// same build: two processes that register "heartbeat" compete for one row, and
// exactly one of them runs each interval.
//
// `registerRecurringJob` below is the ONLY way a job enters the loop. Keeping
// one entry point is what makes "which jobs does this server run?" a question
// with an answer — the loop reads the registry and nothing else.

/** What a handler is given. `now` is the instant the run was claimed at. */
export type ScheduledJobContext = { now: Date };

export type ScheduledJobHandler = (context: ScheduledJobContext) => Promise<void>;

export type RecurringJob = {
  name: string;
  intervalMs: number;
  /** How long a claimed run holds the job. See `claimScheduledJob`. */
  leaseMs: number;
  handler: ScheduledJobHandler;
};

export type RecurringJobOptions = {
  /**
   * Defaults to the interval. Raise it for a job that can legitimately run
   * longer than its own interval, or a slow run's lease lapses and the next
   * slot starts beside it.
   */
  leaseMs?: number;
};

/** Shorter than one poll, a job could never actually run that often. */
export const MIN_JOB_INTERVAL_MS = 1000;

const JOB_NAME = /^[a-z0-9][a-z0-9-]*$/;

export type JobRegistry = {
  register: (
    name: string,
    intervalMs: number,
    handler: ScheduledJobHandler,
    options?: RecurringJobOptions,
  ) => RecurringJob;
  list: () => RecurringJob[];
};

/**
 * A fresh registry. The process has one (`registerRecurringJob` below); tests
 * build their own so no job leaks from one case into the next.
 *
 * Registering a name twice throws. Two handlers under one row would take turns
 * running each other's interval, which nothing would ever report.
 */
export function createJobRegistry(): JobRegistry {
  const jobs = new Map<string, RecurringJob>();
  return {
    register(name, intervalMs, handler, options = {}) {
      if (!JOB_NAME.test(name)) {
        throw new Error(
          `Scheduled job name ${JSON.stringify(name)} must be lowercase letters, digits and dashes.`,
        );
      }
      if (jobs.has(name)) {
        throw new Error(`Scheduled job "${name}" is already registered.`);
      }
      if (!Number.isFinite(intervalMs) || intervalMs < MIN_JOB_INTERVAL_MS) {
        throw new Error(
          `Scheduled job "${name}" needs an interval of at least ${MIN_JOB_INTERVAL_MS}ms.`,
        );
      }
      const leaseMs = options.leaseMs ?? intervalMs;
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
        throw new Error(`Scheduled job "${name}" needs a positive lease.`);
      }
      const job: RecurringJob = { name, intervalMs, leaseMs, handler };
      jobs.set(name, job);
      return job;
    },
    list: () => [...jobs.values()],
  };
}

/** The process-wide registry the scheduler started from index.ts reads. */
export const jobRegistry: JobRegistry = createJobRegistry();

/**
 * Register a job for every server process to share.
 *
 * Call it at boot, before `startScheduler()`. A job registered later is still
 * picked up on the next poll, but nothing should depend on that.
 */
export function registerRecurringJob(
  name: string,
  intervalMs: number,
  handler: ScheduledJobHandler,
  options?: RecurringJobOptions,
): RecurringJob {
  return jobRegistry.register(name, intervalMs, handler, options);
}
