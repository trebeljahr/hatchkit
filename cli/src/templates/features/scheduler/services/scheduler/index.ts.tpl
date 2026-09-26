// The scheduler's public surface.
//
// Everything outside services/scheduler/ imports from here, never from
// lease.ts or scheduler.ts directly: the lease is an implementation detail of
// the loop, and a caller that reaches past this file is a caller that can run
// a job without claiming it.
//
// src/index.ts calls `registerBuiltInJobs()` and then `startScheduler()`.
// Anything else that wants a recurring job calls `registerRecurringJob`.
import { HEARTBEAT_JOB, registerHeartbeatJob } from "./heartbeat.js";
import { jobRegistry } from "./registry.js";

export {
  createJobRegistry,
  jobRegistry,
  MIN_JOB_INTERVAL_MS,
  registerRecurringJob,
  type JobRegistry,
  type RecurringJob,
  type RecurringJobOptions,
  type ScheduledJobContext,
  type ScheduledJobHandler,
} from "./registry.js";
export {
  createScheduler,
  isSchedulerRunning,
  SCHEDULER_POLL_INTERVAL_MS,
  shouldStartScheduler,
  startScheduler,
  stopScheduler,
  type Scheduler,
} from "./scheduler.js";

/**
 * Register every job this server ships with.
 *
 * Safe to call twice — the registry throws on a duplicate name, and a boot
 * path that runs twice (a test harness, a reload) should not crash the
 * process over it. Add one guarded line per job.
 */
export function registerBuiltInJobs(): void {
  const registered = new Set(jobRegistry.list().map((job) => job.name));

  // Placeholder. Delete this line together with ./heartbeat.ts.
  if (!registered.has(HEARTBEAT_JOB)) registerHeartbeatJob();
}
