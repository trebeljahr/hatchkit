/**
 * The worker's state: which server, which session, and what that server
 * last said about this extension's origin.
 *
 * An MV3 service worker is stopped and restarted constantly, so nothing
 * here is "the state" in the sense a long-lived process would mean.
 * Everything is read back from storage on demand and cached only for as
 * long as this wake-up lasts.
 *
 * The one piece of real logic is {@link noteTransportFailure}. Without
 * host permissions every request is cross-origin, and a server that
 * does not trust this extension's origin refuses them all with a bare
 * `TypeError` — which is indistinguishable from being offline (see
 * lib/api.ts). So a transport failure re-asks `/api/health`, which
 * answers `Access-Control-Allow-Origin: *` and therefore gets through
 * either way, at most once a minute. `originTrusted: false` is what the
 * popup shows its "this server does not trust this extension" notice
 * from. The TypeError itself is NEVER read as a refusal: a real outage
 * would then be reported as a trust problem, and anything the extension
 * was holding on to would be thrown away on the strength of it.
 */
import {
  checkServer,
  isUnauthorized,
  lookUpSessionUser,
  revokeSession,
  type ServerCheck,
} from "../lib/api.js";
import { currentApiUrl, loadServerInfo, saveServerInfo, type ServerInfo } from "../lib/config.js";
import { clearPendingDeviceAuth } from "../lib/device-auth-store.js";
import {
  clearLinkBlock,
  clearSignOutMarker,
  saveLinkBlock,
  saveSignOutMarker,
} from "../lib/sign-out-marker.js";
import {
  clearSession,
  loadSession,
  saveSession,
  type SessionSource,
  type StoredSession,
} from "../lib/session.js";

export type RuntimeState = {
  apiUrl: string;
  session: StoredSession | null;
  /** Undefined exactly when `session` is null. */
  sessionSource: SessionSource | undefined;
};

/** How often a transport failure may cost one `/api/health` request. */
export const SERVER_RECHECK_MIN_INTERVAL_MS = 60_000;

let cachedServer: ServerInfo | null = null;
let lastCheckedAt = Number.NEGATIVE_INFINITY;

/** What the last `/api/health` said, or null if none has answered yet. */
export const getCachedServerInfo = (): ServerInfo | null => cachedServer;

export async function ensureReady(): Promise<RuntimeState> {
  const apiUrl = await currentApiUrl();
  if (cachedServer === null) cachedServer = await loadServerInfo();
  const session = await loadSession();
  return { apiUrl, session, sessionSource: session?.source };
}

/** The web app of the current server, from what is known or from `/api/health`. */
export async function resolveWebUrl(): Promise<string | null> {
  if (cachedServer?.webUrl != null) return cachedServer.webUrl;
  const stored = await loadServerInfo();
  if (stored?.webUrl != null) {
    cachedServer = stored;
    return stored.webUrl;
  }
  const check = await refreshServerInfo(await currentApiUrl(), { force: true });
  return check?.webUrl ?? null;
}

/**
 * Ask the server about itself and remember the answer.
 *
 * Rate-limited unless forced: this runs off every transport failure,
 * and a server that is genuinely down would otherwise be asked once per
 * failed request.
 */
export async function refreshServerInfo(
  apiUrl: string,
  options: { force?: boolean; now?: () => number } = {},
): Promise<ServerInfo | null> {
  const now = (options.now ?? Date.now)();
  if (options.force !== true && now - lastCheckedAt < SERVER_RECHECK_MIN_INTERVAL_MS) {
    return cachedServer;
  }
  lastCheckedAt = now;
  const check: ServerCheck = await checkServer(apiUrl);
  if (!check.ok) return cachedServer;
  const info: ServerInfo = {
    origin: check.origin,
    webUrl: check.webUrl,
    originTrusted: check.originTrusted,
  };
  cachedServer = info;
  await saveServerInfo(info);
  return info;
}

/**
 * Called wherever a request failed without an answer. Re-checks the
 * server so an untrusted origin stops looking like an outage.
 *
 * Deliberately returns nothing: no caller may branch on "was it a trust
 * problem?" at the point of failure. The answer arrives later, in the
 * snapshot the popup reads.
 */
export async function noteTransportFailure(): Promise<void> {
  await refreshServerInfo(await currentApiUrl());
}

/** Store a freshly issued session and clear everything that blocked one. */
export async function adoptSession(
  token: string,
  userId: string | null,
  source: SessionSource,
): Promise<void> {
  await saveSession({ token, userId, source });
  // A sign-in of ANY kind is a newer decision than the sign-out that
  // wrote these, so both go.
  await clearSignOutMarker();
  await clearLinkBlock();
}

/**
 * Sign out the session the WEB APP linked, and nothing else.
 *
 * No marker and no link block: the web app did this, so asking the web
 * app to sign out would be circular, and a later web sign-in should
 * link the extension again.
 */
export async function signOutLinkedWebSession(): Promise<void> {
  const { apiUrl, session } = await ensureReady();
  if (session === null) return;
  if (session.source !== "web") return;
  await revokeSession(apiUrl, session.token);
  await clearSession();
  await clearPendingDeviceAuth();
}

/** The web app switched accounts: leave the old linked session behind. */
export async function switchLinkedAccount(): Promise<void> {
  await signOutLinkedWebSession();
}

/**
 * Somebody signed out IN THE EXTENSION.
 *
 * Three things, and each of them is the narrow version of what a shared
 * cookie used to do bluntly:
 *  - revoke this extension's OWN session row, so it does not sit in the
 *    account's devices list for another month;
 *  - write the marker, so the same person's web tab signs out too — on
 *    its next `sync`, not instantly, because the extension cannot reach
 *    a page;
 *  - write the link block, so a web session that predates this does not
 *    quietly sign the extension back in on the very next `sync`.
 */
export async function signOutExplicitly(now: number = Date.now()): Promise<void> {
  const { apiUrl, session } = await ensureReady();
  if (session !== null) {
    await revokeSession(apiUrl, session.token);
    if (session.userId !== null) {
      await saveSignOutMarker({ userId: session.userId, apiOrigin: apiUrl, at: now });
    }
  }
  await saveLinkBlock({ apiOrigin: apiUrl, at: now });
  await clearSession();
  await clearPendingDeviceAuth();
}

/** A 401 means the stored token is dead; keep everything else. */
export async function forgetRejectedSession(error: unknown): Promise<boolean> {
  if (!isUnauthorized(error)) return false;
  await clearSession();
  return true;
}

export type SwitchServerResult =
  | { ok: true; server: ServerInfo }
  | { ok: false; code: "INVALID_URL" | "UNREACHABLE" | "ORIGIN_NOT_TRUSTED"; message: string };

/**
 * Point the extension at another server.
 *
 * There is no permission step — without host permissions there is
 * nothing to ask for. The check that matters is `originTrusted`: a
 * server that does not trust this extension would answer every later
 * request with a CORS refusal that reads as an outage, so it is refused
 * here, once, with the setting that fixes it named. A server too old to
 * report the field (`null`) is let through.
 *
 * The old server's session is revoked whatever its source: it belongs
 * to that server, and leaving it would park a live session in an
 * account the person has moved away from.
 */
export async function switchServer(input: string): Promise<SwitchServerResult> {
  let origin: string;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    origin = url.origin;
  } catch {
    return {
      ok: false,
      code: "INVALID_URL",
      message: `"${input}" is not a web address. It looks like https://__HATCHKIT_DOMAIN__.`,
    };
  }

  const check = await checkServer(origin);
  if (!check.ok) return { ok: false, code: "UNREACHABLE", message: check.message };
  if (check.originTrusted === false) {
    return {
      ok: false,
      code: "ORIGIN_NOT_TRUSTED",
      message:
        `${origin} does not trust this extension's origin. Add it to that server's ` +
        "TRUSTED_ORIGINS (Chrome), or set TRUST_EXTENSION_ORIGINS=true (Firefox).",
    };
  }

  const { apiUrl, session } = await ensureReady();
  if (session !== null && apiUrl !== origin) {
    await revokeSession(apiUrl, session.token);
    await clearSession();
  }
  await clearPendingDeviceAuth();
  await clearSignOutMarker();
  await clearLinkBlock();

  const info: ServerInfo = {
    origin: check.origin,
    webUrl: check.webUrl,
    originTrusted: check.originTrusted,
  };
  cachedServer = info;
  lastCheckedAt = Date.now();
  await saveServerInfo(info);
  return { ok: true, server: info };
}

/**
 * Who the current token belongs to, asked of the server.
 *
 * Used by the device flow before a token is kept: `/device/token`
 * returns no user, so a token whose session names somebody other than
 * the person the flow was started for is revoked rather than adopted.
 */
export async function sessionUser(
  apiUrl: string,
  token: string,
): Promise<{ userId: string; email: string | null } | null> {
  return lookUpSessionUser(apiUrl, token);
}

/** Test seam: forget the cached `/api/health` answer. */
export const resetServerCache = (): void => {
  cachedServer = null;
  lastCheckedAt = Number.NEGATIVE_INFINITY;
};
