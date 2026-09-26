// The scheduler's lease against a real MongoDB: several scheduler instances
// (standing in for several server processes of __HATCHKIT_PROJECT_NAME__)
// sharing one database must run each job exactly once per interval.
//
// These cases are the reason the lease looks the way it does. Each of the
// rules they pin fails QUIETLY when broken — a job that runs twice per tick, a
// job that drifts later every run, a lease cleared by the wrong process — so
// there is nothing to notice in production until something double-charges.
//
//   TEST_MONGODB_URI=mongodb://127.0.0.1:27017 pnpm --filter __HATCHKIT_SERVER_PKG__ test
//
// Without TEST_MONGODB_URI the database cases skip; the pure ones still run.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { ScheduledJob } from "../models/ScheduledJob.js";
import {
  claimScheduledJob,
  ensureScheduledJob,
  releaseScheduledJob,
} from "../services/scheduler/lease.js";
import { createJobRegistry, type ScheduledJobHandler } from "../services/scheduler/registry.js";
import {
  createScheduler,
  isSchedulerRunning,
  type Scheduler,
  shouldStartScheduler,
  startScheduler,
} from "../services/scheduler/scheduler.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const MINUTE = 60_000;
const INTERVAL = 5 * MINUTE;
const T0 = new Date("2030-01-01T08:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const silent = { log: () => {}, error: () => {} };

/** N schedulers, each with its own registry holding the same job name — the
 *  shape of N server processes running the same build. */
function processes(
  count: number,
  handler: (process: number) => ScheduledJobHandler,
  intervalMs = INTERVAL,
  leaseMs?: number,
): Scheduler[] {
  return Array.from({ length: count }, (_, i) => {
    const registry = createJobRegistry();
    registry.register("test-job", intervalMs, handler(i), { leaseMs });
    return createScheduler({ registry, owner: `process-${i}`, logger: silent });
  });
}

const readRow = async () => {
  const row = await ScheduledJob.findOne({ name: "test-job" }).lean();
  assert.ok(row, "expected a test-job row");
  return row;
};

// ── no database needed ───────────────────────────────────────────────

describe("scheduler configuration", () => {
  it("SCHEDULER_ENABLED=false starts no loop", () => {
    let ticks = 0;
    const scheduler: Scheduler = {
      owner: "never",
      tick: async () => {
        ticks += 1;
      },
    };
    assert.equal(shouldStartScheduler({ enabled: false, isTest: false }), false);
    assert.equal(startScheduler({ enabled: false, isTest: false }, scheduler), false);
    assert.equal(isSchedulerRunning(), false);
    assert.equal(ticks, 0);
  });

  it("starts nothing under NODE_ENV=test either", () => {
    assert.equal(shouldStartScheduler({ enabled: true, isTest: true }), false);
    assert.equal(shouldStartScheduler({ enabled: true, isTest: false }), true);
  });

  it("refuses a duplicate name, a bad name and a too-short interval", () => {
    const registry = createJobRegistry();
    const noop: ScheduledJobHandler = async () => {};
    registry.register("heartbeat", INTERVAL, noop);
    assert.throws(() => registry.register("heartbeat", MINUTE, noop), /already registered/);
    assert.throws(() => registry.register("Bad Name", MINUTE, noop), /lowercase/);
    assert.throws(() => registry.register("fast", 10, noop), /at least/);
    assert.deepEqual(
      registry.list().map((job) => job.name),
      ["heartbeat"],
    );
  });
});

// ── against MongoDB ──────────────────────────────────────────────────

describe("scheduler lease", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("scheduler-lease", [ScheduledJob]);
  });
  after(dropTestDatabase);
  beforeEach(clearTestDatabase);

  it("the claim moves nextRunAt one interval forward", async () => {
    await ensureScheduledJob("test-job", INTERVAL, T0);

    const claimed = await claimScheduledJob({
      name: "test-job",
      owner: "process-0",
      intervalMs: INTERVAL,
      leaseMs: INTERVAL,
      now: T0,
    });

    assert.ok(claimed, "the first claim wins the row");
    // Scheduling happens HERE, not at release. A release that moved
    // nextRunAt would schedule from the end of the run instead of the start,
    // so every run would drift later by its own duration.
    assert.equal(claimed.nextRunAt.getTime(), T0.getTime() + INTERVAL);
    assert.equal(claimed.lockedBy, "process-0");
    assert.equal(claimed.lockedUntil?.getTime(), T0.getTime() + INTERVAL);
  });

  it("a second replica racing the same claim gets nothing", async () => {
    await ensureScheduledJob("test-job", INTERVAL, T0);

    const [first, second] = await Promise.all([
      claimScheduledJob({
        name: "test-job",
        owner: "process-0",
        intervalMs: INTERVAL,
        leaseMs: INTERVAL,
        now: T0,
      }),
      claimScheduledJob({
        name: "test-job",
        owner: "process-1",
        intervalMs: INTERVAL,
        leaseMs: INTERVAL,
        now: T0,
      }),
    ]);

    const winners = [first, second].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one process may hold a run");
  });

  it("stays not-due for the rest of the interval, even once released", async () => {
    await ensureScheduledJob("test-job", INTERVAL, T0);
    await claimScheduledJob({
      name: "test-job",
      owner: "process-0",
      intervalMs: INTERVAL,
      leaseMs: INTERVAL,
      now: T0,
    });
    await releaseScheduledJob({ name: "test-job", owner: "process-0", error: null });

    // Released a second later. The row is free, but not due: once per
    // interval, not once per free moment.
    const early = await claimScheduledJob({
      name: "test-job",
      owner: "process-1",
      intervalMs: INTERVAL,
      leaseMs: INTERVAL,
      now: at(1000),
    });
    assert.equal(early, null);

    const onTime = await claimScheduledJob({
      name: "test-job",
      owner: "process-1",
      intervalMs: INTERVAL,
      leaseMs: INTERVAL,
      now: at(INTERVAL),
    });
    assert.ok(onTime, "due again one interval later");
  });

  it("a lapsed holder's release does not clear its successor's lease", async () => {
    await ensureScheduledJob("test-job", INTERVAL, T0);

    // process-0 claims with a lease shorter than the interval and then dies
    // mid-run — it never releases.
    const first = await claimScheduledJob({
      name: "test-job",
      owner: "process-0",
      intervalMs: INTERVAL,
      leaseMs: MINUTE,
      now: T0,
    });
    assert.ok(first);

    // One interval later the row is due again and the lease has lapsed, so
    // process-1 takes it.
    const second = await claimScheduledJob({
      name: "test-job",
      owner: "process-1",
      intervalMs: INTERVAL,
      leaseMs: MINUTE,
      now: at(INTERVAL),
    });
    assert.ok(second, "a lapsed lease frees the job");
    assert.equal(second.lockedBy, "process-1");

    // process-0 now comes back to life and releases. The filter on lockedBy
    // is the only thing standing between that and a job running twice.
    const stillHeld = await releaseScheduledJob({
      name: "test-job",
      owner: "process-0",
      error: "died",
    });
    assert.equal(stillHeld, false, "the zombie learns it no longer holds the job");

    const row = await readRow();
    assert.equal(row.lockedBy, "process-1", "successor still holds the lease");
    assert.equal(row.lockedUntil?.getTime(), at(INTERVAL).getTime() + MINUTE);
    assert.equal(row.lastError, null, "the zombie's error is not recorded either");
  });

  it("a process that dies mid-run loses that run and frees the job", async () => {
    // A handler that never resolves stands in for a process killed mid-run:
    // the claim happened, the release never will.
    await ensureScheduledJob("test-job", INTERVAL, T0);
    await claimScheduledJob({
      name: "test-job",
      owner: "dead",
      intervalMs: INTERVAL,
      leaseMs: MINUTE,
      now: T0,
    });

    // Inside the lease: nobody else may start beside it.
    assert.equal(
      await claimScheduledJob({
        name: "test-job",
        owner: "alive",
        intervalMs: INTERVAL,
        leaseMs: MINUTE,
        now: at(INTERVAL - 1),
      }),
      null,
    );

    // After it: the next scheduled run happens as normal. The lost run is
    // not replayed — a handler must be safe to skip.
    const next = await claimScheduledJob({
      name: "test-job",
      owner: "alive",
      intervalMs: INTERVAL,
      leaseMs: MINUTE,
      now: at(INTERVAL),
    });
    assert.ok(next);
    assert.equal(next.nextRunAt.getTime(), at(2 * INTERVAL).getTime());
  });

  it("runs a job exactly once per interval across concurrent processes", async () => {
    const runs: { process: number; now: string }[] = [];
    const schedulers = processes(8, (process) => async ({ now }) => {
      runs.push({ process, now: now.toISOString() });
    });

    // Three intervals, each polled several times by every process at once,
    // including polls that land exactly on the boundary.
    const polls = [0, 1, 30_000, INTERVAL, INTERVAL + 30_000, 2 * INTERVAL, 2 * INTERVAL + 1];
    for (const offset of polls) {
      await Promise.all(schedulers.map((scheduler) => scheduler.tick(at(offset))));
    }

    assert.equal(runs.length, 3, `expected 3 runs, got ${JSON.stringify(runs)}`);
    assert.deepEqual(
      runs.map((run) => run.now),
      [T0.toISOString(), at(INTERVAL).toISOString(), at(2 * INTERVAL).toISOString()],
    );
  });

  it("records a failing handler on the row without stopping the next run", async () => {
    const [scheduler] = processes(1, () => async () => {
      throw new Error("handler blew up");
    });
    await scheduler.tick(T0);

    const row = await readRow();
    assert.equal(row.lastError, "handler blew up");
    assert.equal(row.lockedBy, null, "a failed run still gives the job back");
    assert.equal(row.nextRunAt.getTime(), at(INTERVAL).getTime());
  });
});
