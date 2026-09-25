/**
 * The account-deletion cascade, in three parts: `plan.ts` says what is
 * removed, `stores.ts` says where those rows live, `delete-account.ts` runs
 * the list. This barrel is what `auth/account-deletion.ts` imports so that the
 * split stays an implementation detail.
 */

export {
  APP_COLLECTIONS,
  AUTH_COLLECTIONS,
  isAuthCollection,
  userScopedSteps,
  type AppCollection,
  type AuthCollection,
  type DeletedUser,
  type DeletionCollection,
  type DeletionFilterValue,
  type DeletionStep,
} from "./plan.js";

export {
  deleteAccountData,
  type AccountDeletionReport,
  type DeletionRowStore,
} from "./delete-account.js";

export {
  authRowStore,
  mongooseRowStore,
  routedRowStore,
  type AuthAdapterLike,
} from "./stores.js";
