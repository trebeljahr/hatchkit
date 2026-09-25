/**
 * The emitted release runtime: the `.mjs` files copied verbatim into a
 * scaffolded project's `scripts/`.
 *
 * These are the real implementation. CI runs them with no Hatchkit
 * installed, so a test that re-implemented their logic in TypeScript
 * would be testing the wrong thing. This file imports the template
 * files themselves and exercises them.
 *
 * What it pins:
 *   · semver comparison, including the rule that a prerelease sorts
 *     BELOW its release — get that backwards and `tag-is-new` lets a
 *     beta supersede the stable build it was cut from;
 *   · version-copy reading, including the count check that catches a
 *     compose file with two image defaults and one bump;
 *   · the rewrite plan, including build numbers moving together;
 *   · the status table built generically from channel data, with no
 *     per-channel branch anywhere in the renderer.
 *
 * Run: pnpm --filter hatchkit test:release-runtime
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getReleaseTemplatesDir, releaseRuntimeScripts } from "./src/features/release/index.js";

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
// biome-ignore lint/suspicious/noExplicitAny: the templates are plain .mjs with no types by design.
const load = (relative: string): Promise<any> =>
  import(pathToFileURL(join(TEMPLATES, "scripts", relative)).href);

// ─────────────────────────────────────────────────────────────────────
section("Every script the feature installs exists");
// ─────────────────────────────────────────────────────────────────────

for (const relative of releaseRuntimeScripts()) {
  const path = join(TEMPLATES, relative);
  assert(existsSync(path), `${relative} ships with the CLI`);
}

const config = await load("lib/release-config.mjs");
const plan = await load("lib/release-plan.mjs");
const status = await load("lib/release-status.mjs");

// ─────────────────────────────────────────────────────────────────────
section("Tags and versions");
// ─────────────────────────────────────────────────────────────────────

assert(config.isReleaseTag("v1.2.3") === true, "v1.2.3 is a release tag");
assert(config.isReleaseTag("v1.2.3-beta.1") === true, "a prerelease tag is a release tag");
assert(config.isReleaseTag("vendor-bump") === false, "a branch starting with v is not a tag");
assert(config.isReleaseTag("1.2.3") === false, "an unprefixed version is not a tag");
assert(config.isReleaseTag(undefined) === false, "undefined is not a tag");

assert(config.parseTag("v1.2.3")?.version === "1.2.3", "parseTag strips the prefix");
assert(config.parseTag("v1.2.3-rc.1")?.prerelease === "rc.1", "parseTag reports the prerelease");
assert(config.parseTag("v1.2.3")?.prerelease === null, "a stable tag has no prerelease");

assert(config.compareVersions("1.2.3", "1.2.4") === -1, "1.2.3 < 1.2.4");
assert(config.compareVersions("1.10.0", "1.9.0") === 1, "1.10.0 > 1.9.0 (numeric, not lexical)");
assert(config.compareVersions("2.0.0", "2.0.0") === 0, "equal versions compare equal");
assert(
  config.compareVersions("1.2.3-beta.1", "1.2.3") === -1,
  "a prerelease sorts BELOW its release",
);
assert(
  config.compareVersions("1.2.3-beta.2", "1.2.3-beta.10") === -1,
  "numeric prerelease identifiers compare numerically",
);

const TAGS = ["v0.9.0", "v1.0.0", "v1.1.0-rc.1", "v1.1.0", "v1.2.0"];
assert(
  config.previousStableTag(TAGS, "v1.2.0") === "v1.1.0",
  "the previous stable tag skips prereleases",
);
assert(
  config.previousStableTag(TAGS, "v1.1.0-rc.1") === "v1.0.0",
  "a prerelease's previous stable is the release below it",
);
assert(config.previousStableTag([], "v1.0.0") === null, "no tags means no previous release");

// ─────────────────────────────────────────────────────────────────────
section("Reading a version copy");
// ─────────────────────────────────────────────────────────────────────

const gradleCopy = {
  path: "android/app/build.gradle",
  pattern: String.raw`versionName\s*=?\s*["']([^"']+)["']`,
  flags: "g",
  form: "semver",
  label: "android versionName",
  expectCount: null,
};
const gradle = 'android {\n  versionCode 7\n  versionName "1.2.3"\n}\n';
const read = plan.readVersionCopy(gradleCopy, gradle);
assert(read.error === null, "a matching copy reads without error");
assert(read.values.length === 1 && read.values[0] === "1.2.3", "the capture group is the version");

const missed = plan.readVersionCopy(gradleCopy, "android {\n}\n");
assert(missed.error !== null, "a copy that matches nothing is an error, not an empty pass");

const twoDefaults = {
  ...gradleCopy,
  path: "docker-compose.selfhost.yml",
  pattern: String.raw`\$\{DEMO_VERSION:-([^}\s]+)\}`,
  form: "v-prefixed",
  label: "compose image defaults",
  expectCount: 2,
};
const halfBumped = "services:\n  a: ${DEMO_VERSION:-v1.2.3}\n";
assert(
  plan.readVersionCopy(twoDefaults, halfBumped).error !== null,
  "one default where two are expected is a failure — that is a half-bumped release",
);

// ─────────────────────────────────────────────────────────────────────
section("Checking every copy against the root version");
// ─────────────────────────────────────────────────────────────────────

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo", version: "1.2.3" }, null, 2),
  "android/app/build.gradle": gradle,
  ".env.selfhost.example": "DEMO_VERSION=v1.2.3\n",
};
const readFile = (path: string) => FILES[path] ?? null;

const CONFIG = {
  configVersion: 1,
  project: { name: "demo", versionFile: "package.json", tagPrefix: "v", packageManager: "pnpm", testCommand: null },
  channels: [],
  versionCopies: [
    gradleCopy,
    {
      path: ".env.selfhost.example",
      pattern: String.raw`^DEMO_VERSION=(\S+)$`,
      flags: "gm",
      form: "v-prefixed",
      label: "self-host version default",
      expectCount: 1,
    },
    {
      path: "android/app/build.gradle",
      pattern: String.raw`versionCode\s*=?\s*(\d+)`,
      flags: "g",
      form: "build-number",
      label: "android versionCode",
      expectCount: null,
    },
  ],
  versionReads: [],
  credentials: [],
  policy: { rules: [], warnOnly: [] },
  compat: null,
};

const clean = plan.checkVersionCopies({ config: CONFIG, version: "1.2.3", readFile });
assert(clean.problems.length === 0, `an in-sync project reports no problems (${clean.problems.join("; ")})`);
assert(clean.checked.length === 3, "every copy was actually checked");

const drifted = plan.checkVersionCopies({
  config: CONFIG,
  version: "1.3.0",
  readFile,
});
assert(drifted.problems.length >= 2, "a bumped root version reports every drifted copy");
assert(
  drifted.problems.some((problem: string) => problem.includes("android/app/build.gradle")),
  "a drift problem names the file",
);
assert(
  !drifted.problems.some((problem: string) => problem.includes("versionCode")),
  "a build number is never compared to the semver",
);

const badBuildNumber = plan.checkVersionCopies({
  config: CONFIG,
  version: "1.2.3",
  readFile: (path: string) =>
    path === "android/app/build.gradle" ? 'versionCode abc\n  versionName "1.2.3"\n' : readFile(path),
});
assert(
  badBuildNumber.problems.length > 0,
  "a build number that is not a positive integer is a problem",
);

// ─────────────────────────────────────────────────────────────────────
section("Planning the rewrite");
// ─────────────────────────────────────────────────────────────────────

const rewrite = plan.planVersionRewrite({ config: CONFIG, version: "1.3.0", readFile });
assert(rewrite.problems.length === 0, `the plan has no problems (${rewrite.problems.join("; ")})`);
const byPath = new Map(rewrite.changes.map((change: { path: string }) => [change.path, change]));

const rootChange = byPath.get("package.json") as { after: string } | undefined;
assert(rootChange !== undefined, "the root version file is rewritten");
assert(
  JSON.parse(rootChange?.after ?? "{}").version === "1.3.0",
  "the root package.json gets the new version",
);
assert(
  JSON.parse(rootChange?.after ?? "{}").name === "demo",
  "rewriting the version leaves the rest of package.json alone",
);

const gradleChange = byPath.get("android/app/build.gradle") as { after: string } | undefined;
assert(gradleChange?.after.includes('versionName "1.3.0"'), "the Android version name is rewritten");
assert(
  gradleChange?.after.includes("versionCode 8"),
  "the build number moves to the next integer, not to the semver",
);

const envChange = byPath.get(".env.selfhost.example") as { after: string } | undefined;
assert(envChange?.after.includes("DEMO_VERSION=v1.3.0"), "a v-prefixed copy keeps its prefix");

// ─────────────────────────────────────────────────────────────────────
section("Refusing a version that is not a release");
// ─────────────────────────────────────────────────────────────────────

const refusal = (current: string, next: string, tags: string[]) =>
  plan.versionRefusal({ current, next, tags, tagPrefix: "v" });

assert(refusal("1.2.3", "1.2.4", ["v1.2.3"]) === null, "a patch bump is allowed");
assert(refusal("1.2.3", "1.2.2", ["v1.2.3"]) !== null, "going backwards is refused");
assert(refusal("1.2.3", "1.2.3", ["v1.2.3"]) !== null, "re-tagging an existing version is refused");
assert(
  refusal("1.2.3", "1.2.3", []) === null,
  "the current version with no tag for it is the first release, and is allowed",
);
assert(refusal("1.2.3", "not-a-version", []) !== null, "a malformed version is refused");
assert(refusal("1.2.3", "1.3.0", ["v1.3.0"]) !== null, "a version whose tag already exists is refused");

// ─────────────────────────────────────────────────────────────────────
section("The status table is built from channel data, not from branches");
// ─────────────────────────────────────────────────────────────────────

const mobileChannel = {
  id: "mobile",
  kind: "mobile",
  label: "Phone apps",
  workflowFile: "mobile-release.yml",
  workflowName: "Mobile Release",
  trigger: "tag",
  effect: "Builds and uploads to both stores.",
  gate: { kind: "store-review", note: "Both stores review the build before anyone can install it." },
  publicDistribution: true,
  uploadSteps: [
    { step: "Upload to Google Play", label: "Google Play" },
    { step: "Upload to TestFlight", label: "TestFlight" },
  ],
  jobPrefixes: ["build"],
  credentials: ["ANDROID_KEYSTORE_BASE64"],
  absent: "unsigned",
  missingRunNote: null,
};

const run = {
  id: 1,
  status: "completed",
  conclusion: "success",
  html_url: "https://example.test/run/1",
  run_attempt: 1,
  event: "push",
  head_branch: "v1.2.3",
};
const jobs = [
  {
    id: 10,
    name: "build (android)",
    conclusion: "success",
    steps: [
      { name: "Upload to Google Play (internal)", conclusion: "success" },
      { name: "Upload to TestFlight", conclusion: "skipped" },
    ],
  },
];

const row = status.statusRow(mobileChannel, run, {
  jobs,
  annotations: ["TestFlight upload skipped: no store secrets"],
});
assert(row.state === "success", "a completed successful run reports its conclusion");
const facts = row.facts.join(" | ");
assert(/Google Play/.test(facts), "a step naming its track in parentheses still matches");
assert(/TestFlight/.test(facts), "a skipped upload is reported");
assert(
  /no store secrets/.test(facts),
  "the annotation says WHY an upload was skipped, so a deliberate skip is not read as a break",
);
assert(/review/i.test(facts), "a gated channel says what is still owed");

const notRun = status.statusRow(
  { ...mobileChannel, trigger: "manual", missingRunNote: "manual dispatch only" },
  null,
  {},
);
assert(notRun.state === "not run", "a channel with no run says so");
assert(
  notRun.facts.join(" ").includes("manual dispatch only"),
  "an expected missing run is explained, not reported as a failure",
);

const renamed = status.statusRow(
  mobileChannel,
  run,
  { jobs: [{ id: 10, name: "build", conclusion: "success", steps: [{ name: "Ship it", conclusion: "success" }] }] },
);
assert(
  !/uploaded to Google Play/i.test(renamed.facts.join(" ")),
  "a renamed step yields no fact rather than a wrong one",
);

const text = status.renderText("v1.2.3", [row, notRun]);
assert(text.includes("v1.2.3"), "the text table names the tag");
assert(text.includes("Phone apps"), "the text table lists the channel");
assert(text.includes("https://example.test/run/1"), "the text table links the run");

const markdown = status.renderMarkdown("v1.2.3", [row, notRun]);
assert(markdown.includes("| Channel |"), "the markdown table has a header row");
assert(
  markdown.split("\n").filter((line: string) => line.startsWith("|")).length >= 4,
  "the markdown table has one row per channel",
);
assert(
  markdown.includes("https://example.test/run/1"),
  "the markdown table links the run from its state",
);

const emptyText = status.renderText("v1.2.3", []);
assert(typeof emptyText === "string", "a project with no channels still renders a table");

// ─────────────────────────────────────────────────────────────────────
section("The status renderer knows nothing about any particular channel");
// ─────────────────────────────────────────────────────────────────────

const { readFileSync } = await import("node:fs");
const statusSource = readFileSync(join(TEMPLATES, "scripts/lib/release-status.mjs"), "utf-8");
for (const name of [
  "desktop-release.yml",
  "mobile-release.yml",
  "extension-release.yml",
  "Chrome Web Store",
  "TestFlight",
]) {
  assert(
    !statusSource.includes(name),
    `the generic renderer does not mention ${name} — that knowledge belongs in the config`,
  );
}

// ─────────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\n✓ release runtime");
