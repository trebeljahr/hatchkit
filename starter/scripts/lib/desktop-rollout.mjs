/*
 * Staged rollout of desktop updates, as rules with no network and no GitHub in
 * them. `scripts/desktop-release-draft.mjs` (CI, on a tag) and
 * `scripts/desktop-rollout.mjs` (a person, on a published release) both write
 * the percentage through `rewriteFeed`, so the two cannot disagree about what a
 * feed says.
 *
 * electron-updater reads `stagingPercentage` from the feed (`latest.yml`,
 * `latest-mac.yml`, `latest-linux*.yml`) and offers the update only when
 * `lastFourBytesOf(<userData>/.updaterId) / 0xffffffff < percentage / 100`
 * (`AppUpdater.isStagingMatch`, electron-updater 6.8.9). Three consequences the
 * rules below are built on:
 *
 *   - The id is random per install and never changes, so raising 10 to 50 keeps
 *     the first 10 % in and adds 40 % more. Lowering takes nobody back: an
 *     install that already updated is on the new version.
 *   - `0` offers the update to nobody.
 *   - An explicit `100` is NOT everybody: `x < 1` is false for the one id in
 *     2^32 whose last four bytes are all 0xff. A full rollout therefore removes
 *     the key, which is what "no staging" means to electron-updater.
 *
 * The feed is edited as text, one top-level line, and never re-serialised:
 * every other byte — above all each file's sha512 and size, which
 * `feedProblems` checks and the updater verifies — stays exactly as
 * electron-builder wrote it. `rewriteFeed` proves that by parsing both versions
 * and comparing everything but the key.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * electron-updater's own YAML parser, so a feed is read exactly the way the
 * installed apps that consume it read it, not the way another parser would.
 *
 * Resolved through the installed package rather than imported directly, because
 * js-yaml is electron-updater's dependency and not one this repo declares.
 * Before `pnpm install` there is nothing to resolve, and the bare failure is an
 * ENOENT stack naming a node_modules path — which reads as a broken release
 * script rather than a missing install.
 *
 * @param {string} repoRoot
 * @returns {{ load: (text: string) => unknown }}
 */
export function loadFeedParser(repoRoot) {
  let updaterDir;
  try {
    updaterDir = realpathSync(join(repoRoot, "node_modules/electron-updater"));
  } catch {
    throw new Error(
      "electron-updater is not installed, so a release feed cannot be parsed the " +
        "way the updater parses it. Run `pnpm install` first.",
    );
  }
  return createRequire(join(updaterDir, "package.json"))("js-yaml");
}

/** The top-level key electron-updater reads. */
export const STAGING_KEY = "stagingPercentage";

/**
 * A staging percentage as a person or a workflow input gives it.
 *
 * Empty (or absent) means a full rollout and returns null. Otherwise a whole
 * number from 0 to 100, with an optional trailing `%`; anything else is a typo
 * and throws. `100` also returns null: see the header.
 *
 * @param {string | number | null | undefined} raw
 * @returns {number | null} the percentage to write, or null for "remove the key"
 */
export function parseStagingPercentage(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/%$/, "").trim();
  if (text === "") return null;
  if (!/^\d{1,3}$/.test(text)) {
    throw new Error(`Staging percentage "${raw}" is not a whole number from 0 to 100.`);
  }
  const value = Number(text);
  if (value > 100) throw new Error(`Staging percentage ${value} is above 100.`);
  return value === 100 ? null : value;
}

/** How a parsed percentage reads in a log line. */
export function describeStaging(percent) {
  if (percent === null) return "every install (no stagingPercentage)";
  if (percent === 0) return "nobody (stagingPercentage: 0, rollout halted)";
  return `${percent} % of installs (stagingPercentage: ${percent})`;
}

const KEY_LINE = new RegExp(`^${STAGING_KEY}\\s*:.*(?:\\r?\\n|$)`, "gm");

/**
 * The feed text with its top-level `stagingPercentage` set to `percent`, or
 * removed for null. Only column-0 lines are touched, so a nested key of the
 * same name could never be rewritten by accident.
 *
 * @param {string} text
 * @param {number | null} percent
 * @returns {string}
 */
export function setStagingPercentage(text, percent) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let next = text.replace(KEY_LINE, "");
  if (percent === null) return next;
  if (next !== "" && !next.endsWith("\n")) next += eol;
  return `${next}${STAGING_KEY}: ${percent}${eol}`;
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function withoutKey(feed) {
  const copy = { ...feed };
  delete copy[STAGING_KEY];
  return copy;
}

/**
 * Rewrite one feed and prove the rewrite. Throws, naming the file, when the
 * input does not parse as an update feed (a mapping with a `version` and a
 * non-empty `files` list), or when the output parses to anything but the input
 * with the new percentage.
 *
 * @param {{ name: string, text: string, percent: number | null, parse: (text: string) => unknown }} input
 *   `parse` is electron-updater's own js-yaml `load`, so the feed is read the
 *   way installed apps read it.
 * @returns {{ text: string, before: number | null, after: number | null }}
 */
export function rewriteFeed({ name, text, percent, parse }) {
  let feed;
  try {
    feed = parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${name} does not parse as YAML: ${detail}`);
  }
  if (
    !isPlainObject(feed) ||
    typeof feed.version !== "string" ||
    !Array.isArray(feed.files) ||
    feed.files.length === 0
  ) {
    throw new Error(`${name} is not an update feed (no version or no files).`);
  }
  const before = feed[STAGING_KEY] === undefined ? null : feed[STAGING_KEY];
  if (before !== null && typeof before !== "number") {
    throw new Error(`${name} has a ${STAGING_KEY} that is not a number: ${JSON.stringify(before)}.`);
  }

  const next = setStagingPercentage(text, percent);
  const reparsed = parse(next);
  const after =
    isPlainObject(reparsed) && reparsed[STAGING_KEY] !== undefined ? reparsed[STAGING_KEY] : null;
  if (after !== percent) {
    throw new Error(
      `${name}: after the rewrite ${STAGING_KEY} reads ${JSON.stringify(after)}, ` +
        `expected ${JSON.stringify(percent)}.`,
    );
  }
  if (JSON.stringify(withoutKey(reparsed)) !== JSON.stringify(withoutKey(feed))) {
    throw new Error(`${name}: the rewrite changed more than ${STAGING_KEY}. Nothing was written.`);
  }
  return { text: next, before, after };
}

/** A release tag as the desktop workflow builds it. */
export function isReleaseTag(tag) {
  return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag);
}

/** The update feeds among a release's asset names. */
export function feedAssetNames(names) {
  return names.filter((name) => /^latest.*\.yml$/.test(name)).sort();
}

/**
 * Arguments of `pnpm desktop:rollout <vX.Y.Z> <percent> [--repo owner/name] [--dry-run]`.
 * The percentage is required here, unlike in CI: a person running the command
 * means a number, and an empty argument is a mistake rather than "100".
 *
 * `--repo` is optional because `gh` uses the checkout's own repository. Pass it
 * to work on a fork.
 *
 * @returns {{ tag: string, percent: number | null, repo: string | null, dryRun: boolean }}
 */
export function parseRolloutArgs(argv) {
  const positional = [];
  let repo = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--repo") {
      repo = argv[i + 1] ?? null;
      i += 1;
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("--repo needs <owner>/<name>.");
    } else if (arg.startsWith("-") && !/^-?\d/.test(arg)) throw new Error(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new Error(
      "Usage: pnpm desktop:rollout <vX.Y.Z> <percent 0-100> [--repo owner/name] [--dry-run]",
    );
  }
  const [tag, rawPercent] = positional;
  if (!isReleaseTag(tag)) throw new Error(`"${tag}" is not a release tag like v1.2.3.`);
  if (String(rawPercent).trim() === "") throw new Error("Give a percentage from 0 to 100.");
  return { tag, percent: parseStagingPercentage(rawPercent), repo, dryRun };
}
