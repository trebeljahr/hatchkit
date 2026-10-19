/*
 * Server error-report scrub — retrofitted onto the Sentry/GlitchTip setup
 * of a project scaffolded before 2026-10-19.
 *
 * Why this exists: the starter's `packages/server/src/instrument.ts` called
 * `Sentry.init` with a DSN, an environment and a sample rate, and nothing
 * else. `@sentry/node` 10 then puts the request headers (`Cookie`
 * included), the parsed cookies (the better-auth session token) and up to
 * 10 KB of the request body on every server event, and leaving
 * `sendDefaultPii` unset does not stop it. Reporting is live as soon as
 * SENTRY_DSN is set, so every error a deployed project reports hands the
 * tracker a working session.
 *
 * The starter now keeps the options in `sentry-options.ts`, which stops the
 * body from being read and strips cookies, credential headers and the body
 * in `beforeSend` / `beforeSendTransaction`. This retrofit copies that file
 * and its test from the starter and rewrites `instrument.ts` to the
 * starter's, but only when `instrument.ts` is still the old starter file
 * byte for byte (line endings and trailing whitespace aside). Any other
 * shape is the project's own and gets a manual step instead.
 *
 * The first `sentry-options.ts` (55d07a1, copied by hand into three apps)
 * kept `Sec-WebSocket-Protocol`, where a client with no cookie jar sends
 * its session token as `bearer.<token>`, and the `http.request.header.*`
 * attributes the HTTP instrumentation copies onto spans. A project whose
 * file is still that version byte for byte gets the current one. Its
 * superseded versions are recognised by hash, so a project's own edit of
 * the file is never replaced.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureLedger, FileAction } from "../features/contract.js";

export const SERVER_INSTRUMENT_REL_PATH = "packages/server/src/instrument.ts";
export const SENTRY_OPTIONS_REL_PATH = "packages/server/src/sentry-options.ts";
export const SENTRY_OPTIONS_TEST_REL_PATH = "packages/server/src/tests/sentry-options.test.ts";

/** `instrument.ts` as the starter shipped it until 2026-10-19. */
export const PRE_SCRUB_INSTRUMENT_TS = [
  "// Sentry/GlitchTip initialization — MUST be imported first in index.ts.",
  "// GlitchTip is Sentry SDK-compatible: just use a GlitchTip DSN.",
  "",
  'import * as Sentry from "@sentry/node";',
  "",
  "if (process.env.SENTRY_DSN) {",
  "  Sentry.init({",
  "    dsn: process.env.SENTRY_DSN,",
  '    environment: process.env.NODE_ENV ?? "development",',
  '    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,',
  "  });",
  "}",
  "",
].join("\n");

/** SHA-256 of {@link normalizeSource} over each `sentry-options.ts` the
 *  starter has shipped and since replaced. The files themselves are kept
 *  in `cli/test-support/`, where the test checks these hashes. */
export const SUPERSEDED_SENTRY_OPTIONS_SHA256: readonly string[] = [
  "e125ed65bded0df1855ea4f5c0a0935444faef42cde2352cd7cfd9e532746d14", // 55d07a1
];

/** The same, for `tests/sentry-options.test.ts`. */
export const SUPERSEDED_SENTRY_OPTIONS_TEST_SHA256: readonly string[] = [
  "a92f2251e4646bf3d1bd3dd0e4c956cf48361aa13682b1a8b28f198d34ddddb9", // 55d07a1
];

/** The manual step for an `instrument.ts` hatchkit did not write. */
export const SERVER_ERROR_SCRUB_MANUAL_STEP =
  "pass the starter's sentryOptions() to Sentry.init by hand: " +
  'httpIntegration({ maxIncomingRequestBodySize: "none" }), ' +
  "requestDataIntegration({ include: { cookies: false, data: false } }), and a " +
  "beforeSend + beforeSendTransaction that delete request.cookies, request.data and the " +
  "cookie, set-cookie, authorization, proxy-authorization and sec-websocket-protocol " +
  "headers, and the matching http.request.header.* keys of contexts.trace.data and spans[].data";

export type ServerErrorScrubOutcome =
  /** `instrument.ts` was the old starter file: the scrub was copied in. */
  | "patched"
  /** `sentry-options.ts` was a superseded starter version: it was replaced. */
  | "upgraded"
  /** `sentry-options.ts` is current or the project's own, or
   *  `instrument.ts` sets its own `beforeSend`. */
  | "already"
  /** `instrument.ts` does not use the Sentry SDK at all. */
  | "not-sentry"
  /** `instrument.ts` uses the SDK but is not the old starter file.
   *  Reported as a manual step, never rewritten. */
  | "customized";

export interface ServerErrorScrubRetrofit {
  outcome: ServerErrorScrubOutcome | "absent";
  /** Every file the retrofit wrote, or would write in a dry run. */
  writes: string[];
}

/** Line endings and trailing whitespace are not an edit. */
export function normalizeSource(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

function isSuperseded(source: string, hashes: readonly string[]): boolean {
  const hash = createHash("sha256").update(normalizeSource(source)).digest("hex");
  return hashes.includes(hash);
}

/** Decide what the retrofit does with this project's files. Pure.
 *  `options` is the project's `sentry-options.ts`, when it has one. */
export function classifyServerInstrument(
  instrument: string,
  options: string | undefined,
): ServerErrorScrubOutcome {
  if (options !== undefined) {
    return isSuperseded(options, SUPERSEDED_SENTRY_OPTIONS_SHA256) ? "upgraded" : "already";
  }
  if (/\bbeforeSend\b/.test(instrument)) return "already";
  if (!instrument.includes("@sentry/")) return "not-sentry";
  return normalizeSource(instrument) === normalizeSource(PRE_SCRUB_INSTRUMENT_TS)
    ? "patched"
    : "customized";
}

/**
 * Bring the starter's server error-report scrub into an older project.
 *
 * `starterRoot` is the `starter/` template the three files are read from,
 * so the copy is always the shipped version. A project with no
 * `instrument.ts` (a server-less scaffold) is `absent`. A customized one is
 * recorded as a ledger conflict carrying the manual fix. A test file the
 * project wrote or edited is kept.
 */
export function retrofitServerErrorScrub(
  ledger: FeatureLedger,
  starterRoot: string,
): ServerErrorScrubRetrofit {
  const instrument = ledger.read(SERVER_INSTRUMENT_REL_PATH);
  if (instrument === undefined) return { outcome: "absent", writes: [] };
  const outcome = classifyServerInstrument(instrument, ledger.read(SENTRY_OPTIONS_REL_PATH));
  if (outcome === "customized") {
    ledger.conflict(SERVER_INSTRUMENT_REL_PATH, SERVER_ERROR_SCRUB_MANUAL_STEP);
    return { outcome, writes: [] };
  }
  if (outcome !== "patched" && outcome !== "upgraded") return { outcome, writes: [] };

  // Read before any write: an instrument.ts that imports a
  // sentry-options.ts nobody copied would stop the server from booting.
  const starter = (rel: string): string => {
    const abs = join(starterRoot, rel);
    if (!existsSync(abs)) throw new Error(`Starter file ${rel} not found under ${starterRoot}.`);
    return readFileSync(abs, "utf-8");
  };
  const starterOptions = starter(SENTRY_OPTIONS_REL_PATH);
  const starterTest = starter(SENTRY_OPTIONS_TEST_REL_PATH);
  const starterInstrument = starter(SERVER_INSTRUMENT_REL_PATH);

  const writes: string[] = [];
  const write = (rel: string, content: string): void => {
    const action: FileAction = ledger.writeIfChanged(rel, content);
    if (action === "written" || action === "would-write") writes.push(rel);
  };
  write(SENTRY_OPTIONS_REL_PATH, starterOptions);
  const test = ledger.read(SENTRY_OPTIONS_TEST_REL_PATH);
  if (test === undefined || isSuperseded(test, SUPERSEDED_SENTRY_OPTIONS_TEST_SHA256)) {
    write(SENTRY_OPTIONS_TEST_REL_PATH, starterTest);
  }
  // An upgrade leaves the project's instrument.ts alone unless it is the
  // pre-scrub file, which only ever pairs with a hand copy gone wrong.
  if (normalizeSource(instrument) === normalizeSource(PRE_SCRUB_INSTRUMENT_TS)) {
    write(SERVER_INSTRUMENT_REL_PATH, starterInstrument);
  }
  return { outcome, writes };
}
