/**
 * What each origin has told this install about its API level, kept across
 * Raycast processes.
 *
 * ============================================================
 * WHY IT HAS TO BE PERSISTED
 * ============================================================
 *
 * Every Raycast command is a fresh process. A cache that lives only in memory
 * therefore starts empty on every launch, and `supports(...)` answers "not
 * known yet" for the whole life of that command — which is not the same as
 * "no", so every capability gate reads unknown and every surface either hides
 * a feature the server has or offers one it does not. The shared kit's cache
 * takes a storage seam for exactly this; the host's job is to pass Raycast's
 * store and then respect two rules.
 *
 * **Hydrate before any read AND before any write.** A write that lands before
 * hydration persists this process's partial view over the stored one, throwing
 * away everything the other commands learned. `hydrate()` is idempotent and
 * cheap, so {@link capabilityCache} awaits it once and hands back an already
 * hydrated cache rather than leaving the rule to each call site.
 *
 * **Keyed by origin, so a changed preference needs no detection.** Point the
 * extension at another server and the lookup simply misses; nothing has to
 * notice that the origin moved.
 *
 * A failed read keeps what was known. An unreachable server has not changed its
 * level, and forgetting it would turn a moment without signal into "this server
 * supports nothing".
 */
import { type Capability, type ServerLevelCache, createServerLevelCache } from "../vendor";
import { raycastStorage } from "./storage";

/**
 * How long a level is trusted before a command start asks again.
 *
 * A throttle rather than a TTL: an entry older than this is still used, it just
 * also triggers a refresh in the background. Expiring it instead would make
 * every launch after the window read "unknown" until the network answered.
 */
const REFRESH_AFTER_MS = 10 * 60 * 1000;

let cache: ServerLevelCache | null = null;
let hydrating: Promise<void> | null = null;

/** The one cache for this process, hydrated. */
export async function capabilityCache(): Promise<ServerLevelCache> {
  cache ??= createServerLevelCache({ storage: raycastStorage() });
  hydrating ??= cache.hydrate();
  await hydrating;
  return cache;
}

/**
 * Ask `origin` again when what is known is old enough, and never block on it.
 *
 * Called at command start. The returned promise resolves when the refresh is
 * done, for a surface that wants to await it; a surface that does not simply
 * renders with what was hydrated, which is the point of persisting it.
 */
export async function refreshCapabilities(origin: string): Promise<void> {
  const known = await capabilityCache();
  const entry = known.get(origin);
  const checkedMs = entry === null ? 0 : Date.parse(entry.checkedAt);
  const fresh = Number.isFinite(checkedMs) && Date.now() - checkedMs < REFRESH_AFTER_MS;
  if (fresh) return;
  await known.refresh(origin);
}

/** Whether `origin` is known to serve `capability`. Unknown reads as false. */
export async function serverHas(origin: string, capability: Capability): Promise<boolean> {
  const known = await capabilityCache();
  return known.supports(origin, capability);
}

/** Test seam: drop the process-local cache so a suite can start clean. */
export function resetCapabilityCacheForTests(): void {
  cache = null;
  hydrating = null;
}
