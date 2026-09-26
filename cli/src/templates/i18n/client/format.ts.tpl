/*
 * Every number, amount, date, time, duration and list this UI prints, in one
 * place, through `Intl` and the language the reader is looking at.
 *
 * THE ONLY PLACE IN THIS PROJECT THAT CONSTRUCTS AN `Intl.*` FORMATTER, and
 * the only correct way to print a number to a person. A bare
 * `value.toLocaleString()` or `toLocaleString(undefined)` formats in the
 * BROWSER's language, which is not the language the page is rendering: a
 * reader with a __HATCHKIT_TARGET_LABEL_EN__ browser reading the
 * "__HATCHKIT_SOURCE_LOCALE__" UI gets __HATCHKIT_TARGET_LABEL_EN__ dates
 * under source-language words, and a prerendered page gets the BUILD
 * machine's locale baked in. i18n/format.test.ts greps the client source for
 * `toLocale` and fails on a new one.
 *
 * NEVER LOCALISE ANYTHING A MACHINE READS BACK. These surfaces stay in the
 * locale-free forms `__HATCHKIT_PKG_SCOPE__/shared` produces when it is
 * given no locale:
 *
 *   · exported data columns — a CSV header and every value in it. A decimal
 *     comma is a different number to the next spreadsheet that opens the file.
 *   · the importer, and anything else that parses its own output later.
 *   · error codes, and `problem+json` `type` URIs.
 *   · webhook payloads, and every API response field.
 *   · the API documentation.
 *   · filenames that carry a date or an amount.
 *
 * `makeFormat` is pure and takes the locale, so a prerendered per-language
 * page can call it at build time; `useFormat()` binds it to the language the
 * component renders in. Anything stateful is in i18n/store.ts.
 */

import * as React from "react";
import {
  formatDuration,
  formatDurationShort,
  intlTag,
  type SupportedLocale,
} from "__HATCHKIT_PKG_SCOPE__/shared";

import { isActivated, subscribe } from "@/i18n/store";
import { useLocale } from "@/i18n/use-t";

export interface Formatters {
  date(d: Date | string, style?: "short" | "medium" | "long"): string;
  time(d: Date | string): string;
  dateTime(d: Date | string): string;
  relative(d: Date | string, now?: Date): string;
  number(n: number, opts?: Intl.NumberFormatOptions): string;
  decimal(n: number, fractionDigits?: number): string;
  percent(n: number): string;
  money(minorUnits: number, currency: string): string;
  duration(ms: number): string;
  durationShort(ms: number): string;
  list(items: string[], type?: "conjunction" | "disjunction"): string;
}

/** Named styles so call sites agree on what "short" means. */
const DATE_STYLES: Record<"short" | "medium" | "long", Intl.DateTimeFormatOptions> = {
  /** "21/08/2026", "8/21/2026", "21.08.2026" */
  short: { day: "2-digit", month: "2-digit", year: "numeric" },
  /** "21 Aug 2026", "Aug 21, 2026", "21. Aug. 2026" */
  medium: { day: "numeric", month: "short", year: "numeric" },
  /** "21 August 2026", "21. August 2026" */
  long: { day: "numeric", month: "long", year: "numeric" },
};

// Constructing a formatter is the expensive part; formatting with it is
// cheap. Keyed by tag and options, so a re-render costs a Map lookup.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
const listFormats = new Map<string, Intl.ListFormat>();

function numberFormat(tag: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${tag}|${JSON.stringify(options)}`;
  let formatter = numberFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(tag, options);
    numberFormats.set(key, formatter);
  }
  return formatter;
}

function dateFormat(tag: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tag}|${JSON.stringify(options)}`;
  let formatter = dateFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(tag, options);
    dateFormats.set(key, formatter);
  }
  return formatter;
}

function toDate(value: Date | string): Date | null {
  const date =
    value instanceof Date
      ? value
      : // A bare calendar date is a LOCAL day, never UTC midnight: parsed as
        // UTC it prints as the day before everywhere west of Greenwich.
        /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(`${value}T00:00:00`)
        : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** How many minor units make one unit of a currency: 2 for EUR, 0 for JPY. */
function currencyDigits(tag: string, currency: string): number {
  try {
    return (
      numberFormat(tag, { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000],
];

/**
 * Formatters for one language, optionally with a region.
 *
 * The catalog is per LANGUAGE and the formatting is per REGION: an
 * English reader in London wants "21 Aug" and one in Boston "Aug 21", a
 * German reader in Vienna wants „Jänner“. So the region comes from the
 * reader's device — see {@link deviceRegion} — and the language from the
 * catalog that is being rendered.
 */
export function makeFormat(locale: SupportedLocale, region?: string): Formatters {
  const tag = intlTag(locale, region);

  const number = (n: number, opts: Intl.NumberFormatOptions = {}): string =>
    numberFormat(tag, opts).format(Number.isFinite(n) ? n : 0);

  return {
    date(d, style = "medium") {
      const date = toDate(d);
      return date === null ? "" : dateFormat(tag, DATE_STYLES[style]).format(date);
    },

    time(d) {
      const date = toDate(d);
      return date === null
        ? ""
        : dateFormat(tag, { hour: "numeric", minute: "2-digit" }).format(date);
    },

    dateTime(d) {
      const date = toDate(d);
      return date === null
        ? ""
        : dateFormat(tag, {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).format(date);
    },

    relative(d, now = new Date()) {
      const date = toDate(d);
      if (date === null) return "";
      const delta = date.getTime() - now.getTime();
      let formatter = relativeFormats.get(tag);
      if (formatter === undefined) {
        // "numeric: auto" is what turns -1 day into "yesterday" rather than
        // "1 day ago", in every language that has such a word.
        formatter = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
        relativeFormats.set(tag, formatter);
      }
      for (const [unit, ms] of RELATIVE_UNITS) {
        if (Math.abs(delta) >= ms || unit === "second") {
          return formatter.format(Math.round(delta / ms), unit);
        }
      }
      return "";
    },

    number,

    decimal(n, fractionDigits = 2) {
      return number(n, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
    },

    /** `n` is a ratio: 0.42 prints as "42%" / „42 %“. */
    percent(n) {
      return number(n, { style: "percent", maximumFractionDigits: 0 });
    },

    /**
     * Amounts are held in MINOR UNITS everywhere in this project — cents,
     * not euros — because a float cannot hold 0.1 exactly and money must
     * add up. The currency decides how many there are to the unit, so
     * dividing by 100 would print ¥1.23 for 123 yen.
     */
    money(minorUnits, currency) {
      const code = currency.toUpperCase();
      const safe = Number.isFinite(minorUnits) ? minorUnits : 0;
      if (/^[A-Z]{3}$/.test(code)) {
        const digits = currencyDigits(tag, code);
        try {
          return numberFormat(tag, { style: "currency", currency: code }).format(
            safe / 10 ** digits,
          );
        } catch {
          /* an ISO code Intl rejects: fall through rather than throw mid-render */
        }
      }
      return `${number(safe / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
    },

    // The shared helpers own the wording ("1 h 30 min"); passing the locale
    // is what makes the NUMBERS in it local. Called without one they stay
    // byte-identical, which the export and the server depend on.
    duration(ms) {
      return formatDuration(ms, tag);
    },

    durationShort(ms) {
      return formatDurationShort(ms, tag);
    },

    list(items, type = "conjunction") {
      const key = `${tag}|${type}`;
      let formatter = listFormats.get(key);
      if (formatter === undefined) {
        formatter = new Intl.ListFormat(tag, { style: "long", type });
        listFormats.set(key, formatter);
      }
      return formatter.format(items);
    },
  };
}

/**
 * The region `Intl` should format with, from the device.
 *
 * Only when the device's language matches the one being rendered: a
 * __HATCHKIT_TARGET_LABEL_EN__ browser reading the
 * "__HATCHKIT_SOURCE_LOCALE__" UI must not get
 * __HATCHKIT_TARGET_LABEL_EN__ date order under source-language words.
 * Otherwise the language's own default region applies.
 */
export function deviceRegion(locale: SupportedLocale): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const tags =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const parts = tag.trim().split(/[-_]/);
    if (parts[0]?.toLowerCase() !== locale) continue;
    const region = parts[1];
    if (region !== undefined && /^[A-Za-z]{2}$/.test(region)) return region.toUpperCase();
  }
  return undefined;
}

function returnFalse(): boolean {
  return false;
}

/**
 * Formatters for the language this component renders in.
 *
 * The device's region is withheld until the store has been activated, for the
 * same reason the language is: the prerendered HTML was formatted with no
 * device to ask, so a first client render that reads `navigator` would print
 * "21/08/2026" where the served markup says "08/21/2026" — a hydration
 * mismatch that costs the whole served DOM, over a date separator. Activation
 * happens in <LocaleRoot>'s layout effect, so the corrected format lands in
 * the same flush as the translated render and is never seen half-applied.
 */
export function useFormat(): Formatters {
  const locale = useLocale();
  const activated = React.useSyncExternalStore(subscribe, isActivated, returnFalse);
  return React.useMemo(
    () => makeFormat(locale, activated ? deviceRegion(locale) : undefined),
    [locale, activated],
  );
}
