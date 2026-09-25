/*
 * cli/src/features/auth-account-security/options.ts — the catalogue.
 *
 * One entry per selectable capability: what it is called, what it needs,
 * and — for every sign-in method — whether a client that can only hold a
 * bearer token can actually complete it.
 *
 * That last column is the point of this file. A sign-in method a native
 * shell silently cannot finish is worse than one that is absent: the user
 * gets a form that accepts input and then fails with no useful error, and
 * nothing on the server logs a reason. Each verdict below was checked
 * against the shipped source of better-auth 1.6.11 rather than its docs,
 * and the note says what in that source decides it. `docs.ts` prints the
 * table into the generated project so the answer travels with the code.
 */

import type { AuthSecurityOption, AuthSecurityOptionSpec } from "./types.js";

/** The npm package that carries WebAuthn. It is NOT part of better-auth
 *  core in 1.6.x — `better-auth/plugins` has no `passkey` export — so
 *  selecting passkeys adds a dependency rather than just a registration. */
export const PASSKEY_PACKAGE = "@better-auth/passkey";

export const AUTH_SECURITY_SPECS: Record<AuthSecurityOption, AuthSecurityOptionSpec> = {
  "two-factor": {
    id: "two-factor",
    label: "Two-factor (TOTP + backup codes)",
    summary: "Authenticator-app codes, with ten single-use backup codes stored encrypted at rest.",
    needsEmail: false,
    tokenShell: "no",
    tokenShellNote:
      "The challenge is the signed cookie `better-auth.two_factor`, and `/two-factor/verify-totp` reads nothing else. The sign-in response body is `{ twoFactorRedirect, twoFactorMethods }` — it carries no challenge token a client could hold. A WebView or extension `fetch` can neither read `set-cookie` nor send `Cookie`, so the step cannot be completed bearer-only. Forwarding the cookie by hand does work, so the fix is a header carrying the challenge (an after-hook copying it out, a before-hook turning it back into a cookie) — not a different flow.",
  },
  "email-verification": {
    id: "email-verification",
    label: "Email verification (only when mail is configured)",
    summary:
      "Require a verified address before sign-in, but only where a transport exists. Ships the idempotent backfill script for accounts created before mail did.",
    needsEmail: true,
    tokenShell: "n/a",
    tokenShellNote: "Not a sign-in method.",
  },
  credentials: {
    id: "credentials",
    label: "Change password and change email",
    summary:
      "Both from Settings, and neither signs the calling device out. Email changes are confirmed at the new address before they take effect.",
    needsEmail: false,
    tokenShell: "n/a",
    tokenShellNote: "Not a sign-in method.",
  },
  "google-oauth": {
    id: "google-oauth",
    label: "Google sign-in button",
    summary:
      "Renders in every build and decides after mount: live on the web when the server has credentials, disabled with a note in shells whose origin the redirect cannot return to.",
    needsEmail: false,
    tokenShell: "no",
    tokenShellNote:
      "The OAuth redirect must come back to the origin that started it. A shell's origin (`capacitor://localhost`, Electron's `app://-`, `file://`) can be neither a registered redirect URI nor a place Google will send a browser. The button therefore renders disabled with a note in those builds rather than being hidden, so the reason is visible.",
  },
  "account-deletion": {
    id: "account-deletion",
    label: "Delete account",
    summary:
      "Password-confirmed, with an idempotent cascade that converges when a retry follows a crash, and a second pass after the user row is gone.",
    needsEmail: false,
    tokenShell: "n/a",
    tokenShellNote:
      "Not a sign-in method. The endpoint itself accepts a bearer token, so the shells use the same path as the web app.",
  },
  "profile-pictures": {
    id: "profile-pictures",
    label: "Profile pictures",
    summary:
      "Squared and shrunk in the browser, validated by magic number and size on the server, served from an unguessable unauthenticated address.",
    needsEmail: false,
    tokenShell: "n/a",
    tokenShellNote:
      "Not a sign-in method. The bytes are deliberately readable without a credential — an `<img>` sends neither a bearer token nor, cross-origin, a cookie.",
  },
  "email-otp": {
    id: "email-otp",
    label: "Email one-time code sign-in",
    summary:
      "A short code mailed to the address, exchanged for a session. Dead without a mail transport, and self-disables when there is none.",
    needsEmail: true,
    tokenShell: "yes",
    tokenShellNote:
      "`/email-otp/send-verification-otp` sets no cookie — the code lives in the verification table — and `/sign-in/email-otp` takes `{ email, otp }` in the request BODY, creates the session and sets the cookie inside the handler. `bearer`'s after-hook therefore sees a live session cookie and emits `set-auth-token`. Request body in, token out: a stored-token shell can complete this unaided, which is what makes it the method to offer on native.",
  },
  "magic-link": {
    id: "magic-link",
    label: "Magic-link sign-in",
    summary:
      "A mailed link that signs the recipient in. Dead without a mail transport, and self-disables when there is none.",
    needsEmail: true,
    tokenShell: "partial",
    tokenShellNote:
      "The endpoint cooperates: `/magic-link/verify` sets the session cookie and, when the request carries NO `callbackURL`, answers with JSON instead of a redirect — so a token client that calls it directly gets `set-auth-token` from `bearer`. What does not cooperate is the delivery channel. The link is opened by the recipient's mail client in the system browser, which is not the shell, so the shell never sees that response. Usable on native only if the shell registers a deep link for the callback, captures the token and calls `/magic-link/verify` itself.",
  },
  passkeys: {
    id: "passkeys",
    label: "Passkeys (WebAuthn)",
    summary:
      "Platform authenticators as an additional method. Adds a dependency: WebAuthn is not part of better-auth core.",
    needsEmail: false,
    tokenShell: "no",
    tokenShellNote:
      "WebAuthn binds a credential to an RP ID, which must be a registered domain reached over a secure context. A shell origin (`capacitor://localhost`, `file://`, Electron's `app://-`) is not a domain and cannot be an RP ID, so a credential registered on the web origin is unusable from the shell and one cannot be registered from the shell at all. Web browsers only.",
    clientDeps: [PASSKEY_PACKAGE],
    serverDeps: [PASSKEY_PACKAGE],
  },
};

/** Look a spec up, throwing on an id that is not in the catalogue —
 *  which can only be a typo, since the union is closed. */
export function specFor(option: AuthSecurityOption): AuthSecurityOptionSpec {
  const spec = AUTH_SECURITY_SPECS[option];
  if (!spec) throw new Error(`Unknown account-security option: ${option}`);
  return spec;
}

/** The options that are sign-in methods, i.e. the ones whose token-shell
 *  verdict is a real answer rather than "the question does not arise". */
export function signInMethods(options: readonly AuthSecurityOption[]): AuthSecurityOptionSpec[] {
  return options.map(specFor).filter((spec) => spec.tokenShell !== "n/a");
}

/** Options selected here that cannot work without a mail transport.
 *  Used for the pre-write warning — never to refuse a selection: a
 *  project commonly picks these BEFORE provisioning mail, and the
 *  generated code decides at runtime, not at build time. */
export function optionsNeedingEmail(
  options: readonly AuthSecurityOption[],
): AuthSecurityOptionSpec[] {
  return options.map(specFor).filter((spec) => spec.needsEmail);
}
