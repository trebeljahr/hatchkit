// The background loop that runs registered jobs.
//
// A timer over one indexed collection rather than a job runner: the workload
// is a handful of jobs every few minutes, and a broker would be a second thing
// to operate, deploy and pay for. What a broker would buy — several processes
// never running the same job at once — the lease in lease.ts buys with one
// atomic update against a database the server already has open.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { claimScheduledJob, ensureScheduledJob, releaseScheduledJob } from "./lease.js";
import { jobRegistry, type JobRegistry, type RecurringJob } from "./registry.js";

/** How often this process asks whether any job is due. */
export const SCHEDULER_POLL_INTERVAL_MS = 30_000;

export type SchedulerLogger = Pick<Console, "log" | "error">;

export type Scheduler = {
  /** The name this process writes into `lockedBy`. */
  owner: string;
  /**
   * One pass: claim every due job this process is not already running, and
   * run the ones it won. Resolves when those runs finish. Never rejects: a
   * handler's failure is recorded on its row, a database failure is logged,
   * and the next poll tries again either way.
   */
  tick: (now?: Date) => Promise<void>;
};

/**
 * A scheduler over a registry. Exported for tests, which drive `tick` with a
 * clock of their own instead of waiting on the interval.
 */
export function createScheduler(
  options: {
    registry?: JobRegistry;
    owner?: string;
    logger?: SchedulerLogger;
  } = {},
): Scheduler {
  const registry = options.registry ?? jobRegistry;
  // Host + pid + uuid, not just the hostname: two containers of the same
  // image share a hostname often enough, and `lockedBy` is what the release
  // filters on. A collision there would let one process clear another's lease.
  const owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID()}`;
  const logger = options.logger ?? console;

  // Jobs this process has in flight. The interval keeps firing while a slow
  // run is going; without this the process would try to claim a job it is
  // already running, which the lease refuses anyway, at the cost of a query
  // per job per poll.
  const running = new Set<string>();

  const runOne = async (job: RecurringJob, now: Date): Promise<void> => {
    running.add(job.name);
    try {
      await ensureScheduledJob(job.name, job.intervalMs, now);
      const claimed = await claimScheduledJob({
        name: job.name,
        owner,
        intervalMs: job.intervalMs,
        leaseMs: job.leaseMs,
        now,
      });
      if (!claimed) return;

      let error: string | null = null;
      try {
        await job.handler({ now });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        logger.error(`[scheduler] Job "${job.name}" failed:`, caught);
      }
      await releaseScheduledJob({ name: job.name, owner, error });
    } catch (caught) {
      // The database, not the job. The row keeps whatever state the last
      // write left it in, and a held lease lapses on its own.
      logger.error(`[scheduler] Could not run job "${job.name}":`, caught);
    } finally {
      running.delete(job.name);
    }
  };

  return {
    owner,
    tick: async (now = new Date()) => {
      const due = registry.list().filter((job) => !running.has(job.name));
      await Promise.all(due.map((job) => runOne(job, now)));
    },
  };
}

/** Whether `startScheduler` starts a loop in this environment. */
export function shouldStartScheduler(source: { enabled: boolean; isTest: boolean }): boolean {
  return source.enabled && !source.isTest;
}

let timer: NodeJS.Timeout | null = null;
let ticking: Promise<void> | null = null;

/**
 * Start polling. Call after the database connects.
 *
 * Returns false without starting anything when SCHEDULER_ENABLED is off, and
 * under NODE_ENV=test, where a background timer keeps the event loop alive and
 * hangs the suite. `.unref()` otherwise, so a shutdown never waits on a poll.
 * Idempotent: a second call does not start a second loop.
 *
 * The first poll runs straight away rather than one interval after boot, so a
 * deploy does not push every due job back by 30 seconds.
 */
export function startScheduler(
  config: { enabled: boolean; isTest: boolean },
  scheduler: Scheduler = createScheduler(),
): boolean {
  if (!shouldStartScheduler(config)) return false;
  if (timer) return true;

  const poll = (): void => {
    if (ticking) return;
    ticking = scheduler.tick().finally(() => {
      ticking = null;
    });
  };
  timer = setInterval(poll, SCHEDULER_POLL_INTERVAL_MS);
  timer.unref();
  poll();
  return true;
}

/** Stop polling. Resolves once a pass already in flight has finished. */
export async function stopScheduler(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (ticking) await ticking;
}

/** Whether a loop is running in this process. */
export function isSchedulerRunning(): boolean {
  return timer !== null;
}
