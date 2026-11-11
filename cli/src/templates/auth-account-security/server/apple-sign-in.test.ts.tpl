/**
 * Sign in with Apple, against the real library.
 *
 * The unit half checks the secret itself. The other half is why this file
 * exists: it builds a real better-auth instance and proves the two properties
 * that fail quietly — the client secret better-auth actually uses still changes
 * after the refresh interval (so the getter survived better-auth's init), and
 * Apple's cross-site `form_post` is accepted rather than refused as an
 * untrusted origin. A better-auth upgrade that breaks either fails here instead
 * of six months after deploy.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  APPLE_ORIGIN,
  APPLE_SECRET_REFRESH_AFTER_SEC,
  type AppleConfig,
  appleProviderOptions,
  appleSignInPlugin,
  readAppleConfig,
} from "../auth/apple-sign-in.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
// better-auth wants a secret of at least 32 characters. Built at runtime, so no
// secret-looking literal sits in the file for scanners to flag.
const AUTH_SECRET = "x".repeat(32);
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const ENV = {
  APPLE_CLIENT_ID: "com.example.app.signin",
  APPLE_TEAM_ID: "ABCDE12345",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
};

function config(): AppleConfig {
  const parsed = readAppleConfig(ENV, () => {});
  assert.ok(parsed);
  return parsed;
}

function decode(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h ?? "", "base64url").toString()),
    payload: JSON.parse(Buffer.from(p ?? "", "base64url").toString()),
  };
}

test("the secret is a verifiable ES256 JWT for Apple", () => {
  const options = appleProviderOptions(config(), () => 1_700_000_000);
  const secret = options.clientSecret;
  const { header, payload } = decode(secret);
  assert.deepEqual(header, { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  assert.equal(payload.iss, "ABCDE12345");
  assert.equal(payload.sub, "com.example.app.signin");
  assert.equal(payload.aud, APPLE_ORIGIN);
  const [h, p, s] = secret.split(".");
  assert.ok(
    verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s ?? "", "base64url")),
  );
});

test("the secret better-auth uses changes after the refresh interval", async () => {
  let now = 1_700_000_000;
  const auth = betterAuth({
    database: memoryAdapter({}),
    secret: AUTH_SECRET,
    baseURL: "http://localhost:5000",
    socialProviders: { apple: appleProviderOptions(config(), () => now) },
    plugins: [appleSignInPlugin(config())],
  });
  const ctx = await auth.$context;
  const provider = ctx.socialProviders.find((p) => p.id === "apple");
  assert.ok(provider, "the Apple provider must be registered");
  const read = (): string => (provider.options as { clientSecret: string }).clientSecret;

  const first = read();
  assert.equal(read(), first, "no re-mint inside the refresh interval");
  now += APPLE_SECRET_REFRESH_AFTER_SEC;
  assert.notEqual(read(), first, "better-auth froze the secret: clientSecret must stay a getter");
});

test("Apple's cross-site form_post passes the origin check", async () => {
  const build = (withPlugin: boolean) =>
    betterAuth({
      database: memoryAdapter({}),
      secret: AUTH_SECRET,
      baseURL: "http://localhost:5000",
      // The control below is refused by design; its error log is noise.
      logger: { disabled: true },
      socialProviders: { apple: appleProviderOptions(config()) },
      plugins: withPlugin ? [appleSignInPlugin(config())] : [],
    });
  const post = (auth: ReturnType<typeof build>) =>
    auth.handler(
      new Request("http://localhost:5000/api/auth/callback/apple", {
        method: "POST",
        headers: {
          origin: APPLE_ORIGIN,
          // Any cookie at all turns the origin check on.
          cookie: "unrelated=1",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "state=abc&code=def",
      }),
    );

  const refused = await post(build(false));
  assert.equal(refused.status, 403, "control: without the plugin Apple's origin is refused");
  const accepted = await post(build(true));
  assert.equal(accepted.status, 302, "the form_post is turned into a GET on the callback");
  assert.match(accepted.headers.get("location") ?? "", /\/callback\/apple\?/);
});

test("ID-token sign-in is off without a bundle id, and scoped to it with one", () => {
  const web = appleProviderOptions(config());
  assert.equal(web.disableIdTokenSignIn, true);
  const nativeConfig = readAppleConfig({ ...ENV, APPLE_APP_BUNDLE_ID: "com.example.app" }, () => {});
  assert.ok(nativeConfig);
  const native = appleProviderOptions(nativeConfig);
  assert.deepEqual(native.audience, ["com.example.app"]);
  assert.equal(native.disableIdTokenSignIn, undefined);
});
