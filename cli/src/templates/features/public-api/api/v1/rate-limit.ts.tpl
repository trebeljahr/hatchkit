// Rate limiting for the public API: fixed 60-second windows, counted in Redis
// when there is one and in this process when there is not.
//
// Fixed window rather than a token bucket because it is INCR plus a
// first-write EXPIRE — two commands, no Lua script to keep in step with the
// deploy, and no stored clock to drift. The cost is the boundary burst, up to
// 2x the limit across two adjacent windows, which for an integration API is
// the right trade: the limit exists to stop a runaway loop, not to shape
// traffic to the millisecond.
//
// TWO counters, because one key can only defend against one thing:
//
//   - per TOKEN — the unit somebody can revoke and re-mint, so the unit whose
//     misbehaviour can be isolated. Keyed on the user instead, one broken
//     script would starve that person's other integrations.
//   - per SOURCE ADDRESS **and presented token prefix**, on FAILED
//     authentication. The 401 path runs before any token is known to exist, so
//     it cannot be keyed on a token id. It is deliberately NOT keyed on the
//     address alone — see `checkAuthFailureBudget`.
import type { Response } from "express";
import { getRedis } from "../../db/redis.js";
import { env } from "../../config/env.js";

const WINDOW_MS = 60_000;
const KEY_PREFIX = "ratelimit:";

/**
 * The budget for requests that never authenticated, per failure key, per
 * minute.
 *
 * Deliberately small and NOT configurable alongside the authenticated limit:
 * nothing legitimate retries a rejected credential quickly. A human pasting a
 * mistyped token retries a handful of times; a script probing token prefixes
 * does not.
 */
const AUTH_FAILURE_PER_MINUTE = 30;

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window rolls over. */
  resetSeconds: number;
};

/**
 * The Redis-less fallback.
 *
 * A self-hoster running one container with no Redis still gets a working
 * limit; the documented caveat is that it is then per PROCESS, so two replicas
 * without Redis effectively double it. Silently having no limit at all would
 * be worse — that is the configuration in which one runaway script takes the
 * database down.
 *
 * Bounded in both directions that matter: entries are dropped when the window
 * rolls over, and the store refuses to grow past a fixed number of keys,
 * falling OPEN instead. A limiter that can be made to eat the heap is a worse
 * outage than the one it prevents.
 */
type MemoryWindow = { windowId: number; count: number };

type MemoryStore = {
  readonly entries: Map<string, MemoryWindow>;
  readonly maxEntries: number;
  /** The window this store was last swept for. `-1` is "never". */
  sweptWindowId: number;
};

function createMemoryStore(maxEntries: number): MemoryStore {
  return { entries: new Map(), maxEntries, sweptWindowId: -1 };
}

/**
 * Authenticated and failed-authentication counters in SEPARATE maps, with
 * separate ceilings.
 *
 * Creating an authenticated key costs a valid token; creating a failure key
 * costs nothing but a socket. One shared map would let unauthenticated junk
 * fill it to the ceiling and thereby switch the authenticated limiter off for
 * the rest of the window — an anonymous caller disabling the control that
 * exists to stop runaway authenticated ones.
 */
const authenticatedCounters = createMemoryStore(20_000);
const authFailureCounters = createMemoryStore(10_000);

/**
 * Swept on window ROLLOVER, not on write.
 *
 * A per-write sweep is O(n) over a map any caller can grow and deletes nothing
 * while it runs — every entry shares the current window id until the window
 * ends. That turns each further request into a linear scan and lets a caller
 * with a large address range stall the whole event loop. Comparing against the
 * last swept window makes the scan run once a minute instead. Still no timer:
 * a background interval would keep the process alive in tests.
 */
function sweepOnRollover(store: MemoryStore, windowId: number): void {
  if (store.sweptWindowId === windowId) return;
  store.sweptWindowId = windowId;
  for (const [key, entry] of store.entries) {
    if (entry.windowId !== windowId) store.entries.delete(key);
  }
}

/** Count one hit in memory, or `null` at the ceiling, which means fall open. */
function countInMemory(store: MemoryStore, key: string, windowId: number): number | null {
  sweepOnRollover(store, windowId);
  const existing = store.entries.get(key);
  if (existing) {
    // Reused rather than replaced, so a key that survives a rollover between
    // sweeps cannot count against the ceiling twice.
    if (existing.windowId !== windowId) {
      existing.windowId = windowId;
      existing.count = 1;
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }
  if (store.entries.size >= store.maxEntries) return null;
  store.entries.set(key, { windowId, count: 1 });
  return 1;
}

/** Read a count. Deliberately never creates an entry — a read must not grow the map. */
function peekInMemory(store: MemoryStore, key: string, windowId: number): number {
  const existing = store.entries.get(key);
  return existing && existing.windowId === windowId ? existing.count : 0;
}

/** Test seam — the fallback counters are process-global state. */
export function resetInMemoryRateLimits(): void {
  for (const store of [authenticatedCounters, authFailureCounters]) {
    store.entries.clear();
    store.sweptWindowId = -1;
  }
}

/**
 * Count one hit against a window, or `null` when it could not be counted —
 * Redis unreachable, or the fallback at its entry ceiling.
 *
 * `null` means FALL OPEN and every caller treats it that way. The limiter is a
 * safeguard against runaway callers, and turning a Redis blip into a 429 storm
 * across every integration would be a far larger outage than the one it
 * guards against.
 */
async function bumpWindow(
  store: MemoryStore,
  key: string,
  windowId: number,
): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return countInMemory(store, key, windowId);
  try {
    const full = `${KEY_PREFIX}${key}:${windowId}`;
    const count = await redis.incr(full);
    // Only the first write sets the TTL. Re-issuing EXPIRE on every request
    // would slide the window forward forever and the key would never drop.
    if (count === 1) await redis.expire(full, Math.ceil(WINDOW_MS / 1000));
    return count;
  } catch {
    return null;
  }
}

/** Read a window's count WITHOUT charging for it. `null` means fall open. */
async function readWindow(
  store: MemoryStore,
  key: string,
  windowId: number,
): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return peekInMemory(store, key, windowId);
  try {
    const raw = await redis.get(`${KEY_PREFIX}${key}:${windowId}`);
    if (raw === null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return null;
  }
}

function windowIdAt(now: number): number {
  return Math.floor(now / WINDOW_MS);
}

function resetSecondsAt(now: number): number {
  return Math.ceil(((windowIdAt(now) + 1) * WINDOW_MS - now) / 1000);
}

function resultFor(count: number | null, limit: number, resetSeconds: number): RateLimitResult {
  if (count === null) return { allowed: true, limit, remaining: limit, resetSeconds };
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds,
  };
}

/**
 * The same, for a counter READ rather than charged.
 *
 * `<` and not `<=`, because `count` is what has already been spent and the
 * request being judged has not been charged yet — it will be only if it too
 * fails. Reusing the charged form would grant one extra failure per window.
 */
function budgetLeft(count: number | null, limit: number, resetSeconds: number): RateLimitResult {
  if (count === null) return { allowed: true, limit, remaining: limit, resetSeconds };
  return {
    allowed: count < limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds,
  };
}

/** Count one authenticated request against its token. */
export async function consumeRateLimit(
  tokenId: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const limit = env.API_RATE_LIMIT_PER_MINUTE;
  const windowId = windowIdAt(now);
  const count = await bumpWindow(authenticatedCounters, `apitoken:${tokenId}`, windowId);
  return resultFor(count, limit, resetSecondsAt(now));
}

/**
 * Has this failure key already burned its budget of failed authentications?
 *
 * `key` is the caller's composite — see `authFailureKey` in `auth.ts`, which
 * builds it from the source address AND the token prefix that was presented.
 * This function never sees an address on its own, and that is the point: keyed
 * on the address alone, thirty rejected requests refuse every OTHER credential
 * arriving from the same NAT, office, CI runner or PaaS egress pool for the
 * rest of the window, including valid ones — a denial primitive anyone who
 * knows a victim's egress address can fire on purpose.
 *
 * READ-only, and called BEFORE the token lookup. That ordering is what buys
 * anything: authentication costs an indexed `findOne` per call, and a
 * well-formed but bogus bearer value reaches it without any credential
 * existing. Metering only after a successful authentication leaves the failure
 * path — the cheap half to abuse — unmetered.
 */
export async function checkAuthFailureBudget(
  key: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const count = await readWindow(authFailureCounters, `authfail:${key}`, windowIdAt(now));
  return budgetLeft(count, AUTH_FAILURE_PER_MINUTE, resetSecondsAt(now));
}

/** Charge one failed authentication to a failure key. */
export async function recordAuthFailure(key: string, now: number = Date.now()): Promise<void> {
  await bumpWindow(authFailureCounters, `authfail:${key}`, windowIdAt(now));
}

/**
 * The `RateLimit-*` headers, on every authenticated response.
 *
 * On every response, not only on a 429: a client that can discover its budget
 * only by being refused has to hit the wall to learn where it is.
 */
export function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader("RateLimit-Limit", String(result.limit));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(result.resetSeconds));
}
