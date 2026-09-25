/*
 * Pure planning logic for the mobile release workflow.
 *
 * Everything the release has to decide — which platform builds, which one
 * signs, which one uploads, to which track, under which build number — is
 * decided HERE, once, before a single byte is compiled. The workflow only
 * executes the plan.
 *
 * Why a separate module instead of `if:` expressions in the YAML:
 *
 *   1. GitHub Actions cannot express "all four of these secrets, or none of
 *      them, but never three". Partially configured signing is the failure
 *      that produces a broken or silently unsigned store upload, and it is
 *      exactly the case an `if: secrets.X != ''` chain gets wrong.
 *   2. `if: env.X != ''` where `env` is declared on the same step does not
 *      work at all — the `if` is evaluated before the step env exists, so the
 *      gate is dead. Several such gates shipped in the previous version of the
 *      workflow. Moving the decision into code removes the whole class.
 *   3. It is testable. Drive it with fixture objects, assert the plan.
 *
 * This module imports nothing and touches no I/O on purpose: it must be safe
 * to import from a test runner, and it must never be able to read a secret.
 * It is handed BOOLEANS ("is this secret set?"), never secret values.
 */

/** Secret names grouped by the capability they unlock. All-or-nothing sets. */
export const SECRET_GROUPS = Object.freeze({
  // Signs the Android App Bundle. A keystore without its password produces a
  // Gradle failure at best and an unsigned bundle at worst.
  androidSigning: Object.freeze([
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
  ]),
  // Publishes to Google Play. The package name is not optional: uploading a
  // bundle to the wrong package is not undoable.
  playUpload: Object.freeze(["PLAY_SERVICE_ACCOUNT_JSON", "ANDROID_PACKAGE_NAME"]),
  // Signs the iOS archive. The team id selects the signing identity; without
  // it xcodebuild picks an arbitrary one or none.
  appleSigning: Object.freeze([
    "APPLE_CERTIFICATE_BASE64",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_TEAM_ID",
  ]),
  // Uploads to App Store Connect / TestFlight. An API key without its issuer
  // id authenticates as nobody and fails after the whole archive is built.
  appleUpload: Object.freeze([
    "APPLE_API_KEY_BASE64",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER_ID",
  ]),
});

/** The build needs this to know which backend the shipped app talks to. */
const API_URL_SECRET = "NEXT_PUBLIC_API_URL";

/** Accepts v1, v1.4, v1.4.0, with an optional -prerelease and +build suffix. */
const VERSION_TAG_RE =
  /^refs\/tags\/v(\d+(?:\.\d+){0,2})(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/;

const PLATFORM_CHOICES = ["both", "ios", "android"];

/**
 * @param {string} ref a git ref, e.g. "refs/tags/v1.4.0-beta.1"
 * @returns {{ version: string, prerelease: boolean } | null}
 *   `version` is the numeric core only ("1.4.0"), because iOS
 *   CFBundleShortVersionString and Android versionName both reject a
 *   prerelease suffix. The suffix survives as the `prerelease` flag.
 */
export function parseVersionTag(ref) {
  if (typeof ref !== "string") return null;
  const match = VERSION_TAG_RE.exec(ref);
  if (!match) return null;
  return { version: match[1], prerelease: Boolean(match[2]) };
}

/**
 * Split a secret set into all / none / some.
 * "some" is the dangerous state — it is always an error, never a silent skip.
 */
function classify(names, secretsPresent) {
  const present = names.filter((name) => secretsPresent[name] === true);
  const missing = names.filter((name) => secretsPresent[name] !== true);
  if (missing.length === 0) return { state: "all", present, missing };
  if (present.length === 0) return { state: "none", present, missing };
  return { state: "some", present, missing };
}

function partialError(label, group) {
  return (
    `${label} is partially configured. Set all of these secrets or none of them. ` +
    `Present: ${group.present.join(", ")}. Missing: ${group.missing.join(", ")}.`
  );
}

/**
 * Decide the entire release up front.
 *
 * @param {object} args
 * @param {string} args.ref                  github.ref
 * @param {string} args.eventName            github.event_name
 * @param {{platforms?: string, track?: string}} [args.inputs]  workflow_dispatch inputs
 * @param {Record<string, boolean>} args.secretsPresent  one BOOLEAN per secret name
 * @param {number} args.runNumber            github.run_number
 */
export function planMobileRelease({
  ref = "",
  eventName = "push",
  inputs = {},
  secretsPresent = {},
  runNumber = 0,
} = {}) {
  const errors = [];
  const notes = [];

  const tagInfo = parseVersionTag(ref);
  const version = tagInfo ? tagInfo.version : null;
  const prerelease = tagInfo ? tagInfo.prerelease : false;
  const tag = tagInfo ? ref.slice("refs/tags/".length) : null;

  // Both stores permanently reject a build number they have already seen, and
  // they reject it AFTER the upload, so the whole build is wasted. run_number
  // is the only value on a runner that is guaranteed to be monotonic. Deriving
  // it from the package version would collide the moment you re-tag or ship a
  // second build of the same version.
  const buildNumber = Number(runNumber) || 0;

  // --- what is even eligible to run -------------------------------------
  // A push to a branch is not a release. Building on every main push would
  // burn macOS minutes and, worse, put a store-shaped artifact on a commit
  // nobody decided to ship.
  const isTagPush = eventName === "push" && tagInfo !== null;
  const isDispatch = eventName === "workflow_dispatch";
  const eligible = isTagPush || isDispatch;

  if (eventName === "push" && !tagInfo) {
    notes.push(`\`${ref}\` is not a \`v*\` tag — nothing to release.`);
  }

  // --- platform narrowing -----------------------------------------------
  const requestedPlatforms = isDispatch ? inputs.platforms || "both" : "both";
  if (isDispatch && !PLATFORM_CHOICES.includes(requestedPlatforms)) {
    // A typo here would otherwise be read as "not android and not ios" and
    // produce a green run that built nothing while looking like a release.
    errors.push(
      `Unknown platforms input "${requestedPlatforms}". Expected one of: ${PLATFORM_CHOICES.join(", ")}.`,
    );
  }
  const wantAndroid = requestedPlatforms === "both" || requestedPlatforms === "android";
  const wantIos = requestedPlatforms === "both" || requestedPlatforms === "ios";
  if (isDispatch && requestedPlatforms !== "both") {
    notes.push(`Manual run limited to \`${requestedPlatforms}\`.`);
  }

  // --- credential sets ---------------------------------------------------
  const androidSigning = classify(SECRET_GROUPS.androidSigning, secretsPresent);
  const playUpload = classify(SECRET_GROUPS.playUpload, secretsPresent);
  const appleSigning = classify(SECRET_GROUPS.appleSigning, secretsPresent);
  const appleUpload = classify(SECRET_GROUPS.appleUpload, secretsPresent);

  // --- Android -----------------------------------------------------------
  const android = {
    build: false,
    sign: false,
    upload: false,
    track: "internal",
    artifact: false,
    reasons: [],
  };

  if (!eligible) {
    android.reasons.push("not a release ref");
  } else if (!wantAndroid) {
    android.reasons.push("excluded by the platforms input");
  } else if (androidSigning.state === "none") {
    // No signing material at all is a legitimate, quiet configuration: a fresh
    // checkout of the template has none. Build nothing rather than produce an
    // unsigned .aab, which cannot be uploaded and must never be published as a
    // release download — an unsigned bundle on a public tag run reads to a user
    // as "the app", and it is not installable or trustworthy.
    android.reasons.push("no Android signing secrets configured");
    notes.push(
      "Android skipped: none of " +
        SECRET_GROUPS.androidSigning.join(", ") +
        " are set.",
    );
  } else if (androidSigning.state === "some") {
    // Gradle would either fail late or fall back to an unsigned bundle. Fail
    // now, loudly, with the names of the secrets that are missing.
    errors.push(partialError("Android signing", androidSigning));
    android.reasons.push("Android signing secrets are incomplete");
  } else {
    android.build = true;
    android.sign = true;
    android.reasons.push("tag release with complete Android signing secrets");
  }

  // Never attach an unsigned artifact. `artifact` exists so the upload step
  // has one boolean to read instead of re-deriving the condition.
  android.artifact = android.sign;

  if (playUpload.state === "some") {
    // The bundle would build, sign, and then fail at the last step — or upload
    // to whatever package name happened to be set. Both are worse than a
    // refusal before the build starts.
    errors.push(partialError("Google Play upload", playUpload));
  } else if (android.sign && playUpload.state === "all") {
    android.upload = true;
  } else if (android.sign) {
    notes.push("Android artifact will be built but not uploaded to Google Play.");
  }

  // Track selection. A prerelease tag must never reach a public track: once a
  // build is promoted to production it is visible to every installed device,
  // and rolling it back means shipping yet another build.
  if (prerelease) {
    const requestedTrack = isDispatch && inputs.track ? inputs.track : null;
    android.track = "internal";
    if (requestedTrack && requestedTrack !== "internal") {
      notes.push(
        `Track input \`${requestedTrack}\` was overridden to \`internal\`: \`${tag}\` is a prerelease.`,
      );
    }
  } else {
    // Default conservative. Promoting internal -> production is a two-click
    // operation in the Play Console; demoting production is not an operation.
    android.track = (isDispatch && inputs.track) || "internal";
  }

  // --- iOS ---------------------------------------------------------------
  const ios = {
    build: false,
    sign: false,
    upload: false,
    artifact: false,
    reasons: [],
  };

  if (!eligible) {
    ios.reasons.push("not a release ref");
  } else if (!wantIos) {
    ios.reasons.push("excluded by the platforms input");
  } else if (appleSigning.state === "none") {
    // Same reasoning as Android, plus: an unsigned .xcarchive is useless to
    // everyone and costs macOS runner minutes at a multiplier.
    ios.reasons.push("no Apple signing secrets configured");
    notes.push(
      "iOS skipped: none of " + SECRET_GROUPS.appleSigning.join(", ") + " are set.",
    );
  } else if (appleSigning.state === "some") {
    // A certificate with no team id signs with an arbitrary identity, which
    // App Store Connect rejects after a 20-minute archive.
    errors.push(partialError("Apple signing", appleSigning));
    ios.reasons.push("Apple signing secrets are incomplete");
  } else {
    ios.build = true;
    ios.sign = true;
    ios.reasons.push("tag release with complete Apple signing secrets");
  }

  ios.artifact = ios.sign;

  if (appleUpload.state === "some") {
    // altool authenticates as nobody without the issuer id and fails at the
    // very end of the run.
    errors.push(partialError("App Store Connect upload", appleUpload));
  } else if (ios.sign && appleUpload.state === "all") {
    ios.upload = true;
  } else if (ios.sign) {
    notes.push("iOS artifact will be built but not uploaded to TestFlight.");
  }

  // A platform whose credentials are inconsistent must not build at all: a
  // half-signed build is the thing we are protecting against.
  if (androidSigning.state === "some") {
    android.build = false;
    android.sign = false;
    android.upload = false;
    android.artifact = false;
  }
  if (appleSigning.state === "some") {
    ios.build = false;
    ios.sign = false;
    ios.upload = false;
    ios.artifact = false;
  }

  // --- cross-cutting -----------------------------------------------------
  // Checked LAST and only when something is actually going to be built. A
  // checkout with no credentials at all has no API URL either, and that run
  // must still succeed with "nothing to build" instead of failing red on a
  // secret it was never going to use.
  if ((android.build || ios.build) && secretsPresent[API_URL_SECRET] !== true) {
    errors.push(
      `${API_URL_SECRET} is not set. The static export bakes the API URL in at ` +
        `build time, so the build would succeed and ship an app that talks to nothing.`,
    );
  }

  if (!android.build && !ios.build && errors.length === 0 && notes.length === 0) {
    notes.push("Nothing to build.");
  }

  return {
    version,
    tag,
    prerelease,
    buildNumber,
    android,
    ios,
    errors,
    notes,
  };
}

function yesNo(value) {
  return value ? "yes" : "no";
}

/**
 * Render the plan as GitHub-flavoured markdown for $GITHUB_STEP_SUMMARY.
 * The summary is the only place a reader learns WHY a platform was skipped,
 * so it carries the reasons and the notes verbatim.
 */
export function formatPlanSummary(plan) {
  const lines = [];
  lines.push("## Mobile release plan");
  lines.push("");
  lines.push(`- Ref version: \`${plan.tag ?? "none"}\``);
  lines.push(`- Marketing version: \`${plan.version ?? "n/a"}\``);
  lines.push(`- Build number: \`${plan.buildNumber}\``);
  lines.push(`- Prerelease: \`${yesNo(plan.prerelease)}\``);
  lines.push("");
  if (!plan.android.build && !plan.ios.build) {
    // Stated once, in bold, at the top: the most common outcome on a template
    // checkout is "nothing to build", and a reader must not have to infer it
    // from a grid of noes.
    lines.push("**Nothing to build.** See the reasons below.");
    lines.push("");
  }
  lines.push("| | Android | iOS |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Build | ${yesNo(plan.android.build)} | ${yesNo(plan.ios.build)} |`);
  lines.push(`| Sign | ${yesNo(plan.android.sign)} | ${yesNo(plan.ios.sign)} |`);
  lines.push(
    `| Keep artifact | ${yesNo(plan.android.artifact)} | ${yesNo(plan.ios.artifact)} |`,
  );
  lines.push(`| Upload | ${yesNo(plan.android.upload)} | ${yesNo(plan.ios.upload)} |`);
  lines.push(`| Destination | ${plan.android.track} | TestFlight |`);
  lines.push("");

  if (plan.android.reasons.length > 0 || plan.ios.reasons.length > 0) {
    lines.push("### Decisions");
    for (const reason of plan.android.reasons) lines.push(`- Android: ${reason}`);
    for (const reason of plan.ios.reasons) lines.push(`- iOS: ${reason}`);
    lines.push("");
  }

  if (plan.notes.length > 0) {
    lines.push("### Notes");
    for (const note of plan.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  if (plan.errors.length > 0) {
    lines.push("### Errors");
    for (const error of plan.errors) lines.push(`- ${error}`);
    lines.push("");
    lines.push("The release was refused before anything was built.");
    lines.push("");
  }

  return lines.join("\n");
}
