/**
 * fetch's connect timeout: hatchkit raises Node's 10 s default so API
 * calls over slow links (relayed tailnet, loaded machine) do not fail
 * with a bare "fetch failed".
 *
 * Run: `node scripts/test.mjs test-http-timeouts.ts`
 */
import assert from "node:assert/strict";
import { getGlobalDispatcher } from "undici";
import {
  configureHttpTimeouts,
  connectTimeoutMs,
  DEFAULT_CONNECT_TIMEOUT_MS,
} from "./src/utils/http-timeouts.js";

assert.equal(connectTimeoutMs({}), DEFAULT_CONNECT_TIMEOUT_MS);
assert.equal(connectTimeoutMs({ HATCHKIT_CONNECT_TIMEOUT_MS: "90000" }), 90_000);
assert.equal(connectTimeoutMs({ HATCHKIT_CONNECT_TIMEOUT_MS: "nope" }), DEFAULT_CONNECT_TIMEOUT_MS);
assert.equal(connectTimeoutMs({ HATCHKIT_CONNECT_TIMEOUT_MS: "-5" }), DEFAULT_CONNECT_TIMEOUT_MS);

const before = getGlobalDispatcher();
assert.equal(configureHttpTimeouts({ HATCHKIT_CONNECT_TIMEOUT_MS: "45000" }), 45_000);
assert.notEqual(getGlobalDispatcher(), before, "fetch now uses hatchkit's dispatcher");
console.log("  ✓ connect timeout defaults to 30 s and follows HATCHKIT_CONNECT_TIMEOUT_MS");
