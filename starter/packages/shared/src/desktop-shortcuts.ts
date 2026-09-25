/**
 * Global shortcuts for the desktop app: which actions can be bound, the one
 * default, and the accelerator grammar both ends agree on.
 *
 * The main process registers accelerators with Electron's `globalShortcut`;
 * the renderer's desktop settings screen records them from a key press. Both
 * parse through {@link normalizeAccelerator}, so a string the recorder
 * produces is exactly a string the main process accepts, and a hand-edited
 * settings file holding something Electron would throw on is refused rather
 * than registered.
 *
 * Pure strings only — this file is bundled into the Electron main process and
 * loaded by the web client, so nothing here may touch Node, Electron or the
 * DOM.
 */

/**
 * Every action a global shortcut can run. Adding one is adding it here, a
 * label in the renderer's settings catalog, and its handling in
 * `electron/src/desktop.ts` (or, when the renderer does the work, in the
 * component that publishes tray state).
 */
export const DESKTOP_SHORTCUT_ACTIONS = [
  /** Show the window, or hide it when it is already in front. */
  "toggle-window",
  /** Show the window and run the app's primary action. */
  "primary-action",
  /** Show the window with the command palette open. */
  "open-palette",
  /** Show the window on the settings screen. */
  "open-settings",
] as const;

export type DesktopShortcutAction = (typeof DESKTOP_SHORTCUT_ACTIONS)[number];

export type DesktopShortcutBindings = Record<DesktopShortcutAction, string | null>;

/**
 * Exactly one default, and it is the window toggle. Three modifiers plus Space
 * is not a default in macOS, Windows, GNOME or KDE, nor in the browsers, VS
 * Code, JetBrains IDEs, Slack, terminals or the launchers (Spotlight, Alfred,
 * Raycast, PowerToys Run), all of which bind one or two modifiers with Space.
 * `CommandOrControl+Alt+Shift+T` is JetBrains' "Refactor This" on Windows and
 * Linux, so it is not a safe default.
 *
 * A global shortcut is taken from every other application on the machine, so
 * shipping more than one default is a cost the person did not agree to. The
 * rest are bindable and start unbound.
 */
export const DEFAULT_DESKTOP_SHORTCUTS: DesktopShortcutBindings = {
  "toggle-window": "CommandOrControl+Alt+Shift+Space",
  "primary-action": null,
  "open-palette": null,
  "open-settings": null,
};

export function isDesktopShortcutAction(value: unknown): value is DesktopShortcutAction {
  return (
    typeof value === "string" && (DESKTOP_SHORTCUT_ACTIONS as readonly string[]).includes(value)
  );
}

/** Canonical modifier names, in the order a canonical accelerator lists them. */
const MODIFIER_ORDER = ["CommandOrControl", "Command", "Control", "Super", "Alt", "Shift"] as const;
export type AcceleratorModifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, AcceleratorModifier> = {
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  command: "Command",
  cmd: "Command",
  control: "Control",
  ctrl: "Control",
  super: "Super",
  meta: "Super",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/** Named keys Electron accepts that a recorder can produce. */
const NAMED_KEYS = [
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Return",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
] as const;
const NAMED_KEY_BY_LOWER = new Map<string, string>(
  NAMED_KEYS.map((key) => [key.toLowerCase(), key]),
);

/** Punctuation keys, as Electron names them (`+` is spelled `Plus`). */
const PUNCTUATION_KEYS = new Set(["-", "=", "[", "]", ";", "'", ",", ".", "/", "\\", "`"]);

function canonicalKey(token: string): string | null {
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (fn) return `F${fn[1]}`;
  if (token.toLowerCase() === "plus") return "Plus";
  if (PUNCTUATION_KEYS.has(token)) return token;
  return NAMED_KEY_BY_LOWER.get(token.toLowerCase()) ?? null;
}

/** Function keys no application binds by default, so they may stand alone. */
const BARE_KEYS = new Set([
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
]);

export type ParsedAccelerator = { modifiers: AcceleratorModifier[]; key: string };

/**
 * An accelerator split into canonical modifiers and key, or null when it is
 * not one this app registers: unknown tokens, a repeated modifier, two keys,
 * no key, or a key that would steal ordinary typing (a bare letter, or one
 * with Shift alone). Alt counts as a modifier here; on macOS Option+letter
 * types a character, which the recorder warns about rather than refuses.
 */
export function parseAccelerator(input: string): ParsedAccelerator | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 80) return null;
  // `+` separates; a trailing `++` would mean the Plus key, which is spelled `Plus`.
  const tokens = trimmed.split("+").map((token) => token.trim());
  if (tokens.some((token) => token === "")) return null;

  const modifiers = new Set<AcceleratorModifier>();
  let key: string | null = null;
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier) {
      if (modifiers.has(modifier)) return null;
      modifiers.add(modifier);
      continue;
    }
    if (key !== null) return null;
    key = canonicalKey(token);
    if (key === null) return null;
  }
  if (key === null) return null;
  // CommandOrControl already means one of the two it names.
  if (modifiers.has("CommandOrControl") && (modifiers.has("Command") || modifiers.has("Control"))) {
    return null;
  }

  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  const hasNonShift = ordered.some((modifier) => modifier !== "Shift");
  if (!hasNonShift && !BARE_KEYS.has(key)) return null;
  return { modifiers: ordered, key };
}

/** The canonical spelling, or null when {@link parseAccelerator} refuses it. */
export function normalizeAccelerator(input: string): string | null {
  const parsed = parseAccelerator(input);
  return parsed === null ? null : [...parsed.modifiers, parsed.key].join("+");
}

/**
 * The physical chord an accelerator means on one platform, for telling two
 * bindings apart: `CommandOrControl+K` and `Command+K` are the same keys on a
 * Mac and different ones on Windows. `Super` is the Command key on macOS.
 */
export function acceleratorChord(input: string, platform: string): string | null {
  const parsed = parseAccelerator(input);
  if (parsed === null) return null;
  const mac = platform === "darwin";
  const resolved = new Set<AcceleratorModifier>(
    parsed.modifiers.map((modifier): AcceleratorModifier => {
      if (modifier === "CommandOrControl") return mac ? "Command" : "Control";
      if (modifier === "Super" && mac) return "Command";
      return modifier;
    }),
  );
  return [...MODIFIER_ORDER.filter((modifier) => resolved.has(modifier)), parsed.key].join("+");
}

/**
 * The action already bound to the same chord, if any. A chord registered
 * twice would run whichever registration the OS kept, so a second binding is
 * refused rather than silently shadowing the first.
 */
export function duplicateShortcutAction(
  bindings: DesktopShortcutBindings,
  action: DesktopShortcutAction,
  accelerator: string,
  platform: string,
): DesktopShortcutAction | null {
  const chord = acceleratorChord(accelerator, platform);
  if (chord === null) return null;
  for (const other of DESKTOP_SHORTCUT_ACTIONS) {
    if (other === action) continue;
    const bound = bindings[other];
    if (bound !== null && acceleratorChord(bound, platform) === chord) return other;
  }
  return null;
}
