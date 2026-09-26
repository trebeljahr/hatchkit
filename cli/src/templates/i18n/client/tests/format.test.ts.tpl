/*
 * Two jobs, both about things the type checker is blind to.
 *
 * (a) The formatters produce the right SHAPE in each language. `money` takes
 *     minor units, `percent` takes a fraction, `decimal` honours its digit
 *     count, `duration` delegates to the shared helper instead of growing a
 *     second implementation. Each of those is a silent wrong number rather
 *     than an error: 123456 minor units printed as "123,456.00" is a bill a
 *     hundred times too large, and it type-checks.
 *
 * (b) NO file outside this module may construct an `Intl` formatter or call
 *     `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString`. That is
 *     a project rule, not a type, so nothing but a source grep can hold it.
 *     A bare `toLocaleString()` reads the BROWSER's language, not the
 *     reader's chosen one, so a German reader on an English laptop sees
 *     German words around English numbers — and the tests pass, because the
 *     test machine happens to agree with itself.
 *
 * The expectations here are computed with `Intl` and the documented locale
 * tag rather than hardcoded: pinning "1.234,50" would pin the CLDR version
 * of the machine that ran the test. The place where exact bytes ARE the
 * contract is the shared duration helper, whose test hardcodes its table on
 * purpose.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDuration,
  intlTag,
  SOURCE_LOCALE,
  type SupportedLocale,
} from "__HATCHKIT_PKG_SCOPE__/shared";
import { describe, expect, it } from "vitest";
import { makeFormat } from "./format";

const TARGET_LOCALE = "__HATCHKIT_TARGET_LOCALE__" as SupportedLocale;
const LOCALES: readonly SupportedLocale[] = [SOURCE_LOCALE, TARGET_LOCALE];

/** A fixed instant, formatted in the machine's own zone on both sides of
 *  every comparison — the zone is the reader's, and pinning one here would
 *  only pin the CI container's. */
const INSTANT = new Date("2024-03-05T14:30:00.000Z");

for (const locale of LOCALES) {
  describe(`makeFormat("${locale}")`, () => {
    const f = makeFormat(locale);
    const tag = intlTag(locale);

    it("reads money as minor units", () => {
      expect(f.money(123456, "EUR")).toBe(
        new Intl.NumberFormat(tag, { style: "currency", currency: "EUR" }).format(1234.56),
      );
    });

    it("reads a percentage as a fraction", () => {
      // 0.125, not 12.5: a formatter that takes the already-multiplied number
      // prints "1,250%" and nothing throws.
      expect(f.percent(0.125)).toBe(
        new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 }).format(0.125),
      );
    });

    it("keeps the requested number of decimals", () => {
      // Whatever the separator is in this language, two digits follow it.
      expect(f.decimal(1234.5, 2)).toMatch(/[.,]\d{2}$/);
      expect(f.decimal(1234.5, 0)).not.toMatch(/[.,]\d$/);
    });

    it("formats a number in the reader's language", () => {
      expect(f.number(1234.5)).toBe(new Intl.NumberFormat(tag).format(1234.5));
    });

    it("has three date styles that differ, and a time", () => {
      const short = f.date(INSTANT, "short");
      const long = f.date(INSTANT, "long");
      expect(short).not.toBe("");
      expect(long).not.toBe(short);
      expect(f.time(INSTANT)).toMatch(/\d/);
      // A date and a time together is longer than either alone; the
      // assertion is that dateTime is not quietly one of them.
      expect(f.dateTime(INSTANT).length).toBeGreaterThan(f.time(INSTANT).length);
    });

    it("accepts an ISO string wherever it accepts a Date", () => {
      expect(f.date(INSTANT.toISOString(), "medium")).toBe(f.date(INSTANT, "medium"));
    });

    it("says something about a past instant", () => {
      const twoDaysEarlier = new Date(INSTANT.getTime() - 2 * 24 * 60 * 60 * 1000);
      expect(f.relative(twoDaysEarlier, INSTANT)).not.toBe("");
    });

    it("delegates a duration to the one shared helper", () => {
      // Not a second implementation: the export, the importer and the
      // server all read the same function, and a copy here would drift.
      expect(f.duration(5_400_000)).toBe(formatDuration(5_400_000, tag));
      expect(f.durationShort(5_400_000)).not.toBe("");
    });

    it("joins a list without hand-written commas", () => {
      const joined = f.list(["one", "two", "three"]);
      expect(joined).toContain("one");
      expect(joined).toContain("two");
      expect(joined).toContain("three");
    });
  });
}

/* ------------------------------------------------------------------ *
 * The rule a type cannot state: all Intl goes through this module.
 * ------------------------------------------------------------------ */

/** Source files exempt from the grep, each for a stated reason. An entry is
 *  a debt, not a decision: route the file through `useFormat()` and delete
 *  its line. */
const EXEMPT: readonly string[] = [
  // The scaffold shipped this one before the project had a formatter. The
  // figure is a vertex count in a developer-facing viewer, so the cost is
  // low — but it is still the browser's language, not the reader's.
  "components/ml/result-viewer-3d.tsx",
];

/** Reading the environment is not formatting. `Intl.DateTimeFormat()
 *  .resolvedOptions().timeZone` is the only way to ask what zone the device
 *  is in, and several modules legitimately need the answer. */
const NOT_FORMATTING = /Intl\.[A-Za-z]+\([^)]*\)\.resolvedOptions\(/;

/** Matches the call, never the type: `Intl.NumberFormatOptions` in a
 *  signature is fine, `new Intl.NumberFormat(...)` is the offence. */
const BANNED: readonly { re: RegExp; what: string }[] = [
  { re: /\.toLocaleString\s*\(/, what: "toLocaleString()" },
  { re: /\.toLocaleDateString\s*\(/, what: "toLocaleDateString()" },
  { re: /\.toLocaleTimeString\s*\(/, what: "toLocaleTimeString()" },
  {
    re: /\bIntl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat|PluralRules|Collator|DurationFormat)\s*\(/,
    what: "an Intl formatter",
  },
];

const CLIENT_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the client source", () => {
  it("constructs Intl formatters in i18n/format.ts and nowhere else", () => {
    const offences: string[] = [];

    for (const file of sourceFiles(CLIENT_SRC)) {
      const rel = relative(CLIENT_SRC, file).split("\\").join("/");
      // format.ts is the one place allowed to; a test computes its own
      // expectations and is not shipped to a reader.
      if (rel === "i18n/format.ts" || /\.test\.tsx?$/.test(rel)) continue;
      if (EXEMPT.includes(rel)) continue;

      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, index) => {
        if (NOT_FORMATTING.test(line)) return;
        for (const { re, what } of BANNED) {
          if (re.test(line)) offences.push(`${rel}:${index + 1} uses ${what}`);
        }
      });
    }

    expect(offences, "route these through useFormat() from src/i18n/format.ts").toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}
