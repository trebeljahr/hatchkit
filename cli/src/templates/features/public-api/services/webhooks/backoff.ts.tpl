// When a failed delivery is tried again, and when an endpoint gives up on
// being an endpoint.
//
// Pure and table-shaped on purpose: the schedule is the part of retry logic
// that is easy to get subtly wrong — an off-by-one that retries forever, or
// one that gives up on the first blip — and a table can be asserted
// exhaustively without a database, a clock or a network.
import { WEBHOOK_AUTO_DISABLE_AFTER } from "../../models/WebhookSubscription.js";

/**
 * Delay before attempt N+1, indexed by the number of attempts already made.
 *
 * 0s, 30s, 2m, 10m, 1h, 6h — six attempts spanning just under eight hours.
 * The first entry is 0 because attempt 1 is due the moment the event is
 * enqueued; the rest widen fast enough that a receiver rebooting for ten
 * minutes is covered without this server hammering a host that is truly gone.
 */
export const WEBHOOK_BACKOFF_MS = [0, 30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;

/** Six attempts total. Derived from the table so the two cannot drift. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length;

/**
 * How long to wait before the next attempt, or `null` when there is none.
 *
 * `null` is the terminal signal and the ONLY one. A caller that instead
 * compares `attemptsMade` against a hard-coded 6 somewhere else is how the
 * table and the give-up point stop agreeing.
 */
export function retryDelayMs(attemptsMade: number): number | null {
  if (attemptsMade < 1) return WEBHOOK_BACKOFF_MS[0];
  return WEBHOOK_BACKOFF_MS[attemptsMade] ?? null;
}

/** The same, as an absolute instant. `null` means "do not schedule again". */
export function nextAttemptAt(attemptsMade: number, from: Date): Date | null {
  const delay = retryDelayMs(attemptsMade);
  if (delay === null) return null;
  return new Date(from.getTime() + delay);
}

/**
 * Has this endpoint failed for long enough to be switched off?
 *
 * The threshold lives on the model next to the field it governs and is
 * imported rather than restated — two copies of a number like this drift the
 * first time somebody tunes one.
 */
export function shouldAutoDisable(consecutiveFailures: number): boolean {
  return consecutiveFailures >= WEBHOOK_AUTO_DISABLE_AFTER;
}
