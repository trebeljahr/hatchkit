"use client";

import { useEffect } from "react";

/*
 * Mounts once at the app root.
 *
 * On web this is a no-op: `window.Capacitor` does not exist, so nothing is
 * imported and no native symbol ever reaches the bundle's execution path.
 *
 * It deliberately passes NO HANDLERS to `initMobile`. `initMobile` latches on
 * its first call, and this component is that first call — it runs before the
 * app shell exists, so any handler given here would be the only one the app
 * could ever have. Screens install their own through `setMobileHandlers`,
 * which writes into a mutable table the listeners read at event time. See the
 * handler-table comment in bridge.ts.
 */
export function MobileBridgeLoader() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cap = (window as unknown as { Capacitor?: unknown }).Capacitor;
    if (!cap) return;

    let cancelled = false;
    (async () => {
      const { initMobile, hideSplash } = await import("./bridge");
      if (cancelled) return;
      await initMobile();
      // Hidden here rather than by `launchAutoHide`, so the first frame the
      // user sees is a laid-out app and not an unstyled flash.
      await hideSplash();
    })().catch(() => {
      /* swallow — bridge failures must never crash the app */
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
