/**
 * Sign in with a username and password, beside the email address.
 *
 * better-auth's `username` plugin: `/sign-in/username` takes `{ username,
 * password }` in the request body and creates the session inside the handler,
 * so a native shell holding a bearer token can complete it — unless the
 * account has two-factor, whose second step is a cookie (see
 * docs/account-security.md).
 *
 * Usernames are stored lower-cased for lookup, with the typed form kept as
 * `displayUsername`. An account gets one from Settings → Sign-in methods, or
 * from a sign-up form that sends `username`.
 */

import { username } from "better-auth/plugins/username";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

export function usernamePlugin(): ReturnType<typeof username> {
  return username({
    minUsernameLength: USERNAME_MIN_LENGTH,
    maxUsernameLength: USERNAME_MAX_LENGTH,
  });
}
