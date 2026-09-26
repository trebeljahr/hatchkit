// @vitest-environment jsdom
/*
 * The pre-paint script and the locale store must answer the same question
 * the same way — this is the test that keeps them honest.
 *
 * Two pieces of code resolve the reader's language. `LOCALE_SCRIPT` runs
 * inline in <head> before the first paint, from a string, with no imports;
 * `store.ts` resolves it again in the app, in TypeScript, with the shared
 * resolver. Nothing in the type system connects them, and when they
 * disagree the failure is silent in both directions:
 *
 *   · the script says "not the source language", sets the gate attribute,
 *     and the store then renders the source language anyway — so the gate
 *     waits for a switch that never comes and the reader sees a blank
 *     screen until the failsafe fires;
 *   · the script says "source language" and the store disagrees — so the
 *     page paints in one language and flips to another in front of the
 *     reader, after the gate has already lifted.
 *
 * So the matrix below drives BOTH over the same inputs and asserts they
 * agree on every row: a stored preference crossed with `navigator.languages`,
 * including a language nothing supports, a region variant, a garbage stored
 * value, no localStorage at all and a localStorage that throws (Safari in
 * private mode). Rows without an `expected` assert agreement only — for a
 * value no build understands, agreeing is the whole requirement.
 *
 * It also pins the two things about the gate that are easy to get wrong: the
 * attribute is set EXACTLY when the answer is not the source locale, and it
 * lands on <html> — never on <body>, which would hide the page itself
 * instead of the app subtree.
 *
 * Every row runs twice, against both shapes of the script: the one this build
 * inlines and the one a production build inlines, with the pseudo-locale
 * branch folded out. The second is the one readers actually get, and a
 * difference between them would otherwise only show up in production.
 */

import { SOURCE_LOCALE, type SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATE_ATTR,
  LOCALE_STORAGE_KEY,
  resetLocaleStoreForTests,
  resolveCurrentLocale,
  shouldGateFirstPaint,
} from "../i18n/store";
import { LOCALE_SCRIPT, localeScript } from "./pre-paint";

const TARGET_LOCALE = "__HATCHKIT_TARGET_LOCALE__" as SupportedLocale;
const TARGET_REGION = "__HATCHKIT_TARGET_REGION__";
const GATE_MS = __HATCHKIT_GATE_MS__;

/** How localStorage behaves for a row. "absent" is an embedded WebView with
 *  storage disabled; "throwing" is Safari in private mode, which has the
 *  property but raises on access. Both must resolve a language anyway. */
type StorageMode = "working" | "absent" | "throwing";

interface Row {
  name: string;
  storage?: StorageMode;
  /** Raw value in the mirror, exactly as a browser would hand it back. */
  stored?: string;
  languages: string[];
  /** Left out when no answer is "correct" — then only agreement matters. */
  expected?: SupportedLocale;
}

const ROWS: readonly Row[] = [
  {
    name: "nothing stored, a device in the source language",
    languages: [SOURCE_LOCALE],
    expected: SOURCE_LOCALE,
  },
  {
    name: "nothing stored, a device in the target language",
    languages: [TARGET_LOCALE],
    expected: TARGET_LOCALE,
  },
  {
    // The answer is the LANGUAGE. The region belongs to the device and
    // decides date and number shapes, never which catalog loads.
    name: "a region variant of the target language",
    languages: [`${TARGET_LOCALE}-${TARGET_REGION}`],
    expected: TARGET_LOCALE,
  },
  {
    name: "a region this project never configured",
    languages: [`${TARGET_LOCALE}-CH`],
    expected: TARGET_LOCALE,
  },
  {
    // First SUPPORTED entry wins, not first entry: a device that leads with
    // a language we do not ship still gets its second choice.
    name: "an unsupported language ahead of the target language",
    languages: ["cy", `${TARGET_LOCALE}-CH`],
    expected: TARGET_LOCALE,
  },
  {
    name: "only languages nothing supports",
    languages: ["cy-GB", "gd"],
    expected: SOURCE_LOCALE,
  },
  { name: "an empty device list", languages: [], expected: SOURCE_LOCALE },
  {
    name: "an explicit preference beats the device",
    stored: TARGET_LOCALE,
    languages: [SOURCE_LOCALE],
    expected: TARGET_LOCALE,
  },
  {
    name: '"system" defers to the device',
    stored: "system",
    languages: [TARGET_LOCALE],
    expected: TARGET_LOCALE,
  },
  {
    // The reader chose the source language on a target-language device. This
    // is the row that a naive "device wins" implementation fails.
    name: "an explicit source preference beats a target-language device",
    stored: SOURCE_LOCALE,
    languages: [TARGET_LOCALE],
    expected: SOURCE_LOCALE,
  },
  {
    // Left over from an older build, or hand-edited. No answer is right;
    // both sides answering the same thing is.
    name: "a stored value no build understands",
    stored: "klingon",
    languages: [TARGET_LOCALE],
  },
  {
    name: "no localStorage at all",
    storage: "absent",
    languages: [TARGET_LOCALE],
    expected: TARGET_LOCALE,
  },
  {
    name: "a localStorage that throws on access",
    storage: "throwing",
    languages: [TARGET_LOCALE],
    expected: TARGET_LOCALE,
  },
];

/** Both shapes of the script: the one this build inlines, and the one a
 *  production build inlines — the pseudo-locale branch is folded out of the
 *  second, and it is the second that readers actually get. */
const SHAPES: readonly [string, string][] = [
  ["this build", LOCALE_SCRIPT],
  ["a production build", localeScript("")],
];

for (const [shape, script] of SHAPES) {
  describe(`the pre-paint script (${shape}) and the store`, () => {
    beforeEach(() => {
      // As a fresh page load: nothing activated, nothing pinned.
      resetLocaleStoreForTests();
    });

    afterEach(() => {
      restoreStorage();
      vi.useRealTimers();
    });

    for (const row of ROWS) {
      it(`agree: ${row.name}`, () => {
        applyRow(row);
        runScript(script);

        const fromScript = document.documentElement.getAttribute("data-locale");
        const fromStore = resolveCurrentLocale();

        expect(fromScript).toBe(fromStore);
        if (row.expected) expect(fromStore).toBe(row.expected);

        // `lang` is what a screen reader picks its voice from, so it has to
        // carry the resolved language too, not the served one.
        expect(document.documentElement.lang).toBe(fromStore);

        // The store publishes the same predicate the script inlines, so the
        // two are compared rather than each agreeing with its own re-derivation.
        expect(document.documentElement.hasAttribute(GATE_ATTR)).toBe(shouldGateFirstPaint());

        // And the rule itself, which for these rows (no pinned path, no
        // pseudo-locale) is exactly "the file is in the wrong language".
        // Gate when it is not, and the page waits for a switch that never
        // comes; do not gate when it is, and the reader watches the language
        // change in front of them.
        expect(document.documentElement.hasAttribute(GATE_ATTR)).toBe(fromStore !== SOURCE_LOCALE);

        // The gate hides the app subtree. On <body> it would hide the page.
        expect(document.body.hasAttribute(GATE_ATTR)).toBe(false);
      });
    }

    it("arms a failsafe that lifts the gate without the app", () => {
      // Fake timers before the script runs: the setTimeout it arms is the
      // subject. A chunk that never loads must cost a source-language page,
      // not an invisible one.
      vi.useFakeTimers();
      applyRow({ name: "failsafe", languages: [TARGET_LOCALE] });
      runScript(script);
      expect(document.documentElement.hasAttribute(GATE_ATTR)).toBe(true);

      vi.advanceTimersByTime(GATE_MS - 1);
      expect(
        document.documentElement.hasAttribute(GATE_ATTR),
        "the gate lifted early — the app never gets its chance to render the translation",
      ).toBe(true);

      vi.advanceTimersByTime(2);
      expect(document.documentElement.hasAttribute(GATE_ATTR)).toBe(false);
    });
  });
}

it("ships no pseudo-locale in the production shape", () => {
  // The dev shape may mention it; the string a production build inlines must
  // not, because nothing in it can ever be reached from a production page.
  expect(localeScript("")).not.toMatch(/pseudo/i);
});

/** Evaluate a script the way the browser does: from the same string, in
 *  global scope, with no module wrapper. Reaching for its internals would
 *  test a copy of the code the page never runs. */
function runScript(script: string): void {
  new Function(script)();
}

function applyRow(row: Row): void {
  resetDocument();
  setDeviceLanguages(row.languages);
  useStorage(row.storage ?? "working", row.stored);
}

function resetDocument(): void {
  const html = document.documentElement;
  html.removeAttribute("lang");
  html.removeAttribute("data-locale");
  html.removeAttribute(GATE_ATTR);
  document.body.removeAttribute(GATE_ATTR);
}

function setDeviceLanguages(languages: readonly string[]): void {
  // `language` as well as `languages`: a WebView may expose only the first,
  // and both sides are allowed to read either.
  Object.defineProperty(window.navigator, "languages", {
    value: [...languages],
    configurable: true,
  });
  Object.defineProperty(window.navigator, "language", {
    value: languages[0] ?? "",
    configurable: true,
  });
}

const REAL_STORAGE = Object.getOwnPropertyDescriptor(window, "localStorage");

function useStorage(mode: StorageMode, stored?: string): void {
  if (mode === "working") {
    restoreStorage();
    window.localStorage.clear();
    if (stored !== undefined) window.localStorage.setItem(LOCALE_STORAGE_KEY, stored);
    return;
  }

  const denied = () => {
    throw new Error("The operation is insecure.");
  };
  const value =
    mode === "absent"
      ? undefined
      : { getItem: denied, setItem: denied, removeItem: denied, clear: denied };

  Object.defineProperty(window, "localStorage", { value, configurable: true, writable: true });
}

function restoreStorage(): void {
  if (REAL_STORAGE) Object.defineProperty(window, "localStorage", REAL_STORAGE);
  else Reflect.deleteProperty(window, "localStorage");
}
