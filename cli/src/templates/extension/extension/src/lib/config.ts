/**
 * What this BUILD is, and which server it is pointed at.
 *
 * The three constants below are baked in by vite (see vite.config.ts)
 * from the build target, never read from storage:
 *
 *  - `DEFAULT_API_URL` is where a fresh install starts. The person can
 *    point the popup at another server; that choice is stored.
 *  - `BRIDGE_TARGET` is which web origins the bridge accepts. It is the
 *    same value the manifest's `externally_connectable` was generated
 *    from, so a manifest typo cannot widen what the worker accepts —
 *    and it is not configurable at runtime, because it is what every
 *    sender is checked against.
 *  - `APP_VERSION` is the release, for the devices list on the server.
 */
import type { ExtensionBridgeTarget } from "@starter/shared/extension-bridge";
import { localStore } from "./chrome-storage.js";

export const DEFAULT_API_URL: string = import.meta.env.VITE_API_URL ?? "";
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "0.0.0";
export const BRIDGE_TARGET: ExtensionBridgeTarget =
  (import.meta.env.VITE_BRIDGE_TARGET as ExtensionBridgeTarget | undefined) ?? "none";

/**
 * Names this client to the server: the device-flow `client_id`, and the
 * label the account's devices list shows. Cosmetic there, load-bearing
 * here — the server's `validateClient` only starts a device
 * authorization for a client id it knows.
 */
export const EXTENSION_CLIENT_ID = "__HATCHKIT_DEVICE_CLIENT_ID__";

/**
 * Sent beside every request so the server can label the session in the
 * account's devices list. Cosmetic there, and never a permission — the
 * name itself is a project-wide identifier, so it comes from the
 * manifest rather than being spelled out per client.
 */
export const CLIENT_HEADER = "__HATCHKIT_CLIENT_HEADER__";

const SERVER_KEY = "__HATCHKIT_STORAGE_PREFIX__.server";

/** What a server said about itself, as the popup and the bridge read it. */
export type ServerInfo = {
  /** The API origin this record is about. */
  origin: string;
  /** Where its web app lives, from `/api/health`. Null when it did not say. */
  webUrl: string | null;
  /**
   * Whether the server trusts the origin that asked, or null from a
   * server too old to report it. `false` is the untrusted-origin case:
   * every request will be refused by CORS and look exactly like being
   * offline, so the popup says so instead of showing an offline badge
   * forever.
   */
  originTrusted: boolean | null;
};

const store = localStore;

export async function loadServerInfo(): Promise<ServerInfo | null> {
  const raw = await store().getItem(SERVER_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { origin, webUrl, originTrusted } = parsed as Record<string, unknown>;
    if (typeof origin !== "string" || origin === "") return null;
    return {
      origin,
      webUrl: typeof webUrl === "string" && webUrl !== "" ? webUrl : null,
      originTrusted: typeof originTrusted === "boolean" ? originTrusted : null,
    };
  } catch {
    return null;
  }
}

export async function saveServerInfo(info: ServerInfo): Promise<void> {
  await store().setItem(SERVER_KEY, JSON.stringify(info));
}

/** The API origin this install talks to: the stored choice, else the build's. */
export async function currentApiUrl(): Promise<string> {
  const stored = await loadServerInfo();
  return stored?.origin ?? DEFAULT_API_URL;
}
