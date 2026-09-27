/**
 * Which server this install talks to, and which web app it opens.
 *
 * ============================================================
 * WHY NEITHER PREFERENCE HAS A MANIFEST `default`
 * ============================================================
 *
 * Raycast stores a manifest `default` as a REAL preference value the first time
 * a command runs. After that "the person never touched this" and "the person
 * deliberately typed the production origin" are the same bytes, and the
 * build-mode fallback below could never fire again — a development build would
 * keep reaching production because a default was written into the store months
 * earlier. So both origin preferences are declared `required: false` with no
 * `default`, and the empty string is the signal that means "decide for me".
 *
 * ============================================================
 * THE PLACES THAT MUST AGREE ON THE DEFAULT API ORIGIN
 * ============================================================
 *
 * The origin is baked into the build, so a wrong value compiles green and
 * points at a host that does not answer. The set is fixed and worth
 * enumerating, because changing one of them and not the rest is silent:
 *
 *  1. {@link RELEASE_API_ORIGIN} / {@link RELEASE_WEB_ORIGIN} here;
 *  2. the web client's `NEXT_PUBLIC_API_URL` build arg in
 *     `.github/workflows/build-and-deploy.yml`;
 *  3. the browser extension's production target in
 *     `packages/extension/manifest.config.ts`, when that package is present;
 *  4. the server's own `FRONTEND_URL` / `TRUSTED_ORIGINS`.
 *
 * ============================================================
 * THE PINNED DEV PORTS
 * ============================================================
 *
 * {@link LOCAL_API_ORIGIN} and {@link LOCAL_WEB_ORIGIN} name the repository's
 * PINNED dev ports (`pnpm run dev`), never the auto-picked ones. A client that
 * bakes its origin in at build time cannot follow a port that changes per run,
 * so an auto-port dev server — which is what a git worktree gets by default —
 * is invisible to this extension. Point the preference at the printed port by
 * hand, or run the dev server in pinned mode.
 */
import { environment, getPreferenceValues } from "@raycast/api";
import { USE_LOCAL_DEV_ORIGINS } from "./local-defaults";

/** The repository's pinned dev API port. */
export const LOCAL_API_ORIGIN = "http://localhost:5000";
/** The repository's pinned dev client port. */
export const LOCAL_WEB_ORIGIN = "http://localhost:3000";
/** Where a release build points. */
export const RELEASE_API_ORIGIN = "https://api.starter.example";
/** Where a release build sends a person to approve a pairing code. */
export const RELEASE_WEB_ORIGIN = "https://app.starter.example";

/** Trailing slashes are typed, pasted and copied; the origin is the same one. */
const trimOrigin = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * True when this build should fall back to the local origins.
 *
 * `environment.isDevelopment` is true under `ray develop` and false in a store
 * build, and the exported copy flips {@link USE_LOCAL_DEV_ORIGINS} to `false`
 * so a reviewer's development run still reaches the hosted service.
 */
const usesLocalOrigins = (): boolean => environment.isDevelopment && USE_LOCAL_DEV_ORIGINS;

/** The API origin this install talks to: the preference, else the build's. */
export function apiOrigin(): string {
  const preference = trimOrigin(
    getPreferenceValues<Preferences.ExtensionPreferences>().apiOrigin ?? "",
  );
  if (preference !== "") return preference;
  return usesLocalOrigins() ? LOCAL_API_ORIGIN : RELEASE_API_ORIGIN;
}

/** The web app this install opens, and where a pairing code is approved. */
export function webOrigin(): string {
  const preference = trimOrigin(
    getPreferenceValues<Preferences.ExtensionPreferences>().webOrigin ?? "",
  );
  if (preference !== "") return preference;
  return usesLocalOrigins() ? LOCAL_WEB_ORIGIN : RELEASE_WEB_ORIGIN;
}
