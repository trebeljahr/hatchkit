"use client";

/*
 * What has to happen when the app comes back to the foreground, and in what
 * order.
 */

import { useEffect, useRef } from "react";
import { setMobileHandlers } from "./bridge";
import { refreshNetworkStatus } from "./network";

export interface NativeLifecycleCallbacks {
  /**
   * Re-open the realtime socket.
   *
   * WHY THE SOCKET IS RECONNECTED AT ALL, rather than trusted to still be
   * open: iOS suspends the whole process on backgrounding. A server that pings
   * and drops a client on a missed pong therefore considers this client DEAD
   * WITHIN SECONDS of every single backgrounding — including a glance at a
   * notification. Meanwhile the client sees nothing: a socket frozen by
   * process suspension delivers no `close` event when it thaws, so
   * `readyState` is still OPEN and the app happily believes it is connected to
   * a server that forgot it minutes ago. Every send after that vanishes.
   * Resume is the only reliable signal, so resume reconnects unconditionally.
   */
  onReconnect?: () => void | Promise<void>;
  /** Re-sync anything time-derived — countdowns, "x minutes ago", expiry. */
  onTick?: () => void | Promise<void>;
  /**
   * Send anything queued while offline or suspended.
   * MUST report how many items it sent (0 when the queue was empty).
   */
  onFlushQueue?: () => number | Promise<number>;
  /** Pull fresh server state. Skipped when the flush sent anything. */
  onRefetch?: () => void | Promise<void>;
}

/**
 * Runs the resume sequence when the app returns to the foreground.
 *
 * THE ORDER IS LOAD-BEARING. It is:
 *
 *   1. reconnect     — restore the transport before anything tries to use it.
 *   2. tick          — cheap, local, and makes the first painted frame correct
 *                      instead of showing a stale relative time.
 *   3. flush queue   — push the user's local work to the server.
 *   4. refetch       — ONLY IF THE FLUSH QUEUED NOTHING.
 *
 * Step 4's condition is the whole point. Refetching first asks a server that
 * has never heard of the work the user did while they had no signal. It
 * answers correctly — with state that does not contain that work — and the app
 * overwrites local state with it. The user watches their changes disappear,
 * and they reappear a second later when the flush lands, if it lands. Flushing
 * first and skipping the refetch when anything was flushed avoids the window
 * entirely: the flush response is already the fresh state.
 *
 * Network status is refreshed before the flush, because the verdict decides
 * whether a refused write is retried or rolled back — see network.ts.
 */
export function useNativeLifecycle(callbacks: NativeLifecycleCallbacks): void {
  // Held in a ref so a caller passing inline closures (everyone) does not
  // re-register the bridge handler on every render.
  //
  // Assigned in an effect rather than during render: writing a ref while
  // rendering is what `react-hooks/refs` refuses, and doing it after commit
  // is safe here because `.current` is only read from the bridge handler
  // below, which fires on a resume long after the first paint. The initial
  // value already carries the first `callbacks`.
  const latest = useRef(callbacks);
  useEffect(() => {
    latest.current = callbacks;
  });

  useEffect(() => {
    let running = false;

    const onResume = () => {
      // Two resume events can arrive close together (a permission sheet, a
      // share sheet). Overlapping runs would flush the same queue twice.
      if (running) return;
      running = true;

      void (async () => {
        const cb = latest.current;
        try {
          // 1.
          await cb.onReconnect?.();

          // 2.
          await cb.onTick?.();

          // The radio may have changed while suspended and fired no event the
          // WebView could see.
          await refreshNetworkStatus();

          // 3.
          const flushed = cb.onFlushQueue ? await cb.onFlushQueue() : 0;

          // 4.
          if (!flushed) await cb.onRefetch?.();
        } catch {
          /* a failed resume must not crash the app; the next one retries */
        } finally {
          running = false;
        }
      })();
    };

    // Through the mutable handler table, never through `initMobile` — that has
    // already latched by the time any component mounts. See bridge.ts.
    return setMobileHandlers({ onResume });
  }, []);
}
