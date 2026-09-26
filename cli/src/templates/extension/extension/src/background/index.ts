/**
 * The background entry: every listener this extension has.
 *
 * Registered at module scope, never inside a callback. An MV3 service
 * worker (and a Gecko event page) is started BY an event, so a listener
 * added asynchronously is a listener the event that woke the worker has
 * already missed.
 *
 * Two message channels, kept apart on purpose:
 *  - `onMessage` is the popup's. It is in-extension, so the sender is
 *    trusted, but a bridge message must never be accepted here — a page
 *    that could reach this channel would bypass every sender check the
 *    bridge makes.
 *  - `onMessageExternal` is the bridge's, and takes nothing else
 *    (`bridge.ts`). A popup command arriving there is refused by the
 *    decoder.
 */
import { ApiError, isTransportFailure, signInWithPassword } from "../lib/api.js";
import { APP_VERSION, BRIDGE_TARGET, DEFAULT_API_URL } from "../lib/config.js";
import { DEVICE_AUTH_ALARM } from "../lib/device-auth-store.js";
import { registerBridgeListener } from "./bridge.js";
import { resumePendingDeviceAuth, startManualSignIn } from "./device-sign-in.js";
import {
  adoptSession,
  ensureReady,
  getCachedServerInfo,
  noteTransportFailure,
  refreshServerInfo,
  signOutExplicitly,
  switchServer,
} from "./runtime.js";

/** What the popup renders from. One shape, one round trip. */
export type PopupSnapshot = {
  apiUrl: string;
  webUrl: string | null;
  version: string;
  signedIn: boolean;
  userId: string | null;
  source: "web" | "password" | "device" | null;
  /**
   * `false` means every request to this server is being refused by
   * CORS, which otherwise reads exactly like being offline. The popup
   * says so and names the setting that fixes it.
   */
  originTrusted: boolean | null;
  /** This build's own origin, for the person to paste into TRUSTED_ORIGINS. */
  extensionOrigin: string;
  bridgeAvailable: boolean;
};

export type PopupCommand =
  | { type: "popup:snapshot" }
  | { type: "popup:sign-in"; email: string; password: string }
  | { type: "popup:device-sign-in" }
  | { type: "popup:sign-out" }
  | { type: "popup:set-server"; origin: string };

export type PopupResult =
  | { ok: true; snapshot: PopupSnapshot }
  | { ok: false; message: string; code?: string };

const snapshot = async (): Promise<PopupSnapshot> => {
  const { apiUrl, session } = await ensureReady();
  const server = getCachedServerInfo();
  return {
    apiUrl,
    webUrl: server?.webUrl ?? null,
    version: APP_VERSION,
    signedIn: session !== null,
    userId: session?.userId ?? null,
    source: session?.source ?? null,
    originTrusted: server?.originTrusted ?? null,
    // On Firefox `chrome.runtime.id` is the ADD-ON id, not the origin:
    // the origin is a random UUID per install. `getURL("/")` is the one
    // value that is the origin on every engine.
    extensionOrigin: chrome.runtime.getURL("/").replace(/\/$/, ""),
    bridgeAvailable: BRIDGE_TARGET !== "none",
  };
};

const runCommand = async (command: PopupCommand): Promise<PopupResult> => {
  if (command.type === "popup:snapshot") {
    await refreshServerInfo((await ensureReady()).apiUrl);
    return { ok: true, snapshot: await snapshot() };
  }

  if (command.type === "popup:sign-in") {
    const { apiUrl } = await ensureReady();
    try {
      const session = await signInWithPassword(apiUrl, {
        email: command.email,
        password: command.password,
      });
      await adoptSession(session.token, session.userId, "password");
      return { ok: true, snapshot: await snapshot() };
    } catch (error) {
      if (isTransportFailure(error)) {
        // Could be an outage, could be an origin this server does not
        // trust. Asking /api/health is what tells them apart.
        await noteTransportFailure();
        const server = getCachedServerInfo();
        return {
          ok: false,
          code: server?.originTrusted === false ? "ORIGIN_NOT_TRUSTED" : "UNREACHABLE",
          message:
            server?.originTrusted === false
              ? "This server does not trust this extension's origin yet."
              : "Could not reach the server.",
        };
      }
      const api = error as ApiError;
      return { ok: false, code: api.code, message: api.message };
    }
  }

  if (command.type === "popup:device-sign-in") {
    const started = await startManualSignIn();
    return started.ok
      ? { ok: true, snapshot: await snapshot() }
      : { ok: false, message: started.message };
  }

  if (command.type === "popup:sign-out") {
    await signOutExplicitly();
    return { ok: true, snapshot: await snapshot() };
  }

  const result = await switchServer(command.origin);
  return result.ok
    ? { ok: true, snapshot: await snapshot() }
    : { ok: false, code: result.code, message: result.message };
};

const isPopupCommand = (value: unknown): value is PopupCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string" &&
  (value as { type: string }).type.startsWith("popup:");

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  // Anything that is not a popup command — a bridge envelope above all
  // — is not answered here.
  if (!isPopupCommand(message)) return false;
  void runCommand(message)
    .catch((error: unknown): PopupResult => ({
      ok: false,
      message: error instanceof Error ? error.message : "Something went wrong.",
    }))
    .then(sendResponse);
  return true;
});

// The bridge, on Chromium only: `registerBridgeListener` registers
// nothing when this build has no bridge target (Firefox).
registerBridgeListener();

// Finishes a popup-started device sign-in while nothing else wakes the
// worker. Cleared by the exchange that succeeds, expires or fails.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DEVICE_AUTH_ALARM) return;
  void resumePendingDeviceAuth();
});

// A fresh install has no stored server, so the build's default is what
// the first `/api/health` is asked about.
chrome.runtime.onInstalled.addListener(() => {
  void refreshServerInfo(DEFAULT_API_URL, { force: true });
});
