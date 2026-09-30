/**
 * Sign-in methods and the account controls built on them — the pieces
 * `auth/auth.ts` registers, kept here so an integration test can run exactly
 * this configuration against the real library instead of a copy of it.
 *
 * Nothing in this file reads `config/env.ts`. Every environment-dependent
 * answer is passed in, which is what lets a test build a better-auth instance
 * with no server environment at all.
 *
 * Four things here fail quietly if they are changed:
 *
 * - **`twoFactorPlugin()` must be registered BEFORE `bearer()`** (and before
 *   nothing else matters, but bearer must come after every plugin that can
 *   replace the session). better-auth runs plugin `after` hooks in
 *   registration order. Password sign-in creates a real session first; the
 *   two-factor hook then deletes it, expires its cookie and answers
 *   `{ twoFactorRedirect: true }`. bearer's after-hook emits `set-auth-token`
 *   for whatever session cookie the response carries, skipping only a cookie
 *   with `max-age=0`. Registered first it would therefore hand a token client
 *   a credential for a session that is deleted a moment later, and every
 *   subsequent request would answer 401 while the client believed it was
 *   signed in. In the right order bearer sees the expired cookie and emits
 *   nothing, so the client gets an error it can act on.
 *
 * - **The two-factor challenge is a signed cookie** (`better-auth.two_factor`)
 *   and `/two-factor/verify-*` reads nothing else. The sign-in body is
 *   `{ twoFactorRedirect, twoFactorMethods }` with no challenge token in it. A
 *   browser carries the cookie for free; a WebView or an extension `fetch` can
 *   neither read `set-cookie` nor send `Cookie`, so those clients cannot
 *   complete the challenge with this configuration. Carrying the challenge in
 *   a header is the follow-up for native clients, not a switch here.
 *
 * - **Email verification is required only when mail can actually be
 *   delivered.** A self-host with no transport would otherwise lock every new
 *   account out behind a link that only ever reaches the server log.
 *
 * - **No auto sign-in after verification.** A verification link is not a
 *   second factor; signing in from it would hand a session to whoever opened
 *   the mail.
 */

import { createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import { twoFactor } from "better-auth/plugins/two-factor";

/** The account label an authenticator app shows next to the code. */
export const TWO_FACTOR_ISSUER = "__HATCHKIT_PROJECT_NAME__";

/**
 * What the login and signup pages are allowed to know before anyone has
 * signed in: whether the Google button can work, and whether a new account
 * will have to confirm its address.
 *
 * Two booleans and no configuration values. This is served publicly from
 * `health.check`, so anything added here is public too.
 */
export type AuthConfig = {
  googleEnabled: boolean;
  emailVerificationRequired: boolean;
};

export function resolveAuthConfig(source: {
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  emailDeliveryConfigured: boolean;
}): AuthConfig {
  return {
    googleEnabled: Boolean(source.googleClientId && source.googleClientSecret),
    emailVerificationRequired: source.emailDeliveryConfigured,
  };
}

/**
 * TOTP plus backup codes.
 *
 * - Backup codes are stored encrypted, which is the library default: ten
 *   codes, formatted `XXXXX-XXXXX`, JSON-encoded and symmetrically encrypted.
 *   The key is derived from `BETTER_AUTH_SECRET`, so **rotating that secret
 *   invalidates every stored TOTP secret and every backup code**. Plan a
 *   rotation as an event that signs everybody's second factor out, not as a
 *   routine key change.
 * - Enabling does not switch two-factor on. `/two-factor/enable` stores the
 *   secret and returns the URI and the backup codes; `twoFactorEnabled`
 *   becomes true only once a code from the authenticator verifies. A QR that
 *   was never scanned therefore cannot lock anyone out.
 * - One-time codes by email are deliberately not offered here (`otpOptions`
 *   is unset): the mailbox is where a password reset already goes, so it is
 *   no second factor. Email codes as a primary sign-in method are a separate
 *   choice — see `emailOtpPlugin` below.
 */
export function twoFactorPlugin(): ReturnType<typeof twoFactor> {
  return twoFactor({ issuer: TWO_FACTOR_ISSUER });
}

/** A message this module hands to the transport. Deliberately plain: the
 *  templating, branding and localisation belong to the app, not here. */
export type AuthMail = { to: string; subject: string; text: string; html: string };

/**
 * How a URL reaches a person.
 *
 * The caller decides what "no transport" means — this module never reads the
 * environment. Every caller in `auth.ts` follows the same shape: log the URL
 * when nothing is configured, and log it AND rethrow when a configured
 * transport fails.
 */
export type AuthMailSender = (url: string, mail: AuthMail) => Promise<void>;

/** Log bearer links only in development or with deliberate owner opt-in.
 * Production operators should prefer mail or their local admin recovery tool.
 */
export function logAuthUrl(label: string, recipient: string, url: string): void {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test" && process.env.AUTH_LOG_LINKS !== "true") {
    throw new Error("Auth email unavailable; configure mail or explicitly enable AUTH_LOG_LINKS for owner recovery");
  }
  console.log(`[auth] ${label} URL for ${recipient}: ${url}`);
}

export function verificationEmailBody(url: string): Omit<AuthMail, "to"> {
  return {
    subject: "Confirm your email address",
    text: `Confirm your email address by opening this link:\n\n${url}\n`,
    html: `<p>Confirm your email address by opening this link:</p><p><a href="${url}">${url}</a></p>`,
  };
}

export function passwordResetEmailBody(url: string): Omit<AuthMail, "to"> {
  return {
    subject: "Reset your password",
    text: `Reset your password by opening this link:\n\n${url}\n`,
    html: `<p>Reset your password by opening this link:</p><p><a href="${url}">${url}</a></p>`,
  };
}

export function signInOtpEmailBody(otp: string): Omit<AuthMail, "to"> {
  return {
    subject: `Your sign-in code: ${otp}`,
    text: `Your sign-in code is ${otp}. It expires shortly and can be used once.\n`,
    html: `<p>Your sign-in code is <strong>${otp}</strong>.</p><p>It expires shortly and can be used once.</p>`,
  };
}

export function magicLinkEmailBody(url: string): Omit<AuthMail, "to"> {
  return {
    subject: "Your sign-in link",
    text: `Sign in by opening this link:\n\n${url}\n\nIt expires shortly and can be used once.\n`,
    html: `<p>Sign in by opening this link:</p><p><a href="${url}">${url}</a></p><p>It expires shortly and can be used once.</p>`,
  };
}

/**
 * The `emailVerification` block.
 *
 * **better-auth reads `sendVerificationEmail` from THIS block only.** Placed
 * under `emailAndPassword` it is never called, nothing logs that it was
 * skipped, and the symptom is silence: accounts are created, no mail is sent,
 * and sign-in refuses them for being unverified.
 *
 * The same callback also carries change-email links. better-auth mails the NEW
 * address and switches the account over only when that link is followed, so a
 * typo cannot move an account to an address nobody reads.
 *
 * `sendOnSignIn` stays off so that the login page can request the link itself
 * and point it at the WEB origin. Passing a `callbackURL` on the sign-in body
 * would do the same thing, except that better-auth's client then follows it as
 * a redirect and the page never navigates.
 */
export function emailVerificationOptions(send: AuthMailSender, sendOnSignUp = true): {
  sendOnSignUp: boolean;
  sendOnSignIn: boolean;
  autoSignInAfterVerification: boolean;
  sendVerificationEmail: (data: {
    user: { id?: string; email: string };
    url: string;
  }) => Promise<void>;
} {
  return {
    sendOnSignUp,
    sendOnSignIn: false,
    autoSignInAfterVerification: false,
    async sendVerificationEmail({ user, url }) {
      await send(url, { to: user.email, ...verificationEmailBody(url) });
    },
  };
}

/**
 * Sign in with a code mailed to the address.
 *
 * The one method here a stored-token client can complete unaided:
 * `/email-otp/send-verification-otp` sets no cookie — the code lives in the
 * verification table — and `/sign-in/email-otp` takes `{ email, otp }` in the
 * request body, creates the session and sets the cookie inside the handler, so
 * `bearer`'s after-hook sees a live session and emits `set-auth-token`.
 *
 * `disableSignUp` is on: a code mailed to an address nobody has registered
 * would otherwise create an account, which turns a sign-in form into an
 * unauthenticated account-creation endpoint.
 */
export function emailOtpPlugin(send: AuthMailSender): ReturnType<typeof emailOTP> {
  return emailOTP({
    disableSignUp: true,
    async sendVerificationOTP({ email, otp }: { email: string; otp: string }) {
      // No URL to fall back on, so the code itself goes to the log when
      // there is no transport. Same contract as every other sender here.
      await send(otp, { to: email, ...signInOtpEmailBody(otp) });
    },
  });
}

/**
 * Sign in by following a mailed link.
 *
 * `disableSignUp` is on for the same reason as the OTP plugin: a link is
 * proof of reading a mailbox, not of being entitled to an account here.
 *
 * Note for native shells: `/magic-link/verify` does set the session cookie and
 * answers with JSON rather than a redirect when the request carries no
 * `callbackURL`, so the endpoint itself is usable by a token client. The link,
 * though, is opened by the recipient's mail client in the system browser,
 * which is not the shell — so a shell can only finish this flow if it
 * registers a deep link for the callback and calls verify itself.
 */
export function magicLinkPlugin(send: AuthMailSender): ReturnType<typeof magicLink> {
  return magicLink({
    disableSignUp: true,
    async sendMagicLink({ email, url }: { email: string; url: string }) {
      await send(url, { to: email, ...magicLinkEmailBody(url) });
    },
  });
}

/**
 * Paths whose response means "some session other than this request's is now
 * gone". Anything that watches sockets can use this to close them at once.
 */
export const SESSION_REVOKING_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

/**
 * Close revoked devices' sockets as soon as the revoking request returns,
 * rather than on the next periodic re-check.
 *
 * Best effort by design: whatever re-checks sessions on an interval is the
 * guarantee, and this only makes "sign out other devices" land immediately.
 */
export const sweepSocketsAfterRevocation = (
  sweep: () => void,
): ReturnType<typeof createAuthMiddleware> =>
  createAuthMiddleware(async (ctx) => {
    if (SESSION_REVOKING_PATHS.has(ctx.path)) sweep();
  });
