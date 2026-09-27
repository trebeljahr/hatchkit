/**
 * Every user-visible string this extension formats, in one language.
 *
 * ============================================================
 * SINGLE-LOCALE ON PURPOSE
 * ============================================================
 *
 * The Raycast Store accepts one language per extension and Raycast offers no
 * locale API to follow, so a localised build is simply unpublishable. That
 * matters here rather than in a README because a shared formatting helper that
 * silently picks up the machine's locale produces output the store review
 * rejects, and nothing in the build catches it: the developer's machine is
 * usually the source language, so it looks right everywhere it is tested.
 *
 * So: no locale argument is ever passed, and `undefined` is never passed as
 * one either — `toLocaleString(undefined)` IS the machine locale. Every
 * formatter below names `"en-US"` explicitly.
 */

const LOCALE = "en-US";

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

const dayAndTime = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "3 minutes ago", "yesterday". An unparseable instant is the empty string. */
export function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const seconds = Math.round((ms - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return relative.format(Math.round(seconds), "second");
  if (absolute < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  if (absolute < 604800) return relative.format(Math.round(seconds / 86400), "day");
  return dayAndTime.format(ms);
}

/**
 * The LIVE value, in the live format.
 *
 * Kept apart from {@link formatAggregate} deliberately. An aggregate rendered
 * in the live format reads as still-live — a person glancing at a menu bar
 * cannot tell "this is what you are working on" from "this is what you did
 * today" when both are drawn the same way, and they will act on the wrong one.
 */
export function formatLive(title: string): string {
  return `● ${truncate(title, 28)}`;
}

/** A COUNT or a total. Never the live format — see {@link formatLive}. */
export function formatAggregate(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** Menu bar titles are elided by the OS, not wrapped. */
export function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(max - 1, 0))}…`;
}
