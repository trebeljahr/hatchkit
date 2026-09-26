/*
 * The machine-readable output, pinned byte for byte.
 *
 * Called with no `locale`, these helpers produce a DATA FORMAT, not a piece
 * of user interface. A CSV export, the importer that reads that CSV back, the
 * server and any CLI all print and parse these exact strings, and none of
 * them has a reader's language to consult. There is no `Intl` call on that
 * path at all, which is the point — an ICU data update inside the runtime
 * cannot move it, and neither may we.
 *
 * So the tables below are the contract, copied from the specification in the
 * header of format-duration.ts. When a value here changes, an export written
 * last year stops matching the import written this year and nothing raises an
 * error: the numbers simply come back wrong, or not at all. If a change turns
 * this red, the answer is almost always to fix the implementation and not the
 * table. Passing a locale is what changes the output.
 *
 * Runner: this package has no test script of its own yet. Add
 * `"test": "vitest run"` plus a `vitest` devDependency to
 * packages/shared/package.json, or run it from the repository root.
 */

import { describe, expect, it } from "vitest";
import {
  formatDecimal,
  formatDuration,
  formatDurationShort,
  parseDecimalInput,
} from "./format-duration.js";

/** Largest non-zero unit down to seconds, always with the smaller ones. */
const DURATION: readonly [number, string][] = [
  [5_025_000, "1h 23m 45s"],
  [1_500_000, "25m 0s"],
  [45_000, "45s"],
  [0, "0s"],
  [-45_000, "-45s"],
  [-5_025_000, "-1h 23m 45s"],
  [3_600_000, "1h 0m 0s"],
  // Whole seconds, rounded once, so every caller splits the same number.
  [59_500, "1m 0s"],
  // A value that rounds down to nothing has no sign: "-0s" reads as a defect.
  [-400, "0s"],
];

/** One unit shorter, because a duration in a list is read at a glance. */
const DURATION_SHORT: readonly [number, string][] = [
  [5_025_000, "1h 23m"],
  [1_500_000, "25m"],
  [45_000, "45s"],
  [0, "0s"],
  [3_600_000, "1h 0m"],
  [-5_025_000, "-1h 23m"],
];

describe("formatDuration with no locale", () => {
  for (const [ms, expected] of DURATION) {
    it(`${ms} ms is exactly "${expected}"`, () => {
      expect(formatDuration(ms)).toBe(expected);
    });
  }

  it("never groups the hours", () => {
    // A grouping separator here is a dot in German — and a dot in an exported
    // column is where an importer splits a number in the wrong place.
    expect(formatDuration(1000 * 3_600_000)).toBe("1000h 0m 0s");
  });

  it("answers zero rather than NaN for a number that is not one", () => {
    // A NaN in a table cell becomes a bug report about the wrong module.
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});

describe("formatDurationShort with no locale", () => {
  for (const [ms, expected] of DURATION_SHORT) {
    it(`${ms} ms is exactly "${expected}"`, () => {
      expect(formatDurationShort(ms)).toBe(expected);
    });
  }
});

describe("formatDecimal with no locale", () => {
  it("writes plain, ungrouped digits with a dot", () => {
    expect(formatDecimal(1.5)).toBe("1.50");
    expect(formatDecimal(1234.5)).toBe("1234.50");
    expect(formatDecimal(1.5, undefined, 0)).toBe("2");
    expect(formatDecimal(0)).toBe("0.00");
  });

  it("is read back by parseDecimalInput, in both directions", () => {
    // The pair is what makes a field a person types into safe: everything
    // these print parses again, so „1,50“ edited in place is never rejected.
    for (const value of [0, 1.5, 1234.5, -2.25]) {
      expect(parseDecimalInput(formatDecimal(value))).toBe(value);
      expect(parseDecimalInput(formatDecimal(value, "de-DE"))).toBe(value);
    }
  });
});

describe("a locale argument, and only a locale argument, changes the output", () => {
  // de-DE is hardcoded rather than taken from this project's configuration:
  // the assertion is that the parameter is honoured at all, and German's
  // decimal comma and unit names are stable facts about German, not about us.
  it("localises the unit names of a duration", () => {
    const localised = formatDuration(5_025_000, "de-DE");
    expect(localised).not.toBe(formatDuration(5_025_000));
    // Same components, in the same order — only their wording is CLDR's.
    expect(localised).toContain("23");
    expect(localised).toContain("45");
  });

  it("localises a decimal, without grouping it", () => {
    expect(formatDecimal(1234.5, "de-DE")).toBe("1234,50");
  });

  it("falls back to the machine form for a tag Intl rejects", () => {
    // A malformed tag reaching this from a stored preference must cost a
    // reader their unit names, not the page.
    expect(formatDuration(5_025_000, "not a locale")).toBe(formatDuration(5_025_000));
    expect(formatDecimal(1234.5, "not a locale")).toBe(formatDecimal(1234.5));
  });
});

describe("parseDecimalInput", () => {
  it("accepts a comma and a dot alike", () => {
    // One field, readers in several languages, and a German keyboard's
    // numeric comma. Rejecting it means a form that cannot be filled in.
    expect(parseDecimalInput("1,5")).toBe(1.5);
    expect(parseDecimalInput("1.5")).toBe(1.5);
    expect(parseDecimalInput("1,5")).toBe(parseDecimalInput("1.5"));
    expect(parseDecimalInput("12")).toBe(12);
    expect(parseDecimalInput("0")).toBe(0);
    expect(parseDecimalInput("-2,25")).toBe(-2.25);
  });

  it("reads a grouped number the way the person who typed it meant it", () => {
    // One separator is always the decimal point, whatever the grouping
    // convention. Several of the same character are grouping; mixed ones put
    // the decimal point last.
    expect(parseDecimalInput("1.234,56")).toBe(1234.56);
    expect(parseDecimalInput("1,234.56")).toBe(1234.56);
    expect(parseDecimalInput("1.234.567")).toBe(1234567);
    expect(parseDecimalInput("1 234,5")).toBe(1234.5);
  });

  it("answers null instead of NaN for anything it cannot read", () => {
    // NaN spreads: it survives arithmetic, reaches the database and prints as
    // an empty cell. A null is a validation error the form can show.
    expect(parseDecimalInput("")).toBeNull();
    expect(parseDecimalInput("   ")).toBeNull();
    expect(parseDecimalInput("abc")).toBeNull();
    expect(parseDecimalInput("1,5 h")).toBeNull();
  });
});
