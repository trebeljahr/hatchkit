import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  API_BASE_PATH,
  ConfigError,
  DEFAULT_API_ORIGIN,
  ORIGIN_VAR,
  TOKEN_VAR,
  normaliseOrigin,
  readConfig,
} from "../config.js";

describe("origin normalisation", () => {
  it("reads the three spellings of one origin as one origin", () => {
    const expected = "https://api.example.com";
    assert.equal(normaliseOrigin("https://api.example.com"), expected);
    assert.equal(normaliseOrigin("https://api.example.com/"), expected);
    assert.equal(normaliseOrigin("https://api.example.com/api/v1"), expected);
    assert.equal(normaliseOrigin("https://api.example.com/api/v1/"), expected);
    assert.equal(normaliseOrigin("  https://api.example.com  "), expected);
  });

  it("keeps a path prefix that is not the versioned base path", () => {
    // A deployment behind a reverse proxy at /app is a different origin from
    // the bare host, and swallowing the prefix would 404 every call.
    assert.equal(normaliseOrigin("https://example.com/app/"), "https://example.com/app");
    assert.equal(normaliseOrigin("https://example.com/app/api/v1"), "https://example.com/app");
  });

  it("drops a query, a fragment and embedded credentials", () => {
    assert.equal(normaliseOrigin("https://example.com/?x=1#f"), "https://example.com");
    assert.equal(normaliseOrigin("https://user:secret@example.com/"), "https://example.com");
  });

  it("refuses a non-http(s) value instead of guessing a scheme", () => {
    for (const bad of ["example.com", "ftp://example.com", "file:///tmp", ""]) {
      assert.throws(() => normaliseOrigin(bad), ConfigError, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  it("names the variable in every refusal", () => {
    // The host shows only that the process exited, so the sentence on stderr
    // is the entire diagnosis — it has to say which variable is wrong.
    for (const bad of ["example.com", "ftp://example.com"]) {
      try {
        normaliseOrigin(bad);
        assert.fail("expected a refusal");
      } catch (error) {
        assert.match((error as Error).message, new RegExp(ORIGIN_VAR));
      }
    }
  });
});

describe("readConfig", () => {
  it("defaults the origin and appends the versioned base path once", () => {
    const config = readConfig({ [TOKEN_VAR]: "sk_test" });
    assert.equal(config.origin, DEFAULT_API_ORIGIN);
    assert.equal(config.baseUrl, `${DEFAULT_API_ORIGIN}${API_BASE_PATH}`);
    assert.equal(config.token, "sk_test");
  });

  it("does not double the base path when the user pasted it", () => {
    const config = readConfig({
      [TOKEN_VAR]: "sk_test",
      [ORIGIN_VAR]: `https://api.example.com${API_BASE_PATH}`,
    });
    assert.equal(config.baseUrl, `https://api.example.com${API_BASE_PATH}`);
  });

  it("refuses a missing credential, naming the variable and where to mint one", () => {
    for (const env of [{}, { [TOKEN_VAR]: "   " }]) {
      try {
        readConfig(env);
        assert.fail("expected a refusal");
      } catch (error) {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(TOKEN_VAR));
        assert.match(error.message, /apiTokens\.create/);
      }
    }
  });

  it("trims the credential, because a pasted value carries a newline", () => {
    assert.equal(readConfig({ [TOKEN_VAR]: " sk_test\n" }).token, "sk_test");
  });
});
