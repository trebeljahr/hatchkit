/*
 * The frame every public page sits in, once per language.
 *
 * A server component on purpose: the whole point of the per-language
 * directories is that `next build` writes translated markup into the HTML
 * file, so a crawler and a first-time reader get the translation without
 * running any JavaScript. Nothing in here may read the locale store.
 *
 * `<FixedLocale>` PINS the locale for this subtree. A public page must not
 * follow the reader's preference: the HTML under /de/ is German in the file,
 * and a preference-following subtree would re-render it in another language
 * during hydration — which React reports as a text mismatch and "fixes" by
 * throwing the served markup away. Pinning also exempts the page from the
 * first-paint gate: there is nothing to wait for when the answer is already
 * baked in.
 *
 * WHY `lang` SITS ON THE CONTENT WRAPPER and not on <html>: a static export
 * has one root layout, and giving a prefixed route its own <html lang> means
 * a second root layout, which means moving every other route into a route
 * group. So `<FixedLocale>`'s own box — the first DOM node of every public
 * page — carries `lang`, and the pre-paint script in <head> sets the
 * attribute on <html> before the first paint. Screen readers and the
 * browser's hyphenation read the nearest `lang`, so the content is correctly
 * tagged either way. Do not add a second `lang` here: two of them on nested
 * elements is a silent invitation for the inner one to go stale.
 *
 * Route shape — why this is not a `[locale]` segment — is explained in
 * ./localized-path.ts. Read that before adding a page.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { createTranslator } from "use-intl/core";
import { LOCALE_ENDONYMS, type SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";
import { FixedLocale } from "@/i18n/fixed-locale";
import { messagesFor } from "@/i18n/messages";
import { localeAlternates } from "./localized-path";

/** The build-time translator for the public pages: an explicit locale
 *  rather than the store's answer, because at build time there is no
 *  reader and no device to ask. Lives here because the shell is the
 *  marketing surface's entry point; the page components and
 *  `marketingMetadata` both take it from here so a page's <title> and its
 *  body can never come out in two different languages. */
export function marketingT(locale: SupportedLocale) {
  return createTranslator({ locale, messages: messagesFor(locale), namespace: "marketing" });
}

export function MarketingShell({
  locale,
  path,
  children,
}: {
  locale: SupportedLocale;
  /** This page's SOURCE-language pathname ("/" for the landing page). The
   *  language list rewrites it per language, so every page's switcher lands
   *  on the same page rather than on the home page. */
  path: string;
  children: ReactNode;
}) {
  const t = marketingT(locale);

  return (
    // `className` styles FixedLocale's own box rather than adding another: it
    // is already a real element, because Next's layout router scrolls to the
    // first node of a page and skips one with no rect.
    <FixedLocale locale={locale} className="flex min-h-screen flex-col">
      <main className="flex-1">{children}</main>

      <footer className="border-t py-8">
        <nav
          aria-label={t("footer.languageLabel")}
          className="container flex flex-wrap items-center gap-4 text-sm"
        >
          <span className="text-muted-foreground">{t("footer.languageLabel")}</span>
          {localeAlternates(path).map((alternate) => (
            <Link
              key={alternate.locale}
              href={alternate.path}
              // Each name is written in ITS OWN language, so the element has
              // to say which — otherwise a screen reader reads „Deutsch“ with
              // the page's pronunciation rules.
              hrefLang={alternate.locale}
              lang={alternate.locale}
              aria-current={alternate.locale === locale ? "page" : undefined}
              className={
                alternate.locale === locale
                  ? "font-medium underline"
                  : "text-muted-foreground hover:text-foreground"
              }
            >
              {LOCALE_ENDONYMS[alternate.locale]}
            </Link>
          ))}
        </nav>
      </footer>
    </FixedLocale>
  );
}
