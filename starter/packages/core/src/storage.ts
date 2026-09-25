/**
 * The storage seam: one key/value contract, bound by each host to its own
 * durable store.
 *
 * Nothing in this package opens a store itself. A host passes one in, because
 * only the host knows which of its stores answers which question — and getting
 * that wrong loses data silently rather than loudly.
 *
 * ## Two rules that decide where a value goes
 *
 * **Credentials belong in real secret storage.** A session token goes in the
 * OS keychain (iOS/macOS Keychain, the Android keystore, libsecret,
 * `chrome.storage.session`, a launcher's own secret store) — never in the same
 * plain store as data. Capacitor Preferences is `UserDefaults`, which is
 * readable from an unencrypted device backup; `localStorage` is readable by any
 * script that reaches the origin.
 *
 * **Data that must survive an OS eviction belongs in a platform store, not
 * browser local storage.** WKWebView classifies `localStorage` as *non-critical
 * web data* and reclaims it after low disk or roughly a week of not opening the
 * app; a browser clears it on "clear site data". {@link webStorage} swallows
 * every throw, so that loss is silent. What is in the offline queue is work the
 * person did that no server has ever seen, so it belongs in Capacitor
 * Preferences, `chrome.storage.local`, a JSON file beside the Electron
 * userData, or the launcher's own store. A remembered filter or a theme can
 * stay in `localStorage`, where eviction costs nothing.
 *
 * In short: three stores, on purpose — the keychain for the credential, a
 * platform store for anything with no other copy, and browser storage for
 * conveniences.
 */

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Synchronous, `localStorage`-shaped source this module can adapt. */
export interface SyncStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage — the default for tests and non-persistent hosts. */
export const memoryStorage = (): KeyValueStorage => {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
};

/**
 * Adapt a synchronous `localStorage`-like object.
 *
 * Quota errors and privacy-mode throws are swallowed: a store that cannot be
 * written must not crash the surface the person is looking at. That is also
 * exactly why this is the wrong home for the offline queue — read the rules at
 * the top of this file before binding it to one.
 */
export const webStorage = (backing: SyncStorageLike): KeyValueStorage => ({
  getItem: async (key) => {
    try {
      return backing.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: async (key, value) => {
    try {
      backing.setItem(key, value);
    } catch {
      /* quota exceeded or storage disabled — drop silently */
    }
  },
  removeItem: async (key) => {
    try {
      backing.removeItem(key);
    } catch {
      /* ignore */
    }
  },
});

/**
 * The marker key that records a completed one-time migration.
 *
 * Its own key, beside the moved value rather than inside it, so a value that
 * fails to decode later cannot make the migration look unfinished and run a
 * second time over whatever the app has written since.
 */
export const migrationMarkerKey = (key: string): string => `${key}.migrated`;

export type MigrateStoreResult =
  /** The marker was already set: nothing was read, nothing was written. */
  | { moved: false; reason: "already-migrated" }
  /** The old store had nothing under this key. The marker is still set. */
  | { moved: false; reason: "nothing-to-move" }
  /** The new store already had a value. The old one is left alone. */
  | { moved: false; reason: "target-occupied" }
  | { moved: true };

/**
 * Move one key from an old store to a new one, once, behind a marker.
 *
 * The case this exists for: a build that kept the offline queue in
 * `localStorage` ships an update that keeps it in a platform store instead.
 * Without this step, *changing the address is the data loss* — the new build
 * reads an empty queue and the old rows sit at an address nobody looks at until
 * the OS reclaims them.
 *
 * Three properties matter, and each one is a bug if dropped:
 *
 *  - **Once.** The marker is written whether or not anything moved, so a person
 *    who empties the queue after upgrading does not have the old rows handed
 *    back on the next launch.
 *  - **Never over a value that is already there.** A store that already holds
 *    this key has the newer truth; the old copy is stale by definition.
 *  - **The source is left in place.** Removing it makes a rollback to the
 *    previous build lose the rows outright. It costs one stale key and buys a
 *    safe downgrade; a host that wants it gone can pass `removeSource`.
 *
 * Never throws: a migration that fails must not stop the app from starting.
 * A failure leaves the marker unset, so the next launch tries again.
 */
export const migrateStore = async ({
  from,
  to,
  key,
  toKey = key,
  removeSource = false,
}: {
  from: KeyValueStorage;
  to: KeyValueStorage;
  key: string;
  /** Defaults to `key` — pass it only when the key itself is being renamed. */
  toKey?: string;
  removeSource?: boolean;
}): Promise<MigrateStoreResult> => {
  const marker = migrationMarkerKey(toKey);
  try {
    if ((await to.getItem(marker)) !== null) {
      return { moved: false, reason: "already-migrated" };
    }
    const existing = await to.getItem(toKey);
    if (existing !== null) {
      // Not marked, so claim it now: the value is already where it belongs and
      // asking again on every launch is a read of a store that may be slow.
      await to.setItem(marker, new Date().toISOString());
      return { moved: false, reason: "target-occupied" };
    }
    const value = await from.getItem(key);
    if (value === null) {
      await to.setItem(marker, new Date().toISOString());
      return { moved: false, reason: "nothing-to-move" };
    }
    await to.setItem(toKey, value);
    await to.setItem(marker, new Date().toISOString());
    if (removeSource) await from.removeItem(key);
    return { moved: true };
  } catch {
    // The marker is not set, so the next launch tries again.
    return { moved: false, reason: "nothing-to-move" };
  }
};
