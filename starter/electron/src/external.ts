/*
 * Handing a URL to the OS: the browser for http(s), the mail client for
 * mailto:. Every caller goes through `openInOs` — the navigation guard
 * (security.ts), the bridge's `openExternal`, and the sign-in flow that sends
 * the person to a page in their own browser.
 *
 * In headless mode (tests, agents) nothing is handed over. Opening the
 * machine's browser takes focus from whoever is using the machine, which is
 * exactly what headless exists to prevent, and a CI runner would accumulate a
 * browser window per spec. The URL is recorded instead: on
 * `globalThis.__desktopOpenedExternally` for a Playwright `evaluate`, and on
 * stdout for a packaged build no inspector can reach. A spec that needs an
 * approval URL reads it from there.
 *
 * Only http(s) and mailto: are handed over. `shell.openExternal` will start
 * whatever handler the OS has registered for a scheme, so a URL that reached
 * the app from a page — a link, a redirect — must not be able to launch an
 * arbitrary local application.
 */

import { shell } from "electron";

import { isHeadless } from "./headless.ts";

export const OPENED_EXTERNALLY_GLOBAL = "__desktopOpenedExternally";

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function mayOpenExternally(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Records the URL and returns it, for the headless path and its tests. */
export function recordExternalOpen(url: string): string[] {
  const g = globalThis as Record<string, unknown>;
  const opened = Array.isArray(g[OPENED_EXTERNALLY_GLOBAL])
    ? (g[OPENED_EXTERNALLY_GLOBAL] as string[])
    : [];
  opened.push(url);
  g[OPENED_EXTERNALLY_GLOBAL] = opened;
  return opened;
}

/** True when the URL was handed over (or recorded), false when it was refused. */
export async function openInOs(url: string): Promise<boolean> {
  if (!mayOpenExternally(url)) {
    console.warn(`[external] refused ${url}`);
    return false;
  }
  if (isHeadless()) {
    recordExternalOpen(url);
    console.log(`[headless] not opening ${url}`);
    return true;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.warn("[external] open failed", err);
    return false;
  }
}
