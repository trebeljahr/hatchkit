/*
 * cli/src/features/extension/types.ts — the data the `extension`
 * feature is defined by, in one place.
 *
 * Every value here is read by BOTH halves of the feature: the apply
 * that renders `packages/extension/**` into a project, and the tests
 * that pin what may end up in a store listing. A permission added in
 * one place and not the other is exactly the drift this file exists to
 * make impossible — the manifest template interpolates these arrays
 * rather than spelling them out, and `cli/test-extension.ts` asserts
 * both the constants and the rendered text.
 */

/** The three targets a build can be. A build IS a target: the default
 *  API origin is baked in at build time, so `development` and
 *  `production` are different bundles with different ids, and
 *  `firefox` is the same code written for a different engine. */
export type ExtensionBuildMode = "development" | "production" | "firefox";

export const EXTENSION_BUILD_MODES: readonly ExtensionBuildMode[] = [
  "development",
  "production",
  "firefox",
];

/**
 * The permission list, exactly, in every build.
 *
 * `storage` holds the session token, the server choice and the
 * sign-out marker; `alarms` is what retries a device-code exchange
 * after the service worker has been stopped. Nothing else: a
 * scaffolded extension makes ordinary cross-origin requests to its own
 * API and needs no host access to do it.
 *
 * Keep this list short on purpose. Every entry is an install warning
 * on every store user's machine, and a store review question. A
 * permission added "just for one fetch" is the failure this array is
 * pinned against.
 */
export const EXTENSION_PERMISSIONS: readonly string[] = ["storage", "alarms"];

/**
 * Keys that must never appear in any generated manifest.
 *
 * `host_permissions` / `optional_host_permissions` would make requests
 * same-site rather than CORS, which changes what the server sees
 * (Firefox then sends no `Origin` header at all) and asks every user
 * for access to sites the extension has no business reading.
 * `optional_permissions` is absent because the generated extension has
 * no optional surface — an empty key reads as an oversight.
 */
export const EXTENSION_FORBIDDEN_MANIFEST_KEYS: readonly string[] = [
  "host_permissions",
  "optional_host_permissions",
  "optional_permissions",
];

/**
 * Permissions that must never be requested, even if someone adds an
 * optional list later. `cookies` is the one that matters: the whole
 * design of the bridge exists because the extension cannot read the
 * web app's session cookie, and granting it back would quietly undo
 * every narrowing decision below it.
 */
export const EXTENSION_FORBIDDEN_PERMISSIONS: readonly string[] = ["cookies", "webRequest"];

/**
 * The Firefox add-on's floor.
 *
 * 140 because `data_collection_permissions` — which addons.mozilla.org
 * requires on a new submission — is only read from 140 on. That is
 * also comfortably above `storage.session` (115) and MV3 (109).
 */
export const EXTENSION_GECKO_MIN_VERSION = "140.0";

/** The protocol version the generated bridge writes. Separate from the
 *  project's API level on purpose: a web deploy and a store update land
 *  on different days, so the two numbers move for different reasons. */
export const EXTENSION_BRIDGE_VERSION = 1;

/** Top-level paths the feature owns, for the `backend` / `static`
 *  surface prune in `cli/src/scaffold/surfaces.ts`. The feature refuses
 *  those surfaces outright, so this only catches a project whose
 *  surface changed after the extension was added. */
export const EXTENSION_TOP_LEVEL_PATHS: readonly string[] = [
  "packages/extension",
  "scripts/extension-package.mjs",
  ".github/workflows/extension-release.yml",
];

/** Root scripts the feature adds, and the surface prune removes. */
export const EXTENSION_SCRIPT_NAMES: readonly string[] = [
  "build:extension",
  "build:extension:prod",
  "build:extension:firefox",
  "test:extension",
  "extension:id",
];
