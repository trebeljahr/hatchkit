/**
 * What "delete my account" removes, expressed as data rather than as calls.
 *
 * Every step is a `{ collection, filter }` pair, for two reasons.
 *
 * The filter is where the ownership rule lives, and having them all in one
 * readable list is what makes it possible to answer "does this delete
 * somebody else's row?" by reading rather than by tracing.
 *
 * And a list of deletes-by-filter is **idempotent by construction**: a step
 * that already ran matches nothing the second time. That is what makes a
 * half-finished deletion safe to simply run again, which is the whole
 * recovery story — there is no progress marker to get out of sync, and no
 * resume point to compute.
 *
 * The user, account and session rows are deliberately NOT here. better-auth's
 * own `deleteUser` removes those, after this cascade has finished.
 *
 * ## Adding your app's rows
 *
 * Add the collection to `APP_COLLECTIONS`, register its model in
 * `stores.ts`, and add a step to `userScopedSteps`. Two rules:
 * order rows so that anything used to FIND other rows is deleted last, and
 * never write a filter that could match a row this user does not own — the
 * store refuses an empty filter for exactly that reason, but it cannot check
 * a filter that is merely wrong.
 */

/** App collections, owned by mongoose models. Rendered from the feature
 *  selection: a project without profile pictures has no `avatars` model, and
 *  naming a collection here that has no model behind it would fail at import
 *  rather than at the one call that needed it. */
export const APP_COLLECTIONS = [__HATCHKIT_DELETION_APP_COLLECTIONS__] as const;

/** better-auth's own tables, reached through its adapter rather than through
 *  mongoose — the adapter is what knows which fields it stored as ObjectIds.
 *  Rendered from the selection too: a plugin's table (two-factor, passkeys)
 *  exists only while the plugin is registered, and the adapter throws for a
 *  model it does not know, which would fail every deletion. */
export const AUTH_COLLECTIONS = [__HATCHKIT_DELETION_AUTH_COLLECTIONS__] as const;

export type AppCollection = (typeof APP_COLLECTIONS)[number];
export type AuthCollection = (typeof AUTH_COLLECTIONS)[number];
export type DeletionCollection = AppCollection | AuthCollection;

export const isAuthCollection = (collection: DeletionCollection): collection is AuthCollection =>
  (AUTH_COLLECTIONS as readonly string[]).includes(collection);

export type DeletionFilterValue = string | null | { $in: string[] };
export type DeletionStep = {
  collection: DeletionCollection;
  filter: Record<string, DeletionFilterValue>;
};

export type DeletedUser = { id: string; email?: string | null };

/**
 * Everything this person owns, wherever they own it.
 *
 * The auth-table steps are easy to leave out and impossible to notice
 * missing. better-auth's `deleteUser` removes only user, account and session
 * rows, and MongoDB has no foreign-key cascade, so every other table that
 * holds this person's rows needs its own step:
 *
 * - `authTwoFactors` (with two-factor) holds the TOTP secret and the backup
 *   codes; without this step the second factor of a deleted account stays in
 *   the database.
 * - `authPasskeys` (with passkeys) holds the public keys of this person's
 *   passkeys, with the device names they gave them.
 * - `authVerifications` holds pending verification and change-email tokens
 *   addressed to this mailbox. A token left behind would still be redeemable
 *   after the account it referred to had gone.
 */
export function userScopedSteps(user: DeletedUser): DeletionStep[] {
  const steps: DeletionStep[] = [
__HATCHKIT_DELETION_USER_STEPS__
  ];

  const email = (user.email ?? "").trim().toLowerCase();
  if (email) {
    steps.push({ collection: "authVerifications", filter: { identifier: email } });
  }

  return steps;
}
