// The delivery sweep, as a leased scheduler job.
//
// Written by the `public-api` feature ONLY when this project also has the
// `scheduler` feature — it is the one file here that imports it, which is what
// keeps `sweeper.ts` resolvable in a project that declined the scheduler.
//
// Leasing is the whole reason to prefer this over `startWebhookSweeper()`.
// Both are safe on several replicas, because claiming a delivery in
// `delivery.ts` is atomic, but the standalone interval has every replica
// polling the queue for work only one of them can take.
import { registerRecurringJob, type RecurringJob } from "../scheduler/index.js";
import {
  sweepWebhooksOnce,
  WEBHOOK_SWEEP_INTERVAL_MS,
  WEBHOOK_SWEEP_JOB_NAME,
} from "./sweeper.js";

/**
 * The lease is longer than the poll interval on purpose.
 *
 * One pass can send up to `WEBHOOK_SWEEP_BATCH` deliveries, each with a
 * ten-second request timeout, so a sweep against a set of slow endpoints
 * legitimately outlives its own interval. With the lease left at the default
 * the next slot would start beside a run that is still in flight.
 */
const SWEEP_LEASE_MS = 5 * 60_000;

export function registerWebhookSweepJob(): RecurringJob {
  return registerRecurringJob(
    WEBHOOK_SWEEP_JOB_NAME,
    WEBHOOK_SWEEP_INTERVAL_MS,
    async () => {
      // The claimed instant is deliberately unused: `runWebhookSweep` reads
      // the clock itself when it decides which rows are due, and a run that
      // was claimed thirty seconds ago must not skip a delivery that came due
      // since.
      await sweepWebhooksOnce();
    },
    { leaseMs: SWEEP_LEASE_MS },
  );
}
