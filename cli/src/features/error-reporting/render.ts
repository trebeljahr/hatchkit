/*
 * cli/src/features/error-reporting/render.ts — the client modules this
 * feature generates.
 *
 * ---------------------------------------------------------------------
 * The failures this closes
 * ---------------------------------------------------------------------
 *
 *  1. **"Off" that is not off.** A project wires up an error SDK, leaves
 *     the endpoint unset, and ships it anyway. The SDK is in the bundle,
 *     it starts, it queues events, and it sends them nowhere — every
 *     user pays for the download and the startup, and nothing is gained.
 *     Here the import sits inside a condition on the inlined variable,
 *     so a build without an endpoint contains none of the SDK at all,
 *     and the prerendered output is byte-identical either way.
 *
 *  2. **Reporting that breaks sign-in.** Turning on tracing makes the
 *     SDK attach `sentry-trace` and `baggage` headers to the app's own
 *     API requests. A header the API's CORS configuration does not list
 *     fails the preflight, and the browser never sends the request — so
 *     sign-in stops working, in the name of monitoring, days after the
 *     change that caused it. The generated code therefore configures no
 *     tracing, no replay and no session tracking, and the generated
 *     comments say why, so the next person does not "improve" it back.
 *
 *  3. **A bundle that carries the whole SDK.** `import("@sentry/browser")`
 *     pulls the namespace, and a namespace cannot be tree-shaken: replay,
 *     feedback, tracing and every integration the reporter never starts
 *     come along. The generated `sdk.ts` re-exports by name, so the lazy
 *     chunk holds only what is used.
 *
 * What a report may carry is not decided here — `allowlist.ts` decides
 * it, and the generated scrubber's constants are written from it.
 */

import type { OperationalProject } from "../operational-context.js";
import {
  REPORT_FIELDS,
  type ReportField,
  allowedBreadcrumbs,
  allowedContexts,
  allowedEventKeys,
  allowedRequestHeaders,
  allowedTags,
} from "./allowlist.js";

/**
 * The build-time variable that carries the endpoint.
 *
 * It is a repository VARIABLE, never a secret: the endpoint ends up in
 * the shipped bundle by nature, because the browser is what posts to it.
 * Storing it as a secret buys nothing and costs the ability to read it
 * back. `scaffold/client-build-args.ts` already passes this name from
 * `vars.` into the client image build, with an empty fallback — this
 * feature reuses that channel and adds no second one.
 */
export const ERROR_REPORTING_DSN_VAR = "NEXT_PUBLIC_SENTRY_DSN";

/** Where the generated modules go, relative to the project root. */
export const CLIENT_ERROR_REPORTING_DIR = "packages/client/src/lib/error-reporting";

/** The npm package the generated code loads, and the version range a
 *  project should pin. Kept here so the note and the generated import
 *  cannot name different packages. */
export const ERROR_REPORTING_SDK_PACKAGE = "@sentry/browser";

/**
 * The range the SDK dependency is added with.
 *
 * It tracks the major the starter's other Sentry packages already pin
 * (`@sentry/nextjs` in the client, `@sentry/node` in the server), so one
 * project never carries two majors of the same protocol library — the
 * version that decides what `beforeSend` is handed is the version the
 * generated scrubber was written against.
 */
export const ERROR_REPORTING_SDK_VERSION = "^10.53.1";

/** A host a report can come from. Which of these a project has is
 *  decided by its manifest features, not by sniffing at runtime. */
export type ReportingPlatform = "web" | "electron" | "ios" | "android";

/** One generated file: path relative to the project root, and contents. */
export interface GeneratedFile {
  path: string;
  contents: string;
}

/**
 * The release every event is tagged with: `<name>@<version>`, plus the
 * commit when one is known.
 *
 * The commit is what tells two builds of one version apart — a deploy
 * from `main` between version bumps, or a desktop build from a branch.
 * Without it, two different bundles report under one name and a fixed
 * crash keeps looking unfixed. Undefined when there is no version,
 * which only a broken build has; the SDK then sends no release rather
 * than a made-up one.
 */
export function releaseName(name: string, version: string, commit = ""): string | undefined {
  if (!name || !version) return undefined;
  const build = commit.trim().slice(0, 12);
  return build ? `${name}@${version}+${build}` : `${name}@${version}`;
}

/**
 * The platforms a project can report from, derived from its manifest
 * features. A web-only project gets a `reportingPlatform()` that returns
 * `"web"` and reads no globals at all — there is nothing to detect, and
 * a detection branch for a shell the project does not have is dead code
 * that later reads as evidence the shell exists.
 */
export function reportingPlatforms(features: readonly string[]): readonly ReportingPlatform[] {
  const platforms: ReportingPlatform[] = ["web"];
  if (features.includes("desktop")) platforms.push("electron");
  if (features.includes("mobile")) platforms.push("ios", "android");
  return platforms;
}

/** A `new Set([...])` literal, sorted so two runs generate the same file. */
function setLiteral(name: string, values: Iterable<string>): string {
  const entries = [...values].sort();
  const items = entries.map((value) => `  ${JSON.stringify(value)},`).join("\n");
  return `const ${name}: ReadonlySet<string> = new Set([\n${items}\n]);`;
}

/**
 * The thin SDK wrapper: the names the reporter uses, re-exported.
 *
 * Nothing else in the project imports this file, and nothing imports it
 * without the endpoint condition in front of it.
 */
export function renderSdkModule(): string {
  return `/**
 * The part of ${ERROR_REPORTING_SDK_PACKAGE} the reporter uses, re-exported by name.
 *
 * Generated and OWNED by hatchkit: \`hatchkit update\` rewrites this file,
 * so an edit here is lost on the next run. Change the generator, or move
 * the code you need into a file of your own.
 *
 * \`reporter.ts\` loads this file with a dynamic
 * import, never the package itself: a dynamic import of the package takes
 * the whole namespace — replay, feedback, tracing and every integration
 * the reporter never starts — because a namespace cannot be tree-shaken.
 * A module that re-exports the names it needs can be, so the lazily
 * loaded chunk holds only these.
 */
export {
  breadcrumbsIntegration,
  browserApiErrorsIntegration,
  captureException,
  dedupeIntegration,
  eventFiltersIntegration,
  functionToStringIntegration,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
} from "${ERROR_REPORTING_SDK_PACKAGE}";
`;
}

/**
 * The generated scrubber. Its constants are written from the given
 * fields, so the browser enforces the same list the privacy page states
 * and a change to `allowlist.ts` reaches both at once.
 */
export function renderScrubModule(fields: readonly ReportField[] = REPORT_FIELDS): string {
  const bullets = fields.map((field) => ` *  - ${field.summary}`).join("\n");
  return `import type { Breadcrumb, ErrorEvent } from "${ERROR_REPORTING_SDK_PACKAGE}";

/**
 * What an error report may carry. Generated by hatchkit from its report
 * allowlist, which the privacy page is generated from as well — the two
 * cannot drift apart while both are generated.
 *
 * This file is OWNED by hatchkit: \`hatchkit update\` rewrites it, so an
 * edit here is lost on the next run. Widening what a report carries is a
 * change to the allowlist, not to this file.
 *
 * A report carries:
 *
${bullets}
 *
 * Every rule below removes something the SDK offered. Nothing here adds
 * data. The removal works by allowlist rather than by blocklist, so a
 * key a later SDK version invents is dropped by default instead of
 * being sent until someone notices it.
 */

${setLiteral("ALLOWED_EVENT_KEYS", allowedEventKeys(fields))}

${setLiteral("ALLOWED_CONTEXTS", allowedContexts(fields))}

${setLiteral("ALLOWED_TAGS", allowedTags(fields))}

/** Compared lowercased: a header name's case is the sender's choice, and
 *  \`cookie\` must not slip past a check written for \`Cookie\`. */
${setLiteral("ALLOWED_REQUEST_HEADERS", allowedRequestHeaders(fields))}

${setLiteral("ALLOWED_BREADCRUMBS", allowedBreadcrumbs(fields))}

const EMAIL = /[^\\s@<>"'(),;:]+@[^\\s@<>"'(),;:]+\\.[a-z]{2,}/gi;
const BEARER = /\\bBearer\\s+[\\w.~+/=-]+/gi;
const QUERY_IN_TEXT = /[?#][^\\s"'<>]*/g;
const URL_IN_TEXT = /(?:\\b[a-z][\\w+.-]*:\\/\\/|(?<![\\w.])\\/)[^\\s"'<>?#]*(?:[?#]\\S*)?/gi;

/**
 * A URL with its query string, its fragment and any \`user:password@\`
 * removed. It never parses: a root-relative path and a shell's own
 * origin both fail \`new URL()\`, and a URL that failed to parse would
 * then be passed through whole — the case where stripping matters most.
 */
export function stripUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const bare = cut === -1 ? url : url.slice(0, cut);
  return bare.replace(/^([a-z][\\w+.-]*:\\/\\/)[^/@]*@/i, "$1");
}

/** Free text with URLs stripped, and email addresses and bearer tokens
 *  replaced. A server refusal can quote the address it refused. */
export function scrubText(text: string): string {
  return text
    .replace(BEARER, "Bearer [redacted]")
    .replace(URL_IN_TEXT, (url) => stripUrl(url))
    .replace(QUERY_IN_TEXT, (rest) => (rest.includes("=") ? "" : rest))
    .replace(EMAIL, "[email]");
}

/** One breadcrumb reduced to a method, a status and a stripped URL, or
 *  null to drop it. Console and DOM entries are always dropped: one holds
 *  whatever the app printed, the other names the field that was typed
 *  into. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const category = breadcrumb.category ?? "";
  if (!ALLOWED_BREADCRUMBS.has(category)) return null;
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
  release?: string;
  platform?: string;
}

/** An event with everything outside the allowlist removed, and the
 *  release and platform set to this build's. Mutates and returns it, the
 *  way the SDK's beforeSend hook expects. */
export function scrubEvent(event: ErrorEvent, options: ScrubOptions = {}): ErrorEvent {
  const bag = event as unknown as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (!ALLOWED_EVENT_KEYS.has(key)) delete bag[key];
  }

  if (event.request) {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.request.headers ?? {})) {
      if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase()) && typeof value === "string") {
        kept[name] = value;
      }
    }
    event.request = {
      ...(event.request.url ? { url: stripUrl(event.request.url) } : {}),
      ...(Object.keys(kept).length > 0 ? { headers: kept } : {}),
    };
  }

  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!ALLOWED_CONTEXTS.has(key)) delete event.contexts[key];
    }
  }

  if (event.tags) {
    for (const key of Object.keys(event.tags)) {
      if (!ALLOWED_TAGS.has(key)) delete event.tags[key];
    }
  }

  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.logentry) {
    if (typeof event.logentry.message === "string") {
      event.logentry.message = scrubText(event.logentry.message);
    }
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
      .map(scrubBreadcrumb)
      .filter((crumb): crumb is Breadcrumb => crumb !== null);
  }

  if (options.release !== undefined) event.release = options.release;
  if (options.platform !== undefined) {
    event.tags = { ...event.tags, platform: options.platform };
  }

  return event;
}
`;
}

/** The platform helpers and `reportingPlatform()` for one project's set
 *  of shells. Web-only projects get a constant. */
function renderPlatformDetection(platforms: readonly ReportingPlatform[]): string {
  const union = platforms.map((p) => `"${p}"`).join(" | ");
  const head = `/** A host this build can run on. Fixed by the build, not by the device. */
export type ReportingPlatform = ${union};
`;
  if (platforms.length === 1) {
    return `${head}
/** This build is for the browser only, so there is nothing to detect. */
export function reportingPlatform(): ReportingPlatform {
  return "web";
}
`;
  }

  const helpers: string[] = [];
  const branches: string[] = [];
  if (platforms.includes("electron")) {
    helpers.push(`/** Electron's renderer keeps its own token in the user-agent string. */
const isElectron = (): boolean =>
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");`);
    branches.push(`  if (isElectron()) return "electron";`);
  }
  if (platforms.includes("ios")) {
    helpers.push(`type CapacitorGlobal = { getPlatform?: () => string };

/** The phone shell names itself. Undefined in a browser tab. */
const capacitorPlatform = (): "ios" | "android" | null => {
  const shell = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  const name = shell?.getPlatform?.();
  if (name === "ios") return "ios";
  if (name === "android") return "android";
  return null;
};`);
    branches.push(`  const phone = capacitorPlatform();
  if (phone) return phone;`);
  }

  return `${head}
${helpers.join("\n\n")}

/**
 * Which host this is. Reads globals the shells inject, so it must run
 * after mount — during prerendering there is no window, and a value read
 * there would be baked into HTML that every host is served.
 */
export function reportingPlatform(): ReportingPlatform {
  if (typeof window === "undefined") return "web";
${branches.join("\n")}
  return "web";
}
`;
}

export interface ReporterModuleOptions {
  /** Version for the release string. */
  version: string;
  /** Commit for the release string, when the build knows one. */
  commit?: string;
}

/**
 * The generated reporter: the conditional SDK import, the queue that
 * holds errors thrown before the SDK finished loading, and the `init`
 * call that turns every generous default off.
 */
export function renderReporterModule(
  project: OperationalProject,
  options: ReporterModuleOptions,
): string {
  const platforms = reportingPlatforms(project.features);
  const release = releaseName(project.name, options.version, options.commit);
  const releaseLiteral = release ? JSON.stringify(release) : "undefined";
  const dsn = ERROR_REPORTING_DSN_VAR;

  return `import { scrubBreadcrumb, scrubEvent } from "./scrub";
import type * as Sdk from "./sdk";

/**
 * Error reports from ${project.name}, to a Sentry-protocol endpoint.
 *
 * Generated and OWNED by hatchkit: \`hatchkit update\` rewrites this file,
 * so an edit here is lost on the next run. Call the two exports at the
 * bottom from your own code; do not tune this one in place.
 *
 * Off unless this build has an endpoint. \`${dsn}\` is inlined at build
 * time with an empty fallback, so the condition in front of the import below
 * is a literal in every build: without an endpoint the bundler folds it
 * away and none of the SDK is shipped. Empty means off, not "on with
 * nowhere to send".
 *
 * Nothing here runs before the app mounts. The SDK arrives as a dynamic
 * import started from an effect, so it is in neither the prerendered HTML
 * nor the first chunks, and the platform is read only once the shell's
 * globals exist.
 *
 * What a report may carry is \`scrub.ts\`, and the privacy page states the
 * same list in plain words. What this file adds is the release and the
 * platform, and nothing else.
 *
 * No tracing, no replay, no session tracking. That is not a preference:
 * tracing makes the SDK add \`sentry-trace\` and \`baggage\` headers to this
 * app's own API requests, the API's CORS configuration does not list
 * them, the preflight fails, and sign-in stops working — in the name of
 * monitoring. Replay records the screen, and session tracking sends a
 * ping on every page load. With none of them, the SDK sends something
 * only when an error happens.
 */

/** The SDK surface the reporter uses: the named re-exports in \`sdk.ts\`. */
type Sentry = typeof Sdk;

/** Where an error was caught. Sent as the \`source\` tag. */
export interface ReportContext {
  source: "boundary" | "global" | "listener";
}

export interface ErrorReporter {
  /** Loads and starts the SDK once. Resolves false with no endpoint, or
   *  when the SDK chunk failed to load. */
  start(): Promise<boolean>;
  /** Reports one error. Does nothing in a build with no endpoint. */
  report(error: unknown, context: ReportContext): void;
}

export interface ErrorReporterOptions {
  dsn: string;
  /** Imports the SDK. Never called when \`dsn\` is empty. */
  load: () => Promise<Sentry>;
  release: string | undefined;
  environment: string;
  /** Read when the SDK starts, which is always after mount. */
  platform: () => ReportingPlatform;
}

/** Errors held while the SDK loads. An error thrown during startup is
 *  the one most likely to matter, so a few are kept rather than lost. */
const MAX_PENDING = 20;

/** The release every event is tagged with. */
export const RELEASE = ${releaseLiteral};

${renderPlatformDetection(platforms)}
export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  let started: Promise<boolean> | null = null;
  let sdk: Sentry | null = null;
  let pending: Array<{ error: unknown; context: ReportContext }> = [];

  const capture = (client: Sentry, error: unknown, context: ReportContext): void => {
    client.captureException(error, { tags: { source: context.source } });
  };

  const start = (): Promise<boolean> => {
    if (!options.dsn) return Promise.resolve(false);
    started ??= options
      .load()
      .then((client) => {
        const platform = options.platform();
        client.init({
          dsn: options.dsn,
          release: options.release,
          environment: options.environment,
          sendDefaultPii: false,
          sendClientReports: false,
          // The list replaces the SDK's defaults rather than adding to
          // them, which is what leaves out the ping on every page load,
          // the culture context, and the console and DOM breadcrumbs.
          defaultIntegrations: false,
          integrations: [
            client.eventFiltersIntegration(),
            client.functionToStringIntegration(),
            client.browserApiErrorsIntegration(),
            client.breadcrumbsIntegration({
              console: false,
              dom: false,
              sentry: false,
              fetch: true,
              xhr: true,
              history: true,
            }),
            client.globalHandlersIntegration(),
            client.linkedErrorsIntegration(),
            client.dedupeIntegration(),
            client.httpContextIntegration(),
          ],
          maxBreadcrumbs: 30,
          // Dropped here as well as in beforeSend, so a breadcrumb that
          // may not be sent is never even stored.
          beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
          beforeSend: (event) =>
            scrubEvent(event, { release: options.release, platform }),
          initialScope: { tags: { platform } },
        });
        sdk = client;
        const held = pending;
        pending = [];
        for (const item of held) capture(client, item.error, item.context);
        return true;
      })
      .catch(() => {
        // The SDK chunk itself failed to load: offline, or a deploy
        // removed it. Caught here so it never travels on as an error of
        // the app's own.
        pending = [];
        return false;
      });
    return started;
  };

  return {
    start,
    report(error, context) {
      if (!options.dsn) return;
      if (sdk) {
        capture(sdk, error, context);
        return;
      }
      if (pending.length < MAX_PENDING) pending.push({ error, context });
      void start();
    },
  };
}

/**
 * The SDK import, inside a condition on the inlined variable in the same
 * expression. With no endpoint the condition is the literal "", the
 * bundler folds the import away, and the SDK is not in the build at all.
 * The import names \`./sdk\`, not the package, so the chunk built when
 * there is an endpoint holds only what the reporter uses.
 */
const loadSdk = (): Promise<Sentry> =>
  process.env.${dsn}
    ? import("./sdk")
    : Promise.reject(new Error("error reporting is not configured"));

const reporter = createErrorReporter({
  dsn: process.env.${dsn} ?? "",
  load: loadSdk,
  release: RELEASE,
  environment: process.env.NODE_ENV ?? "development",
  platform: reportingPlatform,
});

/** Starts reporting, if this build has an endpoint. Call it from an
 *  effect — never during render, and never at module scope. */
export const startErrorReporting = (): Promise<boolean> => reporter.start();

/** Reports an error an error boundary or a listener caught. Does nothing
 *  in a build with no endpoint. */
export const reportClientError = (error: unknown, context: ReportContext): void =>
  reporter.report(error, context);
`;
}

/** Every file this feature generates, with paths relative to the project
 *  root. The caller writes them; nothing here touches the disk. */
export function errorReportingFiles(
  project: OperationalProject,
  options: ReporterModuleOptions & { dir?: string; fields?: readonly ReportField[] },
): GeneratedFile[] {
  const dir = options.dir ?? CLIENT_ERROR_REPORTING_DIR;
  return [
    { path: `${dir}/scrub.ts`, contents: renderScrubModule(options.fields) },
    { path: `${dir}/sdk.ts`, contents: renderSdkModule() },
    { path: `${dir}/reporter.ts`, contents: renderReporterModule(project, options) },
  ];
}
