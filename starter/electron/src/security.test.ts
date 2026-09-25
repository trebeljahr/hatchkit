/*
 * The decisions, not the bindings: this imports security-model.ts rather than
 * security.ts, because security.ts imports `electron`, which resolves only
 * inside the Electron runtime.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { navigationDecision, permissionDecision, WEB_PREFERENCES } from "./security-model.ts";

const DEV_URL = "http://localhost:3000";

/** external.ts's rule, restated here so the test needs no Electron import. */
const mayOpenExternally = (url: string): boolean => {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

const decide = (url: string, devUrl: string | null = null) =>
  navigationDecision(url, { devUrl, mayOpenExternally });

describe("navigationDecision", () => {
  it("allows the app's own origin", () => {
    // `new URL("app://-/").origin` is the string "null" in Node: `app` is not
    // a scheme Node's parser treats as special, whatever Chromium was told in
    // protocol.ts. A trust check written with `.origin` therefore refuses the
    // app's own documents, and the app answers nothing at all.
    const hint = "trust.ts must compare protocol + host for app:// URLs, not URL.origin";
    assert.equal(decide("app://-/"), "allow", hint);
    assert.equal(decide("app://-/settings/?tab=general"), "allow", hint);
  });

  it("refuses another host on the app scheme", () => {
    assert.equal(decide("app://elsewhere/index.html"), "block");
  });

  it("allows the dev server only in an unpackaged run", () => {
    assert.equal(decide("http://localhost:3000/login/", DEV_URL), "allow");
    // Packaged: devUrl is null, so the same URL leaves the app.
    assert.equal(decide("http://localhost:3000/login/"), "open-in-os");
  });

  it("hands web and mail links to the OS", () => {
    assert.equal(decide("https://example.com/docs"), "open-in-os");
    assert.equal(decide("http://example.com/"), "open-in-os");
    assert.equal(decide("mailto:hello@example.com"), "open-in-os");
  });

  it("drops everything the OS must not be asked to start", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "about:blank",
      "javascript:alert(1)",
      "vscode://file/tmp",
      "not a url",
    ]) {
      assert.equal(decide(url), "block", url);
    }
  });
});

describe("permissionDecision", () => {
  it("grants notifications to the app's own documents", () => {
    assert.equal(
      permissionDecision("notifications", "app://-/", null),
      true,
      "trust.ts must compare protocol + host for app:// URLs, not URL.origin",
    );
    assert.equal(permissionDecision("notifications", "http://localhost:3000/", DEV_URL), true);
  });

  it("denies every other permission, however the request arrives", () => {
    for (const permission of [
      "camera",
      "microphone",
      "geolocation",
      "midi",
      "midiSysex",
      "clipboard-read",
      "clipboard-sanitized-write",
      "openExternal",
      "media",
      "display-capture",
    ]) {
      assert.equal(permissionDecision(permission, "app://-/", null), false, permission);
    }
  });

  it("denies notifications to a document that is not ours", () => {
    assert.equal(permissionDecision("notifications", "https://example.com/", null), false);
    assert.equal(permissionDecision("notifications", "file:///tmp/page.html", null), false);
    assert.equal(permissionDecision("notifications", null, null), false);
    assert.equal(permissionDecision("notifications", undefined, null), false);
    // A packaged app ignores the dev URL, so this is not a trusted document.
    assert.equal(permissionDecision("notifications", "http://localhost:3000/", null), false);
  });
});

describe("WEB_PREFERENCES", () => {
  it("keeps the hardening a later edit could quietly drop", () => {
    assert.equal(WEB_PREFERENCES.contextIsolation, true);
    assert.equal(WEB_PREFERENCES.nodeIntegration, false);
    assert.equal(WEB_PREFERENCES.sandbox, true);
    assert.equal(WEB_PREFERENCES.webSecurity, true);
    assert.equal(WEB_PREFERENCES.webviewTag, false);
  });

  it("does not decide devTools, which depends on the run", () => {
    assert.equal("devTools" in WEB_PREFERENCES, false);
  });
});
