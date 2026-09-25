/*
 * cli/src/features/verified-deploy/gate.ts — "is the thing now running
 * the thing this run built, and does it work?", as a pure function.
 *
 * ---------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------
 *
 * `scaffold/deploy-verification.ts` already generates a post-deploy gate
 * as a shell script inside the workflow. A shell script inside a YAML
 * file cannot be unit tested, so every rule it encodes is only ever
 * exercised by a real deploy — and the rules are subtle enough that
 * three of them shipped wrong before anyone noticed:
 *
 *   · An origin that answers NOTHING must count as "the commit has not
 *     landed", not as "the health check failed". Reported the other way
 *     round, the poll loop takes the first silent look as a landing and
 *     hands a server it never heard from to the gate, which gives up
 *     after a few short retries instead of waiting out the deploy.
 *   · The client's commit being right does not make the client right:
 *     the API origin is inlined into the bundle at BUILD time, so an
 *     image built against an unset variable is a perfect build of the
 *     wrong thing.
 *   · `db: true` on a health document does not prove the auth handler
 *     can read that database. A session call that answers 200 does.
 *
 * So the decision lives here, as `evaluateGate(probes, expectations)`:
 * no I/O, no clock, no network, and the same function the generated
 * script mirrors. The check order is fixed and documented in
 * `GATE_CHECK_ORDER` (types.ts) — it decides which failure a run
 * reports when several are true at once, and the poll loop keys off it.
 */

import {
  COMMIT_CHECKS,
  type GateCheck,
  type GateExpectations,
  type GateProbes,
  type GateVerdict,
} from "./types.js";

/** A gate answer with nothing wrong. */
const PASSED: GateVerdict = { ok: true };

/** Sentinel for a value the origin did not give us at all, so an error
 *  line never reads "expected abc, got undefined". */
const NONE = "<none>";

function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return NONE;
  return String(value);
}

/** The commit a health document reports.
 *
 *  Two names because a rollback target can be an older image: `commit`
 *  is the current field, `version` is what images built before it was
 *  renamed report. Accepting both is what stops a rollback to a good
 *  build from failing its own gate on a field name. */
function healthCommit(health: NonNullable<GateProbes["health"]>): unknown {
  return health.commit ?? health.version;
}

/**
 * Every check that applies to a project, in evaluation order.
 *
 * Derived from the expectations rather than from a project shape, so the
 * same function answers both "what can this project check at all" (an
 * empty API origin removes every API check) and "what is this move
 * checking" (a client-only rollback passes `serverSha: null`, which
 * drops the server's commit comparison but keeps its health checks —
 * the server is still expected to be up).
 */
export function applicableChecks(expectations: GateExpectations): GateCheck[] {
  const hasApi = expectations.apiOrigin !== "";
  const hasWeb = expectations.webOrigin !== "";
  const checks: GateCheck[] = [];
  if (hasApi && expectations.serverSha !== null) checks.push("api-commit");
  if (hasWeb && expectations.clientSha !== null) checks.push("web-commit");
  if (hasApi) checks.push("api-status", "api-db");
  if (hasWeb && hasApi) checks.push("web-api-url");
  if (hasApi) checks.push("auth-session");
  if (hasApi && hasWeb && expectations.crossOrigin) checks.push("cors");
  return checks;
}

/**
 * The gate, as one decision over one look at the origins.
 *
 * Returns the FIRST failing check in `GATE_CHECK_ORDER`, with a detail
 * line naming what was seen and what was expected. Deterministic: the
 * same probes and expectations always give the same verdict, which is
 * what lets the generated script's whole sequence be driven in a test
 * against a fake platform.
 */
export function evaluateGate(probes: GateProbes, expectations: GateExpectations): GateVerdict {
  const checks = applicableChecks(expectations);
  for (const check of checks) {
    const failure = failureOf(check, probes, expectations);
    if (failure !== null) return { ok: false, failed: check, detail: failure };
  }
  return PASSED;
}

/** True when the verdict's failure is only "the deploy has not landed
 *  yet" — the one class of failure worth waiting minutes for. */
export function isWaiting(verdict: GateVerdict): boolean {
  return !verdict.ok && verdict.failed !== undefined && COMMIT_CHECKS.includes(verdict.failed);
}

/** The detail line for one check, or null when it passed.
 *
 *  An origin that gave no answer fails its COMMIT check while a commit
 *  is expected — see the module header for why that matters. When no
 *  commit is expected of that half, a silent origin falls through to its
 *  status check instead, so it is still never a pass. */
function failureOf(
  check: GateCheck,
  probes: GateProbes,
  expectations: GateExpectations,
): string | null {
  const { health, buildInfo, sessionStatus, corsAllowOrigin } = probes;

  switch (check) {
    case "api-commit": {
      const expected = expectations.serverSha;
      if (expected === null) return null;
      if (health === null) {
        return `${expectations.apiOrigin} gave no answer, expected commit ${expected}`;
      }
      const seen = healthCommit(health);
      return seen === expected
        ? null
        : `the server reports commit ${show(seen)}, expected ${expected}`;
    }

    case "web-commit": {
      const expected = expectations.clientSha;
      if (expected === null) return null;
      if (buildInfo === null) {
        return `${expectations.webOrigin} gave no build info, expected commit ${expected}`;
      }
      return buildInfo.commit === expected
        ? null
        : `the client reports commit ${show(buildInfo.commit)}, expected ${expected}`;
    }

    case "api-status": {
      if (health === null) return `no health document from ${expectations.apiOrigin}`;
      return health.status === "ok" ? null : `health status is ${show(health.status)}, expected ok`;
    }

    case "api-db": {
      if (health === null) return `no health document from ${expectations.apiOrigin}`;
      return health.db === true ? null : `health db is ${show(health.db)}, expected true`;
    }

    case "web-api-url": {
      if (buildInfo === null) return `no build info from ${expectations.webOrigin}`;
      return buildInfo.apiUrl === expectations.apiOrigin
        ? null
        : `the client was built against ${show(buildInfo.apiUrl)}, expected ${expectations.apiOrigin}`;
    }

    case "auth-session": {
      return sessionStatus === 200
        ? null
        : `the unauthenticated session call answered ${show(sessionStatus)}, expected 200`;
    }

    case "cors": {
      return corsAllowOrigin === expectations.webOrigin
        ? null
        : `the preflight from ${expectations.webOrigin} was answered with Access-Control-Allow-Origin ${show(corsAllowOrigin)}`;
    }
  }
}
