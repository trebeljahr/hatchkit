/*
 * Global shortcuts: register the bindings from the desktop settings, report
 * per action what did not register, and step aside while the settings screen
 * records a new key.
 *
 * The registrar is an argument rather than an import, so every rule here is
 * unit-tested without Electron. The real one is Electron's `globalShortcut`,
 * which matches this interface as it is.
 *
 * Three ways a binding does not become a live shortcut, and all three reach
 * the settings screen (`DesktopShortcutStatus`):
 *
 *   - `invalid`: the accelerator is not one the shared grammar accepts
 *     (`desktop-shortcuts.ts`), or `register` threw on it. Electron throws on
 *     an accelerator it cannot convert, which would take the main process
 *     down at startup on a hand-edited settings file.
 *   - `duplicate`: an earlier action already holds the same physical chord.
 *     Registering a chord twice runs whichever registration the OS kept, so
 *     the second is refused instead of shadowing the first.
 *   - `taken`: `register` returned false. Another application or the OS holds
 *     the chord. The binding is kept, because it may free up later.
 *
 * In a headless run (tests, agents) nothing is registered with the OS. A
 * global shortcut is taken from every other application on the machine, and a
 * test run must not take a person's chord away while it runs. The accelerator
 * is recorded on `__desktopTestHooks` instead (`test-hooks.ts`).
 */

import type { DesktopShortcutStatus } from "../../packages/shared/src/desktop-bridge.ts";
import {
  DESKTOP_SHORTCUT_ACTIONS,
  duplicateShortcutAction,
  normalizeAccelerator,
  type DesktopShortcutAction,
  type DesktopShortcutBindings,
} from "../../packages/shared/src/desktop-shortcuts.ts";
import { isHeadless } from "./headless.ts";
import { recordShortcut, testHooks } from "./test-hooks.ts";

/** The part of Electron's `globalShortcut` this module uses. */
export interface ShortcutRegistrar {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
}

export interface ShortcutManagerOptions {
  /** Electron's `globalShortcut`, or a stand-in in a test. */
  globalShortcut: ShortcutRegistrar;
  onTrigger: (action: DesktopShortcutAction) => void;
  /** `process.platform`, which decides whether two accelerators are one chord. */
  platform: string;
  /** Defaults to {@link isHeadless}; an argument so a test can drive both paths. */
  headless?: boolean;
}

export interface ShortcutManager {
  /** Replace every registration with `bindings`, and report what happened. */
  apply: (bindings: DesktopShortcutBindings) => DesktopShortcutStatus[];
  /** True unregisters everything and keeps the bindings; false puts them back. */
  suspend: (suspended: boolean) => DesktopShortcutStatus[];
  isSuspended: () => boolean;
  statuses: () => DesktopShortcutStatus[];
  /** Release every chord this manager holds (quit). */
  dispose: () => void;
}

const ACTION_ORDER = new Map<DesktopShortcutAction, number>(
  DESKTOP_SHORTCUT_ACTIONS.map((action, index) => [action, index]),
);

export function createShortcutManager(options: ShortcutManagerOptions): ShortcutManager {
  const headless = options.headless ?? isHeadless();
  let bindings: DesktopShortcutBindings | null = null;
  let suspended = false;
  let current: DesktopShortcutStatus[] = [];
  /** What this manager registered, so it never unregisters somebody else's chord. */
  const held = new Set<string>();

  const release = (): void => {
    for (const accelerator of held) {
      try {
        options.globalShortcut.unregister(accelerator);
      } catch {
        /* already gone */
      }
    }
    held.clear();
  };

  const registerAll = (): DesktopShortcutStatus[] => {
    release();
    if (bindings === null) return [];
    // What a non-headless run would have taken from the machine, as it stands
    // now rather than as a log of every apply.
    if (headless) testHooks().shortcutsRegistered.length = 0;

    const statuses: DesktopShortcutStatus[] = [];
    for (const action of DESKTOP_SHORTCUT_ACTIONS) {
      const bound = bindings[action];
      if (bound === null) {
        statuses.push({ action, accelerator: null, registered: false, problem: null });
        continue;
      }
      const accelerator = normalizeAccelerator(bound);
      if (accelerator === null) {
        statuses.push({
          action,
          accelerator: bound.slice(0, 80),
          registered: false,
          problem: "invalid",
        });
        continue;
      }
      const holder = duplicateShortcutAction(bindings, action, accelerator, options.platform);
      // The earlier action in the registry order keeps a repeated chord, so
      // the two never take turns depending on which was written last.
      if (holder !== null && (ACTION_ORDER.get(holder) ?? 0) < (ACTION_ORDER.get(action) ?? 0)) {
        statuses.push({
          action,
          accelerator,
          registered: false,
          problem: "duplicate",
          conflictsWith: holder,
        });
        continue;
      }
      if (suspended) {
        statuses.push({ action, accelerator, registered: false, problem: null });
        continue;
      }
      if (headless) {
        recordShortcut(accelerator);
        statuses.push({ action, accelerator, registered: true, problem: null });
        continue;
      }
      let registered = false;
      let problem: DesktopShortcutStatus["problem"] = null;
      try {
        registered = options.globalShortcut.register(accelerator, () => options.onTrigger(action));
        if (!registered) problem = "taken";
      } catch {
        problem = "invalid";
      }
      if (registered) held.add(accelerator);
      statuses.push({ action, accelerator, registered, problem });
    }
    return statuses;
  };

  return {
    apply: (next) => {
      bindings = { ...next };
      current = registerAll();
      return current;
    },
    suspend: (next) => {
      suspended = next;
      current = registerAll();
      return current;
    },
    isSuspended: () => suspended,
    statuses: () => current,
    dispose: () => {
      release();
      bindings = null;
      current = [];
      if (headless) testHooks().shortcutsRegistered.length = 0;
    },
  };
}
