/*
 * Which channel installed this copy of the app, and what that channel owns.
 *
 * One binary is built per target, but the runtime still has to know where it
 * came from, because two things differ per channel and fail quietly if a store
 * build behaves like a direct download:
 *
 *   - **Updates.** A store (Mac App Store, Microsoft Store, Snap Store,
 *     Flathub) replaces the app itself; an in-app updater there either cannot
 *     write to its own bundle (MAS sandbox, MSIX, a read-only squashfs, a
 *     Flatpak's /app) or fights the store. The updater (`updater-model.ts`,
 *     `updaterPolicy`) stays off everywhere `selfUpdates` answers false. A
 *     Homebrew cask installs the same Developer ID build as the website, so it
 *     cannot be told apart here and does update itself; the cask says
 *     `auto_updates true`. deb, rpm and tar.gz are all `linux-package`, left to
 *     the package manager or the person. electron-builder's
 *     `resources/package-type` would tell them apart, but none of the three
 *     updates itself, so nothing reads it.
 *
 *   - **Open at login.** See `loginItemMechanism`.
 *
 * Pure: every input is passed in, so each channel is a unit test rather than a
 * build for another OS.
 */

export type DistributionChannel =
  | "mac-app-store"
  | "mac-direct"
  | "windows-store"
  | "windows-direct"
  | "snap"
  | "flatpak"
  | "appimage"
  | "linux-package"
  | "unpackaged";

export interface DistributionInputs {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** `process.mas` — true only in a Mac App Store build of Electron. */
  mas: boolean;
  /** `process.windowsStore` — true when running from an AppX/MSIX package. */
  windowsStore: boolean;
  env: Record<string, string | undefined>;
}

export function distributionChannel(input: DistributionInputs): DistributionChannel {
  if (!input.isPackaged) return "unpackaged";
  if (input.platform === "darwin") return input.mas ? "mac-app-store" : "mac-direct";
  if (input.platform === "win32") return input.windowsStore ? "windows-store" : "windows-direct";
  // snapd sets SNAP for every app it runs, and flatpak-spawn sets FLATPAK_ID;
  // AppImage's runtime sets APPIMAGE to the image's own path.
  if (input.env.SNAP) return "snap";
  if (input.env.FLATPAK_ID) return "flatpak";
  if (input.env.APPIMAGE) return "appimage";
  return "linux-package";
}

/** Whether the app may replace itself (the electron-updater path). */
export function selfUpdates(channel: DistributionChannel): boolean {
  return channel === "mac-direct" || channel === "windows-direct" || channel === "appimage";
}

export type LoginItemMechanism =
  | { kind: "electron" }
  | { kind: "xdg-autostart"; exec: string }
  | { kind: "unsupported"; reason: string };

/**
 * How "Open at login" works for a channel.
 *
 * - macOS, direct and App Store alike: `app.setLoginItemSettings`, which is
 *   SMAppService on macOS 13+ and is allowed inside the App Sandbox.
 * - Windows direct: the same Electron call (the `Run` registry key).
 * - **Microsoft Store: unsupported.** A packaged app's `Run` key is virtualised
 *   and never read at login; the supported route is a `windows.startupTask`
 *   extension in the manifest plus the WinRT `StartupTask` API, which Electron
 *   does not expose.
 * - AppImage: an XDG autostart entry pointing at `$APPIMAGE` (the executable
 *   path is inside a mount that disappears on exit).
 * - Snap: the same entry, written under the snap's own `$HOME`
 *   (`$SNAP_USER_DATA`), which is exactly where snapd's `autostart:` key looks;
 *   electron-builder's `snap.autoStart` declares it. snapd rewrites the Exec
 *   line to the snap's command, so it names `/snap/bin/<name>`.
 * - **Flatpak: unsupported.** Writing the host's `~/.config/autostart` needs a
 *   filesystem hole Flathub review refuses, and the Background portal's
 *   autostart request is not reachable from Electron.
 * - deb/rpm: an XDG entry pointing at the installed executable.
 */
export function loginItemMechanism(
  channel: DistributionChannel,
  context: { execPath: string; env: Record<string, string | undefined>; snapCommand: string },
): LoginItemMechanism {
  switch (channel) {
    case "mac-app-store":
    case "mac-direct":
    case "windows-direct":
    case "unpackaged":
      return { kind: "electron" };
    case "windows-store":
      return { kind: "unsupported", reason: "a Microsoft Store package cannot register a Run key" };
    case "flatpak":
      return { kind: "unsupported", reason: "Flatpak has no autostart path reachable from Electron" };
    case "snap":
      return { kind: "xdg-autostart", exec: `/snap/bin/${context.snapCommand}` };
    case "appimage":
      return { kind: "xdg-autostart", exec: context.env.APPIMAGE ?? context.execPath };
    case "linux-package":
      return { kind: "xdg-autostart", exec: context.execPath };
  }
}
