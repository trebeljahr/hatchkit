/**
 * What may end up in a store listing, pinned.
 *
 * Every assertion here is a rule that fails QUIETLY when it is broken:
 * a permission added for one fetch shows an install warning on every
 * user's machine and holds up the next review; a `service_worker` key
 * in the Firefox manifest loads the add-on with no background at all —
 * the popup opens and does nothing; an `externally_connectable` written
 * out empty is an unknown key to AMO. None of these produce an error
 * anywhere in a build.
 */
import { describe, expect, it } from "vitest";
import {
  BUILD_TARGETS,
  GECKO_SETTINGS,
  RELEASE_VERSION,
  buildManifest,
  manifestVersionFields,
} from "../manifest.config";

/** The permission list, exactly, and nothing that implies host access. */
const expectNoHostAccess = (manifest: Record<string, unknown>): void => {
  expect(manifest).not.toHaveProperty("host_permissions");
  expect(manifest).not.toHaveProperty("optional_host_permissions");
  expect(manifest).not.toHaveProperty("optional_permissions");
  expect(manifest.permissions).toEqual(__HATCHKIT_PERMISSIONS_JSON__);
  expect(manifest.permissions).not.toContain("cookies");
};

describe("production manifest", () => {
  it("asks for no host access and no cookies", () => {
    expectNoHostAccess(buildManifest("production", {}));
  });

  it("lets only the hosted web app message the extension, and no other extension", () => {
    const connectable = buildManifest("production", {}).externally_connectable;
    expect(connectable).toEqual({ matches: ["__HATCHKIT_WEB_ORIGIN_PROD__/*"] });
    expect(connectable).not.toHaveProperty("ids");
  });

  it("lets EXTENSION_KEY pin the id", () => {
    expect(buildManifest("production", { EXTENSION_KEY: " fork-key " }).key).toBe("fork-key");
    // Whitespace is not a key: it must fall back rather than pin "".
    expect(buildManifest("production", { EXTENSION_KEY: "  " }).key).toBe(
      BUILD_TARGETS.production.defaultKey,
    );
  });
});

describe("development manifest", () => {
  it("keeps a path-derived id: no key unless one is supplied", () => {
    expect(buildManifest("development", {})).not.toHaveProperty("key");
    expect(buildManifest("development", { EXTENSION_KEY: "k" }).key).toBe("k");
  });

  it("asks for no host access and no cookies", () => {
    expectNoHostAccess(buildManifest("development", {}));
  });

  it("takes a local web app on any port: a dev client port is not fixed", () => {
    expect(buildManifest("development", {}).externally_connectable).toEqual({
      matches: ["http://localhost/*", "http://127.0.0.1/*"],
    });
  });

  it("is a separate extension from the production build", () => {
    // Same toolbar, both installed: different names and different out
    // dirs, so an unpacked dev build never overwrites the real one.
    expect(BUILD_TARGETS.development.name).not.toBe(BUILD_TARGETS.production.name);
    expect(BUILD_TARGETS.development.outDir).not.toBe(BUILD_TARGETS.production.outDir);
  });
});

describe("firefox manifest", () => {
  const manifest = buildManifest("firefox", {});

  it("asks for no host access and no cookies, like every other build", () => {
    expectNoHostAccess(manifest);
  });

  it("runs an event page, not a service worker", () => {
    // Gecko has no `service_worker` key. A manifest carrying one loads
    // with no background at all — every listener unregistered.
    expect(manifest.background).toEqual({ scripts: ["background.js"], type: "module" });
  });

  it("carries the gecko id and the version floor AMO needs", () => {
    expect(manifest.browser_specific_settings).toEqual({ gecko: GECKO_SETTINGS });
    // PERMANENT once listed: AMO keys the listing and Firefox keys the
    // profile's stored data on it.
    expect(GECKO_SETTINGS.id).toBe("__HATCHKIT_IDENTIFIER_TOKEN__@__HATCHKIT_ORG_DOMAIN__");
    // data_collection_permissions is only read from this version on,
    // and AMO requires it on a new submission.
    expect(GECKO_SETTINGS.strict_min_version).toBe("__HATCHKIT_GECKO_MIN_VERSION__");
    expect(GECKO_SETTINGS.data_collection_permissions.required).toContain("authenticationInfo");
  });

  it("carries no Chromium-only keys", () => {
    // `key` pins an id on Chromium and means nothing here; EXTENSION_KEY
    // must not smuggle one in either, since AMO reviews the manifest it
    // is sent.
    expect(manifest).not.toHaveProperty("key");
    expect(buildManifest("firefox", { EXTENSION_KEY: "fork-key" })).not.toHaveProperty("key");
    expect(manifest).not.toHaveProperty("minimum_chrome_version");
  });

  it("has no bridge: Firefox does not connect web pages to extensions", () => {
    // The key is omitted rather than written empty — an empty match list
    // is not a narrower bridge, it is no bridge, and AMO reads an empty
    // key as a mistake. `bridgeTarget: "none"` is also what makes
    // registerBridgeListener() register nothing.
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(BUILD_TARGETS.firefox.bridgeTarget).toBe("none");
  });

  it("points at the same API as the production build", () => {
    // Not asserted from the manifest (the URL is a vite define), but the
    // two must not drift: a Firefox build pointed at localhost would
    // ship to AMO talking to nothing — and a `moz-extension://`
    // document is a secure context, so an http:// server is unreachable
    // from it whatever the manifest says.
    expect(BUILD_TARGETS.firefox.apiUrl).toBe(BUILD_TARGETS.production.apiUrl);
    expect(BUILD_TARGETS.firefox.apiUrl.startsWith("https://")).toBe(true);
    expect(BUILD_TARGETS.firefox.outDir).toBe("dist-firefox");
  });
});

describe("manifest version", () => {
  it("comes from the root package.json, the version the release tag names", async () => {
    const root = (await import("../../../package.json")).default as { version: string };
    expect(RELEASE_VERSION).toBe(root.version);
    expect(buildManifest("production", {}).version).toBe(manifestVersionFields(root.version).version);
  });

  it("keeps a plain release as the version alone", () => {
    expect(manifestVersionFields("1.2.3")).toEqual({ version: "1.2.3" });
  });

  it("splits a prerelease into a Chrome version and a version_name", () => {
    expect(manifestVersionFields("0.2.0-rc.1")).toEqual({
      version: "0.2.0",
      version_name: "0.2.0-rc.1",
    });
  });

  it("refuses a version Chrome cannot read", () => {
    expect(() => manifestVersionFields("v1.2.3")).toThrow(/Chrome version/);
    expect(() => manifestVersionFields("1.2.3.4.5")).toThrow(/Chrome version/);
  });
});
