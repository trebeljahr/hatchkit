/**
 * Build targets, and the manifest each one produces.
 *
 * The DEFAULT API origin is baked in at build time, so a build IS a
 * target — a development bundle starts out pointed at a laptop, a
 * production one at the deployed API. All three targets are described
 * here, in TypeScript that ships in the repo, rather than in
 * `.env.development` / `.env.production`: those filenames are commonly
 * gitignored, which would make a fresh clone build an extension with no
 * URL in it and no error to say so.
 *
 * The default is only where a build starts: `store.config.json` and the
 * popup's server picker let one bundle talk to a self-hosted server.
 *
 * No build asks for host access or cookies. Every request the extension
 * makes is an ordinary cross-origin request, which the server answers
 * because the extension's origin is trusted — a Chromium build by its
 * exact `chrome-extension://<id>` origin in `TRUSTED_ORIGINS`, a
 * Firefox build by the SHAPE of its random origin
 * (`TRUST_EXTENSION_ORIGINS`, see packages/server/src/auth/extension-origins.ts).
 * That trust is a RELEASE PREREQUISITE, not a sign-in detail: without
 * it the extension cannot make a single request.
 *
 * What the cookie used to do — follow the web app's sign-in — is the
 * web app <-> extension bridge instead (src/background/bridge.ts).
 * `externally_connectable` is not a permission and shows no install
 * warning.
 */
import {
  extensionBridgeMatchPatterns,
  type ExtensionBridgeTarget,
} from "@starter/shared/extension-bridge";
import rootPackage from "../../package.json" with { type: "json" };
import storeConfig from "./store.config.json" with { type: "json" };

export type BuildMode = "development" | "production" | "firefox";

export type BuildTarget = {
  /** Baked in as the default API origin. */
  apiUrl: string;
  /** Distinct so a dev build and a real one can sit in the toolbar together. */
  name: string;
  /**
   * Which web origins may message this build (`externally_connectable`),
   * and which the worker's bridge accepts. Baked into the bundle as
   * `VITE_BRIDGE_TARGET`, so the manifest and the runtime check cannot
   * name two different lists.
   */
  bridgeTarget: ExtensionBridgeTarget;
  /**
   * The public key pinned when `EXTENSION_KEY` is not set, or undefined
   * to let the id follow the load path.
   */
  defaultKey: string | undefined;
  outDir: string;
  /**
   * Which engine the manifest is written for. Gecko takes a different
   * background entry, needs an add-on id of its own, and supports
   * neither `key` nor `externally_connectable` for web pages.
   */
  engine: "chromium" | "gecko";
};

/**
 * The Firefox add-on's identity, and the floor it needs.
 *
 * `id` is PERMANENT once the add-on is listed: addons.mozilla.org keys
 * the listing, and Firefox keys the profile's stored data, on it. A
 * change orphans every install's stored session and server choice.
 *
 * `strict_min_version` is __HATCHKIT_GECKO_MIN_VERSION__ because
 * `data_collection_permissions` — which AMO requires on a new
 * submission — is only read from that version on. It is also
 * comfortably above `storage.session` (115) and MV3 (109).
 *
 * The data collection list describes what really leaves the machine:
 * the email and password typed into the popup's sign-in form. Add to it
 * when you add features that send more.
 */
export const GECKO_SETTINGS = {
  id: "__HATCHKIT_IDENTIFIER_TOKEN__@__HATCHKIT_ORG_DOMAIN__",
  strict_min_version: "__HATCHKIT_GECKO_MIN_VERSION__",
  data_collection_permissions: {
    required: ["authenticationInfo", "personallyIdentifyingInfo"],
  },
} as const;

/**
 * The Chrome Web Store identity, filled in once the listing exists.
 *
 * `storeExtensionKey` is the PUBLIC half of the signing key; pinning it
 * gives every build — unpacked, uploaded or installed from the store —
 * the same id, which is what lets a server list that id in
 * `TRUSTED_ORIGINS` before the first upload. `storeExtensionId` is the
 * id that key produces, and the release workflow refuses to upload a
 * build whose key does not produce it: without that check a fork's key
 * could be published over your listing.
 *
 * Both empty means "no listing yet": the production build then gets
 * whatever id the load path or the store assigns it, which is fine for
 * development and wrong for a release.
 */
export const STORE_EXTENSION_KEY: string = storeConfig.storeExtensionKey;
export const STORE_EXTENSION_ID: string = storeConfig.storeExtensionId;

export const BUILD_TARGETS: Record<BuildMode, BuildTarget> = {
  development: {
    // The API origin `pnpm dev` serves. A worktree on random ports uses
    // the popup's server picker instead.
    apiUrl: "__HATCHKIT_API_URL_DEV__",
    name: "__HATCHKIT_PRODUCT_NAME__ (dev)",
    // Any port on either loopback name: a dev client port is not fixed.
    bridgeTarget: "development",
    // No key. An unpacked extension's id is derived from its path, and
    // the dev server trusts that id. Pinning the store key here would
    // give the dev build the store build's id: the two could no longer
    // be installed side by side.
    defaultKey: undefined,
    engine: "chromium",
    // An unpacked extension's id is derived from its path, so moving
    // this directory changes the id — and with it the
    // `chrome-extension://...` origin already in the dev server's
    // TRUSTED_ORIGINS.
    outDir: "dist",
  },
  production: {
    // An ORIGIN, with no path: the extension appends `/api/...` itself.
    apiUrl: "__HATCHKIT_API_URL_PROD__",
    name: "__HATCHKIT_PRODUCT_NAME__",
    // Only the hosted web app. A self-hosted one lives on a domain no
    // manifest can list; those servers use the popup's password form.
    bridgeTarget: "production",
    defaultKey: STORE_EXTENSION_KEY === "" ? undefined : STORE_EXTENSION_KEY,
    engine: "chromium",
    outDir: "dist-prod",
  },
  /**
   * The Firefox build. Same code, `--mode firefox`, and every
   * difference below is the engine's — each one fails QUIETLY if it is
   * broken, which is why they are pinned by src/manifest.test.ts:
   *
   *  - `background.scripts`, because Gecko's MV3 background is an event
   *    page. A manifest carrying `service_worker` loads with no
   *    background at all: every listener unregistered, and a popup that
   *    does nothing.
   *  - An add-on id in `browser_specific_settings`, because Firefox
   *    derives nothing from a `key` — which is a Chromium field Gecko
   *    ignores, so it is left out rather than carried along.
   *  - No `externally_connectable`: Firefox does not implement it for
   *    web pages, so the bridge does not exist here and
   *    `registerBridgeListener()` registers nothing. Signing in on the
   *    web app therefore never signs the add-on in; the popup's
   *    password form is the way in.
   *  - Its origin is `moz-extension://<random uuid>`, fresh on every
   *    install, so no `TRUSTED_ORIGINS` entry can hold it. The server
   *    trusts the shape instead (`TRUST_EXTENSION_ORIGINS`).
   *  - A `moz-extension://` document is a secure context, so Firefox
   *    blocks insecure `ws://` and `http://` from it — there is no
   *    loopback exception, unlike Chrome, and host permissions do not
   *    change it. Against an `http://` dev server this build cannot
   *    reach the API at all; point it at an https server to test.
   */
  firefox: {
    apiUrl: "__HATCHKIT_API_URL_PROD__",
    name: "__HATCHKIT_PRODUCT_NAME__",
    // No bridge on this engine at all, rather than the development list
    // by omission.
    bridgeTarget: "none",
    // `key` is Chromium's way of pinning an id. Firefox's is the gecko
    // id above, and a stray `key` in a manifest AMO reviews reads as a
    // Chrome build somebody forgot to clean up.
    defaultKey: undefined,
    engine: "gecko",
    outDir: "dist-firefox",
  },
};

/**
 * The release version, read from the root `package.json` — the one
 * number the release process bumps. A second literal here drifted from
 * it silently, and both stores refuse an upload whose version is not
 * higher than the published one, so a forgotten bump only surfaced at
 * upload. `.github/workflows/extension-release.yml` checks it against
 * the tag.
 */
export const RELEASE_VERSION: string = rootPackage.version;

/**
 * Chrome's `version` is one to four dot-separated integers, so a
 * prerelease such as `0.2.0-rc.1` cannot be one. It becomes
 * `version: "0.2.0"` with the full string kept as `version_name`, which
 * is what Chrome shows people.
 */
export const manifestVersionFields = (
  release: string,
): { version: string; version_name?: string } => {
  const match = /^(\d+(?:\.\d+){0,3})(?:[-+].*)?$/.exec(release.trim());
  if (!match) {
    throw new Error(
      `package.json version "${release}" does not start with a Chrome version (1-4 dot-separated integers).`,
    );
  }
  const version = match[1];
  return version === release.trim() ? { version } : { version, version_name: release.trim() };
};

/** The environment a build reads, narrowed so no Node typings are needed. */
export type BuildEnv = Readonly<Record<string, string | undefined>>;

const processEnv = (): BuildEnv =>
  (globalThis as { process?: { env?: BuildEnv } }).process?.env ?? {};

/**
 * A pinned public key, which fixes the extension's id.
 *
 * Without one, an unpacked extension's id follows its path and a Web
 * Store extension's id is assigned by Google — neither of which can be
 * known before the server needs it in `TRUSTED_ORIGINS`. Generate one
 * with:
 *
 *   openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out __HATCHKIT_PROJECT_SLUG__.pem
 *   openssl rsa -in __HATCHKIT_PROJECT_SLUG__.pem -pubout -outform DER | base64 | tr -d '\n'
 *
 * Keep the .pem out of the repo; only the public half belongs in a
 * manifest. `EXTENSION_KEY` overrides the pinned one, for a fork that
 * publishes under its own listing.
 */
export const pinnedKey = (target: BuildTarget, env: BuildEnv = processEnv()): string | undefined => {
  const key = env.EXTENSION_KEY?.trim();
  return key !== undefined && key !== "" ? key : target.defaultKey;
};

export function buildManifest(mode: BuildMode, env: BuildEnv = processEnv()): Record<string, unknown> {
  const target = BUILD_TARGETS[mode];
  const gecko = target.engine === "gecko";
  const key = gecko ? undefined : pinnedKey(target, env);
  const connectable = extensionBridgeMatchPatterns(target.bridgeTarget);

  return {
    manifest_version: 3,
    name: target.name,
    ...manifestVersionFields(RELEASE_VERSION),
    description: "__HATCHKIT_PRODUCT_NAME__ in your browser toolbar.",
    // Gecko reads neither of these; Chromium needs 116 for a service
    // worker that survives long-lived connections.
    ...(gecko
      ? { browser_specific_settings: { gecko: GECKO_SETTINGS } }
      : { minimum_chrome_version: "116" }),
    ...(key === undefined ? {} : { key }),
    action: {
      default_popup: "src/popup/index.html",
      default_title: target.name,
    },
    // Chromium runs an MV3 background as a service worker; Gecko runs an
    // event page and has no `service_worker` key at all, so a manifest
    // carrying one loads with no background script and an extension that
    // does nothing.
    background: gecko
      ? { scripts: ["background.js"], type: "module" }
      : { service_worker: "background.js", type: "module" },
    // Exactly this, in every build. No `cookies`, no host permissions:
    // see the header, and src/manifest.test.ts, which pins the list.
    permissions: __HATCHKIT_PERMISSIONS_JSON__,
    // The first-party web app may message the extension, so signing in
    // there signs the toolbar in too. No `ids` key: other extensions
    // cannot connect. Omitted entirely where the engine has no such
    // thing (Firefox), rather than written out empty, which AMO reads as
    // an unknown key.
    ...(connectable.length > 0 ? { externally_connectable: { matches: connectable } } : {}),
  };
}
