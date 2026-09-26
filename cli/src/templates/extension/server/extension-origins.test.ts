/**
 * The scheme rule, and the two narrowings that make it safe.
 *
 * Run with the rest of the server's tests: `pnpm --filter @starter/server test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  carriesSessionCookie,
  corsDecisionFor,
  extensionOriginTrusted,
  isRandomExtensionOrigin,
  trustedOriginsForRequest,
} from "../auth/extension-origins.js";

const MOZ = "moz-extension://42a04a0c-c28d-4f59-8694-9623ce55de3d";

describe("extension origins", () => {
  it("recognises a per-install random origin, and only that shape", () => {
    assert.equal(isRandomExtensionOrigin(MOZ), true);
    assert.equal(isRandomExtensionOrigin("safari-web-extension://42a04a0c-c28d-4f59-8694-9623ce55de3d"), true);
    // A Chromium id is derivable and pinnable, so it is trusted by its
    // exact origin or not at all — never by its scheme.
    assert.equal(isRandomExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
    assert.equal(isRandomExtensionOrigin("moz-extension://not-a-uuid"), false);
    assert.equal(isRandomExtensionOrigin("https://example.com"), false);
  });

  it("is off until the server opts in", () => {
    assert.equal(extensionOriginTrusted({ origin: MOZ, cookie: null, enabled: false }), false);
    assert.equal(extensionOriginTrusted({ origin: MOZ, cookie: null, enabled: true }), true);
  });

  it("refuses a request that carries a session cookie", () => {
    // Otherwise any add-on on the machine could ride the signed-in
    // person's session — on a WebSocket upgrade there is no CORS to
    // stop it and no way to opt out of cookies.
    assert.equal(
      extensionOriginTrusted({ origin: MOZ, cookie: "better-auth.session_token=abc", enabled: true }),
      false,
    );
  });

  it("keys on the session cookie, not on any cookie", () => {
    // A CDN's SameSite=None cookie rides along on every upgrade. "Any
    // cookie" would silently kill the add-on for everybody behind one.
    assert.equal(carriesSessionCookie("__cf_bm=xyz"), false);
    assert.equal(carriesSessionCookie("__Secure-better-auth.session_token=abc"), true);
    assert.equal(carriesSessionCookie(""), false);
    assert.equal(carriesSessionCookie(undefined), false);
  });

  it("adds the asking origin to better-auth's list, and nothing else", () => {
    const request = {
      headers: { get: (name: string) => (name === "origin" ? MOZ : null) },
    };
    assert.deepEqual(trustedOriginsForRequest(["https://web.example"], request, true), [
      "https://web.example",
      MOZ,
    ]);
    assert.deepEqual(trustedOriginsForRequest(["https://web.example"], request, false), [
      "https://web.example",
    ]);
  });

  it("never answers an extension origin with credentialed CORS", () => {
    assert.deepEqual(corsDecisionFor(MOZ, undefined, ["https://web.example"], true), {
      allowed: true,
      credentials: false,
    });
    assert.deepEqual(corsDecisionFor("https://web.example", undefined, ["https://web.example"], true), {
      allowed: true,
      credentials: true,
    });
    assert.deepEqual(corsDecisionFor("https://evil.example", undefined, ["https://web.example"], true), {
      allowed: false,
      credentials: false,
    });
  });
});
