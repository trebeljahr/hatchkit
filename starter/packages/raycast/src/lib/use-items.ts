/**
 * The freshness ladder, in one hook every surface shares.
 *
 * ============================================================
 * FOUR MECHANISMS, CHEAPEST AND FASTEST FIRST
 * ============================================================
 *
 * 1. **The local echo, re-read once a second.** A local read, no network — so
 *    it is the only rung that works offline, and it is the only one that can
 *    close the gap between two Raycast processes. The capture command confirms
 *    a write; the menu bar command, which is a different process with no shared
 *    memory, sees it within a second.
 * 2. **The push socket, while this command is alive.** Held by `useSyncFeed`.
 * 3. **A narrow poll every 4 seconds, ONLY while the socket is disconnected.**
 *    Polling underneath a connected socket asks a question that has already
 *    been answered, and it costs a request every four seconds for nothing.
 * 4. **The whole snapshot every 20 seconds.** The backstop, for everything the
 *    other three can miss.
 *
 * Raycast's own `refreshMenuBar()` is a NUDGE on top of these, never one of
 * them: Raycast may decline a background refresh, and it does not remount a
 * menu bar command that is still loaded — so a refresh call alone leaves the
 * surface showing state the person changed a second ago from another command.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Item } from "../vendor";
import { type ItemsRead, flushQueue, readItems } from "./api";
import { type SessionState, readSessionState } from "./auth";
import { refreshCapabilities } from "./capabilities";
import { apiOrigin } from "./preferences";
import { offlineQueue } from "./queue";
import { type StateEcho, echoOutranks, readStateEcho } from "./storage";
import { useSyncFeed } from "./sync";

const ECHO_INTERVAL_MS = 1_000;
const DISCONNECTED_POLL_MS = 4_000;
const SNAPSHOT_INTERVAL_MS = 20_000;

export type ItemsView = {
  items: Item[];
  /** The one authoritative session-scoped value: the item touched last. */
  live: Item | null;
  /** How many changes are still waiting to be sent. */
  pending: number;
  /** The answer did not come from the server. */
  fromCache: boolean;
  loading: boolean;
  session: SessionState;
  error: string | null;
  /** Ask the server again now. */
  reload: () => void;
};

export function useItems(limit = 50): ItemsView {
  const [read, setRead] = useState<ItemsRead | null>(null);
  const [echo, setEcho] = useState<StateEcho | null>(null);
  const [pending, setPending] = useState(0);
  const [session, setSession] = useState<SessionState>({ status: "signed-out" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const running = useRef(false);

  const load = useCallback(async (rows: number) => {
    // One read at a time. Four timers plus a socket can otherwise start five
    // overlapping reads, each of which drains the queue.
    if (running.current) return;
    running.current = true;
    try {
      const state = await readSessionState();
      setSession(state);
      if (state.status !== "signed-in") {
        setRead({ items: [], fromCache: false, fetchedAt: null, flush: null });
        setError(null);
        return;
      }
      const next = await readItems(rows);
      setRead(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(await offlineQueue().size());
      setEcho(await readStateEcho());
      running.current = false;
      setLoading(false);
    }
  }, []);

  // Command start: refresh what this origin can do, then read. The capability
  // cache is persisted, so the surface renders from what other commands learned
  // rather than waiting for this.
  useEffect(() => {
    void refreshCapabilities(apiOrigin());
    void load(limit);
  }, [load, limit]);

  // Rung 1 — the local echo.
  useEffect(() => {
    const timer = setInterval(() => {
      void readStateEcho().then(setEcho);
    }, ECHO_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Rung 2 — the push socket.
  const status = useSyncFeed(
    useCallback(() => {
      void load(limit);
    }, [load, limit]),
  );

  // Rung 3 — the narrow poll, only while the socket is down.
  useEffect(() => {
    if (status === "open") return;
    const timer = setInterval(() => {
      void load(1);
    }, DISCONNECTED_POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  // Rung 4 — the whole snapshot.
  useEffect(() => {
    const timer = setInterval(() => {
      void load(limit);
    }, SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, limit]);

  const items = read?.items ?? [];
  return {
    items,
    live: resolveLive(items, echo, read?.fetchedAt ?? null),
    pending,
    fromCache: read?.fromCache ?? false,
    loading,
    session,
    error,
    reload: useCallback(() => {
      void flushQueue({ retryHeld: true }).finally(() => void load(limit));
    }, [load, limit]),
  };
}

/**
 * Which item counts as the live one.
 *
 * The echo wins only when it was written AFTER the snapshot was fetched. That
 * is what lets a record of a local change outrank a list that predates it, and
 * — just as importantly — what stops it masking a change made on another
 * device, which arrives in a snapshot fetched later.
 */
export function resolveLive(
  items: readonly Item[],
  echo: StateEcho | null,
  fetchedAt: string | null,
): Item | null {
  if (echoOutranks(echo, fetchedAt) && echo !== null) {
    const named = items.find((item) => item.id === echo.id);
    if (named !== undefined) return named;
  }
  return items[0] ?? null;
}
