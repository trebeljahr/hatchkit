/**
 * Passkeys (WebAuthn), kept in their own module because they are the one
 * capability here that is not part of better-auth core — `@better-auth/passkey`
 * is a separate dependency, and a project that did not ask for passkeys should
 * not have to install it to compile `account-security.ts`.
 *
 * **Web browsers only.** WebAuthn binds a credential to an RP ID, which must
 * be a registered domain reached over a secure context. A shell origin —
 * `capacitor://localhost`, `file://`, Electron's `app://-` — is not a domain
 * and cannot be an RP ID, so a credential registered on the web origin is
 * unusable from a shell and one cannot be registered from a shell at all.
 * The settings row says so rather than offering a button that fails.
 *
 * `rpID` is the bare hostname (no scheme, no port); `origin` is the full
 * origin the browser will be on. Getting either wrong fails at the
 * authenticator with an opaque browser error, so both are derived from
 * configuration rather than guessed.
 */

import { passkey } from "@better-auth/passkey";

export function passkeyPlugin(config: {
  /** Bare hostname, e.g. `app.example.com`. */
  rpID: string;
  /** Human-readable name shown in the platform's passkey prompt. */
  rpName: string;
  /** Full web origin(s) a credential may be used from. */
  origin: string | string[];
}): ReturnType<typeof passkey> {
  return passkey({
    rpID: config.rpID,
    rpName: config.rpName,
    origin: config.origin,
  });
}

/** `rpID` from a base URL. Throws rather than guessing: a wrong RP ID is an
 *  opaque failure inside the browser's authenticator UI, with nothing in any
 *  server log to explain it. */
export function rpIdFromUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? "").trim();
  if (!trimmed) throw new Error("passkeys: no base URL to derive an RP ID from");
  try {
    return new URL(trimmed).hostname;
  } catch {
    throw new Error(`passkeys: ${baseUrl} is not a URL, so it has no RP ID`);
  }
}
