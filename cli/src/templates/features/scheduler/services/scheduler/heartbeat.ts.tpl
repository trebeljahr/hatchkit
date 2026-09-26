// ─────────────────────────────────────────────────────────────────────────
// PLACEHOLDER JOB — delete this file and its two lines in ./index.ts once
// __HATCHKIT_PROJECT_NAME__ has a real background job.
//
// It exists so the scheduler ships with something running: a loop with an
// empty registry looks identical to a loop that never started, and the
// difference only shows up the day you add your first job. This one logs a
// line and touches nothing, so it is safe to leave in place while you build.
//
// Copy its shape for a real job:
//   1. one file per job under services/scheduler/,
//   2. a `register…Job()` that calls `registerRecurringJob`,
//   3. one line in `registerBuiltInJobs()` in ./index.ts.
// The handler must be idempotent and safe to skip: a run whose process dies
// mid-flight is lost, not replayed. See docs/scheduler.md.
// ─────────────────────────────────────────────────────────────────────────
import { registerRecurringJob, type RecurringJob } from "./registry.js";

export const HEARTBEAT_JOB = "heartbeat";

/** Long enough that the log stays readable, short enough that a broken
 *  scheduler is obvious within a coffee break. */
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000;

export function registerHeartbeatJob(): RecurringJob {
  return registerRecurringJob(HEARTBEAT_JOB, HEARTBEAT_INTERVAL_MS, async ({ now }) => {
    // `now` is the instant the run was CLAIMED at, not the instant the
    // handler happens to reach this line. Use it for anything time-based, so
    // a slow run and a fast one compute the same window.
    console.log(`[scheduler] heartbeat ${now.toISOString()}`);
  });
}
