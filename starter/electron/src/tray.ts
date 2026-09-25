/*
 * The tray icon (the menu bar item on macOS, the notification area on
 * Windows, the AppIndicator on Linux) and the count the Dock or the taskbar
 * shows. Everything drawn here comes from `tray-model.ts`, which holds the
 * rules and is unit-tested; this file is the Electron binding.
 *
 * Created on demand and updated in place. Destroying and rebuilding a `Tray`
 * on every state change makes the icon jump to the end of the menu bar,
 * because the OS treats it as a new item.
 *
 * Nothing is created in a headless run (`headless.ts`): a tray icon appears on
 * the screen of whoever is using the machine, and a test that leaves one
 * behind leaves it in their menu bar. The draw calls are recorded on
 * `__desktopTestHooks` instead (`test-hooks.ts`), so a spec can prove the
 * refusal happened rather than infer it from an absence.
 */

import path from "node:path";
import {
  app,
  Menu,
  nativeImage,
  Tray,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";

import type { DesktopTrayState } from "../../packages/shared/src/desktop-bridge.ts";
import { isHeadless } from "./headless.ts";
import { recordTray } from "./test-hooks.ts";
import {
  trayIconFile,
  trayMenuTemplate,
  trayTooltip,
  TRAY_OVERLAY_FILE,
  type TrayMenuEntry,
} from "./tray-model.ts";

export interface TrayView {
  /** Redraw from the state the renderer last published. */
  update: (state: DesktopTrayState | null) => void;
  destroy: () => void;
}

export interface InstallTrayOptions {
  /** Where `pnpm icons:desktop` writes the tray bitmaps (`electron/dist/tray`). */
  iconDir: string;
  platform: NodeJS.Platform;
  /** Asked on every redraw, so "Restart to update" appears without a second path. */
  updateReady: () => boolean;
  /** A menu item was clicked; the id is the one `tray-model.ts` gave it. */
  onItem: (id: string) => void;
  /** A left click on the icon itself (Windows only). */
  onActivate: () => void;
}

/** The template Electron builds the menu from: the model's entries plus a click. */
export function menuTemplate(
  entries: TrayMenuEntry[],
  onItem: (id: string) => void,
): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    const id = entry.id;
    if (id === undefined) return entry;
    return { ...entry, click: () => onItem(id) };
  });
}

export function installTray(options: InstallTrayOptions): TrayView {
  const headless = isHeadless();
  let tray: Tray | null = null;
  let icon: NativeImage | null = null;
  let lastMenu = "";
  let lastTooltip = "";

  const image = (): NativeImage => {
    if (icon === null) {
      icon = nativeImage.createFromPath(
        path.join(options.iconDir, trayIconFile(options.platform)),
      );
      // `createFromPath` answers an empty image for a file that is not there,
      // and an empty image is an invisible tray item rather than an error.
      // `scripts/icons-desktop.mjs` always writes tray.png, so fall back to it
      // and say so.
      if (icon.isEmpty()) {
        console.warn(`[tray] ${trayIconFile(options.platform)} is missing; using tray.png`);
        icon = nativeImage.createFromPath(path.join(options.iconDir, "tray.png"));
      }
      // A template image is tinted by macOS for a light or a dark menu bar. A
      // coloured icon there keeps its colour and vanishes against one of them.
      if (options.platform === "darwin") icon.setTemplateImage(true);
    }
    return icon;
  };

  if (!headless) {
    tray = new Tray(image());
    // Windows opens the window on a left click and the menu on a right click.
    // macOS and Linux open the menu on any click: an AppIndicator knows only
    // menus, so a click handler there never runs.
    if (options.platform === "win32") tray.on("click", options.onActivate);
    recordTray("created");
  }

  return {
    update: (state) => {
      const entries = trayMenuTemplate(state, { updateReady: options.updateReady() });
      const tooltip = trayTooltip(state);
      recordTray("updated");
      if (tray === null || tray.isDestroyed()) return;
      // Rebuilding an unchanged menu closes it under the pointer of somebody
      // who has it open.
      const key = JSON.stringify(entries);
      if (key !== lastMenu) {
        lastMenu = key;
        tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(entries, options.onItem)));
      }
      if (tooltip !== lastTooltip) {
        lastTooltip = tooltip;
        tray.setToolTip(tooltip);
      }
    },
    destroy: () => {
      recordTray("destroyed");
      if (tray !== null && !tray.isDestroyed()) tray.destroy();
      tray = null;
      lastMenu = "";
      lastTooltip = "";
    },
  };
}

export interface BadgeOptions {
  platform: NodeJS.Platform;
  /** `DesktopTrayState.badge`; 0 clears it. */
  count: number;
  /** `labels.badgeDescription`, which a screen reader reads out on Windows. */
  description: string;
  iconDir: string;
  /** The Windows overlay belongs to a window; null while none exists. */
  window: BrowserWindow | null;
}

let overlayIcon: NativeImage | null = null;

/**
 * The Dock badge on macOS and the taskbar overlay on Windows.
 *
 * Not part of the tray view, because the two are separate surfaces: a person
 * who turned the tray icon off still has a Dock. Linux has no equivalent that
 * Electron can set, so nothing is drawn there.
 *
 * macOS shows the count. Windows shows a dot instead: the overlay is a 16px
 * image, not text, so a number would have to be drawn into a bitmap per
 * count. The description carries what the badge means for a screen reader.
 */
export function applyBadge(options: BadgeOptions): void {
  if (isHeadless()) return;
  const { count, platform } = options;
  if (platform === "darwin") {
    app.dock?.setBadge(count > 0 ? String(count) : "");
    return;
  }
  if (platform !== "win32") return;
  const window = options.window;
  if (window === null || window.isDestroyed()) return;
  if (count <= 0) {
    window.setOverlayIcon(null, "");
    return;
  }
  overlayIcon ??= nativeImage.createFromPath(path.join(options.iconDir, TRAY_OVERLAY_FILE));
  window.setOverlayIcon(overlayIcon, options.description);
}
