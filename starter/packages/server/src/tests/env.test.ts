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

const { env, getTrustedOrigins } = await import("../config/env.js");

test("getTrustedOrigins leads with the configured frontend URL", () => {
  assert.notEqual(env.FRONTEND_URL, "");
  assert.equal(getTrustedOrigins()[0], env.FRONTEND_URL);
});

test("getTrustedOrigins splits, trims and appends TRUSTED_ORIGINS", () => {
  assert.deepEqual(getTrustedOrigins().slice(1), [
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
