/*
 * What the tray draws, as data: the menu template, the tooltip and which icon
 * file. `tray.ts` turns this into Electron objects; a headless run uses the
 * same functions and creates nothing. No Electron import, so every rule here
 * is unit-tested with `node:test`.
 *
 * The renderer owns the app's state and its locale. It publishes a
 * `DesktopTrayState` and this file lays it out — it decides nothing. A
 * main-process copy of "what is going on" drifts the moment a renderer action
 * fails, and the drift is invisible, because the menu bar keeps showing the
 * old answer.
 */

import {
  MAX_TRAY_ITEMS,
  type DesktopNotice,
  type DesktopTrayItem,
  type DesktopTrayLabels,
  type DesktopTrayState,
} from "../../packages/shared/src/desktop-bridge.ts";

/**
 * English, for the moments no renderer has published labels yet: before the
 * first page load, and signed out on a first launch. The last labels a
 * renderer sent are remembered on disk (`desktop.ts`), so a person whose app
 * is in another language sees these only once.
 *
 * `quitPendingTitle` is empty, which turns the quit notice off. A renderer
 * fills it in only while it has work that has not been sent.
 */
export const FALLBACK_TRAY_LABELS: DesktopTrayLabels = {
  open: "Open {{projectName}}",
  settings: "Settings…",
  quit: "Quit {{projectName}}",
  idleTooltip: "{{projectName}}",
  badgeDescription: "{{projectName}} has pending items",
  itemsHeading: "",
  quitPendingTitle: "",
  quitPendingBody: "",
  quitPendingButton: "Quit",
  restartToUpdate: "Restart to update",
};

/** A tray label is one line in a menu. Longer strings are cut rather than refused. */
const MAX_TEXT = 200;
/** The quit notice's body is a sentence, so labels get more room than items. */
const MAX_LABEL = 600;
/** An item key is opaque and comes back in a command; this bounds what a page can send. */
const MAX_KEY = 500;

/**
 * One entry of the Electron menu template, as plain data.
 *
 * The field names are Electron's, so `tray.ts` passes an entry to
 * `Menu.buildFromTemplate` after adding the `click` handler and nothing has to
 * be translated in between. `id` is this app's click id, which Electron also
 * accepts on a menu item and ignores.
 */
export interface TrayMenuEntry {
  /** What `tray.ts` reports on a click. Absent on a separator and a heading. */
  id?: string;
  label?: string;
  type?: "separator" | "checkbox";
  enabled?: boolean;
  checked?: boolean;
}

export interface TrayMenuContext {
  /** An update is downloaded and waiting for a restart. */
  updateReady?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : null;
}

export function parseTrayLabels(value: unknown): DesktopTrayLabels {
  const labels = { ...FALLBACK_TRAY_LABELS };
  if (!isRecord(value)) return labels;
  for (const key of Object.keys(labels) as (keyof DesktopTrayLabels)[]) {
    const candidate = value[key];
    if (typeof candidate === "string") labels[key] = candidate.slice(0, MAX_LABEL);
  }
  return labels;
}

/**
 * The renderer's payload, checked field by field: it crossed IPC, so nothing
 * in it is trusted to have the declared shape. Items past
 * {@link MAX_TRAY_ITEMS} are dropped here rather than in the menu, so the test
 * hooks and the menu agree on what the tray holds.
 */
export function parseTrayState(value: unknown): DesktopTrayState | null {
  if (!isRecord(value) || typeof value.signedIn !== "boolean") return null;
  const items: DesktopTrayItem[] = [];
  if (Array.isArray(value.items)) {
    for (const entry of value.items) {
      if (items.length >= MAX_TRAY_ITEMS) break;
      if (!isRecord(entry) || typeof entry.key !== "string" || entry.key === "") continue;
      items.push({
        key: entry.key.slice(0, MAX_KEY),
        label: text(entry.label),
        hint: nullableText(entry.hint),
        checked: entry.checked === true,
        disabled: entry.disabled === true,
      });
    }
  }
  const badge =
    typeof value.badge === "number" && Number.isFinite(value.badge)
      ? Math.max(0, Math.floor(value.badge))
      : 0;
  return {
    signedIn: value.signedIn,
    status: value.signedIn ? nullableText(value.status) : null,
    // Signed out there is nothing of the person's to show in a menu anyone
    // walking past the machine can open.
    items: value.signedIn ? items : [],
    badge,
    labels: parseTrayLabels(value.labels),
  };
}

/** A notice from the renderer, checked; null when it carries no title to show. */
export function parseNotice(value: unknown): DesktopNotice | null {
  if (!isRecord(value)) return null;
  const title = text(value.title).trim();
  if (title === "") return null;
  const tag = text(value.tag).trim().slice(0, 100);
  return { title, body: text(value.body), tag: tag === "" ? "notice" : tag };
}

/** The click id for a published item. `tray.ts` and `desktop.ts` both split on this prefix. */
export const TRAY_ITEM_PREFIX = "item:";

function itemEntry(item: DesktopTrayItem): TrayMenuEntry {
  const label = item.label.trim() === "" ? item.key : item.label;
  const entry: TrayMenuEntry = {
    id: `${TRAY_ITEM_PREFIX}${item.key}`,
    // The hint goes on the same line as the label, on every platform.
    //
    // Electron has two second lines, and neither carries a hint everywhere.
    // `sublabel` is macOS 14.4 and later, so an older Mac would show no hint
    // at all. A submenu holding a disabled line works on all three, but a
    // menu item that owns a submenu no longer reports a click — the hint
    // would cost the person the command it describes.
    label: item.hint === null || item.hint === "" ? label : `${label} — ${item.hint}`,
    enabled: item.disabled !== true,
  };
  if (item.checked === true) {
    entry.type = "checkbox";
    entry.checked = true;
  }
  return entry;
}

/**
 * The tray menu, as an Electron template.
 *
 * Signed in: the status line, the published items under their heading, then
 * Open, Settings and Quit. Signed out, or before any state arrived: Open and
 * Quit, and nothing that names the person's work.
 *
 * With a downloaded update, "Restart to update" sits above Quit in either
 * menu. The person picks the moment; the app never restarts by itself.
 *
 * Click ids are `item:<key>`, `open`, `settings`, `restart-to-update` and
 * `quit`. A heading carries no id and is disabled, which is how a menu draws
 * a line that is not a command.
 */
export function trayMenuTemplate(
  state: DesktopTrayState | null,
  context: TrayMenuContext = {},
): TrayMenuEntry[] {
  const labels = state?.labels ?? FALLBACK_TRAY_LABELS;
  const restart: TrayMenuEntry[] = context.updateReady
    ? [{ id: "restart-to-update", label: labels.restartToUpdate, enabled: true }]
    : [];

  if (state === null || !state.signedIn) {
    return [
      { id: "open", label: labels.open, enabled: true },
      { type: "separator" },
      ...restart,
      { id: "quit", label: labels.quit, enabled: true },
    ];
  }

  const entries: TrayMenuEntry[] = [];
  if (state.status !== null && state.status !== "") {
    entries.push({ label: state.status, enabled: false });
    entries.push({ type: "separator" });
  }
  const items = state.items.slice(0, MAX_TRAY_ITEMS);
  if (items.length > 0) {
    if (labels.itemsHeading !== "") entries.push({ label: labels.itemsHeading, enabled: false });
    for (const item of items) entries.push(itemEntry(item));
    entries.push({ type: "separator" });
  }
  entries.push({ id: "open", label: labels.open, enabled: true });
  entries.push({ id: "settings", label: labels.settings, enabled: true });
  entries.push({ type: "separator" });
  entries.push(...restart);
  entries.push({ id: "quit", label: labels.quit, enabled: true });
  return entries;
}

/**
 * The tooltip: the published status line, else the idle label. Windows and
 * Linux show it on hover; macOS shows it beside the menu bar icon only when
 * the item has no title, which this tray does not set.
 */
export function trayTooltip(state: DesktopTrayState | null): string {
  const labels = state?.labels ?? FALLBACK_TRAY_LABELS;
  if (state === null || !state.signedIn) return labels.idleTooltip;
  const status = state.status?.trim() ?? "";
  return status === "" ? labels.idleTooltip : `${labels.idleTooltip} · ${status}`;
}

/**
 * The tray icon file for a platform, under `electron/dist/tray`
 * (`pnpm icons:desktop`).
 *
 * macOS takes a template image: a black-and-transparent PNG the system tints
 * for a light or a dark menu bar. A coloured icon there stays coloured and
 * disappears against one of the two. Windows takes an `.ico`, which carries
 * the several sizes the notification area picks between; a PNG scaled by
 * Windows is visibly soft. Linux takes a PNG.
 */
export function trayIconFile(platform: string): string {
  if (platform === "darwin") return "trayTemplate.png";
  if (platform === "win32") return "tray.ico";
  return "tray.png";
}

/** The Windows taskbar overlay image, drawn when the badge count is not zero. */
export const TRAY_OVERLAY_FILE = "overlay-badge.png";
