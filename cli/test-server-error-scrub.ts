/**
 * server-error-scrub.ts: the server error-report scrub retrofit.
 *
 * Until 2026-10-19 the starter's `instrument.ts` called `Sentry.init` with
 * no scrub, so every server event carried the request's Cookie header, the
 * parsed better-auth session cookie and up to 10 KB of the body. `hatchkit
 * update` brings the starter's `sentry-options.ts` into an older project;
 * these tests pin when it does and when it must not.
 *
 *  1. **Old file.** The pre-fix starter `instrument.ts` gets
 *     `sentry-options.ts`, its test and the new `instrument.ts`, all byte
 *     for byte the starter's. A second pass writes nothing.
 *  2. **Already fixed.** A project with the current `sentry-options.ts`, its
 *     own edit of it, or a `beforeSend` of its own, is left alone.
 *  3. **Superseded.** broadcastdock, mood-magic and streaks copied the first
 *     `sentry-options.ts` (55d07a1) by hand. It kept the WebSocket bearer
 *     token and the span header attributes. That exact file is replaced; a
 *     test the project edited is kept.
 *  4. **Customized.** Any other `instrument.ts` is never rewritten. The
 *     ledger records a conflict and `update` prints what to add.
 *  5. **Missing.** No `instrument.ts` means no server to scrub.
 *  6. **Dry run.** Names the files and writes none of them, both at the
 *     module and through `runUpdate`.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

process.env.HATCHKIT_CONF_DIR ??= mkdtempSync(join(tmpdir(), "server-error-scrub-conf-"));
process.env.HATCHKIT_DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "server-error-scrub-devdir-"));

const { FeatureLedger } = await import("./src/features/contract.js");
const {
  PRE_SCRUB_INSTRUMENT_TS,
  SENTRY_OPTIONS_REL_PATH,
  SENTRY_OPTIONS_TEST_REL_PATH,
  SERVER_INSTRUMENT_REL_PATH,
  SUPERSEDED_SENTRY_OPTIONS_SHA256,
  SUPERSEDED_SENTRY_OPTIONS_TEST_SHA256,
  classifyServerInstrument,
  normalizeSource,
  retrofitServerErrorScrub,
} = await import("./src/scaffold/server-error-scrub.js");

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
const SCRUB_FILES = [
  SENTRY_OPTIONS_REL_PATH,
  SENTRY_OPTIONS_TEST_REL_PATH,
  SERVER_INSTRUMENT_REL_PATH,
];

/** The first sentry-options.ts and its test, exactly as 55d07a1 shipped them. */
const OPTIONS_55D07A1 = readFileSync(
  join(import.meta.dirname, "test-support", "sentry-options-55d07a1.ts.txt"),
  "utf-8",
);
const OPTIONS_TEST_55D07A1 = readFileSync(
  join(import.meta.dirname, "test-support", "sentry-options-55d07a1.test.ts.txt"),
  "utf-8",
);
/** broadcastdock's test: the 55d07a1 test with its own example URL. */
const OWN_OPTIONS_TEST = OPTIONS_TEST_55D07A1.replaceAll("app.example", "broadcastdock.example");

function sha256(source: string): string {
  return createHash("sha256").update(normalizeSource(source)).digest("hex");
}

const failures: string[] = [];
function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        console.log(`  ✓ ${label}`);
      },
      (err: Error) => {
        failures.push(`${label}: ${err.message}`);
        console.log(`  ✗ ${label}`);
      },
    );
}

function starterFile(rel: string): string {
  return readFileSync(join(STARTER, rel), "utf-8");
}

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "server-error-scrub-"));
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), contents, "utf-8");
  }
  return dir;
}

function snapshot(dir: string): Record<string, string | undefined> {
  return Object.fromEntries(
    SCRUB_FILES.map((rel) => {
      const abs = join(dir, rel);
      return [rel, existsSync(abs) ? readFileSync(abs, "utf-8") : undefined];
    }),
  );
}

/** The starter's three files, as a project scaffolded today has them. */
function fixedByHand(): Record<string, string> {
  return Object.fromEntries(SCRUB_FILES.map((rel) => [rel, starterFile(rel)]));
}

/** An instrument.ts a project wrote itself: same SDK, its own options. */
const CUSTOM_INSTRUMENT_TS = PRE_SCRUB_INSTRUMENT_TS.replace(
  "    tracesSampleRate:",
  "    release: process.env.GIT_SHA,\n    tracesSampleRate:",
);

// ── The starter ───────────────────────────────────────────────────────
console.log("\nstarter:");

await expect("the starter's own files classify as already fixed", () => {
  assert.equal(
    classifyServerInstrument(
      starterFile(SERVER_INSTRUMENT_REL_PATH),
      starterFile(SENTRY_OPTIONS_REL_PATH),
    ),
    "already",
  );
  assert.match(
    starterFile(SERVER_INSTRUMENT_REL_PATH),
    /sentryOptions\(process\.env\.SENTRY_DSN\)/,
  );
  assert.match(starterFile(SENTRY_OPTIONS_REL_PATH), /beforeSend: scrubRequest/);
});

await expect("the starter strips the WebSocket bearer token and span header attributes", () => {
  const options = starterFile(SENTRY_OPTIONS_REL_PATH);
  assert.match(options, /"sec-websocket-protocol",/);
  assert.match(options, /scrubSpanData\(event\.contexts\?\.trace\?\.data\)/);
  assert.match(options, /for \(const span of event\.spans \?\? \[\]\) scrubSpanData\(span\.data\)/);
  assert.match(
    starterFile(SENTRY_OPTIONS_TEST_REL_PATH),
    /"Sec-WebSocket-Protocol": "bearer\.abc\.def"/,
  );
});

await expect("the 55d07a1 fixtures are the superseded hashes, and not the starter", () => {
  assert.deepEqual(SUPERSEDED_SENTRY_OPTIONS_SHA256, [sha256(OPTIONS_55D07A1)]);
  assert.deepEqual(SUPERSEDED_SENTRY_OPTIONS_TEST_SHA256, [sha256(OPTIONS_TEST_55D07A1)]);
  assert.notEqual(sha256(starterFile(SENTRY_OPTIONS_REL_PATH)), sha256(OPTIONS_55D07A1));
  assert.notEqual(sha256(starterFile(SENTRY_OPTIONS_TEST_REL_PATH)), sha256(OPTIONS_TEST_55D07A1));
  assert.doesNotMatch(OPTIONS_55D07A1, /sec-websocket-protocol/);
});

await expect("the pre-fix file is not what the starter ships now", () => {
  assert.notEqual(PRE_SCRUB_INSTRUMENT_TS, starterFile(SERVER_INSTRUMENT_REL_PATH));
  assert.doesNotMatch(PRE_SCRUB_INSTRUMENT_TS, /beforeSend/);
});

// ── 1. Old file ───────────────────────────────────────────────────────
console.log("\nold instrument.ts:");

await expect("writes sentry-options.ts, its test and the new instrument.ts", () => {
  const dir = makeProject({ [SERVER_INSTRUMENT_REL_PATH]: PRE_SCRUB_INSTRUMENT_TS });
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "patched");
  assert.deepEqual(result.writes, SCRUB_FILES);
  for (const rel of SCRUB_FILES) {
    assert.equal(
      readFileSync(join(dir, rel), "utf-8"),
      starterFile(rel),
      `${rel} is the starter's`,
    );
  }
  assert.deepEqual(ledger.conflicts(), []);
  rmSync(dir, { recursive: true, force: true });
});

await expect("CRLF line endings and trailing whitespace still count as the old file", () => {
  const crlf = PRE_SCRUB_INSTRUMENT_TS.replace(/\n/g, "  \r\n");
  assert.equal(classifyServerInstrument(crlf, undefined), "patched");
});

await expect("a second pass writes nothing", () => {
  const dir = makeProject({ [SERVER_INSTRUMENT_REL_PATH]: PRE_SCRUB_INSTRUMENT_TS });
  retrofitServerErrorScrub(new FeatureLedger(dir, false), STARTER);
  const before = snapshot(dir);
  const ledger = new FeatureLedger(dir, false);
  const second = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(second.outcome, "already");
  assert.deepEqual(second.writes, []);
  assert.deepEqual(ledger.entries, []);
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

await expect("an existing test file of the project's own is kept", () => {
  const own = "// the project's own test\n";
  const dir = makeProject({
    [SERVER_INSTRUMENT_REL_PATH]: PRE_SCRUB_INSTRUMENT_TS,
    [SENTRY_OPTIONS_TEST_REL_PATH]: own,
  });
  const result = retrofitServerErrorScrub(new FeatureLedger(dir, false), STARTER);
  assert.deepEqual(result.writes, [SENTRY_OPTIONS_REL_PATH, SERVER_INSTRUMENT_REL_PATH]);
  assert.equal(readFileSync(join(dir, SENTRY_OPTIONS_TEST_REL_PATH), "utf-8"), own);
  rmSync(dir, { recursive: true, force: true });
});

// ── 2. Already fixed ──────────────────────────────────────────────────
console.log("\nalready fixed:");

await expect("the hand-fixed starter files are a no-op", () => {
  const dir = makeProject(fixedByHand());
  const before = snapshot(dir);
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "already");
  assert.deepEqual(result.writes, []);
  assert.deepEqual(ledger.entries, []);
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

await expect("a sentry-options.ts of the project's own marks the project fixed", () => {
  const dir = makeProject({
    [SERVER_INSTRUMENT_REL_PATH]: PRE_SCRUB_INSTRUMENT_TS,
    [SENTRY_OPTIONS_REL_PATH]: "export {};\n",
  });
  const result = retrofitServerErrorScrub(new FeatureLedger(dir, false), STARTER);
  assert.equal(result.outcome, "already");
  assert.equal(
    readFileSync(join(dir, SERVER_INSTRUMENT_REL_PATH), "utf-8"),
    PRE_SCRUB_INSTRUMENT_TS,
  );
  rmSync(dir, { recursive: true, force: true });
});

await expect("an instrument.ts with its own beforeSend is a no-op", () => {
  const own = PRE_SCRUB_INSTRUMENT_TS.replace(
    "  });",
    "    beforeSend: (event) => {\n      delete event.request;\n      return event;\n    },\n  });",
  );
  const dir = makeProject({ [SERVER_INSTRUMENT_REL_PATH]: own });
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "already");
  assert.deepEqual(ledger.entries, []);
  assert.equal(existsSync(join(dir, SENTRY_OPTIONS_REL_PATH)), false);
  rmSync(dir, { recursive: true, force: true });
});

await expect("an edited 55d07a1 file is the project's own", () => {
  const edited = OPTIONS_55D07A1.replace(
    '"proxy-authorization"',
    '"proxy-authorization", "x-api-key"',
  );
  assert.notEqual(edited, OPTIONS_55D07A1);
  const dir = makeProject({
    [SERVER_INSTRUMENT_REL_PATH]: starterFile(SERVER_INSTRUMENT_REL_PATH),
    [SENTRY_OPTIONS_REL_PATH]: edited,
  });
  const ledger = new FeatureLedger(dir, false);
  assert.equal(retrofitServerErrorScrub(ledger, STARTER).outcome, "already");
  assert.deepEqual(ledger.entries, []);
  assert.equal(readFileSync(join(dir, SENTRY_OPTIONS_REL_PATH), "utf-8"), edited);
  rmSync(dir, { recursive: true, force: true });
});

// ── 3. Superseded ─────────────────────────────────────────────────────
console.log("\nthe 55d07a1 sentry-options.ts:");

/** broadcastdock, mood-magic and streaks as they are: the 55d07a1 options,
 *  their own copy of its test, and the current instrument.ts. */
function copiedBy55d07a1(test: string = OWN_OPTIONS_TEST): Record<string, string> {
  return {
    [SERVER_INSTRUMENT_REL_PATH]: starterFile(SERVER_INSTRUMENT_REL_PATH),
    [SENTRY_OPTIONS_REL_PATH]: OPTIONS_55D07A1,
    [SENTRY_OPTIONS_TEST_REL_PATH]: test,
  };
}

await expect("is replaced; the project's own test and instrument.ts are kept", () => {
  const dir = makeProject(copiedBy55d07a1());
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "upgraded");
  assert.deepEqual(result.writes, [SENTRY_OPTIONS_REL_PATH]);
  assert.equal(
    readFileSync(join(dir, SENTRY_OPTIONS_REL_PATH), "utf-8"),
    starterFile(SENTRY_OPTIONS_REL_PATH),
  );
  assert.equal(readFileSync(join(dir, SENTRY_OPTIONS_TEST_REL_PATH), "utf-8"), OWN_OPTIONS_TEST);
  assert.equal(
    readFileSync(join(dir, SERVER_INSTRUMENT_REL_PATH), "utf-8"),
    starterFile(SERVER_INSTRUMENT_REL_PATH),
  );
  assert.deepEqual(ledger.conflicts(), []);
  rmSync(dir, { recursive: true, force: true });
});

await expect("the 55d07a1 test is replaced along with it", () => {
  const dir = makeProject(copiedBy55d07a1(OPTIONS_TEST_55D07A1));
  const result = retrofitServerErrorScrub(new FeatureLedger(dir, false), STARTER);
  assert.equal(result.outcome, "upgraded");
  assert.deepEqual(result.writes, [SENTRY_OPTIONS_REL_PATH, SENTRY_OPTIONS_TEST_REL_PATH]);
  assert.deepEqual(snapshot(dir), fixedByHand());
  rmSync(dir, { recursive: true, force: true });
});

await expect("CRLF line endings still count as the 55d07a1 file", () => {
  const instrument = starterFile(SERVER_INSTRUMENT_REL_PATH);
  assert.equal(
    classifyServerInstrument(instrument, OPTIONS_55D07A1.replace(/\n/g, "\r\n")),
    "upgraded",
  );
});

await expect("a second pass writes nothing", () => {
  const dir = makeProject(copiedBy55d07a1());
  retrofitServerErrorScrub(new FeatureLedger(dir, false), STARTER);
  const before = snapshot(dir);
  const ledger = new FeatureLedger(dir, false);
  assert.equal(retrofitServerErrorScrub(ledger, STARTER).outcome, "already");
  assert.deepEqual(ledger.entries, []);
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

await expect("a dry run names sentry-options.ts and writes nothing", () => {
  const dir = makeProject(copiedBy55d07a1());
  const before = snapshot(dir);
  const ledger = new FeatureLedger(dir, true);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "upgraded");
  assert.deepEqual(
    ledger.entries.map((e) => [e.file, e.action]),
    [[SENTRY_OPTIONS_REL_PATH, "would-write"]],
  );
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

// ── 4. Customized ─────────────────────────────────────────────────────
console.log("\ncustomized instrument.ts:");

await expect("is left alone and recorded as a conflict with the manual step", () => {
  const dir = makeProject({ [SERVER_INSTRUMENT_REL_PATH]: CUSTOM_INSTRUMENT_TS });
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "customized");
  assert.deepEqual(result.writes, []);
  assert.equal(readFileSync(join(dir, SERVER_INSTRUMENT_REL_PATH), "utf-8"), CUSTOM_INSTRUMENT_TS);
  assert.equal(existsSync(join(dir, SENTRY_OPTIONS_REL_PATH)), false);
  assert.equal(existsSync(join(dir, SENTRY_OPTIONS_TEST_REL_PATH)), false);
  const [conflict, ...rest] = ledger.conflicts();
  assert.equal(rest.length, 0);
  assert.equal(conflict?.file, SERVER_INSTRUMENT_REL_PATH);
  assert.match(conflict?.detail ?? "", /maxIncomingRequestBodySize: "none"/);
  assert.match(conflict?.detail ?? "", /beforeSend \+ beforeSendTransaction/);
  assert.match(conflict?.detail ?? "", /sec-websocket-protocol/);
  assert.match(conflict?.detail ?? "", /http\.request\.header\.\* keys/);
  rmSync(dir, { recursive: true, force: true });
});

await expect("an instrument.ts without the Sentry SDK is not reported", () => {
  const dir = makeProject({ [SERVER_INSTRUMENT_REL_PATH]: "// no error reporting here\n" });
  const ledger = new FeatureLedger(dir, false);
  assert.equal(retrofitServerErrorScrub(ledger, STARTER).outcome, "not-sentry");
  assert.deepEqual(ledger.entries, []);
  rmSync(dir, { recursive: true, force: true });
});

// ── 5. Missing ────────────────────────────────────────────────────────
console.log("\nno instrument.ts:");

await expect("a project without a server is skipped", () => {
  const dir = makeProject({ "packages/client/src/app/page.tsx": "export default null;\n" });
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "absent");
  assert.deepEqual(result.writes, []);
  assert.deepEqual(ledger.entries, []);
  assert.equal(existsSync(join(dir, "packages/server")), false);
  rmSync(dir, { recursive: true, force: true });
});

// ── 6. Dry run ────────────────────────────────────────────────────────
console.log("\ndry run:");

await expect("names the three files and writes none of them", () => {
  const dir = makeProject({ [SERVER_INSTRUMENT_REL_PATH]: PRE_SCRUB_INSTRUMENT_TS });
  const before = snapshot(dir);
  const ledger = new FeatureLedger(dir, true);
  const result = retrofitServerErrorScrub(ledger, STARTER);
  assert.equal(result.outcome, "patched");
  assert.deepEqual(result.writes, SCRUB_FILES);
  assert.deepEqual(
    ledger.entries.map((e) => [e.file, e.action]),
    SCRUB_FILES.map((rel) => [rel, "would-write"]),
  );
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

// ── Through `hatchkit update` ─────────────────────────────────────────
console.log("\nhatchkit update on a scaffolded project:");

const { scaffoldApp } = await import("./src/scaffold/app.js");
const { runUpdate } = await import("./src/scaffold/update.js");
type ProjectConfig = import("./src/prompts.js").ProjectConfig;

function cfg(name: string): ProjectConfig {
  return {
    name,
    domain: `${name}.example.com`,
    baseDomain: "example.com",
    subdomain: name,
    surfaces: "fullstack",
    deployTarget: "existing",
    serverId: 1,
    serverIp: "1.2.3.4",
    features: [],
    provisionServices: [],
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
  };
}

async function runUpdateQuietly(dir: string, dryRun: boolean): Promise<string> {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
  try {
    await runUpdate(dir, {
      dryRun,
      presets: {
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
        desiredFeatures: [],
      },
    });
  } finally {
    console.log = log;
  }
  return printed.join("\n");
}

/** A fresh scaffold, turned back into one from before the fix. */
async function oldScaffold(label: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `server-error-scrub-${label}-`));
  await scaffoldApp(cfg(`scrub-${label}`), dir);
  unlinkSync(join(dir, SENTRY_OPTIONS_REL_PATH));
  unlinkSync(join(dir, SENTRY_OPTIONS_TEST_REL_PATH));
  writeFileSync(join(dir, SERVER_INSTRUMENT_REL_PATH), PRE_SCRUB_INSTRUMENT_TS, "utf-8");
  return dir;
}

await expect("a fresh scaffold ships the scrub, and update leaves it alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "server-error-scrub-fresh-"));
  try {
    await scaffoldApp(cfg("scrub-fresh"), dir);
    for (const rel of SCRUB_FILES) {
      assert.equal(readFileSync(join(dir, rel), "utf-8"), starterFile(rel), `${rel} scaffolded`);
    }
    const output = await runUpdateQuietly(dir, false);
    assert.doesNotMatch(output, /sentry-options|instrument\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("--dry-run lists the three files and changes none", async () => {
  const dir = await oldScaffold("dry");
  try {
    const before = snapshot(dir);
    const output = await runUpdateQuietly(dir, true);
    for (const rel of SCRUB_FILES) {
      assert.match(
        output,
        new RegExp(`~ would write ${rel.replace(/\./g, "\\.")}: server error reports`),
      );
    }
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("a real run brings the starter's files in", async () => {
  const dir = await oldScaffold("real");
  try {
    const output = await runUpdateQuietly(dir, false);
    assert.match(output, /✓ packages\/server\/src\/instrument\.ts: server error reports/);
    for (const rel of SCRUB_FILES) {
      assert.equal(
        readFileSync(join(dir, rel), "utf-8"),
        starterFile(rel),
        `${rel} is the starter's`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("a project with the 55d07a1 sentry-options.ts gets the current one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "server-error-scrub-upgrade-"));
  try {
    await scaffoldApp(cfg("scrub-upgrade"), dir);
    writeFileSync(join(dir, SENTRY_OPTIONS_REL_PATH), OPTIONS_55D07A1, "utf-8");
    writeFileSync(join(dir, SENTRY_OPTIONS_TEST_REL_PATH), OWN_OPTIONS_TEST, "utf-8");
    const before = snapshot(dir);
    const dry = await runUpdateQuietly(dir, true);
    assert.match(
      dry,
      /~ would write packages\/server\/src\/sentry-options\.ts: server error reports also drop the WebSocket bearer token/,
    );
    assert.doesNotMatch(
      dry,
      /would write packages\/server\/src\/(tests\/sentry-options\.test|instrument)\.ts/,
    );
    assert.deepEqual(snapshot(dir), before);
    const real = await runUpdateQuietly(dir, false);
    assert.match(
      real,
      /✓ packages\/server\/src\/sentry-options\.ts: server error reports also drop/,
    );
    assert.equal(
      readFileSync(join(dir, SENTRY_OPTIONS_REL_PATH), "utf-8"),
      starterFile(SENTRY_OPTIONS_REL_PATH),
    );
    assert.equal(readFileSync(join(dir, SENTRY_OPTIONS_TEST_REL_PATH), "utf-8"), OWN_OPTIONS_TEST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("a customized instrument.ts is kept and the note says what to add", async () => {
  const dir = await oldScaffold("custom");
  try {
    writeFileSync(join(dir, SERVER_INSTRUMENT_REL_PATH), CUSTOM_INSTRUMENT_TS, "utf-8");
    const output = await runUpdateQuietly(dir, false);
    assert.match(
      output,
      /⚠ packages\/server\/src\/instrument\.ts is not the file hatchkit scaffolded/,
    );
    assert.match(output, /Sentry\.init\(sentryOptions\(process\.env\.SENTRY_DSN\)\)/);
    assert.match(output, /proxy-authorization and sec-websocket-protocol headers/);
    assert.match(
      output,
      /requestDataIntegration\(\{ include: \{ cookies: false, data: false \} \}\)/,
    );
    assert.equal(
      readFileSync(join(dir, SERVER_INSTRUMENT_REL_PATH), "utf-8"),
      CUSTOM_INSTRUMENT_TS,
    );
    assert.equal(existsSync(join(dir, SENTRY_OPTIONS_REL_PATH)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll server-error-scrub checks passed.");
