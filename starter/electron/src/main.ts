/*
 * The Electron main process.
 *
 * Packaged, and under the e2e harness: the static export in
 * `packages/client/out-desktop` — built by `scripts/build-desktop.mjs` — is
 * served from the privileged `app://-` scheme, and the window loads
 * `app://-/`.
 *
 * Development (`pnpm dev:desktop`, unpackaged only): the window loads
 * `ELECTRON_DEV_URL`, Next's dev server. That origin is http, so it is
 * same-site with a local API and cookie auth works there and nowhere else.
 * Never accept a desktop change on the dev run alone.
 *
 * This file is the arrangement, not the behaviour: every rule lives in the
 * module beside it (protocol, security, window, desktop, updater, …). What it
 * owns is the ORDER, and three steps below have to happen before the app is
 * ready or they do nothing at all:
 *
 *   1. `registerAppScheme()` — a privileged scheme has to be registered
 *      before the first Chromium process starts, or `app://-` is an ordinary
 *      opaque scheme: no real origin, no fetch, no service worker.
 *   2. `app.setPath("userData", …)` — the profile carries the
 *      single-instance lock, the session token and the updater's staging id,
 *      so it is pinned before anything asks for any of them.
 *   3. The macOS accessory policy in a headless run — the first frame
 *      activates the app otherwise, which is the focus theft headless exists
 *      to prevent.
 *
 * esbuild bundles this into `electron/dist/main.js` as CommonJS, so
 * `__dirname` is that directory in a packaged and an unpackaged run alike.
 */

import path from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";

import { DESKTOP_APP_ORIGIN, DESKTOP_IPC } from "../../packages/shared/src/desktop-bridge.ts";
import { hideOnClose, installDesktopShell, refreshDesktopShell } from "./desktop.ts";
import { openInOs } from "./external.ts";
import { isHeadless } from "./headless.ts";
import { startIdleMonitor } from "./idle.ts";
import { configureIpcTrust, handle } from "./ipc.ts";
import { isHiddenLaunch } from "./login-item.ts";
import { installApplicationMenu } from "./menu.ts";
import { USER_DATA_DIR_ENV, userDataDir } from "./profile.ts";
import { handleAppScheme, registerAppScheme } from "./protocol.ts";
import {
  createSecureStore,
  MOCK_KEYCHAIN_SWITCH,
  safeStorageEncryption,
  type SecureStore,
} from "./secure-store.ts";
import { installSecurity } from "./security.ts";
import { testHooks } from "./test-hooks.ts";
import { installUpdater } from "./updater.ts";
import type { UpdateController } from "./updater-model.ts";
import { createMainWindow, getMainWindow, showMainWindow } from "./window.ts";

/** electron-builder's `appId`. Windows groups the taskbar button and attributes
 *  notifications by it, and an app that does not set it is grouped under the
 *  Electron binary instead. */
const APP_USER_MODEL_ID = "{{bundleId}}";

/*
 * A packaged app ignores ELECTRON_DEV_URL. Honouring it would let anyone able
 * to set an environment variable on an installed copy load a page of their own
 * with the preload attached, and reach every IPC handler through it.
 */
const devUrl = !app.isPackaged && process.env.ELECTRON_DEV_URL ? process.env.ELECTRON_DEV_URL : null;
const isDev = devUrl !== null;

const headless = isHeadless();

/*
 * The profile directory (profile.ts): pinned by name, separate for an
 * unpackaged run, separate again for a headless one, and movable through the
 * environment for the e2e harness or a second copy on purpose. It carries the
 * single-instance lock, so it has to be set before the lock is requested.
 */
app.setPath(
  "userData",
  userDataDir({
    appData: app.getPath("appData"),
    isPackaged: app.isPackaged,
    // Never the installed app's profile: a headless run encrypts against the
    // mock keychain below, where that profile's session.bin cannot decrypt,
    // and secure-store.ts deletes a ciphertext it cannot read.
    headless,
    override: process.env[USER_DATA_DIR_ENV],
  }),
);

/*
 * Headless (tests, agents): never show, focus or activate anything. On macOS
 * the accessory policy keeps the app out of the Dock and stops the launch from
 * activating it, and the mock keychain keeps Chromium's OSCrypt from reading
 * or creating a real "<name> Safe Storage" item — which macOS may answer with
 * a system password prompt, taking focus (secure-store.ts).
 */
if (headless && process.platform === "darwin") {
  app.setActivationPolicy("accessory");
  app.commandLine.appendSwitch(MOCK_KEYCHAIN_SWITCH);
}

/*
 * One instance per profile. Two would each hold a socket and both write the
 * same profile. The second launch hands over to the first — which comes to the
 * front — and exits 0, so a launcher that waits on it does not report a
 * failure.
 */
if (!app.requestSingleInstanceLock()) {
  console.log(`[main] another instance holds ${app.getPath("userData")}; handing over to it`);
  app.exit(0);
} else {
  start();
}

function start(): void {
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

  registerAppScheme();
  installSecurity({ devUrl });
  configureIpcTrust({ devUrl });

  /** `electron/dist` → the repo root, or the root of `app.asar` when packaged. */
  const appRoot = path.join(__dirname, "..", "..");
  const exportDir = path.join(appRoot, "packages", "client", "out-desktop");
  const preload = path.join(__dirname, "preload.js");
  /** Copied beside the bundle by `scripts/build-desktop.mjs`. */
  const iconDir = path.join(__dirname, "tray");

  let updates: UpdateController | null = null;

  const showMain = (): void => {
    if (headless) return;
    if (getMainWindow() !== null) showMainWindow();
    else if (app.isReady()) openWindow();
  };

  // A login-item launch while the app already runs changes nothing on screen:
  // the person did not ask for a window, the OS did.
  app.on("second-instance", (_event, argv) => {
    if (!isHiddenLaunch(argv)) showMain();
  });

  handle(DESKTOP_IPC.quit, () => {
    app.quit();
  });

  handle(DESKTOP_IPC.openExternal, (_event, url: unknown) => {
    // external.ts refuses every scheme but http, https and mailto, and records
    // rather than opening in a headless run.
    if (typeof url !== "string") return Promise.resolve(false);
    return openInOs(url);
  });

  /*
   * The session token (secure-store.ts). Built on first use, which is after
   * the app is ready: on Linux `safeStorage` cannot answer before then.
   */
  let store: SecureStore | null = null;
  const tokens = (): SecureStore => {
    store ??= createSecureStore({
      dir: app.getPath("userData"),
      encryption: safeStorageEncryption(safeStorage, process.platform),
    });
    return store;
  };

  handle(DESKTOP_IPC.tokenGet, () => tokens().getToken());
  handle(DESKTOP_IPC.tokenSet, (_event, token: unknown) => {
    if (typeof token !== "string") return tokens().status();
    return tokens().setToken(token);
  });
  handle(DESKTOP_IPC.tokenDelete, () => {
    tokens().deleteToken();
  });
  handle(DESKTOP_IPC.tokenStatus, () => tokens().status());

  function openWindow(options: { show?: boolean } = {}): BrowserWindow {
    const win = createMainWindow({
      preload,
      dev: isDev,
      headless,
      showOnReady: options.show ?? true,
      // desktop.ts owns the preference, and it can change while the window is
      // open, so the window asks each time rather than being told once.
      hideOnClose,
    });
    if (devUrl) loadDev(win, devUrl);
    else void win.loadURL(`${DESKTOP_APP_ORIGIN}/`);
    return win;
  }

  app.whenReady().then(() => {
    // Set again after ready, with the Dock icon: a policy set before ready is
    // enough to stop the activation, and `app.dock` does not exist until now.
    if (headless && process.platform === "darwin") {
      app.setActivationPolicy("accessory");
      app.dock?.hide();
    }

    // The dev run loads http from Next's server, so the scheme has no export
    // to serve and registering a handler for it would only mask a mistake.
    if (!devUrl) handleAppScheme(exportDir);

    installApplicationMenu({ isDev });
    // `powerMonitor` is unusable before the app is ready. The monitor
    // registers the idle IPC handler itself.
    startIdleMonitor();

    const controller = installUpdater({
      headless,
      // Without this the tray learns that an update is ready only the next
      // time the renderer publishes state (desktop.ts).
      onChange: () => refreshDesktopShell(),
    });
    updates = controller;

    installDesktopShell({
      platform: process.platform,
      userData: app.getPath("userData"),
      iconDir,
      updates: {
        isReady: () => controller.snapshot().status.kind === "ready",
        // Handed over as a reference and never called here. Installing an
        // update quits the app, so the source rule in updater-model.test.ts
        // allows exactly two callers: the `update:restart` IPC handler, which
        // the settings button invokes, and the tray item. A third caller would
        // be an install nobody clicked.
        restart: controller.restart,
      },
    });

    openWindow({ show: !isHiddenLaunch(process.argv) });

    // macOS: the Dock icon brings back a window its close button hid.
    app.on("activate", showMain);

    const hooks = testHooks();
    hooks.headless = headless;
    hooks.userDataDir = app.getPath("userData");
    // Last, so a spec that polls for `ready` finds every other field filled in.
    hooks.ready = true;
  });

  app.on("will-quit", () => {
    updates?.dispose();
    updates = null;
  });

  app.on("window-all-closed", () => {
    // macOS keeps the app running with no window; everywhere else a closed
    // window that was not hidden to the tray means the person is done.
    if (process.platform !== "darwin") app.quit();
  });
}

/**
 * The dev server, with one retry loop.
 *
 * Next restarts its dev server on a config change, and the window is often
 * pointed at it during the second or so when nothing is listening. Without the
 * retry the window keeps Chromium's error page until somebody reloads it by
 * hand, which reads as "the desktop build is broken".
 */
function loadDev(win: BrowserWindow, url: string): void {
  void win.loadURL(url);
  win.webContents.openDevTools({ mode: "detach" });

  // Connection-level failures only: a 404 or a page that threw is the app's
  // own problem and must stay on screen.
  const RECOVERABLE_ERRORS = new Set([-7, -21, -101, -102, -104, -105, -106]);
  let retrying = false;
  win.webContents.on("did-fail-load", (_event, errorCode, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || !failedUrl.startsWith(url) || !RECOVERABLE_ERRORS.has(errorCode)) return;
    if (retrying) return;
    retrying = true;
    console.log(`[dev-reload] ${description} (${errorCode}); retrying`);
    const tryReload = (): void => {
      if (win.isDestroyed()) {
        retrying = false;
        return;
      }
      win.loadURL(url).catch(() => setTimeout(tryReload, 500));
    };
    setTimeout(tryReload, 300);
  });
  win.webContents.on("did-finish-load", () => {
    retrying = false;
  });
}
