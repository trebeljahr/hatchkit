import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  applySettingsPatch,
  defaultDesktopSettings,
  DESKTOP_SETTINGS_FILE,
  loadDesktopSettings,
  parseDesktopSettings,
  saveDesktopSettings,
} from "./desktop-settings.ts";

const TOGGLE = "CommandOrControl+Alt+Shift+Space";
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "desktop-settings-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("defaultDesktopSettings", () => {
  it("binds only the window toggle and hides on close only where a tray is certain", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const settings = defaultDesktopSettings(platform);
      assert.equal(settings.shortcuts["toggle-window"], TOGGLE);
      assert.deepEqual(
        Object.entries(settings.shortcuts)
          .filter(([, value]) => value !== null)
          .map(([action]) => action),
        ["toggle-window"],
      );
      assert.equal(settings.openAtLogin, false);
      assert.equal(settings.showBadge, false);
      assert.equal(settings.showInTray, true);
    }
    assert.equal(defaultDesktopSettings("win32").closeHides, true);
    assert.equal(defaultDesktopSettings("linux").closeHides, false);
    assert.equal(defaultDesktopSettings("darwin").closeHides, false);
  });
});

describe("parseDesktopSettings", () => {
  it("falls back to the defaults for a missing, corrupt or foreign file", () => {
    const defaults = defaultDesktopSettings("darwin");
    assert.deepEqual(parseDesktopSettings(null, "darwin"), defaults);
    assert.deepEqual(parseDesktopSettings("{nope", "darwin"), defaults);
    assert.deepEqual(parseDesktopSettings("[1,2]", "darwin"), defaults);
    const wrongType = JSON.stringify({ openAtLogin: "yes" });
    assert.deepEqual(parseDesktopSettings(wrongType, "darwin"), defaults);
  });

  it("keeps a cleared default, normalises bindings and drops ones Electron would throw on", () => {
    const parsed = parseDesktopSettings(
      JSON.stringify({
        openAtLogin: true,
        showBadge: true,
        shortcuts: {
          "toggle-window": null,
          "primary-action": "ctrl+shift+n",
          "open-palette": "Cmd+Banana",
          unknown: "F13",
        },
      }),
      "linux",
    );
    assert.equal(parsed.openAtLogin, true);
    assert.equal(parsed.showBadge, true);
    assert.equal(parsed.shortcuts["toggle-window"], null);
    assert.equal(parsed.shortcuts["primary-action"], "Control+Shift+N");
    assert.equal(parsed.shortcuts["open-palette"], null);
    assert.equal("unknown" in parsed.shortcuts, false);
  });

  it("gives a repeated chord to the earlier action only", () => {
    const parsed = parseDesktopSettings(
      JSON.stringify({
        shortcuts: { "toggle-window": "Command+K", "open-palette": "CommandOrControl+K" },
      }),
      "darwin",
    );
    assert.equal(parsed.shortcuts["toggle-window"], "Command+K");
    assert.equal(parsed.shortcuts["open-palette"], null);
    // On Windows the same two strings are different keys.
    const win = parseDesktopSettings(
      JSON.stringify({
        shortcuts: { "toggle-window": "Super+K", "open-palette": "CommandOrControl+K" },
      }),
      "win32",
    );
    assert.equal(win.shortcuts["open-palette"], "CommandOrControl+K");
  });
});

describe("applySettingsPatch", () => {
  const base = defaultDesktopSettings("darwin");

  it("applies booleans and ignores anything that is not one", () => {
    const { next } = applySettingsPatch(
      base,
      { openAtLogin: true, showInTray: "no", showBadge: 1 },
      "darwin",
    );
    assert.equal(next.openAtLogin, true);
    assert.equal(next.showInTray, true);
    assert.equal(next.showBadge, false);
    assert.equal(base.openAtLogin, false, "the current settings are not mutated");
  });

  it("refuses an invalid accelerator without saving it", () => {
    const { next, refused } = applySettingsPatch(
      base,
      { shortcuts: { "primary-action": "Shift+A" } },
      "darwin",
    );
    assert.equal(next.shortcuts["primary-action"], null);
    assert.deepEqual(refused, [
      { action: "primary-action", accelerator: "Shift+A", registered: false, problem: "invalid" },
    ]);
  });

  it("refuses a chord another action holds, naming it", () => {
    const { next, refused } = applySettingsPatch(
      base,
      { shortcuts: { "open-palette": "Command+Alt+Shift+Space" } },
      "darwin",
    );
    assert.equal(next.shortcuts["open-palette"], null);
    assert.equal(refused[0]?.problem, "duplicate");
    assert.equal(refused[0]?.conflictsWith, "toggle-window");
  });

  it("moves a chord between actions in one patch, clearing first", () => {
    const { next, refused } = applySettingsPatch(
      base,
      { shortcuts: { "open-palette": TOGGLE, "toggle-window": null } },
      "darwin",
    );
    assert.deepEqual(refused, []);
    assert.equal(next.shortcuts["toggle-window"], null);
    assert.equal(next.shortcuts["open-palette"], TOGGLE);
  });

  it("ignores unknown actions and a patch that is not an object", () => {
    assert.deepEqual(applySettingsPatch(base, { shortcuts: { nope: "F13" } }, "darwin").next, base);
    assert.deepEqual(applySettingsPatch(base, "openAtLogin", "darwin").next, base);
    assert.deepEqual(applySettingsPatch(base, null, "darwin").next, base);
  });
});

describe("loadDesktopSettings and saveDesktopSettings", () => {
  it("round-trips through the file, and reads defaults from an empty directory", () => {
    const dir = scratch();
    assert.deepEqual(loadDesktopSettings(dir, "linux"), defaultDesktopSettings("linux"));
    const settings = { ...defaultDesktopSettings("linux"), openAtLogin: true, showInTray: false };
    saveDesktopSettings(dir, settings);
    assert.deepEqual(loadDesktopSettings(dir, "linux"), settings);
  });

  it("creates the directory it writes into and survives a corrupt file", () => {
    const dir = path.join(scratch(), "nested", "userData");
    saveDesktopSettings(dir, defaultDesktopSettings("win32"));
    assert.deepEqual(loadDesktopSettings(dir, "win32"), defaultDesktopSettings("win32"));
    writeFileSync(path.join(dir, DESKTOP_SETTINGS_FILE), "half a fi", "utf8");
    assert.deepEqual(loadDesktopSettings(dir, "win32"), defaultDesktopSettings("win32"));
  });
});
