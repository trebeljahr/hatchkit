/*
 * The Electron security baseline, applied to every webContents the app ever
 * creates rather than to the one window we know about.
 *
 * - Navigation stays on the app's own origin. An http(s) or mailto: link that
 *   would leave it goes to the OS (browser, mail client); anything else is
 *   dropped.
 * - `window.open` never creates an Electron window. http(s) and mailto: go to
 *   the OS, and nothing else goes anywhere.
 * - `<webview>` is refused outright.
 * - Every permission request and permission check is denied, except
 *   notifications from the app's own documents (security-model.ts).
 * - Every window is created with `WEB_PREFERENCES` (security-model.ts).
 *
 * The decisions themselves are pure and tested in security.test.ts; this file
 * is the binding. The IPC sender check is in ipc.ts, the CSP in csp.ts, and
 * the menu without Reload and DevTools in menu.ts.
 */

import { app, session, type WebContents } from "electron";

import { mayOpenExternally, openInOs } from "./external.ts";
import { navigationDecision, permissionDecision } from "./security-model.ts";

export { WEB_PREFERENCES, navigationDecision, permissionDecision } from "./security-model.ts";
export type { NavigationDecision } from "./security-model.ts";

function handOver(url: string): void {
  openInOs(url).catch((err: unknown) => {
    console.warn("[security] openExternal failed:", err);
  });
}

/** Apply the navigation and webview rules to one webContents. */
export function applyWindowSecurity(
  contents: WebContents,
  options: { devUrl: string | null },
): void {
  const decide = (url: string) =>
    navigationDecision(url, { devUrl: options.devUrl, mayOpenExternally });

  contents.setWindowOpenHandler(({ url }) => {
    // Never "allow": a new Electron window would carry this app's preload and
    // its bridge to the main process, whatever it then loads.
    if (decide(url) === "open-in-os") handOver(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    const decision = decide(url);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "open-in-os") handOver(url);
  });

  // A redirect is not a click, so it is stopped rather than handed over: a
  // page that can redirect could otherwise open browser windows unprompted.
  contents.on("will-redirect", (event, url) => {
    if (decide(url) !== "allow") event.preventDefault();
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

/**
 * Install the baseline for the whole app. Called before `app` is ready, so the
 * first webContents the app creates is already covered.
 */
export function installSecurity(options: { devUrl: string | null }): void {
  const { devUrl } = options;

  app.on("web-contents-created", (_event, contents: WebContents) => {
    applyWindowSecurity(contents, { devUrl });
  });

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const url = details.requestingUrl || contents?.getURL();
      callback(permissionDecision(permission, url, devUrl));
    });
    // The check handler answers `navigator.permissions.query` and the internal
    // checks Chromium makes before a feature runs. Both must agree with the
    // request handler, or a feature reports "granted" and then does nothing.
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      return permissionDecision(permission, requestingOrigin, devUrl);
    });
  });
}
