/**
 * The push feed, for as long as a command is alive.
 *
 * The shared kit's `createSyncClient` owns the socket: the room comes from the
 * authenticated session and nothing else, the client never sends a frame, and
 * a malformed frame is ignored rather than fatal. This module only supplies the
 * URL, the token and Raycast's lifetime.
 *
 * ============================================================
 * WHY THIS DOES NOT FILTER ITS OWN ORIGIN ID
 * ============================================================
 *
 * The feed stamps each event with the origin id that caused it, and a client
 * that filters its own writes out avoids redrawing something it already drew.
 * That reasoning does NOT hold here. Every Raycast command of one install
 * shares one origin id (`auth.ts`'s `originId`), so an event caused by the
 * capture command carries the same id the menu bar command would filter on —
 * and the menu bar command is precisely the surface that needs to hear about
 * it, because it is a different process that drew nothing. Filtering drops
 * exactly the event the persistent surface exists for.
 */
import { useEffect, useRef, useState } from "react";
import { type SyncEvent, type SyncStatus, createSyncClient, resolveSyncUrl } from "../vendor";
import { loadSession } from "./auth";
import { apiOrigin } from "./preferences";
import { EXTENSION_VERSION } from "./version";

/**
 * Subscribe while the component is mounted, and report the socket's status.
 *
 * The status is not cosmetic: the poll below it in the freshness ladder runs
 * ONLY while this says `closed`, because polling underneath a connected socket
 * asks a question that has already been answered.
 */
export function useSyncFeed(onEvent: (event: SyncEvent) => void): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>("closed");
  // The callback is re-created on every render; capturing it in a ref keeps the
  // socket from being torn down and rebuilt each time.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let closed = false;
    let stop: (() => void) | undefined;

    void (async () => {
      const session = await loadSession();
      if (session === null || closed) return;
      const url = resolveSyncUrl(apiOrigin(), apiOrigin());
      if (url === "") return;
      const feed = createSyncClient({
        url,
        // A getter, not a captured value: a pairing that completes while this
        // command is open has to reach the next reconnect.
        token: () => session.token,
        clientVersion: EXTENSION_VERSION,
        onStatus: (next) => {
          if (!closed) setStatus(next);
        },
        // No own-origin filter — see the module header.
        onEvent: (event) => handler.current(event),
      });
      feed.connect();
      stop = () => feed.close();
      if (closed) stop();
    })();

    return () => {
      closed = true;
      stop?.();
    };
  }, []);

  return status;
}
