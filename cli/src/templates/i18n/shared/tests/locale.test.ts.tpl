/*
 * The one resolver, and its precedence table.
 *
 * `resolveLocale` is the only place in the project that decides which
 * language a reader gets. The client calls it, the pre-paint script mirrors
 * it, and the server calls it for a document or an email. Every wrong answer
 * here is silent: the page simply renders in a language somebody did not
 * ask for, and no test elsewhere can tell that apart from a translation
 * choice.
 *
 * The row that matters most is the last one: a "system" preference with NO
 * device list must answer the source locale. That is the server, which has
 * no device to ask. A resolver that quietly treats "system" as "the first
 * supported language" would mail a German invoice to a reader who never
 * chose German, and the only witness would be the invoice.
 *
 * Runner: this package has no test script of its own yet. Add
 * `"test": "vitest run"` plus a `vitest` devDependency to
 * packages/shared/package.json, or run it from the repository root.
 */

import { describe, expect, it } from "vitest";
import {
  intlTag,
  isSupportedLocale,
  LOCALE_ENDONYMS,
  LOCALE_REGIONS,
  matchLocaleList,
  resolveLocale,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  type LocalePreference,
  type SupportedLocale,
} from "./locale.js";

const TARGET_LOCALE = "__HATCHKIT_TARGET_LOCALE__" as SupportedLocale;

describe("the supported list", () => {
  it("leads with the source locale", () => {
    // The order IS the fallback order, and the source locale is what every
    // prerendered file already contains.
    expect(SUPPORTED_LOCALES[0]).toBe(SOURCE_LOCALE);
  });

  it("carries a region and an endonym for every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      // A missing region means Intl falls back to the machine's own, which
      // is how a German page ends up with US dates.
      expect(LOCALE_REGIONS[locale], `no region for ${locale}`).toMatch(/^[A-Z]{2}$/);
      // The endonym is what a picker shows: a reader who cannot read the
      // current language still recognises their own.
      expect(LOCALE_ENDONYMS[locale], `no endonym for ${locale}`).not.toBe("");
    }
  });

  it("recognises exactly the locales it lists", () => {
    for (const locale of SUPPORTED_LOCALES) expect(isSupportedLocale(locale)).toBe(true);
    // A full BCP-47 tag is not a supported locale: the catalogs are keyed by
    // primary subtag, and `matchLocaleList` is what turns one into the other.
    expect(isSupportedLocale(`${TARGET_LOCALE}-CH`)).toBe(false);
    expect(isSupportedLocale("cy")).toBe(false);
    expect(isSupportedLocale("")).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});

describe("matchLocaleList", () => {
  it("matches on the primary subtag", () => {
    // The region belongs to the device and decides date and number shapes.
    // It never decides which catalog loads.
    expect(matchLocaleList([TARGET_LOCALE])).toBe(TARGET_LOCALE);
    expect(matchLocaleList([`${TARGET_LOCALE}-${LOCALE_REGIONS[TARGET_LOCALE]}`])).toBe(
      TARGET_LOCALE,
    );
    expect(matchLocaleList([`${TARGET_LOCALE}-CH`])).toBe(TARGET_LOCALE);
  });

  it("takes the first SUPPORTED entry, not the first entry", () => {
    expect(matchLocaleList(["cy", "gd", TARGET_LOCALE])).toBe(TARGET_LOCALE);
    // Order is the answer: a device asking for the source language first
    // gets it, even though the target language is also on the list.
    expect(matchLocaleList([SOURCE_LOCALE, TARGET_LOCALE])).toBe(SOURCE_LOCALE);
  });

  it("falls back to the source locale when nothing matches", () => {
    expect(matchLocaleList(["cy-GB"])).toBe(SOURCE_LOCALE);
    expect(matchLocaleList([])).toBe(SOURCE_LOCALE);
    expect(matchLocaleList(undefined)).toBe(SOURCE_LOCALE);
  });
});

describe("resolveLocale", () => {
  interface Row {
    name: string;
    preference?: LocalePreference;
    devices?: readonly string[];
    expected: SupportedLocale;
  }

  const ROWS: readonly Row[] = [
    {
      // Nothing stored behaves like "system": a fresh account follows the
      // device it was created on.
      name: "no preference, a target-language device",
      devices: [TARGET_LOCALE],
      expected: TARGET_LOCALE,
    },
    {
      name: '"system" defers to the device',
      preference: "system",
      devices: [`${TARGET_LOCALE}-CH`],
      expected: TARGET_LOCALE,
    },
    {
      name: "an explicit preference beats the device",
      preference: SOURCE_LOCALE,
      devices: [TARGET_LOCALE],
      expected: SOURCE_LOCALE,
    },
    {
      name: "an explicit preference the other way round",
      preference: TARGET_LOCALE,
      devices: [SOURCE_LOCALE],
      expected: TARGET_LOCALE,
    },
    {
      // The server CAN honour an explicit preference: it is an answer, not
      // a question about a device.
      name: "an explicit preference with no device list at all",
      preference: TARGET_LOCALE,
      expected: TARGET_LOCALE,
    },
    {
      // THE server row. "system" is a question, and the server has nobody
      // to ask, so the answer is the source language and never a guess.
      name: '"system" with no device list',
      preference: "system",
      expected: SOURCE_LOCALE,
    },
    {
      name: '"system" with an empty device list',
      preference: "system",
      devices: [],
      expected: SOURCE_LOCALE,
    },
    {
      name: '"system" on a device nothing supports',
      preference: "system",
      devices: ["cy-GB", "gd"],
      expected: SOURCE_LOCALE,
    },
    { name: "nothing at all", expected: SOURCE_LOCALE },
  ];

  for (const row of ROWS) {
    it(row.name, () => {
      expect(resolveLocale(row.preference, row.devices)).toBe(row.expected);
    });
  }
});

describe("intlTag", () => {
  it("pairs the rendered language with a region", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(intlTag(locale)).toBe(`${locale}-${LOCALE_REGIONS[locale]}`);
      // The device's region overrides the default: an at-AT reader keeps
      // „Jänner“ while reading the same German catalog.
      expect(intlTag(locale, "CH")).toBe(`${locale}-CH`);
    }
  });

  it("produces tags Intl accepts", () => {
    // A malformed tag throws a RangeError on the first format call, which in
    // a client is a blank screen rather than a wrong date.
    for (const locale of SUPPORTED_LOCALES) {
      expect(() => new Intl.NumberFormat(intlTag(locale)).format(1)).not.toThrow();
      expect(() => new Intl.DateTimeFormat(intlTag(locale, "CH")).format(new Date())).not.toThrow();
    }
  });
});
