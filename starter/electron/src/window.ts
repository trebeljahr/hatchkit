/*
 * The one app window: remembered bounds, a background that matches the theme
 * before the page paints, hide-on-close, and the headless contract.
 *
 * The window is a singleton here rather than in main.ts, because the tray, the
 * global shortcuts and the notifications all need "the window, if there is
 * one" and each keeping its own reference is how a destroyed window gets shown
 * again.
 */

import { app, BrowserWindow, nativeTheme, screen } from "electron";

import { appVersionArg } from "./app-version.ts";
import { isHeadless } from "./headless.ts";
import { WEB_PREFERENCES } from "./security.ts";
import {
  MIN_SIZE,
  backgroundColorFor,
  initialBounds,
  readWindowState,
  writeWindowState,
} from "./window-state.ts";

let mainWindow: BrowserWindow | null = null;
let quitting = false;

app.on("before-quit", () => {
  quitting = true;
});

/**
 * The app is about to quit on purpose — an update restart, or a Quit from the
 * tray. On macOS Squirrel closes every window BEFORE `before-quit` fires, so
 * without this the close handler below hides the window, cancels the close and
 * leaves "Restart to update" doing nothing (Electron's `autoUpdater` docs,
 * `quitAndInstall`).
 */
export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

/** The live window, or null when there is none (macOS keeps the app running). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function createMainWindow(options: {
  preload: string;
  dev: boolean;
  /** Tests and agents: never shown, never focused (see headless.ts). */
  headless?: boolean;
  /** False for a login-item launch that starts in the tray. */
  showOnReady?: boolean;
  /**
   * Whether the close button hides rather than quits: always on macOS, and on
   * Windows and Linux while the tray is on and the person has not chosen to
   * quit on close (desktop.ts owns that preference). Default: macOS only.
   */
  hideOnClose?: () => boolean;
}): BrowserWindow {
  const isMac = process.platform === "darwin";
  const headless = options.headless ?? isHeadless();
  /*
   * Headless on macOS: the accessory policy keeps the app out of the Dock and
   * stops the launch from activating it. main.ts also sets it before `ready`,
   * because the first frame activates the app otherwise; setting it again here
   * costs nothing and keeps the rule with the window it protects.
   */
  if (headless && isMac) {
    app.setActivationPolicy("accessory");
    app.dock?.hide();
  }

  const saved = readWindowState(app.getPath("userData"));
  const bounds = initialBounds(
    saved.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
  );

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: "{{projectName}}",
    // The page's first frame is painted over this colour, and until then the
    // window is not shown at all (`show: false` plus ready-to-show).
    backgroundColor: backgroundColorFor(nativeTheme.shouldUseDarkColors),
    show: false,
    // macOS: no title bar; the traffic lights sit inside the web header, which
    // is the drag region. y centres them in a 3.5rem header.
    ...(isMac
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 20 } }
      : { autoHideMenuBar: true }),
    // Never in headless: a fullscreen window cannot stay hidden.
    fullscreen: saved.fullscreen === true && !headless,
    webPreferences: {
      ...WEB_PREFERENCES,
      preload: options.preload,
      // The bridge reports the app's version synchronously, and the preload is
      // sandboxed, where there is no `app` to ask. `additionalArguments` puts
      // the value in the renderer's `process.argv`, which the sandbox does
      // expose (app-version.ts).
      additionalArguments: [appVersionArg(app.getVersion())],
      // No inspector in a shipped app: it reads the session token straight out
      // of the renderer. menu.ts drops the Reload and DevTools roles to match.
      devTools: options.dev,
    },
    ...(headless ? { skipTaskbar: true } : {}),
  });
  mainWindow = win;

  // `maximize()` also SHOWS a hidden window (Electron's docs say so), so it
  // waits for ready-to-show: called right after construction it puts the
  // window on screen before the page paints — the flash `show: false` exists
  // to prevent — and makes a headless launch on a profile that was last closed
  // maximised visible.
  win.once("ready-to-show", () => {
    if (win.isDestroyed() || headless || options.showOnReady === false) return;
    if (saved.maximized) win.maximize();
    win.show();
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const snapshot = () => ({
    // Normal bounds, so a maximised window restores to its old size.
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen() || win.isSimpleFullScreen(),
  });
  const saveSoon = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      writeWindowState(app.getPath("userData"), snapshot());
    }, 400);
  };
  const SAVE_EVENTS = [
    "resize",
    "move",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ] as const;
  for (const event of SAVE_EVENTS) win.on(event as "resize", saveSoon);

  win.on("close", (event) => {
    if (saveTimer) clearTimeout(saveTimer);
    writeWindowState(app.getPath("userData"), snapshot());
    // Closing the window hides it and the app keeps running, so the renderer —
    // which owns the socket and whatever state the tray draws — stays alive.
    // macOS always (the Dock icon brings it back); Windows and Linux while the
    // tray is there to bring it back.
    const hide = options.hideOnClose ? options.hideOnClose() : isMac;
    if (hide && !quitting) {
      event.preventDefault();
      if (win.isFullScreen()) {
        win.once("leave-full-screen", () => win.hide());
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    }
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

/**
 * Bring the window to the front, for a tray click, a global shortcut or a
 * second launch. Does nothing headless: showing or focusing anything is what
 * headless exists to prevent.
 */
export function showMainWindow(): void {
  const win = getMainWindow();
  if (win === null || isHeadless()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // A tray click or a global shortcut arrives while another app is in front;
  // on macOS `focus()` alone leaves this app behind it.
  if (process.platform === "darwin") app.focus({ steal: true });
}
