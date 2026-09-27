/*
 * cli/src/features/device-grant/index.ts — the shared device-grant unit.
 *
 * What it installs: better-auth's `bearer()` and its RFC 8628
 * `deviceAuthorization(...)` on the server, the `deviceAuthorizationClient()`
 * plugin on the web app's auth client, and `/device` — the page a person
 * approves a pairing code on.
 *
 * ============================================================
 * WHY IT IS A UNIT AND NOT A FEATURE
 * ============================================================
 *
 * This code used to live inside `extension`, where its own comment gave
 * the game away: bearer() is for "a client with no cookie jar — the
 * browser extension, a CLI". None of it is specific to a browser
 * extension. A launcher extension needs exactly the same thing and
 * cannot say `requires: ["extension"]` to get it — that would scaffold a
 * whole browser extension, with its manifest, its store release workflow
 * and its permission warnings, because somebody asked for a launcher.
 *
 * So it moved here, and it is deliberately NOT registered: no
 * `registerFeature`, no `Feature` union member, no `--features` entry.
 * A pairing endpoint with nothing to pair is not something to offer a
 * user. `types.ts` holds the dependent list and the predicate everything
 * else asks; `apply.ts` is what each dependent calls; `strip.ts` is the
 * other direction.
 *
 * Dependents call `applyDeviceGrant(ctx)` from their own `apply`, so it
 * runs once per selected dependent. The ledger makes every call after
 * the first report nothing written.
 */

export {
  applyDeviceGrant,
  deviceGrantClientIds,
  deviceGrantPlannedFiles,
} from "./apply.js";
export {
  type PatchResult,
  addDeviceClientPlugin,
  validateClientExpression,
  wireDeviceGrant,
} from "./patches.js";
export { stripDeviceGrant } from "./strip.js";
export {
  DEVICE_GRANT_DEPENDENTS,
  DEVICE_GRANT_OWNED_PATHS,
  DEVICE_GRANT_PATCHED_FILES,
  DEVICE_GRANT_TEMPLATES,
  deviceGrantClientHosts,
  deviceGrantWanted,
  shouldStripDeviceGrant,
} from "./types.js";
