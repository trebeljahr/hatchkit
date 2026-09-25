/*
 * The Android hardware back button. ALL OF IT. One module, one function.
 *
 * WHY THIS HAS TO BE ONE PLACE: registering a `backButton` listener with
 * @capacitor/app OVERRIDES CAPACITOR'S DEFAULT HANDLING ENTIRELY. There is no
 * "also do the normal thing" — whatever this callback does is the complete
 * behaviour of the button. A second listener added elsewhere does not extend
 * it; it runs alongside and both of them act, so one press closes a dialog AND
 * navigates AND possibly exits.
 *
 * `event.canGoBack` IS NOT THE SIGNAL IT LOOKS LIKE. It reports whether the
 * WebView has history entries, and a single-page app accumulates those just by
 * moving between tabs, opening a modal that pushes state, or any router
 * navigation. It is nearly always true, including on the screen the user
 * considers the root. Gating exit on it means the app can never be exited with
 * back. This module ignores it and reasons about app state instead.
 *
 * ---------------------------------------------------------------------------
 * THE TWO-PRESS BEHAVIOUR WITH THE KEYBOARD UP — this is correct, leave it.
 *
 * With a text field focused and the soft keyboard visible, closing a dialog
 * takes TWO presses of back. One press when the keyboard is down. That looks
 * like a bug and is not one:
 *
 *   Android gives the first press to the IME. The IME consumes it and dismisses
 *   the keyboard. The WebView is never told the press happened, so this module
 *   is never called and the dialog stays open. The second press reaches the
 *   WebView and closes it.
 *
 * That is the platform's own ordering and the one every other Android app has,
 * so it is the one users expect: back dismisses the keyboard first, then the
 * thing behind it.
 *
 * DO NOT collapse it into one press by importing the Capacitor keyboard plugin
 * and hiding the keyboard from here. Doing so takes the back key away from the
 * IME — which is the only way to dismiss the keyboard without submitting — and
 * trades a correct two-press for a screen the user cannot get the keyboard off.
 * `back-button.test.ts` pins this by reading this file's own source.
 * ---------------------------------------------------------------------------
 */

import { closeTopOverlay } from "./overlay-stack";

/**
 * Where back goes when nothing is open. Generic on purpose — a template cannot
 * know the app's home route, and a wrong guess sends the user somewhere that
 * does not exist under a static export.
 */
let homePath = "/";

/** Names the app's home route. Call once, from the root layout or provider. */
export function setBackButtonHome(path: string): void {
  homePath = path;
}

/** The configured home route. */
export function getBackButtonHome(): string {
  return homePath;
}

type Navigate = (path: string) => void;

/**
 * Default navigation is a document-level assign, which under a static export
 * means a full reload. Wire the router's `push` with `setBackButtonNavigate`
 * so back is a client transition and in-memory state survives it.
 */
let navigate: Navigate = (path) => {
  if (typeof window !== "undefined") window.location.assign(path);
};

/** Installs the app's router navigation. Returns a teardown to the default. */
export function setBackButtonNavigate(fn: Navigate): () => void {
  const previous = navigate;
  navigate = fn;
  return () => {
    if (navigate === fn) navigate = previous;
  };
}

function currentPath(): string {
  if (typeof window === "undefined") return homePath;
  return window.location.pathname || "/";
}

/**
 * Handles one press.
 *
 * Order, and it is the order users expect from every Android app:
 *   1. an overlay is open  -> close the top one
 *   2. we are not at home  -> go home
 *   3. otherwise           -> return false, meaning "exit the app"
 *
 * Returns `true` when the press was consumed. The caller (bridge.ts) calls
 * `App.exitApp()` only on `false`, so exiting is a decision made here and
 * nowhere else.
 */
export function handleBackButton(): boolean {
  if (closeTopOverlay()) return true;

  if (currentPath() !== homePath) {
    navigate(homePath);
    return true;
  }

  return false;
}
