"use client";

import { QueryClient, onlineManager } from "@tanstack/react-query";

import { isOnline, subscribeNetwork } from "@starter/core";

/**
 * React Query, wired to the same network verdict as the rest of the app.
 *
 * Two decisions live here, and each one has a wrong answer that looks fine until
 * the network goes away. One is which verdict `onlineManager` is fed
 * ({@link bindOnlineManager}); the other is which mutations are allowed to run
 * while that verdict says offline ({@link OFFLINE_QUEUED_MUTATION}).
 */

/**
 * The tab's one QueryClient, kept so sign-out can empty it.
 *
 * Sign-out does not reload the page, so without this the next account to sign in
 * in the same tab is shown the previous one's cached answers until every query
 * happens to refetch.
 */
let appQueryClient: QueryClient | null = null;

export const createAppQueryClient = (): QueryClient => {
  appQueryClient = new QueryClient();
  return appQueryClient;
};

/** Drop every cached answer. Called on sign-out and account deletion. */
export const clearAppQueryCache = async (): Promise<void> => {
  const client = appQueryClient;
  if (client === null) return;
  await client.cancelQueries();
  client.clear();
};

/**
 * The mutation options for a write the offline queue owns.
 *
 * React Query's default is to *pause* a mutation while `onlineManager` says
 * offline: `mutationFn` never runs, `onError` never fires, and `onError` is where
 * the offline queue is filled. Paused means the promise sits there and nothing is
 * ever queued — with the radio's real answer wired in, the default would make the
 * queued mutations do nothing at all in airplane mode. The offline queue *is* this
 * app's pause mechanism for these writes, and it needs the failure to happen to
 * do its job.
 *
 * **Applied per mutation, deliberately not as a `defaultOptions.mutations`.** That
 * is the half this gets wrong when someone tidies it up. Global, it quietly takes
 * React Query's pause-and-resume away from every *other* mutation in the app — on
 * the web as much as on a phone. None of those queue anything: without pausing
 * they roll back and report a network error the instant the connection blips,
 * where pausing would have replayed them on reconnect with the optimistic state
 * intact. Queries keep the default too, where pausing is exactly right.
 *
 * So it is spread into the mutations the offline queue owns, and into the queue's
 * own replay — which must reject rather than hang if the radio dies mid-flush,
 * because a paused replay leaves `flush()` awaiting a promise that never settles
 * and the queue latched as "flushing" for the rest of the launch. Nowhere else.
 * Adding another is a decision to argue about, not a default to inherit.
 */
export const OFFLINE_QUEUED_MUTATION = { networkMode: "always" } as const;

let bound = false;

/**
 * Hand React Query the same network verdict everything else in the app uses.
 *
 * Idempotent: `setEventListener` replaces whatever was registered before, so
 * calling this twice would drop React Query's reference to the first
 * registration while leaving its subscription to the network alive — a listener
 * nothing can ever remove.
 */
export const bindOnlineManager = (): void => {
  if (bound) return;
  bound = true;

  onlineManager.setEventListener((setOnline) => {
    setOnline(isOnline());
    return subscribeNetwork(() => setOnline(isOnline()));
  });
};
