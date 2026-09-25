/**
 * The one account-deletion refusal both sides need to agree on.
 *
 * Shared because the settings dialog branches on it: it is the refusal that
 * means "ask for the password and try again", as distinct from better-auth's
 * own `INVALID_PASSWORD` ("that password is wrong") and `SESSION_EXPIRED`
 * ("an account with no password must sign in again first"). A client that
 * cannot tell those apart either asks for a password it does not need or
 * fails with nowhere to type the one it does.
 */
export const ACCOUNT_DELETION_PASSWORD_REQUIRED = "PASSWORD_REQUIRED";
