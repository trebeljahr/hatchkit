/*
 * cli/src/features/error-reporting/allowlist.ts — the one list of what
 * an error report may carry.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * A project that turns on error reporting ends up describing the same
 * thing twice: once in the scrubber that runs in the browser, and once
 * in the sentence on the privacy page. The two are written months
 * apart, and nothing compares them. The failure is not a crash — it is
 * a page that still promises "reports carry no session token" a year
 * after an SDK upgrade started attaching cookies, and that promise is
 * the part a user actually reads. A wrong sentence on a privacy page is
 * worse than no page, because it is the thing the user relied on.
 *
 * So the list lives here, once. `scrub.ts` derives the keys it keeps
 * from it, `render.ts` writes those same keys into the generated client
 * code, and `privacy.ts` writes the page text from the same entries.
 * Add a field and all three change together; remove one and they change
 * back. Nothing else in this feature may decide what a report carries.
 *
 * The event shape below is the Sentry protocol's, because that is what
 * the endpoint speaks (GlitchTip self-hosted, or any other server that
 * accepts it). The types are declared here rather than imported from
 * `@sentry/browser` on purpose: the CLI must not depend on the SDK it
 * generates code for, and the scrubber has to be testable without it.
 */

/** One stack frame of a reported error. A subset of the SDK's `StackFrame`. */
export interface ReportFrame {
  filename?: string;
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  /** Local variables the SDK captured for this frame. Never sent: a local
   *  variable holds whatever the user typed. */
  vars?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One thrown value in a report, with the frames that led to it. */
export interface ReportException {
  type?: string;
  value?: string;
  stacktrace?: { frames?: ReportFrame[] };
  [key: string]: unknown;
}

/** One entry in the trail of what the app did before the error. */
export interface ReportBreadcrumb {
  type?: string;
  category?: string;
  level?: string;
  message?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The request the page was serving when the error happened. */
export interface ReportRequest {
  url?: string;
  headers?: Record<string, string>;
  cookies?: unknown;
  data?: unknown;
  query_string?: unknown;
  [key: string]: unknown;
}

/**
 * An error event on its way to the endpoint — the object the SDK hands
 * to `beforeSend`, reduced to the parts this feature reasons about. The
 * index signature is what makes the scrubber's rule enforceable: it
 * deletes every key it does not recognise, including keys added by a
 * future SDK version that this code has never heard of.
 */
export interface ReportEvent {
  event_id?: string;
  timestamp?: number;
  /** The SDK's own language tag ("javascript"), not the platform tag of
   *  {@link REPORT_FIELDS}. Two different things with one name; the
   *  platform a build is for is a tag, and lives in `tags.platform`. */
  platform?: string;
  environment?: string;
  release?: string;
  level?: string;
  message?: string;
  logentry?: { message?: string; params?: unknown };
  exception?: { values?: ReportException[] };
  breadcrumbs?: ReportBreadcrumb[];
  request?: ReportRequest;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: unknown;
  extra?: unknown;
  server_name?: string;
  [key: string]: unknown;
}

export type ReportFieldId = "error" | "page" | "requests" | "browser" | "release" | "platform";

/**
 * One thing a report is allowed to carry.
 *
 * `summary` is the words the privacy page uses, so it is written for the
 * person reading that page, not for the developer. `safeBecause` is the
 * reason it may be sent at all, which is what a reviewer asks about; it
 * is not printed on the page, but it is the record of the decision.
 */
export interface ReportField {
  id: ReportFieldId | string;
  /** What it is, in plain words. Lowercase, no full stop — the privacy
   *  page renders it as a bullet under "A report contains:". */
  summary: string;
  /** Why sending it is safe. The reason the field survived review. */
  safeBecause: string;
  /** Top-level keys of an event this field authorises. Everything else
   *  is deleted, whether or not this code has heard of it. */
  eventKeys: readonly string[];
  /** `contexts` sub-keys this field authorises. */
  contexts?: readonly string[];
  /** `tags` this field authorises. */
  tags?: readonly string[];
  /** `request.headers` names this field authorises. */
  requestHeaders?: readonly string[];
  /** `breadcrumbs[].category` values this field authorises. */
  breadcrumbs?: readonly string[];
}

/**
 * Everything a report may carry, and nothing else.
 *
 * Two entries deserve their reason spelled out here rather than only in
 * `safeBecause`:
 *
 *  - **page** and **requests** keep URLs, but never a query string.
 *    Invitation ids, device codes and return-to targets live after the
 *    question mark, and an API that takes its input as a query parameter
 *    puts the whole input there. A URL with its query removed says which
 *    screen broke; a URL with its query says who was on it.
 *  - **browser** is the user-agent string and what the SDK derives from
 *    it. It is the one header that survives, because "only on Safari 17"
 *    is most of what makes a report actionable.
 */
export const REPORT_FIELDS: readonly ReportField[] = [
  {
    id: "error",
    summary: "the error message and where in the code it happened",
    safeBecause:
      "the message and the stack come from the app's own code, and the scrubber replaces email addresses and bearer tokens that a server refusal may have quoted into the message",
    eventKeys: ["exception", "message", "logentry", "level"],
    tags: ["source"],
  },
  {
    id: "page",
    summary: "the address of the page, without anything after the question mark",
    safeBecause:
      "the path names the screen that broke; the query string is removed before the report leaves the browser, so invitation ids, device codes and return-to targets never travel with it",
    eventKeys: ["request"],
  },
  {
    id: "requests",
    summary: "the addresses, methods and status codes of the last requests the app made",
    safeBecause:
      "a status code and a path show which call failed first; the query string is removed, the request body is never read, and only network and navigation entries are kept",
    eventKeys: ["breadcrumbs"],
    breadcrumbs: ["fetch", "xhr", "navigation"],
  },
  {
    id: "browser",
    summary: "the names of the browser and the operating system",
    safeBecause:
      "a bug that only happens in one browser is unfixable without knowing which one; this is the only request header that is kept",
    eventKeys: ["contexts"],
    contexts: ["browser", "os", "device", "runtime"],
    requestHeaders: ["User-Agent"],
  },
  {
    id: "release",
    summary: "the version of the app that reported the error",
    safeBecause:
      "the version is a property of the build, identical for every user of it, and without it a report cannot be matched to the code that produced it",
    eventKeys: ["release"],
  },
  {
    id: "platform",
    summary: "the platform the build is for",
    safeBecause:
      "the platform is fixed when the build is made, not read from the device, and the same bug often exists on one platform only",
    eventKeys: [],
    tags: ["platform"],
  },
];

/**
 * Something a report never carries, and where it would have sat.
 *
 * `plant` is what makes the promise checkable rather than decorative: a
 * test puts a recognisable marker exactly where this thing would live in
 * a real event, runs the scrubber, and searches the whole result for the
 * marker. A negative claim that nothing verifies is how the privacy page
 * drifts away from the code in the first place, so every "never" on the
 * page comes from an entry here that a test has just disproved.
 */
export interface ReportOmission {
  id: string;
  /** What is never sent, in plain words. Rendered as a bullet under
   *  "A report never contains:". */
  summary: string;
  /** Writes `marker` into the event where this thing would appear. */
  plant(event: ReportEvent, marker: string): void;
}

export const REPORT_OMISSIONS: readonly ReportOmission[] = [
  {
    id: "person",
    summary: "your name or your email address",
    plant(event, marker) {
      event.user = { id: marker, email: `${marker}@example.com`, ip_address: "203.0.113.4" };
    },
  },
  {
    id: "session",
    summary: "your session token or your cookies",
    plant(event, marker) {
      event.request = {
        ...event.request,
        cookies: `session=${marker}`,
        headers: {
          ...event.request?.headers,
          Cookie: `session=${marker}`,
          Authorization: `Bearer ${marker}`,
        },
      };
    },
  },
  {
    id: "typed",
    summary: "anything you typed, and the fields you typed it into",
    plant(event, marker) {
      event.breadcrumbs = [
        ...(event.breadcrumbs ?? []),
        { category: "ui.input", message: `input[name=${marker}]` },
        { category: "ui.click", message: `button#${marker}` },
      ];
    },
  },
  {
    id: "console",
    summary: "what the app wrote to the browser console",
    plant(event, marker) {
      event.breadcrumbs = [
        ...(event.breadcrumbs ?? []),
        { category: "console", level: "log", message: `debug dump ${marker}` },
      ];
    },
  },
  {
    id: "body",
    summary: "the contents of any request the app made",
    plant(event, marker) {
      event.request = { ...event.request, data: { note: marker } };
    },
  },
  {
    id: "query",
    summary: "anything after the question mark in an address",
    plant(event, marker) {
      event.request = {
        ...event.request,
        url: `https://example.test/invite/?id=${marker}`,
        query_string: `id=${marker}`,
      };
    },
  },
  {
    id: "screen",
    summary: "a recording or a picture of the screen",
    plant(event, marker) {
      event.contexts = { ...event.contexts, replay: { replay_id: marker } };
    },
  },
];

/**
 * Keys the transport needs to accept the event at all, and which say
 * nothing about the person: the event's own id and time, the SDK's
 * language tag and name, and which environment the build runs in. They
 * are not report fields, so they are not on the privacy page; they are
 * the envelope the fields travel in.
 */
export const ENVELOPE_KEYS: readonly string[] = [
  "event_id",
  "timestamp",
  "platform",
  "environment",
  "type",
  "sdk",
];

/** Every top-level event key the given fields authorise, plus the
 *  envelope. `tags` and `contexts` are present only when some field
 *  actually asks for something inside them. */
export function allowedEventKeys(
  fields: readonly ReportField[] = REPORT_FIELDS,
): ReadonlySet<string> {
  const keys = new Set<string>(ENVELOPE_KEYS);
  for (const field of fields) {
    for (const key of field.eventKeys) keys.add(key);
    if (field.tags?.length) keys.add("tags");
    if (field.contexts?.length) keys.add("contexts");
  }
  return keys;
}

/** The `contexts` sub-keys the given fields authorise. */
export function allowedContexts(
  fields: readonly ReportField[] = REPORT_FIELDS,
): ReadonlySet<string> {
  return new Set(fields.flatMap((field) => field.contexts ?? []));
}

/** The tag names the given fields authorise. */
export function allowedTags(fields: readonly ReportField[] = REPORT_FIELDS): ReadonlySet<string> {
  return new Set(fields.flatMap((field) => field.tags ?? []));
}

/** The request header names the given fields authorise. Compared
 *  case-insensitively at scrub time, because a header name's case is the
 *  sender's choice and `cookie` must not slip past `Cookie`. */
export function allowedRequestHeaders(
  fields: readonly ReportField[] = REPORT_FIELDS,
): ReadonlySet<string> {
  return new Set(fields.flatMap((field) => field.requestHeaders ?? []).map((n) => n.toLowerCase()));
}

/** The breadcrumb categories the given fields authorise. */
export function allowedBreadcrumbs(
  fields: readonly ReportField[] = REPORT_FIELDS,
): ReadonlySet<string> {
  return new Set(fields.flatMap((field) => field.breadcrumbs ?? []));
}
