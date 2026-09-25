/**
 * Client error reporting — the scrubber, the generated client code, and
 * the privacy copy that is generated from the same list.
 *
 * The bugs these encode:
 *
 *   1. A report that carries more than the page admits. Error SDKs are
 *      generous by default: console output, the element that was typed
 *      into, cookies, the full URL with its query string. An invitation
 *      id, a device code and a return-to target all live after the
 *      question mark, so a page address sent whole names the person who
 *      was on it. The scrubber removes by allowlist, so a key a later
 *      SDK version invents is dropped rather than waved through.
 *   2. Reporting that breaks sign-in. Tracing makes the SDK attach
 *      `sentry-trace` and `baggage` headers to the app's own API
 *      requests; a header the API's CORS configuration does not list
 *      fails the preflight, the request never leaves the browser, and
 *      sign-in stops working days after the change that caused it. The
 *      generated code must therefore configure no tracing, no replay and
 *      no session tracking — checked by option name AND by header name,
 *      on the code with its comments removed.
 *   3. "Off" that is not off. An empty endpoint variable must mean the
 *      SDK is absent from the bundle, not present and posting nowhere:
 *      the import stays inside a condition on the inlined variable, and
 *      nothing runs at module scope, so the prerendered output is the
 *      same either way.
 *   4. A privacy page that drifts away from the code. The page's bullets
 *      are generated from REPORT_FIELDS, so a field cannot be added
 *      without the page changing, and the page cannot claim anything the
 *      list does not carry. Every "never contains" line is proved by
 *      planting a marker where that thing would live and scrubbing.
 *   5. A release string that cannot be matched to a build, or a platform
 *      branch for a shell the project does not have.
 *   6. The two ledger invariants, which `update` re-applies this module
 *      often enough to make load-bearing: a second apply writes nothing,
 *      and a dry run leaves the disk untouched while still describing
 *      the whole change.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Nothing in this feature opens the config store, but a sibling import
// could grow one — keep any store away from the user's real config.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "error-reporting-conf-"));

const { REPORT_FIELDS, REPORT_OMISSIONS, allowedEventKeys } = await import(
  "./src/features/error-reporting/allowlist.js"
);
type ReportEvent = import("./src/features/error-reporting/allowlist.js").ReportEvent;
type ReportField = import("./src/features/error-reporting/allowlist.js").ReportField;
const { scrubBreadcrumb, scrubEvent, scrubText, stripUrl } = await import(
  "./src/features/error-reporting/scrub.js"
);
const {
  ERROR_REPORTING_DSN_VAR,
  errorReportingFiles,
  releaseName,
  renderReporterModule,
  renderScrubModule,
  renderSdkModule,
  reportingPlatforms,
} = await import("./src/features/error-reporting/render.js");
const { renderPrivacyCopy } = await import("./src/features/error-reporting/privacy.js");
const { ERROR_REPORTING_SDK_PACKAGE, ERROR_REPORTING_SDK_VERSION } = await import(
  "./src/features/error-reporting/render.js"
);
const { PRIVACY_COPY_REL_PATH, applyErrorReporting } = await import(
  "./src/features/error-reporting/index.js"
);
const { FeatureLedger } = await import("./src/features/contract.js");
type OperationalProject = import("./src/features/operational-context.js").OperationalProject;
type OperationalContext = import("./src/features/operational-context.js").OperationalContext;
type FileAction = import("./src/features/contract.js").FileAction;

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

function project(overrides: Partial<OperationalProject> = {}): OperationalProject {
  return {
    name: "hatchdemo",
    domain: "hatchdemo.dev",
    topology: "single-origin",
    surfaces: "fullstack",
    features: ["mobile", "desktop"],
    ...overrides,
  };
}

/** A context over a real ledger rooted at `dir` — the same object the
 *  operational layer hands the module, so the tests exercise the write
 *  path rather than a stand-in for it. */
function context(
  dir: string,
  opts: { project?: Partial<OperationalProject>; dryRun?: boolean; force?: boolean } = {},
): OperationalContext {
  return {
    projectDir: dir,
    project: project(opts.project),
    mode: "create",
    ledger: new FeatureLedger(dir, opts.dryRun === true),
    log: () => undefined,
    force: opts.force,
  };
}

/** Every file the module generates, relative to the project root. */
const GENERATED = [
  "packages/client/src/lib/error-reporting/scrub.ts",
  "packages/client/src/lib/error-reporting/sdk.ts",
  "packages/client/src/lib/error-reporting/reporter.ts",
  PRIVACY_COPY_REL_PATH,
];

/** What the ledger did to one path, so an assertion can name the file
 *  instead of indexing into the entry list. */
function actionFor(ctx: OperationalContext, file: string): FileAction | undefined {
  return ctx.ledger.entries.find((entry) => entry.file === file)?.action;
}

function writeJson(dir: string, rel: string, value: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/**
 * An event with something in every place the SDK can put something —
 * the shape a real SDK event has, so a rule that only works on a
 * hand-trimmed object fails here.
 */
function fullEvent(): ReportEvent {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_700_000_000,
    platform: "javascript",
    environment: "production",
    release: "stale@0.0.1",
    level: "error",
    message: "boom",
    logentry: { message: "boom for user@example.com", params: ["user@example.com"] },
    exception: {
      values: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined (reading 'id')",
          stacktrace: {
            frames: [
              {
                filename: "https://hatchdemo.dev/_next/static/chunks/main.js?v=9",
                abs_path: "https://hatchdemo.dev/_next/static/chunks/main.js?v=9",
                function: "onSubmit",
                lineno: 12,
                vars: { password: "hunter2" },
              },
            ],
          },
        },
      ],
    },
    breadcrumbs: [
      {
        category: "fetch",
        data: {
          method: "POST",
          status_code: 500,
          url: "https://hatchdemo.dev/api/trpc/entries.list?input=%7B%22note%22%3A%22secret%22%7D",
        },
      },
      { category: "navigation", data: { from: "/login/?next=/app/", to: "/app/?welcome=1" } },
    ],
    request: {
      url: "https://hatchdemo.dev/invite/?id=INVITE-TOKEN",
      headers: { "User-Agent": "Mozilla/5.0 Safari/17", Cookie: "session=COOKIE-TOKEN" },
      cookies: "session=COOKIE-TOKEN",
      data: { description: "what the user typed" },
      query_string: "id=INVITE-TOKEN",
    },
    contexts: {
      browser: { name: "Safari", version: "17" },
      os: { name: "macOS" },
      replay: { replay_id: "REPLAY-ID" },
    },
    tags: { platform: "stale", source: "boundary", email: "user@example.com" },
    user: { id: "USER-ID", email: "user@example.com" },
    extra: { form: "what the user typed" },
    server_name: "some-host",
  };
}

/** Comments removed, so an assertion about configuration is not fooled
 *  by a comment that names the thing it forbids — the generated comments
 *  have to name `sentry-trace` and `baggage` to explain why they are
 *  absent. Line comments are only stripped when they start a line, so a
 *  `://` inside a regular expression survives. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

console.log("\nerror reporting\n");

// ---------------------------------------------------------------------
// The scrubber
// ---------------------------------------------------------------------

check("strips the query string, fragment and credentials from every kind of address", () => {
  assert.equal(stripUrl("https://a.dev/invite/?id=abc#x"), "https://a.dev/invite/");
  assert.equal(stripUrl("/login/?next=%2Fapp%2F"), "/login/");
  assert.equal(stripUrl("app://-/app/track/#top"), "app://-/app/track/");
  assert.equal(stripUrl("capacitor://localhost/app/"), "capacitor://localhost/app/");
  assert.equal(stripUrl("https://user:pw@api.a.dev/x"), "https://api.a.dev/x");
});

check("replaces email addresses and bearer tokens inside a message", () => {
  assert.equal(scrubText("no account for jane+w@example.co.uk"), "no account for [email]");
  assert.equal(scrubText("Authorization: Bearer a.B-1_="), "Authorization: Bearer [redacted]");
  assert.equal(
    scrubText('fetch failed: https://api.a.dev/trpc/x?input={"a":1} (500)'),
    "fetch failed: https://api.a.dev/trpc/x (500)",
  );
  const plain = "Minified React error #418";
  assert.equal(scrubText(plain), plain);
});

check("strips the query string from the page URL", () => {
  const event = scrubEvent(fullEvent());
  assert.equal(event.request?.url, "https://hatchdemo.dev/invite/");
});

check("strips the query string from request URLs, keeping method and status", () => {
  const event = scrubEvent(fullEvent());
  const [request, navigation] = event.breadcrumbs ?? [];
  assert.equal(request?.data?.url, "https://hatchdemo.dev/api/trpc/entries.list");
  assert.equal(request?.data?.method, "POST");
  assert.equal(request?.data?.status_code, 500);
  assert.equal(navigation?.data?.from, "/login/");
  assert.equal(navigation?.data?.to, "/app/");
});

check("strips the query string from stack frame paths, and drops frame variables", () => {
  const event = scrubEvent(fullEvent());
  const frame = event.exception?.values?.[0]?.stacktrace?.frames?.[0];
  assert.equal(frame?.filename, "https://hatchdemo.dev/_next/static/chunks/main.js");
  assert.equal(frame?.abs_path, "https://hatchdemo.dev/_next/static/chunks/main.js");
  assert.equal(frame?.vars, undefined);
  assert.equal(frame?.function, "onSubmit", "the frame itself still says where it happened");
});

for (const omission of REPORT_OMISSIONS) {
  check(`never sends ${omission.id}: ${omission.summary}`, () => {
    const marker = "MARKER-7f3a9c";
    const event = fullEvent();
    omission.plant(event, marker);
    const scrubbed = JSON.stringify(scrubEvent(event));
    assert.equal(
      scrubbed.includes(marker),
      false,
      `the privacy page promises this is never sent, and it survived: ${scrubbed}`,
    );
  });
}

check("keeps every allowlisted field", () => {
  const event = scrubEvent(fullEvent(), { release: "hatchdemo@1.2.3", platform: "ios" });
  assert.equal(event.exception?.values?.[0]?.type, "TypeError");
  assert.match(String(event.exception?.values?.[0]?.value), /Cannot read properties/);
  assert.equal(event.request?.headers?.["User-Agent"], "Mozilla/5.0 Safari/17");
  assert.deepEqual(event.contexts?.browser, { name: "Safari", version: "17" });
  assert.equal(event.release, "hatchdemo@1.2.3");
  assert.equal(event.tags?.platform, "ios");
  assert.equal(event.tags?.source, "boundary");
  assert.equal((event.breadcrumbs ?? []).length, 2);
});

check("drops an unknown top-level key rather than passing it through", () => {
  const event = fullEvent();
  event.somethingANewSdkAdded = { note: "MARKER-unknown" };
  const scrubbed = scrubEvent(event);
  assert.equal("somethingANewSdkAdded" in scrubbed, false);
  assert.equal(JSON.stringify(scrubbed).includes("MARKER-unknown"), false);
});

check("drops unknown contexts and unknown tags", () => {
  const event = fullEvent();
  event.contexts = { ...event.contexts, culture: { locale: "de-DE" } };
  const scrubbed = scrubEvent(event);
  assert.equal(scrubbed.contexts?.culture, undefined);
  assert.equal(scrubbed.contexts?.replay, undefined);
  assert.equal(scrubbed.tags?.email, undefined, "a tag nobody allowlisted is not a tag we send");
});

check("drops console and DOM breadcrumbs whatever they hold", () => {
  assert.equal(scrubBreadcrumb({ category: "console", message: "user@example.com" }), null);
  assert.equal(scrubBreadcrumb({ category: "ui.click", message: "input[name=email]" }), null);
  assert.equal(scrubBreadcrumb({ message: "no category at all" }), null);
});

check("the rules follow the field list, not a hard-coded set of keys", () => {
  const withoutBrowser = REPORT_FIELDS.filter((field) => field.id !== "browser");
  const scrubbed = scrubEvent(fullEvent(), { fields: withoutBrowser });
  assert.equal(scrubbed.contexts, undefined, "dropping the browser field drops its contexts");
  assert.equal(
    scrubbed.request?.headers,
    undefined,
    "the user-agent header survives only because the browser field authorises it",
  );
  assert.equal(allowedEventKeys(withoutBrowser).has("contexts"), false);
});

// ---------------------------------------------------------------------
// Absence: no tracing, no replay, no session tracking
// ---------------------------------------------------------------------

const BANNED_CONFIG = [
  "tracesSampleRate",
  "tracesSampler",
  "tracePropagationTargets",
  "browserTracingIntegration",
  "startSpan",
  "replayIntegration",
  "replaysSessionSampleRate",
  "replaysOnErrorSampleRate",
  "autoSessionTracking",
  "sessionTimingIntegration",
  "browserSessionIntegration",
];
/** The headers tracing would attach to the app's own API requests. A
 *  header the API's CORS configuration does not list fails the preflight
 *  and takes sign-in down with it — this is the check that protects it. */
const BANNED_HEADERS = ["sentry-trace", "baggage"];

const generated = errorReportingFiles(project(), { version: "1.2.3", commit: "abcdef0123456789" });

for (const file of generated) {
  check(`${file.path} configures no tracing, replay or session tracking`, () => {
    const code = withoutComments(file.contents);
    for (const name of [...BANNED_CONFIG, ...BANNED_HEADERS]) {
      assert.equal(code.includes(name), false, `generated code mentions ${name}`);
    }
  });
}

check("the generated reporter records WHY the tracing headers are absent", () => {
  const reporter = renderReporterModule(project(), { version: "1.2.3" });
  const comments = reporter.length - withoutComments(reporter).length;
  assert.ok(comments > 0, "the generated reporter has comments");
  for (const header of BANNED_HEADERS) {
    assert.ok(
      reporter.includes(header),
      `the comment has to name ${header}, or the next person adds tracing back`,
    );
  }
  assert.match(reporter, /preflight/);
});

check("the SDK is loaded by name, so the lazy chunk is not the whole package", () => {
  const sdk = renderSdkModule();
  assert.match(sdk, /export \{[\s\S]*captureException,[\s\S]*\} from "@sentry\/browser";/);
  const reporter = renderReporterModule(project(), { version: "1.2.3" });
  assert.equal(
    withoutComments(reporter).includes('"@sentry/browser"'),
    false,
    "the reporter imports ./sdk, never the package — a namespace import cannot be tree-shaken",
  );
});

check("the generated scrubber takes the SDK types only as types", () => {
  const scrub = withoutComments(renderScrubModule());
  assert.match(scrub, /^import type \{ Breadcrumb, ErrorEvent \} from "@sentry\/browser";/m);
});

// ---------------------------------------------------------------------
// Conditionality: empty means off, and nothing runs before mount
// ---------------------------------------------------------------------

check("the SDK import sits behind a condition on the inlined variable", () => {
  const flat = withoutComments(renderReporterModule(project(), { version: "1.2.3" })).replace(
    /\s+/g,
    " ",
  );
  assert.ok(
    flat.includes(`process.env.${ERROR_REPORTING_DSN_VAR} ? import("./sdk")`),
    "with no endpoint the condition is a literal, and the bundler folds the import away",
  );
  assert.equal(
    (flat.match(/import\("\.\/sdk"\)/g) ?? []).length,
    1,
    "one dynamic import of the SDK, and it is the conditional one",
  );
  assert.ok(flat.includes(`dsn: process.env.${ERROR_REPORTING_DSN_VAR} ?? ""`));
});

check("nothing runs at module scope, so nothing runs before mount", () => {
  const code = withoutComments(renderReporterModule(project(), { version: "1.2.3" }));
  const topLevelCalls = code
    .split("\n")
    .filter((line) => /^[A-Za-z_$][\w$.]*\(/.test(line))
    .filter((line) => !line.startsWith("export"));
  assert.deepEqual(topLevelCalls, [], "a call at module scope runs during import, before mount");
  assert.equal(code.includes("startErrorReporting();"), false);
  assert.match(code, /export const startErrorReporting/);
});

check("the platform is read inside a function, never while rendering", () => {
  const code = withoutComments(renderReporterModule(project(), { version: "1.2.3" }));
  for (const line of code.split("\n")) {
    if (/^(const|let|var) /.test(line)) {
      assert.equal(
        /\bwindow\b|\bnavigator\b/.test(line),
        false,
        `a global read at module scope has no window during prerender: ${line}`,
      );
    }
  }
  assert.match(code, /typeof window === "undefined"/);
});

// ---------------------------------------------------------------------
// Agreement between the allowlist and the privacy copy
// ---------------------------------------------------------------------

check("every entry in the allowlist appears in the privacy copy", () => {
  const copy = renderPrivacyCopy(project());
  for (const field of REPORT_FIELDS) {
    assert.ok(copy.markdown.includes(field.summary), `the page never mentions ${field.id}`);
  }
  for (const omission of REPORT_OMISSIONS) {
    assert.ok(copy.markdown.includes(omission.summary), `the page never mentions ${omission.id}`);
  }
});

check("the privacy copy claims nothing that is not in the allowlist", () => {
  const copy = renderPrivacyCopy(project());
  const summaries = REPORT_FIELDS.map((field) => field.summary);
  assert.deepEqual(copy.contains, summaries);
  const between = copy.markdown.slice(
    copy.markdown.indexOf(copy.containsLead) + copy.containsLead.length,
    copy.markdown.indexOf(copy.omitsLead),
  );
  const bullets = between
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  assert.deepEqual(bullets, summaries, "the page's list of what is sent IS the allowlist");
});

check("add a field and the copy changes", () => {
  const extra: ReportField = {
    id: "screen-size",
    summary: "the size of the browser window",
    safeBecause: "a layout bug depends on it",
    eventKeys: [],
    contexts: ["viewport"],
  };
  const before = renderPrivacyCopy(project());
  const after = renderPrivacyCopy(project(), { fields: [...REPORT_FIELDS, extra] });
  assert.notEqual(after.markdown, before.markdown);
  assert.ok(after.markdown.includes(extra.summary));
  assert.equal(after.contains.length, before.contains.length + 1);
});

check("who runs the endpoint is stated, and unanswered is visible", () => {
  const undecided = renderPrivacyCopy(project());
  assert.equal(undecided.unresolved, true);
  assert.match(undecided.markdown, /\[Decide before publishing/);

  const self = renderPrivacyCopy(project(), { operator: { kind: "self" } });
  assert.equal(self.unresolved, false);
  assert.match(self.markdown, /No other company receives the report\./);

  const hosted = renderPrivacyCopy(project(), {
    operator: { kind: "third-party", company: "Some Tracker Inc" },
  });
  assert.equal(hosted.unresolved, false);
  assert.match(hosted.markdown, /Some Tracker Inc runs the error tracker/);
  assert.match(hosted.markdown, /processor/);
  assert.equal(hosted.markdown.includes("No other company receives"), false);
});

check("the copy names the project and says nothing is sent without an error", () => {
  const copy = renderPrivacyCopy(project({ name: "sample-app" }));
  assert.match(copy.when, /^When sample-app hits an error/);
  assert.match(copy.when, /With no error, nothing is sent\./);
});

// ---------------------------------------------------------------------
// Release and platform follow the project
// ---------------------------------------------------------------------

check("the release string is the project's own name and version", () => {
  assert.equal(releaseName("hatchdemo", "1.2.3"), "hatchdemo@1.2.3");
  assert.equal(
    releaseName("hatchdemo", "1.2.3", "abcdef0123456789"),
    "hatchdemo@1.2.3+abcdef012345",
  );
  assert.equal(releaseName("hatchdemo", ""), undefined, "no made-up release for a broken build");
  const code = renderReporterModule(project({ name: "sample-app" }), {
    version: "0.4.0",
    commit: "0f1e2d3c4b5a6978",
  });
  assert.match(code, /export const RELEASE = "sample-app@0\.4\.0\+0f1e2d3c4b5a";/);
});

check("the platforms are the project's features, and nothing else", () => {
  assert.deepEqual(reportingPlatforms([]), ["web"]);
  assert.deepEqual(reportingPlatforms(["websocket"]), ["web"]);
  assert.deepEqual(reportingPlatforms(["desktop"]), ["web", "electron"]);
  assert.deepEqual(reportingPlatforms(["mobile", "desktop"]), [
    "web",
    "electron",
    "ios",
    "android",
  ]);
});

check("a web-only project gets no detection branch for a shell it does not have", () => {
  const code = renderReporterModule(project({ features: [] }), { version: "1.0.0" });
  assert.match(code, /export type ReportingPlatform = "web";/);
  assert.equal(code.includes("Capacitor"), false);
  assert.equal(code.includes("Electron"), false);
});

check("a mobile + desktop project detects exactly those shells", () => {
  const code = renderReporterModule(project(), { version: "1.0.0" });
  assert.match(code, /export type ReportingPlatform = "web" \| "electron" \| "ios" \| "android";/);
  assert.match(code, /navigator\.userAgent\.includes\("Electron"\)/);
  assert.match(code, /Capacitor\?: CapacitorGlobal/);
});

// ---------------------------------------------------------------------
// Write-through, on the ledger
// ---------------------------------------------------------------------

check("writes the client modules, the privacy copy and the SDK dependency", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    // The root package is versioned too, so this also proves the walk
    // takes the NEAREST version rather than the first one it can find.
    writeJson(dir, "package.json", { name: "root", private: true, version: "9.9.9" });
    writeJson(dir, "packages/client/package.json", { name: "hatchdemo", version: "2.1.0" });

    const ctx = context(dir);
    const outcome = applyErrorReporting(ctx);

    assert.equal(outcome.skipped, undefined);
    for (const file of GENERATED) {
      assert.equal(actionFor(ctx, file), "written", `${file} was not written`);
      assert.ok(existsSync(join(dir, file)), `${file} is not on disk`);
    }

    const reporter = readFileSync(join(dir, GENERATED[2]), "utf-8");
    assert.match(reporter, /RELEASE = "hatchdemo@2\.1\.0"/);

    const client = JSON.parse(readFileSync(join(dir, "packages/client/package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(
      client.dependencies?.[ERROR_REPORTING_SDK_PACKAGE],
      ERROR_REPORTING_SDK_VERSION,
      "the SDK the generated code imports has to be a dependency of the package it lives in",
    );
    const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(root.dependencies, undefined, "the dependency belongs to the client package only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the privacy copy is the generated text, under a header saying it is regenerated", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    writeJson(dir, "packages/client/package.json", { name: "hatchdemo", version: "1.0.0" });
    applyErrorReporting(context(dir));
    const written = readFileSync(join(dir, PRIVACY_COPY_REL_PATH), "utf-8");
    assert.match(written, /^<!--/, "a reader who opens the file is told not to edit it here");
    assert.match(written, /rewrites this file, so edit the allowlist/);
    assert.ok(
      written.endsWith(renderPrivacyCopy(project()).markdown),
      "the copy below the header is exactly what the allowlist generates",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("applying twice writes nothing the second time", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    writeJson(dir, "packages/client/package.json", { name: "hatchdemo", version: "2.1.0" });
    applyErrorReporting(context(dir));

    const second = context(dir);
    applyErrorReporting(second);
    const changed = second.ledger.entries.filter(
      (entry) => entry.action !== "unchanged" && entry.action !== "absent",
    );
    assert.deepEqual(
      changed,
      [],
      `a re-apply must change nothing: ${changed.map((e) => `${e.action} ${e.file}`).join(", ")}`,
    );
    assert.equal(second.ledger.touched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a dry run describes the whole change and touches no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    writeJson(dir, "packages/client/package.json", { name: "hatchdemo", version: "2.1.0" });
    const before = readFileSync(join(dir, "packages/client/package.json"), "utf-8");

    const ctx = context(dir, { dryRun: true });
    const outcome = applyErrorReporting(ctx);

    assert.equal(outcome.skipped, undefined, "a dry run still reports what it would do");
    for (const file of GENERATED) {
      assert.equal(actionFor(ctx, file), "would-write", `${file} was not described`);
      assert.equal(existsSync(join(dir, file)), false, `${file} was written during a dry run`);
    }
    assert.equal(actionFor(ctx, "packages/client/package.json"), "would-write");
    assert.equal(
      readFileSync(join(dir, "packages/client/package.json"), "utf-8"),
      before,
      "a dry run must not add the dependency either",
    );
    assert.equal(existsSync(join(dir, ".hatchkit")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a generated file the user edited is regenerated, because the module owns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    writeJson(dir, "packages/client/package.json", { name: "hatchdemo", version: "2.1.0" });
    applyErrorReporting(context(dir));
    const reporterPath = join(dir, GENERATED[2]);
    writeFileSync(reporterPath, "// hand-tuned\n", "utf-8");

    const ctx = context(dir);
    applyErrorReporting(ctx);
    assert.equal(actionFor(ctx, GENERATED[2]), "written");
    assert.match(
      readFileSync(reporterPath, "utf-8"),
      /RELEASE = "hatchdemo@2\.1\.0"/,
      "an owned file says so in its header; a tightened scrubber has to reach the project",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a pinned SDK version is reported as a conflict, not reverted", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    writeJson(dir, "packages/client/package.json", {
      name: "hatchdemo",
      version: "2.1.0",
      dependencies: { [ERROR_REPORTING_SDK_PACKAGE]: "^9.0.0" },
    });

    const ctx = context(dir);
    applyErrorReporting(ctx);

    const conflicts = ctx.ledger.conflicts();
    assert.equal(conflicts.length, 1, "the run has to say what it did not apply");
    assert.equal(conflicts[0].file, "packages/client/package.json");
    assert.match(String(conflicts[0].detail), /keeping "\^9\.0\.0"/);
    const client = JSON.parse(readFileSync(join(dir, "packages/client/package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(client.dependencies?.[ERROR_REPORTING_SDK_PACKAGE], "^9.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the version falls back to a visible placeholder rather than failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    writeJson(dir, "package.json", { name: "root", private: true });
    applyErrorReporting(context(dir));
    assert.match(readFileSync(join(dir, GENERATED[2]), "utf-8"), /RELEASE = "hatchdemo@0\.0\.0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a backend-only project is skipped with a reason, and nothing is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    const ctx = context(dir, { project: { surfaces: "backend" } });
    const outcome = applyErrorReporting(ctx);
    assert.match(String(outcome.skipped), /no browser half/);
    assert.deepEqual(ctx.ledger.entries, []);
    assert.equal(existsSync(join(dir, "packages")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the notes are only what a person has to do", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    writeJson(dir, "packages/client/package.json", { name: "hatchdemo", version: "1.0.0" });
    const notes = applyErrorReporting(context(dir)).notes.join("\n");
    assert.ok(notes.includes(`gh variable set ${ERROR_REPORTING_DSN_VAR}`));
    assert.match(notes, /repository variable, not a secret/);
    assert.match(notes, /startErrorReporting\(\) from an effect/);
    assert.match(notes, /who runs the error tracker/);
    assert.equal(
      notes.includes(PRIVACY_COPY_REL_PATH),
      false,
      "the ledger reports the files it wrote; a note that restates one is noise",
    );
    assert.equal(
      notes.includes(`Add ${ERROR_REPORTING_SDK_PACKAGE}`),
      false,
      "the dependency was merged in, so there is nothing for a person to add",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("with no package.json above the generated directory, the note says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "error-reporting-"));
  try {
    const ctx = context(dir);
    const notes = applyErrorReporting(ctx).notes.join("\n");
    assert.match(notes, /Add @sentry\/browser@/);
    assert.match(notes, /No package.json was found above it/);
    assert.equal(
      ctx.ledger.entries.some((entry) => entry.file.endsWith("package.json")),
      false,
      "there was nothing to merge into, so nothing is reported against a package.json",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all error-reporting checks passed\n");
