/**
 * Run the cascade.
 *
 * The contract the callers rely on: **calling this twice is the recovery
 * strategy.** Every step is a delete by filter, so a step that already ran
 * matches nothing; there is no progress marker, no resume point, and nothing
 * that can be left half-applied. A run that throws part-way leaves a state the
 * next run finishes from.
 *
 * That is why `beforeDelete` in `auth/account-deletion.ts` can let a failure
 * propagate — better-auth stops before removing the user row, so the person
 * simply tries again — and why `afterDelete` runs the whole thing a second
 * time without any bookkeeping.
 */

import { type DeletedUser, type DeletionCollection, type DeletionFilterValue, type DeletionStep, userScopedSteps } from "./plan.js";

export interface DeletionRowStore {
  find(
    collection: DeletionCollection,
    filter: Record<string, DeletionFilterValue>,
  ): Promise<Array<Record<string, unknown>>>;
  deleteMany(
    collection: DeletionCollection,
    filter: Record<string, DeletionFilterValue>,
  ): Promise<void>;
}

export type AccountDeletionReport = {
  /** Steps executed. Diagnostic only — a second pass legitimately reports
   *  the same number while deleting nothing. */
  steps: number;
  collections: DeletionCollection[];
};

export async function deleteAccountData(
  store: DeletionRowStore,
  user: DeletedUser,
): Promise<AccountDeletionReport> {
  const steps: DeletionStep[] = userScopedSteps(user);
  // Sequential on purpose. The steps are ordered so that anything used to
  // locate other rows goes last, and running them concurrently would throw
  // that ordering away for a saving measured in milliseconds on a request
  // that happens once per account.
  for (const step of steps) {
    await store.deleteMany(step.collection, step.filter);
  }
  return { steps: steps.length, collections: steps.map((step) => step.collection) };
}
