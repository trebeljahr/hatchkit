/*
 * One verdict on connectivity, taken from the platform radio.
 *
 * `navigator.onLine` IS NOT THAT VERDICT INSIDE A WEBVIEW.
 *   - WKWebView reports `true` on a dead radio: the interface is up, so the
 *     browser-level flag stays true while nothing can leave the device.
 *   - Airplane mode does not reliably fire `offline` in the WebView at all,
 *     so a listener-only design never learns about the most common way a
 *     phone goes offline.
 *   - Android is closer to honest, but still reports captive-portal Wi-Fi as
 *     online.
 * @capacitor/network reads the OS connectivity state instead, and fires on the
 * transitions the WebView misses.
 *
 * Both sources feed ONE cached verdict, so `isOnline()` and `subscribeOnline()`
 * can never disagree with each other. Two half-correct answers in two places is
 * how a UI ends up showing an offline banner over a screen that is actively
 * loading data.
 */

/** Minimal shape of @capacitor/network's status payload. */
interface NetworkStatus {
  connected: boolean;
}

/** Plain-object surface, never the plugin handle (see lib/native-session.ts). */
interface NetworkApi {
  getStatus(): Promise<NetworkStatus>;
  onChange(cb: (status: NetworkStatus) => void): Promise<() => void>;
}

export type NetworkLoader = () => Promise<NetworkApi | null>;

function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}

/**
 * Real loader. Returns a PLAIN OBJECT of bound calls — a Capacitor plugin
 * handle returned from an `async` function deadlocks; see lib/native-session.ts.
 */
const loadNetworkPlugin: NetworkLoader = async () => {
  if (!isNativeShell()) return null;
  try {
    const { Network } = await import("@capacitor/network");
    return {
      async getStatus() {
        const s = await Network.getStatus();
        return { connected: s.connected };
      },
      async onChange(cb) {
        const handle = await Network.addListener(
          "networkStatusChange",
          (s: NetworkStatus) => cb({ connected: s.connected }),
        );
        return () => {
          void handle.remove();
        };
      },
    };
  } catch {
    return null;
  }
};

function browserOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  // Optimistic default: a false "offline" blocks work the user could have
  // done, which is worse than a failed request they can retry.
  return navigator.onLine !== false;
}

/** The single cached verdict. */
let online = browserOnline();
const listeners = new Set<(value: boolean) => void>();

function publish(next: boolean): void {
  if (next === online) return;
  online = next;
  for (const cb of [...listeners]) {
    try {
      cb(next);
    } catch {
      /* a subscriber must not be able to break the others */
    }
  }
}

let nativeReady: Promise<NetworkApi | null> | null = null;

function nativeApi(load: NetworkLoader): Promise<NetworkApi | null> {
  nativeReady ??= load().catch(() => null);
  return nativeReady;
}

/** The current verdict. Synchronous, because callers ask it inside handlers. */
export function isOnline(): boolean {
  return online;
}

/**
 * Re-reads the radio and updates the verdict. Call on resume: a phone that was
 * backgrounded on Wi-Fi and woken on a dead cell connection fires no event the
 * WebView can see, so the cached verdict is stale exactly when it matters.
 */
export async function refreshNetworkStatus(
  load: NetworkLoader = loadNetworkPlugin,
): Promise<boolean> {
  const api = await nativeApi(load);
  if (api) {
    try {
      publish((await api.getStatus()).connected);
      return online;
    } catch {
      /* fall through to the browser flag */
    }
  }
  publish(browserOnline());
  return online;
}

/**
 * Subscribes to the verdict. Returns a teardown.
 *
 * On native the radio is the source and the browser events are ignored; on web
 * the online/offline events are all there is. Either way subscribers see the
 * same value `isOnline()` returns.
 *
 * `load` is an injection point for the tests and nothing else.
 */
export function subscribeOnline(
  cb: (value: boolean) => void,
  load: NetworkLoader = loadNetworkPlugin,
): () => void {
  listeners.add(cb);

  let disposed = false;
  let removeNative: (() => void) | null = null;

  const onBrowserEvent = () => {
    // Only trusted on web. On native the radio has already spoken, and
    // `navigator.onLine` would happily overwrite a correct "offline" with a
    // stale "online".
    if (!isNativeShell()) publish(browserOnline());
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", onBrowserEvent);
    window.addEventListener("offline", onBrowserEvent);
  }

  void (async () => {
    const api = await nativeApi(load);
    if (!api || disposed) return;
    try {
      publish((await api.getStatus()).connected);
      removeNative = await api.onChange((s) => publish(s.connected));
      if (disposed) removeNative();
    } catch {
      /* keep the browser fallback */
    }
  })();

  return () => {
    disposed = true;
    listeners.delete(cb);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onBrowserEvent);
      window.removeEventListener("offline", onBrowserEvent);
    }
    removeNative?.();
  };
}

/**
 * Was this failure the network, or the server saying no?
 *
 * SHORT-CIRCUITS ON `isOnline()` ON PURPOSE, and this is the load-bearing part:
 * the answer decides whether a refused mutation is QUEUED FOR REPLAY or ROLLED
 * BACK. Call a server rejection a network error and the app replays a write the
 * server already refused — a duplicate charge, a resurrected deleted row. Call
 * a real disconnect a server rejection and the app discards work the user did
 * with no signal, which they will never know to redo.
 *
 * So: if the radio says we are offline, any failure is a network failure,
 * whatever the error object looks like. Only when we believe we are online do
 * we bother inspecting the error.
 */
export function isNetworkError(err: unknown): boolean {
  if (!isOnline()) return true;

  if (err instanceof TypeError) {
    // `fetch` rejects with a TypeError for transport-level failures. A response
    // that arrived — even a 500 — never comes back as one.
    return true;
  }
  if (err instanceof DOMException && err.name === "AbortError") return false;

  const message =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown })?.message === "string"
          ? (err as { message: string }).message
          : "";

  return /network|failed to fetch|load failed|connection|offline|timed? ?out|ECONN|ENOTFOUND|ETIMEDOUT/i.test(
    message,
  );
}
