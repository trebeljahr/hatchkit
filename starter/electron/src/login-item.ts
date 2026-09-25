/*
 * Open at login.
 *
 * Which backend applies is decided per distribution channel (distribution.ts).
 * macOS and Windows go through `app.setLoginItemSettings`; Linux has no such
 * API in Electron, so the app writes the XDG autostart entry itself, pointing
 * at the AppImage when it runs from one (`$APPIMAGE`: `process.execPath` is
 * inside a mount that disappears on exit). The Microsoft Store and Flatpak have
 * no reachable mechanism at all and report `unsupported`, which the settings
 * screen draws as a disabled row.
 *
 * Electron arrives as an injected `LoginItemApi` rather than an import. This
 * module is unit-tested with `node --test`, which runs in plain Node, where
 * importing `electron` throws; `desktop.ts` binds the two calls in one object
 * literal. That keeps every branch below testable without a window.
 *
 * A launch the OS started at login gets `--hidden` (Windows and Linux) and
 * opens to the tray without a window, when the tray is on. macOS 13 and later
 * register through SMAppService, which passes no arguments and does not report
 * `wasOpenedAtLogin` reliably, so a Mac opens its window at login; its close
 * button hides it.
 *
 * **Headless and unpackaged runs never touch the OS.** Registering
 * `node_modules/electron`'s binary as a login item from a test would outlive
 * the test, on the machine of whoever ran it, and nothing in the suite would
 * go red. Those runs get the memory backend, which records every write on
 * `__desktopTestHooks.loginItem` (test-hooks.ts) — a refusal that leaves no
 * trace is indistinguishable from a refusal that stopped working.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DesktopLoginItemStatus } from "../../packages/shared/src/desktop-bridge.ts";
import { loginItemMechanism, type DistributionChannel } from "./distribution.ts";
import { recordLoginItem } from "./test-hooks.ts";

/** Passed by the login item so the app can open to the tray without a window. */
export const HIDDEN_LAUNCH_ARG = "--hidden";
export const LINUX_AUTOSTART_FILE = "{{projectSlug}}.desktop";

export interface LoginItemBackend {
  status: () => DesktopLoginItemStatus;
  set: (enabled: boolean) => void;
}

/** The two Electron calls this module uses, injected (see the file comment). */
export interface LoginItemApi {
  get: (options?: { args?: string[] }) => { openAtLogin: boolean; status?: string };
  set: (settings: { openAtLogin: boolean; args?: string[] }) => void;
}

export interface LoginItemContext {
  channel: DistributionChannel;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** headless.ts. True means nothing below reaches the OS. */
  headless: boolean;
  /** The app's display name, for the XDG entry's `Name=`. */
  appName: string;
  execPath: string;
  env: Record<string, string | undefined>;
  /** The snap's command name, which snapd puts in `/snap/bin`. */
  snapCommand: string;
  /** `app.getLoginItemSettings` / `app.setLoginItemSettings`, bound by desktop.ts. */
  api?: LoginItemApi;
  /** Overridden by the tests; `linuxAutostartPath` answers otherwise. */
  autostartFile?: string;
}

/**
 * The stand-in for a run that must not touch the machine. One per process, so
 * a status read after a write in the same run answers what was written.
 */
export function createMemoryLoginItem(): LoginItemBackend & { enabled: boolean } {
  const item = {
    enabled: false,
    status: (): DesktopLoginItemStatus => (item.enabled ? "enabled" : "disabled"),
    set: (enabled: boolean): void => {
      item.enabled = enabled;
      recordLoginItem(enabled ? "enabled" : "disabled");
    },
  };
  return item;
}

const processMemoryLoginItem = createMemoryLoginItem();

/** A channel with no way to open at login (distribution.ts). */
export function createUnsupportedLoginItem(): LoginItemBackend {
  return {
    status: (): DesktopLoginItemStatus => "unsupported",
    set: (): void => {},
  };
}

/** A value for a desktop entry's Exec key, quoted per the XDG spec. */
export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;
}

export function linuxAutostartEntry(options: { exec: string; name: string }): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    // A newline in the value would start a second key, so the name is flattened.
    `Name=${options.name.replace(/[\r\n]/g, " ")}`,
    `Exec=${quoteExecArg(options.exec)} ${HIDDEN_LAUNCH_ARG}`,
    "X-GNOME-Autostart-enabled=true",
    "Terminal=false",
    "",
  ].join("\n");
}

export function linuxAutostartPath(
  env: Record<string, string | undefined>,
  home: string,
): string {
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be
  // ignored; honouring one would write the entry under the working directory.
  const configHome =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(home, ".config");
  return path.join(configHome, "autostart", LINUX_AUTOSTART_FILE);
}

export function createLinuxLoginItem(options: {
  exec: string;
  name: string;
  file?: string;
}): LoginItemBackend {
  const file = options.file ?? linuxAutostartPath(process.env, os.homedir());
  return {
    status: () => {
      try {
        // Matched on the Exec line, not on the file existing: an entry left by
        // an AppImage that has since moved launches nothing, and reporting it
        // as "on" would hide that from the person.
        return readFileSync(file, "utf8").includes(`Exec=${quoteExecArg(options.exec)}`)
          ? "enabled"
          : "disabled";
      } catch {
        return "disabled";
      }
    },
    set: (enabled) => {
      if (!enabled) {
        rmSync(file, { force: true });
        return;
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, linuxAutostartEntry(options), "utf8");
    },
  };
}

export function createElectronLoginItem(
  api: LoginItemApi,
  platform: NodeJS.Platform,
): LoginItemBackend {
  // Windows matches a login item by its arguments, so the read has to ask for
  // the same `--hidden` the write registered or it answers "off".
  const options = platform === "win32" ? { args: [HIDDEN_LAUNCH_ARG] } : undefined;
  return {
    status: () => {
      const current = api.get(options);
      if (platform === "darwin") {
        // macOS 13+ registers through SMAppService, where the person can hold
        // the item in "Login Items & Extensions". The preference alone reads as
        // on, so the app would claim it opens at login when it does not.
        if (current.status === "requires-approval") return "requires-approval";
        if (current.status === "enabled") return "enabled";
      }
      return current.openAtLogin ? "enabled" : "disabled";
    },
    set: (enabled) => {
      api.set(
        platform === "win32"
          ? { openAtLogin: enabled, args: [HIDDEN_LAUNCH_ARG] }
          : { openAtLogin: enabled },
      );
    },
  };
}

export function loginItemBackend(context: LoginItemContext): LoginItemBackend {
  // Headless and unpackaged runs are recorded, never performed.
  if (context.headless || !context.isPackaged) return processMemoryLoginItem;
  const mechanism = loginItemMechanism(context.channel, {
    execPath: context.execPath,
    env: context.env,
    snapCommand: context.snapCommand,
  });
  if (mechanism.kind === "unsupported") return createUnsupportedLoginItem();
  if (mechanism.kind === "xdg-autostart") {
    return createLinuxLoginItem({
      exec: mechanism.exec,
      name: context.appName,
      file: context.autostartFile,
    });
  }
  // No binding means nobody can write one; saying so beats throwing at a click.
  if (!context.api) return createUnsupportedLoginItem();
  return createElectronLoginItem(context.api, context.platform);
}

/**
 * Writes the preference and answers what the OS reports afterwards, which can
 * differ from what was asked for (a macOS item awaiting approval).
 */
export function applyLoginItem(
  context: LoginItemContext,
  enabled: boolean,
): DesktopLoginItemStatus {
  try {
    loginItemBackend(context).set(enabled);
  } catch (error) {
    // A read-only home, a locked registry key: the preference stays saved and
    // the status below reports what is actually true.
    console.warn("[login-item] write failed", error);
  }
  return readLoginItemStatus(context);
}

export function readLoginItemStatus(context: LoginItemContext): DesktopLoginItemStatus {
  try {
    return loginItemBackend(context).status();
  } catch {
    return "unsupported";
  }
}

/** Whether this launch came from the login item. */
export function isHiddenLaunch(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_LAUNCH_ARG);
}
