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
 */

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

/** The manual step for an `instrument.ts` hatchkit did not write. */
export const SERVER_ERROR_SCRUB_MANUAL_STEP =
  "pass the starter's sentryOptions() to Sentry.init by hand: " +
  'httpIntegration({ maxIncomingRequestBodySize: "none" }), ' +
  "requestDataIntegration({ include: { cookies: false, data: false } }), and a " +
  "beforeSend + beforeSendTransaction that delete request.cookies, request.data and the " +
  "cookie, set-cookie, authorization and proxy-authorization headers";

export type ServerErrorScrubOutcome =
  /** `instrument.ts` was the old starter file: the scrub was copied in. */
  | "patched"
  /** `sentry-options.ts` exists, or `instrument.ts` already sets `beforeSend`. */
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

function normalize(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

/** Decide what the retrofit does with this project's files. Pure. */
export function classifyServerInstrument(
  instrument: string,
  hasSentryOptions: boolean,
): ServerErrorScrubOutcome {
  if (hasSentryOptions || /\bbeforeSend\b/.test(instrument)) return "already";
  if (!instrument.includes("@sentry/")) return "not-sentry";
  return normalize(instrument) === normalize(PRE_SCRUB_INSTRUMENT_TS) ? "patched" : "customized";
}

/**
 * Bring the starter's server error-report scrub into an older project.
 *
 * `starterRoot` is the `starter/` template the three files are read from,
 * so the copy is always the shipped version. A project with no
 * `instrument.ts` (a server-less scaffold) is `absent`. A customized one is
 * recorded as a ledger conflict carrying the manual fix.
 */
export function retrofitServerErrorScrub(
  ledger: FeatureLedger,
  starterRoot: string,
): ServerErrorScrubRetrofit {
  const instrument = ledger.read(SERVER_INSTRUMENT_REL_PATH);
  if (instrument === undefined) return { outcome: "absent", writes: [] };
  const outcome = classifyServerInstrument(instrument, ledger.exists(SENTRY_OPTIONS_REL_PATH));
  if (outcome === "customized") {
    ledger.conflict(SERVER_INSTRUMENT_REL_PATH, SERVER_ERROR_SCRUB_MANUAL_STEP);
    return { outcome, writes: [] };
  }
  if (outcome !== "patched") return { outcome, writes: [] };

  // Checked before any write: an instrument.ts that imports a
  // sentry-options.ts nobody copied would stop the server from booting.
  const sources = [
    SENTRY_OPTIONS_REL_PATH,
    SENTRY_OPTIONS_TEST_REL_PATH,
    SERVER_INSTRUMENT_REL_PATH,
  ];
  for (const rel of sources) {
    if (!existsSync(join(starterRoot, rel))) {
      throw new Error(`Starter file ${rel} not found under ${starterRoot}.`);
    }
  }

  const writes: string[] = [];
  const record = (rel: string, action: FileAction): void => {
    if (action === "written" || action === "would-write") writes.push(rel);
  };
  for (const rel of [SENTRY_OPTIONS_REL_PATH, SENTRY_OPTIONS_TEST_REL_PATH]) {
    record(rel, ledger.copyIfAbsent(rel, join(starterRoot, rel)));
  }
  const starterInstrument = readFileSync(join(starterRoot, SERVER_INSTRUMENT_REL_PATH), "utf-8");
  record(
    SERVER_INSTRUMENT_REL_PATH,
    ledger.writeIfChanged(SERVER_INSTRUMENT_REL_PATH, starterInstrument),
  );
  return { outcome, writes };
}
