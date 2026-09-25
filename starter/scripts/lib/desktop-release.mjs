/*
 * Desktop release rules, shared by `scripts/build-desktop.mjs`,
 * `electron-builder.config.mjs`, `scripts/desktop-release-draft.mjs` and
 * `.github/workflows/desktop-release.yml`. Pure — every input is an argument —
 * so each rule is a unit test (`desktop-release.test.mjs`) rather than a CI run
 * on another operating system.
 *
 * Signing fails closed. No secrets at all builds an artifact that says it is
 * unsigned in its file name; a complete set signs; anything in between refuses
 * before the build. A half-configured set is a typo, and the alternative is
 * shipping an unsigned build under a signed build's name.
 */

/** Every desktop channel the release workflow signs, or does not sign. */
export const CHANNELS = Object.freeze(["mac", "win", "linux"]);

/** The platform flag `scripts/build-desktop.mjs` takes for each channel. */
export const PLATFORM_FLAGS = Object.freeze({ mac: "--mac", win: "--win", linux: "--linux" });

/**
 * The channel one `build-desktop.mjs` argument list builds, or null when it
 * names no platform or more than one. The caller decides what to do with null:
 * a local `--dir` preview has no channel and signs nothing.
 *
 * @param {string[]} args
 * @returns {"mac" | "win" | "linux" | null}
 */
export function channelForPlatform(args) {
  const found = CHANNELS.filter((channel) => args.includes(PLATFORM_FLAGS[channel]));
  return found.length === 1 ? found[0] : null;
}

/**
 * The one variable that carries the build's decision from
 * `scripts/build-desktop.mjs` into `electron-builder.config.mjs`: the channel,
 * plus `-unsigned` when nothing signed it. One variable, so the update feed and
 * the artifact names cannot disagree about the same build.
 */
export const DESKTOP_TARGET_ENV = "DESKTOP_TARGET";

/** The target string for a channel and the mode `resolveSigning` returned. */
export function desktopTarget(channel, mode) {
  if (!CHANNELS.includes(channel)) return "local";
  // Linux carries no suffix: nothing on Linux is signed, so a suffix on every
  // Linux build would say nothing about this one.
  if (channel === "linux") return channel;
  return mode === "unsigned" ? `${channel}-unsigned` : channel;
}

/**
 * Read a target back. An unknown one — "local", or electron-builder started by
 * hand — is `{ channel: null }`, which gets no update feed.
 *
 * @returns {{ channel: "mac" | "win" | "linux" | null, unsigned: boolean }}
 */
export function parseTarget(target) {
  const text = String(target ?? "").trim();
  const unsigned = text.endsWith("-unsigned");
  const channel = unsigned ? text.slice(0, -"-unsigned".length) : text;
  return { channel: CHANNELS.includes(channel) ? channel : null, unsigned };
}

/**
 * Environment variables each channel's signing needs, as electron-builder
 * reads them. The workflow maps its repository secrets onto these names.
 *
 * mac: a Developer ID Application certificate (p12) and the App Store Connect
 *      key that notarizes. A signed build that is not notarized is still
 *      blocked by Gatekeeper, so notarization belongs to the set.
 * win: EITHER a certificate file (signtool) OR Azure Trusted Signing.
 * linux: nothing is signed, so the list is empty and every Linux build is
 *      "unsigned" without that being a finding.
 */
export const SIGNING_SETS = Object.freeze({
  mac: [["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]],
  win: [
    ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
    [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT",
      "AZURE_TRUSTED_SIGNING_PROFILE",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ],
  ],
  linux: [],
});

/**
 * The variables whose presence means "sign this channel". The others in the set
 * are then required, but on their own start nothing: the App Store Connect API
 * key is the one the iOS release already uses (`mobile-release.yml`), so a repo
 * that ships the phone app has it set without meaning to sign a desktop build.
 * A channel not listed here counts every variable in its sets.
 */
export const SIGNING_TRIGGERS = Object.freeze({
  mac: ["CSC_LINK", "CSC_KEY_PASSWORD"],
});

/**
 * What electron-builder signs or notarizes with on its own, whatever the config
 * says: a certificate (`WIN_CSC_LINK` falls back to `CSC_LINK`, so an Apple p12
 * in the shell is picked up by a Windows build too) and every notarization
 * credential. All of them are stripped from an unsigned build, or its
 * `-unsigned` name would be a lie.
 */
export const SIGNING_CREDENTIAL_VARS = Object.freeze([
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_KEYCHAIN_PROFILE",
]);

/** A GitHub secret that is not set expands to "", which is also unset. */
function isSet(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

/**
 * @param {string} channel
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: "signed" | "unsigned", set?: string[] }}
 * @throws {Error} on a partial set, two complete sets, or an unknown channel
 */
export function resolveSigning(channel, env) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(
      `Unknown desktop channel "${channel}". Expected one of: ${CHANNELS.join(", ")}.`,
    );
  }

  const sets = SIGNING_SETS[channel];
  const triggers = SIGNING_TRIGGERS[channel];
  const complete = [];
  for (const set of sets) {
    const present = set.filter((name) => isSet(env, name));
    const started = present.filter((name) => !triggers || triggers.includes(name));
    if (present.length === set.length) {
      complete.push(set);
    } else if (started.length > 0) {
      const missing = set.filter((name) => !isSet(env, name));
      throw new Error(
        `The ${channel} signing secrets are incomplete. Set: ${present.join(", ")}. ` +
          `Missing: ${missing.join(", ")}.\n` +
          "  Set all of them to sign, or none of them for an artifact named -unsigned.",
      );
    }
  }
  if (complete.length > 1) {
    throw new Error(
      `Two complete ${channel} signing configurations are set ` +
        `(${complete.map((set) => set[0]).join(" and ")}). ` +
        "Keep one, so which certificate signed a release is never a guess.",
    );
  }
  return complete.length === 1 ? { mode: "signed", set: complete[0] } : { mode: "unsigned" };
}

/**
 * The environment electron-builder runs in for a channel.
 *
 * Identity auto-discovery is off in both modes: a developer's keychain must
 * never sign a build by accident, and every machine has to produce the same
 * thing. An unsigned build also loses every credential above, and is marked so
 * the config can put `-unsigned` in each artifact name.
 */
export function builderEnvFor(channel, env, signing) {
  const next = { ...env, [DESKTOP_TARGET_ENV]: desktopTarget(channel, signing.mode) };
  if (signing.mode === "unsigned") {
    for (const name of SIGNING_CREDENTIAL_VARS) delete next[name];
  }
  next.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return next;
}

/**
 * Where direct downloads are published and where their updater looks.
 *
 * No owner or repo: electron-builder reads them from the `repository` field of
 * package.json, so this template names no repository and a fork needs no edit.
 * electron-builder only ever uploads into a draft; a person publishes it, and
 * publishing is what makes installed apps see the release.
 */
export const UPDATE_FEED = Object.freeze({ provider: "github", releaseType: "draft" });

/**
 * The electron-builder `publish` value for a build, which decides whether the
 * app gets an `app-update.yml` (and the release a `latest*.yml`) at all.
 *
 * - mac and win: only when signed. Squirrel.Mac refuses to install into an
 *   unsigned app, and an `-unsigned` test build must never replace itself with
 *   a release.
 * - linux: always. Nothing on Linux is signed; the AppImage is the only one of
 *   its packages that updates itself, and the app decides that at run time
 *   (`electron/src/updater-model.ts`), because electron-builder writes the same
 *   file into the deb, the rpm and the tar.gz.
 * - anything else, including a local preview: never.
 *
 * Always `null`, never `undefined`, when there is no feed: with `publish` unset
 * electron-builder guesses a GitHub feed whenever GH_TOKEN or GITHUB_TOKEN is in
 * the environment — which it is on every CI runner.
 *
 * @param {string} target  what `DESKTOP_TARGET` holds, from `desktopTarget`
 * @returns {typeof UPDATE_FEED | null}
 */
export function updateFeedFor(target) {
  const { channel, unsigned } = parseTarget(target);
  if (channel === "linux") return UPDATE_FEED;
  if ((channel === "mac" || channel === "win") && !unsigned) return UPDATE_FEED;
  return null;
}

/**
 * Artifact names, in one place. electron-builder expands `${name}` (the package
 * name), `${version}`, `${arch}` and `${ext}`.
 *
 * `${name}` rather than `${productName}`, because the names must carry no
 * space: electron-updater's GitHub provider replaces a space in a feed's `url`
 * with a dash, and then asks the release page for a file name no asset has.
 *
 * Linux names have no `-unsigned` suffix, because no Linux package is ever
 * signed and a suffix every build carries says nothing.
 */
export function artifactPatterns(target) {
  const suffix = parseTarget(target).unsigned ? "-unsigned" : "";
  return {
    dmg: `\${name}-\${version}-mac-\${arch}${suffix}.\${ext}`,
    zip: `\${name}-\${version}-mac-\${arch}${suffix}.\${ext}`,
    // One installer carries both architectures (electron-builder combines them
    // when nsis is built for more than one), so there is no ${arch} in it.
    nsis: `\${name}-Setup-\${version}${suffix}.\${ext}`,
    linux: "${name}-${version}-linux-${arch}.${ext}",
  };
}

/** Expand one pattern the way electron-builder does, for logs and checks. */
export function expandArtifactName(pattern, values) {
  return pattern.replace(/\$\{(\w+)\}/g, (whole, key) => {
    if (!(key in values)) throw new Error(`No value for \${${key}} in ${pattern}`);
    return values[key];
  });
}

/**
 * On a tag run the tag must name the version being packaged: electron-builder
 * reads the root package.json, and a `v0.2.0` tag over a `0.1.0` package.json
 * would publish a 0.1.0 app as 0.2.0's download.
 */
export function tagMismatch({ refType, refName, version }) {
  if (refType !== "tag") return null;
  return refName === `v${version}`
    ? null
    : `Tag ${refName} does not match package.json version ${version} (expected v${version}).`;
}

/**
 * The update feed file each release leg must carry, when it carries one: what
 * electron-updater asks for on that platform. `latest-mac.yml` holds both mac
 * architectures, `latest.yml` the one NSIS installer, and Linux names its
 * architecture unless it is x64. Keyed by the workflow's matrix `channel`.
 */
export const FEED_FILES = Object.freeze({
  mac: "latest-mac.yml",
  win: "latest.yml",
  "linux-x64": "latest-linux.yml",
  "linux-arm64": "latest-linux-arm64.yml",
});

/** Files a store or a package manager delivers; never a release-page download. */
const STORE_ONLY = /\.(pkg|appx|snap)$/;

/**
 * What goes into the draft GitHub Release for a tag, from the legs the matrix
 * built (`desktop-<channel>-<mode>` artifacts).
 *
 * - An `-unsigned` file is never attached: a release page is where people
 *   download from, and the updater would offer nothing for it anyway. The leg's
 *   absence is a warning, so whoever publishes the draft sees which platform has
 *   no download this time.
 * - Store packages stay CI artifacts for a manual upload.
 * - Per-leg checksum files are replaced by one file over what is attached.
 * - A leg that has a feed (signed mac and win, every Linux leg) must bring its
 *   feed file. Without it installed apps would never see this release, and
 *   nothing else would say so.
 *
 * @param {{ channel: string, mode: string, files: string[] }[]} legs
 * @returns {{ upload: string[], feeds: string[], warnings: string[], problems: string[] }}
 */
export function releasePlan(legs) {
  const upload = [];
  const feeds = [];
  const warnings = [];
  const problems = [];
  for (const leg of legs) {
    const feedFile = FEED_FILES[leg.channel];
    const hasFeed =
      feedFile !== undefined && (leg.channel.startsWith("linux") || leg.mode === "signed");
    if ((leg.channel === "mac" || leg.channel === "win") && leg.mode !== "signed") {
      const platform = leg.channel === "mac" ? "macOS" : "Windows";
      warnings.push(
        `${leg.channel} was built unsigned: the draft has no ${platform} download and no update for it.`,
      );
    }
    for (const file of leg.files) {
      const name = file.split("/").pop();
      if (/-unsigned\./.test(name) || STORE_ONLY.test(name) || /^SHA256SUMS/.test(name)) continue;
      if (/^latest.*\.yml$/.test(name)) {
        if (hasFeed && name === feedFile) feeds.push(file);
        continue;
      }
      upload.push(file);
    }
    if (hasFeed && !leg.files.some((file) => file.split("/").pop() === feedFile)) {
      problems.push(
        `The ${leg.channel} leg has no ${feedFile}; installed apps would never be offered this release.`,
      );
    }
  }
  if (upload.length === 0) {
    problems.push("Nothing to attach: every leg was unsigned, a store package, or empty.");
  }
  return { upload, feeds, warnings, problems };
}

/**
 * Every file a feed names must be attached, with the size and the sha512 the
 * feed states, or the updater downloads it, rejects the checksum and reports an
 * error to every installed app.
 *
 * @param {{ name: string, feed: { files?: { url: string, sha512: string, size?: number }[] } }[]} feeds
 * @param {Map<string, { sha512: string, size: number }>} attached  by file name
 * @returns {string[]} problems
 */
export function feedProblems(feeds, attached) {
  const problems = [];
  for (const { name, feed } of feeds) {
    const files = Array.isArray(feed?.files) ? feed.files : [];
    if (files.length === 0) problems.push(`${name} lists no files.`);
    for (const entry of files) {
      // electron-updater's GitHub provider replaces spaces with dashes.
      const fileName = String(entry.url).replace(/ /g, "-");
      const actual = attached.get(fileName);
      if (!actual) {
        problems.push(`${name} names ${fileName}, which is not attached.`);
      } else if (actual.sha512 !== entry.sha512) {
        problems.push(`${name}: the sha512 of ${fileName} does not match the attached file.`);
      } else if (typeof entry.size === "number" && entry.size !== actual.size) {
        problems.push(`${name}: the size of ${fileName} does not match the attached file.`);
      }
    }
  }
  return problems;
}
