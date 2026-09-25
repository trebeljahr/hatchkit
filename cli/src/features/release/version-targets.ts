/*
 * cli/src/features/release/version-targets.ts — every place the release
 * version is written down a second time, and every place it is deliberately
 * read instead of copied.
 *
 * WHY THIS EXISTS
 * ===============
 * The root `package.json` holds the one version. Native projects cannot read
 * it: an Xcode build setting, a Gradle `versionName`, a Cargo manifest and a
 * compose file's image tag all want a literal. So a release bump has to touch
 * several files, and a bump that misses one ships a build that reports the
 * wrong version with nothing failing anywhere. The generated version-sync
 * test asserts each copy against the root, which turns that silent drift into
 * a red test before anything is uploaded.
 *
 * WHY A COPY IS ONLY EMITTED WHEN ITS PATTERN ALREADY MATCHES
 * -----------------------------------------------------------
 * A copy target that matches nothing is not a harmless extra assertion — it
 * is a test that fails on a project which never had that copy in the first
 * place, on the first run, for a file the author has never opened. So each
 * candidate below is read before it is emitted, and one that does not match
 * is dropped. Two real cases this catches: an `electron/package.json` that
 * carries only `{"type":"commonjs"}`, and an Android `versionCode` computed
 * from `System.getenv(...)` rather than written as a literal. Both are
 * correct as they stand and neither should be asserted.
 *
 * WHY `expectCount` IS USUALLY A NUMBER
 * -------------------------------------
 * The matches are counted here, at derivation time, against the file as it
 * stands. A compose file with two image defaults and only one substituted is
 * a half-bumped release, and "at least one" cannot see that. The one
 * exception is the Xcode project file, where the setting repeats once per
 * build configuration and adding a configuration is a normal thing to do.
 *
 * WHY THE READS ARE PINNED TOO
 * ----------------------------
 * A build-time read of the root version is the good case, and it is the case
 * a refactor quietly undoes — someone inlines the value to drop an import and
 * the drift is back, with no copy for the test to catch. {@link VersionRead}
 * asserts the read is still a read.
 *
 * Pure: every file access goes through the `exists` / `list` / `read`
 * callbacks on the input.
 */

import type { ReleaseDerivationInput, VersionCopy, VersionForm, VersionRead } from "./types.js";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------
//
// Each is a RegExp *source string* with exactly one capture group, because it
// crosses a JSON boundary into `.hatchkit-release.json` and is compiled by the
// emitted reader with the `flags` beside it. `String.raw` keeps the
// backslashes readable: what is written here is what the reader compiles.

/** A JSON `"version": "…"` member. Used for every package.json-shaped file
 *  and for `tauri.conf.json`. Tolerant of spacing, so a reformat does not
 *  break the assertion. */
const JSON_VERSION = String.raw`"version"\s*:\s*"([^"]+)"`;

/** Gradle writes `versionName "1.2.3"` in Groovy and `versionName = "1.2.3"`
 *  in the Kotlin DSL; both spellings are live in the wild. */
const GRADLE_VERSION_NAME = String.raw`^\s*versionName\s*=?\s*["']([^"']+)["']`;

/** Only a literal integer. A `versionCode` derived from an environment
 *  variable — the usual way to keep Play's monotonic counter out of the
 *  repo — deliberately does not match, and so is not asserted. */
const GRADLE_VERSION_CODE = String.raw`^\s*versionCode\s*=?\s*(\d+)\s*$`;

/** Xcode build settings are `NAME = value;` inside a build configuration. */
const PBX_MARKETING_VERSION = String.raw`MARKETING_VERSION = ([^;]+);`;
const PBX_CURRENT_PROJECT_VERSION = String.raw`CURRENT_PROJECT_VERSION = ([^;]+);`;

/** The `version` of Cargo's `[package]` table, and nothing else. `[^\[]*?`
 *  cannot cross into the next table, so the `version = "2"` of a dependency
 *  under `[dependencies]` is out of reach. Dependencies written inline
 *  (`tauri = { version = "2" }`) are out of reach for the same reason once
 *  the lazy run has already found the package version above them. */
const CARGO_PACKAGE_VERSION = String.raw`\[package\][^\[]*?\bversion\s*=\s*"([^"]+)"`;

// ---------------------------------------------------------------------------
// Copy candidates
// ---------------------------------------------------------------------------

interface CopyCandidate {
  /** Repo-relative, posix slashes. */
  path: string;
  pattern: string;
  flags: string;
  form: VersionForm;
  label: string;
  /** `false` keeps `expectCount` at `null` ("at least one") even though the
   *  file was read and could have been counted — for files where the number
   *  of matches is legitimately free to change. */
  countMatches: boolean;
}

/** The fixed candidates, in the order a reader of the failure message would
 *  want them: native projects first (they drift most), then the desktop
 *  wrappers, then the self-host defaults. Workspace packages are enumerated
 *  separately because their paths are not known ahead of time. */
const FIXED_CANDIDATES: readonly CopyCandidate[] = [
  {
    path: "android/app/build.gradle",
    pattern: GRADLE_VERSION_NAME,
    flags: "gm",
    form: "semver",
    label: "android versionName",
    countMatches: true,
  },
  {
    path: "android/app/build.gradle",
    pattern: GRADLE_VERSION_CODE,
    flags: "gm",
    form: "build-number",
    label: "android versionCode",
    countMatches: true,
  },
  {
    path: "ios/App/App.xcodeproj/project.pbxproj",
    pattern: PBX_MARKETING_VERSION,
    flags: "g",
    form: "semver",
    label: "ios MARKETING_VERSION",
    // Once per build configuration. Adding a configuration is normal and
    // must not turn into a failing version-sync test.
    countMatches: false,
  },
  {
    path: "ios/App/App.xcodeproj/project.pbxproj",
    pattern: PBX_CURRENT_PROJECT_VERSION,
    flags: "g",
    form: "build-number",
    label: "ios CURRENT_PROJECT_VERSION",
    countMatches: false,
  },
  {
    path: "src-tauri/tauri.conf.json",
    pattern: JSON_VERSION,
    flags: "g",
    form: "semver",
    label: "src-tauri/tauri.conf.json version",
    countMatches: true,
  },
  {
    path: "src-tauri/Cargo.toml",
    pattern: CARGO_PACKAGE_VERSION,
    flags: "g",
    form: "semver",
    label: "src-tauri/Cargo.toml [package] version",
    countMatches: true,
  },
  {
    // A hand-written MV3 manifest keeps a literal. The generated one
    // (`manifest.config.ts`) does not, and shows up under the reads instead.
    path: "packages/extension/manifest.json",
    pattern: JSON_VERSION,
    flags: "g",
    form: "semver",
    label: "packages/extension/manifest.json version",
    countMatches: true,
  },
  {
    // Usually `{"type":"commonjs"}` and nothing else, in which case this is
    // dropped. Electron projects that do carry a version here get it checked.
    path: "electron/package.json",
    pattern: JSON_VERSION,
    flags: "g",
    form: "semver",
    label: "electron/package.json version",
    countMatches: true,
  },
  {
    // electron-builder reads the root package.json, so a version in its own
    // config is a copy someone added on purpose — and forgets on purpose too.
    path: "electron-builder.json",
    pattern: JSON_VERSION,
    flags: "g",
    form: "semver",
    label: "electron-builder.json version",
    countMatches: true,
  },
  {
    path: "build/electron-builder.json",
    pattern: JSON_VERSION,
    flags: "g",
    form: "semver",
    label: "build/electron-builder.json version",
    countMatches: true,
  },
];

// ---------------------------------------------------------------------------
// Self-host image tag defaults
// ---------------------------------------------------------------------------

/** The env var a self-hoster's compose file reads the image tag from.
 *
 *  Read from the frozen identifier set, never derived here. It ends up in
 *  every self-hoster's `.env`, so a second derivation rule that disagreed
 *  with the project's own would rename the variable out from under a
 *  deployment on its next pull — the exact failure
 *  `cli/src/scaffold/identifiers.ts` exists to prevent.
 *
 *  Still guarded to `[A-Z0-9_]` before it goes into a regex source: the
 *  value is a contract, and this function's job is to fail closed rather
 *  than emit a pattern that silently matches nothing. */
function selfHostVersionVar(envPrefix: string): string | null {
  return /^[A-Z][A-Z0-9_]*$/.test(envPrefix) ? `${envPrefix}_VERSION` : null;
}

/** The two self-host defaults, which are `v`-prefixed because they are image
 *  tags rather than semvers: `.env.selfhost.example` is what a self-hoster
 *  copies, and the compose file's `${VAR:-vX.Y.Z}` is what they get when they
 *  do not. Both have to name the tag the release actually pushed. */
function selfHostCandidates(envPrefix: string): CopyCandidate[] {
  const variable = selfHostVersionVar(envPrefix);
  if (variable === null) return [];
  return [
    {
      path: ".env.selfhost.example",
      pattern: `^${variable}=(\\S+)$`,
      flags: "gm",
      form: "v-prefixed",
      label: `${variable} in .env.selfhost.example`,
      countMatches: true,
    },
    {
      path: "docker-compose.selfhost.yml",
      pattern: `\\$\\{${variable}:-([^}\\s]+)\\}`,
      flags: "g",
      form: "v-prefixed",
      label: `${variable} defaults in docker-compose.selfhost.yml`,
      // One default per image. A service added without a bumped default is
      // exactly the half-bumped release this count exists to catch.
      countMatches: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Read candidates
// ---------------------------------------------------------------------------

interface ReadCandidate {
  /** Checked in order; the first path that exists and matches wins. A
   *  project is a workspace or a single package, never both. */
  paths: readonly string[];
  mustMatch: readonly string[];
  label: string;
}

/** The pattern pins the shape of the read, not its spelling: the value of a
 *  `NEXT_PUBLIC_*_VERSION` has to start with an identifier, so a call or a
 *  variable passes and an inlined `"1.2.3"` does not. The second pattern
 *  keeps it honest about where the value came from. */
const READ_CANDIDATES: readonly ReadCandidate[] = [
  {
    paths: ["packages/client/next.config.ts", "next.config.ts"],
    mustMatch: [
      String.raw`NEXT_PUBLIC_[A-Z0-9_]*VERSION\s*:\s*[A-Za-z_$]`,
      String.raw`package\.json`,
    ],
    label: "the web export's version, read from the root package.json",
  },
  {
    paths: ["packages/extension/manifest.config.ts"],
    mustMatch: [
      // `(?:\.\./)+` rather than a fixed depth, so moving the package one
      // level does not turn a correct read into a failure.
      String.raw`from\s+["'](?:\.\./)+package\.json["']`,
      String.raw`\.version\b`,
    ],
    label: "the browser extension manifest, built from the root package.json",
  },
  {
    paths: ["packages/extension/vite.config.ts"],
    mustMatch: [String.raw`import\.meta\.env\.[A-Za-z0-9_]*VERSION`, String.raw`manifest\.config`],
    label: "the extension bundle's version, defined from the manifest config",
  },
];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** How many times `pattern` matches `body`. A pattern without `g` can match
 *  at most once, which is what the reader would see too. */
function countMatches(body: string, pattern: string, flags: string): number {
  const compiled = new RegExp(pattern, flags);
  if (!flags.includes("g")) return compiled.test(body) ? 1 : 0;
  let count = 0;
  for (const _ of body.matchAll(compiled)) count += 1;
  return count;
}

/** A candidate becomes a {@link VersionCopy} only when its file is readable
 *  AND its pattern already matches something. See the file header for why a
 *  non-matching candidate is dropped rather than emitted. */
function toCopy(input: ReleaseDerivationInput, candidate: CopyCandidate): VersionCopy | null {
  if (!input.exists(candidate.path)) return null;
  const body = input.read(candidate.path);
  if (body === null) return null;
  const count = countMatches(body, candidate.pattern, candidate.flags);
  if (count === 0) return null;
  return {
    path: candidate.path,
    pattern: candidate.pattern,
    flags: candidate.flags,
    form: candidate.form,
    label: candidate.label,
    expectCount: candidate.countMatches ? count : null,
  };
}

/** Every workspace package that declares a version. A package.json without a
 *  `version` field is legal and common — a private workspace package, or one
 *  whose manifest is generated — and it is skipped rather than asserted. */
function workspaceCandidates(input: ReleaseDerivationInput): CopyCandidate[] {
  // Sorted because `list` is a directory listing and its order is the
  // filesystem's. An unsorted list would reshuffle `.hatchkit-release.json`
  // between machines and put noise in the diff of every regeneration.
  const entries = input.list("packages").filter((entry) => !entry.startsWith("."));
  entries.sort();
  return entries.map((entry) => ({
    path: `packages/${entry}/package.json`,
    pattern: JSON_VERSION,
    flags: "g",
    form: "semver" as const,
    label: `packages/${entry}/package.json version`,
    countMatches: true,
  }));
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Every place other than the root package.json where this project writes the
 * version down literally.
 *
 * The root file is not in the list on purpose: it is the thing every entry
 * here is compared against, and comparing it with itself would always pass.
 */
export function deriveVersionCopies(input: ReleaseDerivationInput): VersionCopy[] {
  const candidates: CopyCandidate[] = [
    ...workspaceCandidates(input),
    ...FIXED_CANDIDATES,
    ...selfHostCandidates(input.identifiers.envPrefix),
  ];
  const copies: VersionCopy[] = [];
  for (const candidate of candidates) {
    const copy = toCopy(input, candidate);
    if (copy !== null) copies.push(copy);
  }
  return copies;
}

/**
 * The files asserted to READ the root version at build time rather than keep
 * a copy of it.
 *
 * A candidate is emitted only when the read is already there. Adding one for
 * a file that does not do the read yet would fail a project for not having
 * written code nobody asked it to write; the assertion's job is to stop a
 * read that exists from being removed.
 */
export function deriveVersionReads(input: ReleaseDerivationInput): VersionRead[] {
  const reads: VersionRead[] = [];
  for (const candidate of READ_CANDIDATES) {
    for (const path of candidate.paths) {
      if (!input.exists(path)) continue;
      const body = input.read(path);
      if (body === null) continue;
      if (!candidate.mustMatch.every((pattern) => new RegExp(pattern).test(body))) continue;
      reads.push({ path, mustMatch: [...candidate.mustMatch], label: candidate.label });
      break;
    }
  }
  return reads;
}
