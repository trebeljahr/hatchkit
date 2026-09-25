/**
 * The release policy: does it refuse the combinations that are known to
 * ship something wrong, and does it refuse them for the right reason?
 *
 * Every case below is a release that would have gone out broken. The
 * point of each assertion is not that the evaluator returns a non-empty
 * array; it is that the refusal names the thing that is wrong, so
 * someone reading CI output can fix it without reading this file.
 *
 * The one case worth stating plainly: when the check runs somewhere that
 * cannot see repo secrets, the credential rules must produce a NOTE, not
 * a pass. A rule that was never evaluated and reports success is exactly
 * the silent failure this feature exists to remove.
 *
 * Run: pnpm --filter hatchkit test:release-policy
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getReleaseTemplatesDir } from "./src/features/release/index.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

const TEMPLATES = getReleaseTemplatesDir();
// biome-ignore lint/suspicious/noExplicitAny: plain .mjs, untyped by design.
const policy: any = await import(
  pathToFileURL(join(TEMPLATES, "scripts/lib/release-policy.mjs")).href
);

const PKG = (version: string) => JSON.stringify({ name: "demo", version }, null, 2);

const CHANNEL = {
  id: "mobile",
  kind: "mobile",
  label: "Phone apps",
  workflowFile: "mobile-release.yml",
  workflowName: "Mobile Release",
  trigger: "tag",
  effect: "Uploads to both stores.",
  gate: null,
  publicDistribution: true,
  uploadSteps: [],
  jobPrefixes: [],
  credentials: ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEY_ALIAS", "PLAY_SERVICE_ACCOUNT_JSON"],
  absent: "unsigned",
  missingRunNote: null,
};

function config(overrides: Record<string, unknown> = {}) {
  return {
    configVersion: 1,
    project: {
      name: "demo",
      versionFile: "package.json",
      tagPrefix: "v",
      packageManager: "pnpm",
      testCommand: null,
    },
    channels: [CHANNEL],
    versionCopies: [],
    versionReads: [],
    credentials: [],
    policy: { rules: [], warnOnly: [] },
    compat: null,
    ...overrides,
  };
}

const FILES: Record<string, string> = {
  "package.json": PKG("1.2.3"),
  "CHANGELOG.md": "# Changelog\n\n## 1.2.3 — 2026-01-01\n\nThings changed.\n",
};
const readFile = (path: string) => FILES[path] ?? null;

const run = (rules: unknown[], extra: Record<string, unknown> = {}) =>
  policy.evaluatePolicy({
    config: config({ policy: { rules, warnOnly: [] }, ...extra }),
    tag: "v1.2.3",
    tags: ["v1.1.0"],
    readFile,
    secretsPresent: new Set<string>(),
    ...extra,
  });

const errorsOf = (result: { problems: Array<{ severity: string; message: string }> }) =>
  result.problems.filter((problem) => problem.severity === "error");
/** The whole refusal a person sees: the rule's standing explanation
 *  plus the detail naming this failure's particulars. */
const messages = (result: { problems: Array<{ message: string; detail?: string }> }) =>
  result.problems.map((problem) => `${problem.message} ${problem.detail ?? ""}`).join(" | ");

// ─────────────────────────────────────────────────────────────────────
section("A version that does not match the tag");
// ─────────────────────────────────────────────────────────────────────

const RULE_VERSION = {
  id: "version-matches-tag",
  kind: "version-matches-tag",
  message: "The version must equal the tag.",
};

assert(errorsOf(run([RULE_VERSION])).length === 0, "a matching version and tag pass");

const mismatched = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_VERSION], warnOnly: [] } }),
  tag: "v1.3.0",
  tags: ["v1.1.0"],
  readFile,
  secretsPresent: new Set<string>(),
});
assert(errorsOf(mismatched).length === 1, "a version that does not match the tag is refused");
assert(
  /1\.2\.3/.test(messages(mismatched)) && /1\.3\.0/.test(messages(mismatched)),
  "the refusal names both numbers, so the fix is obvious",
);

// ─────────────────────────────────────────────────────────────────────
section("A copy of the version that drifted");
// ─────────────────────────────────────────────────────────────────────

const RULE_COPIES = {
  id: "version-copies-match",
  kind: "version-copies-match",
  message: "Every copy must match the root.",
};
const driftConfig = config({
  policy: { rules: [RULE_COPIES], warnOnly: [] },
  versionCopies: [
    {
      path: "android/app/build.gradle",
      pattern: String.raw`versionName\s*=?\s*["']([^"']+)["']`,
      flags: "g",
      form: "semver",
      label: "android versionName",
      expectCount: null,
    },
  ],
});
const drift = policy.evaluatePolicy({
  config: driftConfig,
  tag: "v1.2.3",
  tags: [],
  readFile: (path: string) =>
    path === "android/app/build.gradle" ? 'versionName "1.2.2"\n' : readFile(path),
  secretsPresent: new Set<string>(),
});
assert(errorsOf(drift).length >= 1, "a drifted copy is refused");
assert(
  /android/.test(messages(drift)),
  "the refusal names the file that drifted, not just that one did",
);

// ─────────────────────────────────────────────────────────────────────
section("A prerelease tag reaching a public channel");
// ─────────────────────────────────────────────────────────────────────

const RULE_PRERELEASE = {
  id: "no-prerelease-to-public",
  kind: "no-prerelease-to-public",
  channels: ["mobile"],
  message: "A prerelease must not reach Phone apps.",
};

const stable = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_PRERELEASE], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set<string>(),
});
assert(errorsOf(stable).length === 0, "a stable tag reaches a public channel freely");

const prerelease = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_PRERELEASE], warnOnly: [] } }),
  tag: "v1.2.3-beta.1",
  tags: [],
  readFile: (path: string) => (path === "package.json" ? PKG("1.2.3-beta.1") : readFile(path)),
  secretsPresent: new Set<string>(),
});
assert(errorsOf(prerelease).length === 1, "a prerelease tag reaching a public channel is refused");
assert(/Phone apps/.test(messages(prerelease)), "the refusal names the channel it would have reached");

// ─────────────────────────────────────────────────────────────────────
section("A half-configured credential set");
// ─────────────────────────────────────────────────────────────────────

const RULE_CREDS = {
  id: "credential-set-complete:mobile",
  kind: "credential-set-complete",
  channelId: "mobile",
  secrets: ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEY_ALIAS", "PLAY_SERVICE_ACCOUNT_JSON"],
  message: "Set all of these or none.",
};

const noneSet = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_CREDS], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set<string>(),
});
assert(errorsOf(noneSet).length === 0, "no credentials at all is a deliberate skip, not a refusal");

const allSet = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_CREDS], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set(RULE_CREDS.secrets),
});
assert(errorsOf(allSet).length === 0, "a complete credential set passes");

const halfSet = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_CREDS], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set(["ANDROID_KEYSTORE_BASE64"]),
});
assert(errorsOf(halfSet).length === 1, "a half-configured credential set is refused");
assert(
  /ANDROID_KEY_ALIAS/.test(messages(halfSet)) && /PLAY_SERVICE_ACCOUNT_JSON/.test(messages(halfSet)),
  "the refusal names the missing secrets, not the present ones",
);

// ─────────────────────────────────────────────────────────────────────
section("An artifact that would be published unsigned");
// ─────────────────────────────────────────────────────────────────────

const RULE_UNSIGNED = {
  id: "no-unsigned-publish:mobile",
  kind: "no-unsigned-publish",
  channelId: "mobile",
  signingSecrets: ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEY_ALIAS"],
  message: "Phone apps must not publish unsigned.",
};

const signed = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_UNSIGNED], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set(["ANDROID_KEYSTORE_BASE64", "ANDROID_KEY_ALIAS", "PLAY_SERVICE_ACCOUNT_JSON"]),
});
assert(errorsOf(signed).length === 0, "a signed, uploadable build passes");

const unsignedButNotUploaded = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_UNSIGNED], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set<string>(),
});
assert(
  errorsOf(unsignedButNotUploaded).length === 0,
  "no signing key AND no store key builds nothing anyone can install, and uploads nothing — allowed",
);

const unsignedAndUploaded = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_UNSIGNED], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set(["PLAY_SERVICE_ACCOUNT_JSON"]),
});
assert(
  errorsOf(unsignedAndUploaded).length === 1,
  "a store key without a signing key would publish unsigned, and is refused",
);
assert(
  /ANDROID_KEYSTORE_BASE64/.test(messages(unsignedAndUploaded)),
  "the refusal names the missing signing secret",
);

// ─────────────────────────────────────────────────────────────────────
section("A check that cannot see secrets must not report a pass");
// ─────────────────────────────────────────────────────────────────────

const blind = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_CREDS, RULE_UNSIGNED], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: null,
});
assert(errorsOf(blind).length === 0, "an unevaluated credential rule does not fail the release");
assert(blind.notes.length >= 2, "an unevaluated credential rule produces a note per rule");
assert(
  blind.notes.some((note: string) => /not (checked|evaluated)/i.test(note)),
  "the note says the rule was not evaluated, rather than implying it passed",
);

// ─────────────────────────────────────────────────────────────────────
section("Re-tagging a released version");
// ─────────────────────────────────────────────────────────────────────

const RULE_NEW = { id: "tag-is-new", kind: "tag-is-new", message: "The tag must be new." };

assert(
  errorsOf(
    policy.evaluatePolicy({
      config: config({ policy: { rules: [RULE_NEW], warnOnly: [] } }),
      tag: "v1.2.3",
      tags: ["v1.1.0", "v1.2.0"],
      readFile,
      secretsPresent: new Set<string>(),
    }),
  ).length === 0,
  "a tag above every existing tag passes",
);
assert(
  errorsOf(
    policy.evaluatePolicy({
      config: config({ policy: { rules: [RULE_NEW], warnOnly: [] } }),
      tag: "v1.2.3",
      tags: ["v1.2.3", "v1.3.0"],
      readFile,
      secretsPresent: new Set<string>(),
    }),
  ).length === 1,
  "a tag that already exists, or is below one that does, is refused",
);

// ─────────────────────────────────────────────────────────────────────
section("The written record");
// ─────────────────────────────────────────────────────────────────────

const RULE_RECORD = {
  id: "release-record",
  kind: "release-record",
  path: "CHANGELOG.md",
  headingPattern: String.raw`^#{1,3}\s*\[?v?__VERSION__\]?(\s|$|\])`,
  message: "CHANGELOG.md needs a heading for this version.",
};

assert(errorsOf(run([RULE_RECORD])).length === 0, "a changelog with the version's heading passes");
const noHeading = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_RECORD], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile: (path: string) =>
    path === "CHANGELOG.md" ? "# Changelog\n\n## 1.1.0\n" : readFile(path),
  secretsPresent: new Set<string>(),
});
assert(errorsOf(noHeading).length === 1, "a changelog missing this version's heading is refused");
assert(/CHANGELOG\.md/.test(messages(noHeading)), "the refusal names the file");

const missingFile = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_RECORD], warnOnly: [] } }),
  tag: "v1.2.3",
  tags: [],
  readFile: () => null,
  secretsPresent: new Set<string>(),
});
assert(errorsOf(missingFile).length === 1, "a missing changelog is refused, not skipped");

// ─────────────────────────────────────────────────────────────────────
section("warnOnly demotes, and an unknown rule never passes silently");
// ─────────────────────────────────────────────────────────────────────

const demoted = policy.evaluatePolicy({
  config: config({ policy: { rules: [RULE_RECORD], warnOnly: ["release-record"] } }),
  tag: "v1.2.3",
  tags: [],
  readFile: () => null,
  secretsPresent: new Set<string>(),
});
assert(errorsOf(demoted).length === 0, "a warnOnly rule does not fail the check");
assert(demoted.problems.length === 1, "a warnOnly rule is still reported");
assert(demoted.problems[0].severity === "warn", "a warnOnly rule is reported as a warning");

const unknown = policy.evaluatePolicy({
  config: config({
    policy: { rules: [{ id: "future", kind: "something-newer", message: "x" }], warnOnly: [] },
  }),
  tag: "v1.2.3",
  tags: [],
  readFile,
  secretsPresent: new Set<string>(),
});
assert(
  errorsOf(unknown).length === 1,
  "a rule this checker does not understand is an error, never a silent pass",
);

// ─────────────────────────────────────────────────────────────────────
section("Every problem is attributable");
// ─────────────────────────────────────────────────────────────────────

const all = policy.evaluatePolicy({
  config: config({
    policy: {
      rules: [RULE_VERSION, RULE_COPIES, RULE_PRERELEASE, RULE_CREDS, RULE_UNSIGNED, RULE_NEW, RULE_RECORD],
      warnOnly: [],
    },
  }),
  tag: "v1.0.0-beta.1",
  tags: ["v1.2.0"],
  readFile: () => null,
  secretsPresent: new Set(["PLAY_SERVICE_ACCOUNT_JSON"]),
});
assert(all.problems.length > 0, "a thoroughly broken release produces problems");
for (const problem of all.problems) {
  assert(typeof problem.ruleId === "string" && problem.ruleId.length > 0, "every problem names its rule");
  assert(typeof problem.message === "string" && problem.message.length > 0, "every problem has a message");
  assert(["error", "warn"].includes(problem.severity), "every problem has a severity");
}

// ─────────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\n✓ release policy");
