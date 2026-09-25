/**
 * Mobile release-plan unit tests.
 *
 * `.github/workflows/mobile-release.yml` decides every job BEFORE anything
 * is built, in a `plan` job that the build jobs are gated on. That shape
 * exists because of what the alternative does:
 *
 *   · a tag with no signing credentials must build nothing and upload
 *     nothing — an unsigned .aab attached to a public tag run reads as a
 *     release download;
 *   · a PARTIAL credential set must fail, not quietly produce a broken or
 *     unsigned build;
 *   · a prerelease tag must reach an internal track only, whatever a
 *     dispatch input asks for;
 *   · the build number must come from the run number, because both stores
 *     permanently reject a number they have already seen.
 *
 * The plan is handed booleans, never secret values, so nothing in its JSON
 * output or its job summary can leak a credential. These tests drive it
 * with fixtures.
 *
 * Run: pnpm --filter hatchkit test:mobile-release
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
const LIB = join(STARTER, "scripts/lib/mobile-release.mjs");
if (!existsSync(LIB)) {
  console.log(`\nSkipping: starter not populated at ${STARTER}`);
  console.log("Run `git submodule update --init` or symlink a checkout, then retry.\n");
  process.exit(0);
}

interface Leg {
  build: boolean;
  sign: boolean;
  upload: boolean;
  artifact: boolean;
  track?: string;
  reasons: string[];
}
interface Plan {
  version: string | null;
  tag: string | null;
  prerelease: boolean;
  buildNumber: number;
  android: Leg;
  ios: Leg;
  errors: string[];
  notes: string[];
}
interface ReleaseLib {
  planMobileRelease(input: {
    ref?: string;
    eventName?: string;
    inputs?: Record<string, string>;
    secretsPresent?: Record<string, boolean>;
    runNumber?: number;
  }): Plan;
  formatPlanSummary(plan: Plan): string;
  parseVersionTag(ref: string): { version: string; prerelease: boolean } | null;
}

const lib = (await import(pathToFileURL(LIB).href)) as unknown as ReleaseLib;

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${msg}`);
}
function section(name: string): void {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}`);
}

const ANDROID_SIGNING = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];
const APPLE_SIGNING = ["APPLE_CERTIFICATE_BASE64", "APPLE_CERTIFICATE_PASSWORD", "APPLE_TEAM_ID"];
const APPLE_UPLOAD = ["APPLE_API_KEY_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"];
const PLAY_UPLOAD = ["PLAY_SERVICE_ACCOUNT_JSON", "ANDROID_PACKAGE_NAME"];

function secrets(...groups: string[][]): Record<string, boolean> {
  const out: Record<string, boolean> = { NEXT_PUBLIC_API_URL: true };
  for (const g of groups) for (const name of g) out[name] = true;
  return out;
}

const plan = (over: Partial<Parameters<ReleaseLib["planMobileRelease"]>[0]> = {}): Plan =>
  lib.planMobileRelease({
    ref: "refs/tags/v1.4.0",
    eventName: "push",
    runNumber: 42,
    secretsPresent: { NEXT_PUBLIC_API_URL: true },
    ...over,
  });

// ── tag parsing ───────────────────────────────────────────────────────
section("version tags");
{
  assert(lib.parseVersionTag("refs/tags/v1.4.0")?.version === "1.4.0", "a v* tag parses");
  assert(
    lib.parseVersionTag("refs/tags/v1.4.0")?.prerelease === false,
    "a plain release tag is not a prerelease",
  );
  assert(
    lib.parseVersionTag("refs/tags/v2.0.0-rc.1")?.prerelease === true,
    "a hyphen suffix marks a prerelease",
  );
  assert(lib.parseVersionTag("refs/heads/main") === null, "a branch ref is not a version tag");
}

// ── the credential-less checkout ──────────────────────────────────────
section("no credentials — build nothing, upload nothing");
{
  const p = plan();
  assert(p.errors.length === 0, "a checkout with no signing secrets is NOT an error");
  assert(!p.android.build && !p.ios.build, "nothing is built");
  assert(!p.android.artifact && !p.ios.artifact, "and nothing is uploaded as an artifact");
  assert(
    p.android.reasons.length > 0 && p.ios.reasons.length > 0,
    "each leg says why it is not building, so the job summary is readable",
  );
  assert(
    lib.formatPlanSummary(p).length > 0,
    "the plan still renders a summary — a skipped release must be legible, not blank",
  );
}

// ── the partial credential set ────────────────────────────────────────
section("a partial credential set fails");
{
  const threeOfFour = { ...secrets(), ANDROID_KEY_PASSWORD: false };
  delete threeOfFour.ANDROID_KEY_PASSWORD;
  const p = lib.planMobileRelease({
    ref: "refs/tags/v1.4.0",
    eventName: "push",
    runNumber: 7,
    secretsPresent: {
      NEXT_PUBLIC_API_URL: true,
      ANDROID_KEYSTORE_BASE64: true,
      ANDROID_KEYSTORE_PASSWORD: true,
      ANDROID_KEY_ALIAS: true,
      // ANDROID_KEY_PASSWORD deliberately absent
    },
  });
  assert(p.errors.length > 0, "three of four Android signing secrets is an error, not a build");
  assert(
    p.errors.join(" ").includes("ANDROID_KEY_PASSWORD"),
    "the error names the missing secret",
  );

  const halfApple = lib.planMobileRelease({
    ref: "refs/tags/v1.4.0",
    eventName: "push",
    runNumber: 7,
    secretsPresent: {
      NEXT_PUBLIC_API_URL: true,
      APPLE_API_KEY_BASE64: true,
      APPLE_API_KEY_ID: true,
      // APPLE_API_ISSUER_ID absent
    },
  });
  assert(halfApple.errors.length > 0, "a half-configured App Store Connect key is an error");
}

// ── the missing API URL ───────────────────────────────────────────────
section("NEXT_PUBLIC_API_URL");
{
  // `secrets()` always sets NEXT_PUBLIC_API_URL, so the negative case is
  // built by hand: full signing credentials, no API URL.
  const withoutUrl = lib.planMobileRelease({
    ref: "refs/tags/v1.4.0",
    eventName: "push",
    runNumber: 7,
    secretsPresent: Object.fromEntries(
      [...ANDROID_SIGNING, ...APPLE_SIGNING].map((k) => [k, true]),
    ),
  });
  assert(
    withoutUrl.errors.some((e) => e.includes("NEXT_PUBLIC_API_URL")),
    "signing credentials with no API URL is an error — the bundle would build green and die on device",
  );
}

// ── the full, signed release ──────────────────────────────────────────
section("fully credentialed release");
{
  const p = plan({
    secretsPresent: secrets(ANDROID_SIGNING, APPLE_SIGNING, APPLE_UPLOAD, PLAY_UPLOAD),
  });
  assert(p.errors.length === 0, "a complete credential set plans cleanly");
  assert(p.android.build && p.android.sign && p.android.artifact, "Android builds, signs, uploads");
  assert(p.ios.build && p.ios.sign && p.ios.artifact, "iOS builds, signs, uploads");
  assert(p.android.upload && p.ios.upload, "both store uploads are on");
  assert(p.buildNumber === 42, "the build number comes from the run number, never the version");
  assert(p.version === "1.4.0", "the version comes from the tag");
}

// ── artifact is true only when signed ─────────────────────────────────
section("an unsigned artifact is never attached");
{
  // Apple signing present, Apple UPLOAD absent: the artifact is still
  // produced (it is signed), but nothing reaches TestFlight.
  const p = plan({ secretsPresent: secrets(APPLE_SIGNING) });
  assert(p.ios.sign && p.ios.artifact, "a signed build still produces a downloadable artifact");
  assert(!p.ios.upload, "with no App Store Connect key, nothing is uploaded to the store");
  assert(
    !p.android.artifact,
    "the unsigned platform attaches nothing — an unsigned .aab on a public tag reads as a release download",
  );

  const both = plan({
    secretsPresent: secrets(ANDROID_SIGNING, APPLE_SIGNING, APPLE_UPLOAD, PLAY_UPLOAD),
  });
  for (const leg of [both.android, both.ios]) {
    assert(leg.artifact === leg.sign, "artifact tracks sign exactly, on every leg");
  }
}

// ── prereleases ───────────────────────────────────────────────────────
section("a prerelease goes to an internal track only");
{
  const p = lib.planMobileRelease({
    ref: "refs/tags/v2.0.0-rc.1",
    eventName: "workflow_dispatch",
    inputs: { track: "production" },
    runNumber: 99,
    secretsPresent: secrets(ANDROID_SIGNING, APPLE_SIGNING, APPLE_UPLOAD, PLAY_UPLOAD),
  });
  assert(p.prerelease, "the tag is recognised as a prerelease");
  assert(
    p.android.track === "internal",
    "a prerelease is forced to the internal track, overriding the dispatch input",
  );
  assert(
    p.notes.some((n) => n.toLowerCase().includes("internal")),
    "the override is stated in the notes rather than applied silently",
  );

  const stable = lib.planMobileRelease({
    ref: "refs/tags/v2.0.0",
    eventName: "push",
    runNumber: 99,
    secretsPresent: secrets(ANDROID_SIGNING, PLAY_UPLOAD),
  });
  assert(
    stable.android.track === "internal",
    "even a stable tag defaults to internal — promoting is a human decision",
  );
}

// ── a branch push is not a release ────────────────────────────────────
section("a non-tag push builds nothing");
{
  const p = lib.planMobileRelease({
    ref: "refs/heads/main",
    eventName: "push",
    runNumber: 3,
    secretsPresent: secrets(ANDROID_SIGNING, APPLE_SIGNING, APPLE_UPLOAD, PLAY_UPLOAD),
  });
  assert(!p.android.build && !p.ios.build, "a branch push with every credential still builds nothing");
  assert(p.version === null, "and carries no version");
}

// ── platform narrowing via dispatch ───────────────────────────────────
section("workflow_dispatch platform narrowing");
{
  const p = lib.planMobileRelease({
    ref: "refs/tags/v1.4.0",
    eventName: "workflow_dispatch",
    inputs: { platforms: "ios" },
    runNumber: 5,
    secretsPresent: secrets(ANDROID_SIGNING, APPLE_SIGNING, APPLE_UPLOAD, PLAY_UPLOAD),
  });
  assert(p.ios.build && !p.android.build, "a narrowed dispatch builds only the named platform");

  const typo = lib.planMobileRelease({
    ref: "refs/tags/v1.4.0",
    eventName: "workflow_dispatch",
    inputs: { platforms: "phone" },
    runNumber: 5,
    secretsPresent: secrets(ANDROID_SIGNING, APPLE_SIGNING),
  });
  assert(
    typo.errors.length > 0,
    "an unknown platforms input is an error, not a green run that built nothing",
  );
}

// ── the workflow honours the plan ─────────────────────────────────────
section("the workflow is actually gated on the plan");
{
  const wf = join(STARTER, ".github/workflows/mobile-release.yml");
  assert(existsSync(wf), "mobile-release.yml exists");
  const yml = (await import("node:fs")).readFileSync(wf, "utf-8");

  // Every artifact upload must be guarded. An unguarded one is exactly the
  // bug this whole plan job exists to prevent.
  const uploadLines = yml
    .split("\n")
    .map((l, i) => [l, i] as const)
    .filter(([l]) => l.includes("upload-artifact"));
  assert(uploadLines.length > 0, "the workflow does upload artifacts somewhere");
  for (const [, i] of uploadLines) {
    const window = yml.split("\n").slice(Math.max(0, i - 6), i + 2).join("\n");
    assert(
      window.includes("needs.plan.outputs.plan") && window.includes(".artifact"),
      `the upload-artifact step near line ${i + 1} is guarded by the plan's artifact flag`,
    );
  }

  assert(
    yml.includes("jarsigner -verify"),
    "CI verifies the Android artifact is signed — an unsigned AAB must not pass quietly",
  );
  assert(yml.includes("codesign --verify"), "CI verifies the iOS artifact is signed");

  // The two checks below must ignore comments. Both patterns appear in the
  // file's own prose explaining why they are absent, and a naive substring
  // search would happily pass on a workflow that reintroduced them.
  const code = yml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert(
    !/^\s*(-\s*)?(name:.*pod install|run:\s*pod install)/m.test(code) &&
      !/\bpod install\b/.test(code),
    "no CocoaPods step — Capacitor 8 iOS resolves through Swift Package Manager",
  );
  assert(
    !/if:\s*env\.[A-Z_]+\s*!=\s*''/.test(code),
    "no `if: env.X != ''` gates — step-level env is invisible to a step's own `if`, so those gates are dead",
  );
  assert(
    yml.includes("!= ''") && yml.includes("secrets."),
    "secrets reach the plan as booleans (`secrets.X != ''`), never as values",
  );
  assert(
    yml.includes("build-mobile.mjs"),
    "CI builds through the one supported entry point, not a bare cap sync",
  );
}

console.log();
if (failed > 0) {
  console.error(`✗ ${failed} assertion(s) failed\n`);
  process.exit(1);
}
console.log("✓ mobile release plan: all assertions passed\n");
