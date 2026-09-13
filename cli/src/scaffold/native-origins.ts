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
export const NATIVE_CLIENT_FEATURES = ["mobile", "desktop", "desktop-tauri"] as const;

/** The origins each native feature needs trusted, in the order they are
 *  appended. */
const ORIGINS_BY_FEATURE: Record<(typeof NATIVE_CLIENT_FEATURES)[number], readonly string[]> = {
  // Capacitor: iOS serves the bundle from capacitor://localhost. Android
  // serves it from https://localhost — `androidScheme` defaults to
  // https, and an `http://localhost` entry would never match.
  mobile: ["capacitor://localhost", "https://localhost"],
  // Electron: the custom `app` protocol registered in electron/main.ts.
  // file:// sends `Origin: null`, which must never be trusted.
  desktop: ["app://-"],
  // Tauri serves the bundled frontend from tauri://localhost on
  // macOS/Linux and http://tauri.localhost on Windows.
  "desktop-tauri": ["tauri://localhost", "http://tauri.localhost"],
};

/** Origins the project's native shells need in TRUSTED_ORIGINS, deduped,
 *  in a stable order (mobile, desktop, desktop-tauri). Empty when the
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
