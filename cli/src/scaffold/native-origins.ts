/*
 * Native-client origins — the ONE place that knows which document
 * origins a native shell loads the client from.
 *
 * better-auth rejects a request whose `Origin` is not in its trusted
 * list with `403 INVALID_ORIGIN`, before it ever looks at the password.
 * Real browsers and WebViews send `Sec-Fetch-*` headers, which make
 * better-auth validate `Origin` even on a cookieless request; curl sends
 * none, so a curl test passes against a server a phone cannot sign in
 * to. The starter's server trusts FRONTEND_URL plus the TRUSTED_ORIGINS
 * CSV (starter/packages/server/src/config/env.ts `getTrustedOrigins`).
 *
 * Two call sites consume this list and must never disagree:
 *   · scaffold/starter-files.ts `updateEnvExample` — writes it into the
 *     server's .env.example.
 *   · deploy/trusted-origins.ts — merges it into TRUSTED_ORIGINS on the
 *     server's Coolify application, which is where production actually
 *     reads it for projects whose runtime env lives in Coolify.
 *
 * Values are matched VERBATIM by better-auth in production. A trailing
 * slash or a wrong scheme is a silent 403, so every entry here is a bare
 * `scheme://host` with nothing after it.
 *
 * Pure: no I/O, no chalk, no network — safe to import from anywhere.
 */

/** Features that ship a native shell loading the client from its own
 *  document origin. */
export const NATIVE_CLIENT_FEATURES = ["mobile", "desktop"] as const;

/** The origins each native feature needs trusted, in the order they are
 *  appended. */
const ORIGINS_BY_FEATURE: Record<(typeof NATIVE_CLIENT_FEATURES)[number], readonly string[]> = {
  // Capacitor: iOS serves the bundle from capacitor://localhost. Android
  // serves it from https://localhost — `androidScheme` defaults to
  // https, and an `http://localhost` entry would never match.
  //
  // THE SCHEME IS THE ORIGIN. Never set a custom `iosScheme` /
  // `androidScheme` in capacitor.config.ts: the document origin keys the
  // platform preference store, the WebView's own storage and this trust
  // list, so changing it later orphans every stored preference and
  // invalidates the trust list at once, in one step, with no migration
  // path for either.
  mobile: ["capacitor://localhost", "https://localhost"],
  // Electron: the privileged `app` scheme registered in
  // electron/src/protocol.ts, whose host is `-`. file:// sends
  // `Origin: null`, which must never be trusted — and which no trust list
  // can match anyway, so a file:// shell cannot be fixed from this side.
  desktop: ["app://-"],
};

/** Origins the project's native shells need in TRUSTED_ORIGINS, deduped,
 *  in a stable order (mobile, desktop). Empty when the
 *  project has no native client. */
export function nativeClientOrigins(features: readonly string[]): string[] {
  const out: string[] = [];
  for (const feature of NATIVE_CLIENT_FEATURES) {
    if (!features.includes(feature)) continue;
    for (const origin of ORIGINS_BY_FEATURE[feature]) {
      if (!out.includes(origin)) out.push(origin);
    }
  }
  return out;
}

/** The Android emulator's NAT alias for the host loopback. The emulator
 *  cannot reach the host as `localhost` — that is the emulated device. */
export const ANDROID_EMULATOR_HOST = "10.0.2.2";

/** Origins a Capacitor LIVE-RELOAD session signs in from.
 *
 *  Under `pnpm dev:ios` / `pnpm dev:android` the WebView loads the Next
 *  dev server instead of the bundle, so the document origin is the DEV
 *  SERVER'S — not `capacitor://localhost` and not `https://localhost`.
 *  The API has to trust *that*, which is why these are separate from
 *  `nativeClientOrigins` and belong only in a dev trust list.
 *
 *  The consequence is worth stating plainly, because it is the one that
 *  costs real time: LIVE RELOAD NEVER EXERCISES THE REAL ORIGIN. Neither
 *  the bundle's origin nor its place in the production trust list is
 *  touched by a live-reload run, so an auth change that works under
 *  `dev:ios` can still fail on the first install. Verify against a real
 *  `pnpm build:mobile` bundle.
 *
 *  Only the emulator alias and loopback are returned. A physical device
 *  on the LAN, or a non-default port, needs its own entry — pass `lanIp`,
 *  or set TRUSTED_ORIGINS explicitly. */
export function mobileLiveReloadOrigins(opts: {
  port: number;
  lanIp?: string;
}): string[] {
  const out = [
    // iOS Simulator shares the Mac's network namespace.
    `http://localhost:${opts.port}`,
    // Android emulator.
    `http://${ANDROID_EMULATOR_HOST}:${opts.port}`,
  ];
  if (opts.lanIp) out.push(`http://${opts.lanIp}:${opts.port}`);
  return out;
}

/** True when the project ships at least one native shell. */
export function hasNativeClient(features: readonly string[]): boolean {
  return NATIVE_CLIENT_FEATURES.some((f) => features.includes(f));
}

/** Split a TRUSTED_ORIGINS value the way the server does: comma-separated,
 *  each entry trimmed, empties dropped. A value wrapped whole in matching
 *  quotes (a dashboard paste) is unwrapped first. Order and duplicates are
 *  preserved — this is a reading, not a normalisation. */
export function parseOriginList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  let value = raw.trim();
  if (value.length >= 2 && /^(["']).*\1$/s.test(value)) value = value.slice(1, -1);
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface TrustedOriginsMerge {
  /** The live list as read, before anything is added. */
  before: string[];
  /** The list to write: `before` de-duplicated in its own order, with
   *  every missing wanted origin appended. */
  after: string[];
  /** Origins appended by this merge. Empty means nothing to write. */
  added: string[];
  /** `after` in the CSV form the server parses. */
  value: string;
  /** True only when an origin was missing. De-duplicating an existing
   *  list is not, on its own, a reason to write to production. */
  changed: boolean;
}

/** Union a live TRUSTED_ORIGINS value with the origins hatchkit wants.
 *
 *  Merge, never overwrite. A live list routinely carries hand-added
 *  entries — a pinned production `chrome-extension://<id>`, say — that a
 *  script has no business touching. So: keep every existing entry in its
 *  existing order, append only what is missing, remove nothing. */
export function mergeTrustedOrigins(
  existing: string | undefined | null,
  wanted: readonly string[],
): TrustedOriginsMerge {
  const before = parseOriginList(existing);
  const after: string[] = [];
  for (const origin of before) if (!after.includes(origin)) after.push(origin);
  const added: string[] = [];
  for (const origin of wanted) {
    if (after.includes(origin)) continue;
    after.push(origin);
    added.push(origin);
  }
  return { before, after, added, value: after.join(","), changed: added.length > 0 };
}

/** Entries better-auth can never match: anything carrying a path, a
 *  trailing slash, or no scheme. Reported, never removed — deleting a
 *  hand-added origin is not ours to do, even a broken one. */
export function malformedOrigins(origins: readonly string[]): string[] {
  return origins.filter((o) => o !== "null" && !/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/i.test(o));
}
