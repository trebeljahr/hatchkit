// The version handshake, server side: what a request declares about the client
// that sent it, and the floor below which it is refused.
//
// A declared version is SELF-REPORTED. It labels a request and decides the
// floor refusal — a refusal the caller can always avoid by lying, which is
// fine: the floor protects honest old clients from a server they would
// misread, not the server from anyone. Nothing here is a permission, and
// nothing here may ever become one; the moment a declared level decides what a
// request is allowed to do, every client can grant itself that by editing a
// header.
import {
  API_LEVEL_HEADER,
  CLIENT_ID_HEADER,
  CLIENT_TOO_OLD,
  CLIENT_VERSION_HEADER,
  MIN_CLIENT_API_LEVEL,
  parseApiLevel,
  parseClientVersion,
  type VersionRefusal,
} from "@starter/shared";

export type DeclaredClient = {
  clientVersion: string | null;
  apiLevel: number | null;
};

/** Something headers can be read from: a Fetch `Headers` or Node's plain object. */
export type HeaderSource =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | null
  | undefined;

const readHeader = (headers: HeaderSource, name: string): string | undefined => {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const value = (headers as Readonly<Record<string, string | readonly string[] | undefined>>)[name];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
};

/** The version and API level a request declared, each null when absent. */
export function declaredClient(headers: HeaderSource): DeclaredClient {
  try {
    return {
      clientVersion: parseClientVersion(readHeader(headers, CLIENT_VERSION_HEADER)),
      apiLevel: parseApiLevel(readHeader(headers, API_LEVEL_HEADER)),
    };
  } catch {
    // A header source that throws on a read — a proxy's exotic object, a
    // Headers subclass mid-construction — is a client that declared nothing,
    // never a client that is refused. See `versionRefusalFor`.
    return { clientVersion: null, apiLevel: null };
  }
}

/**
 * `CLIENT_TOO_OLD` when the request declared an API level below
 * `MIN_CLIENT_API_LEVEL`, otherwise null.
 *
 * A request that declares NO level is a client from before the handshake and
 * is always served: the floor exists to refuse clients that can say how old
 * they are, never to lock out ones that cannot. The same goes for a level
 * nobody can parse — a proxy that mangles headers must not be able to get a
 * working client refused, so an unreadable value is a missing one.
 */
export function versionRefusalFor(
  headers: HeaderSource,
  floor: number = MIN_CLIENT_API_LEVEL,
): VersionRefusal | null {
  const { apiLevel } = declaredClient(headers);
  if (apiLevel === null) return null;
  return apiLevel < floor ? CLIENT_TOO_OLD : null;
}

/** What a refused client is told. The same words on tRPC and on any REST route. */
export const CLIENT_TOO_OLD_MESSAGE =
  "This version of the app is too old for this server. Update the app to keep syncing; nothing stored on this device has been deleted.";

/** Longest client label worth keeping. Anything longer is noise, not a name. */
const MAX_CLIENT_LABEL_LENGTH = 32;

/**
 * What a label may contain. Deliberately narrow — words, digits, dots and
 * dashes — so a label can be written into a log line or a template without a
 * second thought about what a header smuggled into it.
 */
const CLIENT_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * The client label a request carried (`x-starter-client`), or null.
 *
 * A LABEL and never a permission. It exists so a device list can say "the web
 * app" or "a launcher extension" instead of a user-agent string, and it is
 * self-reported exactly like the version headers — any client can claim to be
 * any other, so no query, no scope and no rate limit may ever be decided by
 * it. The handshake does not touch this header: the floor reads
 * `x-starter-api-level` only, and a request with a label and no level is a
 * pre-handshake client that is served as before.
 *
 * Trimmed and length-capped because it is stored and rendered: a header is
 * attacker-controlled free text, and an unbounded one is a row in somebody's
 * settings screen that is a megabyte wide.
 */
export function parseDeclaredClientLabel(headers: HeaderSource): string | null {
  const raw = readHeader(headers, CLIENT_ID_HEADER);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CLIENT_LABEL_LENGTH) return null;
  return CLIENT_LABEL_PATTERN.test(trimmed) ? trimmed : null;
}
