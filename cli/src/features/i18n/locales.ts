/*
 * cli/src/features/i18n/locales.ts — The locale catalog hatchkit offers.
 *
 * Deliberately a small, curated list rather than an Intl-derived one.
 * Every entry here has to carry an endonym a picker can show and a
 * default region for Intl formatting, and both are editorial choices no
 * API answers: `Intl.DisplayNames` would give "German" in the current UI
 * language, which is exactly the wrong string for a language picker, and
 * there is no "the region for `de`" anywhere in CLDR — we pick DE and let
 * the reader's device override it (an at-AT device keeps „Jänner“).
 *
 * `en` appears as a SOURCE option, not only as a target: an adopted
 * project may well be written in another language.
 */

import type { LocaleCode, LocaleMeta } from "./types.js";

export const SUPPORTED_LOCALES: Record<LocaleCode, LocaleMeta> = {
  en: { code: "en", endonym: "English", englishName: "English", defaultRegion: "US" },
  de: {
    code: "de",
    endonym: "Deutsch",
    englishName: "German",
    defaultRegion: "DE",
    informalSecondPerson: "du",
  },
  fr: {
    code: "fr",
    endonym: "Français",
    englishName: "French",
    defaultRegion: "FR",
    informalSecondPerson: "tu",
  },
  es: {
    code: "es",
    endonym: "Español",
    englishName: "Spanish",
    defaultRegion: "ES",
    informalSecondPerson: "tú",
  },
  it: {
    code: "it",
    endonym: "Italiano",
    englishName: "Italian",
    defaultRegion: "IT",
    informalSecondPerson: "tu",
  },
  pt: {
    code: "pt",
    endonym: "Português",
    englishName: "Portuguese",
    defaultRegion: "PT",
    informalSecondPerson: "tu",
  },
  nl: {
    code: "nl",
    endonym: "Nederlands",
    englishName: "Dutch",
    defaultRegion: "NL",
    informalSecondPerson: "je",
  },
  pl: {
    code: "pl",
    endonym: "Polski",
    englishName: "Polish",
    defaultRegion: "PL",
    informalSecondPerson: "ty",
  },
  sv: {
    code: "sv",
    endonym: "Svenska",
    englishName: "Swedish",
    defaultRegion: "SE",
    informalSecondPerson: "du",
  },
  da: {
    code: "da",
    endonym: "Dansk",
    englishName: "Danish",
    defaultRegion: "DK",
    informalSecondPerson: "du",
  },
  // No informal second person: Japanese resolves register by verb form and
  // normally drops the pronoun, so the glossary asks for a register instead.
  ja: { code: "ja", endonym: "日本語", englishName: "Japanese", defaultRegion: "JP" },
  zh: {
    code: "zh",
    endonym: "中文",
    englishName: "Chinese",
    defaultRegion: "CN",
    informalSecondPerson: "你",
  },
};

/** The namespaces a fresh scaffold gets. `common` is shared vocabulary,
 *  `app` the signed-in surface, `marketing` the public pages. */
export const DEFAULT_NAMESPACES = ["common", "app", "marketing"];

export function isKnownLocale(code: string): boolean {
  return Object.hasOwn(SUPPORTED_LOCALES, code);
}

/** Throws rather than returning undefined: a locale hatchkit does not know
 *  has no endonym and no default region, so every downstream template
 *  would render a `__HATCHKIT_` hole. Failing here names the fix. */
export function localeMeta(code: string): LocaleMeta {
  const meta = SUPPORTED_LOCALES[code];
  if (!meta) {
    const known = Object.keys(SUPPORTED_LOCALES).sort().join(", ");
    throw new Error(
      `Unknown locale "${code}". Hatchkit knows: ${known}. ` +
        `Add it to cli/src/features/i18n/locales.ts (endonym + default Intl region) first.`,
    );
  }
  return meta;
}
