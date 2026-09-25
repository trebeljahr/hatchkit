import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  distributionChannel,
  loginItemMechanism,
  selfUpdates,
  type DistributionInputs,
} from "./distribution.ts";

const base: DistributionInputs = {
  platform: "linux",
  isPackaged: true,
  mas: false,
  windowsStore: false,
  env: {},
};

describe("distributionChannel", () => {
  it("is unpackaged before anything else", () => {
    assert.equal(
      distributionChannel({ ...base, isPackaged: false, env: { SNAP: "/snap/x" } }),
      "unpackaged",
    );
  });

  it("tells the two macOS builds apart by process.mas", () => {
    assert.equal(distributionChannel({ ...base, platform: "darwin", mas: true }), "mac-app-store");
    assert.equal(distributionChannel({ ...base, platform: "darwin" }), "mac-direct");
  });

  it("tells the two Windows builds apart by process.windowsStore", () => {
    assert.equal(
      distributionChannel({ ...base, platform: "win32", windowsStore: true }),
      "windows-store",
    );
    assert.equal(distributionChannel({ ...base, platform: "win32" }), "windows-direct");
  });

  it("reads the Linux sandbox from the environment its runtime sets", () => {
    assert.equal(distributionChannel({ ...base, env: { SNAP: "/snap/app/12" } }), "snap");
    assert.equal(distributionChannel({ ...base, env: { FLATPAK_ID: "com.example.app" } }), "flatpak");
    assert.equal(distributionChannel({ ...base, env: { APPIMAGE: "/home/me/App.AppImage" } }), "appimage");
    assert.equal(distributionChannel(base), "linux-package");
  });

  it("ignores a stray SNAP on macOS and Windows", () => {
    assert.equal(distributionChannel({ ...base, platform: "darwin", env: { SNAP: "x" } }), "mac-direct");
    assert.equal(distributionChannel({ ...base, platform: "win32", env: { SNAP: "x" } }), "windows-direct");
  });
});

describe("selfUpdates", () => {
  it("is off for every store and package manager", () => {
    const off = [
      "mac-app-store",
      "windows-store",
      "snap",
      "flatpak",
      "linux-package",
      "unpackaged",
    ] as const;
    for (const channel of off) assert.equal(selfUpdates(channel), false, channel);
  });

  it("is on for the direct downloads electron-updater can replace", () => {
    for (const channel of ["mac-direct", "windows-direct", "appimage"] as const) {
      assert.equal(selfUpdates(channel), true, channel);
    }
  });
});

describe("loginItemMechanism", () => {
  const context = { execPath: "/opt/My App/myapp", env: {}, snapCommand: "myapp" };

  it("uses Electron's API on macOS (App Store too) and direct Windows", () => {
    assert.deepEqual(loginItemMechanism("mac-app-store", context), { kind: "electron" });
    assert.deepEqual(loginItemMechanism("mac-direct", context), { kind: "electron" });
    assert.deepEqual(loginItemMechanism("windows-direct", context), { kind: "electron" });
  });

  it("reports the Microsoft Store and Flatpak as unsupported", () => {
    assert.equal(loginItemMechanism("windows-store", context).kind, "unsupported");
    assert.equal(loginItemMechanism("flatpak", context).kind, "unsupported");
  });

  it("points each Linux entry at the right executable", () => {
    assert.deepEqual(loginItemMechanism("snap", context), {
      kind: "xdg-autostart",
      exec: "/snap/bin/myapp",
    });
    // $APPIMAGE, never process.execPath: that path is inside a mount which
    // disappears when the app exits, so the entry would launch nothing.
    assert.deepEqual(
      loginItemMechanism("appimage", { ...context, env: { APPIMAGE: "/home/me/App.AppImage" } }),
      { kind: "xdg-autostart", exec: "/home/me/App.AppImage" },
    );
    assert.deepEqual(loginItemMechanism("linux-package", context), {
      kind: "xdg-autostart",
      exec: "/opt/My App/myapp",
    });
  });

  it("answers every channel, so a new one cannot fall through", () => {
    const channels = [
      "mac-app-store",
      "mac-direct",
      "windows-store",
      "windows-direct",
      "snap",
      "flatpak",
      "appimage",
      "linux-package",
      "unpackaged",
    ] as const;
    for (const channel of channels) {
      assert.ok(loginItemMechanism(channel, context).kind, channel);
    }
  });
});
