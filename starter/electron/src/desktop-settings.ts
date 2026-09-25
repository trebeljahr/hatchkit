/*
 * The desktop settings: per-device preferences the main process owns, in
 * `userData/desktop-settings.json`.
 *
 * Not the account's preferences. Whether this laptop opens at login, or what
 * chord it binds, says nothing about the person's other machines. And the
 * main process needs them before any page has loaded, because the tray and
 * the global shortcuts exist from launch, signed in or not.
 *
 * Everything here is pure apart from the two functions that name a directory,
 * so the parsing and the patch rules are unit-tested without Electron.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  DesktopSettings,
  DesktopShortcutStatus,
} from "../../packages/shared/src/desktop-bridge.ts";
import {
  acceleratorChord,
  DEFAULT_DESKTOP_SHORTCUTS,
  DESKTOP_SHORTCUT_ACTIONS,
  duplicateShortcutAction,
  isDesktopShortcutAction,
  normalizeAccelerator,
  type DesktopShortcutBindings,
} from "../../packages/shared/src/desktop-shortcuts.ts";

export const DESKTOP_SETTINGS_FILE = "desktop-settings.json";

const BOOLEAN_KEYS = ["openAtLogin", "showInTray", "closeHides", "showBadge"] as const;

/**
 * The defaults, per platform.
 *
 * `closeHides` is on for Windows, where the notification-area icon is always
 * there to bring the window back, and off for Linux: GNOME without the
 * AppIndicator extension shows no tray icon at all, and Electron cannot tell
 * whether one is visible — hiding the only window there leaves an app nobody
 * can reach. On macOS the close button always hides, because the Dock brings
 * the window back, and this value is ignored.
 *
 * `showBadge` is off. A count on the Dock icon is a standing interruption,
 * and the person can ask for it.
 */
export function defaultDesktopSettings(platform: string): DesktopSettings {
  return {
    openAtLogin: false,
    showInTray: true,
    closeHides: platform === "win32",
    showBadge: false,
    shortcuts: { ...DEFAULT_DESKTOP_SHORTCUTS },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored file, read leniently: every well-formed field is kept and anything
 * else falls back to its default. A binding the grammar refuses, or one that
 * repeats an earlier action's chord, is dropped to null rather than handed to
 * `globalShortcut.register`, which throws on a malformed accelerator and
 * would take the main process down before the window opens.
 */
export function parseDesktopSettings(raw: string | null, platform: string): DesktopSettings {
  const settings = defaultDesktopSettings(platform);
  if (raw === null) return settings;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!isRecord(data)) return settings;

  for (const key of BOOLEAN_KEYS) {
    if (typeof data[key] === "boolean") settings[key] = data[key];
  }

  if (isRecord(data.shortcuts)) {
    const stored = data.shortcuts;
    const bindings: DesktopShortcutBindings = { ...settings.shortcuts };
    for (const action of DESKTOP_SHORTCUT_ACTIONS) {
      if (!(action in stored)) continue;
      const value = stored[action];
      bindings[action] = typeof value === "string" ? normalizeAccelerator(value) : null;
    }
    // The earlier action in the registry order keeps a repeated chord.
    const chords = new Set<string>();
    for (const action of DESKTOP_SHORTCUT_ACTIONS) {
      const bound = bindings[action];
      if (bound === null) continue;
      const chord = acceleratorChord(bound, platform);
      if (chord === null || chords.has(chord)) bindings[action] = null;
      else chords.add(chord);
    }
    settings.shortcuts = bindings;
  }
  return settings;
}

export interface SettingsPatchResult {
  next: DesktopSettings;
  /** Bindings the patch asked for and did not get; nothing about them was saved. */
  refused: DesktopShortcutStatus[];
}

/**
 * Apply what the renderer sent. It crossed IPC, so every field is checked:
 * booleans must be booleans, actions must exist, accelerators must parse and
 * must not repeat another action's chord.
 *
 * Clearing a binding (null) always succeeds and is applied before any new
 * binding, so moving a chord from one action to another in a single patch
 * works rather than refusing itself.
 */
export function applySettingsPatch(
  current: DesktopSettings,
  patch: unknown,
  platform: string,
): SettingsPatchResult {
  const next: DesktopSettings = { ...current, shortcuts: { ...current.shortcuts } };
  const refused: DesktopShortcutStatus[] = [];
  if (!isRecord(patch)) return { next, refused };

  for (const key of BOOLEAN_KEYS) {
    if (typeof patch[key] === "boolean") next[key] = patch[key];
  }

  if (isRecord(patch.shortcuts)) {
    const entries = Object.entries(patch.shortcuts).filter(
      (entry): entry is [(typeof DESKTOP_SHORTCUT_ACTIONS)[number], unknown] =>
        isDesktopShortcutAction(entry[0]),
    );
    for (const [action, value] of entries) {
      if (value === null) next.shortcuts[action] = null;
    }
    for (const [action, value] of entries) {
      if (value === null) continue;
      const accelerator = typeof value === "string" ? normalizeAccelerator(value) : null;
      if (accelerator === null) {
        refused.push({
          action,
          accelerator: typeof value === "string" ? value.slice(0, 80) : null,
          registered: false,
          problem: "invalid",
        });
        continue;
      }
      const holder = duplicateShortcutAction(next.shortcuts, action, accelerator, platform);
      if (holder !== null) {
        refused.push({
          action,
          accelerator,
          registered: false,
          problem: "duplicate",
          conflictsWith: holder,
        });
        continue;
      }
      next.shortcuts[action] = accelerator;
    }
  }
  return { next, refused };
}

/** Read the file in `userData`; the defaults when it is missing or unreadable. */
export function loadDesktopSettings(
  dir: string,
  platform: string = process.platform,
): DesktopSettings {
  let raw: string | null = null;
  try {
    raw = readFileSync(path.join(dir, DESKTOP_SETTINGS_FILE), "utf8");
  } catch {
    raw = null;
  }
  return parseDesktopSettings(raw, platform);
}

/**
 * Write the file in `userData`, through a temporary file and a rename. A
 * direct write that is interrupted — the machine loses power, the app is
 * killed mid-quit — leaves a truncated file, and the next launch reads it as
 * corrupt and silently restores the defaults.
 */
export function saveDesktopSettings(dir: string, settings: DesktopSettings): void {
  const target = path.join(dir, DESKTOP_SETTINGS_FILE);
  mkdirSync(dir, { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temp, target);
}
