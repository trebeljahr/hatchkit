/**
 * The contract between the Electron shell and the web app it hosts.
 *
 * `electron/src/preload.ts` builds a `DesktopBridge` and exposes it as
 * `window.electronAPI`; `packages/client/src/types/electron.d.ts` declares the
 * same type on `Window`. Both import it from here, so the object the preload
 * hands over and the object the renderer calls cannot drift apart without a
 * type error on one side.
 *
 * Types and string constants only: the preload is bundled into a sandboxed
 * script and the renderer loads this through `@starter/shared`, so nothing in
 * this file may touch Node, Electron or the DOM.
 */

import type { DesktopShortcutAction, DesktopShortcutBindings } from "./desktop-shortcuts.js";

/** The OS platforms the shell reports, as Node's `process.platform` spells them. */
export type DesktopPlatform = "darwin" | "win32" | "linux";

/** What the main process reports about the machine's idleness. */
export interface DesktopIdlePayload {
  /** "active" | "idle" | "locked" — widened because it crosses IPC. */
  state: string;
  /** Seconds since the OS last saw any input. */
  idleSeconds: number;
}

/**
 * Where the session token is kept, as the main process reports it.
 *
 * `persistent: false` means the token lives in the main process's memory only
 * and the next launch starts signed out: Electron's `safeStorage` had no real
 * encryption to offer (Linux with no keyring, where the backend is
 * `basic_text` — obfuscation with a hardcoded key). Writing a credential there
 * would look secure and not be, so the app refuses and says so instead.
 */
export interface DesktopSecureStoreStatus {
  persistent: boolean;
  /**
   * `safeStorage.getSelectedStorageBackend()` on Linux ("gnome_libsecret",
   * "kwallet5", "basic_text", …); "keychain" on macOS, "dpapi" on Windows,
   * "unavailable" when encryption is not available at all.
   */
  backend: string;
}

/**
 * The session token store, backed by `safeStorage` in the main process. The
 * renderer never sees the file or the key; it hands a token over and asks for
 * it back.
 *
 * Why a bearer token and not the API's cookie: the app's document origin is
 * `app://-`, so every API call is cross-site. A cookie would need SameSite=None
 * and would be a second, silent credential that masks a broken bearer path —
 * the auth client therefore sends `credentials: "omit"` in the desktop shell.
 */
export interface DesktopSecureStore {
  getToken: () => Promise<string | null>;
  setToken: (token: string) => Promise<DesktopSecureStoreStatus>;
  deleteToken: () => Promise<void>;
  status: () => Promise<DesktopSecureStoreStatus>;
}

/**
 * What the tray, the dock badge and the quit notice draw, published by the
 * renderer whenever it changes. The renderer owns the app's state and the
 * locale; the main process only draws what arrives here.
 *
 * The tray is a VIEW of renderer state, never a second source of truth. A
 * main-process copy of "what is running" drifts the moment a renderer action
 * fails, and the drift is invisible — the menu bar keeps showing the old
 * answer.
 */
export interface DesktopTrayState {
  /** False on the way out of the signed-in app: the tray keeps Open and Quit only. */
  signedIn: boolean;
  /** One line under the app name, already formatted; null for none. */
  status: string | null;
  /** The commands the tray offers, in order, at most {@link MAX_TRAY_ITEMS}. */
  items: DesktopTrayItem[];
  /** Dock badge (macOS) / taskbar overlay (Windows) count. 0 hides it. */
  badge: number;
  /** Every string the main process draws, already translated. */
  labels: DesktopTrayLabels;
}

/** A single tray menu command the renderer offers. */
export interface DesktopTrayItem {
  /** Opaque to the main process; it comes back verbatim in a `run` command. */
  key: string;
  label: string;
  /** A second line, or null. Rendered as a disabled sub-item where supported. */
  hint: string | null;
  /** Drawn with a checkmark. */
  checked?: boolean;
  /** Drawn greyed out and not clickable. */
  disabled?: boolean;
}

/** More than this and the menu stops being a menu. Extra items are dropped. */
export const MAX_TRAY_ITEMS = 8;

/**
 * The main process has no catalog of its own, so every word it draws arrives
 * here. Strings with a count are formatted by the renderer (ICU plurals).
 */
export interface DesktopTrayLabels {
  open: string;
  settings: string;
  quit: string;
  /** Tooltip when `status` is null. */
  idleTooltip: string;
  /** Accessible description of the Windows taskbar overlay / dock badge. */
  badgeDescription: string;
  /** Heading above `items`, or "" to draw them without one. */
  itemsHeading: string;
  /** The notice shown when quitting with unsaved work; "" disables the notice. */
  quitPendingTitle: string;
  quitPendingBody: string;
  quitPendingButton: string;
  /** The tray item shown once an update is downloaded. */
  restartToUpdate: string;
}

/** What the tray, a global shortcut or a notification asks the renderer to do. */
export type DesktopCommand =
  /** A tray item was clicked; `key` is the one the renderer published. */
  | { kind: "run"; key: string }
  /** A bound global shortcut fired. The window is already shown. */
  | { kind: "shortcut"; action: DesktopShortcutAction }
  /** Go to the settings screen. */
  | { kind: "open-settings" }
  /** A notification was clicked: go where that prompt is. */
  | { kind: "open-notice"; tag: string };

/** A system notification for a prompt a hidden window would otherwise swallow. */
export interface DesktopNotice {
  title: string;
  body: string;
  /** Replaces an earlier notice with the same tag instead of stacking, and
   *  comes back as the `open-notice` command's `tag`. */
  tag: string;
}

/** Per-device desktop preferences, kept by the main process in `userData`. */
export interface DesktopSettings {
  openAtLogin: boolean;
  /** Tray icon (the menu bar item on macOS). */
  showInTray: boolean;
  /** Windows and Linux: the close button hides to the tray instead of quitting. */
  closeHides: boolean;
  /** macOS Dock badge / Windows taskbar overlay. Off by default. */
  showBadge: boolean;
  shortcuts: DesktopShortcutBindings;
}

export type DesktopSettingsPatch = Partial<Omit<DesktopSettings, "shortcuts">> & {
  shortcuts?: Partial<DesktopShortcutBindings>;
};

/**
 * Why a binding is not active. `invalid` and `duplicate` are refused before
 * saving; `taken` is saved (it may free up later) but `globalShortcut.register`
 * returned false — another application or the OS holds the chord.
 */
export type DesktopShortcutProblem = "invalid" | "duplicate" | "taken";

export interface DesktopShortcutStatus {
  action: DesktopShortcutAction;
  accelerator: string | null;
  registered: boolean;
  problem: DesktopShortcutProblem | null;
  /** For `duplicate`: the action already holding the chord. */
  conflictsWith?: DesktopShortcutAction;
}

export type DesktopLoginItemStatus = "enabled" | "disabled" | "requires-approval" | "unsupported";

export interface DesktopSettingsSnapshot {
  settings: DesktopSettings;
  shortcuts: DesktopShortcutStatus[];
  /** True while the settings screen is recording a key and every shortcut is off. */
  shortcutsSuspended: boolean;
  /** What the OS reports, which can differ from the preference (macOS approval). */
  loginItem: DesktopLoginItemStatus;
  capabilities: {
    /** The close button's behaviour is a choice (not on macOS, where close always hides). */
    closeHides: boolean;
    /** A badge exists on this platform (macOS, Windows). */
    badge: boolean;
  };
}

export interface DesktopSettingsUpdate {
  snapshot: DesktopSettingsSnapshot;
  /** Bindings in the patch that were refused and not saved. */
  refused: DesktopShortcutStatus[];
}

/**
 * Why this copy of the app does not update itself
 * (`electron/src/updater-model.ts`).
 *
 * - `store`: the Mac App Store or the Microsoft Store replaces the app.
 * - `sandbox`: Snap or Flatpak, whose store replaces it.
 * - `package-manager`: a deb, rpm or tar.gz install, which the system's
 *   package manager (or the person) upgrades.
 * - `no-feed`: a build with no update feed — every unsigned macOS or Windows
 *   build, and any local build.
 * - `unpackaged`: a development run.
 * - `turned-off`: the disable-updates environment variable, for managed machines.
 */
export type DesktopUpdateDisabledReason =
  | "store"
  | "sandbox"
  | "package-manager"
  | "no-feed"
  | "unpackaged"
  | "turned-off";

export type DesktopUpdateStatus =
  | { kind: "disabled"; reason: DesktopUpdateDisabledReason }
  /** Nothing in progress. `lastCheckedAt` is null before the first check answered. */
  | { kind: "idle"; lastCheckedAt: string | null }
  | { kind: "checking"; lastCheckedAt: string | null }
  /** `percent` is null until the first progress event. */
  | { kind: "downloading"; version: string; percent: number | null }
  /** Downloaded: installed when the app quits, or now on "Restart to update". */
  | { kind: "ready"; version: string }
  /** The last check or download failed; the next scheduled check tries again. */
  | { kind: "error"; lastCheckedAt: string | null };

export interface DesktopUpdateSnapshot {
  /** The running app's version (`app.getVersion()`). */
  currentVersion: string;
  status: DesktopUpdateStatus;
}

/**
 * The updater, as the settings screen sees it. Nothing here restarts the app
 * on its own: `restart` is only ever called from a click on "Restart to
 * update".
 */
export interface DesktopUpdates {
  getStatus: () => Promise<DesktopUpdateSnapshot>;
  onStatus: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
  /** Checks now; resolves with the snapshot once the check has started. */
  check: () => Promise<DesktopUpdateSnapshot>;
  /** Quits and installs a downloaded update. Resolves false when none is ready. */
  restart: () => Promise<boolean>;
}

/** The desktop-app surface beyond auth: tray, shortcuts, settings, attention. */
export interface DesktopShell {
  publishTrayState: (state: DesktopTrayState) => Promise<void>;
  onCommand: (listener: (command: DesktopCommand) => void) => () => void;
  getSettings: () => Promise<DesktopSettingsSnapshot>;
  updateSettings: (patch: DesktopSettingsPatch) => Promise<DesktopSettingsUpdate>;
  onSettingsChanged: (listener: (snapshot: DesktopSettingsSnapshot) => void) => () => void;
  /** While recording a key: unregister every global shortcut so the press reaches the page. */
  suspendShortcuts: (suspended: boolean) => Promise<void>;
  showWindow: () => Promise<void>;
  /** Posts only when the window is hidden or not focused; resolves whether it did. */
  notify: (notice: DesktopNotice) => Promise<boolean>;
  /** Auto-update. Optional so an older preload is still a valid bridge. */
  updates?: DesktopUpdates;
}

/**
 * `window.electronAPI`. Guard every use: the same export also runs in a
 * browser, an installed PWA and the Capacitor shells, where it is undefined.
 */
export interface DesktopBridge {
  isDesktop: true;
  /**
   * The OS, known synchronously so a pre-paint script can put it on
   * `<html data-platform>` before the first frame (the macOS traffic-light
   * inset depends on it). Widened for platforms Electron supports and this
   * app does not style.
   */
  platform: DesktopPlatform | (string & {});
  /** The app version, so an "About" screen needs no round trip. */
  appVersion: string;
  quit: () => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;

  /**
   * OS-level idle, which sees input in every application — a renderer only
   * sees its own. Optional so a caller keeps guarding on it.
   */
  getIdleState?: () => Promise<DesktopIdlePayload>;
  onIdleState?: (listener: (payload: DesktopIdlePayload) => void) => () => void;

  /** The bearer session token's home. */
  secureStore: DesktopSecureStore;

  /** Tray, global shortcuts, desktop settings and notifications. */
  desktop: DesktopShell;
}

/**
 * Every IPC channel name, in one place. The main process registers handlers
 * under these and the preload invokes them, so a rename is one edit.
 */
export const DESKTOP_IPC = {
  quit: "app:quit",
  openExternal: "app:openExternal",
  getIdle: "idle:get",
  tokenGet: "secure-store:get",
  tokenSet: "secure-store:set",
  tokenDelete: "secure-store:delete",
  tokenStatus: "secure-store:status",
  desktopPublishState: "desktop:tray-state",
  desktopSettingsGet: "desktop:settings-get",
  desktopSettingsUpdate: "desktop:settings-update",
  desktopSuspendShortcuts: "desktop:shortcuts-suspend",
  desktopShowWindow: "desktop:window-show",
  desktopNotify: "desktop:notify",
  updateGetStatus: "update:status",
  updateCheck: "update:check",
  updateRestart: "update:restart",
  /** main → renderer push, not an invoke. */
  idleState: "idle:state",
  /** main → renderer push. */
  desktopCommand: "desktop:command",
  /** main → renderer push. */
  desktopSettingsChanged: "desktop:settings-changed",
  /** main → renderer push. */
  updateStatusChanged: "update:status-changed",
} as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC];

/**
 * The origin the packaged app serves its export from.
 *
 * A constant on purpose, and one that must NEVER change once a version has
 * shipped: `localStorage`, IndexedDB, cookies and every server's
 * TRUSTED_ORIGINS entry are keyed by this origin. Changing the scheme or the
 * host orphans all of them — installed copies wake up with an empty store and
 * a server that refuses their sign-in.
 *
 * Not `file://`: that document's origin is the string "null", which no trust
 * list can match (sign-in answers 403), and it has no root, so root-absolute
 * "/_next/…" resolves against the filesystem root and every route but the
 * first blanks.
 */
export const DESKTOP_APP_SCHEME = "app";
export const DESKTOP_APP_HOST = "-";
export const DESKTOP_APP_ORIGIN = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}` as const;
