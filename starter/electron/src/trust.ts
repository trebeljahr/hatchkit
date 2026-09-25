/*
 * One answer to "is this URL our own document?", shared by the IPC guard
 * (ipc.ts) and the navigation and permission guards (security-model.ts).
 *
 * A packaged app has exactly one trusted origin: the app scheme's. An
 * unpackaged run also trusts the dev server URL it was started with, because
 * `pnpm dev:desktop` loads the page from Next's dev server rather than the
 * export. A PACKAGED app ignores the dev URL entirely — otherwise anyone who
 * could set an environment variable on an installed copy could point it at a
 * page of their own and reach every IPC handler through the preload.
 *
 * `URL.origin` is NOT usable for the app scheme. Node's URL parser follows the
 * WHATWG rules, where only the special schemes (http, https, ws, wss, ftp,
 * file) have a tuple origin; every other scheme gets the opaque origin, and
 * `new URL("app://-/index.html").origin` is the string "null". Chromium gives
 * the scheme a real origin in the renderer because protocol.ts registers it as
 * `standard`, but the main process — where these checks run — is plain Node.
 * Comparing origins there would refuse every frame of our own app, and, worse,
 * would make `about:blank`, `data:` and `file:` URLs compare equal to each
 * other. So the app URL is matched on protocol and host, and the dev URL is
 * matched on origin only after it has been confirmed to be http(s).
 */

import { DESKTOP_APP_ORIGIN } from "../../packages/shared/src/desktop-bridge.ts";

/** A URL on the packaged app's own origin, `app://-`. */
export function isAppUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}` === DESKTOP_APP_ORIGIN;
  } catch {
    return false;
  }
}

/** An http(s) URL — the only kind handed to the OS browser, and the only kind
 *  a dev URL may be. */
export function isExternalWebUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Same origin as the dev server `dev:desktop` loads, when there is one.
 *
 * Only an http(s) dev URL counts. `file:`, `data:` and `about:` URLs all share
 * the opaque origin "null", so an origin comparison alone would trust every
 * one of them the moment a malformed dev URL was set.
 */
export function isDevUrl(url: string | null | undefined, devUrl: string | null): boolean {
  if (!url || !devUrl || !isExternalWebUrl(devUrl) || !isExternalWebUrl(url)) return false;
  try {
    return new URL(url).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

/**
 * May a frame at `url` call the bridge? Only the app's own documents: the
 * export over `app://-`, or the dev server in `dev:desktop`. Anything else — a
 * page navigated to by mistake, an `about:blank` frame, a `data:` URL — is
 * refused, however it came to have the preload attached.
 */
export function isTrustedSenderUrl(url: string | null | undefined, devUrl: string | null): boolean {
  return isAppUrl(url) || isDevUrl(url, devUrl);
}

/**
 * Whether the window may navigate to this URL itself. Same rule as the IPC
 * guard: anything else is handed to the OS browser (security.ts), so a link to
 * a payment page or a docs site opens where the person's password manager,
 * extensions and history are — and cannot repaint the app's own window.
 */
export function isTrustedNavigationUrl(url: string, devUrl: string | null): boolean {
  return isTrustedSenderUrl(url, devUrl);
}

/**
 * A URL the app may hand to the OS when a link would leave it: http(s) for the
 * browser and `mailto:` for the mail client. Nothing else — `shell.openExternal`
 * starts whatever handler the OS has registered for a scheme, so a URL that
 * arrived from a page must not be able to launch an arbitrary application.
 */
export function isOsHandledUrl(url: string): boolean {
  if (isExternalWebUrl(url)) return true;
  try {
    return new URL(url).protocol === "mailto:";
  } catch {
    return false;
  }
}
