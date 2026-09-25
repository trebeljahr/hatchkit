import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_DESKTOP_SHORTCUTS,
  type DesktopShortcutBindings,
} from "../../packages/shared/src/desktop-shortcuts.ts";
import { createShortcutManager, type ShortcutRegistrar } from "./shortcuts.ts";
import { testHooks } from "./test-hooks.ts";

const TOGGLE = "CommandOrControl+Alt+Shift+Space";

/** Electron's `globalShortcut`, as far as this module uses it. */
function fakeGlobalShortcut(): ShortcutRegistrar & {
  taken: Set<string>;
  registered: Map<string, () => void>;
} {
  const taken = new Set<string>();
  const registered = new Map<string, () => void>();
  return {
    taken,
    registered,
    register: (accelerator, callback) => {
      if (taken.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => {
      registered.delete(accelerator);
    },
  };
}

function bind(extra: Partial<DesktopShortcutBindings> = {}): DesktopShortcutBindings {
  return { ...DEFAULT_DESKTOP_SHORTCUTS, ...extra };
}

function manager(
  globalShortcut: ShortcutRegistrar,
  onTrigger: (action: string) => void = () => undefined,
  overrides: { platform?: string; headless?: boolean } = {},
) {
  return createShortcutManager({
    globalShortcut,
    onTrigger,
    platform: overrides.platform ?? "darwin",
    headless: overrides.headless ?? false,
  });
}

describe("createShortcutManager", () => {
  it("registers the bound actions and runs the right one", () => {
    const globalShortcut = fakeGlobalShortcut();
    const fired: string[] = [];
    const shortcuts = manager(globalShortcut, (action) => fired.push(action));
    const statuses = shortcuts.apply(bind({ "open-palette": "Control+Alt+K" }));
    assert.deepEqual(
      statuses.map((status) => [status.action, status.registered, status.problem]),
      [
        ["toggle-window", true, null],
        ["primary-action", false, null],
        ["open-palette", true, null],
        ["open-settings", false, null],
      ],
    );
    globalShortcut.registered.get("Control+Alt+K")?.();
    globalShortcut.registered.get(TOGGLE)?.();
    assert.deepEqual(fired, ["open-palette", "toggle-window"]);
  });

  it("normalises what it registers, so a recorded chord and a typed one agree", () => {
    const globalShortcut = fakeGlobalShortcut();
    const shortcuts = manager(globalShortcut);
    const [, primary] = shortcuts.apply(bind({ "primary-action": "ctrl+shift+n" }));
    assert.equal(primary?.accelerator, "Control+Shift+N");
    assert.deepEqual([...globalShortcut.registered.keys()].sort(), [TOGGLE, "Control+Shift+N"]);
  });

  it("reports a chord somebody else holds as taken, and keeps the binding", () => {
    const globalShortcut = fakeGlobalShortcut();
    globalShortcut.taken.add(TOGGLE);
    const shortcuts = manager(globalShortcut);
    const [toggle] = shortcuts.apply(bind());
    assert.equal(toggle?.registered, false);
    assert.equal(toggle?.problem, "taken");
    assert.equal(toggle?.accelerator, TOGGLE);
  });

  it("reports an accelerator the grammar refuses without handing it to Electron", () => {
    const globalShortcut = fakeGlobalShortcut();
    const shortcuts = manager(globalShortcut);
    const [, primary] = shortcuts.apply(bind({ "primary-action": "Shift+A" }));
    assert.equal(primary?.problem, "invalid");
    assert.equal(primary?.accelerator, "Shift+A");
    assert.deepEqual([...globalShortcut.registered.keys()], [TOGGLE]);
  });

  it("reports a throwing registration as invalid", () => {
    const shortcuts = manager({
      register: () => {
        throw new Error("conversion failure");
      },
      unregister: () => undefined,
    });
    assert.equal(shortcuts.apply(bind())[0]?.problem, "invalid");
  });

  it("gives a repeated chord to the earlier action and names the holder", () => {
    const globalShortcut = fakeGlobalShortcut();
    const shortcuts = manager(globalShortcut);
    const statuses = shortcuts.apply(bind({ "open-palette": "Command+Alt+Shift+Space" }));
    assert.equal(statuses[0]?.registered, true, "toggle-window keeps the chord");
    assert.equal(statuses[2]?.problem, "duplicate");
    assert.equal(statuses[2]?.conflictsWith, "toggle-window");
    assert.deepEqual([...globalShortcut.registered.keys()], [TOGGLE]);
  });

  it("treats the same two strings as one chord on macOS and as two on Windows", () => {
    const win = manager(fakeGlobalShortcut(), () => undefined, { platform: "win32" });
    const statuses = win.apply(bind({ "open-palette": "Command+Alt+Shift+Space" }));
    assert.equal(statuses[2]?.problem, null);
    assert.equal(statuses[2]?.registered, true);
  });

  it("re-registers on change and releases what it no longer binds", () => {
    const globalShortcut = fakeGlobalShortcut();
    const shortcuts = manager(globalShortcut);
    shortcuts.apply(bind());
    shortcuts.apply(bind({ "toggle-window": "Control+Alt+T" }));
    assert.deepEqual([...globalShortcut.registered.keys()], ["Control+Alt+T"]);
  });

  it("suspends everything while a key is recorded, and puts it back", () => {
    const globalShortcut = fakeGlobalShortcut();
    const shortcuts = manager(globalShortcut);
    shortcuts.apply(bind());
    shortcuts.suspend(true);
    assert.equal(globalShortcut.registered.size, 0);
    assert.equal(shortcuts.isSuspended(), true);
    assert.equal(shortcuts.statuses()[0]?.registered, false);
    // A change made while suspended is kept and registered on resume.
    shortcuts.apply(bind({ "primary-action": "Control+Alt+N" }));
    assert.equal(globalShortcut.registered.size, 0);
    shortcuts.suspend(false);
    assert.deepEqual([...globalShortcut.registered.keys()].sort(), [TOGGLE, "Control+Alt+N"]);
    assert.equal(shortcuts.isSuspended(), false);
  });

  it("never unregisters a chord it did not register", () => {
    const globalShortcut = fakeGlobalShortcut();
    const foreign = () => undefined;
    globalShortcut.registered.set("Control+Alt+X", foreign);
    globalShortcut.taken.add("Control+Alt+X");
    const shortcuts = manager(globalShortcut);
    shortcuts.apply(bind({ "primary-action": "Control+Alt+X" }));
    shortcuts.dispose();
    assert.equal(globalShortcut.registered.get("Control+Alt+X"), foreign);
  });

  it("headless: nothing reaches the OS, and the accelerator is recorded instead", () => {
    const globalShortcut = fakeGlobalShortcut();
    const shortcuts = manager(globalShortcut, () => undefined, { headless: true });
    const statuses = shortcuts.apply(bind({ "open-palette": "Control+Alt+K" }));
    assert.equal(globalShortcut.registered.size, 0);
    assert.deepEqual(
      statuses.filter((status) => status.registered).map((status) => status.accelerator),
      [TOGGLE, "Control+Alt+K"],
    );
    assert.deepEqual(testHooks().shortcutsRegistered, [TOGGLE, "Control+Alt+K"]);
    // The hook is what is bound now, not a log of every apply.
    shortcuts.apply(bind());
    assert.deepEqual(testHooks().shortcutsRegistered, [TOGGLE]);
    shortcuts.dispose();
    assert.deepEqual(testHooks().shortcutsRegistered, []);
  });
});
