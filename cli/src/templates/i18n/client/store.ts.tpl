"use client";

/*
 * Which language this device renders, held outside React.
 *
 * Outside React for three reasons: the pre-paint script in app/pre-paint.ts
 * has already decided the answer before React exists, the two places that
 * change it (the picker and the server sync) live in different trees, and
 * non-component code — a toast fired from a mutation callback — must read the
 * same value the components render.
 *
 * THE HYDRATION ANSWER IS THE SOURCE LOCALE, BY CONSTRUCTION. Every HTML file
 * this project exports outside /<locale>/ is prerendered in
 * "__HATCHKIT_SOURCE_LOCALE__", and hydration has to match it byte for byte.
 * So {@link getSnapshot} answers SOURCE_LOCALE until {@link
 * activateResolvedLocale} has run, and {@link getServerSnapshot} answers it
 * always. <LocaleRoot> calls the activation in a layout effect, after
 * hydration has committed. Returning the reader's language earlier is a text
 * mismatch on every string of their first paint: React reports it once and
 * then "fixes" it by throwing the served DOM away and re-rendering from
 * scratch — which looks like it worked, which is why this fails silently.
 *
 * There is no cached "current locale" variable on purpose. localStorage plus
 * `navigator.languages` ARE the state; this module only decides whether React
 * is allowed to see them yet. A snapshot that reads them live cannot go stale
 * against another tab, and there is nothing to reset between tests but one
 * boolean.
 *
 * KEEP IN LOCKSTEP WITH app/pre-paint.ts. The script resolves the same answer
 * before paint and the gate it sets is lifted on the strength of that
 * agreement; pre-paint.test.ts runs both over the same inputs and fails when
 * they disagree, because a disagreement either lifts the gate on the wrong
 * language or waits for a switch that never comes.
 */

import {
  SOURCE_LOCALE,
  isSupportedLocale,
  resolveLocale,
  type LocalePreference,
  type SupportedLocale,
} from "__HATCHKIT_PKG_SCOPE__/shared";

/** The synchronous mirror of the synced account preference. Read before
 *  paint by the script in app/pre-paint.ts, which hardcodes this string. */
export const LOCALE_STORAGE_KEY = "locale-preference";

/** The dev-only pseudo-locale switch. Also hardcoded in the script. */
export const PSEUDO_STORAGE_KEY = "locale-pseudo";

/** Set on <html> by the pre-paint script while the rendered language is
 *  still the source one, and removed by <LocaleRoot> in the same flush as
 *  the translated render. */
export const GATE_ATTR = "data-locale-pending";

/** The app-subtree wrapper globals.css hides while {@link GATE_ATTR} is
 *  present. On a wrapper INSIDE <body>, never on <body> itself: a script
 *  that mutates <body> before hydration makes its attributes disagree with
 *  the served HTML, and the only cure is `suppressHydrationWarning` on
 *  <body> — which then silences every other body-level mismatch forever. */
export const GATE_SCOPE_ATTR = "data-locale-gate";

/** Opts a subtree back out of the gate. <FixedLocale> sets it: a
 *  prerendered per-language page is already in its final language and must
 *  not be held on a blank screen waiting for JavaScript it does not need. */
export const GATE_EXEMPT_ATTR = "data-locale-fixed";

/** Mirrors the resolved language onto <html> for CSS and for anything that
 *  reads the DOM (a screenshot test, an extension). */
export const LOCALE_ATTR = "data-locale";

/** Present while the pseudo-locale is on. Never in a production build. */
export const PSEUDO_ATTR = "data-pseudo-locale";

const DEV = process.env.NODE_ENV !== "production";

// ── storage, guarded ─────────────────────────────────────────────────

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode, or a WebView with site data blocked. The preference
    // simply does not survive the reload; that costs one gated frame.
    return null;
  }
}

function write(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* see read() */
  }
}

function isPreference(value: unknown): value is LocalePreference {
  return value === "system" || isSupportedLocale(value);
}

/** The stored preference, or "system" when there is none. */
export function readStoredPreference(): LocalePreference {
  const stored = read(LOCALE_STORAGE_KEY);
  return isPreference(stored) ? stored : "system";
}

export function writeStoredPreference(p: LocalePreference): void {
  write(LOCALE_STORAGE_KEY, p);
}

/** The device's languages, most preferred first. Safe on the server, where
 *  there is no device — which is why the server never resolves "system". */
export function deviceLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [];
}

/**
 * The locale a prerendered public page under /<locale>/ is pinned to.
 *
 * Those pages exist once per language and are rendered at build time in
 * that language, so the preference must not apply to them: a reader with
 * "__HATCHKIT_SOURCE_LOCALE__" stored who opens a shared
 * /__HATCHKIT_TARGET_LOCALE__/ link is reading that page in
 * __HATCHKIT_TARGET_LABEL_EN__, and switching it would replace the page
 * they were sent. The pre-paint script applies the same rule, so the two
 * still agree. <FixedLocale> pins the React tree the same way.
 */
export function pinnedPathLocale(): SupportedLocale | null {
  if (typeof location === "undefined") return null;
  const segment = location.pathname.split("/")[1] ?? "";
  if (segment === SOURCE_LOCALE) return null;
  return isSupportedLocale(segment) ? segment : null;
}

/**
 * Whether the pseudo-locale is on for this browser.
 *
 * `?locale=pseudo` turns it on, `?locale=off` turns it off, and the
 * pre-paint script persists whichever it saw. Read-only here: a snapshot
 * React calls during render must not write to storage.
 */
export function isPseudoActive(): boolean {
  if (!DEV || typeof window === "undefined") return false;
  let query: string | null = null;
  try {
    query = new URLSearchParams(location.search).get("locale");
  } catch {
    query = null;
  }
  if (query === "pseudo") return true;
  if (query === "off") return false;
  return read(PSEUDO_STORAGE_KEY) === "1";
}

/** Dev-only: switch the pseudo-locale on or off for this browser. */
export function setPseudoOverride(on: boolean): void {
  if (!DEV) return;
  write(PSEUDO_STORAGE_KEY, on ? "1" : null);
  syncHtml();
  emit();
}

// ── the store ────────────────────────────────────────────────────────

type Listener = () => void;

const listeners = new Set<Listener>();
let activated = false;
let fixed: SupportedLocale | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * What the reader should actually see, right now — the answer the pre-paint
 * script wrote onto <html> before React existed.
 *
 * Precedence, and the script repeats it exactly: a pinned subtree or page,
 * then the stored preference, then the device's languages, then the source
 * locale.
 */
export function resolveCurrentLocale(): SupportedLocale {
  return fixed ?? pinnedPathLocale() ?? resolveLocale(readStoredPreference(), deviceLocales());
}

/**
 * Exactly the condition the pre-paint script uses to set {@link GATE_ATTR}.
 *
 * Named so that pre-paint.test.ts can assert the two agree per row rather
 * than re-deriving the rule and agreeing with itself.
 */
export function shouldGateFirstPaint(): boolean {
  if (pinnedPathLocale() !== null) return false;
  return resolveCurrentLocale() !== SOURCE_LOCALE || isPseudoActive();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** CLIENT snapshot. SOURCE_LOCALE until {@link activateResolvedLocale}
 *  runs — see the hydration note at the top of this file. */
export function getSnapshot(): SupportedLocale {
  return activated ? resolveCurrentLocale() : SOURCE_LOCALE;
}

/** SERVER snapshot: SOURCE_LOCALE, always, by construction. */
export function getServerSnapshot(): SupportedLocale {
  return SOURCE_LOCALE;
}

export function isActivated(): boolean {
  return activated;
}

function syncHtml(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const locale = resolveCurrentLocale();
  root.lang = locale;
  root.setAttribute(LOCALE_ATTR, locale);
  if (DEV) {
    if (isPseudoActive()) root.setAttribute(PSEUDO_ATTR, "");
    else root.removeAttribute(PSEUDO_ATTR);
  }
}

/**
 * Let React see the reader's language. Called once, from <LocaleRoot>'s
 * layout effect, after hydration has matched the served markup.
 *
 * An update scheduled from a layout effect is flushed before the browser
 * paints, so the first visible frame is already translated — which is what
 * makes it safe for <LocaleRoot> to lift the gate immediately afterwards.
 */
export function activateResolvedLocale(): void {
  if (activated) return;
  activated = true;
  syncHtml();
  emit();
}

/** A language the person chose on this device: stored, then published. */
export function setPreference(p: LocalePreference): void {
  writeStoredPreference(p);
  if (activated) syncHtml();
  emit();
}

/**
 * Pin every non-component read to one locale, for the lifetime of a
 * prerendered per-language page. <FixedLocale> sets it from a layout effect
 * and clears it on unmount; the React tree gets the same answer from the
 * context, which is what keeps the prerender and the hydration identical.
 */
export function setFixedLocaleOverride(locale: SupportedLocale | null): void {
  if (fixed === locale) return;
  fixed = locale;
  if (activated) syncHtml();
  emit();
}

// ── the message transform (pseudo-locale) ────────────────────────────

export type MessageTransform = (message: string) => string;

let transform: MessageTransform | null = null;

/**
 * Register a transform applied to every message before ICU formatting.
 *
 * A registry rather than an import because i18n/pseudo.ts is OPTIONAL: it is
 * written only when the feature was configured with the pseudo-locale on, so
 * nothing that always exists may import it. `import "@/i18n/pseudo";` from
 * anywhere in a dev build registers it; with nothing registered the
 * pseudo-locale silently renders as the source language, which is the right
 * failure for a development-only tool.
 */
export function setMessageTransform(fn: MessageTransform | null): void {
  transform = fn;
  emit();
}

export function getMessageTransform(): MessageTransform | null {
  return transform;
}

/** Test-only: forget everything, as a fresh page load would. */
export function resetLocaleStoreForTests(): void {
  activated = false;
  fixed = null;
  transform = null;
  emit();
}
