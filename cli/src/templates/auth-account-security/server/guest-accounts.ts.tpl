/**
 * Guest accounts that become real accounts and keep their data.
 *
 * better-auth's `anonymous` plugin: `/sign-in/anonymous` creates a user with
 * `isAnonymous: true` and a session, with no address and no password. When
 * that guest later signs up or signs in by any method, better-auth calls
 * `onLinkAccount` with both users and then deletes the guest. Everything the
 * guest made must move in that call, or it is deleted with them.
 *
 * Rules that fail quietly if they are changed:
 *
 * - **`moveGuestData` must cover every collection keyed by user id.** A new
 *   model that stores a guest's work and is not moved here loses that work on
 *   the upgrade, with nothing logged. See `services/guest-upgrade.ts`.
 * - **Placeholder addresses are under `guest.invalid`**, a domain that can
 *   never receive mail, so no message is ever sent to a guest by mistake.
 * - **Steam sign-in is not one of better-auth's sign-in paths**, so the guest
 *   plugin's own hook does not see it. `steam-sign-in.ts` calls this
 *   `onLinkAccount` itself.
 */

import { anonymous } from "better-auth/plugins/anonymous";
import { moveGuestData } from "../services/guest-upgrade.js";

export const GUEST_EMAIL_DOMAIN = "guest.invalid";

export function guestAccountsPlugin(): ReturnType<typeof anonymous> {
  return anonymous({
    emailDomainName: GUEST_EMAIL_DOMAIN,
    onLinkAccount: async ({ anonymousUser, newUser }) => {
      await moveGuestData(anonymousUser.user.id, newUser.user.id);
    },
  });
}
