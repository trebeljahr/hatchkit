import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "google-oauth-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
delete process.env.HATCHKIT_GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
delete process.env.HATCHKIT_GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;

const {
  exchangeGoogleCode,
  extractGoogleOAuthCodeFromCallbackUrl,
  getGoogleSearchConsoleConfig,
  getStore,
  GoogleOAuthClientSecretMissingError,
  refreshGoogleSearchConsoleAccessToken,
} = await import("./src/config.js");
const { inferSearchConsoleDomainDefault, writeSearchConsoleManifest } = await import(
  "./src/provision/index.js"
);
const { MANIFEST_VERSION, readManifest, writeManifest } = await import(
  "./src/scaffold/manifest.js"
);
const { SECRET_KEYS, deleteSecret, setSecret } = await import("./src/utils/secrets.js");

assert.equal(
  extractGoogleOAuthCodeFromCallbackUrl(
    "http://127.0.0.1:51716/oauth/google/callback?state=expected&code=abc123&scope=x",
    "expected",
  ),
  "abc123",
);

assert.throws(
  () =>
    extractGoogleOAuthCodeFromCallbackUrl(
      "http://127.0.0.1:51716/oauth/google/callback?state=wrong&code=abc123",
      "expected",
    ),
  /state mismatch/,
);

assert.throws(
  () =>
    extractGoogleOAuthCodeFromCallbackUrl(
      "http://127.0.0.1:51716/oauth/google/callback?state=expected&error=access_denied",
      "expected",
    ),
  /access_denied/,
);

assert.throws(
  () =>
    extractGoogleOAuthCodeFromCallbackUrl(
      "https://accounts.google.com/o/oauth2/v2/auth?state=expected",
      "expected",
    ),
  /Expected a Google redirect URL/,
);

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), "desktop-client-id");
    assert.equal(body.get("code"), "auth-code");
    assert.equal(body.get("redirect_uri"), "http://127.0.0.1:51716/oauth/google/callback");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code_verifier"), "pkce-verifier");
    assert.equal(body.has("client_secret"), false);
    return new Response(
      JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        scope: "https://www.googleapis.com/auth/webmasters",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    const token = await exchangeGoogleCode({
      clientId: "desktop-client-id",
      code: "auth-code",
      redirectUri: "http://127.0.0.1:51716/oauth/google/callback",
      codeVerifier: "pkce-verifier",
    });
    assert.equal(token.refresh_token, "refresh-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("code_verifier"), "pkce-verifier");
    assert.equal(body.has("client_secret"), false);
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "client_secret is missing.",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        exchangeGoogleCode({
          clientId: "desktop-client-id",
          code: "auth-code",
          redirectUri: "http://127.0.0.1:51716/oauth/google/callback",
          codeVerifier: "pkce-verifier",
        }),
      GoogleOAuthClientSecretMissingError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_secret"), "desktop-client-secret");
    assert.equal(body.get("code_verifier"), "pkce-verifier");
    return new Response(
      JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    const token = await exchangeGoogleCode({
      clientId: "desktop-client-id",
      clientSecret: "desktop-client-secret",
      code: "auth-code",
      redirectUri: "http://127.0.0.1:51716/oauth/google/callback",
      codeVerifier: "pkce-verifier",
    });
    assert.equal(token.access_token, "access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), "desktop-client-id");
    assert.equal(body.get("refresh_token"), "refresh-token");
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.has("client_secret"), false);
    return new Response(JSON.stringify({ access_token: "access-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const accessToken = await refreshGoogleSearchConsoleAccessToken({
      status: "configured",
      oauthMode: "byo-client",
      scopes: [],
      clientId: "desktop-client-id",
      refreshToken: "refresh-token",
    });
    assert.equal(accessToken, "access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  getStore().set("providers.googleSearchConsole", {
    status: "configured",
    oauthMode: "byo-client",
    scopes: [],
  });
  await setSecret(SECRET_KEYS.googleSearchConsoleClientId, "desktop-client-id");
  await setSecret(SECRET_KEYS.googleSearchConsoleRefreshToken, "refresh-token");
  await deleteSecret(SECRET_KEYS.googleSearchConsoleClientSecret);
  const cfg = await getGoogleSearchConsoleConfig();
  assert.equal(cfg?.oauthMode, "byo-client");
  assert.equal(cfg?.clientId, "desktop-client-id");
  assert.equal(cfg?.clientSecret, undefined);
  assert.equal(cfg?.refreshToken, "refresh-token");
}

{
  getStore().set("providers.googleSearchConsole", {
    status: "configured",
    oauthMode: "hatchkit-pkce",
    scopes: [],
  });
  await deleteSecret(SECRET_KEYS.googleSearchConsoleClientId);
  await deleteSecret(SECRET_KEYS.googleSearchConsoleClientSecret);
  await setSecret(SECRET_KEYS.googleSearchConsoleRefreshToken, "refresh-token");
  const cfg = await getGoogleSearchConsoleConfig();
  assert.equal(cfg?.oauthMode, "hatchkit-pkce");
  assert.equal(
    cfg?.clientId,
    "932614455438-s0ih891al5pkeo4aeafekf01t6pbqd21.apps.googleusercontent.com",
  );
  assert.equal(cfg?.clientSecret, undefined);
  assert.equal(cfg?.refreshToken, "refresh-token");
}

{
  const dir = mkdtempSync(join(tmpdir(), "search-console-domain-"));
  writeFileSync(join(dir, "CNAME"), "console.example.com\n", "utf-8");
  const guess = await inferSearchConsoleDomainDefault(dir, "fractal-garden");
  assert.deepEqual(guess, { domain: "console.example.com", source: "CNAME" });
}

{
  const dir = mkdtempSync(join(tmpdir(), "search-console-domain-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fractal-garden", homepage: "https://fractal.garden/app" }),
    "utf-8",
  );
  const guess = await inferSearchConsoleDomainDefault(dir, "fallback-name");
  assert.deepEqual(guess, { domain: "fractal.garden", source: "package.json homepage" });
}

{
  const dir = mkdtempSync(join(tmpdir(), "search-console-domain-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fractal-garden" }), "utf-8");
  const guess = await inferSearchConsoleDomainDefault(dir, "fallback-name");
  assert.deepEqual(guess, { domain: "fractal.garden", source: "package.json name" });
}

{
  const dir = mkdtempSync(join(tmpdir(), "search-console-manifest-"));
  writeSearchConsoleManifest(dir, null, "asteroids", {
    domain: "asteroids.trebeljahr.com",
    siteUrl: "sc-domain:asteroids.trebeljahr.com",
  });
  const manifest = readManifest(dir);
  assert.equal(manifest?.name, "asteroids");
  assert.equal(manifest?.domain, "asteroids.trebeljahr.com");
  assert.equal(manifest?.s3Provider, "none");
  assert.equal(manifest?.deployTarget, "existing");
  assert.deepEqual(manifest?.features, []);
  assert.deepEqual(manifest?.mlServices, []);
  assert.deepEqual(manifest?.ports, { server: 3000, client: 5173 });
  assert.deepEqual(manifest?.integrations?.searchConsole, {
    domain: "asteroids.trebeljahr.com",
    siteUrl: "sc-domain:asteroids.trebeljahr.com",
    verifiedAt: manifest?.integrations?.searchConsole?.verifiedAt,
  });
}

{
  const dir = mkdtempSync(join(tmpdir(), "search-console-manifest-"));
  writeManifest(dir, {
    version: MANIFEST_VERSION,
    cliVersion: "0.1.0",
    scaffoldedAt: "2026-05-01T00:00:00.000Z",
    name: "existing-app",
    domain: "existing.example.com",
    description: "keep me",
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    deploymentMode: "coolify",
    ports: { server: 1111, client: 2222 },
    integrations: {
      email: {
        domain: "existing.example.com",
        configuredAt: "2026-05-02T00:00:00.000Z",
        destinationEmail: "owner@example.com",
      },
    },
  });
  const before = readManifest(dir);
  writeSearchConsoleManifest(dir, before, "ignored-name", {
    domain: "search.example.com",
    siteUrl: "sc-domain:search.example.com",
  });
  const after = readManifest(dir);
  assert.equal(after?.name, "existing-app");
  assert.equal(after?.domain, "existing.example.com");
  assert.equal(after?.description, "keep me");
  assert.equal(after?.deploymentMode, "coolify");
  assert.deepEqual(after?.ports, { server: 1111, client: 2222 });
  assert.equal(after?.integrations?.email?.destinationEmail, "owner@example.com");
  assert.equal(after?.integrations?.searchConsole?.domain, "search.example.com");
  assert.equal(after?.integrations?.searchConsole?.siteUrl, "sc-domain:search.example.com");
}

console.log("google oauth callback checks ok");
