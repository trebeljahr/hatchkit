/**
 * Signing the extension in through the RFC 8628 device flow.
 *
 * Two ways in share everything here:
 *  - the web app linking the extension (`bridge.ts`, purpose
 *    `web-link`): somebody is signed in to the web app, the page
 *    approves a code the extension started, and the extension fetches a
 *    session of its OWN. No credential crosses the bridge;
 *  - the popup's "Sign in with the web app" (purpose `manual`): the
 *    approval page opens in a tab. This is also the way in for an
 *    account with two-factor authentication, which the password form
 *    cannot complete.
 *
 * The worker never long-polls: MV3 stops it after about thirty idle
 * seconds, so the pending authorization is stored
 * (`lib/device-auth-store.ts`) and each thing that wakes the worker
 * makes one exchange. An alarm finishes a manual sign-in when nothing
 * else does.
 *
 * Every exchange runs through {@link serially}, so two tabs and an
 * alarm can never spend one device code twice or start two
 * authorizations at once.
 */
import {
  ApiError,
  requestDeviceToken,
  revokeSession,
  startDeviceAuthorization,
  type DeviceAuthorization,
} from "../lib/api.js";
import {
  clearDeviceAuthFailure,
  clearPendingDeviceAuth,
  createDeviceRequestId,
  DEVICE_AUTH_ALARM,
  isLivePendingDeviceAuth,
  loadPendingDeviceAuth,
  noteDeviceAuthFailure,
  savePendingDeviceAuth,
  type DeviceAuthPurpose,
  type PendingDeviceAuth,
} from "../lib/device-auth-store.js";
import { adoptSession, ensureReady, sessionUser } from "./runtime.js";

/** What one exchange came to. The names are the bridge's device statuses. */
export type DeviceExchangeOutcome = "signed-in" | "pending" | "failed" | "expired";

/** Chrome's floor for a repeating alarm is thirty seconds. */
const DEVICE_ALARM_PERIOD_MINUTES = 0.5;

let chain: Promise<unknown> = Promise.resolve();

/**
 * Run `task` after every task already queued, whatever became of them.
 * Never call it from inside a task: that task would wait for itself.
 */
export const serially = <T>(task: () => Promise<T>): Promise<T> => {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const clearDeviceAlarm = async (): Promise<void> => {
  try {
    await chrome.alarms.clear(DEVICE_AUTH_ALARM);
  } catch {
    /* no alarm to clear */
  }
};

/** The approval page may only be an https page, or http on this machine. */
export const isAllowedVerificationUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
};

/**
 * Start an authorization and write it down.
 *
 * `forUserId` is who the page said is signed in. It is not sent
 * anywhere: it is kept so the token this eventually buys can be checked
 * against it before it is adopted.
 */
export async function beginDeviceAuthorization(
  apiOrigin: string,
  purpose: DeviceAuthPurpose,
  forUserId: string | null,
  now: number = Date.now(),
): Promise<{ record: PendingDeviceAuth; authorization: DeviceAuthorization }> {
  const authorization = await startDeviceAuthorization(apiOrigin);
  const record: PendingDeviceAuth = {
    requestId: createDeviceRequestId(),
    deviceCode: authorization.deviceCode,
    userCode: authorization.userCode,
    apiOrigin,
    purpose,
    forUserId,
    expiresAt: now + authorization.expiresInSeconds * 1000,
  };
  return { record, authorization };
}

/**
 * Exchange a pending authorization for a session, up to `attempts`
 * times with `delayMs` between them.
 *
 * The token is adopted only after the server names the expected user.
 * `/device/token` says nothing about the account, and a `web-link` code
 * is approved by whatever session the page holds — so a token whose
 * session is somebody else's is REVOKED and discarded rather than
 * stored. Without that check, a page could link the extension to an
 * account the person never chose here.
 */
export async function exchangePendingDeviceAuth(
  record: PendingDeviceAuth,
  attempts = 1,
  delayMs = 1000,
  now: () => number = Date.now,
): Promise<DeviceExchangeOutcome> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (record.expiresAt <= now()) {
      await clearPendingDeviceAuth();
      await clearDeviceAlarm();
      return "expired";
    }
    let result: Awaited<ReturnType<typeof requestDeviceToken>>;
    try {
      result = await requestDeviceToken(record.apiOrigin, record.deviceCode);
    } catch (error) {
      // A terminal RFC error (access_denied, expired_token) ends it. A
      // transport failure does not: the code is still good, and the
      // next wake-up tries again.
      if (error instanceof ApiError) {
        await clearPendingDeviceAuth();
        await clearDeviceAlarm();
        await noteDeviceAuthFailure(now());
        return error.code === "expired_token" ? "expired" : "failed";
      }
      return "pending";
    }

    if (result.status === "approved") {
      const { token, userId } = result.session;
      const named = await sessionUser(record.apiOrigin, token);
      const resolvedUserId = named?.userId ?? userId;
      if (
        named === null ||
        (record.forUserId !== null && named.userId !== record.forUserId)
      ) {
        // Not the account this flow was started for — or an account the
        // server would not name. Neither is a session this extension
        // may keep.
        await revokeSession(record.apiOrigin, token);
        await clearPendingDeviceAuth();
        await clearDeviceAlarm();
        await noteDeviceAuthFailure(now());
        return "failed";
      }
      await adoptSession(token, resolvedUserId, record.purpose === "manual" ? "device" : "web");
      await clearPendingDeviceAuth();
      await clearDeviceAuthFailure();
      await clearDeviceAlarm();
      return "signed-in";
    }

    if (attempt + 1 < attempts) await sleep(result.status === "slow-down" ? delayMs * 2 : delayMs);
  }
  return "pending";
}

/**
 * The popup's "Sign in with the web app": start a code, open the
 * approval page, and leave the alarm to finish it.
 *
 * `chrome.tabs.create` needs no permission — opening a tab is not
 * reading one.
 */
export async function startManualSignIn(): Promise<
  { ok: true; authorization: DeviceAuthorization } | { ok: false; message: string }
> {
  const { apiUrl } = await ensureReady();
  try {
    const { record, authorization } = await beginDeviceAuthorization(apiUrl, "manual", null);
    await savePendingDeviceAuth(record);
    const target = authorization.verificationUriComplete || authorization.verificationUri;
    if (target !== "" && isAllowedVerificationUrl(target)) {
      await chrome.tabs.create({ url: target });
    }
    await chrome.alarms.create(DEVICE_AUTH_ALARM, {
      periodInMinutes: DEVICE_ALARM_PERIOD_MINUTES,
    });
    return { ok: true, authorization };
  } catch (error) {
    await noteDeviceAuthFailure(Date.now());
    return {
      ok: false,
      message:
        error instanceof ApiError
          ? error.message
          : "Could not reach the server to start sign-in.",
    };
  }
}

/** One exchange attempt against whatever is pending. Safe to call on any wake-up. */
export async function resumePendingDeviceAuth(
  now: number = Date.now(),
): Promise<DeviceExchangeOutcome | "nothing-pending"> {
  const record = await loadPendingDeviceAuth();
  if (record === null) return "nothing-pending";
  const { apiUrl } = await ensureReady();
  if (!isLivePendingDeviceAuth(record, apiUrl, now)) {
    await clearPendingDeviceAuth();
    await clearDeviceAlarm();
    return "expired";
  }
  return serially(() => exchangePendingDeviceAuth(record, 1));
}
