# Background jobs (scheduler)

`packages/server/src/services/scheduler/` runs recurring jobs inside the server
process. There is no broker and no worker fleet: one `ScheduledJob` row per job
name is shared by every replica on the same database, and a replica runs a job
only after an atomic `findOneAndUpdate` has claimed that row.

The loop polls every 30 seconds, starts from `src/index.ts` after the database
connects, stops in `shutdown()`, and is gated by `SCHEDULER_ENABLED` (on unless
set to `false`/`0`/`no`/`off`).

## The five rules

Each of these fails **quietly** when broken. Nothing logs, nothing alerts — the
job just runs twice, or drifts, or stops.

1. **One row per job name, claimed by an atomic find-and-update.** The filter
   matches only while the row is due and unheld; the update makes it neither.
   Two replicas asking at the same instant cannot both match, because Mongo
   applies the second update to the document the first one already changed.
2. **The claim moves `nextRunAt` forward, not the release.** That is what makes
   a run once per *interval* rather than once per *free moment*. Move it in the
   release instead and "every 5 minutes" silently becomes "5 minutes after each
   run finishes", drifting by the duration of every run.
3. **`lockedUntil` only stops a slow run from starting beside itself.** It is
   not the scheduling mechanism — rule 2 is. The lease matters when a run takes
   longer than its own interval: the next slot comes due mid-run and the live
   lease keeps it from starting in parallel.
4. **The release filters on `lockedBy`.** A replica whose lease lapsed and was
   taken over must not clear its successor's lease on its way out.
   `releaseScheduledJob` returns `false` when the caller no longer holds the
   job; that is the zombie learning it lost.
5. **A replica that dies mid-run loses that run.** When the lease expires the
   job is free again and the next scheduled run happens as normal. There is no
   resurrection and no replay, so **every handler must be idempotent and safe
   to skip.**

## Adding a job

1. One file per job under `src/services/scheduler/`, exporting a
   `register…Job()`:

   ```ts
   import { registerRecurringJob, type RecurringJob } from "./registry.js";

   export const PRUNE_SESSIONS_JOB = "prune-sessions";

   export function registerPruneSessionsJob(): RecurringJob {
     return registerRecurringJob(PRUNE_SESSIONS_JOB, 60 * 60_000, async ({ now }) => {
       // `now` is the instant the run was CLAIMED at, not the instant this
       // line runs. Derive every window from it.
     });
   }
   ```

2. One guarded line in `registerBuiltInJobs()` in
   `src/services/scheduler/index.ts`. `registerRecurringJob` is the only way a
   job enters the loop — nothing else reads the registry.

3. Pass `{ leaseMs }` when the job can legitimately run longer than its own
   interval. The default lease is the interval, so a slower run lapses its own
   lease and the next slot starts beside it.

Names are lowercase letters, digits and dashes, unique per process, and the
minimum interval is 1 second. The registry throws on all three, at boot, rather
than letting a typo produce a job that never runs.

## Removing the placeholder

`services/scheduler/heartbeat.ts` is a placeholder that logs one line every 15
minutes and touches nothing. Delete the file and its line in
`registerBuiltInJobs()` once __HATCHKIT_PROJECT_NAME__ has a real job.

## Tests

`src/tests/scheduler-lease.test.ts` covers the rules above against a real
MongoDB — a stub of `findOneAndUpdate` would only test the stub. The
database-backed cases skip unless `TEST_MONGODB_URI` is set, and each test file
creates and drops a throwaway database of its own
(`src/tests/support/test-database.ts`), so the URI may point at a shared
server.

```bash
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 pnpm --filter __HATCHKIT_SERVER_PKG__ test
```

Set it in CI. Without it the suite still runs; it just proves less.

## Operating it

- `SCHEDULER_ENABLED=false` on a replica that must not run jobs — a one-off
  container, a local debug process attached to the production database.
- Nothing starts under `NODE_ENV=test`: a background timer keeps the event loop
  alive and hangs the suite.
- The `ScheduledJob` collection is the state. `lastRunAt` is when the last run
  *started*, `lastError` is that run's failure (truncated to 1000 characters;
  the stack trace is in the log). A job stuck with a live `lockedUntil` far in
  the future is a lease that was granted and never released — clear `lockedBy`
  and `lockedUntil` to hand it back.
