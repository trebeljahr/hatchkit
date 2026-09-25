/**
 * Client/server compatibility: the API level and the version handshake.
 *
 * Three clocks run at once in a project that ships more than one surface. A
 * self-hosted server can lag months behind; store clients (a browser
 * extension, a launcher extension, the phone builds) update themselves and are
 * often NEWER than the server they talk to; a desktop build or a tab left open
 * is often OLDER. A release number cannot say whether two of them understand
 * each other, because a server and a client of the same release were never
 * guaranteed to be deployed together.
 *
 * So each side declares an integer **API level** — the set of tRPC procedures,
 * input fields, enum values and sync event kinds it knows — and each side names
 * the lowest level of the other it still works with.
 */

/**
 * The API level this build speaks.
 *
 * Bump it (and add a row to {@link API_LEVEL_CHANGES}) whenever a tRPC
 * procedure, an input field, an enum value or a sync event kind is ADDED.
 * Never lower it. A server reports it on `/api/health` and `health.check`; a
 * client sends it on every request as {@link API_LEVEL_HEADER}.
 */
export const API_LEVEL = 2;

export type ApiLevelChange = {
  level: number;
  /** The release the level first shipped in. */
  release: string;
  /** What a peer at this level can rely on that one below cannot. */
  added: readonly string[];
};

/**
 * What each level added, oldest first. The last row's `level` is
 * {@link API_LEVEL}, which `api-level.test.ts` in the server tests checks.
 *
 * Level 0 is not a row: it is every server and client released before the
 * handshake existed, which sends no level at all and reports none.
 */
export const API_LEVEL_CHANGES: readonly ApiLevelChange[] = [
  {
    level: 1,
    release: "0.1.0",
    added: [
      "The version handshake: `x-starter-client-version` and `x-starter-api-level` request headers.",
      "`apiLevel` and `minClientApiLevel` on `/api/health` and `health.check`.",
      "The `CLIENT_TOO_OLD` refusal (`data.versionRefusal` on tRPC).",
      "The sync feed at `/api/sync`: a one-way server-to-client stream of `items.changed` and `profile.changed`.",
    ],
  },
  {
    level: 2,
    release: "0.1.0",
    added: [
      "`items.update`: edit a record's title, description and status.",
    ],
  },
];

/**
 * The lowest client API level this server still serves.
 *
 * A request that DECLARES a lower level is refused with {@link CLIENT_TOO_OLD}.
 * A request that declares nothing is a client from before the handshake and is
 * served as before — raising this floor never locks those out silently; that
 * would need a separate decision.
 */
export const MIN_CLIENT_API_LEVEL = 1;

/** The app release of the client making the request, e.g. `0.3.1`. */
export const CLIENT_VERSION_HEADER = "x-starter-client-version";

/** The {@link API_LEVEL} the client making the request was built with. */
export const API_LEVEL_HEADER = "x-starter-api-level";

/**
 * Names the client in a device list. Cosmetic, never a permission, and
 * deliberately NOT touched by the handshake: the two version headers are read
 * by the floor, this one drives labels and session windows.
 */
export const CLIENT_ID_HEADER = "x-starter-client";

/** The server refused a client whose declared API level is below its floor. */
export const CLIENT_TOO_OLD = "CLIENT_TOO_OLD";

/** The client refuses a server whose API level is below its own floor. */
export const SERVER_TOO_OLD = "SERVER_TOO_OLD";

export type VersionRefusal = typeof CLIENT_TOO_OLD | typeof SERVER_TOO_OLD;

/**
 * The HTTP status a version refusal is served with.
 *
 * 412, deliberately. The offline queue drops a row on a permanent rejection
 * status (400/403/404/409/410/422), and version skew must never delete work a
 * person did with no signal. A 412 keeps the row for the build that can send
 * it. See `isPermanentRejectionStatus` in `@starter/core`.
 */
export const VERSION_REFUSAL_HTTP_STATUS = 412;

/**
 * Something a client may only rely on from a server at or above a given level.
 *
 * One entry per gate, so a feature check is a name rather than a number
 * sprinkled through call sites. Add a member here in the same change that
 * bumps {@link API_LEVEL}.
 */
export type Capability = "sync.feed" | "items.update";

const CAPABILITY_LEVEL: Readonly<Record<Capability, number>> = {
  "sync.feed": 1,
  "items.update": 2,
};

/**
 * Whether a server at `apiLevel` has `capability`.
 *
 * `null` — a server never asked — is optimistic: the request is made and the
 * server's own answer decides. Treating unknown as "no" would hide a working
 * feature behind a health read that has not landed yet. Level 0 is a real
 * answer from a server released before the handshake, and it has nothing.
 */
export const serverSupports = (
  capability: Capability,
  apiLevel: number | null,
): boolean => (apiLevel === null ? true : apiLevel >= CAPABILITY_LEVEL[capability]);

/** Longest client version string a server stores. Anything longer is noise. */
const MAX_VERSION_LENGTH = 64;

const VERSION_PATTERN =
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A client version as a server may record it, or null.
 *
 * Self-reported and therefore cosmetic: it names a row in a device list and is
 * never a permission.
 */
export const parseClientVersion = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) return null;
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
};

/**
 * A declared API level, or null when the request declared none.
 *
 * Null covers a malformed value too. A header nobody can read is treated like
 * a missing one — a legacy client — rather than as level 0, so a proxy that
 * mangles headers cannot get a working client refused.
 */
export const parseApiLevel = (value: unknown): number | null => {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
};

/**
 * Compare two release strings numerically, major.minor.patch.
 *
 * A prerelease sorts before its release (`1.2.0-rc.1` < `1.2.0`); two
 * prereleases of one release compare as equal, which is all the callers need.
 * Unparseable input compares as equal to anything, so it never wins.
 */
export const compareVersions = (a: string, b: string): number => {
  const parse = (value: string): { core: number[]; pre: boolean } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]*)?/.exec(value.trim());
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] !== undefined,
    };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
};

/**
 * The two handshake headers, for a client to spread into every API request.
 *
 * Never send these to `/api/health` on a server that has not said it trusts
 * the caller's origin: a custom header makes a browser preflight the request,
 * and an untrusted origin's preflight fails — turning "reachable, but not
 * trusting you" into "unreachable".
 */
export const versionHeaders = (
  clientVersion: string | null | undefined,
): Record<string, string> => {
  const headers: Record<string, string> = { [API_LEVEL_HEADER]: String(API_LEVEL) };
  const version = parseClientVersion(clientVersion);
  if (version !== null) headers[CLIENT_VERSION_HEADER] = version;
  return headers;
};
