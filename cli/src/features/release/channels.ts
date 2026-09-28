/*
 * cli/src/features/release/channels.ts — which release channels a project
 * actually has, and what each one does for a version tag.
 *
 * WHY A CATALOG AND NOT SEVEN IF-BLOCKS
 * =====================================
 * A channel is two separable things: a question ("does this project have a
 * browser extension?") and a row of facts about the workflow that ships it.
 * Written as branching code the two get tangled, and every new store means
 * re-reading the whole function to find where its row would go. Written as a
 * catalog of `{ applies, row }` entries, a new surface is one entry appended
 * in release order and nothing else changes — which is the rule the feature's
 * types file states: surface knowledge lives here, mechanism lives in the
 * emitted `.mjs`.
 *
 * WHY THE ROWS DESCRIBE THE STARTER'S WORKFLOWS, NOT AN IDEAL ONE
 * ---------------------------------------------------------------
 * `workflowName`, `jobPrefixes` and `uploadSteps` are matched against the
 * GitHub API by exact text. A row that describes a workflow the project does
 * not have produces "unknown" in the status table forever, which reads as a
 * broken release rather than as a wrong config. So every name here was taken
 * from the workflow file a scaffolded project actually gets
 * (`starter/.github/workflows/`), and the two cases where the starter differs
 * from the obvious guess are commented where they occur.
 *
 * DEGRADING CLEANLY
 * -----------------
 * Every entry's `applies` is a conjunction of manifest evidence and disk
 * evidence, and both have to say yes. A project whose only surface is a web
 * deploy gets exactly one channel back; a `scaffold-only` project gets none.
 * An empty array is a correct answer and every consumer treats it as one.
 */

import { SIGNING_SECRET_NAMES } from "../signing/github.js";
import type { ChannelGate, ChannelStep, ReleaseChannel, ReleaseDerivationInput } from "./types.js";

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

/** One candidate channel: the question that decides whether the project has
 *  it, and the facts about it once the answer is yes.
 *
 *  `row` takes the input too, because a handful of fields are not constant
 *  for a surface — a desktop channel's credentials depend on whether the
 *  signing feature ran, and the web channel's workflow file depends on how
 *  the project deploys. Keeping those inside `row` rather than in `applies`
 *  means the guard stays a pure yes/no. */
interface ChannelEntry {
  /** Becomes {@link ReleaseChannel.id}. Held on the entry rather than
   *  inside `row` so the ordering of the catalog is readable at a glance. */
  id: string;
  applies: (input: ReleaseDerivationInput) => boolean;
  row: (input: ReleaseDerivationInput) => Omit<ReleaseChannel, "id">;
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

const hasFeature = (input: ReleaseDerivationInput, feature: string): boolean =>
  input.features.includes(feature);

/** True only for the three shapes that run server code. `static` has no
 *  server, and an absent `surfaces` (an old manifest) is treated as "not
 *  established" rather than as a default: a container channel invented for a
 *  project that ships no server image would report a missing run on every
 *  tag. */
const hasServerRuntime = (input: ReleaseDerivationInput): boolean =>
  input.surfaces === "fullstack" || input.surfaces === "split" || input.surfaces === "backend";

/** Absent `deploymentMode` means `coolify` — the types file says so, and
 *  every manifest written before the field existed was a Coolify deploy. */
const deploymentMode = (
  input: ReleaseDerivationInput,
): "coolify" | "gh-pages" | "cloudflare" | "scaffold-only" => input.deploymentMode ?? "coolify";

/** Whether Hatchkit provisioned signing for a platform. `enabled: false`
 *  counts as no: the secrets were never pushed, so naming them as this
 *  channel's requirements would make the credentials doc describe a setup
 *  that does not exist. */
const signsFor = (input: ReleaseDerivationInput, platform: string): boolean =>
  input.signing?.enabled === true && input.signing.platforms.includes(platform);

/** The extension lives outside the manifest — there is no `extension`
 *  feature — so its existence is a disk fact. Three layouts are recognised
 *  because the manifest is generated in two of them and hand-written in the
 *  third. */
const hasExtension = (input: ReleaseDerivationInput): boolean =>
  input.exists("packages/extension/manifest.config.ts") ||
  input.exists("packages/extension/manifest.json") ||
  input.exists("extension/manifest.json");

/** A root package.json that npm would accept: not `private`, and named.
 *  Anything else has no package channel, because `npm publish` would refuse
 *  the tag and the row would promise a registry upload that cannot happen. */
const isPublishablePackage = (input: ReleaseDerivationInput): boolean => {
  const raw = input.read("package.json");
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unparseable root package.json is a bigger problem than a missing
    // channel; the version-copies derivation and the policy check both say
    // so more usefully than a thrown error here would.
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const pkg = parsed as { private?: unknown; name?: unknown };
  return !pkg.private && typeof pkg.name === "string" && pkg.name.length > 0;
};

// ---------------------------------------------------------------------------
// Shared credential sets
// ---------------------------------------------------------------------------

/** itch.io is the desktop channel's only publish target in the starter's
 *  `desktop-release.yml`; without these three the butler steps are skipped
 *  and the installers stay attached to the run. */
const ITCH_SECRETS = ["ITCH_API_KEY", "ITCH_USER", "ITCH_GAME"] as const;

/** The Developer ID material both desktop workflows read to sign and
 *  notarize the macOS bundle. It is not in the signing feature's
 *  `SIGNING_SECRET_NAMES`, because that set covers the three signing
 *  PLATFORMS a project opts into and macOS desktop is not one of them —
 *  but the workflows read these names on every desktop build, and a
 *  desktop channel always has a macOS leg.
 *
 *  Leaving them out was tempting and wrong: it would have produced a
 *  credentials document that says a desktop release needs an itch key
 *  and nothing else, while the artifact it ships is a macOS bundle
 *  Gatekeeper refuses to open. */
const MACOS_SIGNING_SECRETS = [
  "APPLE_DEVELOPER_ID_CERT_BASE64",
  "APPLE_DEVELOPER_ID_CERT_PASSWORD",
  "APPLE_DEVELOPER_ID_IDENTITY",
] as const;

/** The mobile workflow builds an Android AAB and an iOS archive on every
 *  tag, whether or not `hatchkit signing` has run. So when signing is
 *  configured its platforms decide the requirement, and when it is not we
 *  still name both sets: the secrets the existing workflow reads are what a
 *  person needs in order to publish, and a credentials doc that listed
 *  nothing would be worse than one that lists more than this project uses. */
const mobileSecrets = (input: ReleaseDerivationInput): string[] => {
  const platforms =
    input.signing?.enabled === true
      ? input.signing.platforms.filter((p) => p === "android" || p === "ios")
      : ["android", "ios"];
  const secrets: string[] = [];
  if (platforms.includes("android")) secrets.push(...SIGNING_SECRET_NAMES.android);
  if (platforms.includes("ios")) secrets.push(...SIGNING_SECRET_NAMES.ios);
  return secrets;
};

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const DRAFT_RELEASE_GATE: ChannelGate = {
  kind: "draft-release",
  note: "Publish the draft GitHub Release. Until it is published nobody can download the installers.",
};

const MOBILE_GATE: ChannelGate = {
  kind: "store-review",
  note: "Promote the Play internal-track build to a public track, and submit the TestFlight build for App Store review.",
};

const CHROME_GATE: ChannelGate = {
  kind: "store-review",
  note: "Chrome Web Store review has to pass. The upload only queues the new version.",
};

const FIREFOX_GATE: ChannelGate = {
  kind: "store-review",
  note: "addons.mozilla.org review has to pass before the signed add-on reaches users.",
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The starter names this step `Upload to Play Store (internal track)`. The
 *  reader matches a step name up to `" ("`, so the track stays free to
 *  change per run without the row going stale. */
const PLAY_UPLOAD_STEP: ChannelStep = {
  step: "Upload to Play Store",
  label: "uploaded to Google Play",
};

const TESTFLIGHT_UPLOAD_STEP: ChannelStep = {
  step: "Upload to TestFlight",
  label: "uploaded to TestFlight",
};

// ---------------------------------------------------------------------------
// The catalog, in the order a release reaches people
// ---------------------------------------------------------------------------

/** Web first: it is live for everyone the moment it deploys. Then the
 *  container images, which a self-hoster pulls by a floating tag without
 *  asking. Then the channels a person has to download or a store has to
 *  approve, which are slower and narrower. The package registry is last —
 *  it reaches other developers, not users. */
const CATALOG: readonly ChannelEntry[] = [
  // -- 1. web ---------------------------------------------------------------
  {
    id: "web",
    // `scaffold-only` means the project was never wired to a host, so there
    // is no deploy for a tag to be reflected in.
    applies: (input) => deploymentMode(input) !== "scaffold-only",
    row: (input) => {
      const mode = deploymentMode(input);
      const pages = mode === "gh-pages";
      // `hatchkit cloudflare` writes `deploy.yml` with `name: Deploy to
      // Cloudflare`; it is the only workflow a cloudflare-mode project
      // deploys through (the scaffold removes build-and-deploy.yml, which
      // has no image to build).
      const cloudflare = mode === "cloudflare";
      // `hatchkit gh-pages` writes `gh-pages.yml` with `name: Deploy to
      // GitHub Pages`. A Pages project that predates that command deploys
      // from the scaffold's own workflow instead.
      const ownPagesWorkflow = pages && input.exists(".github/workflows/gh-pages.yml");
      const where = cloudflare
        ? "Cloudflare Workers"
        : pages
          ? "GitHub Pages"
          : "the production domain";
      const workflowFile = cloudflare
        ? "deploy.yml"
        : ownPagesWorkflow
          ? "gh-pages.yml"
          : "build-and-deploy.yml";
      const workflowName = cloudflare
        ? "Deploy to Cloudflare"
        : ownPagesWorkflow
          ? "Deploy to GitHub Pages"
          : "build-and-deploy";
      return {
        kind: "web",
        label: "Web deploy",
        workflowFile,
        workflowName,
        // Deliberately NOT "tag". Both workflows trigger on a push to the
        // default branch, so the tag has no run of its own. Calling it "tag"
        // would make the status table report every release as a deploy that
        // never started.
        trigger: "branch",
        effect: `Serves the tag's commit on ${where}, from the deploy that ran when that commit landed on the default branch.`,
        gate: null,
        publicDistribution: true,
        uploadSteps: [],
        // The run's own conclusion is the whole story: this workflow's jobs
        // are a pipeline, and a failure anywhere means nothing deployed.
        jobPrefixes: [],
        // The deploy authenticates with the workflow's own token and the
        // secrets it already has; a release adds no credential of its own.
        credentials: [],
        absent: "skip",
        missingRunNote:
          "the deploy runs on a push to the default branch; pushing a tag does not start it",
      };
    },
  },

  // -- 2. container ---------------------------------------------------------
  {
    id: "container",
    applies: (input) =>
      hasServerRuntime(input) && (input.exists("Dockerfile") || input.exists("docker-compose.yml")),
    row: () => ({
      kind: "container",
      label: "Self-host images",
      workflowFile: "release.yml",
      workflowName: "release",
      trigger: "tag",
      effect:
        "Builds multi-arch images, smoke-tests them, and moves the floating latest and X.Y tags to this version.",
      gate: null,
      // The floating tags are the reason this is public: a self-hoster who
      // pinned `latest` gets this build without having asked for it.
      publicDistribution: true,
      uploadSteps: [],
      jobPrefixes: ["build", "smoke", "promote"],
      // GHCR accepts the workflow's own GITHUB_TOKEN, so there is nothing
      // for a person to create.
      credentials: [],
      absent: "skip",
      missingRunNote: null,
    }),
  },

  // -- 3. desktop (Electron) ------------------------------------------------
  {
    id: "desktop-electron",
    applies: (input) => hasFeature(input, "desktop"),
    row: (input) => {
      const signsWindows = signsFor(input, "windows");
      return {
        kind: "desktop",
        label: "Desktop apps",
        workflowFile: "desktop-release.yml",
        workflowName: "Desktop Release",
        trigger: "tag",
        effect:
          "Builds mac, Windows and Linux installers, pushes them to itch.io, and attaches them to a draft GitHub Release.",
        gate: DRAFT_RELEASE_GATE,
        publicDistribution: true,
        uploadSteps: [{ step: "Push to itch.io", label: "pushed to itch.io" }],
        jobPrefixes: ["build"],
        credentials: signsWindows
          ? [...ITCH_SECRETS, ...MACOS_SIGNING_SECRETS, ...SIGNING_SECRET_NAMES.windows]
          : [...ITCH_SECRETS, ...MACOS_SIGNING_SECRETS],
        // A desktop build always produces a macOS bundle, and without a
        // Developer ID certificate that bundle is unsigned — Gatekeeper
        // refuses it. With Windows signing configured, a missing Azure
        // secret adds an installer SmartScreen blocks. Either way the
        // honest word is "unsigned", not "skipped": something was built
        // that nobody can install.
        absent: "unsigned",
        missingRunNote: null,
      };
    },
  },

  // -- 4. mobile ------------------------------------------------------------
  {
    id: "mobile",
    applies: (input) => hasFeature(input, "mobile"),
    row: (input) => ({
      kind: "mobile",
      label: "Mobile apps",
      workflowFile: "mobile-release.yml",
      workflowName: "Mobile Release",
      // The starter's mobile workflow does trigger on `v*` tags, so a missing
      // run means the tag push did not arrive — which is worth reporting.
      trigger: "tag",
      effect:
        "Builds a signed Android AAB and an iOS archive, and uploads them to the Play internal track and to TestFlight.",
      gate: MOBILE_GATE,
      publicDistribution: true,
      uploadSteps: [PLAY_UPLOAD_STEP, TESTFLIGHT_UPLOAD_STEP],
      jobPrefixes: ["android", "ios"],
      credentials: mobileSecrets(input),
      // Never "skip". A phone build with no signing key cannot be installed
      // by anyone, so uploading it would put a broken version in a store
      // queue; the build is produced and the upload is refused.
      absent: "unsigned",
      missingRunNote: null,
    }),
  },

  // -- 6a. extension (Chrome) -----------------------------------------------
  {
    id: "extension-chrome",
    applies: hasExtension,
    row: () => ({
      kind: "extension",
      label: "Chrome extension",
      // Both stores share one workflow file. Two rows over one file is the
      // intended shape: either store can be unconfigured or refuse an upload
      // without that saying anything about the other, and the status reader
      // separates them by job prefix.
      workflowFile: "extension-release.yml",
      workflowName: "Extension Release",
      trigger: "tag",
      effect:
        "Builds the extension, uploads the zip to the Chrome Web Store, and submits it for review.",
      gate: CHROME_GATE,
      publicDistribution: true,
      uploadSteps: [
        { step: "Upload to the Chrome Web Store", label: "uploaded to the Chrome Web Store" },
      ],
      jobPrefixes: ["chrome-web-store"],
      credentials: [
        "CHROME_EXTENSION_ID",
        "CHROME_CLIENT_ID",
        "CHROME_CLIENT_SECRET",
        "CHROME_REFRESH_TOKEN",
      ],
      // The zip is the same bundle anyone can build from the tagged source,
      // so stopping after the artifact upload is safe.
      absent: "skip",
      missingRunNote: null,
    }),
  },

  // -- 6b. extension (Firefox) ----------------------------------------------
  {
    id: "extension-firefox",
    applies: hasExtension,
    row: () => ({
      kind: "extension",
      label: "Firefox add-on",
      workflowFile: "extension-release.yml",
      workflowName: "Extension Release",
      trigger: "tag",
      effect:
        "Builds the extension and submits it to addons.mozilla.org, which signs it and reviews it.",
      gate: FIREFOX_GATE,
      publicDistribution: true,
      uploadSteps: [
        { step: "Sign and submit to addons.mozilla.org", label: "submitted to addons.mozilla.org" },
      ],
      jobPrefixes: ["firefox-add-ons"],
      credentials: ["AMO_JWT_ISSUER", "AMO_JWT_SECRET"],
      absent: "skip",
      missingRunNote: null,
    }),
  },

  // -- 6. package registry --------------------------------------------------
  {
    id: "package",
    applies: isPublishablePackage,
    row: () => ({
      kind: "package",
      label: "Package registry",
      workflowFile: "package-release.yml",
      workflowName: "Package Release",
      trigger: "tag",
      effect: "Publishes the tagged version to the npm registry.",
      gate: null,
      // npm serves the new version to `npm install <name>` immediately.
      publicDistribution: true,
      uploadSteps: [{ step: "Publish to npm", label: "published to npm" }],
      jobPrefixes: [],
      credentials: ["NPM_TOKEN"],
      absent: "skip",
      missingRunNote: null,
    }),
  },
];

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The channels this project actually has, in the order a release reaches
 * people.
 *
 * Pure: every filesystem question goes through the `exists` / `read`
 * callbacks on the input, so the whole derivation is testable against a
 * project that was never written to disk.
 */
export function deriveChannels(input: ReleaseDerivationInput): ReleaseChannel[] {
  const channels: ReleaseChannel[] = [];
  for (const entry of CATALOG) {
    if (!entry.applies(input)) continue;
    channels.push({ id: entry.id, ...entry.row(input) });
  }
  return channels;
}
