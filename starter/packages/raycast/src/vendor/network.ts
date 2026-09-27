// GENERATED — DO NOT EDIT.
//
// A byte-for-byte copy of a file in the shared client core, with its import
// specifiers rewritten for this flat directory. Written by
// `scripts/vendor-core.mjs`; `npm test` fails when it is stale.
//
// Edit the source package and re-run the generator. An edit made here is
// silently overwritten on the next run, and until then this surface behaves
// differently from every other client.

/*
 * What "online" actually means, and which server a client is talking to.
 *
 * `navigator.onLine` is the browser's answer and it is a good one in a browser.
 * In a WKWebView it is not: it routinely reports `true` on a dead radio, and it
 * does not fire `online`/`offline` when the phone enters or leaves airplane
 * mode. Two things downstream take that lie seriously:
 *
 *  - a transport-failure test that short-circuits on it. A lying `true` makes a
 *    genuine server rejection look like a transport failure — the mutation is
 *    queued forever instead of rolled back — and a lying `false` makes a real
 *    refusal look like a hiccup.
 *  - the query library's decision whether to fetch at all. Fed the browser's
 *    answer, a backgrounded phone wakes up and fires a burst of doomed requests
 *    into a radio that is not there.
 *
 * So the truth comes from the platform's own reachability API wherever there is
 * one, and from the browser only where there is not. A host installs its radio
 * through {@link setNetworkProbe}; this package never imports a plugin of its
 * own, because the plugin belongs to the host and a package that reaches for one
 * drags it into every bundle that has no use for it.
 *
 * The server half lives here too — {@link sameServerOrigin},
 * {@link checkServer}, {@link serverCompatibility} — because "can this client
 * talk to that server" is the same question as "is there a network", asked one
 * layer up, and both answers are read by the same callers.
 */

import { API_LEVEL, CLIENT_TOO_OLD, SERVER_TOO_OLD, parseApiLevel } from "./api-level";
import type { VersionRefusal } from "./api-level";

// ── the radio ────────────────────────────────────────────────────────

/**
 * A platform's reachability API, reduced to the two things a caller needs.
 *
 * `online` is read synchronously on every decision, so it must be a cached value
 * the host keeps current rather than a request — a probe that awaits the OS is a
 * probe nobody can call from a transport-failure test.
 *
 * `subscribe` is called at most once, by this module, and returns its own
 * unsubscribe. Every caller's listener is fanned out from that one subscription:
 * a probe subscribed per caller would deliver each change once per caller.
 */
export type NetworkProbe = {
  online: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

let installed: NetworkProbe | null = null;
const listeners = new Set<() => void>();
/** Unsubscribe for the single bridge from the installed probe to `notify`. */
let probeStop: (() => void) | null = null;
let windowBound = false;

const notify = (): void => {
  for (const listener of listeners) listener();
};

const bindWindow = (): void => {
  if (windowBound || typeof window === "undefined") return;
  windowBound = true;
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
};

/**
 * One bridge from the installed probe to every listener, not one per listener: a
 * probe subscribed once per caller would fan each change out across every
 * listener once per caller, and a host that swaps probes would leak the old
 * one's subscription for each.
 */
const bindProbe = (): void => {
  if (probeStop !== null || installed === null) return;
  try {
    probeStop = installed.subscribe(notify);
  } catch {
    // A probe that cannot be subscribed to still answers `online()`.
    probeStop = null;
  }
};

/**
 * Install the host's radio, or clear it with `null`.
 *
 * The host imports its own plugin and adapts it here — `@capacitor/network` in a
 * Capacitor shell, `net`/`powerMonitor` in Electron, a launcher extension's own
 * API — and this package stays free of every one of them. Installing drops the
 * previous probe's subscription and tells every listener at once, because a new
 * probe usually knows something the old one did not.
 */
export const setNetworkProbe = (probe: NetworkProbe | null): void => {
  probeStop?.();
  probeStop = null;
  installed = probe;
  if (listeners.size > 0) bindProbe();
  notify();
};

/**
 * The browser's own answer as a probe, for a host that has nothing better.
 *
 * Self-contained: it binds its own window events rather than sharing this
 * module's, so installing it is the same operation as installing a platform
 * radio and clearing it leaves nothing behind.
 *
 * Guarded for a non-DOM runtime: a service worker has `navigator` but a Node
 * build and a launcher extension's process may have neither `navigator` nor
 * `window`, and asking there is not an error — it is simply unknown.
 */
export const browserNetworkProbe = (): NetworkProbe => ({
  online: () => {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
  },
  subscribe: (listener) => {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
      window.removeEventListener("online", listener);
      window.removeEventListener("offline", listener);
    };
  },
});

/**
 * The current verdict: the installed probe's answer, then the browser's, then
 * `true`.
 *
 * Unknown is `true`, never `false`. An unknown state must not declare the app
 * offline: a `false` short-circuits a transport-failure test into queueing work
 * the server actually refused, and stops the query library from making the one
 * request that would have settled the question.
 */
export const isOnline = (): boolean => {
  if (installed !== null) {
    try {
      return installed.online() !== false;
    } catch {
      // A probe that throws is a probe that knows nothing, and unknown is true.
      return true;
    }
  }
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
};

/**
 * Subscribe to changes in the verdict above.
 *
 * One subscription surface whichever probe is installed, so a caller never has
 * to know which platform it is on — and so a host that installs its radio after
 * the first listener attached still reaches that listener, because
 * `setNetworkProbe` notifies through the same set.
 */
export const subscribeNetwork = (listener: () => void): (() => void) => {
  listeners.add(listener);
  bindWindow();
  bindProbe();
  return () => {
    listeners.delete(listener);
  };
};

/** Test seam: forget the installed probe and every listener. */
export const resetNetworkForTests = (): void => {
  probeStop?.();
  probeStop = null;
  installed = null;
  listeners.clear();
};

// ── which server ─────────────────────────────────────────────────────

/**
 * Same server, whatever the letter case or a trailing slash says.
 *
 * The offline queue compares the server a row was stamped with against the one
 * it is about to be sent to, so this comparison decides whether work is filed
 * against the right account. A loose one — a plain `===` over whatever a person
 * typed — files a row queued against `https://App.Example.com/` on
 * `https://app.example.com` as a different server, holds it forever, and a
 * looser one would send it to a server that never asked for it.
 *
 * Both sides are parsed as URLs and compared on protocol, host and port, which
 * is what `URL.origin` is; a host is case-insensitive there and a trailing slash
 * is not part of an origin at all. A value that does not parse falls back to a
 * trimmed, lowercased, slash-stripped string compare, so a half-typed address is
 * still only ever equal to itself.
 */
export const sameServerOrigin = (a: string, b: string): boolean => {
  const canonical = (value: string): string => {
    try {
      return new URL(value).origin;
    } catch {
      return value.trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  return canonical(a) === canonical(b);
};

/**
 * The lowest server API level this build works with.
 *
 * A server reporting less is refused with `SERVER_TOO_OLD` rather than left to
 * half-work. Level 0 is a server from before the version handshake, which
 * reports no level at all.
 *
 * Raise it only together with a client change that cannot work without the newer
 * server, and never past what the oldest self-hosted release a person could
 * still be running reports.
 */
export const MIN_SERVER_API_LEVEL = 1;

/**
 * Whether this build and a server can work together, or which side is too old.
 *
 * `SERVER_TOO_OLD` when the server's level is below this client's floor;
 * `CLIENT_TOO_OLD` when this build's `API_LEVEL` is below the floor the server
 * declared. Both are loud answers with a way out — update the server, update the
 * app — and neither is ever a reason to delete anything stored on the device.
 *
 * `null` means "these two are fine", and it also means "not known yet": a caller
 * holding levels it has not read yet gets the same optimistic answer as one
 * holding levels that agree, because a banner shown on a guess is worse than a
 * banner shown a second late.
 */
export const serverCompatibility = (levels: {
  apiLevel: number;
  minClientApiLevel: number | null;
  /** Override this build's floor. Defaults to {@link MIN_SERVER_API_LEVEL}. */
  minServerApiLevel?: number | null;
}): VersionRefusal | null => {
  const minServer = levels.minServerApiLevel ?? MIN_SERVER_API_LEVEL;
  if (levels.apiLevel < minServer) return SERVER_TOO_OLD;
  if (levels.minClientApiLevel !== null && API_LEVEL < levels.minClientApiLevel) {
    return CLIENT_TOO_OLD;
  }
  return null;
};

/** What a server said about itself, or why it could not be asked. */
export type ServerCheck =
  | {
      ok: true;
      server: {
        origin: string;
        /** Its API level. 0 for a server that reports none. */
        apiLevel: number;
        /** The lowest client level it serves, when it said. */
        minClientApiLevel: number | null;
        /** Its release, e.g. "0.3.1", when it said. */
        release: string | null;
      };
    }
  | { ok: false; reason: "unreachable" | "not-a-server" };

/** Give up after this long. A server that takes longer is not usable anyway. */
const CHECK_TIMEOUT_MS = 10_000;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * Call `GET <origin>/api/health` and read the levels out of the answer.
 *
 * **No custom headers.** Not the two handshake headers, not a client id,
 * nothing. A custom header forces the browser to preflight the request, and a
 * preflight an untrusted origin fails is indistinguishable here from a server
 * that is not there — so the one read whose entire job is "is this address a
 * server" would report `unreachable` for a server that is running, reachable and
 * simply does not trust the caller yet. The handshake headers go on API requests
 * and never on this one.
 *
 * A server that reports no `apiLevel` is level 0, not null: it answered, and
 * "released before the handshake" is a real answer. Null is reserved for an
 * origin nobody has asked.
 */
export const checkServer = async (
  origin: string,
  fetchImpl?: typeof fetch,
): Promise<ServerCheck> => {
  const doFetch =
    fetchImpl ??
    (globalThis as { fetch?: typeof fetch }).fetch?.bind(globalThis);
  if (!doFetch) return { ok: false, reason: "unreachable" };

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(`${origin.replace(/\/+$/, "")}/api/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      // Nothing to authenticate, and a cookie would make the answer depend on
      // who is asking.
      credentials: "omit",
      signal: controller.signal,
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(deadline);
  }

  if (!response.ok) return { ok: false, reason: "not-a-server" };

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "not-a-server" };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    // A 200 that is not JSON is a proxy, a captive portal or the web app's own
    // HTML — something in front of the server, not the server.
    return { ok: false, reason: "not-a-server" };
  }

  if (body.status !== "ok") return { ok: false, reason: "not-a-server" };

  /*
   * A server whose database is down answered, so it is not `not-a-server` — but
   * it cannot serve a single request either, and every caller's response to that
   * is the response to a server that did not answer: wait, and ask again. So it
   * reads as `unreachable` rather than being reported as a usable server whose
   * every call then fails.
   */
  if (body.db === false) return { ok: false, reason: "unreachable" };

  return {
    ok: true,
    server: {
      origin,
      apiLevel: parseApiLevel(body.apiLevel) ?? 0,
      minClientApiLevel: parseApiLevel(body.minClientApiLevel),
      release: text(body.release) ?? text(body.version),
    },
  };
};
