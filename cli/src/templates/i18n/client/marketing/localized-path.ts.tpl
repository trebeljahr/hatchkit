/*
 * Keeps an internal link inside the language the reader is already on.
 *
 * The source language lives at the root ("/about/"), every other language
 * under its own prefix ("/de/about/"). A link written by hand is a link that
 * drops the reader back into __HATCHKIT_SOURCE_LABEL__ halfway through the
 * site, so every href on a public page goes through here.
 *
 * WHY THERE IS NO `[locale]` SEGMENT — do not "simplify" this into one.
 * A dynamic segment at the root matches EVERY first path element. It would
 * compete with the app's own routes, and worse, it would turn every unknown
 * address into a page: a typo, an old link and a crawler's guess would all
 * render a marketing page with an unresolvable locale instead of a
 * not-found. A static export has no middleware to sort that out afterwards.
 * Explicit `app/<locale>/**` directories cost one file per page per
 * language and answer 404 for everything else, which is the correct answer.
 *
 * ONLY PUBLIC, PRERENDERED PAGES take a prefix. The auth screens and
 * everything behind the login exist once, at the root, and follow the
 * reader's own preference at runtime — there is no /de/login/, so a link to
 * one must not come through here.
 */

import { SOURCE_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";

/** Rewrite a SOURCE-language pathname for `locale`. Pass the path as it
 *  appears at the root ("/" or "/about/"), never one that already carries a
 *  prefix — the result would be "/de/de/about/". */
export function localizedPath(path: string, locale: SupportedLocale): string {
  const clean = withTrailingSlash(path);
  // The source language is not prefixed: its pages are the ones old links,
  // sent emails and existing search results already point at.
  return locale === SOURCE_LOCALE ? clean : `/${locale}${clean}`;
}

/** Every language's address for one source-language pathname, source first.
 *  `marketingMetadata` turns this into the `hreflang` set; the shell turns
 *  it into the language list in the footer. One source for both, so a page
 *  cannot advertise an alternate it does not link to. */
export function localeAlternates(path: string): Array<{ locale: SupportedLocale; path: string }> {
  return SUPPORTED_LOCALES.map((locale) => ({ locale, path: localizedPath(path, locale) }));
}

/** `trailingSlash: true` in next.config.ts, so "/about" and "/about/" are
 *  two addresses and one of them redirects. Emit the one that does not. */
function withTrailingSlash(path: string): string {
  const rooted = path.startsWith("/") ? path : `/${path}`;
  return rooted.endsWith("/") ? rooted : `${rooted}/`;
}
