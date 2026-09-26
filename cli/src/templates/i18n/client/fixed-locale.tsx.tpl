"use client";

/*
 * Pins a subtree to one language, whatever the reader's preference says.
 *
 * For the public pages, which exist once per language (`/` and
 * `/<locale>/`), are rendered at build time in that language, and must
 * hydrate and stay in it. A reader with "__HATCHKIT_SOURCE_LOCALE__" stored
 * who opens a shared /__HATCHKIT_TARGET_LOCALE__/ link is reading that page
 * in __HATCHKIT_TARGET_LABEL_EN__; switching it after hydration would
 * replace the page they were sent with a different one.
 *
 * THE CONTEXT DEFAULT IS `null`, MEANING "FOLLOW THE STORE". That is what
 * keeps this out of the root: a project that mounts no provider behaves
 * exactly as it did before i18n was added, and every existing component test
 * renders in the source locale without being wrapped in anything.
 *
 * `useLocale()` reads the context BEFORE the store, so the pinned answer is
 * the same during the build render and during hydration — there is no
 * mismatch to report and nothing to switch afterwards.
 */

import * as React from "react";
import type { SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";

import { setFixedLocaleOverride } from "@/i18n/store";

/** `null` means "follow the store". Read by useLocale() in i18n/use-t.ts. */
export const FixedLocaleContext = React.createContext<SupportedLocale | null>(null);

export function FixedLocale({
  locale,
  className,
  children,
  ...rest
}: {
  locale: SupportedLocale;
  className?: string;
  children: React.ReactNode;
} & { [data: `data-${string}`]: string | undefined }): React.JSX.Element {
  // Non-component code on this page — a toast, a filename — must agree with
  // what the components render. Set from an effect, not during render: the
  // store is module state, and writing to it while rendering would leak this
  // page's language into anything else React happens to render next.
  React.useEffect(() => {
    setFixedLocaleOverride(locale);
    return () => setFixedLocaleOverride(null);
  }, [locale]);

  // A real box, never `display: contents`. This is the first DOM node of
  // every public page, and Next's layout router scrolls to it on a
  // client-side navigation — it skips any node whose rect is all zeros, and
  // a `contents` box has no rect, so the new page would keep the previous
  // page's scroll position. Callers style the box through `className`.
  //
  // `lang` scopes the language for screen readers and crawlers even where
  // <html lang> still says otherwise. `data-locale-fixed` (GATE_EXEMPT_ATTR
  // in i18n/store.ts, and the selector globals.css opts back in) exempts the
  // subtree from the first-paint gate, which it does not need: this page is
  // already in its final language. Written out rather than interpolated from
  // the constant so a `grep data-locale-fixed` finds the CSS and this
  // together.
  return (
    <FixedLocaleContext.Provider value={locale}>
      <div {...rest} data-locale-fixed="" lang={locale} className={className}>
        {children}
      </div>
    </FixedLocaleContext.Provider>
  );
}
