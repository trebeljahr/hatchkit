// The background loop that drains the delivery queue.
//
// Deliberately a timer over an indexed query rather than a job runner: the
// queue is one collection with a `{ status, nextAttemptAt }` index, and adding
// a broker to this would be a second thing to operate for a workload measured
// in events per minute.
//
// Two ways to run it, because a project may or may not have the `scheduler`
// feature installed:
//
//   ./sweep-job.ts        — registers `sweepWebhooksOnce` as a leased
//                           recurring job. Written only when there is a
//                           scheduler to register it with, and preferred:
//                           a lease means one replica sweeps, not all of them.
//   startWebhookSweeper() — this module's own `setInterval`, for a project
//                           with no scheduler. Safe on several replicas too —
//                           the claim in `delivery.ts` is atomic — just N
//                           times the queries for one queue's work.
//
// This file deliberately does NOT import the scheduler. It has to keep
// resolving in a project that declined it.
import { env } from "../../config/env.js";
import { runWebhookSweep } from "./delivery.js";

/** The job name, when a scheduler owns the sweep. Also its log key. */
export const WEBHOOK_SWEEP_JOB_NAME = "webhook-sweep";

/** How often the queue is checked. Cheap: it is one indexed query. */
export const WEBHOOK_SWEEP_INTERVAL_MS = 10_000;

/**
 * True while a pass is in flight.
 *
 * The interval keeps firing while a sweep waits on a slow endpoint, and
 * without this guard those passes stack up: each claims its own batch and the
 * process ends up holding far more concurrent requests than
 * `WEBHOOK_SWEEP_BATCH` implies.
 */
let sweeping = false;

/**
 * One guarded pass.
 *
 * Swallows its own errors: a database blip must reschedule the next tick, not
 * kill the loop and silently stop every webhook in the deployment until
 * somebody restarts the process.
 */
export async function sweepWebhooksOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await runWebhookSweep();
  } catch {
    // Next tick tries again. See the doc comment.
  } finally {
    sweeping = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the standalone loop.
 *
 * Returns immediately under NODE_ENV=test: a background timer in a test
 * process keeps the event loop alive and turns a passing suite into one that
 * hangs. `.unref()` for the same reason everywhere else — a shutdown must not
 * wait on the next tick of this.
 *
 * Idempotent, so a double call cannot start two loops racing for the same
 * pending rows.
 */
export function startWebhookSweeper(): void {
  if (env.isTest || timer) return;
  timer = setInterval(() => {
    void sweepWebhooksOnce();
  }, WEBHOOK_SWEEP_INTERVAL_MS);
  timer.unref();
}

/** Stop the loop. Called from the graceful-shutdown path. */
export function stopWebhookSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
