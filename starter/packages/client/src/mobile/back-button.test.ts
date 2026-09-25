// @vitest-environment jsdom
/*
 * Two kinds of test here.
 *
 * 1. A SOURCE-LEVEL PIN. The two-press-with-keyboard behaviour documented in
 *    back-button.ts is correct platform behaviour, but it reads as a bug, so
 *    sooner or later someone "fixes" it by importing the Capacitor keyboard
 *    plugin and hiding the keyboard from the back handler. That takes the back
 *    key away from the IME and leaves users unable to dismiss the keyboard.
 *    No behavioural test can catch it — the fix works, it is just wrong — so
 *    the module's own source is read and checked instead.
 *
 * 2. Behavioural tests for the handling order and for the LIFO teardown.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTopOverlay,
  overlayCount,
  pushOverlay,
} from "./overlay-stack";
import {
  handleBackButton,
  setBackButtonHome,
  setBackButtonNavigate,
} from "./back-button";

const backButtonSource = readFileSync(
  fileURLToPath(new URL("./back-button.ts", import.meta.url)),
  "utf8",
);

/**
 * The rationale HAS to live in a comment, so the ban can only be checked
 * against code. Strip comments first, then look.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("back-button source", () => {
  it("does not reach for the keyboard plugin", () => {
    const code = stripComments(backButtonSource);
    expect(code).not.toMatch(/@capacitor\/keyboard/);
    expect(code).not.toMatch(/\bKeyboard\b/);
  });

  it("still explains why, so the ban is not cargo cult", () => {
    expect(backButtonSource).toMatch(/two/i);
    expect(backButtonSource).toMatch(/IME/);
  });

  it("does not read event.canGoBack", () => {
    // canGoBack is true almost always in a single-page app, because tab
    // switches push history entries. Gating exit on it means back can never
    // exit the app.
    expect(stripComments(backButtonSource)).not.toMatch(/canGoBack/);
  });
});

describe("overlay stack", () => {
  beforeEach(() => {
    while (closeTopOverlay()) {
      /* drain */
    }
  });

  it("closes the most recently pushed overlay first", () => {
    const order: string[] = [];
    pushOverlay(() => order.push("first"));
    pushOverlay(() => order.push("second"));

    expect(closeTopOverlay()).toBe(true);
    expect(closeTopOverlay()).toBe(true);
    expect(closeTopOverlay()).toBe(false);
    expect(order).toEqual(["second", "first"]);
  });

  it("teardown removes only the entry that pushed it", () => {
    const order: string[] = [];
    const removeFirst = pushOverlay(() => order.push("first"));
    pushOverlay(() => order.push("second"));

    // Out-of-order unmount: the older overlay goes away while a newer one is
    // still open. A pop-based teardown would discard "second" instead.
    removeFirst();

    expect(overlayCount()).toBe(1);
    expect(closeTopOverlay()).toBe(true);
    expect(order).toEqual(["second"]);
  });

  it("teardown is idempotent", () => {
    const remove = pushOverlay(() => {});
    pushOverlay(() => {});
    remove();
    remove();
    expect(overlayCount()).toBe(1);
  });

  it("gives distinct entries to overlays sharing one close function", () => {
    const close = () => {};
    const removeA = pushOverlay(close);
    pushOverlay(close);
    removeA();
    expect(overlayCount()).toBe(1);
  });
});

describe("handleBackButton", () => {
  beforeEach(() => {
    while (closeTopOverlay()) {
      /* drain */
    }
    setBackButtonHome("/");
  });

  it("closes an open overlay before touching navigation", () => {
    const close = vi.fn();
    const navigate = vi.fn();
    setBackButtonNavigate(navigate);
    setBackButtonHome("/home");
    pushOverlay(close);

    expect(handleBackButton()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates home when nothing is open and we are elsewhere", () => {
    const navigate = vi.fn();
    const restore = setBackButtonNavigate(navigate);
    setBackButtonHome("/home"); // jsdom's pathname is "/"

    expect(handleBackButton()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/home");
    restore();
  });

  it("returns false at home with nothing open, meaning exit", () => {
    const navigate = vi.fn();
    const restore = setBackButtonNavigate(navigate);
    setBackButtonHome("/");

    expect(handleBackButton()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    restore();
  });

  it("consumes the press even when an overlay's close throws", () => {
    setBackButtonHome("/home");
    const navigate = vi.fn();
    const restore = setBackButtonNavigate(navigate);
    pushOverlay(() => {
      throw new Error("close blew up");
    });

    expect(handleBackButton()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    restore();
  });
});
