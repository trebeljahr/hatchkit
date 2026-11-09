/**
 * Sign in with Apple — the one part better-auth does not do for you.
 *
 * better-auth's own Apple provider (`socialProviders.apple`) handles the
 * redirect, Apple's `form_post` callback, the code exchange and ID-token
 * verification. What it cannot do is produce the client secret: Apple issues
 * no static one. The secret is an ES256 JWT signed with the `.p8` key from the
 * Apple Developer portal, and Apple refuses one that lives longer than six
 * months. This module mints it at boot and re-mints it lazily, so a server
 * that runs for a year never presents an expired secret.
 *
 * Environment (all read from `process.env`, once, on first use):
 *
 *   APPLE_CLIENT_ID      The Services ID — the OAuth client_id of the web flow.
 *   APPLE_TEAM_ID        The 10-character Team ID of the developer account.
 *   APPLE_KEY_ID         The 10-character Key ID of the Sign in with Apple key.
 *   APPLE_PRIVATE_KEY    The contents of the `.p8` file (PEM). Literal `\n`
 *                        sequences are accepted, for single-line env files.
 *   APPLE_APP_BUNDLE_ID  Optional. The native app's bundle ID. Set it only
 *                        when a native app signs in with an Apple identity
 *                        token; without it the ID-token path is switched off.
 *
 * Sign in with Apple is OFF unless the first four are all set and the key
 * parses. A partial set is logged by NAME (never by value) and also leaves it
 * off, because a half-configured provider fails at Apple's token endpoint with
 * a bare `invalid_client` that says nothing about which value is wrong.
 *
 * Three things here fail quietly if they are changed:
 *
 * - **`clientSecret` is a getter.** better-auth keeps a reference to the
 *   options object it was given and reads `clientSecret` on every authorize
 *   and token call, so each read gets a secret that is still valid. Replace
 *   the getter with a plain value and every sign-in works — until the first
 *   secret expires, months after anybody remembers this file.
 *   `tests/apple-sign-in.test.ts` builds a real better-auth instance and
 *   proves the secret it uses still changes after the refresh interval.
 *
 * - **Apple's origin is trusted only through `appleSignInPlugin()`.** Apple
 *   returns with a cross-site POST from `https://appleid.apple.com`, and
 *   better-auth refuses a POST from an untrusted origin whenever the request
 *   carries any cookie. The origin is added by a plugin rather than in
 *   `trustedOrigins` because that option belongs to the CORS list too, and
 *   Apple's page has no business making credentialed requests to this API.
 *
 * - **The ID-token audience is the bundle ID only.** An identity token minted
 *   for the web Services ID is not accepted at `/sign-in/social`: nothing in
 *   the web flow needs it, and a token that leaked from a browser would
 *   otherwise be a sign-in for up to an hour.
 */

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";

/** Where Apple's sign-in pages live, and the `aud` of every client secret. */
export const APPLE_ORIGIN = "https://appleid.apple.com";

/** Apple rejects a client secret that lives longer than six months. */
export const APPLE_MAX_SECRET_TTL_SEC = 15_777_000;
/** The lifetime minted with — well inside Apple's limit. */
export const APPLE_SECRET_TTL_SEC = 60 * 60 * 24 * 90;
/** Re-mint once the current secret is this old. */
export const APPLE_SECRET_REFRESH_AFTER_SEC = 60 * 60 * 24 * 30;

/** The variables this module reads. */
export type AppleEnvKey =
  | "APPLE_CLIENT_ID"
  | "APPLE_TEAM_ID"
  | "APPLE_KEY_ID"
  | "APPLE_PRIVATE_KEY"
  | "APPLE_APP_BUNDLE_ID";

/** A string map, so `process.env` satisfies it under every declaration of
 *  `ProcessEnv` — an all-optional object type would not (TS2559): Next's
 *  declares named properties only, none of them Apple's. */
export type AppleEnv = Readonly<Record<string, string | undefined>>;

export type AppleConfig = {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: KeyObject;
  /** Absent when no native app signs in with an identity token. */
  appBundleIdentifier?: string;
};

/** The shape better-auth's `socialProviders.apple` accepts. */
export type AppleProviderOptions = {
  clientId: string;
  readonly clientSecret: string;
  appBundleIdentifier?: string;
  audience?: string[];
  disableIdTokenSignIn?: boolean;
};

const REQUIRED: readonly AppleEnvKey[] = [
  "APPLE_CLIENT_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
];

/** Team IDs and Key IDs are both ten upper-case letters and digits. */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Parse the Apple settings. Returns null — Sign in with Apple off — when any
 * required value is missing or malformed. Pure apart from `log`, so a test can
 * call it with a literal object.
 */
export function readAppleConfig(
  source: AppleEnv,
  log: (message: string) => void = (message) => console.error(message),
): AppleConfig | null {
  const value = (key: AppleEnvKey): string => source[key]?.trim() ?? "";
  const missing = REQUIRED.filter((key) => value(key) === "");
  if (missing.length === REQUIRED.length) return null; // Not configured at all.
  if (missing.length > 0) {
    log(`[auth] Sign in with Apple is off: ${missing.join(", ")} not set.`);
    return null;
  }

  const teamId = value("APPLE_TEAM_ID");
  const keyId = value("APPLE_KEY_ID");
  if (!APPLE_ID_RE.test(teamId) || !APPLE_ID_RE.test(keyId)) {
    log(
      "[auth] Sign in with Apple is off: APPLE_TEAM_ID and APPLE_KEY_ID must each be the 10-character id from the Apple Developer portal.",
    );
    return null;
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(value("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n"));
  } catch {
    log("[auth] Sign in with Apple is off: APPLE_PRIVATE_KEY is not a PEM private key.");
    return null;
  }
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    log(
      "[auth] Sign in with Apple is off: APPLE_PRIVATE_KEY must be the P-256 (.p8) key Apple issues for Sign in with Apple.",
    );
    return null;
  }

  const bundleId = value("APPLE_APP_BUNDLE_ID");
  return {
    clientId: value("APPLE_CLIENT_ID"),
    teamId,
    keyId,
    privateKey,
    ...(bundleId ? { appBundleIdentifier: bundleId } : {}),
  };
}

/**
 * Mint the client-secret JWT Apple's token endpoint expects.
 * https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
 */
export function createAppleClientSecret(
  config: Pick<AppleConfig, "clientId" | "teamId" | "keyId" | "privateKey">,
  nowSec: number = Math.floor(Date.now() / 1000),
  ttlSec: number = APPLE_SECRET_TTL_SEC,
): string {
  const header = { alg: "ES256", kid: config.keyId, typ: "JWT" };
  const payload = {
    iss: config.teamId,
    iat: nowSec,
    exp: nowSec + Math.min(ttlSec, APPLE_MAX_SECRET_TTL_SEC),
    aud: APPLE_ORIGIN,
    sub: config.clientId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // JWS ES256 wants the raw r||s signature, not the DER encoding Node
  // produces by default. A DER signature is rejected as invalid_client.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * A function that hands out a valid client secret, re-minting once the cached
 * one is older than {@link APPLE_SECRET_REFRESH_AFTER_SEC}.
 */
export function createAppleClientSecretSource(
  config: AppleConfig,
  now: () => number = () => Math.floor(Date.now() / 1000),
): () => string {
  let mintedAt = now();
  let secret = createAppleClientSecret(config, mintedAt);
  return () => {
    const current = now();
    if (current - mintedAt >= APPLE_SECRET_REFRESH_AFTER_SEC) {
      mintedAt = current;
      secret = createAppleClientSecret(config, mintedAt);
    }
    return secret;
  };
}

/** better-auth `socialProviders.apple` options for a parsed config. */
export function appleProviderOptions(
  config: AppleConfig,
  now?: () => number,
): AppleProviderOptions {
  const secret = createAppleClientSecretSource(config, now);
  return {
    clientId: config.clientId,
    // A getter, not a value — see the file header.
    get clientSecret(): string {
      return secret();
    },
    ...(config.appBundleIdentifier
      ? {
          appBundleIdentifier: config.appBundleIdentifier,
          audience: [config.appBundleIdentifier],
        }
      : { disableIdTokenSignIn: true }),
  };
}

/**
 * Trust Apple's origin for its `form_post` callback, and nothing else.
 *
 * No hooks, no endpoints, and it never touches a session — but it is still a
 * plugin, so it is registered ahead of `bearer()` like every other one. With
 * no config it contributes nothing.
 */
export function appleSignInPlugin(config: AppleConfig | null): BetterAuthPlugin {
  return {
    id: "apple-sign-in-origin",
    init() {
      return config ? { options: { trustedOrigins: [APPLE_ORIGIN] } } : {};
    },
  };
}

let cached: { config: AppleConfig | null } | undefined;

/**
 * The process's Apple config, read once on first use.
 *
 * Lazy on purpose: `config/env.ts` loads the env files into `process.env` when
 * it is first imported, and a read at THIS module's load time could run before
 * that. Cached so a malformed key is logged once, not on every health check.
 */
export function appleSignInConfig(): AppleConfig | null {
  cached ??= { config: readAppleConfig(process.env) };
  return cached.config;
}

/** Whether the login page should offer the button. Public via `health.check`. */
export function isAppleSignInConfigured(): boolean {
  return appleSignInConfig() !== null;
}
