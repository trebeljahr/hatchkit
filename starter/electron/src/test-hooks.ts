/*
 * What a headless run did instead of touching the machine.
 *
 * Headless mode (headless.ts) refuses a list of side effects: no tray icon, no
 * OS-level global shortcut, no notification, no login item, no browser window
 * opened, no real keychain item. A refusal that leaves no trace is
 * indistinguishable from a feature that silently stopped working, so each
 * refused effect is RECORDED here, on a global the e2e specs read through
 * Playwright's `electronApp.evaluate`.
 *
 * The global is the only channel available: a packaged build's fuses block the
 * inspector (security.ts), so there is no debugger to query, and stdout alone
 * cannot be asserted on in order.
 *
 * Kept deliberately small and JSON-shaped — everything crossing
 * `evaluate` is structured-cloned.
 */

import type { DesktopNotice } from "../../packages/shared/src/desktop-bridge.ts";
import type { DesktopShortcutAction } from "../../packages/shared/src/desktop-shortcuts.ts";

export const TEST_HOOKS_GLOBAL = "__desktopTestHooks";

export interface DesktopTestHooks {
  /** Set once the main process has finished starting. */
  ready: boolean;
  /** True when this process is running under the headless contract. */
  headless: boolean;
  /** `userData` in use, so a spec can prove the harness profile was taken. */
  userDataDir: string | null;
  /** "created" / "updated" / "destroyed" — never "created" in a headless run. */
  tray: string[];
  /** Accelerators a non-headless run would have registered with the OS. */
  shortcutsRegistered: string[];
  /** Notifications a non-headless run would have posted. */
  notifications: DesktopNotice[];
  /** Login-item writes a non-headless run would have made. */
  loginItem: string[];
  /** Shortcut actions delivered to the renderer, for a spec that fires one. */
  commands: string[];
  /** The updater driver a headless run installs instead of electron-updater. */
  update: {
    /** Events pushed in by the spec; the memory updater replays them. */
    emit?: (event: { kind: string; version?: string; percent?: number }) => void;
    /** How many times `restart()` was reached. Never restarts the process. */
    restarts: number;
  };
}

function blank(): DesktopTestHooks {
  return {
    ready: false,
    headless: false,
    userDataDir: null,
    tray: [],
    shortcutsRegistered: [],
    notifications: [],
    loginItem: [],
    commands: [],
    update: { restarts: 0 },
  };
}

/** The hooks object, created on first use. Safe to call in a non-headless run:
 *  the object is written to and nothing reads it. */
export function testHooks(): DesktopTestHooks {
  const g = globalThis as Record<string, unknown>;
  const existing = g[TEST_HOOKS_GLOBAL];
  if (existing && typeof existing === "object") return existing as DesktopTestHooks;
  const created = blank();
  g[TEST_HOOKS_GLOBAL] = created;
  return created;
}

export function recordTray(event: "created" | "updated" | "destroyed"): void {
  testHooks().tray.push(event);
}

export function recordShortcut(accelerator: string): void {
  testHooks().shortcutsRegistered.push(accelerator);
}

export function recordNotification(notice: DesktopNotice): void {
  testHooks().notifications.push(notice);
}

export function recordLoginItem(detail: string): void {
  testHooks().loginItem.push(detail);
}

export function recordCommand(action: DesktopShortcutAction | string): void {
  testHooks().commands.push(String(action));
}
