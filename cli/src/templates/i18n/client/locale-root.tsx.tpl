"use client";

/*
 * Switches the app from the prerendered "__HATCHKIT_SOURCE_LOCALE__" to the
 * reader's language, and lifts the first-paint gate once that render has
 * committed.
 *
 * Mounted once, in app/layout.tsx, around everything that follows the
 * preference. The order of events on a cold load in
 * __HATCHKIT_TARGET_LABEL_EN__:
 *
 *  1. LOCALE_SCRIPT (app/pre-paint.ts) resolves the language before paint,
 *     writes <html lang>, and sets `data-locale-pending` on <html>. The
 *     `[data-locale-gate]` wrapper inside <body> is invisible.
 *  2. React hydrates. Every `useLocale()` answers
 *     "__HATCHKIT_SOURCE_LOCALE__" (the server snapshot), so the tree matches
 *     the served markup and nothing is reported.
 *  3. The layout effect below activates the store. Subscribers re-render
 *     synchronously: an update scheduled in a layout effect is flushed before
 *     the browser paints.
 *  4. The same effect removes the attribute. The first frame the reader ever
 *     sees is already translated.
 *
 * ONE effect, in that order, on purpose. Splitting the activation and the
 * release across two effects — or releasing from a `useEffect` — lets the
 * browser paint in between, and the reader sees a flash of
 * "__HATCHKIT_SOURCE_LOCALE__" before the page settles. That flash is the
 * whole bug this component exists to prevent, and nothing in a test that
 * asserts final text will catch it.
 *
 * It renders `children` directly: no wrapper, no provider. The gate wrapper
 * is in app/layout.tsx, because it has to sit INSIDE <body> — a script that
 * mutates <body> before hydration makes <body>'s attributes disagree with the
 * served HTML.
 */

import * as React from "react";

import { activateResolvedLocale, GATE_ATTR } from "@/i18n/store";

export function LocaleRoot({ children }: { children: React.ReactNode }): React.ReactNode {
  React.useLayoutEffect(() => {
    activateResolvedLocale();
    if (typeof document !== "undefined") {
      document.documentElement.removeAttribute(GATE_ATTR);
    }
  }, []);

  return children;
}
