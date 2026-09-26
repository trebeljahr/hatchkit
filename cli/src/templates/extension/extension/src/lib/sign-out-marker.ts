/**
 * "Somebody signed the extension out on purpose", kept for the web app.
 *
 * The extension cannot message a page — there is no content script, and
 * the bridge only ever ANSWERS a page's request — so an extension
 * sign-out cannot be pushed to the web app the way a shared cookie used
 * to carry it. It is written down instead, and the next `sync` from a
 * tab of the same person on the same server is answered `sign-out-web`.
 *
 * Narrower than a cookie on purpose, and every narrowing below is load
 * bearing:
 *
 *  - a marker from one account never signs a DIFFERENT account out of
 *    the web app;
 *  - a marker older than the web session says nothing about it, which
 *    is what lets somebody sign out in the extension and then sign back
 *    in on the web without being signed straight out again;
 *  - one past {@link EXTENSION_SIGN_OUT_MARKER_TTL_MS} is forgotten.
 *
 * Beside it, the {@link LinkBlock}: the same sign-out, seen from the
 * other side. The marker answers "should the web app sign out?" and is
 * narrowed to one person and a lifetime. The block answers "may a web
 * session link the extension again?" and is narrowed to nothing — no
 * web session that began before an explicit sign-out links the
 * extension, whoever it belongs to and however long ago it was. Only a
 * sign-in of any kind clears it.
 */
import { sameServerOrigin } from "@starter/core";
import {
  EXTENSION_SIGN_OUT_MARKER_TTL_MS,
  type ExtensionBridgeWebSession,
} from "@starter/shared/extension-bridge";
import { localStore } from "./chrome-storage.js";

export const SIGN_OUT_MARKER_STORAGE_KEY = "__HATCHKIT_STORAGE_PREFIX__.web-sign-out-marker";
export const LINK_BLOCK_STORAGE_KEY = "__HATCHKIT_STORAGE_PREFIX__.web-link-not-before";

export type SignOutMarker = {
  userId: string;
  /** The API origin the extension was signed out of. */
  apiOrigin: string;
  /** When (epoch ms). */
  at: number;
};

export type LinkBlock = {
  apiOrigin: string;
  /** A web session that began at or before this never links. */
  at: number;
};

const store = localStore;

export const decodeSignOutMarker = (raw: string | null): SignOutMarker | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { userId, apiOrigin, at } = parsed as Record<string, unknown>;
    if (typeof userId !== "string" || userId === "") return null;
    if (typeof apiOrigin !== "string" || apiOrigin === "") return null;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return null;
    return { userId, apiOrigin, at };
  } catch {
    return null;
  }
};

export async function saveSignOutMarker(marker: SignOutMarker): Promise<void> {
  await store().setItem(SIGN_OUT_MARKER_STORAGE_KEY, JSON.stringify(marker));
}

export async function loadSignOutMarker(): Promise<SignOutMarker | null> {
  return decodeSignOutMarker(await store().getItem(SIGN_OUT_MARKER_STORAGE_KEY));
}

export async function clearSignOutMarker(): Promise<void> {
  await store().removeItem(SIGN_OUT_MARKER_STORAGE_KEY);
}

/**
 * What a marker means for a web session that just said who it is.
 *
 * - `sign-out-web`: the same person, on the same server, whose web
 *   session began BEFORE the extension was signed out, within the
 *   marker's lifetime.
 * - `discard`: anything else — the marker has nothing more to say to
 *   anybody and is deleted, so it cannot sign out a web session that
 *   begins later.
 *
 * A signed-out page also discards it: the web app is already where the
 * marker wanted it.
 */
export const signOutMarkerVerdict = (
  marker: SignOutMarker,
  apiOrigin: string,
  web: ExtensionBridgeWebSession,
  now: number,
): "sign-out-web" | "discard" => {
  if (web.userId === null || web.sessionCreatedAt === null) return "discard";
  if (now - marker.at > EXTENSION_SIGN_OUT_MARKER_TTL_MS) return "discard";
  if (!sameServerOrigin(marker.apiOrigin, apiOrigin)) return "discard";
  if (marker.userId !== web.userId) return "discard";
  if (marker.at <= web.sessionCreatedAt) return "discard";
  return "sign-out-web";
};

export const decodeLinkBlock = (raw: string | null): LinkBlock | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { apiOrigin, at } = parsed as Record<string, unknown>;
    if (typeof apiOrigin !== "string" || apiOrigin === "") return null;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return null;
    return { apiOrigin, at };
  } catch {
    return null;
  }
};

/** Written on every explicit sign-out, whether or not the account is known. */
export async function saveLinkBlock(block: LinkBlock): Promise<void> {
  await store().setItem(LINK_BLOCK_STORAGE_KEY, JSON.stringify(block));
}

export async function loadLinkBlock(): Promise<LinkBlock | null> {
  return decodeLinkBlock(await store().getItem(LINK_BLOCK_STORAGE_KEY));
}

/** Cleared by a sign-in of any kind, and by nothing else. */
export async function clearLinkBlock(): Promise<void> {
  await store().removeItem(LINK_BLOCK_STORAGE_KEY);
}

/**
 * Whether `block` keeps a web session that began at `sessionCreatedAt`
 * from linking the extension on `apiOrigin`. A session with no known
 * start is blocked: it cannot be shown to be newer.
 */
export const isLinkBlocked = (
  block: LinkBlock | null,
  apiOrigin: string,
  sessionCreatedAt: number | null,
): boolean => {
  if (block === null || !sameServerOrigin(block.apiOrigin, apiOrigin)) return false;
  return sessionCreatedAt === null || sessionCreatedAt <= block.at;
};
