/**
 * Delete this project's signups that never confirmed, 30 days after the
 * subscriber was created. The privacy policy promises this.
 *
 * A subscriber is deleted only when ALL of these hold:
 *
 *   - this project's signup form created it: `attribs.signup.list` is
 *     this project's live or test list (listmonk.ts writes it on create);
 *   - it is on no list at all: the form creates it there, and only the
 *     confirm click adds one (see "Double opt-in and list membership" in
 *     listmonk.ts);
 *   - its status is `enabled`: deleting a blocklisted or disabled
 *     subscriber would forget that it must not get mail;
 *   - Listmonk created it more than 30 days ago. Posting the form again
 *     does not restart the clock; a confirm link clicked after the
 *     cleanup still works, because the confirm route creates the
 *     subscriber again on the list.
 *
 * "On no list" alone is not enough on a shared instance: deleting a list
 * (`hatchkit remove … listmonk-ses`) or removing a membership by hand
 * also leaves subscribers on no list, and so do other projects' pending
 * signups. The `attribs.signup` check keeps the cleanup to subscribers
 * this project's form made. One case remains: a subscriber this form
 * created and confirmed, whose membership is later removed from every
 * list, is deleted too.
 *
 * Each candidate is read again right before the delete, so a confirm
 * click between the listing and the delete keeps the subscriber. At most
 * MAX_PER_RUN are deleted per run; the rest wait for the next day, which
 * limits what a bug in this rule can delete.
 *
 * It runs once a day in production (`scheduleUnconfirmedCleanup`, from
 * routes.ts) and on demand with `pnpm newsletter:prune [--dry-run]`.
 */

import {
  deleteSubscribers,
  getSubscriber,
  type ListmonkSubscriber,
  listAllSubscribers,
  projectListIds,
} from "./listmonk.js";

export const UNCONFIRMED_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 500;
const BATCH = 100;

function log(level: "info" | "error", event: string, extra: object = {}): void {
  const line = JSON.stringify({ scope: "newsletter.prune", level, event, ...extra });
  if (level === "error") console.error(line);
  else console.info(line);
}

function signupList(sub: ListmonkSubscriber): unknown {
  const signup = sub.attribs?.signup;
  return typeof signup === "object" && signup !== null ? (signup as { list?: unknown }).list : undefined;
}

/** Subscribers the rule above deletes, given this project's list ids. */
export function findUnconfirmed(
  subscribers: ListmonkSubscriber[],
  ownLists: number[],
  cutoff: number,
): ListmonkSubscriber[] {
  return subscribers.filter((sub) => {
    if (sub.status !== "enabled") return false;
    if ((sub.lists?.length ?? 0) > 0) return false;
    if (!ownLists.includes(signupList(sub) as number)) return false;
    const created = sub.created_at ? Date.parse(sub.created_at) : Number.NaN;
    return Number.isFinite(created) && created < cutoff;
  });
}

export type PruneResult = {
  total: number;
  candidates: number;
  deleted: number;
  /** Candidates left for the next run by MAX_PER_RUN. */
  deferred: number;
  emails: string[];
};

/** Find and (unless `dryRun`) delete this project's never-confirmed
 *  signups. */
export async function pruneUnconfirmed(
  opts: { dryRun?: boolean; now?: number; days?: number } = {},
): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? UNCONFIRMED_TTL_DAYS;
  const ownLists = projectListIds();
  if (ownLists.length === 0) throw new Error("No Listmonk list id in the environment");
  const subscribers = await listAllSubscribers();
  const stale = findUnconfirmed(subscribers, ownLists, now - days * DAY_MS);
  const batch = stale.slice(0, MAX_PER_RUN);
  const result: PruneResult = {
    total: subscribers.length,
    candidates: stale.length,
    deleted: 0,
    deferred: stale.length - batch.length,
    emails: stale.map((s) => s.email),
  };

  if (!opts.dryRun) {
    for (let i = 0; i < batch.length; i += BATCH) {
      const ids: number[] = [];
      for (const sub of batch.slice(i, i + BATCH)) {
        // Read it again: a confirm click since the listing added a list.
        const fresh = await getSubscriber(sub.id);
        if (fresh && findUnconfirmed([fresh], ownLists, now - days * DAY_MS).length === 1) ids.push(sub.id);
      }
      await deleteSubscribers(ids);
      result.deleted += ids.length;
    }
  }
  log("info", opts.dryRun ? "dry_run" : "pruned", {
    total: result.total,
    candidates: result.candidates,
    deleted: result.deleted,
    deferred: result.deferred,
  });
  return result;
}

let scheduled = false;

/** Run the cleanup ten to twenty minutes after start, then every 24
 *  hours. Production only, so a laptop pointed at the shared instance
 *  never runs it on a timer, and once per process. A failed run is
 *  logged and retried the next day. The timer never keeps the process
 *  alive. */
export function scheduleUnconfirmedCleanup(): void {
  if (scheduled || process.env.NODE_ENV !== "production") return;
  if (!process.env.LISTMONK_URL || !process.env.LISTMONK_API_TOKEN) return;
  scheduled = true;
  const run = (): void => {
    pruneUnconfirmed().catch((err: unknown) => {
      log("error", "failed", { message: (err as Error).message });
    });
  };
  // The random part spreads replicas that start together.
  const first = setTimeout(
    () => {
      run();
      setInterval(run, DAY_MS).unref();
    },
    (10 + Math.random() * 10) * 60 * 1000,
  );
  first.unref();
}
