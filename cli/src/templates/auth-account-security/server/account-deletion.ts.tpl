/**
 * "Delete my account" — better-auth's own `POST /api/auth/delete-user`, with
 * this app's data hung off it and one of its policies tightened.
 *
 * better-auth already does the parts that are easy to get subtly wrong: it
 * resolves the session with the cookie cache disabled (a revoked session
 * cannot delete anything), it accepts a bearer token like every other endpoint
 * so the native shells use the same path, it verifies a password when one is
 * sent, and it removes the user, accounts and every session afterwards.
 *
 * The policy it gets too loose: with NO password in the body it deletes on a
 * merely *fresh* session — one created in the last 24 hours. A browser session
 * here lasts far longer than that, so "fresh" degrades to "signed in this
 * morning", and a laptop left open is one click away from losing everything.
 *
 * So an account that HAS a password must send it. An account without one
 * (social sign-in only) has nothing to type and keeps better-auth's
 * fresh-session rule: sign in again, then delete.
 */

import { APIError, createAuthMiddleware } from "better-auth/api";
import { ACCOUNT_DELETION_PASSWORD_REQUIRED } from "__HATCHKIT_SHARED_SCOPE__/shared";
import {
  type AuthAdapterLike,
  type DeletedUser,
  authRowStore,
  deleteAccountData,
  mongooseRowStore,
  routedRowStore,
} from "../services/account-deletion/index.js";

type AccountRow = { providerId?: string; password?: string | null };

export type DeletionAuthContext = {
  adapter: AuthAdapterLike;
  internalAdapter: { findAccounts(userId: string): Promise<AccountRow[]> };
};

/**
 * Did this request carry a password?
 *
 * Keyed on the `Request` object because that is the one thing better-auth
 * hands to BOTH ends of this: the before-hook sees the body but not the
 * account, and `beforeDelete` sees the request but not the body.
 *
 * The hook cannot simply look the account up itself — user-level hooks run
 * BEFORE the bearer plugin turns an `Authorization` header into a session
 * cookie, so from there a token client's request has no session at all and the
 * check would refuse every phone.
 *
 * A WeakMap rather than a cache, so a request that never reaches
 * `beforeDelete` — wrong password, stale session — leaves nothing behind.
 *
 * By the time `beforeDelete` reads this, "sent" and "correct" are the same
 * thing: better-auth verifies the password before it runs, and refuses the
 * request outright when it is wrong.
 */
const passwordSent = new WeakMap<Request, boolean>();

export const recordDeletionPassword = createAuthMiddleware(async (ctx) => {
  // The `!ctx.request` guard doubles as the escape hatch for server-side
  // `auth.api.*` calls, which carry no request and are trusted by definition.
  if (ctx.path !== "/delete-user" || !ctx.request) return;
  const password = (ctx.body as { password?: unknown } | undefined)?.password;
  passwordSent.set(ctx.request, typeof password === "string" && password.length > 0);
});

export const hasPasswordAccount = (accounts: readonly AccountRow[]): boolean =>
  accounts.some(
    (account) =>
      account.providerId === "credential" &&
      typeof account.password === "string" &&
      account.password.length > 0,
  );

export function accountDeletionOptions(deps: {
  context: () => Promise<DeletionAuthContext>;
  onDeleted?: (user: DeletedUser) => void;
  log?: (message: string, error: unknown) => void;
}): {
  enabled: true;
  beforeDelete: (user: DeletedUser, request?: Request) => Promise<void>;
  afterDelete: (user: DeletedUser, request?: Request) => Promise<void>;
} {
  const cascade = async (user: DeletedUser): Promise<void> => {
    const context = await deps.context();
    await deleteAccountData(
      routedRowStore(mongooseRowStore, authRowStore(context.adapter)),
      user,
    );
  };
  const log = deps.log ?? ((message: string, error: unknown) => console.error(message, error));

  return {
    enabled: true,

    /**
     * Refuse a password account that did not send its password, then delete
     * the data. If the data deletion throws, better-auth stops here and the
     * user row survives — so the person simply tries again, and the cascade
     * is idempotent precisely so that this is safe. The user row is removed
     * only after everything it owned.
     */
    async beforeDelete(user, request) {
      const context = await deps.context();
      const accounts = await context.internalAdapter.findAccounts(user.id);
      if (hasPasswordAccount(accounts) && !(request && passwordSent.get(request))) {
        throw new APIError("BAD_REQUEST", {
          code: ACCOUNT_DELETION_PASSWORD_REQUIRED,
          message: "Enter your password to delete your account.",
        });
      }
      await cascade(user);
    },

    /**
     * Run the cascade a second time.
     *
     * A request from another of this person's devices can land between the
     * two passes and recreate a row that the first pass had just removed —
     * a profile created on demand is the usual way. The second pass is what
     * stops that outliving the account.
     *
     * Its failure is logged, never thrown: the account is already gone by
     * now, and an error response would tell the person it was not.
     */
    async afterDelete(user) {
      try {
        await cascade(user);
      } catch (error) {
        log("[auth] account deletion: second cascade pass failed", error);
      }
      deps.onDeleted?.(user);
    },
  };
}
