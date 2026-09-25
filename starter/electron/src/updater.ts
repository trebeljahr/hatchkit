/*
 * electron-updater, bound to the controller in `updater-model.ts`, plus the
 * three `update:*` IPC handlers the settings screen reads the updater through.
 *
 * Direct downloads only (macOS dmg/zip, the Windows NSIS installer, the
 * AppImage), through the `app-update.yml` electron-builder writes beside the
 * app when the build has a feed. Everything else — the two stores, Snap,
 * Flatpak, deb, rpm, tar.gz, unsigned and local builds — never loads
 * electron-updater at all. The module is `require`d inside `loadUpdater`, and
 * `loadUpdater` runs only when the policy allows updates, so a store or
 * package build does not even run electron-updater's module code (which
 * inspects the install on load).
 *
 * **Headless** (tests, agents): the real updater is never loaded and nothing
 * touches the network. A memory updater stands in, which answers no event
 * until a spec drives it through `__desktopTestHooks.update` (test-hooks.ts),
 * so the "Restart to update" item and button can be exercised without a
 * release. Its `quitAndInstall` counts a restart on the hooks instead of
 * quitting.
 *
 * **Staged rollout** is electron-updater's own and needs nothing from this
 * file except to be left alone: its default `isUserWithinRollout` compares the
 * feed's `stagingPercentage` with a random id it creates once in
 * `<userData>/.updaterId`. That id is stable because `userData` is pinned by
 * name in profile.ts and set in main.ts before the app is ready, so an update
 * never moves a person in or out of a rollout. Do not assign
 * `isUserWithinRollout` here (updater-model.test.ts greps for it). A headless
 * run never loads electron-updater, so it never writes `.updaterId` and never
 * evaluates staging: the memory updater has no feed to read.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";

import {
  DESKTOP_IPC,
  type DesktopUpdateSnapshot,
} from "../../packages/shared/src/desktop-bridge.ts";
import { distributionChannel } from "./distribution.ts";
import { handle } from "./ipc.ts";
import { testHooks } from "./test-hooks.ts";
import {
  createUpdateController,
  updaterPolicy,
  type UpdateController,
  type UpdaterEvent,
  type UpdaterLike,
  type UpdaterPolicy,
} from "./updater-model.ts";
import { markQuitting } from "./window.ts";

/** The stand-in a headless run installs: no network, no feed, no install. */
function createMemoryUpdater(): UpdaterLike {
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    checkForUpdates: () => Promise.resolve(null),
    quitAndInstall: () => {
      testHooks().update.restarts += 1;
    },
    on: () => updater,
  };
  return updater;
}

/**
 * An event from a spec, narrowed to an `UpdaterEvent`. Everything crossing
 * Playwright's `evaluate` is structured-cloned and typed as loosely as the
 * hooks declare it, so the kind is checked here rather than cast.
 */
function toUpdaterEvent(event: {
  kind: string;
  version?: string;
  percent?: number;
}): UpdaterEvent | null {
  switch (event.kind) {
    case "checking":
      return { kind: "checking" };
    case "available":
      return { kind: "available", version: event.version ?? "" };
    case "not-available":
      return { kind: "not-available" };
    case "progress":
      return { kind: "progress", percent: event.percent ?? 0 };
    case "downloaded":
      return { kind: "downloaded", version: event.version ?? "" };
    case "error":
      return { kind: "error" };
    default:
      return null;
  }
}

/** Why this copy does or does not update itself, from the running process. */
export function resolveUpdaterPolicy(isPackaged: boolean): UpdaterPolicy {
  return updaterPolicy({
    channel: distributionChannel({
      platform: process.platform,
      isPackaged,
      mas: process.mas === true,
      windowsStore: process.windowsStore === true,
      env: process.env,
    }),
    hasFeed: isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml")),
    env: process.env,
  });
}

export function installUpdater(options: {
  headless: boolean;
  /** Called after every renderer has been told, so the tray can redraw. */
  onChange?: (snapshot: DesktopUpdateSnapshot) => void;
}): UpdateController {
  const memory = options.headless ? createMemoryUpdater() : null;
  const controller = createUpdateController({
    policy: memory ? { enabled: true } : resolveUpdaterPolicy(app.isPackaged),
    currentVersion: app.getVersion(),
    loadUpdater: () => {
      if (memory) return memory;
      const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
      autoUpdater.logger = {
        info: (message: unknown) => console.log("[updater]", message),
        warn: (message: unknown) => console.warn("[updater]", message),
        error: (message: unknown) => console.error("[updater]", message),
        debug: () => undefined,
      };
      return autoUpdater as unknown as UpdaterLike;
    },
    scheduler: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clear: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    },
    now: () => new Date(),
    // Headless: only a spec's own `update.emit` drives the memory updater, so
    // no timer may move the status underneath it.
    autoCheck: !options.headless,
    onChange: (snapshot) => {
      // The settings screen subscribes through the bridge; a push is the only
      // way it learns that a download finished while it was open.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(DESKTOP_IPC.updateStatusChanged, snapshot);
      }
      options.onChange?.(snapshot);
    },
    // macOS Squirrel closes every window before `before-quit` fires, so
    // without this the hide-on-close handler would cancel the close and leave
    // "Restart to update" doing nothing (window.ts).
    beforeInstall: markQuitting,
    log: (message, err) => console.warn(message, err),
  });

  handle(DESKTOP_IPC.updateGetStatus, () => controller.snapshot());
  handle(DESKTOP_IPC.updateCheck, () => controller.check());
  // Only ever from a click on "Restart to update".
  handle(DESKTOP_IPC.updateRestart, () => controller.restart());

  if (memory) {
    const hooks = testHooks();
    hooks.update.emit = (event) => {
      const next = toUpdaterEvent(event);
      if (next) controller.dispatch(next);
    };
  }

  return controller;
}
