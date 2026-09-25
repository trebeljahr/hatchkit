/*
 * `window.electronAPI` in the renderer.
 *
 * The shape is not written here: it is `DesktopBridge` from `@starter/shared`,
 * the same type `electron/src/preload.ts` builds the object against. One type
 * on both sides means a method the preload stops exposing is a type error in
 * the page that calls it, instead of an `undefined is not a function` in a
 * shipped desktop build.
 *
 * Optional on purpose. The same client bundle runs in a browser, an installed
 * PWA and the Capacitor shells, where `window.electronAPI` is undefined, so
 * every use has to be guarded.
 */

// Imported through the package's subpath export rather than its index:
// `@starter/shared`'s index is shared with every surface, and a project
// without the desktop feature has no desktop-bridge module to re-export.
import type { DesktopBridge } from "@starter/shared/desktop-bridge.js";

declare global {
  interface Window {
    electronAPI?: DesktopBridge;
  }
}

export {};
