/*
 * The desktop shell: the tray, the global shortcuts, the desktop settings,
 * the Dock or taskbar badge, the notifications for a prompt a hidden window
 * would swallow, and the notice on quitting with work that has not been sent.
 *
 * Every one of those is a VIEW of renderer state. The renderer owns the app —
 * its data, its locale, what its primary action means — and publishes a
 * `DesktopTrayState`; this process draws it and sends commands back on
 * `DESKTOP_IPC.desktopCommand`. Nothing here decides anything about the app
 * itself, because a second copy of that decision in the main process drifts
 * the moment a renderer action fails, and the menu bar goes on showing the
 * old answer with nobody to notice.
 *
 * Every `desktop:*` handler registers through `handle()` (`ipc.ts`), so a
 * call from a frame that is not the app's own document is refused.
 *
 * In a headless run (tests, agents) the shell refuses every side effect that
 * would reach the screen of whoever is using the machine: no tray icon, no
 * global shortcut registered with the OS, no notification, no dialog, no
 * badge. Each refusal is recorded on `__desktopTestHooks` (`test-hooks.ts`),
 * so a spec can assert the refusal rather than an absence.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, globalShortcut, Notification, powerMonitor } from "electron";

import {
  DESKTOP_IPC,
  type DesktopCommand,
  type DesktopLoginItemStatus,
  type DesktopNotice,
  type DesktopSettings,
  type DesktopSettingsSnapshot,
  type DesktopSettingsUpdate,
  type DesktopTrayLabels,
  type DesktopTrayState,
} from "../../packages/shared/src/desktop-bridge.ts";
import type { DesktopShortcutAction } from "../../packages/shared/src/desktop-shortcuts.ts";
import {
  applySettingsPatch,
  loadDesktopSettings,
  saveDesktopSettings,
} from "./desktop-settings.ts";
import { distributionChannel } from "./distribution.ts";
import { isHeadless } from "./headless.ts";
import { handle } from "./ipc.ts";
import { loginItemBackend, type LoginItemBackend } from "./login-item.ts";
import { recordCommand, recordNotification } from "./test-hooks.ts";
import { applyBadge, installTray, type TrayView } from "./tray.ts";
import {
  FALLBACK_TRAY_LABELS,
  parseNotice,
  parseTrayLabels,
  parseTrayState,
  TRAY_ITEM_PREFIX,
} from "./tray-model.ts";
import { createShortcutManager, type ShortcutManager } from "./shortcuts.ts";
import { getMainWindow, showMainWindow } from "./window.ts";

/**
 * How long the settings screen may hold the shortcuts unregistered before
 * they come back by themselves. A recorder that never says "done" — a crashed
 * tab, a window closed mid-recording — must not leave the person's chords off
 * for the rest of the day.
 */
const SUSPEND_LIMIT_MS = 60_000;

/**
 * The last labels a renderer published, cached beside the settings. The tray
 * exists before the first page has loaded; without this it would be in
 * English on every launch for a person whose app is not.
 */
const LABELS_FILE = "tray-labels.json";

export interface DesktopShellOptions {
  platform: NodeJS.Platform;
  /** `app.getPath("userData")` (`profile.ts`). */
  userData: string;
  /** Where the tray bitmaps live (`electron/dist/tray`). */
  iconDir: string;
  /**
   * Open at login. Left out, this file builds the real one from
   * `login-item.ts` — which is where it has to be built, because
   * `headless.test.ts` allows `app.getLoginItemSettings` and
   * `app.setLoginItemSettings` in this module and nowhere else. An override is
   * for a test that wants to watch the writes.
   */
  loginItem?: LoginItemBackend;
  /**
   * The updater, wired by `main.ts` from `updater.ts`, for the one tray item
   * it owns. Nothing here ever restarts the app on its own.
   */
  updates?: {
    isReady: () => boolean;
    restart: () => unknown;
  };
}

/** Whether the close button should hide the window rather than quit the app. */
let hideOnCloseNow = false;

/**
 * Read by `window.ts` in the window's `close` handler. A function rather than
 * a value, because the person can change the preference while the window is
 * open.
 */
export function hideOnClose(): boolean {
  return hideOnCloseNow;
}

let redrawShell: (() => void) | null = null;

/**
 * Redraw the tray and the badge from the state already published.
 *
 * `main.ts` calls this from the updater's `onChange`. Without it, "Restart to
 * update" would appear in the menu only the next time the renderer published
 * something — the update would be downloaded and the tray would not say so.
 */
export function refreshDesktopShell(): void {
  redrawShell?.();
}

export function installDesktopShell(options: DesktopShellOptions): void {
  const headless = isHeadless();
  const { platform, userData } = options;

  /*
   * Open at login (login-item.ts). Electron's two calls are injected there
   * rather than imported, so that module is unit-tested in plain Node, where
   * importing `electron` throws — which makes this the one place they may be
   * named. `loginItemBackend` answers with the memory backend in a headless or
   * unpackaged run, so a test never registers a login item that outlives it.
   */
  const loginItem: LoginItemBackend =
    options.loginItem ??
    loginItemBackend({
      channel: distributionChannel({
        platform,
        isPackaged: app.isPackaged,
        mas: process.mas === true,
        windowsStore: process.windowsStore === true,
        env: process.env,
      }),
      platform,
      isPackaged: app.isPackaged,
      headless,
      appName: app.getName(),
      execPath: process.execPath,
      env: process.env,
      // snapd puts the snap's command in /snap/bin under this name; it is the
      // same slug as the profile directory.
      snapCommand: "{{projectSlug}}",
      api: {
        get: (settingsOptions) => {
          const current = app.getLoginItemSettings(settingsOptions);
          return { openAtLogin: current.openAtLogin, status: current.status };
        },
        set: (next) => app.setLoginItemSettings(next),
      },
    });

  let settings: DesktopSettings = loadDesktopSettings(userData, platform);
  let state: DesktopTrayState | null = null;
  let tray: TrayView | null = null;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let quitNoticeShown = false;
  let shuttingDown = false;

  let rememberedLabels: DesktopTrayLabels = FALLBACK_TRAY_LABELS;
  try {
    rememberedLabels = parseTrayLabels(
      JSON.parse(readFileSync(path.join(userData, LABELS_FILE), "utf8")),
    );
  } catch {
    /* first launch */
  }

  /** What the tray draws before any renderer has spoken: the remembered words. */
  const drawnState = (): DesktopTrayState =>
    state ?? { signedIn: false, status: null, items: [], badge: 0, labels: rememberedLabels };

  const syncHideOnClose = (): void => {
    // macOS closes to the Dock whatever the preference says. Elsewhere the
    // close button may only hide while a tray icon is there to bring the
    // window back.
    hideOnCloseNow = platform === "darwin" || (settings.closeHides && settings.showInTray);
  };
  syncHideOnClose();

  // ── commands out to the renderer ─────────────────────────────────────
  const send = (command: DesktopCommand): void => {
    recordCommand(command.kind === "shortcut" ? command.action : command.kind);
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.desktopCommand, command);
    }
  };

  const signedIn = (): boolean => state?.signedIn === true;

  // ── shortcuts ────────────────────────────────────────────────────────
  const onShortcut = (action: DesktopShortcutAction): void => {
    switch (action) {
      case "toggle-window": {
        // Handled here and not sent on: the window is the main process's, and
        // a renderer that is busy or crashed must not be able to swallow the
        // one chord that brings the app back.
        const window = getMainWindow();
        if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
          window.hide();
        } else {
          showMainWindow();
        }
        return;
      }
      case "open-settings":
        showMainWindow();
        send({ kind: "open-settings" });
        return;
      case "primary-action":
      case "open-palette":
        showMainWindow();
        // Signed out there is nothing to run and nobody to ask: the window is
        // in front, which is as much as the chord can honestly do.
        if (signedIn()) send({ kind: "shortcut", action });
        return;
    }
  };

  const shortcuts: ShortcutManager = createShortcutManager({
    globalShortcut,
    onTrigger: onShortcut,
    platform,
    headless,
  });

  // ── tray and badge ───────────────────────────────────────────────────
  const onTrayItem = (id: string): void => {
    if (id.startsWith(TRAY_ITEM_PREFIX)) {
      // A tray command runs where the person left it. Raising the window
      // would take focus from what they are doing, which is the reason they
      // used the tray.
      send({ kind: "run", key: id.slice(TRAY_ITEM_PREFIX.length) });
      return;
    }
    if (id === "open") showMainWindow();
    else if (id === "settings") {
      showMainWindow();
      send({ kind: "open-settings" });
    } else if (id === "restart-to-update") options.updates?.restart();
    else if (id === "quit") app.quit();
  };

  const syncTray = (): void => {
    if (!settings.showInTray) {
      tray?.destroy();
      tray = null;
      return;
    }
    tray ??= installTray({
      iconDir: options.iconDir,
      platform,
      updateReady: () => options.updates?.isReady() === true,
      onItem: onTrayItem,
      onActivate: showMainWindow,
    });
    tray.update(drawnState());
  };

  const syncBadge = (): void => {
    const drawn = drawnState();
    applyBadge({
      platform,
      count: settings.showBadge ? drawn.badge : 0,
      description: drawn.labels.badgeDescription,
      iconDir: options.iconDir,
      window: getMainWindow(),
    });
  };

  // ── settings ─────────────────────────────────────────────────────────
  const loginStatus = (): DesktopLoginItemStatus => {
    try {
      return loginItem.status();
    } catch {
      return "unsupported";
    }
  };

  const snapshot = (): DesktopSettingsSnapshot => {
    const login = loginStatus();
    return {
      // What the OS reports wins over the stored value: a person who removed
      // the login item in their system settings must see it off here.
      settings: { ...settings, openAtLogin: login === "enabled" || login === "requires-approval" },
      shortcuts: shortcuts.statuses(),
      shortcutsSuspended: shortcuts.isSuspended(),
      loginItem: login,
      capabilities: {
        closeHides: platform !== "darwin",
        badge: platform === "darwin" || platform === "win32",
      },
    };
  };

  const broadcastSettings = (): void => {
    const current = snapshot();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(DESKTOP_IPC.desktopSettingsChanged, current);
    }
  };

  const resumeShortcuts = (): void => {
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    if (!shortcuts.isSuspended()) return;
    shortcuts.suspend(false);
    broadcastSettings();
  };

  // ── notifications ────────────────────────────────────────────────────
  const posted = new Map<string, Notification>();

  const windowInFront = (): boolean => {
    const window = getMainWindow();
    return (
      !!window &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      window.isFocused()
    );
  };

  const openNotice = (notice: DesktopNotice): void => {
    showMainWindow();
    send({ kind: "open-notice", tag: notice.tag });
  };

  // ── IPC ──────────────────────────────────────────────────────────────
  handle(DESKTOP_IPC.desktopPublishState, (_event, payload: unknown) => {
    const next = parseTrayState(payload);
    if (next === null) return;
    state = next;
    if (JSON.stringify(next.labels) !== JSON.stringify(rememberedLabels)) {
      rememberedLabels = next.labels;
      try {
        writeFileSync(path.join(userData, LABELS_FILE), JSON.stringify(next.labels), "utf8");
      } catch {
        /* a cache of words, not data: a failed write costs one English tray */
      }
    }
    syncTray();
    syncBadge();
  });

  handle(DESKTOP_IPC.desktopSettingsGet, () => snapshot());

  handle(DESKTOP_IPC.desktopSettingsUpdate, (_event, patch: unknown): DesktopSettingsUpdate => {
    const { next, refused } = applySettingsPatch(settings, patch, platform);
    // Written only when the patch asked for it. The stored value can lag the
    // OS, so an unrelated change must not put a login item back that the
    // person removed in their system settings.
    const asked = typeof (patch as { openAtLogin?: unknown } | null)?.openAtLogin === "boolean";
    const loginChanged = asked && next.openAtLogin !== snapshot().settings.openAtLogin;
    settings = next;
    try {
      saveDesktopSettings(userData, settings);
    } catch (err) {
      console.warn("[desktop] settings save failed:", err);
    }
    if (loginChanged) {
      try {
        loginItem.set(settings.openAtLogin);
      } catch (err) {
        console.warn("[desktop] login item failed:", err);
      }
    }
    shortcuts.apply(settings.shortcuts);
    syncHideOnClose();
    syncTray();
    syncBadge();
    const current = snapshot();
    broadcastSettings();
    return { snapshot: current, refused };
  });

  handle(DESKTOP_IPC.desktopSuspendShortcuts, (_event, suspended: unknown) => {
    if (suspended !== true) {
      resumeShortcuts();
      return;
    }
    shortcuts.suspend(true);
    if (suspendTimer !== null) clearTimeout(suspendTimer);
    suspendTimer = setTimeout(resumeShortcuts, SUSPEND_LIMIT_MS);
    broadcastSettings();
  });

  handle(DESKTOP_IPC.desktopShowWindow, () => {
    showMainWindow();
  });

  handle(DESKTOP_IPC.desktopNotify, (_event, payload: unknown): boolean => {
    const notice = parseNotice(payload);
    // A notification for something the person is already looking at is noise.
    if (notice === null || windowInFront()) return false;
    if (headless) {
      // Posting one would put a banner on the screen of whoever is using the
      // machine. The answer is false, so a caller cannot read a headless run
      // as proof that a notification appeared.
      recordNotification(notice);
      return false;
    }
    if (!Notification.isSupported()) return false;
    // Same tag replaces rather than stacks, so a prompt that is published
    // again does not leave a column of copies in the notification centre.
    posted.get(notice.tag)?.close();
    const notification = new Notification({ title: notice.title, body: notice.body });
    notification.on("click", () => openNotice(notice));
    notification.on("close", () => {
      if (posted.get(notice.tag) === notification) posted.delete(notice.tag);
    });
    posted.set(notice.tag, notification);
    notification.show();
    return true;
  });

  // ── quit ─────────────────────────────────────────────────────────────
  powerMonitor.on("shutdown", () => {
    // A modal box during logout or shutdown holds the whole session up.
    shuttingDown = true;
  });

  app.on("before-quit", () => {
    const labels = drawnState().labels;
    // The renderer fills the title in only while it has work that has not
    // been sent, and clears it to "" otherwise. There is no second count in
    // this process to disagree with it.
    if (quitNoticeShown || shuttingDown || labels.quitPendingTitle === "") return;
    quitNoticeShown = true;
    if (headless) {
      recordNotification({
        title: labels.quitPendingTitle,
        body: labels.quitPendingBody,
        tag: "quit-pending",
      });
      return;
    }
    // Informational: quitting goes ahead. The work is kept on this computer
    // and sent the next time the app starts, so a box that could cancel the
    // quit would ask a question with one answer.
    dialog.showMessageBoxSync({
      type: "info",
      title: labels.quitPendingTitle,
      message: labels.quitPendingTitle,
      detail: labels.quitPendingBody,
      buttons: [labels.quitPendingButton],
    });
  });

  app.on("will-quit", () => {
    if (suspendTimer !== null) clearTimeout(suspendTimer);
    shortcuts.dispose();
    tray?.destroy();
    tray = null;
  });

  // ── start ────────────────────────────────────────────────────────────
  redrawShell = () => {
    syncTray();
    syncBadge();
  };
  shortcuts.apply(settings.shortcuts);
  redrawShell();
}
