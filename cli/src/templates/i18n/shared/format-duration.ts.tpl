/**
 * Durations and plain numbers, for every surface — including the ones that
 * are not localised at all.
 *
 * These four helpers are called from the web client, the server, data export,
 * the importer and any CLI. The last four are NOT localised and must not
 * become so: a CSV column, an API field or a log line that changes shape with
 * a language is a file somebody's spreadsheet stops parsing.
 *
 * So the contract is: **omitting `locale` is byte-identical, forever.** That
 * path contains no `Intl` call at all, which is the point — an ICU data
 * update inside the runtime cannot move it. `format-duration.test.ts` pins it
 * against this table, and the table is the specification:
 *
 *   formatDuration(5_025_000)         "1h 23m 45s"
 *   formatDuration(1_500_000)         "25m 0s"
 *   formatDuration(45_000)            "45s"
 *   formatDuration(0)                 "0s"
 *   formatDuration(-45_000)           "-45s"
 *   formatDurationShort(5_025_000)    "1h 23m"
 *   formatDurationShort(1_500_000)    "25m"
 *   formatDurationShort(45_000)       "45s"
 *   formatDecimal(1.5)                "1.50"
 *   formatDecimal(1234.5)             "1234.50"
 *   formatDecimal(1.5, undefined, 0)  "2"
 *
 * Passing a locale opts in to CLDR's own unit names and separators, and
 * nothing else changes: the same components, in the same order. Unit names
 * and the space before them come from `Intl`, never from a table here —
 * German gets its no-break space because CLDR says so.
 *
 * Read-back belongs to `parseDecimalInput`, which takes a comma and a dot
 * alike: everything these helpers print in any language parses again, so a
 * reader who edits „1,50“ in place is never told it is invalid.
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

interface DurationParts {
  negative: boolean;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Whole seconds, rounded once, so every caller below splits the same
 *  number. A non-finite input is zero: a NaN in a table cell is a bug report
 *  about the wrong module. */
function split(ms: number): DurationParts {
  const total = Number.isFinite(ms) ? Math.round(Math.abs(ms) / MS_PER_SECOND) : 0;
  return {
    // A value that rounds down to zero has no sign — "-0s" reads as a defect.
    negative: total > 0 && ms < 0,
    hours: Math.floor(total / SECONDS_PER_HOUR),
    minutes: Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE),
    seconds: total % SECONDS_PER_MINUTE,
  };
}

type DurationUnit = "hour" | "minute" | "second";

/** `Intl.NumberFormat` is expensive to construct and these run per table
 *  row, so every formatter is built once and kept. */
const unitFormatters = new Map<string, Intl.NumberFormat>();
const decimalFormatters = new Map<string, Intl.NumberFormat>();

function unitFormatter(locale: string, unit: DurationUnit): Intl.NumberFormat {
  const key = `${locale}:${unit}`;
  const cached = unitFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    // "short", not "narrow": CLDR's narrow data is inconsistent WITHIN a
    // locale — German narrow prints "1h 23 Min. 45 Sek.", mixing an English
    // abbreviation into a German duration, and Japanese narrow prints
    // "1h 23m 45s". "short" is uniform everywhere ("1 Std. 23 Min. 45 Sek.",
    // "1 時間 23 分 45 秒") and still fits a table cell.
    unitDisplay: "short",
    // A grouping separator in a duration is a dot in German — the exact
    // character a reader types as a decimal point.
    useGrouping: false,
  });
  unitFormatters.set(key, formatter);
  return formatter;
}

function decimalFormatter(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}:${digits}`;
  const cached = decimalFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    // Grouping off so `parseDecimalInput` reads back what this printed.
    useGrouping: false,
  });
  decimalFormatters.set(key, formatter);
  return formatter;
}

/** Components joined by a plain space. Not `Intl.ListFormat`: the glue
 *  between the parts of one duration is a space in every locale CLDR
 *  covers, and a list formatter would offer to insert "and". */
function joinUnits(parts: DurationParts, locale: string, units: DurationUnit[]): string {
  const values: Record<DurationUnit, number> = {
    hour: parts.hours,
    minute: parts.minutes,
    second: parts.seconds,
  };
  return units
    .map((unit, index) => {
      // The sign rides on the leading component so the reader gets their
      // locale's own minus sign instead of an ASCII hyphen we glued on.
      const value = index === 0 && parts.negative ? -values[unit] : values[unit];
      return unitFormatter(locale, unit).format(value);
    })
    .join(" ");
}

/** Largest non-zero unit down to seconds. */
function unitsFor(parts: DurationParts): DurationUnit[] {
  if (parts.hours > 0) return ["hour", "minute", "second"];
  if (parts.minutes > 0) return ["minute", "second"];
  return ["second"];
}

/**
 * A duration in full: "1h 23m 45s", "25m 0s", "45s".
 *
 * With a locale, the same components in that locale's unit names ("1 Std.
 * 23 Min. 45 Sek."). Without one, the byte-identical form in this file's
 * header — pass no locale from anything a machine reads back.
 */
export function formatDuration(ms: number, locale?: string): string {
  const parts = split(ms);
  const sign = parts.negative ? "-" : "";

  if (locale === undefined) {
    if (parts.hours > 0) return `${sign}${parts.hours}h ${parts.minutes}m ${parts.seconds}s`;
    if (parts.minutes > 0) return `${sign}${parts.minutes}m ${parts.seconds}s`;
    return `${sign}${parts.seconds}s`;
  }

  try {
    return joinUnits(parts, locale, unitsFor(parts));
  } catch {
    // A malformed tag reaching this from a stored preference must cost a
    // reader their unit names, not the page.
    return formatDuration(ms);
  }
}

/**
 * The compact form, one unit shorter: "1h 23m", "25m", "45s".
 *
 * Seconds appear only when there is nothing larger to show, because a
 * duration in a list is read at a glance and the seconds are noise.
 */
export function formatDurationShort(ms: number, locale?: string): string {
  const parts = split(ms);
  const sign = parts.negative ? "-" : "";

  if (locale === undefined) {
    if (parts.hours > 0) return `${sign}${parts.hours}h ${parts.minutes}m`;
    if (parts.minutes > 0) return `${sign}${parts.minutes}m`;
    return `${sign}${parts.seconds}s`;
  }

  const units = unitsFor(parts);
  try {
    return joinUnits(parts, locale, units.length > 1 ? units.slice(0, -1) : units);
  } catch {
    return formatDurationShort(ms);
  }
}

/**
 * A number with a fixed number of decimals: "1.50" without a locale, "1,50"
 * with a German one.
 *
 * Never grouped, in either path. This is the helper paired with
 * `parseDecimalInput` — a field a person types into and reads back — and a
 * German grouping dot in "1.234,50" is the character they type as a decimal
 * point. Use `useFormat().number()` for a figure that is only ever read.
 */
export function formatDecimal(value: number, locale?: string, fractionDigits = 2): string {
  const safe = Number.isFinite(value) ? value : 0;
  const digits = Math.min(Math.max(Math.trunc(fractionDigits), 0), 20);

  if (locale === undefined) return safe.toFixed(digits);

  try {
    return decimalFormatter(locale, digits).format(safe);
  } catch {
    return safe.toFixed(digits);
  }
}

/**
 * Read a decimal a person typed, in whatever notation their language uses.
 *
 * Comma and dot are both decimal points, and spaces (including the no-break
 * space CLDR groups with) are ignored. "1,5" and "1.5" are 1.5; "1.234,56"
 * and "1,234.56" are both 1234.56.
 *
 * One separator is always the decimal point — a reader who types "1.234"
 * means 1.234, whatever their grouping convention. Several separators are
 * grouping when they are all the same character ("1.234.567" is 1234567) and
 * the last one is the decimal point when they are mixed. That is the only
 * reading of "1.234" a single field can have; a locale-aware guess here would
 * change the value of what somebody typed when they travel.
 *
 * Returns null rather than NaN, so a caller cannot forget to check.
 */
export function parseDecimalInput(raw: string): number | null {
  const compact = raw.replace(/[\s   ]/g, "");
  if (compact === "" || !/^[+-]?[\d.,]+$/.test(compact)) return null;

  const commas = (compact.match(/,/g) ?? []).length;
  const dots = (compact.match(/\./g) ?? []).length;
  let normalised = compact;

  if (commas + dots === 1) {
    normalised = compact.replace(",", ".");
  } else if (commas + dots > 1) {
    if (commas === 0 || dots === 0) {
      normalised = compact.replace(/[.,]/g, "");
    } else {
      const decimalAt = Math.max(compact.lastIndexOf(","), compact.lastIndexOf("."));
      normalised = `${compact.slice(0, decimalAt).replace(/[.,]/g, "")}.${compact.slice(decimalAt + 1)}`;
    }
  }

  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}
