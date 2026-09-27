// GENERATED — DO NOT EDIT.
//
// A byte-for-byte copy of a file in the shared client core, with its import
// specifiers rewritten for this flat directory. Written by
// `scripts/vendor-core.mjs`; `npm test` fails when it is stale.
//
// Edit the source package and re-run the generator. An edit made here is
// silently overwritten on the next run, and until then this surface behaves
// differently from every other client.

/**
 * What each server this client talks to has said about its API level.
 *
 * One cache per client, keyed by server origin, because a person can move a
 * client between servers — a hosted one, one they run themselves, a staging one
 * — and the levels of two servers have nothing to do with each other. Every
 * client refreshes it at the same moments (app start, a resume, a server switch,
 * and whenever a replay is held because the server lacks a procedure) and reads
 * it for three decisions:
 *
 *  - feature gating (`serverSupports` in `@starter/shared`);
 *  - holding queued rows the server is too old for;
 *  - the "server too old" / "app too old" banners ({@link ServerLevelCache.compatibility}).
 *
 * A cache and nothing more: an origin never asked is `null`, which every reader
 * treats as "not known yet" — and NEVER as level 0, which is a real answer from a
 * server released before the version handshake existed. Confusing the two turns
 * "we have not asked yet" into "this server supports nothing", which hides
 * working features behind a health read that has not landed.
 */

import { CLIENT_TOO_OLD, parseApiLevel, serverSupports } from "./api-level";
import type { Capability, VersionRefusal } from "./api-level";

import {
  checkServer,
  sameServerOrigin,
  serverCompatibility,
  type ServerCheck,
} from "./network";
import type { KeyValueStorage } from "./storage";
import {
  decodeVersioned,
  encodeVersioned,
  type VersionedSpec,
} from "./versioned-storage";

/**
 * The self-hosting guide's "Upgrading" section, relative to the docs site.
 *
 * One constant, because every "server too old" banner sends a person to the same
 * place whichever surface shows it — and a surface that invents its own link is
 * the one that goes stale.
 */
export const SERVER_UPGRADE_DOCS_PATH = "/docs/self-hosting#upgrading";

/** What one server said about its level, and when. */
export type ServerLevel = {
  origin: string;
  /** The server's API level; 0 for a server that reports none. */
  apiLevel: number;
  /** The lowest client level it serves, when it said. */
  minClientApiLevel: number | null;
  /** Its release, e.g. "0.3.1", when it said. */
  release: string | null;
  /** ISO instant of the health read this came from. */
  checkedAt: string;
  /**
   * Set when a request was refused with `CLIENT_TOO_OLD`, which a server can
   * answer even when its health read said nothing about a floor. Cleared by the
   * next health read that shows this build is served again.
   */
  clientTooOld: boolean;
};

export type ServerLevelCache = {
  /** What is known about `origin`, or null when it was never asked. */
  get(origin: string): ServerLevel | null;
  /** The level of `origin`, or null when unknown. */
  apiLevel(origin: string): number | null;
  /** `serverSupports` against what is known about `origin`. */
  supports(origin: string, capability: Capability): boolean;
  /** Which side is too old for the other, or null (also when unknown). */
  compatibility(origin: string): VersionRefusal | null;
  /** Record a health read made elsewhere — a server picker's own `checkServer`. */
  record(
    level: Omit<ServerLevel, "checkedAt" | "clientTooOld"> & { checkedAt?: string },
  ): void;
  /** A request to `origin` was refused as `CLIENT_TOO_OLD`. */
  noteClientTooOld(origin: string): void;
  /**
   * Ask `origin` again. Concurrent calls for one origin share one request. A
   * failed read keeps what was known: an unreachable server has not changed its
   * level, and forgetting it would turn a moment without signal into "this server
   * supports nothing".
   */
  refresh(origin: string): Promise<ServerLevel | null>;
  /** Read the persisted copy, when the cache has storage. Idempotent. */
  hydrate(): Promise<void>;
  subscribe(listener: () => void): () => void;
};

export type ServerLevelCacheOptions = {
  /**
   * Persist across launches — a launcher extension runs each command as a fresh
   * process, so without this it would re-read every server's level every time.
   */
  storage?: KeyValueStorage;
  key?: string;
  /** Defaults to core's `checkServer`. */
  check?: (origin: string) => Promise<ServerCheck>;
  now?: () => number;
};

export const SERVER_LEVELS_STORAGE_KEY = "starter.server-levels";

const STORED_VERSION = 1;

const readLevel = (value: unknown): ServerLevel | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const apiLevel = parseApiLevel(record.apiLevel);
  if (typeof record.origin !== "string" || apiLevel === null) return null;
  if (typeof record.checkedAt !== "string") return null;
  return {
    origin: record.origin,
    apiLevel,
    minClientApiLevel: parseApiLevel(record.minClientApiLevel),
    release: typeof record.release === "string" ? record.release : null,
    checkedAt: record.checkedAt,
    clientTooOld: record.clientTooOld === true,
  };
};

const LEVELS_SPEC: VersionedSpec<ServerLevel[]> = {
  version: STORED_VERSION,
  decode: (data) =>
    Array.isArray(data)
      ? data.map(readLevel).filter((it): it is ServerLevel => it !== null)
      : null,
};

export const createServerLevelCache = (
  options: ServerLevelCacheOptions = {},
): ServerLevelCache => {
  const key = options.key ?? SERVER_LEVELS_STORAGE_KEY;
  const check = options.check ?? ((origin: string) => checkServer(origin));
  const now = options.now ?? Date.now;
  let levels: ServerLevel[] = [];
  const listeners = new Set<() => void>();
  const inFlight = new Map<string, Promise<ServerLevel | null>>();
  let hydrated: Promise<void> | null = null;

  const find = (origin: string): ServerLevel | null =>
    levels.find((it) => sameServerOrigin(it.origin, origin)) ?? null;

  const put = (level: ServerLevel): void => {
    levels = [
      ...levels.filter((it) => !sameServerOrigin(it.origin, level.origin)),
      level,
    ];
    for (const listener of listeners) listener();
    if (options.storage) {
      // Fire and forget: a store that cannot be written is a slower next launch,
      // never a reason to fail the read that just succeeded.
      void options.storage
        .setItem(key, encodeVersioned(STORED_VERSION, levels))
        .catch(() => undefined);
    }
  };

  const cache: ServerLevelCache = {
    get: find,
    apiLevel: (origin) => find(origin)?.apiLevel ?? null,
    supports: (origin, capability) =>
      serverSupports(capability, cache.apiLevel(origin)),
    compatibility: (origin) => {
      const level = find(origin);
      // Never asked: no banner. "Not known yet" is not a verdict.
      if (level === null) return null;
      if (level.clientTooOld) return CLIENT_TOO_OLD;
      return serverCompatibility(level);
    },
    record: (level) =>
      put({
        origin: level.origin,
        apiLevel: level.apiLevel,
        minClientApiLevel: level.minClientApiLevel,
        release: level.release,
        checkedAt: level.checkedAt ?? new Date(now()).toISOString(),
        // A health read that answered is the newest word on this build being
        // served, so it clears an earlier refusal rather than being ignored.
        clientTooOld: false,
      }),
    noteClientTooOld: (origin) => {
      const known = find(origin);
      if (known?.clientTooOld) return;
      put({
        origin,
        // A server that refuses by level has the handshake, so it is at least 1.
        apiLevel: known?.apiLevel ?? 1,
        minClientApiLevel: known?.minClientApiLevel ?? null,
        release: known?.release ?? null,
        // No health read happened: the epoch says so, and a throttled refresh
        // ("asked less than N minutes ago") therefore asks at once instead of
        // sitting on a refusal it has never verified.
        checkedAt: known?.checkedAt ?? new Date(0).toISOString(),
        clientTooOld: true,
      });
    },
    refresh: (origin) => {
      // One request per origin in flight. Every surface refreshes on the same
      // triggers — start, resume, a held replay — so several callers asking at
      // once is the normal case, not the exception.
      const running = inFlight.get(origin);
      if (running) return running;
      const request = check(origin)
        .then((result) => {
          if (!result.ok) return find(origin);
          cache.record({
            origin,
            apiLevel: result.server.apiLevel,
            minClientApiLevel: result.server.minClientApiLevel,
            release: result.server.release,
          });
          return find(origin);
        })
        .catch(() => find(origin))
        .finally(() => inFlight.delete(origin));
      inFlight.set(origin, request);
      return request;
    },
    hydrate: () => {
      if (!options.storage) return Promise.resolve();
      const storage = options.storage;
      hydrated ??= storage
        .getItem(key)
        .then((raw) => {
          const stored = raw === null ? null : decodeVersioned(raw, LEVELS_SPEC);
          if (stored === null) return;
          // Anything learned while the read was in flight wins over the stored
          // copy: a level read from the network a moment ago is newer than one
          // written on a previous launch, and a store read is slow enough that
          // the race is normal rather than theoretical.
          const fresh = levels;
          levels = [
            ...stored.filter(
              (it) => !fresh.some((live) => sameServerOrigin(live.origin, it.origin)),
            ),
            ...fresh,
          ];
          for (const listener of listeners) listener();
        })
        .catch(() => undefined);
      return hydrated;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return cache;
};
