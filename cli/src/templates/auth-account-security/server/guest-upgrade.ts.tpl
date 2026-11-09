/**
 * Move a guest's data to the account the guest just became.
 *
 * Called from `onLinkAccount` (auth/guest-accounts.ts) before better-auth
 * deletes the guest. Add one line per collection that is keyed by a user id;
 * anything not moved here is deleted with the guest.
 *
 * The starter's own per-user rows are `items`. A profile is NOT moved: the
 * account the guest signs in to may already have one, and two profiles for one
 * user is worse than the guest's theme choice being lost.
 */

__HATCHKIT_GUEST_MOVE_IMPORTS__

export async function moveGuestData(fromUserId: string, toUserId: string): Promise<void> {
  if (fromUserId === toUserId) return;
__HATCHKIT_GUEST_MOVE_BODY__
}
