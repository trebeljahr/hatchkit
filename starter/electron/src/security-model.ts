/*
 * The two decisions the security baseline makes, as pure functions with no
 * Electron import, so both are unit-tested (security.test.ts). security.ts
 * binds them to `app`, `session` and every webContents.
 *
 * Keeping them here is what makes them testable at all: `import { app } from
 * "electron"` only resolves inside the Electron runtime, so a decision written
 * inline in the event handler can be read but never asserted on.
 */

import type { WebPreferences } from "electron";

import { isTrustedNavigationUrl, isTrustedSenderUrl } from "./trust.ts";

/**
 * What to do with a URL the window is about to show.
 *
 * - `allow`: the app's own document (the app scheme, or the dev server in an
 *   unpackaged run).
 * - `open-in-os`: a link that leaves the app. It goes to the browser or the
 *   mail client, where the person's password manager, extensions and history
 *   are, and cannot repaint the app's own window.
 * - `block`: dropped. `shell.openExternal` starts whatever handler the OS has
 *   registered for a scheme, so a `file:` or custom-scheme URL that reached
 *   the app from a page must not be able to launch a local application.
 */
export type NavigationDecision = "allow" | "open-in-os" | "block";

export function navigationDecision(
  url: string,
  options: {
    devUrl: string | null;
    /** external.ts's `mayOpenExternally`, injected so this file stays pure. */
    mayOpenExternally: (url: string) => boolean;
  },
): NavigationDecision {
  if (isTrustedNavigationUrl(url, options.devUrl)) return "allow";
  return options.mayOpenExternally(url) ? "open-in-os" : "block";
}

/**
 * The web permissions the app's own documents are granted. Everything else —
 * camera, microphone, geolocation, MIDI, clipboard read, … — is denied, and
 * nothing at all is granted to any other document.
 *
 * `notifications` is the exception because the shell posts a notice when the
 * window is hidden (the tray keeps the app running with no window on screen),
 * and a denied notification permission makes that notice disappear with no
 * error anywhere.
 *
 * Chromium also gates `navigator.clipboard.writeText` on a permission,
 * `clipboard-sanitized-write`. An app with a Copy button has to add it here,
 * or every copy fails with a write-permission error. It is not granted by
 * default: a template that ships an unused permission teaches the wrong
 * baseline.
 */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set(["notifications"]);

export function permissionDecision(
  permission: string,
  url: string | null | undefined,
  devUrl: string | null,
): boolean {
  return GRANTED_PERMISSIONS.has(permission) && isTrustedSenderUrl(url ?? null, devUrl);
}

/**
 * The renderer settings every window in this app is created with (window.ts
 * spreads these). One constant, because each of them is a silent failure when
 * it drifts:
 *
 * - `contextIsolation` and `sandbox` keep the page out of the preload's realm
 *   and out of Node. Without them a single injected script owns the machine.
 * - `nodeIntegration: false` is the default and is stated anyway, so a future
 *   edit has to argue with it.
 * - `webSecurity: false` is the usual "fix" for a CORS error in a desktop
 *   shell. It also turns off the same-origin policy for the whole renderer.
 * - `webviewTag: false` removes the `<webview>` element. security.ts also
 *   refuses `will-attach-webview`, so a page that finds another way in is
 *   still stopped.
 * - `backgroundThrottling: false`: a hidden window is throttled like a
 *   background tab, and this one is hidden whenever it is closed to the tray.
 *   Chromium's intensive throttling holds a hidden renderer's timers to once a
 *   minute after five minutes, which stalls a socket the renderer owns.
 *
 * `devTools` is not here: it is false outside a development run, which
 * window.ts decides per launch.
 */
export const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  spellcheck: true,
  backgroundThrottling: false,
} as const satisfies WebPreferences;
