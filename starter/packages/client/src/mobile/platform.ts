/*
 * Which shell are we running in, and the single root-marker contract.
 *
 * THE MARKER CONTRACT, stated once so CSS and TS agree:
 *   - `<html class="cap">`            present only under a native shell
 *   - `<html data-platform="ios">`    or "android"
 *   - set PRE-PAINT, from a script inlined into <head>
 *
 * Everything phone-specific in the stylesheets hangs off `html.cap`, which is
 * what makes `styles/native.css` inert on web by construction rather than by
 * discipline.
 */

/** Minimal shape of the global Capacitor object injected by the native shell. */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * True inside an iOS/Android WebView shell.
 *
 * NOTHING THAT RENDERS MAY BRANCH ON THIS DURING RENDER.
 * Under `output: "export"` every page is prerendered in Node, where
 * `window.Capacitor` cannot exist. So a component that returns a different
 * tree when `isCapacitor()` is true produces markup at hydration that does not
 * match the exported HTML, and React resolves that by throwing away the served
 * DOM and re-rendering the subtree from scratch — losing focus, scroll position
 * and any uncontrolled input state, on the slowest device in the fleet.
 *
 * Phone-only UI therefore ships in the web bundle like everything else and is
 * hidden with CSS under the root marker (`html.cap` / `html:not(.cap)`).
 * `isCapacitor()` is for effects, event handlers and imperative code that runs
 * after mount — never for deciding what to return.
 */
export function isCapacitor(): boolean {
  return capacitorGlobal()?.isNativePlatform?.() ?? false;
}

/** "ios" | "android" on a native shell, "web" everywhere else. */
export function platformName(): "ios" | "android" | "web" {
  const cap = capacitorGlobal();
  if (!cap?.isNativePlatform?.()) return "web";
  const name = cap.getPlatform?.();
  return name === "ios" || name === "android" ? name : "web";
}

/**
 * Self-contained IIFE, inlined into <head> by the root layout so the marker is
 * on `<html>` BEFORE THE FIRST PAINT. Without it, the first frame of every
 * cold start and every WebView reload renders with no safe-area padding and
 * then jumps — the splash screen hides that on a cold start and hides nothing
 * on a reload.
 *
 * THE MARKER GOES ON `<html>`, NEVER ON `<body>`. This is a correctness
 * decision, not a style one:
 *
 *   A pre-paint script that mutates `<body>` makes the served HTML and the
 *   hydrated DOM disagree about body's attributes. React reports that as a
 *   hydration mismatch, and the only way to silence it is
 *   `suppressHydrationWarning` on `<body>` — which then silences EVERY OTHER
 *   body-level mismatch, for the web app too, forever. One phone-only class
 *   would have bought permanent blindness to real hydration bugs.
 *
 *   `<html>` also lets the script sit in <head>: `document.documentElement`
 *   exists while the head is still being parsed, `document.body` does not.
 *   A script that touches `document.body` from <head> reads null.
 *
 * Kept as a string (not a function reference) because it is injected via
 * `dangerouslySetInnerHTML` and must survive minification of the app bundle
 * unchanged.
 */
export const ROOT_MARKER_SCRIPT: string =
  '(function(){try{var c=window.Capacitor;' +
  'if(c&&c.isNativePlatform&&c.isNativePlatform()){' +
  'var e=document.documentElement;e.classList.add("cap");' +
  'e.setAttribute("data-platform",c.getPlatform?c.getPlatform():"unknown");' +
  '}}catch(e){}})();';

/**
 * Applies the same marker imperatively. `bridge.ts` calls this again after its
 * dynamic imports resolve; see the comment there for why twice is deliberate.
 */
export function applyRootMarker(): void {
  if (typeof document === "undefined") return;
  const cap = capacitorGlobal();
  if (!cap?.isNativePlatform?.()) return;
  const root = document.documentElement;
  root.classList.add("cap");
  root.setAttribute("data-platform", cap.getPlatform?.() ?? "unknown");
}
