/*
 * cli/src/features/error-reporting/scrub.ts — the scrubber, as a pure
 * function over a Sentry-protocol event.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * An error tracker is the one part of a product that is wired to send
 * whatever happens to be lying around at the moment things go wrong.
 * The defaults of every SDK are generous: the console output, the
 * element that was typed into, the cookies, the full URL. So a project
 * that adds error reporting on a Friday has, by Monday, a searchable
 * archive of its users' invitation links and half their form input, and
 * nobody decided that — it was the default.
 *
 * This function removes. It never adds. Every rule here deletes
 * something the SDK offered, and what survives is exactly what
 * `allowlist.ts` names. The deletion is by allowlist, not by blocklist,
 * because a blocklist is a list of the leaks someone already thought
 * of: the next SDK version adds a key nobody here has heard of, and a
 * blocklist waves it through.
 *
 * It lives in the CLI, tested without a browser and without the SDK, and
 * `render.ts` writes the same rules into the generated client code. The
 * tests drive this copy; the generated copy carries the same allowlist,
 * derived from the same list.
 */

import {
  REPORT_FIELDS,
  type ReportBreadcrumb,
  type ReportEvent,
  type ReportField,
  allowedBreadcrumbs,
  allowedContexts,
  allowedEventKeys,
  allowedRequestHeaders,
  allowedTags,
} from "./allowlist.js";

/** An email address inside free text. A server refusal can quote the address it refused. */
const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
/** A bearer token inside free text. An auth failure can quote the header it rejected. */
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
/** A leftover `?…` or `#…` inside free text, after the URL rule has run. */
const QUERY_IN_TEXT = /[?#][^\s"'<>]*/g;
/**
 * A URL — absolute, or root-relative — inside a longer text. The path
 * stops at a quote or a bracket, but a query string, once it has begun,
 * runs to the next whitespace: an API input encoded as `?input={"a":1}`
 * must be removed whole, rather than cut at its first quote with the
 * rest of the JSON left in the message.
 */
const URL_IN_TEXT = /(?:\b[a-z][\w+.-]*:\/\/|(?<![\w.])\/)[^\s"'<>?#]*(?:[?#]\S*)?/gi;

/**
 * A URL with its query string, its fragment and any `user:password@`
 * removed.
 *
 * It never parses. `new URL()` throws on a root-relative path and on the
 * custom origins a desktop or phone shell serves its bundle from
 * (`app://-`, `capacitor://localhost`), and a URL that fails to parse
 * would then be passed through whole — the one case where stripping
 * matters most.
 */
export function stripUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const bare = cut === -1 ? url : url.slice(0, cut);
  return bare.replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** Free text with URLs stripped, and email addresses and bearer tokens
 *  replaced. Used on every message and every exception value. */
export function scrubText(text: string): string {
  // URLs first. Stripping a URL removes any `user:password@` before the
  // email rule could half-match it, and removes any address that was
  // only ever present inside a query string.
  return text
    .replace(BEARER, "Bearer [redacted]")
    .replace(URL_IN_TEXT, (url) => stripUrl(url))
    .replace(QUERY_IN_TEXT, (rest) => (rest.includes("=") ? "" : rest))
    .replace(EMAIL, "[email]");
}

/**
 * One breadcrumb reduced to what may be sent, or `null` to drop it.
 *
 * Dropping is the common case: a console breadcrumb holds whatever the
 * app decided to print, and a DOM breadcrumb names the field that was
 * typed into. Only the categories the `requests` field authorises
 * survive, and they survive as a method, a status and a stripped URL —
 * never as the message the SDK built, which repeats the full URL.
 */
export function scrubBreadcrumb(
  breadcrumb: ReportBreadcrumb,
  fields: readonly ReportField[] = REPORT_FIELDS,
): ReportBreadcrumb | null {
  const category = breadcrumb.category ?? "";
  if (!allowedBreadcrumbs(fields).has(category)) return null;
  const data = breadcrumb.data ?? {};
  const kept: Record<string, unknown> = {};
  if (category === "navigation") {
    if (typeof data.from === "string") kept.from = stripUrl(data.from);
    if (typeof data.to === "string") kept.to = stripUrl(data.to);
  } else {
    if (typeof data.method === "string") kept.method = data.method;
    if (typeof data.status_code === "number") kept.status_code = data.status_code;
    if (typeof data.url === "string") kept.url = stripUrl(data.url);
  }
  return {
    type: breadcrumb.type,
    category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
    data: kept,
  };
}

export interface ScrubOptions {
  /** The release this build reports under. Replaces whatever the SDK
   *  put there, so one build cannot report under another's name. */
  release?: string;
  /** The platform the build is for. Set here rather than detected, so it
   *  is a property of the build and never of the device. */
  platform?: string;
  /** The fields a report may carry. Defaults to the real allowlist; a
   *  test passes its own to prove the rules follow the list. */
  fields?: readonly ReportField[];
}

/**
 * An event with everything outside the allowlist removed, and the
 * release and platform normalised to this build's.
 *
 * Mutates and returns the event it is given, because that is what an
 * SDK's `beforeSend` hook expects to hand on.
 */
export function scrubEvent(event: ReportEvent, options: ScrubOptions = {}): ReportEvent {
  const fields = options.fields ?? REPORT_FIELDS;
  const keys = allowedEventKeys(fields);
  const contexts = allowedContexts(fields);
  const tags = allowedTags(fields);
  const headers = allowedRequestHeaders(fields);

  // Allowlist, not blocklist: a key this code has never heard of — a new
  // SDK version's, or one an integration added — is gone by default.
  for (const key of Object.keys(event)) {
    if (!keys.has(key)) delete event[key];
  }

  if (event.request) {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.request.headers ?? {})) {
      if (headers.has(name.toLowerCase()) && typeof value === "string") kept[name] = value;
    }
    event.request = {
      ...(event.request.url ? { url: stripUrl(event.request.url) } : {}),
      ...(Object.keys(kept).length > 0 ? { headers: kept } : {}),
    };
  }

  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!contexts.has(key)) delete event.contexts[key];
    }
  }

  if (event.tags) {
    for (const key of Object.keys(event.tags)) {
      if (!tags.has(key)) delete event.tags[key];
    }
  }

  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.logentry) {
    if (typeof event.logentry.message === "string") {
      event.logentry.message = scrubText(event.logentry.message);
    }
    // The parameters a formatted message was built from. The message
    // itself is scrubbed; its ingredients are dropped whole.
    delete event.logentry.params;
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = stripUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = stripUrl(frame.abs_path);
      delete frame.vars;
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((crumb) => scrubBreadcrumb(crumb, fields))
      .filter((crumb): crumb is ReportBreadcrumb => crumb !== null);
  }

  if (options.release !== undefined) event.release = options.release;
  if (options.platform !== undefined) {
    event.tags = { ...event.tags, platform: options.platform };
  }

  return event;
}
