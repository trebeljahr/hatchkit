/*
 * cli/src/features/release/types.ts — the contract for the `release`
 * feature.
 *
 * WHY THIS FILE IS THE CENTRE OF THE FEATURE
 * ==========================================
 * A project scaffolded by Hatchkit can ship, from one version tag: a web
 * deploy, container images for self-hosters, a desktop app across several
 * channels, two phone stores, two extension stores, and a package
 * registry. Nothing coordinates that. Five workflows run, each reports
 * only on itself, and the release decision gets made by watching tabs.
 *
 * The `release` feature coordinates them, and it does so through ONE
 * generated data file — {@link ReleaseConfig}, written to
 * {@link RELEASE_CONFIG_FILENAME} at the project root. Hatchkit derives
 * that file from the project manifest (which surfaces are enabled) and
 * from what is actually on disk. Everything downstream — the cut script,
 * the status table, the policy check, the version-sync test, the summary
 * workflow, the credentials doc — reads it.
 *
 * THE SPLIT, AND WHY IT IS WHERE IT IS
 * ------------------------------------
 *   TypeScript, here in `cli/src/features/release/`
 *       DERIVATION ONLY. Reads the manifest + disk, produces a
 *       ReleaseConfig. Pure functions, unit-tested in `cli/test-release-*`.
 *       No project ever runs this code.
 *
 *   Plain `.mjs`, in `cli/src/templates/release/`
 *       EXECUTION ONLY. Copied verbatim into the project's `scripts/`.
 *       Generic interpreters of a ReleaseConfig: they contain no
 *       knowledge of any particular surface. CI runs them, with no
 *       Hatchkit installed and no network beyond `gh api`.
 *
 * The rule that keeps the two from drifting: **surface knowledge lives
 * only in the TypeScript; mechanism lives only in the `.mjs`.** A new
 * store is a new row in a catalog here, never a new branch there. The
 * Hatchkit tests import the `.mjs` libraries directly (dynamic import of
 * the template files) so the shipped mechanism is what gets tested, not a
 * second copy of it.
 *
 * DEGRADING CLEANLY
 * -----------------
 * Every list in a ReleaseConfig is derived from the manifest's enabled
 * features. A project with only a web deploy gets one channel, one
 * version copy (the root package.json), no credential groups, and a
 * policy with the two rules that apply to everything. Each extra surface
 * adds its own rows and nothing else. No consumer may assume a channel,
 * a credential, or a version copy exists — {@link ReleaseConfig} is
 * always read defensively, and an empty list is a valid answer.
 */

import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";

/** Written to the project root. Committed: it carries no secrets, only
 *  secret *names*, workflow file names and file paths — all of which are
 *  already visible in the repo's `.github/workflows/`. */
export const RELEASE_CONFIG_FILENAME = ".hatchkit-release.json";

/** Bumped when a shape here changes in a way the emitted `.mjs` readers
 *  cannot tolerate. They refuse a config newer than they understand
 *  rather than guessing, so a stale `scripts/` never half-reads a new
 *  config. */
export const RELEASE_CONFIG_VERSION = 1;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Coarse family of a release channel. Drives grouping in the docs and
 *  the default policy rules (a `store` channel is public and gated; a
 *  `web` channel is neither). */
export type ChannelKind = "web" | "container" | "desktop" | "mobile" | "extension" | "package";

/** What still stands between a green workflow and a person having the
 *  new version. `null` means the workflow finishing IS the release. */
export type ChannelGate =
  | { kind: "draft-release"; note: string }
  | { kind: "store-review"; note: string }
  | { kind: "manual-dispatch"; note: string }
  | { kind: "staged-rollout"; note: string };

/** What a channel does when its credentials are missing. The one option
 *  that must never exist is "publish anyway, quietly".
 *
 *   · `skip`     — the upload step does not run; the build is still
 *                  produced and attached to the workflow run.
 *   · `unsigned` — the artifact is built without a signature and is NOT
 *                  uploaded anywhere a user could install it from.
 *   · `fail`     — the channel cannot degrade; the workflow fails. */
export type AbsentBehaviour = "skip" | "unsigned" | "fail";

/** A step inside a channel's workflow whose conclusion answers a
 *  question the release decision depends on ("did it reach the store?").
 *  Matched by name, or by name up to `" ("` so a step that names its
 *  track in parentheses still matches. A renamed step turns its fact
 *  into "unknown" in the status table — never into a wrong answer. */
export interface ChannelStep {
  /** Step name as written in the workflow's `name:`. */
  step: string;
  /** How the status table words a success, e.g. "uploaded to Google Play". */
  label: string;
}

/** One release channel: a workflow that a version tag starts, and what
 *  it produces. Derived, never hand-written. */
export interface ReleaseChannel {
  /** Stable id, referenced by policy rules and credential groups. */
  id: string;
  kind: ChannelKind;
  /** Column text in the status table, e.g. "Desktop apps". */
  label: string;
  /** Workflow file basename, e.g. "desktop-release.yml". This is the
   *  `gh api .../workflows/<file>/runs` key. */
  workflowFile: string;
  /** The workflow's `name:` field. Must match exactly — the generated
   *  `release-summary.yml` lists these under `workflow_run.workflows`,
   *  and GitHub matches on the name, not the file. */
  workflowName: string;
  /** How a run for a tag comes about. The distinction is not cosmetic:
   *  it decides which channels a prerelease tag can reach, and which
   *  are expected to have no run for a tag at all.
   *
   *   · `tag`          — pushing the tag starts the workflow.
   *   · `tag-dispatch` — a person dispatches the workflow, from the tag.
   *                      A prerelease tag CAN reach it, so the
   *                      prerelease rule covers it.
   *   · `branch`       — the workflow is not started from a tag. A
   *                      branch-deployed site is the case: the tag's
   *                      commit reaches production when it lands on the
   *                      default branch, and the tag itself does
   *                      nothing. A prerelease tag cannot reach it, so
   *                      the prerelease rule must not name it — a
   *                      refusal that lists a channel the tag could
   *                      never have touched teaches people to skim
   *                      refusals. */
  trigger: "tag" | "tag-dispatch" | "branch";
  /** One line, present tense: what this channel will do on that tag.
   *  Printed by the cut command before the tag is created. */
  effect: string;
  /** What is still owed by a person after the workflow is green. */
  gate: ChannelGate | null;
  /** True when the artifact reaches people who did not ask for a
   *  prerelease — a store, a public download page, a `latest` tag.
   *  The prerelease policy rule is built from exactly this set. */
  publicDistribution: boolean;
  /** Steps whose conclusion the status table reports on. */
  uploadSteps: ChannelStep[];
  /** Job-name prefixes to summarise as "n/m succeeded". Empty means the
   *  run's own conclusion is the whole story. */
  jobPrefixes: string[];
  /** Repo secret names this channel needs in order to publish. */
  credentials: string[];
  /** What happens when those are absent. */
  absent: AbsentBehaviour;
  /** Why a run might legitimately be missing, e.g. "manual dispatch
   *  only". `null` when a run is always expected. */
  missingRunNote: string | null;
}

// ---------------------------------------------------------------------------
// Version copies
// ---------------------------------------------------------------------------

/** How a copy of the version is spelled where it lives. */
export type VersionForm =
  /** `1.2.3` exactly. */
  | "semver"
  /** `v1.2.3` — image tags, self-host env defaults. */
  | "v-prefixed"
  /** A monotonically increasing integer that is NOT the semver: an
   *  Android `versionCode`, an iOS `CURRENT_PROJECT_VERSION`. Checked
   *  for shape and for being strictly greater than the previous
   *  release's, never for equality with the version. */
  | "build-number";

/** One place, other than the root package file, where the version is
 *  written down. Each becomes an assertion in the generated version-sync
 *  test; a mismatch fails that test, which runs before anything is
 *  uploaded. */
export interface VersionCopy {
  /** Repo-relative, posix slashes. */
  path: string;
  /** RegExp source with exactly one capture group, applied with the
   *  `g` (and `m` where the pattern is anchored) flags by the reader.
   *  Stored as a source string because this crosses a JSON boundary. */
  pattern: string;
  /** Regex flags the reader compiles `pattern` with. */
  flags: string;
  form: VersionForm;
  /** Names the copy in a failure message, e.g. "android versionName". */
  label: string;
  /** How many matches the file must have. `null` means "at least one".
   *  A number that does not match is itself a failure: a compose file
   *  with two image defaults and only one substituted is a half-bumped
   *  release. */
  expectCount: number | null;
}

/** A file that is asserted to READ the root version rather than keep a
 *  copy of it. These are the good cases — the test pins them so a later
 *  refactor cannot quietly turn a build-time read back into a literal. */
export interface VersionRead {
  /** Repo-relative, posix slashes. */
  path: string;
  /** RegExp sources that must all match the file's contents. */
  mustMatch: string[];
  /** Names the surface, e.g. "the browser extension manifest". */
  label: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** One repo secret a channel needs. `where` is the page a person goes to
 *  to produce it — the single most useful thing the generated doc can
 *  say, and the reason the doc is generated rather than written. */
export interface CredentialSecret {
  name: string;
  /** What the value is, in one line. Never an example value. */
  what: string;
  /** Where it comes from: a console page, a URL, or a Hatchkit command. */
  where: string;
}

/** Everything a channel needs, and what it does without it. One group
 *  per channel that needs credentials; channels that need none (a web
 *  deploy using the workflow's own token) produce no group. */
export interface CredentialGroup {
  /** {@link ReleaseChannel.id} this group belongs to. */
  channelId: string;
  label: string;
  secrets: CredentialSecret[];
  absent: AbsentBehaviour;
  /** Spelled-out consequence of absence, for the generated doc. */
  absentNote: string;
  /** One-time steps a person must do by hand, because the vendor
   *  enforces a UI step. Empty when there are none. */
  manualSteps: string[];
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** A refusal the policy check can issue. Declarative on purpose: the
 *  emitted checker is a generic evaluator with one branch per `kind`, so
 *  adding a surface adds data here and no code there.
 *
 * Each rule carries its own `message`, written at derivation time where
 * the project's actual channel names are known. */
export type PolicyRule =
  /** The root package version must equal the tag, minus the `v`. */
  | { id: string; kind: "version-matches-tag"; message: string }
  /** Every {@link VersionCopy} must agree with the root version. The
   *  version-sync test asserts the same thing; this rule means a tag
   *  cannot be cut without it having been run. */
  | { id: string; kind: "version-copies-match"; message: string }
  /** A prerelease tag (`v1.2.3-beta.1`) must not reach a channel that
   *  distributes publicly. */
  | {
      id: string;
      kind: "no-prerelease-to-public";
      channels: string[];
      message: string;
    }
  /** Either all of a credential set is present or none of it is. A half
   *  set is the shape that builds something and uploads nothing, or
   *  uploads something unsigned, depending on which half is missing. */
  | {
      id: string;
      kind: "credential-set-complete";
      channelId: string;
      secrets: string[];
      message: string;
    }
  /** A channel with `publicDistribution` must not publish while its
   *  signing credentials are absent. The credentials named here are the
   *  signing subset, not the whole set: store API keys can be absent
   *  (that only skips the upload); a signing key cannot. */
  | {
      id: string;
      kind: "no-unsigned-publish";
      channelId: string;
      signingSecrets: string[];
      message: string;
    }
  /** The tag must be newer than the newest existing release tag. */
  | { id: string; kind: "tag-is-new"; message: string }
  /** A file must contain a heading for this version — the written
   *  record that says what changed.
   *
   *  `headingPattern` is a RegExp source in which the literal
   *  `__VERSION__` stands for the version being released; the evaluator
   *  substitutes the escaped version before compiling. The placeholder
   *  is spelled that way rather than `{version}` because braces are
   *  quantifier syntax inside a regex, and a pattern that is a valid
   *  regex either way is one nobody notices is wrong. */
  | {
      id: string;
      kind: "release-record";
      path: string;
      headingPattern: string;
      message: string;
    };

/** A rule's `message` says what the rule is, in words that make sense
 *  before it fires. The evaluator pairs it with a `detail` naming the
 *  specific files, versions or secrets involved in THIS failure. Both
 *  are printed, so a message never has to guess at particulars it
 *  cannot know at derivation time. */

/** Whether a rule blocks the release or is reported and passed. Every
 *  rule in scope here is an `error`; `warn` exists so a project can keep
 *  a rule visible while a surface is being set up. */
export type PolicySeverity = "error" | "warn";

export interface ReleasePolicy {
  rules: PolicyRule[];
  /** Rule ids demoted to warnings for this project. */
  warnOnly: string[];
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/** The compat workflow's parameters. Present only when the project has
 *  both a server the user can self-host and a client that ships
 *  separately — otherwise old clients and new servers never meet and the
 *  workflow would test nothing. */
export interface CompatConfig {
  /** Command that starts a server from an image, relative to the repo
   *  root. Receives `COMPAT_SERVER_IMAGE` and prints `COMPAT_API_URL=`. */
  serverScript: string;
  /** Compose file the server stack is started from. */
  composeFile: string;
  /** Container image repository the released server is pulled from. */
  serverImageRepo: string;
  /** Dockerfile the current checkout's server image is built from. */
  serverDockerfile: string;
  /** Source path of the compat suite's entry point. Its presence at a
   *  tag decides whether the old-client direction can run at all. */
  suiteEntry: string;
  /** Build command for the suite. */
  suiteBuild: string;
  /** Run command for the built suite. */
  suiteRun: string;
}

// ---------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------

export interface ReleaseConfig {
  configVersion: typeof RELEASE_CONFIG_VERSION;
  /** Hatchkit version that generated this file.
   *
   *  There is deliberately NO timestamp beside it. The config is
   *  written with `writeIfChanged`, which compares bytes, so a field
   *  that differs on every run would make the feature rewrite the file
   *  on every `hatchkit update` — a broken idempotency invariant and a
   *  dirty git status for no change. A version does change when the
   *  emitted scripts change, which is exactly when a rewrite is worth
   *  having. */
  generatedBy: string;
  project: {
    name: string;
    /** Repo-relative path to the file holding the one version. */
    versionFile: string;
    /** Tag prefix; `v` everywhere Hatchkit generates. */
    tagPrefix: string;
    /** Package manager the emitted scripts invoke. */
    packageManager: "pnpm" | "npm" | "yarn";
    /** Script the cut command runs before committing. `null` skips it. */
    testCommand: string | null;
  };
  channels: ReleaseChannel[];
  versionCopies: VersionCopy[];
  versionReads: VersionRead[];
  credentials: CredentialGroup[];
  policy: ReleasePolicy;
  compat: CompatConfig | null;
}

// ---------------------------------------------------------------------------
// Derivation input
// ---------------------------------------------------------------------------

/** Everything the derivation functions are allowed to look at. Passing
 *  this explicitly (rather than a manifest plus ambient `fs`) is what
 *  makes every derivation function a pure function of its input, and so
 *  testable without a project on disk. */
export interface ReleaseDerivationInput {
  /** Project name, from the manifest. Display only — anything a file or
   *  a registry will hold comes from {@link identifiers}. */
  name: string;
  /** The project's frozen identifier set.
   *
   *  A release surface is exactly the place where deriving a name goes
   *  wrong most expensively: `<PREFIX>_VERSION` is in every
   *  self-hoster's `.env`, and the container image name is in every
   *  `docker pull` anyone has written down. Both are contracts from the
   *  first release, so both are read from here rather than computed
   *  from the project name — see `cli/src/scaffold/identifiers.ts`. */
  identifiers: ProjectIdentifiers;
  /** Enabled features, from the manifest. The derivation may not look
   *  anywhere else to decide whether a surface exists. */
  features: readonly string[];
  /** Project shape, from the manifest. Absent on old manifests. */
  surfaces?: "fullstack" | "split" | "backend" | "static";
  /** How the project deploys. Absent means `coolify`. */
  deploymentMode?: "coolify" | "gh-pages" | "cloudflare" | "scaffold-only";
  /** Per-project signing config, when the `signing` feature ran. Its
   *  `platforms` decide which store credentials are real requirements
   *  and which are absent-by-design. */
  signing?: {
    enabled: boolean;
    platforms: readonly string[];
  };
  /** Predicate over repo-relative paths. Lets derivation notice a
   *  surface the manifest does not model — a browser extension package,
   *  a workspace directory — without reaching for `fs` itself. */
  exists: (relativePath: string) => boolean;
  /** Directory listing for a repo-relative path; `[]` when absent.
   *  Used to enumerate workspace packages. */
  list: (relativePath: string) => string[];
  /** Reads a repo-relative file, or `null`. Used to confirm that a file
   *  really carries the pattern a version copy claims. */
  read: (relativePath: string) => string | null;
}

// ---------------------------------------------------------------------------
// Feature run result
// ---------------------------------------------------------------------------

/** What one apply did, for the caller to print and the tests to assert
 *  on. Built from the feature ledger, so a dry run reports through the
 *  same shape as a real run. */
export interface ReleaseSetupAudit {
  /** False when the ledger recorded a conflict — something hatchkit
   *  wanted to set that the user's file already sets differently. */
  ok: boolean;
  /** Project-relative paths written, or that a dry run would write. */
  written: string[];
  /** Paths already byte-identical — the idempotent re-run. */
  unchanged: string[];
  /** What was reported and deliberately NOT overwritten. */
  conflicts: string[];
  /** Channels the config ended up with, by label. */
  channels: string[];
  /** Things only a person can do, surfaced at the end of the run. */
  manualResidue: string[];
}
