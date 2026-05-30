/**
 * SES Custom MAIL FROM Domain — pure-function tests.
 *
 * The orchestrator's `configureMailFromStep` reaches out to SES + CF;
 * end-to-end coverage lives in a manual run against `collection-of-beauty`.
 * What we lock down here are the deterministic outputs every consumer of
 * the MAIL FROM helpers depends on:
 *
 *   1. `sesMailFromSubdomain(domain, label?)` — name derivation. Drifting
 *      it silently breaks DNS publish + leaves orphan SES attributes.
 *
 *   2. `sesMailFromMxTarget(region)` — region-bound MX target string.
 *      Hardcoding `eu-west-1` here would silently break every other
 *      region's MAIL FROM verification.
 *
 *   3. `SES_MAIL_FROM_SPF` — the SPF TXT value SES requires.
 *
 *   4. `decideMailFromPlan(currentState, computed, desiredBehavior)` —
 *      the adopt/setup/skip decision table. Five table-driven cases
 *      cover the relevant transitions:
 *
 *        · greenfield (no MAIL FROM set)        → set + publish
 *        · retrofit  (no MAIL FROM, was empty)  → set + publish
 *        · adopt user-set                       → never overwrite
 *        · healthy match + SUCCESS              → skip the SET call
 *        · drift (status != SUCCESS)            → re-apply
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  SES_MAIL_FROM_SPF,
  type SesMailFromState,
  decideMailFromPlan,
  sesMailFromMxTarget,
  sesMailFromSubdomain,
} from "./src/provision/ses.js";

const failures: string[] = [];

function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("sesMailFromSubdomain:");

expect("default label 'bounce' prepended to sending domain", () => {
  assert.equal(
    sesMailFromSubdomain("mail.beauty.trebeljahr.com"),
    "bounce.mail.beauty.trebeljahr.com",
  );
});

expect("custom label overrides the default", () => {
  assert.equal(sesMailFromSubdomain("mail.example.com", "feedback"), "feedback.mail.example.com");
});

expect("trims surrounding dots in the label (defense against user typo)", () => {
  assert.equal(sesMailFromSubdomain("mail.example.com", ".bounce."), "bounce.mail.example.com");
});

expect("throws on an empty label (would produce an invalid name)", () => {
  assert.throws(() => sesMailFromSubdomain("mail.example.com", ""), /cannot be empty/);
  assert.throws(() => sesMailFromSubdomain("mail.example.com", "   "), /cannot be empty/);
});

console.log("\nsesMailFromMxTarget:");

expect("eu-west-1 → feedback-smtp.eu-west-1.amazonses.com", () => {
  assert.equal(sesMailFromMxTarget("eu-west-1"), "feedback-smtp.eu-west-1.amazonses.com");
});

expect("us-east-1 → feedback-smtp.us-east-1.amazonses.com (region binding works)", () => {
  assert.equal(sesMailFromMxTarget("us-east-1"), "feedback-smtp.us-east-1.amazonses.com");
});

expect("ap-southeast-2 produces the right hostname (multi-region coverage)", () => {
  assert.equal(sesMailFromMxTarget("ap-southeast-2"), "feedback-smtp.ap-southeast-2.amazonses.com");
});

console.log("\nSES_MAIL_FROM_SPF:");

expect("exact SPF string SES expects", () => {
  assert.equal(SES_MAIL_FROM_SPF, "v=spf1 include:amazonses.com ~all");
});

expect(
  "includes the amazonses.com directive (without which SES MAIL FROM verification can't pass)",
  () => {
    assert.match(SES_MAIL_FROM_SPF, /include:amazonses\.com/);
  },
);

console.log("\ndecideMailFromPlan:");

const greenfield: SesMailFromState = {
  identity: "mail.beauty.trebeljahr.com",
  mailFromDomain: null,
  behaviorOnMxFailure: null,
  status: null,
};

expect("greenfield (no MAIL FROM set) → set + publish with the computed value", () => {
  const plan = decideMailFromPlan(
    greenfield,
    "bounce.mail.beauty.trebeljahr.com",
    "UseDefaultValue",
  );
  assert.equal(plan.mailFromDomain, "bounce.mail.beauty.trebeljahr.com");
  assert.equal(plan.adoptedExisting, false);
  assert.equal(plan.behaviorOnMxFailure, "UseDefaultValue");
  assert.equal(plan.needsSet, true);
});

expect("adopt: SES already holds a DIFFERENT user-set MAIL FROM → never overwrite", () => {
  const state: SesMailFromState = {
    identity: "mail.example.com",
    mailFromDomain: "custom.example.com",
    behaviorOnMxFailure: "RejectMessage",
    status: "SUCCESS",
  };
  const plan = decideMailFromPlan(state, "bounce.mail.example.com", "UseDefaultValue");
  assert.equal(plan.mailFromDomain, "custom.example.com", "adopted user value, NOT the default");
  assert.equal(plan.adoptedExisting, true);
  assert.equal(
    plan.behaviorOnMxFailure,
    "RejectMessage",
    "respects user's behavior choice (don't flatten to default)",
  );
  // SUCCESS state + behavior matches → no need to re-issue PutEmailIdentityMailFromAttributes.
  assert.equal(plan.needsSet, false);
});

expect(
  "healthy match: identical MAIL FROM + SUCCESS → skip the SET call (avoids unnecessary API write)",
  () => {
    const state: SesMailFromState = {
      identity: "mail.example.com",
      mailFromDomain: "bounce.mail.example.com",
      behaviorOnMxFailure: "UseDefaultValue",
      status: "SUCCESS",
    };
    const plan = decideMailFromPlan(state, "bounce.mail.example.com", "UseDefaultValue");
    // Identity match between SES + computed flips the adopted flag (semantically:
    // there IS an existing value, just one identical to what we'd set). What we
    // care about is `needsSet`: a no-op write should be skipped.
    assert.equal(plan.mailFromDomain, "bounce.mail.example.com");
    assert.equal(plan.needsSet, false, "SES already holds the same name + behavior + SUCCESS");
  },
);

expect("drift: identical MAIL FROM but status PENDING → re-apply (SES is still verifying)", () => {
  const state: SesMailFromState = {
    identity: "mail.example.com",
    mailFromDomain: "bounce.mail.example.com",
    behaviorOnMxFailure: "UseDefaultValue",
    status: "PENDING",
  };
  const plan = decideMailFromPlan(state, "bounce.mail.example.com", "UseDefaultValue");
  assert.equal(plan.needsSet, true, "PENDING means re-apply to nudge SES into re-checking");
});

expect("drift: behavior mismatch → re-apply with the desired behavior", () => {
  const state: SesMailFromState = {
    identity: "mail.example.com",
    mailFromDomain: "bounce.mail.example.com",
    behaviorOnMxFailure: "RejectMessage",
    status: "SUCCESS",
  };
  const plan = decideMailFromPlan(state, "bounce.mail.example.com", "UseDefaultValue");
  // Same name → not adopted; behaviorToApply uses the desired override.
  assert.equal(plan.adoptedExisting, false);
  assert.equal(plan.behaviorOnMxFailure, "UseDefaultValue");
  assert.equal(plan.needsSet, true);
});

expect(
  "adopt with NO behavior set on SES yet → fall back to desired behavior (don't propagate null)",
  () => {
    const state: SesMailFromState = {
      identity: "mail.example.com",
      mailFromDomain: "custom.example.com",
      behaviorOnMxFailure: null,
      status: "SUCCESS",
    };
    const plan = decideMailFromPlan(state, "bounce.mail.example.com", "UseDefaultValue");
    assert.equal(plan.mailFromDomain, "custom.example.com", "still adopt the user's domain");
    assert.equal(
      plan.behaviorOnMxFailure,
      "UseDefaultValue",
      "fall back to caller's intent when SES has no behavior set",
    );
    // Behavior changed from null → UseDefaultValue, so needsSet is true.
    assert.equal(plan.needsSet, true);
  },
);

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll SES MAIL FROM tests passed.");
