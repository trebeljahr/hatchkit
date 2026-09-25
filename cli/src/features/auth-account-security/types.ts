/*
 * cli/src/features/auth-account-security/types.ts — shared vocabulary for
 * the `auth-account-security` feature.
 *
 * The feature adds sign-in methods and account controls to the starter's
 * better-auth instance, which registers no plugins of its own. Everything
 * here is additive: `hatchkit create` applies it at scaffold time and
 * `hatchkit update` layers it onto an already-scaffolded project, both
 * through the same `applyAuthAccountSecurity`.
 */

/** One selectable capability. The ids are stable — they are persisted
 *  into `.hatchkit.json` under `authSecurity.options`, so renaming one is
 *  a manifest migration, not a refactor. */
export type AuthSecurityOption =
  /** better-auth `twoFactor`: TOTP enrolment plus single-use backup codes,
   *  stored encrypted at rest. */
  | "two-factor"
  /** Require a verified email before sign-in — but only when a mail
   *  transport is actually configured. */
  | "email-verification"
  /** Change password and change email from Settings, without signing the
   *  calling device out. */
  | "credentials"
  /** Google OAuth button that ships in every build and decides after
   *  mount whether it can work. */
  | "google-oauth"
  /** Password-confirmed account deletion with an idempotent cascade. */
  | "account-deletion"
  /** Avatar upload: squared client-side, validated server-side, served
   *  from an unguessable unauthenticated address. */
  | "profile-pictures"
  /** better-auth `emailOTP`: sign in with a one-time code mailed to the
   *  address. Net-new — not in the reference implementation. */
  | "email-otp"
  /** better-auth `magicLink`: sign in by following a mailed link.
   *  Net-new — not in the reference implementation. */
  | "magic-link"
  /** better-auth `passkey`: WebAuthn as an additional method.
   *  Net-new — not in the reference implementation. */
  | "passkeys";

/** Every option, in the order they are offered and applied. Also the
 *  order the generated docs list them in. */
export const AUTH_SECURITY_OPTIONS: readonly AuthSecurityOption[] = [
  "two-factor",
  "email-verification",
  "credentials",
  "google-oauth",
  "account-deletion",
  "profile-pictures",
  "email-otp",
  "magic-link",
  "passkeys",
] as const;

/** Pre-ticked in the interactive multiselect, and the set a
 *  non-interactive `--auth-security` with no explicit list gets.
 *
 *  The three net-new sign-in methods are deliberately OFF: each one adds
 *  a way into the account, and a template should not widen the attack
 *  surface of every project scaffolded from it by default. */
export const AUTH_SECURITY_DEFAULT_OPTIONS: readonly AuthSecurityOption[] = [
  "two-factor",
  "email-verification",
  "credentials",
  "google-oauth",
  "account-deletion",
  "profile-pictures",
] as const;

/** Whether a client that can only hold a bearer token — a WKWebView or
 *  Capacitor shell, an Electron renderer on a custom protocol, a browser
 *  extension's `fetch` — can complete a sign-in method end to end.
 *
 *  Such a client can neither read `set-cookie` nor send `Cookie`, so any
 *  step whose state lives in a cookie is unreachable for it. This is not
 *  a detail: shipping a method a native shell silently cannot finish
 *  produces a sign-in screen that hangs with no error. Every method
 *  carries its answer, and `hatchkit` prints it into the generated docs.
 *
 *  - `yes`      — request body in, session out. Works on a token client.
 *  - `partial`  — the endpoint would work, but the flow reaches the user
 *                 through a channel the shell does not control (a mailed
 *                 link opens in the system browser). Needs extra shell
 *                 plumbing, and the docs say which.
 *  - `no`       — some step is cookie-only, or the origin cannot be an
 *                 RP ID. Web browsers only.
 *  - `n/a`      — not a sign-in method, so the question does not arise. */
export type TokenShellSupport = "yes" | "partial" | "no" | "n/a";

export interface AuthSecurityOptionSpec {
  id: AuthSecurityOption;
  /** Short label for the multiselect. */
  label: string;
  /** One line under the label, and the docs table's description cell. */
  summary: string;
  /** True when the capability is dead without a mail transport. Such an
   *  option still gets scaffolded — the code self-disables at runtime —
   *  but the CLI warns at selection time. */
  needsEmail: boolean;
  /** Can a stored-token shell complete this? See {@link TokenShellSupport}. */
  tokenShell: TokenShellSupport;
  /** The sentence the docs print next to the verdict. Required for every
   *  sign-in method: "we did not check" is not an acceptable answer to
   *  ship. */
  tokenShellNote: string;
  /** npm packages this option pulls into the generated project, beyond
   *  what the starter already has. Empty for options served by
   *  better-auth core. */
  clientDeps?: readonly string[];
  serverDeps?: readonly string[];
}

/** What a run decided to do, before anything is written. Pure data, so
 *  the planner is testable without touching a filesystem. */
export interface AuthSecurityPlan {
  options: AuthSecurityOption[];
  /** Server-side better-auth plugin registrations, in the order they
   *  must appear in the generated `auth.ts`. See
   *  `assertPluginOrder` — `bearer` is always last. */
  serverPlugins: string[];
  /** Client-side plugin registrations, same order. */
  clientPlugins: string[];
  /** Relative paths (POSIX) this plan writes into the project. */
  files: string[];
  /** Env vars the project gains, with the comment written above each. */
  envVars: Array<{ key: string; comment: string }>;
  /** `package.json` additions, by workspace package directory. */
  deps: Array<{ pkgDir: string; name: string; dev: boolean }>;
  /** Human-readable warnings surfaced before the write (e.g. an option
   *  that needs mail on a project with no transport). */
  warnings: string[];
}

export interface AuthSecurityAudit {
  ok: boolean;
  options: AuthSecurityOption[];
  /** Files actually created (absent before the run). */
  written: string[];
  /** Files left alone because they already existed — re-runs are
   *  no-ops, never clobbers. */
  skipped: string[];
  /** Files patched in place (auth.ts, auth-client.ts, login page, …). */
  rewritten: string[];
  warnings: string[];
  /** Steps the user must finish by hand (OAuth console, running the
   *  backfill script, …). */
  manualResidue: string[];
}

export interface ApplyAuthSecurityOptions {
  /** Root of the deployable package (the dir holding `packages/`). */
  projectDir: string;
  options: readonly AuthSecurityOption[];
  /** True when the project has any native shell (`desktop`,
   *  `mobile`). Decides whether `bearer` is registered
   *  and whether the shells' "this method needs the web app" notices are
   *  emitted. */
  hasNativeClient: boolean;
  /** True when the project's recorded email intent names a real
   *  transport. Only affects warnings and generated docs — the
   *  scaffolded code decides at runtime, never at build time. */
  hasEmailTransport: boolean;
  /** Public origin of the deployed app, used for the docs' example URLs. */
  domain?: string;
}
