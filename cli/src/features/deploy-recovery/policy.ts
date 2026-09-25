/*
 * cli/src/features/deploy-recovery/policy.ts — the rules a browser tab
 * follows when it has outlived the deploy that built it.
 *
 * ---------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------
 *
 * Every deploy replaces the client image, and every hashed chunk name in
 * it changes. A tab that was open before the deploy keeps working — its
 * document and its already-loaded chunks are in memory — right up to the
 * moment it lazily loads a route it has not visited yet. That request
 * asks for a file name the new image does not have, and the person sees
 * a blank screen or an error boundary for a deploy they never noticed.
 *
 * There are two answers, and this module holds the decisions behind
 * both so a test can drive them without a browser:
 *
 *   1. The polite one. The build-info file (`version.json`, written by
 *      scaffold/deploy-verification.ts and served with no caching) says
 *      which commit is live. When it differs from the commit baked into
 *      the running bundle, the tab OFFERS a reload. It never takes one:
 *      someone is in the middle of something, and a page that reloads
 *      itself under a half-typed form is worse than a stale tab.
 *   2. The blunt one. When a chunk has already failed, a reload is the
 *      only cure, so the tab takes one — but at most ONCE per guard
 *      window, recorded in session storage. Without that guard a server
 *      that is broken rather than merely updated becomes a reload loop,
 *      and the person cannot even read the error well enough to report
 *      it.
 *
 * Both are web-only. A native shell (Capacitor, Electron, Tauri) loads
 * its bundle from inside its own package: there is no deploy for it to
 * notice, the build-info file it would fetch belongs to a different
 * artefact, and a reload there means something else entirely.
 *
 * Pure: no DOM, no timers, no I/O. The generated client mirrors these
 * rules in its own `policy.ts` (see client-sources.ts); this copy is the
 * one the test suite drives.
 */

/** How the bundle was built. Anything that is not a production build is
 *  a dev server or a test run: no image, no deploy, and no build-info
 *  file to compare against. */
export type RuntimeMode = "development" | "production" | "test";

/** Which host the bundle is running in. `web` is a real browser tab
 *  served over HTTP — the only one a deploy can affect. */
export type ClientShell = "web" | "capacitor" | "electron" | "tauri";

/** The shells that carry their own copy of the bundle.
 *
 *  Mirrors scaffold/native-origins.ts `NATIVE_CLIENT_FEATURES`, which
 *  names the same three surfaces by their manifest feature name. Kept as
 *  runtime names here because the client asks "what am I running in?",
 *  not "what did the manifest enable?" — a project can ship a mobile
 *  shell and still be served to an ordinary browser tab. */
export const NATIVE_SHELLS = ["capacitor", "electron", "tauri"] as const;

/** Manifest feature name → the shell its bundle runs in. Lets the CLI
 *  say, from the manifest alone, which shells a project builds.
 *
 *  Tauri is absent on purpose: hatchkit scaffolds no Tauri shell any
 *  more, so no manifest can name one. It stays in {@link NATIVE_SHELLS}
 *  because that list answers a different question — what the bundle is
 *  RUNNING in — and a client someone wrapped in Tauri themselves must
 *  still skip a check that belongs to the web image. */
export const SHELL_BY_FEATURE: Readonly<Record<string, ClientShell>> = {
  mobile: "capacitor",
  desktop: "electron",
};

/** Shells the project builds, in manifest-feature order. Used for the
 *  generated comment that explains which hosts skip the check. */
export function nativeShellsOf(features: readonly string[]): ClientShell[] {
  const out: ClientShell[] = [];
  for (const feature of Object.keys(SHELL_BY_FEATURE)) {
    if (!features.includes(feature)) continue;
    const shell = SHELL_BY_FEATURE[feature];
    if (shell && !out.includes(shell)) out.push(shell);
  }
  return out;
}

/** True for a host that carries its own bundle. Unknown values count as
 *  `web`: a shell hatchkit has never heard of is far more likely to be a
 *  typo in a detection helper than a new native package, and the cost of
 *  guessing wrong that way is one spurious offer rather than a whole
 *  surface with no recovery at all. */
export function isNativeShell(shell: string): boolean {
  return (NATIVE_SHELLS as readonly string[]).includes(shell);
}

/** Everything the decision to run at all depends on. */
export interface RecoveryHost {
  /** `process.env.NODE_ENV` of the running bundle. */
  mode: RuntimeMode | string;
  /** The host the bundle detected at runtime. */
  shell: ClientShell | string;
  /** The commit the running bundle was built from, inlined at build
   *  time. Empty for any build that was not stamped. */
  builtCommit: string;
}

/** How often, at most, a tab asks which build is live. Five minutes is
 *  long enough that a tab left open all day costs nothing and short
 *  enough that someone coming back after lunch is told. */
export const DEFAULT_VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** An automatic chunk reload within this long of the previous one is
 *  refused. One minute is comfortably longer than a deploy's rollout
 *  and comfortably shorter than a person's patience. */
export const DEFAULT_CHUNK_RELOAD_GUARD_MS = 60 * 1000;

/** Session-storage key holding the timestamp of this tab's last
 *  automatic chunk reload. Session storage on purpose: the guard is
 *  about THIS tab's last attempt, and it must not outlive the tab. */
export const CHUNK_RELOAD_STORAGE_KEY = "hatchkit:deploy-recovery:chunk-reload-at";

/**
 * Whether the version check may run at all.
 *
 * Three ways it is off, and each one is a real configuration rather than
 * a defensive nicety:
 *   · development — the dev server rebuilds in place, there is no image
 *     and no build-info file, so the fetch would 404 on every focus.
 *   · a native shell — see the module header.
 *   · no built commit — a local `docker build` with no `COMMIT_SHA`, or
 *     a shell build that never receives one. With nothing to compare
 *     against, every answer would be "different", and the tab would
 *     offer a reload that changes nothing.
 */
export function isRecoveryEnabled(host: RecoveryHost): boolean {
  if (host.mode !== "production") return false;
  if (isNativeShell(host.shell)) return false;
  return host.builtCommit.trim() !== "";
}

/**
 * Whether the chunk-failure reload may run at all.
 *
 * Same host rules, minus the commit: a chunk that failed to load is
 * evidence in itself, so this half works on a build that was never
 * stamped. Split from {@link isRecoveryEnabled} because an unstamped
 * production image should still recover a tab whose chunks vanished —
 * it just cannot be told about the deploy in advance.
 */
export function isChunkRecoveryEnabled(host: Pick<RecoveryHost, "mode" | "shell">): boolean {
  return host.mode === "production" && !isNativeShell(host.shell);
}

/** What made the tab consider asking. Both are moments the person is
 *  about to use a tab that may be stale, and both cost nothing while it
 *  sits in the background. */
export type VersionCheckTrigger = "focus" | "visibility-change";

export interface VersionCheckRequest {
  now: number;
  /** When the tab last asked. The clock starts at mount, not at zero:
   *  the tab has just loaded its bundle, so asking immediately would
   *  only confirm what it already knows. */
  lastCheckedAt: number;
  intervalMs: number;
  trigger: VersionCheckTrigger;
}

/**
 * Whether this trigger may turn into a request.
 *
 * Only the two named triggers are honoured. A `visibilitychange` that
 * fires because the page became HIDDEN must not reach this function at
 * all, and an unrecognised trigger is refused rather than guessed at: a
 * request on every DOM event of some kind would turn the interval gate
 * into decoration.
 *
 * A clock that has moved BACKWARDS (a laptop waking, a corrected system
 * time) counts as due. Refusing would wedge the check until real time
 * caught up with the stale reading, which can be hours.
 */
export function shouldCheckVersion(req: VersionCheckRequest): boolean {
  if (req.trigger !== "focus" && req.trigger !== "visibility-change") return false;
  const elapsed = req.now - req.lastCheckedAt;
  if (elapsed < 0) return true;
  return elapsed >= req.intervalMs;
}

/** What the served build says about the running one.
 *
 *  `unknown` is not a soft `same`: it is "the question could not be
 *  answered", which happens offline, behind a captive portal, against a
 *  proxy error page, and on an image that was never stamped. None of
 *  those is evidence of a deploy, so none of them may produce an offer. */
export type VersionOutcome = "same" | "newer" | "unknown";

export interface VersionComparison {
  builtCommit: string;
  /** The commit read from the served build-info file, or null/undefined
   *  when it could not be read. */
  servedCommit: string | null | undefined;
}

/** Commits shorter than this are not compared by prefix — seven is git's
 *  own floor for an abbreviated sha, and anything shorter collides. */
const MIN_ABBREVIATED_SHA = 7;

/**
 * Compare the running bundle's commit with the served one.
 *
 * `newer` is a claim about DIFFERENCE, not about order: two commit shas
 * cannot be ordered without the repository. In the only situation that
 * produces a difference — the image behind this origin was replaced —
 * different means newer, and the offer says so.
 *
 * Prefix matching in both directions, because the two facts travel by
 * different routes: the bundle's commit is inlined from a build arg and
 * the served one is printed into a file by a shell script, and one of
 * them being abbreviated is a configuration difference, not a deploy.
 * Treating `a1b2c3d` and `a1b2c3d9f…` as different would offer a reload
 * on every single check, forever.
 */
export function evaluateVersion(input: VersionComparison): { outcome: VersionOutcome } {
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
}

export interface ReloadOfferInput {
  versionOutcome: VersionOutcome;
  /** How many writes the app has in flight right now. */
  writesInFlight: number;
  /** Whether this tab has already put the offer on screen for this
   *  version. */
  alreadyOffered: boolean;
}

/**
 * Whether to put the reload offer on screen.
 *
 * Deferred while writes are in flight, and re-evaluated once they drain.
 * A reload during a write aborts the request, and an offline queue
 * cannot reliably catch a write that fails while the document unloads —
 * the browser is already tearing the page down by then. Waiting for the
 * answer costs a few seconds and removes the whole class of "I pressed
 * reload and my last edit vanished".
 *
 * Never automatic: the caller shows an offer, and the person decides.
 */
export function shouldOfferReload(input: ReloadOfferInput): boolean {
  if (input.versionOutcome !== "newer") return false;
  if (input.alreadyOffered) return false;
  return input.writesInFlight === 0;
}

export interface ChunkReloadInput {
  now: number;
  /** When this tab last reloaded itself for a chunk failure, or null
   *  when it never has. */
  lastReloadAt: number | null;
  guardMs: number;
}

/**
 * Whether an automatic reload is allowed for a chunk that failed to
 * load.
 *
 * The guard is the whole point. A reload cures a stale tab; it cures
 * nothing when the chunk is missing because the server is broken, the
 * device is offline, or a proxy is answering HTML for a script. In those
 * cases a second automatic reload starts a loop that never ends, and the
 * error screen — with its own reload button, which the person presses
 * deliberately — is the right place to stop.
 *
 * An unreadable or nonsensical stored value counts as "never reloaded":
 * refusing on garbage would leave a genuinely stale tab with no way out
 * but a manual reload it does not know it needs.
 */
export function shouldChunkReload(input: ChunkReloadInput): boolean {
  const last = input.lastReloadAt;
  if (last === null || !Number.isFinite(last) || last <= 0) return true;
  const elapsed = input.now - last;
  if (elapsed < 0) return true;
  return elapsed >= input.guardMs;
}

/** The value to persist after taking a chunk reload. A string, because
 *  every storage this is modelled on stores strings. */
export function recordChunkReload(now: number): string {
  return String(now);
}

/** Parse a stored guard timestamp back. Anything that is not a positive
 *  finite number is null — see {@link shouldChunkReload}. */
export function readChunkReloadAt(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The two storage operations the guard needs. Modelled as a plain pair
 *  so the decision can be tested without a browser, and so a caller can
 *  pass anything with the same shape (`window.sessionStorage`, a memory
 *  map in a test, nothing at all). */
export interface GuardStore {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
}

export interface ChunkReloadClaim {
  now: number;
  guardMs?: number;
  key?: string;
}

/**
 * Read the guard, decide, and write it back — returning whether the
 * caller may reload now.
 *
 * With no working storage the answer is always no. Private-mode and
 * blocked-storage browsers throw on both operations, and without a
 * record there is no way to tell a first attempt from the tenth; a
 * reload loop in a browser that cannot remember it is looping is the
 * worst version of this bug, so the tab stays put and leaves it to the
 * error screen.
 */
export function claimChunkReload(store: GuardStore | null, input: ChunkReloadClaim): boolean {
  if (store === null) return false;
  const key = input.key ?? CHUNK_RELOAD_STORAGE_KEY;
  const guardMs = input.guardMs ?? DEFAULT_CHUNK_RELOAD_GUARD_MS;
  try {
    const lastReloadAt = readChunkReloadAt(store.get(key));
    if (!shouldChunkReload({ now: input.now, lastReloadAt, guardMs })) return false;
    store.set(key, recordChunkReload(input.now));
    return true;
  } catch {
    return false;
  }
}

/** Message shapes a failed chunk or dynamic import actually produces.
 *
 *  Collected from more than one bundler on purpose: matching webpack's
 *  string alone is how this check silently stops working the day a
 *  project moves to Vite, and the symptom — a permanently blank route
 *  after a deploy — looks nothing like a bundler change.
 *
 *    · webpack / Next.js : "Loading chunk 42 failed", "Loading CSS chunk"
 *    · Vite / Rollup     : "Failed to fetch dynamically imported module",
 *                          "Unable to preload CSS for"
 *    · Firefox           : "error loading dynamically imported module"
 *    · Safari            : "Importing a module script failed"
 *    · any bundler, when a 404 is answered with the index document:
 *                          "Failed to load module script" (the MIME type
 *                          check rejects the HTML) */
/** Message shapes that mean a chunk or dynamic import failed, across
 *  bundlers and browsers. Exported for the same reason as
 *  {@link CHUNK_ERROR_NAMES}: the generated client code is rendered
 *  from it, so there is one list, not two. */
export const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
  /Loading (CSS )?chunk [\w/.-]+ failed/i,
  /Failed to load chunk/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Failed to load module script/i,
  /Unable to preload CSS for/i,
];

/** Error names bundlers give the failure outright. */
/** Error `name` values that mean a chunk failed, whatever the message
 *  says. Exported because the generated client code is rendered FROM
 *  this list rather than carrying its own copy — see client-sources.ts.
 *  Two hand-kept copies of a bundler-detection list is how this check
 *  silently stops working the day a project changes bundler. */
export const CHUNK_ERROR_NAMES: readonly string[] = ["ChunkLoadError"];

/**
 * Whether a thrown value is a chunk or dynamic-import load failure.
 *
 * Takes `unknown` because every source of one hands over something
 * different: an `ErrorEvent` carries an `Error` or a bare string, an
 * unhandled rejection carries whatever was rejected, and a framework
 * error boundary carries a re-thrown error whose `cause` holds the real
 * one. One level of `cause` is unwrapped for that last case; deeper
 * nesting is not, because a chunk failure buried two causes down is
 * someone's own wrapper and their error screen should own it.
 */
export function isChunkLoadFailure(error: unknown, depth = 1): boolean {
  if (typeof error === "string") return CHUNK_ERROR_PATTERNS.some((re) => re.test(error));
  if (typeof error !== "object" || error === null) return false;
  const { name, message, cause } = error as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (typeof name === "string" && CHUNK_ERROR_NAMES.includes(name)) return true;
  if (typeof message === "string" && CHUNK_ERROR_PATTERNS.some((re) => re.test(message))) {
    return true;
  }
  if (depth > 0 && cause !== undefined && cause !== null) {
    return isChunkLoadFailure(cause, depth - 1);
  }
  return false;
}
