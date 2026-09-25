/*
 * cli/src/features/deploy-recovery/client-sources.ts — the client-side
 * modules this feature generates into a project.
 *
 * Why the sources live here as constants rather than as files under
 * `starter/`: `hatchkit update` and `hatchkit adopt` have to be able to
 * add deploy recovery to a project that was scaffolded before it
 * existed, and they have no starter tree to copy from. The same reason
 * scaffold/deploy-verification.ts carries its blocks inline.
 *
 * The generated `policy.ts` mirrors this feature's own policy.ts. The
 * two are separate copies on purpose — one is Node code the test suite
 * drives directly, the other ships to a browser — and the test asserts
 * the invariants that matter in both: the chunk guard is present, and
 * the module that DETECTS a new version cannot reload the page.
 *
 * Every source below is framework-shaped the way the starter's client
 * is: Next.js App Router, `"use client"` on anything that touches the
 * DOM, relative imports (an alias like `@/` is a per-project tsconfig
 * setting and not every adopted repo has one).
 */

/** Values the generated sources need stamped into them. */
import { CHUNK_ERROR_NAMES, CHUNK_ERROR_PATTERNS } from "./policy.js";

export interface ClientSourceOptions {
  /** Path the build-info file is served at, absolute from the web root.
   *  Written by the image build (scaffold/deploy-verification.ts) and by
   *  the local writer script below. */
  buildInfoPath: string;
  /** Build-time environment variable carrying the commit the bundle was
   *  built from. Inlined by the bundler, so it must be a name the
   *  bundler agrees to inline. */
  commitEnvVar: string;
  /** How often, at most, a tab asks which build is live. */
  intervalMs: number;
  /** How long an automatic chunk reload blocks the next one. */
  chunkGuardMs: number;
  /** Session-storage key for the chunk-reload guard. */
  chunkGuardKey: string;
}

/** The pure rules, mirrored from this feature's policy.ts. */
export function clientPolicySource(opts: ClientSourceOptions): string {
  return `/**
 * Deploy recovery — the rules, with no DOM and no timers in them.
 *
 * A tab that was open before a deploy is running code the server no
 * longer has. It keeps working until it lazily loads a route it has not
 * visited yet, and then that chunk 404s. Two answers live here:
 * comparing the built commit with the served one to OFFER a reload, and
 * taking one automatically — once — when a chunk has already failed.
 *
 * Generated and owned by hatchkit: regenerated on every hatchkit
 * update, so an edit here is lost. Everything in it is a pure function
 * so it can be unit-tested; the browser parts live in ./host.ts,
 * ./version-check.ts and ./chunk-reload.ts.
 */

/** How often, at most, a tab asks which build is live. */
export const VERSION_CHECK_INTERVAL_MS = ${opts.intervalMs};

/** An automatic chunk reload within this long of the previous one is
 *  refused. Removing this guard turns a broken server into a reload
 *  loop the person cannot read their way out of. */
export const CHUNK_RELOAD_GUARD_MS = ${opts.chunkGuardMs};

/** Session storage on purpose: the guard is about THIS tab's last
 *  attempt, and it must not outlive the tab. */
export const CHUNK_RELOAD_STORAGE_KEY = ${JSON.stringify(opts.chunkGuardKey)};

/** The shells that carry their own copy of the bundle. A deploy of the
 *  web image says nothing about them, and a reload there means
 *  something else entirely, so recovery is off in all of them. */
export const NATIVE_SHELLS = ["capacitor", "electron", "tauri"] as const;

export type ClientShell = "web" | (typeof NATIVE_SHELLS)[number];

export type RecoveryHost = {
  mode: string;
  shell: string;
  builtCommit: string;
};

export const isNativeShell = (shell: string): boolean =>
  (NATIVE_SHELLS as readonly string[]).includes(shell);

/**
 * Whether the version check may run at all. Off in development (the dev
 * server rebuilds in place and serves no build info), off in every
 * native shell, and off with no built commit — an unstamped build has
 * nothing to compare, so every answer would read as "different" and the
 * tab would offer a reload that changes nothing.
 */
export const isRecoveryEnabled = (host: RecoveryHost): boolean =>
  host.mode === "production" && !isNativeShell(host.shell) && host.builtCommit.trim() !== "";

/**
 * Whether the chunk-failure reload may run. Same host rules, minus the
 * commit: a chunk that failed to load is evidence in itself, so an image
 * that was never stamped still recovers — it just cannot be told about
 * the deploy in advance.
 */
export const isChunkRecoveryEnabled = (host: { mode: string; shell: string }): boolean =>
  host.mode === "production" && !isNativeShell(host.shell);

export type VersionCheckTrigger = "focus" | "visibility-change";

/**
 * Whether this trigger may turn into a request. Only the two named
 * triggers count, and a clock that moved backwards counts as due —
 * refusing would wedge the check until real time caught up with a stale
 * reading, which can be hours.
 */
export const shouldCheckVersion = (input: {
  now: number;
  lastCheckedAt: number;
  intervalMs: number;
  trigger: VersionCheckTrigger;
}): boolean => {
  if (input.trigger !== "focus" && input.trigger !== "visibility-change") return false;
  const elapsed = input.now - input.lastCheckedAt;
  if (elapsed < 0) return true;
  return elapsed >= input.intervalMs;
};

/** "unknown" is not a soft "same": offline, a captive portal, a proxy
 *  error page and an unstamped image all land here, and none of them is
 *  evidence of a deploy. */
export type VersionOutcome = "same" | "newer" | "unknown";

const MIN_ABBREVIATED_SHA = 7;

/**
 * Compare the running bundle's commit with the served one. "newer" is a
 * claim about DIFFERENCE — two shas cannot be ordered without the
 * repository — but the only thing that changes the served commit is a
 * new image, so different means newer.
 *
 * Prefix matching in both directions: the two facts travel by different
 * routes, and one of them being abbreviated is a configuration
 * difference rather than a deploy.
 */
export const evaluateVersion = (input: {
  builtCommit: string;
  servedCommit: string | null | undefined;
}): { outcome: VersionOutcome } => {
  const built = input.builtCommit.trim().toLowerCase();
  const served = (input.servedCommit ?? "").trim().toLowerCase();
  if (built === "" || served === "") return { outcome: "unknown" };
  if (built === served) return { outcome: "same" };
  const shorter = built.length < served.length ? built : served;
  const longer = built.length < served.length ? served : built;
  if (shorter.length >= MIN_ABBREVIATED_SHA && longer.startsWith(shorter)) {
    return { outcome: "same" };
  }
  return { outcome: "newer" };
};

/**
 * Whether to put the reload offer on screen. Deferred while writes are
 * in flight and re-evaluated once they drain: a reload during a write
 * aborts the request, and an offline queue cannot reliably catch a write
 * that fails while the document unloads.
 *
 * Note what this returns — an OFFER, never a reload. Someone is in the
 * middle of something, and a page that reloads itself under a half-typed
 * form is worse than a stale tab.
 */
export const shouldOfferReload = (input: {
  versionOutcome: VersionOutcome;
  writesInFlight: number;
  alreadyOffered: boolean;
}): boolean => {
  if (input.versionOutcome !== "newer") return false;
  if (input.alreadyOffered) return false;
  return input.writesInFlight === 0;
};

/**
 * Whether an automatic reload is allowed for a chunk that failed to
 * load. A reload cures a stale tab; it cures nothing when the server is
 * broken, the device is offline, or a proxy answers HTML for a script.
 * In those cases a second automatic reload loops forever, so the guard
 * stops after one and the error screen's own button takes over.
 */
export const shouldChunkReload = (input: {
  now: number;
  lastReloadAt: number | null;
  guardMs: number;
}): boolean => {
  const last = input.lastReloadAt;
  if (last === null || !Number.isFinite(last) || last <= 0) return true;
  const elapsed = input.now - last;
  if (elapsed < 0) return true;
  return elapsed >= input.guardMs;
};

/** The value to persist after taking a chunk reload. */
export const recordChunkReload = (now: number): string => String(now);

/** Anything that is not a positive finite number reads as "never
 *  reloaded" — refusing on garbage would leave a genuinely stale tab
 *  with no way out. */
export const readChunkReloadAt = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** The two storage operations the guard needs, as a plain pair, so the
 *  decision can be tested without a browser. */
export type GuardStore = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
};

/**
 * Read the guard, decide, write it back. With no working storage the
 * answer is always no: a browser that cannot remember it is looping is
 * the worst place to start a loop.
 */
export const claimChunkReload = (
  store: GuardStore | null,
  input: { now: number; guardMs?: number; key?: string },
): boolean => {
  if (store === null) return false;
  const key = input.key ?? CHUNK_RELOAD_STORAGE_KEY;
  const guardMs = input.guardMs ?? CHUNK_RELOAD_GUARD_MS;
  try {
    const lastReloadAt = readChunkReloadAt(store.get(key));
    if (!shouldChunkReload({ now: input.now, lastReloadAt, guardMs })) return false;
    store.set(key, recordChunkReload(input.now));
    return true;
  } catch {
    return false;
  }
};

/** Message shapes a failed chunk or dynamic import actually produces,
 *  across bundlers — matching one bundler's string is how this check
 *  silently stops working the day the project moves to another one.
 *
 *    webpack / Next.js : "Loading chunk 42 failed", "Loading CSS chunk"
 *    Vite / Rollup     : "Failed to fetch dynamically imported module",
 *                        "Unable to preload CSS for"
 *    Firefox           : "error loading dynamically imported module"
 *    Safari            : "Importing a module script failed"
 *    any bundler, when a 404 is answered with the index document:
 *                        "Failed to load module script" */
const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
${renderPatternList()}];

/**
 * Whether a thrown value is a chunk or dynamic-import load failure.
 * Takes unknown because every source hands over something different: an
 * ErrorEvent carries an Error or a bare string, a rejection carries
 * whatever was rejected, and an error boundary carries a re-thrown error
 * whose cause holds the real one. One level of cause is unwrapped.
 */
export const isChunkLoadFailure = (error: unknown, depth = 1): boolean => {
  if (typeof error === "string") return CHUNK_ERROR_PATTERNS.some((re) => re.test(error));
  if (typeof error !== "object" || error === null) return false;
  const { name, message, cause } = error as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (typeof name === "string" && ${renderNameList()}.includes(name)) return true;
  if (typeof message === "string" && CHUNK_ERROR_PATTERNS.some((re) => re.test(message))) {
    return true;
  }
  if (depth > 0 && cause !== undefined && cause !== null) {
    return isChunkLoadFailure(cause, depth - 1);
  }
  return false;
};
`;
}

/** Render {@link CHUNK_ERROR_PATTERNS} as the source lines of a literal
 *  array, so the shipped detector and the tested one are one list.
 *
 *  A regular expression round-trips through `source` + `flags` exactly,
 *  and the result is interpolated rather than written into the template
 *  literal, so no backslash needs escaping a second time — which is
 *  what the hand-kept copy got wrong-looking and easy to break. */
function renderPatternList(): string {
  return CHUNK_ERROR_PATTERNS.map((re) => `  /${re.source}/${re.flags},\n`).join("");
}

/** Render {@link CHUNK_ERROR_NAMES} as a literal array expression. */
function renderNameList(): string {
  return `[${CHUNK_ERROR_NAMES.map((n) => JSON.stringify(n)).join(", ")}]`;
}

/** The two places the generated code touches the browser: what host it
 *  is running in, and where the guard timestamp lives. */
export function clientHostSource(opts: ClientSourceOptions): string {
  return `"use client";

/**
 * Deploy recovery — the browser facts the rules need.
 *
 * Kept apart from ./policy.ts so the rules stay testable without a DOM,
 * and small enough to read in one go, because every line of it is a
 * guess about a host that cannot be verified from here.
 *
 * Generated and owned by hatchkit: regenerated on every hatchkit
 * update, so an edit here is lost. Change the app around it instead.
 */

import type { ClientShell, GuardStore } from "./policy";

/** The commit the running bundle was built from, inlined at build time.
 *  Empty for any build that was not stamped — a local build, or a native
 *  shell build — which disables the version check on its own. */
export const BUILT_COMMIT: string = process.env.${opts.commitEnvVar} ?? "";

/** Where the deployed build announces itself. The image build writes
 *  this file next to the export, and the static server sends it with no
 *  caching — otherwise the tab would be comparing itself against a
 *  cached copy of its own build. */
export const BUILD_INFO_PATH = ${JSON.stringify(opts.buildInfoPath)};

/**
 * Which host this bundle is running in.
 *
 * Capacitor first, and by its injected global rather than by the URL:
 * Android serves the bundle from https://localhost, which is
 * indistinguishable from an ordinary web origin by protocol alone. iOS
 * uses capacitor://, Electron the app:// protocol registered by its main
 * process, and Tauri tauri:// on macOS and Linux with
 * http://tauri.localhost on Windows.
 */
export const detectShell = (): ClientShell => {
  if (typeof window === "undefined") return "web";
  const w = window as unknown as Record<string, unknown>;
  if (w.Capacitor !== undefined || window.location.protocol === "capacitor:") return "capacitor";
  if (w.__TAURI__ !== undefined || w.__TAURI_INTERNALS__ !== undefined) return "tauri";
  if (window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost") {
    return "tauri";
  }
  if (window.location.protocol === "app:") return "electron";
  if (typeof navigator !== "undefined" && / Electron\\//.test(navigator.userAgent)) {
    return "electron";
  }
  return "web";
};

/** Everything the enable/disable rules read, gathered in one place. */
export const currentHost = (): { mode: string; shell: ClientShell; builtCommit: string } => ({
  mode: process.env.NODE_ENV ?? "production",
  shell: detectShell(),
  builtCommit: BUILT_COMMIT,
});

/** Session storage, or null when it cannot be used. Private mode and
 *  blocked site data throw on the first access rather than returning
 *  null, so the access itself has to be wrapped. */
export const sessionGuardStore = (): GuardStore | null => {
  try {
    const storage = window.sessionStorage;
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
    };
  } catch {
    return null;
  }
};
`;
}

/** The polite half: notice the deploy, offer a reload, never take one. */
export function versionCheckSource(_opts: ClientSourceOptions): string {
  return `"use client";

/**
 * Deploy recovery — noticing that a newer build is live.
 *
 * On focus and on becoming visible again (the two moments a stale tab is
 * about to be used, and both free while it sits in the background), and
 * at most once per interval, the tab fetches the build-info file and
 * compares the commit in it with the one baked into this bundle. A
 * difference produces an OFFER. Nothing in this module reloads the page:
 * the decision belongs to the person, and the component holds the only
 * call that acts on it.
 *
 * Generated and owned by hatchkit: regenerated on every hatchkit
 * update, so an edit here is lost. Change the app around it instead.
 */

import {
  VERSION_CHECK_INTERVAL_MS,
  evaluateVersion,
  shouldCheckVersion,
  shouldOfferReload,
} from "./policy";
import type { VersionCheckTrigger } from "./policy";
import { BUILD_INFO_PATH } from "./host";

/** The commit from a build-info body, or null when the answer is not
 *  one. An unstamped image writes an empty commit, which says nothing
 *  about whether this tab is current. */
export const readServedCommit = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const commit = (body as { commit?: unknown }).commit;
  if (typeof commit !== "string") return null;
  const trimmed = commit.trim();
  return trimmed === "" ? null : trimmed;
};

/** Fetch the build info, bypassing every cache on the way. The server
 *  sends it with no caching too; this is the half of that agreement the
 *  tab controls. */
export const fetchServedCommit = async (): Promise<string | null> => {
  const response = await fetch(BUILD_INFO_PATH, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  return readServedCommit(await response.json());
};

export type WriteActivity = {
  /** How many writes are in flight right now. */
  count: () => number;
  /** Called back whenever that number changes. Returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
};

/** No app state to consult: every check behaves as if nothing is in
 *  flight. Used when the component is mounted outside whatever holds the
 *  app's mutations. */
export const noWriteActivity: WriteActivity = {
  count: () => 0,
  subscribe: () => () => undefined,
};

export type VersionWatcherOptions = {
  builtCommit: string;
  fetchCommit?: () => Promise<string | null>;
  /** Called at most once per newer build. Shows the offer — it must not
   *  reload. */
  onOffer: (commit: string) => void;
  writes?: WriteActivity;
  now?: () => number;
  intervalMs?: number;
};

export type VersionWatcher = {
  check: (trigger: VersionCheckTrigger) => Promise<void>;
  /** Drop the deferred offer and any write subscription. */
  stop: () => void;
};

/**
 * The throttled comparison, free of the DOM so it can be driven
 * directly.
 *
 * The clock starts at creation: the tab has just loaded its bundle, so
 * asking immediately would only confirm what it already knows. A failed
 * request — offline, a proxy error page, a server with no build info —
 * counts as an ask and is otherwise ignored, because it is not evidence
 * of a deploy.
 *
 * An offer that arrives while writes are in flight is held, not dropped:
 * the watcher subscribes and makes it as soon as they drain.
 */
export const createVersionWatcher = (options: VersionWatcherOptions): VersionWatcher => {
  const now = options.now ?? ((): number => Date.now());
  const intervalMs = options.intervalMs ?? VERSION_CHECK_INTERVAL_MS;
  const writes = options.writes ?? noWriteActivity;
  const fetchCommit = options.fetchCommit ?? fetchServedCommit;
  let lastCheckedAt = now();
  let inFlight = false;
  let offered: string | null = null;
  let pending: string | null = null;
  let unsubscribe: (() => void) | null = null;

  const clearPending = (): void => {
    pending = null;
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const offer = (commit: string): void => {
    if (
      !shouldOfferReload({
        versionOutcome: "newer",
        writesInFlight: writes.count(),
        alreadyOffered: offered === commit,
      })
    ) {
      return;
    }
    clearPending();
    offered = commit;
    options.onOffer(commit);
  };

  const defer = (commit: string): void => {
    pending = commit;
    if (unsubscribe !== null) return;
    unsubscribe = writes.subscribe(() => {
      const held = pending;
      if (held !== null && writes.count() === 0) offer(held);
    });
  };

  return {
    check: async (trigger) => {
      if (inFlight) return;
      if (!shouldCheckVersion({ now: now(), lastCheckedAt, intervalMs, trigger })) return;
      inFlight = true;
      lastCheckedAt = now();
      try {
        const servedCommit = await fetchCommit();
        const { outcome } = evaluateVersion({ builtCommit: options.builtCommit, servedCommit });
        if (outcome !== "newer" || servedCommit === null) return;
        if (writes.count() === 0) offer(servedCommit);
        else defer(servedCommit);
      } catch {
        /* offline, or not JSON — ask again after the next interval */
      } finally {
        inFlight = false;
      }
    },
    stop: clearPending,
  };
};

/** Wire the watcher to the two triggers. Returns an unsubscribe. */
export const watchForVersionChange = (watcher: VersionWatcher): (() => void) => {
  const onFocus = (): void => {
    void watcher.check("focus");
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") void watcher.check("visibility-change");
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    watcher.stop();
  };
};

/**
 * Run the action once no write is in flight, or after the timeout
 * regardless. Takes the action as an argument and never reloads by
 * itself — the component passes the reload in, which keeps every call
 * that can navigate away from the page in one file.
 *
 * The click that asks for the reload also blurs whatever field was
 * focused, and a field that commits on blur starts exactly such a write.
 */
export const runWhenIdle = (
  writes: WriteActivity,
  act: () => void,
  timeoutMs = 10_000,
): (() => void) => {
  if (writes.count() === 0) {
    act();
    return () => undefined;
  }
  let done = false;
  const stop = (): void => {
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  const finish = (): void => {
    if (done) return;
    stop();
    act();
  };
  const unsubscribe = writes.subscribe(() => {
    if (writes.count() === 0) finish();
  });
  const timer = setTimeout(finish, timeoutMs);
  return stop;
};
`;
}

/** The blunt half: a chunk has already failed, so reload — once. */
export function chunkReloadSource(_opts: ClientSourceOptions): string {
  return `"use client";

/**
 * Deploy recovery — reloading a tab whose chunks were removed by a
 * deploy.
 *
 * Hashed chunk names change with every image, so a tab opened before a
 * deploy asks for a name the server no longer has the first time it
 * lazily loads a route. The cure is a reload, which fetches the current
 * document and the current chunk names.
 *
 * It happens automatically at most ONCE per guard window. Keep that
 * guard. When the reload does not help — the server really is broken,
 * the device is offline, a proxy is answering HTML for a script — a
 * second automatic reload starts a loop that never ends, and the person
 * cannot even read the error screen well enough to report it. After the
 * first attempt the error screen's own button, pressed deliberately, is
 * the way out.
 *
 * Generated and owned by hatchkit: regenerated on every hatchkit
 * update, so an edit here is lost. Change the app around it instead.
 */

import { claimChunkReload, isChunkLoadFailure } from "./policy";
import type { GuardStore } from "./policy";
import { sessionGuardStore } from "./host";

/**
 * Reload, unless this tab already did so for a chunk failure inside the
 * guard window. Returns whether it reloaded, so a caller can report the
 * refusal — a chunk still missing after one reload is a broken deploy,
 * not a stale tab, and that is worth knowing about.
 */
export const reloadOnceForChunkError = (
  reload: () => void = () => {
    window.location.reload();
  },
  store: GuardStore | null = sessionGuardStore(),
  now: number = Date.now(),
): boolean => {
  if (!claimChunkReload(store, { now })) return false;
  reload();
  return true;
};

/**
 * Catch the chunk failures nothing else will: a rejected dynamic import
 * and an error thrown outside the component tree. Failures the framework
 * catches reach the error boundaries in app/error.tsx and
 * app/global-error.tsx, which call reloadOnceForChunkError themselves.
 */
export const watchChunkErrors = (
  onChunkError: (error: unknown) => void = () => {
    reloadOnceForChunkError();
  },
): (() => void) => {
  const onError = (event: ErrorEvent): void => {
    const error: unknown = event.error ?? event.message;
    if (isChunkLoadFailure(error)) onChunkError(error);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (isChunkLoadFailure(event.reason)) onChunkError(event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
};
`;
}

/** The component that mounts both halves and renders the offer. */
export function componentSource(_opts: ClientSourceOptions): string {
  return `"use client";

/**
 * Keeps a long-open tab usable across a deploy: offers a reload when a
 * newer build is live, and reloads once when a removed chunk fails to
 * load. See lib/deploy-recovery/version-check.ts and
 * lib/deploy-recovery/chunk-reload.ts.
 *
 * Decides everything in an effect rather than during render, for two
 * reasons: the host is only known after mount, and the prerendered HTML
 * has to be identical whichever host ends up running it.
 *
 * Mount it inside whatever holds the app's writes and pass them in, so
 * the offer can wait for a write in flight. Without that it still works;
 * it just cannot tell a quiet tab from a busy one.
 *
 * Generated and owned by hatchkit: regenerated on every hatchkit
 * update, so an edit here is lost. Change the app around it instead.
 */

import * as React from "react";

import { currentHost } from "../lib/deploy-recovery/host";
import { watchChunkErrors } from "../lib/deploy-recovery/chunk-reload";
import { isChunkRecoveryEnabled, isRecoveryEnabled } from "../lib/deploy-recovery/policy";
import {
  createVersionWatcher,
  noWriteActivity,
  runWhenIdle,
  watchForVersionChange,
} from "../lib/deploy-recovery/version-check";
import type { WriteActivity } from "../lib/deploy-recovery/version-check";

export type DeployRecoveryProps = {
  /** The app's writes in flight. Defaults to "none, ever". */
  writes?: WriteActivity;
  /** Override the check interval. Tests and demos only. */
  intervalMs?: number;
};

export function DeployRecovery({
  writes = noWriteActivity,
  intervalMs,
}: DeployRecoveryProps): React.ReactElement | null {
  const [offered, setOffered] = React.useState(false);
  const cancelPendingReload = React.useRef<() => void>(() => undefined);

  React.useEffect(() => {
    const host = currentHost();
    const stops: Array<() => void> = [];

    if (isChunkRecoveryEnabled(host)) stops.push(watchChunkErrors());

    if (isRecoveryEnabled(host)) {
      const watcher = createVersionWatcher({
        builtCommit: host.builtCommit,
        writes,
        intervalMs,
        // A newer build only ever raises the offer. Reloading here would
        // take the page out from under whoever is using it, which is a
        // worse outcome than the stale tab this is trying to fix.
        onOffer: () => setOffered(true),
      });
      stops.push(watchForVersionChange(watcher));
    }

    return () => {
      for (const stop of stops) stop();
      cancelPendingReload.current();
    };
  }, [writes, intervalMs]);

  // The only reload in this file, and it is reachable only from the
  // button below. It still waits for writes to drain, because the click
  // that pressed it also blurred whatever field was focused.
  const handleReloadClick = React.useCallback(() => {
    cancelPendingReload.current();
    cancelPendingReload.current = runWhenIdle(writes, () => {
      window.location.reload();
    });
  }, [writes]);

  if (!offered) return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        insetInline: 0,
        bottom: 0,
        zIndex: 9999,
        display: "flex",
        gap: "0.75rem",
        alignItems: "center",
        justifyContent: "center",
        padding: "0.75rem 1rem",
        background: "#111827",
        color: "#f9fafb",
        fontSize: "0.875rem",
      }}
    >
      <span>A new version of this app is available.</span>
      <button
        type="button"
        onClick={handleReloadClick}
        style={{
          padding: "0.25rem 0.75rem",
          borderRadius: "0.375rem",
          border: "1px solid currentColor",
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
        }}
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => setOffered(false)}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
        }}
      >
        Not now
      </button>
    </div>
  );
}
`;
}

/** Route-level error boundary wiring. */
export function errorBoundarySource(_opts: ClientSourceOptions): string {
  return `"use client";

/**
 * Route error boundary, wired to deploy recovery.
 *
 * The most common way a tab that outlived a deploy fails is a route
 * chunk that no longer exists, and that failure lands here. One
 * automatic reload fixes it; the guard in lib/deploy-recovery refuses
 * the next one inside the window, so a server that is actually broken
 * leaves this screen on the page instead of looping.
 *
 * Generated by hatchkit ONCE, and never overwritten after that: this
 * file is the project's, not hatchkit's. Extend the markup freely —
 * but keep the effect, which is the only part of it the recovery
 * needs.
 */

import * as React from "react";

import { reloadOnceForChunkError } from "../lib/deploy-recovery/chunk-reload";
import { isChunkLoadFailure } from "../lib/deploy-recovery/policy";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    if (isChunkLoadFailure(error)) reloadOnceForChunkError();
  }, [error]);

  return (
    <div style={{ padding: "2rem" }}>
      <h2>Something went wrong</h2>
      <p>This page could not be loaded. Reloading usually fixes it.</p>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
      <button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload the page
      </button>
    </div>
  );
}
`;
}

/** Root error boundary wiring — the one that catches a failure in the
 *  root layout itself, where the route boundary never renders. */
export function globalErrorBoundarySource(_opts: ClientSourceOptions): string {
  return `"use client";

/**
 * Root error boundary, wired to deploy recovery.
 *
 * This one replaces the whole document, so it renders its own html and
 * body. It catches what app/error.tsx cannot: a failure in the root
 * layout, which after a deploy is usually a shared chunk that no longer
 * exists. Same single guarded reload — see lib/deploy-recovery.
 *
 * Generated by hatchkit ONCE, and never overwritten after that: this
 * file is the project's, not hatchkit's. Extend the markup freely —
 * but keep the effect, which is the only part of it the recovery
 * needs.
 */

import * as React from "react";

import { reloadOnceForChunkError } from "../lib/deploy-recovery/chunk-reload";
import { isChunkLoadFailure } from "../lib/deploy-recovery/policy";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}): React.ReactElement {
  React.useEffect(() => {
    if (isChunkLoadFailure(error)) reloadOnceForChunkError();
  }, [error]);

  return (
    <html lang="en">
      <body style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h2>Something went wrong</h2>
        <p>This page could not be loaded. Reloading usually fixes it.</p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload the page
        </button>
      </body>
    </html>
  );
}
`;
}

/** Where a locally built bundle writes its build-info file. */
export interface BuildInfoWriterOptions {
  /** Default output path, relative to the repository root. Must be the
   *  same file the image build stamps, or a local build and a deployed
   *  one would disagree about where the answer lives. */
  defaultTarget: string;
}

/**
 * The local build-info writer.
 *
 * The image build already stamps this file (see
 * scaffold/deploy-verification.ts), so CI needs nothing from here. A
 * local `next build` does not, and a developer checking that the offer
 * appears at all would otherwise be debugging a 404. It writes the same
 * two facts under the same names — a different shape here would make the
 * local answer unreadable to the deployed check.
 *
 * With no COMMIT_SHA it falls back to the working tree's own HEAD, which
 * is the honest answer for a local build, and to an empty string outside
 * a repository — and an empty commit disables the check, which is
 * exactly what a build nobody deployed should do.
 */
export function buildInfoWriterSource(opts: BuildInfoWriterOptions): string {
  return `#!/usr/bin/env node
// Writes the build-info file that an open tab compares itself against:
// which commit this bundle was built from, and which API origin was
// baked into it. The image build stamps the same file from COMMIT_SHA
// (see the client Dockerfile); this covers a local build, where there is
// no build arg and the file would otherwise 404.
//
// Usage: node scripts/write-version-json.mjs [out-file]
// Reads COMMIT_SHA and NEXT_PUBLIC_API_URL from the environment, and
// falls back to the working tree's HEAD when COMMIT_SHA is unset.
//
// Generated and owned by hatchkit: regenerated on every hatchkit
// update, so an edit here is lost.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_TARGET = ${JSON.stringify(opts.defaultTarget)};

const headCommit = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // Not a repository, or no git — an empty commit is the honest
    // answer, and it disables the version check rather than faking one.
    return "";
  }
};

const target = resolve(process.cwd(), process.argv[2] ?? DEFAULT_TARGET);
const body = {
  commit: (process.env.COMMIT_SHA ?? "").trim() || headCommit(),
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "",
};

mkdirSync(dirname(target), { recursive: true });
// JSON.stringify rather than a printf, so no value can break the quoting.
writeFileSync(target, JSON.stringify(body) + "\\n");
console.log("wrote " + target);
`;
}
