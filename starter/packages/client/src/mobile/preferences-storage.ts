/*
 * Durable key-value storage, and the three-tier rule it belongs to.
 *
 * THE THREE TIERS. This file implements exactly one of them; it documents all
 * three because the mistake is always putting a value in the wrong tier, not
 * using the wrong API within a tier.
 *
 *   1. CREDENTIALS — session tokens, refresh tokens, anything that grants
 *      access. Platform keychain, via `lib/native-session.ts`. NEVER here.
 *      The preference store is plain UserDefaults / SharedPreferences and is
 *      readable from an unencrypted device backup.
 *
 *   2. ANYTHING THE APP CANNOT AFFORD TO LOSE — draft content, progress,
 *      purchases restored offline, a pending mutation queue. The platform
 *      preference store (@capacitor/preferences => UserDefaults on iOS,
 *      SharedPreferences on Android). That is this file.
 *
 *   3. DISPOSABLE CONVENIENCES — a remembered filter, the collapsed state of a
 *      sidebar, the theme. Web storage is fine; losing it costs one click.
 *
 * WHY TIER 2 EXISTS AT ALL:
 *   iOS WKWebView classifies localStorage/IndexedDB as *non-critical web data*
 *   and reclaims it under disk pressure, or after roughly a week of the app
 *   not being opened. The user did nothing; the OS deleted it.
 *   And because every web-storage accessor in this file (and in every other
 *   codebase) swallows its own throws — it has to, Safari private mode makes
 *   `setItem` throw — THE LOSS IS SILENT. There is no error, no event, no log
 *   line. The app simply boots one day as if it had just been installed.
 *
 * On web there is no preference store, so the same interface is backed by
 * localStorage. That is not a downgrade: on web, tier 2 does not exist —
 * browsers do not evict an installed app's storage the way WKWebView does.
 */

/** Async key-value contract. Async because the native side is a bridge call. */
export interface DurableStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** What a backend must provide. Same shape as DurableStorage, by design. */
export type PreferenceBackend = DurableStorage;

/** Loader contract. Resolves to `null` when there is no native backend. */
export type BackendLoader = () => Promise<PreferenceBackend | null>;

/** The subset of the Web Storage API this module touches. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

function webStorage(): WebStorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    // Storage access denied (private mode, blocked cookies). Treat as absent
    // rather than throwing — a preference read must never break a render.
    return null;
  }
}

/**
 * Web-storage backend. Every accessor swallows — see the silent-loss note at
 * the top of the file; that swallowing is exactly why tier 2 is not this.
 */
const webBackend: PreferenceBackend = {
  async get(key) {
    try {
      return webStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      webStorage()?.setItem(key, value);
    } catch {
      /* quota exceeded or storage denied */
    }
  },
  async remove(key) {
    try {
      webStorage()?.removeItem(key);
    } catch {
      /* storage denied */
    }
  },
  async keys() {
    try {
      const s = webStorage();
      if (!s) return [];
      const out: string[] = [];
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        if (k != null) out.push(k);
      }
      return out;
    } catch {
      return [];
    }
  },
};

/**
 * Real native loader. The dynamic import is the point: it keeps
 * @capacitor/preferences out of the web bundle, and a missing plugin resolves
 * to `null` instead of throwing into a render.
 *
 * Note the return shape — a PLAIN OBJECT of bound calls, never the plugin
 * handle itself. Returning a Capacitor plugin handle from an `async` function
 * deadlocks; `lib/native-session.ts` documents that trap in full.
 */
async function loadPreferencesBackend(): Promise<PreferenceBackend | null> {
  try {
    if (typeof window === "undefined") return null;
    const cap = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    if (!cap?.isNativePlatform?.()) return null;

    const { Preferences } = await import("@capacitor/preferences");
    return {
      async get(key) {
        const res = await Preferences.get({ key });
        return res.value ?? null;
      },
      async set(key, value) {
        await Preferences.set({ key, value });
      },
      async remove(key) {
        await Preferences.remove({ key });
      },
      async keys() {
        const res = await Preferences.keys();
        return res.keys;
      },
    };
  } catch {
    return null;
  }
}

/**
 * Builds the store. `loadBackend` is an INJECTION POINT THAT EXISTS FOR THE
 * TESTS AND FOR NOTHING ELSE — it lets the unit tests supply a fake backend so
 * the dynamic import of a package that may not be installed is never attempted.
 * Application code calls `durableStorage`.
 */
export function createDurableStorage(
  loadBackend: BackendLoader = loadPreferencesBackend,
): DurableStorage {
  // Resolve the backend once and reuse the promise: concurrent first reads must
  // not each pay for a dynamic import, and must not race to a different answer.
  let backendPromise: Promise<PreferenceBackend> | null = null;

  function backend(): Promise<PreferenceBackend> {
    backendPromise ??= loadBackend()
      .then((b) => b ?? webBackend)
      .catch(() => webBackend);
    return backendPromise;
  }

  return {
    async get(key) {
      return (await backend()).get(key);
    },
    async set(key, value) {
      return (await backend()).set(key, value);
    },
    async remove(key) {
      return (await backend()).remove(key);
    },
    async keys() {
      return (await backend()).keys();
    },
  };
}

/** The app-wide durable store. */
export const durableStorage: DurableStorage = createDurableStorage();

/**
 * Marker recorded in the DURABLE store once the hand-over has completed.
 * Versioned: a future migration adds `-v2` rather than re-running `-v1`.
 *
 * The `starter.` prefix is rewritten to the project's own `storagePrefix` at
 * scaffold time — see `IDENTIFIER_RENAMES` in the CLI; it ships as a real
 * literal, not a mustache placeholder, so the starter runs unscaffolded.
 *
 * It has to be namespaced because on web the durable store IS localStorage, and
 * localStorage is scoped to an origin rather than to a path: every project a
 * user publishes to GitHub Pages shares `https://<user>.github.io`, so an
 * unprefixed marker written by one app tells a sibling app that its own
 * hand-over had already run — and that app then skips the migration forever.
 */
export const HANDOVER_MARKER_KEY = "starter.durable-handover-v1";

export interface HandoverResult {
  /** Keys actually moved out of web storage during this pass. */
  moved: string[];
  /** Keys skipped because the durable store already had them. */
  skipped: string[];
  /** False when a durable write failed; the marker is then NOT recorded. */
  completed: boolean;
}

export interface HandoverDeps {
  durable?: DurableStorage;
  web?: WebStorageLike | null;
  markerKey?: string;
}

/**
 * ONE-TIME HAND-OVER of keys an earlier build wrote to localStorage.
 *
 * WITHOUT THIS, CHANGING THE ADDRESS *IS* THE DATA LOSS. Shipping a release
 * that reads tier-2 values from the preference store instead of localStorage
 * does not migrate anything — it just stops looking where the data is. Every
 * user who updates finds an empty app, and the old values sit in a store the
 * new code never reads until WKWebView reclaims them.
 *
 * The three rules that make the pass safe to interrupt at any point:
 *
 *   1. SKIP a key the preference store already has. A partially completed
 *      earlier run, or a value the new build already wrote, must win over a
 *      stale web copy. Overwriting would silently roll the user back.
 *   2. NEVER delete the web copy until the durable write has RESOLVED. The
 *      bridge call can fail; a delete-then-write ordering loses the value for
 *      good on exactly the devices where the write fails.
 *   3. RECORD THE MARKER ONLY AFTER THE WHOLE PASS SUCCEEDED. A marker written
 *      mid-pass turns a transient failure into a permanent one, because the
 *      next launch skips the migration entirely.
 *
 * On web this is a no-op in effect: the durable store IS localStorage there, so
 * every key reads back as "already present" and is skipped. Harmless, and it
 * keeps one code path for both hosts.
 */
export async function handOverLegacyWebStorage(
  keys: string[],
  deps: HandoverDeps = {},
): Promise<HandoverResult> {
  const durable = deps.durable ?? durableStorage;
  const web = deps.web !== undefined ? deps.web : webStorage();
  const markerKey = deps.markerKey ?? HANDOVER_MARKER_KEY;

  const moved: string[] = [];
  const skipped: string[] = [];

  if (!web) return { moved, skipped, completed: true };

  try {
    if ((await durable.get(markerKey)) != null) {
      // Already done. Re-running is not merely wasteful: the web copies are
      // gone, so a second pass would find nothing and could only do harm.
      return { moved, skipped, completed: true };
    }
  } catch {
    // Cannot read the marker => cannot prove the pass has not already run.
    // Doing nothing is the safe answer; rule 1 would protect us anyway, but a
    // store we cannot read is a store we should not be writing to either.
    return { moved, skipped, completed: false };
  }

  for (const key of keys) {
    let legacy: string | null = null;
    try {
      legacy = web.getItem(key);
    } catch {
      legacy = null;
    }
    if (legacy == null) continue;

    // Rule 1.
    let existing: string | null = null;
    try {
      existing = await durable.get(key);
    } catch {
      return { moved, skipped, completed: false };
    }
    if (existing != null) {
      skipped.push(key);
      continue;
    }

    // Rule 2: write first, and only remove once the write has resolved.
    try {
      await durable.set(key, legacy);
    } catch {
      return { moved, skipped, completed: false };
    }
    try {
      web.removeItem(key);
    } catch {
      // The durable copy is in place, which is what matters. A leftover web
      // copy is dead weight, not data loss.
    }
    moved.push(key);
  }

  // Rule 3.
  try {
    await durable.set(markerKey, new Date().toISOString());
  } catch {
    return { moved, skipped, completed: false };
  }

  return { moved, skipped, completed: true };
}
