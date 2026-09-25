/*
 * Capacitor (native-mobile) bridge.
 *
 * Loaded dynamically from the client entry so Capacitor symbols stay out of
 * the web bundle. Init is idempotent and every native call is try-wrapped — a
 * missing plugin or a denied permission must never crash the WebView, because
 * on a phone there is no console to read the crash in.
 */

import { handleBackButton } from "./back-button";
import { applyRootMarker } from "./platform";

/**
 * Lifecycle callbacks the app can install.
 *
 * `onBackButton` is deliberately absent. The hardware back button is owned
 * entirely by `back-button.ts`; see the header there for why it has to be one
 * place. Apps influence it with `setBackButtonHome` and the overlay stack.
 */
export interface MobileHandlers {
  onPause?: () => void;
  onResume?: () => void;
}

/*
 * THE MUTABLE HANDLER TABLE, and why handlers do not go through `initMobile`.
 *
 * `initMobile` latches on its first call — it has to, or every mount would add
 * another duplicate listener. That first call comes from `MobileBridgeLoader`
 * at the app root, which is the earliest possible moment: BEFORE the app shell
 * exists, before any screen has mounted, and on screens that never mount at
 * all. So handlers passed to `initMobile` from a component are passed to a
 * function that has already latched. They are DROPPED IN SILENCE — no warning,
 * no error, just a resume callback that never fires, on device only, weeks
 * later.
 *
 * Instead the listeners are registered UNCONDITIONALLY at init and read this
 * table at press/resume time. Components install into the table with
 * `setMobileHandlers`, whenever they mount, as often as they like.
 */
const handlers: MobileHandlers = {};

/**
 * Installs handlers and returns ITS OWN teardown.
 *
 * The teardown clears only the exact functions it installed. An unmount that
 * blindly did `handlers.onResume = undefined` would delete a newer screen's
 * handler whenever two components' lifecycles overlap — which they do on every
 * route transition, since the incoming component mounts before the outgoing
 * one unmounts.
 */
export function setMobileHandlers(next: MobileHandlers): () => void {
  const installed: MobileHandlers = {};

  if (next.onPause) {
    handlers.onPause = next.onPause;
    installed.onPause = next.onPause;
  }
  if (next.onResume) {
    handlers.onResume = next.onResume;
    installed.onResume = next.onResume;
  }

  return () => {
    if (installed.onPause && handlers.onPause === installed.onPause) {
      delete handlers.onPause;
    }
    if (installed.onResume && handlers.onResume === installed.onResume) {
      delete handlers.onResume;
    }
  };
}

let initialized = false;

export async function initMobile(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const [{ Capacitor }, { App }, { StatusBar, Style }] = await Promise.all([
    import("@capacitor/core"),
    import("@capacitor/app"),
    import("@capacitor/status-bar"),
  ]);

  if (!Capacitor.isNativePlatform()) return;

  /*
   * The root marker is set TWICE on purpose, and both times matter.
   *
   * `ROOT_MARKER_SCRIPT` runs inline in <head> before the first paint, which
   * is the one that counts on a WebView RELOAD — a reload has no splash screen
   * to hide behind, so a marker applied only from here would show one frame of
   * unpadded layout under the notch and then jump.
   *
   * This second, imperative application covers the case where the pre-paint
   * script did not run at all: the inline script can be dropped by a strict
   * CSP, and on a slow cold start `window.Capacitor` may not be injected yet
   * when <head> is parsed. By the time these dynamic imports have resolved it
   * certainly is.
   *
   * On `<html>`, never `<body>` — see platform.ts for what a body-level
   * pre-paint mutation costs.
   */
  applyRootMarker();

  try {
    await StatusBar.setStyle({ style: Style.Default });
  } catch {
    /* ignore */
  }

  /*
   * Registered UNCONDITIONALLY, not "if a handler exists". A listener added
   * later would be a second listener, and both would run; and a back listener
   * that is absent at boot means Capacitor's default handling is live for the
   * first few seconds and this module's afterwards — two different behaviours
   * for the same button depending on how fast the user was.
   */
  App.addListener("backButton", () => {
    // `event.canGoBack` is ignored on purpose; see back-button.ts.
    let handled = false;
    try {
      handled = handleBackButton();
    } catch {
      // A throwing handler must not exit the app. Treat it as consumed.
      handled = true;
    }
    if (!handled) {
      try {
        void App.exitApp();
      } catch {
        /* ignore */
      }
    }
  });

  App.addListener("appStateChange", ({ isActive }) => {
    try {
      if (isActive) handlers.onResume?.();
      else handlers.onPause?.();
    } catch {
      /* a broken app handler must not tear down the bridge */
    }
  });
}

export async function hideSplash(): Promise<void> {
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch {
    /* ignore */
  }
}

export async function lockOrientation(
  orientation: "portrait" | "landscape",
): Promise<void> {
  try {
    const { ScreenOrientation } = await import("@capacitor/screen-orientation");
    await ScreenOrientation.lock({ orientation });
  } catch {
    /* some devices refuse — leave unlocked */
  }
}

export function isNative(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}
