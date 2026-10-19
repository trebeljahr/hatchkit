/**
 * Delete subscribers that never confirmed, 30 days after Listmonk
 * created them. The privacy policy promises this.
 *
 * A subscriber is deleted only when ALL of these hold:
 *
 *   - it is on no list at all. The signup form creates the subscriber
 *     there, and only the confirm click adds one (see "Double opt-in and
 *     list membership" in listmonk.ts). Account emails send with
 *     `subscriber_mode: "external"` (services/email.ts) and create no
 *     subscriber. An address that unsubscribed keeps its membership as
 *     `unsubscribed`, so it is not on "no list";
 *   - its status is `enabled`. Deleting a blocklisted or disabled
 *     subscriber would forget that it must not get mail;
 *   - Listmonk created it more than 30 days ago. Posting the form again
 *     does not restart the clock. A confirm link clicked after the
 *     cleanup still works: the confirm route creates the subscriber
 *     again, on the list.
 *
 * The app stores nothing on a subscriber about where it signed up, so
 * the rule cannot tell projects apart and looks at the whole shared
 * instance. Every project's signup form follows the same rule, so that
 * is right for each of them, and several projects or replicas running
 * it delete nothing twice. It also deletes an address left on no list
 * for another reason: its only list was deleted (`hatchkit remove …
 * listmonk-ses`), or its membership was removed by hand. Such an
 * address has no subscription left to keep it for. Export a list before
 * deleting it if you want its addresses.
 *
 * Guards, because the rule reads every project's subscribers:
 *   - each candidate is read again right before the delete, so a confirm
 *     click between the listing and the delete keeps it;
 *   - at most MAX_PER_RUN are deleted per run; the rest wait a day;
 *   - the run deletes nothing when more than half of the enabled
 *     subscribers look unconfirmed. A working signup form does not leave
 *     that behind. A Listmonk change that hid other projects'
 *     memberships from this API user would, and it would empty the
 *     instance. The rule depends on `lists` holding every membership
 *     (see listAllSubscribers in listmonk.ts).
 *
 * It runs once a day in production (`scheduleUnconfirmedCleanup`, from
 * routes.ts) and on demand with `pnpm newsletter:prune [--dry-run]`.
 */

import {
  deleteSubscribers,
  getSubscriber,
  type ListmonkSubscriber,
  listAllSubscribers,
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

/** Subscribers the rule above deletes. */
export function findUnconfirmed(subscribers: ListmonkSubscriber[], cutoff: number): ListmonkSubscriber[] {
  return subscribers.filter((sub) => {
    if (sub.status !== "enabled") return false;
    if ((sub.lists?.length ?? 0) > 0) return false;
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
  /** Set when the run refused to delete anything. */
  refused?: string;
};

/** Find and (unless `dryRun`) delete never-confirmed subscribers. */
export async function pruneUnconfirmed(
  opts: { dryRun?: boolean; now?: number; days?: number } = {},
): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.days ?? UNCONFIRMED_TTL_DAYS) * DAY_MS;
  const subscribers = await listAllSubscribers();
  const stale = findUnconfirmed(subscribers, cutoff);
  const batch = stale.slice(0, MAX_PER_RUN);
  const result: PruneResult = {
    total: subscribers.length,
    candidates: stale.length,
    deleted: 0,
    deferred: stale.length - batch.length,
    emails: stale.map((s) => s.email),
  };

  const enabled = subscribers.filter((s) => s.status === "enabled").length;
  if (stale.length > 10 && stale.length * 2 > enabled) {
    result.refused = `${stale.length} of ${enabled} enabled subscribers look unconfirmed; refusing to delete that many. Check Listmonk → Subscribers; if they really are pending signups, delete them in Listmonk → Maintenance.`;
    log("error", "refused", { total: result.total, candidates: stale.length });
    return result;
  }

  if (!opts.dryRun) {
    for (let i = 0; i < batch.length; i += BATCH) {
      const ids: number[] = [];
      for (const sub of batch.slice(i, i + BATCH)) {
        // Read it again: a confirm click since the listing added a list.
        const fresh = await getSubscriber(sub.id);
        if (fresh && findUnconfirmed([fresh], cutoff).length === 1) ids.push(sub.id);
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
