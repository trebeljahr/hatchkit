/**
 * The device authorization that is currently in flight, written down.
 *
 * Nothing long-polls in the worker: Chrome stops an idle MV3 service
 * worker after about thirty seconds, so a loop holding a device code is
 * a loop that dies halfway. The pending authorization is stored
 * instead, and every event that wakes the worker — the page's
 * `device-approved`, the alarm, the popup opening — makes ONE exchange
 * attempt against it.
 *
 * It lives in `chrome.storage.session`, like the token: a device code
 * is a credential for the few minutes it is alive, and it has no
 * business surviving a browser restart.
 *
 * One authorization at a time. `purpose` is what keeps the two ways in
 * from fighting: a `manual` one (the popup's "Sign in with the web
 * app") is never replaced by a `web-link` one the bridge would start.
 */
import { localStore, sessionStore } from "./chrome-storage.js";

export type DeviceAuthPurpose = "web-link" | "manual";

export type PendingDeviceAuth = {
  /** Our own id for this attempt; the page echoes it back. */
  requestId: string;
  deviceCode: string;
  userCode: string;
  /** Which server it was started against. */
  apiOrigin: string;
  purpose: DeviceAuthPurpose;
  /**
   * For a `web-link`: the user the page said was signed in. The token
   * is discarded unless the session it buys names this user.
   */
  forUserId: string | null;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
};

const PENDING_KEY = "__HATCHKIT_STORAGE_PREFIX__.pending-device-auth";
const FAILED_AT_KEY = "__HATCHKIT_STORAGE_PREFIX__.device-auth-failed-at";

/** The alarm that finishes a popup-started sign-in while nothing else wakes us. */
export const DEVICE_AUTH_ALARM = "__HATCHKIT_STORAGE_PREFIX__.device-auth";

const pendingStore = sessionStore;
const failureStore = localStore;

/** A request id the page can echo without it being guessable. */
export const createDeviceRequestId = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export const decodePendingDeviceAuth = (raw: string | null): PendingDeviceAuth | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const { requestId, deviceCode, userCode, apiOrigin, purpose, forUserId, expiresAt } = record;
    if (typeof requestId !== "string" || requestId === "") return null;
    if (typeof deviceCode !== "string" || deviceCode === "") return null;
    if (typeof userCode !== "string" || userCode === "") return null;
    if (typeof apiOrigin !== "string" || apiOrigin === "") return null;
    if (purpose !== "web-link" && purpose !== "manual") return null;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
    return {
      requestId,
      deviceCode,
      userCode,
      apiOrigin,
      purpose,
      forUserId: typeof forUserId === "string" && forUserId !== "" ? forUserId : null,
      expiresAt,
    };
  } catch {
    return null;
  }
};

export async function loadPendingDeviceAuth(): Promise<PendingDeviceAuth | null> {
  return decodePendingDeviceAuth(await pendingStore().getItem(PENDING_KEY));
}

export async function savePendingDeviceAuth(record: PendingDeviceAuth): Promise<void> {
  await pendingStore().setItem(PENDING_KEY, JSON.stringify(record));
}

export async function clearPendingDeviceAuth(): Promise<void> {
  await pendingStore().removeItem(PENDING_KEY);
}

/** Still worth exchanging: same server, not expired. */
export const isLivePendingDeviceAuth = (
  record: PendingDeviceAuth,
  apiOrigin: string,
  now: number,
): boolean => record.apiOrigin === apiOrigin && record.expiresAt > now;

export async function noteDeviceAuthFailure(now: number): Promise<void> {
  await failureStore().setItem(FAILED_AT_KEY, String(now));
}

export async function loadDeviceAuthFailedAt(): Promise<number | null> {
  const raw = await failureStore().getItem(FAILED_AT_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function clearDeviceAuthFailure(): Promise<void> {
  await failureStore().removeItem(FAILED_AT_KEY);
}
