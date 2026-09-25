import assert from "node:assert/strict";
import test from "node:test";

// `config/env.ts` snapshots process.env into a frozen `env` object at
// module-evaluation time, so the environment has to be staged BEFORE the
// module is pulled in — hence the dynamic import instead of a static one.
// dotenvx does not overload keys already present in process.env, so these
// assignments win over whatever .env.development happens to hold.
//
// Staging matters here: `hatchkit create` rewrites FRONTEND_URL to each
// project's own allocated client port, so asserting on a hardcoded
// http://localhost:3000 would pin an incidental scaffold default rather
// than getTrustedOrigins()' actual contract. TRUSTED_ORIGINS is set with
// stray whitespace and an empty entry to exercise the trim/filter path.
process.env.FRONTEND_URL = "http://localhost:4321";
process.env.TRUSTED_ORIGINS = " capacitor://localhost ,https://localhost,, app://- ";
// The store clients the self-host compose file turns on. TRUST_STORE_APPS is
// deliberately left unset, because "unset means on" is the whole point of the
// switch and staging a value would hide a regression in that default. The
// first entry repeats a TRUSTED_ORIGINS one, so the dedupe is exercised too.
process.env.STORE_CLIENT_ORIGINS = "capacitor://localhost, chrome-extension://storeidhere";

const {
  buildTrustedOrigins,
  env,
  getTrustedOrigins,
  resolveTrustExtensionOrigins,
  resolveTrustStoreApps,
  trustsExtensionOrigins,
  trustsStoreApps,
} = await import("../config/env.js");

test("getTrustedOrigins leads with the configured frontend URL", () => {
  assert.notEqual(env.FRONTEND_URL, "");
  assert.equal(getTrustedOrigins()[0], env.FRONTEND_URL);
});

test("getTrustedOrigins splits, trims and appends TRUSTED_ORIGINS", () => {
  // The hand-listed origins come before the store clients, so this slice is
  // exactly the TRUSTED_ORIGINS csv.
  assert.deepEqual(getTrustedOrigins().slice(1, 4), [
    "capacitor://localhost",
    "https://localhost",
    "app://-",
  ]);
});

test("getTrustedOrigins yields only non-empty, pre-trimmed origins", () => {
  const origins = getTrustedOrigins();
  assert.ok(origins.length > 0);
  for (const origin of origins) {
    assert.equal(typeof origin, "string");
    assert.notEqual(origin, "");
    assert.equal(origin, origin.trim());
  }
});

// ── The store clients ───────────────────────────────────────────────────
// A self-hosted server has to accept the published phone, desktop and
// extension builds without anybody editing a trust list, or every sign-in
// from them is refused with 403 INVALID_ORIGIN before the password is read.

test("STORE_CLIENT_ORIGINS is parsed like TRUSTED_ORIGINS and appended", () => {
  const origins = getTrustedOrigins();
  assert.ok(origins.includes("chrome-extension://storeidhere"));
  assert.equal(origins.at(-1), "chrome-extension://storeidhere");
});

test("a store origin already listed by hand is kept exactly once", () => {
  const origins = getTrustedOrigins();
  const seen = origins.filter((o) => o === "capacitor://localhost");
  assert.equal(seen.length, 1);
});

test("TRUST_STORE_APPS is on unless it is explicitly false", () => {
  assert.equal(resolveTrustStoreApps(""), true);
  assert.equal(resolveTrustStoreApps("true"), true);
  assert.equal(resolveTrustStoreApps("anything else"), true);
  assert.equal(resolveTrustStoreApps("false"), false);
  assert.equal(resolveTrustStoreApps(" FALSE "), false);
  assert.equal(resolveTrustStoreApps("0"), false);
  // Unset in this process, so the default is what the server actually runs.
  assert.equal(trustsStoreApps(), true);
});

test("TRUST_STORE_APPS=false drops the store clients and nothing else", () => {
  const source = {
    frontendUrl: "https://example.com",
    trustedOrigins: "app://-",
    storeClientOrigins: "capacitor://localhost,https://localhost",
    trustStoreApps: true,
  };
  assert.deepEqual(buildTrustedOrigins(source), [
    "https://example.com",
    "app://-",
    "capacitor://localhost",
    "https://localhost",
  ]);
  assert.deepEqual(buildTrustedOrigins({ ...source, trustStoreApps: false }), [
    "https://example.com",
    "app://-",
  ]);
});

// ── The extension flavour that cannot be listed ─────────────────────────
// Every install gets its own identifier, so the origin is matched by shape,
// and only while the request carries no session cookie.

test("TRUST_EXTENSION_ORIGINS follows TRUST_STORE_APPS when unset", () => {
  assert.equal(resolveTrustExtensionOrigins("", true), true);
  assert.equal(resolveTrustExtensionOrigins("", false), false);
  assert.equal(resolveTrustExtensionOrigins("   ", true), true);
  assert.equal(trustsExtensionOrigins(), trustsStoreApps());
});

test("an explicit TRUST_EXTENSION_ORIGINS wins in both directions", () => {
  assert.equal(resolveTrustExtensionOrigins("false", true), false);
  assert.equal(resolveTrustExtensionOrigins("true", false), true);
  assert.equal(resolveTrustExtensionOrigins(" ON ", false), true);
});

