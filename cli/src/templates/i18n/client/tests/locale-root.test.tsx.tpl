// @vitest-environment jsdom
/*
 * Hydration over REAL prerendered markup, with the console treated as a
 * test failure.
 *
 * Every HTML file this project exports is prerendered in the source locale,
 * and hydration has to match it exactly. When it does not, React reports the
 * text mismatch ONCE, in the console, and then "fixes" it by throwing the
 * served DOM away and re-rendering on the client. Nothing throws, the page
 * looks right, and the cost — a blank frame, lost event handlers, a
 * client-side render of a page that was supposed to be static — ships. An
 * unwatched console is how that bug reaches production, so this test fails
 * on any console.error or console.warn during hydration.
 *
 * The sequence mirrors the real one: render the tree to a string (the build),
 * put that string in the DOM (the served file), run the pre-paint script
 * against a device asking for the target language (the browser), and only
 * then hydrate. `useLocale()` must answer the SOURCE locale during
 * hydration — that is what `useSyncExternalStore`'s server snapshot is for —
 * and the real language may only arrive in <LocaleRoot>'s layout effect,
 * in the same flush that clears the gate.
 *
 * The second case is the failsafe, and it is deliberately the opposite
 * scenario: the app never activates at all, because its chunk failed to
 * load. The gate must lift anyway and leave a readable source-language page,
 * because a source-language page beats an invisible one.
 */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { SOURCE_LOCALE, type SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALE_SCRIPT } from "../app/pre-paint";
import { LocaleRoot } from "./locale-root";
import { MESSAGES } from "./messages";
import { GATE_ATTR } from "./store";
import { useT } from "./use-t";

declare global {
  /** React refuses to flush effects inside act() without this, and says so
   *  on the console — which this test reads as a failure. */
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TARGET_LOCALE = "__HATCHKIT_TARGET_LOCALE__" as SupportedLocale;
const GATE_MS = __HATCHKIT_GATE_MS__;

/** One ordinary message, taken from `common` so the assertion reads the
 *  catalogs instead of hardcoding a translation that a translator is free
 *  to improve tomorrow. */
const PROBE_KEY = "actions.save";
const SOURCE_TEXT = messageAt(MESSAGES[SOURCE_LOCALE].common, PROBE_KEY);
const TARGET_TEXT = messageAt(MESSAGES[TARGET_LOCALE].common, PROBE_KEY);

function Probe() {
  const t = useT("common");
  return <p data-testid="probe">{t(PROBE_KEY)}</p>;
}

const tree = (
  <LocaleRoot>
    <Probe />
  </LocaleRoot>
);

describe("<LocaleRoot>", () => {
  let root: ReturnType<typeof hydrateRoot> | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    // Real timers first: unmounting runs effects, and effects on a fake
    // clock hang instead of finishing.
    vi.useRealTimers();
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    resetDocument();
  });

  it("hydrates prerendered source-language markup with a silent console", async () => {
    const el = mount();
    container = el;
    // The build. Rendered before the console is watched: what a build logs
    // is the build's business, and useLayoutEffect has nothing to say on a
    // server anyway.
    const served = renderToString(tree);
    expect(served, "the prerendered file must contain the SOURCE language").toContain(SOURCE_TEXT);
    el.innerHTML = served;

    setDeviceLanguages([TARGET_LOCALE]);
    runLocaleScript();
    expect(
      document.documentElement.hasAttribute(GATE_ATTR),
      "the script should have gated: the device asks for a language the file is not in",
    ).toBe(true);

    const watch = watchConsole();
    await act(async () => {
      root = hydrateRoot(el, tree);
    });
    watch.restore();

    // A hydration text mismatch lands here, and nowhere else.
    expect(watch.messages).toEqual([]);

    expect(probeText(container)).toBe(TARGET_TEXT);
    expect(document.documentElement.getAttribute("data-locale")).toBe(TARGET_LOCALE);
    // Cleared in the same flush as the translated render — a gate that
    // outlives the render is a page nobody can read.
    expect(document.documentElement.hasAttribute(GATE_ATTR)).toBe(false);
  });

  it("lifts the gate on its own when the app never activates", () => {
    // The app's chunk never arrives, so nothing ever calls
    // activateResolvedLocale(). Only the script's own timer can save the
    // page here.
    vi.useFakeTimers();
    container = mount();
    container.innerHTML = renderToString(tree);
    setDeviceLanguages([TARGET_LOCALE]);
    runLocaleScript();
    expect(document.documentElement.hasAttribute(GATE_ATTR)).toBe(true);

    vi.advanceTimersByTime(GATE_MS + 1);

    expect(document.documentElement.hasAttribute(GATE_ATTR)).toBe(false);
    expect(probeText(container), "the served markup must still be readable").toBe(SOURCE_TEXT);
  });
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function mount(): HTMLDivElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

function probeText(container: HTMLDivElement | null): string {
  return container?.querySelector('[data-testid="probe"]')?.textContent ?? "";
}

/** Evaluate the script the way the browser does — from the same string, in
 *  global scope. Reaching for its internals would test a copy of the code
 *  the page never runs. */
function runLocaleScript(): void {
  new Function(LOCALE_SCRIPT)();
}

function setDeviceLanguages(languages: readonly string[]): void {
  Object.defineProperty(window.navigator, "languages", {
    value: [...languages],
    configurable: true,
  });
  Object.defineProperty(window.navigator, "language", {
    value: languages[0] ?? "",
    configurable: true,
  });
}

function resetDocument(): void {
  const html = document.documentElement;
  html.removeAttribute("lang");
  html.removeAttribute("data-locale");
  html.removeAttribute(GATE_ATTR);
}

interface ConsoleWatch {
  messages: string[];
  restore(): void;
}

/** Collect instead of print: the messages are the assertion, and a failure
 *  has to show them rather than bury them in the runner's output. */
function watchConsole(): ConsoleWatch {
  const messages: string[] = [];
  const capture =
    (label: string) =>
    (...args: unknown[]) => {
      messages.push(`${label}: ${args.map(String).join(" ")}`);
    };
  const error = vi.spyOn(console, "error").mockImplementation(capture("console.error"));
  const warn = vi.spyOn(console, "warn").mockImplementation(capture("console.warn"));
  return {
    messages,
    restore() {
      error.mockRestore();
      warn.mockRestore();
    },
  };
}

/** Read a dotted key out of a catalog without depending on how the catalog
 *  is typed. */
function messageAt(catalog: unknown, key: string): string {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") break;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") {
    throw new Error(`the common catalog has no message at "${key}" — pick another probe key`);
  }
  return node;
}
