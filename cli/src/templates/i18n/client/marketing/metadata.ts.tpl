/*
 * <head> for a public page, once per language.
 *
 * Three things a search engine needs and no framework can guess:
 *
 *   · a CANONICAL address, so /de/ and / are not read as duplicates of each
 *     other;
 *   · an `hreflang` ALTERNATE for every language this build publishes, plus
 *     `x-default` — which is the SOURCE language, not the reader's nearest
 *     match: it is the page served to somebody whose language we do not
 *     publish at all;
 *   · `og:locale`, which wants a language_REGION pair ("de_DE"), not the
 *     bare language code the rest of the app uses.
 *
 * Set NEXT_PUBLIC_SITE_URL at BUILD time. Without it the addresses below
 * stay relative, Next resolves them against its localhost default, and the
 * `hreflang` set a crawler reads points at nothing. It is inlined by
 * `next build`, so supplying it at container runtime is too late.
 */

import type { Metadata } from "next";
import { LOCALE_REGIONS, SOURCE_LOCALE, type SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";
import { localeAlternates, localizedPath } from "./localized-path";
import { marketingT } from "./marketing-shell";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "";

export function marketingMetadata({
  locale,
  path,
}: {
  locale: SupportedLocale;
  /** The page's SOURCE-language pathname, exactly as passed to
   *  `<MarketingShell path>` — the canonical and the alternates are derived
   *  from it, so a page cannot claim an address it is not served at. */
  path: string;
}): Metadata {
  const t = marketingT(locale);
  const title = t("seo.title");
  const description = t("seo.description");
  const alternates = localeAlternates(path);
  const self = absolute(localizedPath(path, locale));

  const languages: Record<string, string> = {};
  for (const alternate of alternates) {
    languages[alternate.locale] = absolute(alternate.path);
  }
  languages["x-default"] = absolute(localizedPath(path, SOURCE_LOCALE));

  return {
    // `absolute`, because the root layout sets a title TEMPLATE ("%s | App")
    // and a translated title that already names the product would come out
    // saying it twice.
    title: { absolute: title },
    description,
    ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
    alternates: { canonical: self, languages },
    openGraph: {
      title,
      description,
      url: self,
      locale: ogLocale(locale),
      alternateLocale: alternates
        .filter((alternate) => alternate.locale !== locale)
        .map((alternate) => ogLocale(alternate.locale)),
    },
  };
}

/** "de" + "DE" → "de_DE". The region is the catalog's default, never the
 *  reader's: this string ends up in a prerendered file that every reader in
 *  that language gets. */
function ogLocale(locale: SupportedLocale): string {
  return `${locale}_${LOCALE_REGIONS[locale]}`;
}

function absolute(path: string): string {
  return SITE_URL ? new URL(path, SITE_URL).toString() : path;
}
