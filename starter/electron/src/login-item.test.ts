import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  LINUX_AUTOSTART_FILE,
  applyLoginItem,
  createElectronLoginItem,
  createLinuxLoginItem,
  createMemoryLoginItem,
  createUnsupportedLoginItem,
  isHiddenLaunch,
  linuxAutostartEntry,
  linuxAutostartPath,
  loginItemBackend,
  quoteExecArg,
  readLoginItemStatus,
  type LoginItemApi,
  type LoginItemContext,
} from "./login-item.ts";
import { testHooks } from "./test-hooks.ts";

const tempFile = (): string =>
  path.join(mkdtempSync(path.join(os.tmpdir(), "desktop-autostart-")), "autostart", LINUX_AUTOSTART_FILE);

const context = (over: Partial<LoginItemContext> = {}): LoginItemContext => ({
  channel: "linux-package",
  platform: "linux",
  isPackaged: true,
  headless: false,
  appName: "My App",
  execPath: "/opt/My App/myapp",
  env: {},
  snapCommand: "myapp",
  ...over,
});

describe("linux autostart", () => {
  it("quotes an Exec path with spaces and shell characters", () => {
    assert.equal(quoteExecArg("/opt/MyApp/app"), "/opt/MyApp/app");
    assert.equal(quoteExecArg("/home/a b/My $App`.AppImage"), '"/home/a b/My \\$App\\`.AppImage"');
  });

  it("writes an entry that launches hidden", () => {
    const entry = linuxAutostartEntry({ exec: "/home/me/Apps/My App.AppImage", name: "My App" });
    assert.match(entry, /^\[Desktop Entry\]\n/);
    assert.match(entry, /\nExec="\/home\/me\/Apps\/My App.AppImage" --hidden\n/);
    assert.match(entry, /\nName=My App\n/);
  });

  it("keeps a newline in the app name from starting a second key", () => {
    assert.match(linuxAutostartEntry({ exec: "/opt/a", name: "My\nApp" }), /\nName=My App\n/);
  });

  it("honours an absolute XDG_CONFIG_HOME only", () => {
    assert.equal(
      linuxAutostartPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/me"),
      path.join("/x/cfg", "autostart", LINUX_AUTOSTART_FILE),
    );
    assert.equal(
      linuxAutostartPath({ XDG_CONFIG_HOME: "rel" }, "/home/me"),
      path.join("/home/me/.config", "autostart", LINUX_AUTOSTART_FILE),
    );
    assert.equal(
      linuxAutostartPath({}, "/home/me"),
      path.join("/home/me/.config", "autostart", LINUX_AUTOSTART_FILE),
    );
  });

  it("round-trips enable and disable on a file", () => {
    const file = tempFile();
    const item = createLinuxLoginItem({ exec: "/opt/myapp", name: "My App", file });
    assert.equal(item.status(), "disabled");
    item.set(true);
    assert.equal(item.status(), "enabled");
    assert.match(readFileSync(file, "utf8"), /Exec=\/opt\/myapp --hidden/);
    item.set(false);
    assert.equal(item.status(), "disabled");
  });

  it("does not claim an entry written for another binary", () => {
    // A moved AppImage leaves an entry that launches nothing; reporting it as
    // on would tell the person the app opens at login when it does not.
    const file = tempFile();
    createLinuxLoginItem({ exec: "/opt/myapp", name: "My App", file }).set(true);
    assert.equal(createLinuxLoginItem({ exec: "/opt/elsewhere", name: "My App", file }).status(), "disabled");
  });
});

describe("electron login item", () => {
  const fakeApi = (): LoginItemApi & { calls: unknown[]; answer: { openAtLogin: boolean; status?: string } } => {
    const api = {
      calls: [] as unknown[],
      answer: { openAtLogin: false } as { openAtLogin: boolean; status?: string },
      get: (options?: { args?: string[] }) => {
        api.calls.push({ read: options });
        return api.answer;
      },
      set: (settings: { openAtLogin: boolean; args?: string[] }) => {
        api.calls.push({ write: settings });
        api.answer = { openAtLogin: settings.openAtLogin };
      },
    };
    return api;
  };

  it("registers and reads back the same --hidden argument on Windows", () => {
    const api = fakeApi();
    const item = createElectronLoginItem(api, "win32");
    item.set(true);
    assert.equal(item.status(), "enabled");
    assert.deepEqual(api.calls, [
      { write: { openAtLogin: true, args: ["--hidden"] } },
      { read: { args: ["--hidden"] } },
    ]);
  });

  it("passes no arguments on macOS, where SMAppService ignores them", () => {
    const api = fakeApi();
    createElectronLoginItem(api, "darwin").set(true);
    assert.deepEqual(api.calls, [{ write: { openAtLogin: true } }]);
  });

  it("reports a macOS item the person has not approved", () => {
    const api = fakeApi();
    api.answer = { openAtLogin: true, status: "requires-approval" };
    assert.equal(createElectronLoginItem(api, "darwin").status(), "requires-approval");
    // The same answer on Windows has no approval step to report.
    assert.equal(createElectronLoginItem(api, "win32").status(), "enabled");
  });
});

describe("loginItemBackend", () => {
  it("records instead of writing in a headless run", () => {
    const before = testHooks().loginItem.length;
    const ctx = context({ headless: true, channel: "mac-direct", platform: "darwin" });
    assert.equal(applyLoginItem(ctx, true), "enabled");
    assert.deepEqual(testHooks().loginItem.slice(before), ["enabled"]);
    assert.equal(applyLoginItem(ctx, false), "disabled");
    assert.deepEqual(testHooks().loginItem.slice(before), ["enabled", "disabled"]);
  });

  it("never reaches Electron in a headless or unpackaged run", () => {
    const api: LoginItemApi = {
      get: () => assert.fail("read the OS login item in a run that must not"),
      set: () => assert.fail("wrote the OS login item in a run that must not"),
    };
    applyLoginItem(context({ headless: true, api }), true);
    applyLoginItem(context({ isPackaged: false, api }), true);
  });

  it("writes an XDG entry for a packaged Linux build", () => {
    const file = tempFile();
    const ctx = context({ channel: "linux-package", autostartFile: file });
    assert.equal(applyLoginItem(ctx, true), "enabled");
    assert.match(readFileSync(file, "utf8"), /Exec="\/opt\/My App\/myapp" --hidden/);
    assert.equal(applyLoginItem(ctx, false), "disabled");
    assert.equal(readLoginItemStatus(ctx), "disabled");
  });

  it("points a packaged AppImage at $APPIMAGE", () => {
    const file = tempFile();
    const ctx = context({
      channel: "appimage",
      env: { APPIMAGE: "/home/me/My App.AppImage" },
      autostartFile: file,
    });
    applyLoginItem(ctx, true);
    assert.match(readFileSync(file, "utf8"), /Exec="\/home\/me\/My App.AppImage" --hidden/);
  });

  it("reports the channels with no mechanism as unsupported", () => {
    for (const channel of ["windows-store", "flatpak"] as const) {
      const ctx = context({ channel, platform: channel === "flatpak" ? "linux" : "win32" });
      assert.equal(readLoginItemStatus(ctx), "unsupported", channel);
      assert.equal(applyLoginItem(ctx, true), "unsupported", channel);
    }
  });

  it("reports unsupported rather than throwing when Electron is not bound", () => {
    assert.equal(readLoginItemStatus(context({ channel: "mac-direct", platform: "darwin" })), "unsupported");
  });

  it("survives a backend that throws on write and on read", () => {
    const api: LoginItemApi = {
      get: () => {
        throw new Error("registry locked");
      },
      set: () => {
        throw new Error("registry locked");
      },
    };
    const ctx = context({ channel: "windows-direct", platform: "win32", api });
    assert.equal(applyLoginItem(ctx, true), "unsupported");
  });

  it("shares one memory backend across the process, so a read answers the last write", () => {
    const unpackaged = context({ isPackaged: false });
    assert.equal(loginItemBackend(unpackaged), loginItemBackend(context({ headless: true })));
    applyLoginItem(unpackaged, true);
    assert.equal(readLoginItemStatus(context({ headless: true })), "enabled");
    applyLoginItem(unpackaged, false);
  });
});

describe("memory and unsupported backends", () => {
  it("keeps its own answer and never reaches the OS", () => {
    const item = createMemoryLoginItem();
    assert.equal(item.status(), "disabled");
    item.set(true);
    assert.equal(item.status(), "enabled");
  });

  it("stays unsupported whatever it is told", () => {
    const item = createUnsupportedLoginItem();
    item.set(true);
    assert.equal(item.status(), "unsupported");
  });
});

describe("isHiddenLaunch", () => {
  it("detects the login item's argument", () => {
    assert.equal(isHiddenLaunch(["/app", "--hidden"]), true);
    assert.equal(isHiddenLaunch(["/app"]), false);
    assert.equal(isHiddenLaunch([]), false);
  });
});
