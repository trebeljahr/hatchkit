// One row per recurring background job, shared by every server process.
//
// The row IS the lease. A process runs a job only after an atomic
// `findOneAndUpdate` has moved `nextRunAt` into the future and written its own
// name into `lockedBy` — see services/scheduler/lease.ts for the claim itself.
// Nothing here is per-process state: two replicas of __HATCHKIT_PROJECT_NAME__
// on the same database compete for the same row, which is what keeps a job
// running once per interval instead of once per replica per interval.
import mongoose, { Schema, type Document } from "mongoose";

export interface IScheduledJob extends Document {
  /** The name the job was registered under. Unique. */
  name: string;
  /** The earliest instant any process may claim the next run. */
  nextRunAt: Date;
  /** The process holding the current run, or null when none does. */
  lockedBy: string | null;
  /** When that hold lapses, so a process that died mid-run frees the job. */
  lockedUntil: Date | null;
  /** When the last run STARTED, whether it succeeded or not. */
  lastRunAt: Date | null;
  /** The last run's error message, or null when it succeeded. */
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Structural shape of a `.lean()` read. The claim returns this rather than a
 *  hydrated document: callers only ever inspect it, never save it. */
export type ScheduledJobDocLike = {
  name: string;
  nextRunAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
};

const scheduledJobSchema = new Schema<IScheduledJob>(
  {
    // `unique` is also what makes the seeding upsert safe with two processes
    // booting at once: the loser's insert fails on the index instead of
    // creating a second row that both could then claim.
    name: { type: String, required: true, unique: true },
    nextRunAt: { type: Date, required: true },
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

export const ScheduledJob = mongoose.model<IScheduledJob>("ScheduledJob", scheduledJobSchema);
