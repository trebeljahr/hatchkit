/*
 * Where the app keeps its profile (`userData`): localStorage, IndexedDB,
 * cookies, the encrypted session token, window-state.json and the
 * single-instance lock.
 *
 * Pinned by NAME rather than left to Electron, which derives the directory
 * from the packaged package.json's `productName`, else `name`. Adding a
 * `productName` to the root package.json — or renaming the package — would
 * then silently move every installed copy to an empty profile and strand
 * whatever was queued in the old one.
 *
 * An unpackaged run (`pnpm dev:desktop`) gets its own profile. Sharing the
 * installed app's meant sharing its single-instance lock too: with the
 * installed app open, a dev run exits at once without a word.
 *
 * A headless run (tests, agents; headless.ts) gets its own profile as well,
 * unless one is named explicitly. Headless swaps the OS keychain for
 * Chromium's mock keychain, so the installed app's ciphertext does not decrypt
 * there — and secure-store.ts deletes a ciphertext it cannot decrypt. An agent
 * verifying a packaged build on the default profile would otherwise sign the
 * person who installed the app out, from a window nobody can see.
 */

import path from "node:path";

/** Set this to move `userData` (and with it the single-instance lock). The
 *  e2e harness gives every launch a fresh directory through it. */
export const USER_DATA_DIR_ENV = "{{envPrefix}}_USER_DATA_DIR";

export const PACKAGED_PROFILE_NAME = "{{projectSlug}}";
export const UNPACKAGED_PROFILE_NAME = "{{projectSlug}}-dev";
export const HEADLESS_PROFILE_SUFFIX = "-headless";

export function userDataDir(options: {
  /** Electron's `app.getPath("appData")`. */
  appData: string;
  isPackaged: boolean;
  headless?: boolean;
  override?: string | undefined;
}): string {
  if (options.override) return path.resolve(options.override);
  const name = options.isPackaged ? PACKAGED_PROFILE_NAME : UNPACKAGED_PROFILE_NAME;
  return path.join(options.appData, options.headless ? `${name}${HEADLESS_PROFILE_SUFFIX}` : name);
}
