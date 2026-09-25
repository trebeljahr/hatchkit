/**
 * Every file a release rewrites, and every copy of the version it checks —
 * the arithmetic behind `release.mjs`, kept free of git, the filesystem and
 * the clock so the same functions serve the cut command, the policy check
 * and the version-sync test.
 *
 * A project has one version, in `project.versionFile`. Everywhere else the
 * version appears — an image tag, a Gradle `versionName`, an Xcode
 * `MARKETING_VERSION`, an extension manifest — is a COPY, and a copy that
 * drifts ships a build that reports the wrong version with nothing failing
 * anywhere. Each copy is one `VersionCopy` row in `.hatchkit-release.json`:
 * a path, a regex with one capture group, and how the version is spelled
 * there. This file is the only place that applies those rows, so the test,
 * the policy rule and the rewrite can never disagree about what a copy is.
 *
 * Build numbers are the exception that proves it: an Android `versionCode`
 * or an iOS `CURRENT_PROJECT_VERSION` is not the version, it is a counter
 * the stores demand go up. It is checked for shape and bumped, never
 * compared to the semver.
 */
import { compareVersions, parseVersion } from "./release-config.mjs";

const message = (caught) => (caught instanceof Error ? caught.message : String(caught));

/** `flags` plus `extra`, without ever repeating one (a duplicate throws). */
const withFlags = (flags, extra) => [...new Set(`${flags ?? ""}${extra}`)].join("");

/** How a failure names a copy: enough to fix it without opening anything. */
const naming = (copy) => `${copy.path} (${copy.label})`;

/**
 * The version strings a copy's pattern finds in `contents`.
 *
 * `expectCount` is enforced here rather than by the caller because a count
 * that does not match is itself the failure: a compose file with two image
 * defaults and one substituted is a half-bumped release, and it reads as a
 * success to anything that only looks at the first match.
 *
 * @param {object} copy a `VersionCopy` row
 * @param {string | null} contents the file, or null when it is missing
 * @returns {{ values: string[], error: string | null }}
 */
export function readVersionCopy(copy, contents) {
  if (typeof contents !== "string") {
    return { values: [], error: `${naming(copy)} is missing` };
  }
  let pattern;
  try {
    pattern = new RegExp(copy.pattern, withFlags(copy.flags, "g"));
  } catch (caught) {
    return {
      values: [],
      error: `${naming(copy)}: ${copy.pattern} is not a valid regex (${message(caught)})`,
    };
  }
  const values = [];
  for (const match of contents.matchAll(pattern)) {
    if (match[1] === undefined) {
      return {
        values: [],
        error: `${naming(copy)}: the pattern ${copy.pattern} has no capture group`,
      };
    }
    values.push(match[1].trim());
  }
  const expected = copy.expectCount ?? null;
  if (expected === null) {
    if (values.length === 0) {
      return { values, error: `${naming(copy)}: nothing matched ${copy.pattern}` };
    }
  } else if (values.length !== expected) {
    return {
      values,
      error: `${naming(copy)}: expected ${expected} match(es) of ${copy.pattern}, found ${values.length}`,
    };
  }
  return { values, error: null };
}

/** Why a single found value is wrong for `version`, or null. */
const copyProblem = (copy, value, version) => {
  if (copy.form === "build-number") {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return `${naming(copy)}: "${value}" is not a positive integer build number`;
    }
    return null;
  }
  const want = copy.form === "v-prefixed" ? `v${version}` : version;
  return value === want ? null : `${naming(copy)}: "${value}" should be "${want}"`;
};

/**
 * Every version copy that disagrees with `version`, and which ones were
 * looked at. Empty `problems` with an empty `checked` is the correct answer
 * for a project that keeps no copies at all.
 *
 * @param {object} input
 * @param {object} input.config the release config
 * @param {string} input.version X.Y.Z the copies must agree with
 * @param {(path: string) => string | null} input.readFile
 * @returns {{ problems: string[], checked: string[] }}
 */
export function checkVersionCopies({ config, version, readFile }) {
  const problems = [];
  const checked = [];
  for (const copy of config.versionCopies ?? []) {
    checked.push(naming(copy));
    const read = readVersionCopy(copy, readFile(copy.path));
    if (read.error) {
      problems.push(read.error);
      continue;
    }
    for (const value of read.values) {
      const problem = copyProblem(copy, value, version);
      if (problem) problems.push(problem);
    }
  }
  return { problems, checked };
}

/**
 * `text` with capture group 1 of every match replaced by `replacer(value)`,
 * and every other byte left alone.
 *
 * The `d` flag gives the group's absolute span, which is what makes this
 * work for any pattern a config can carry: the rewrite never has to know
 * what surrounds the version, only where the version itself starts and
 * ends. A config pattern with no group 1 is skipped rather than guessed at.
 */
const rewriteCaptures = (text, source, flags, replacer) => {
  const pattern = new RegExp(source, withFlags(flags, "gd"));
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const span = match.indices?.[1];
    if (!span) continue;
    out += text.slice(last, span[0]) + replacer(match[1]);
    last = span[1];
  }
  return out + text.slice(last);
};

/** The root `"version"` key, formatting and key order untouched. */
const ROOT_VERSION = /^(\s*"version"\s*:\s*")[^"]*(")/m;

const setRootVersion = (text, version, path) => {
  if (!ROOT_VERSION.test(text)) return { text, error: `${path} has no "version" field` };
  const next = text.replace(ROOT_VERSION, `$1${version}$2`);
  try {
    // A JSON version file gets the real check: the first `"version"` key
    // must be the top-level one, not a dependency's.
    if (JSON.parse(next).version !== version) {
      return { text, error: `${path}: the first "version" key is not the top-level one` };
    }
  } catch {
    // Not JSON. The regex above is then the whole check, by design: the
    // config is free to point `versionFile` at something else.
  }
  return { text: next, error: null };
};

/**
 * Every file a release of `version` writes, as
 * `{ path, before, after, label }` — the root version file and every copy,
 * with a file that holds more than one of them rewritten once.
 *
 * `problems` are reasons the plan is incomplete (a missing file, a pattern
 * that no longer matches). They are not warnings: a release that rewrites
 * three of four copies is exactly the drift this feature exists to stop.
 *
 * @param {object} input
 * @param {object} input.config
 * @param {string} input.version X.Y.Z
 * @param {(path: string) => string | null} input.readFile the tree to plan against
 * @returns {{ changes: { path: string, before: string, after: string, label: string }[],
 *            problems: string[] }}
 */
export function planVersionRewrite({ config, version, readFile }) {
  const problems = [];
  /** path -> the file as it is becoming, plus what is being changed in it. */
  const files = new Map();
  const open = (path) => {
    if (!files.has(path)) {
      const before = readFile(path);
      files.set(path, { before, after: before, labels: [] });
    }
    return files.get(path);
  };

  const versionFile = config.project?.versionFile ?? "package.json";
  const root = open(versionFile);
  if (root.before === null) {
    problems.push(`${versionFile} is missing; it holds the one version this project releases`);
  } else {
    const result = setRootVersion(root.after, version, versionFile);
    if (result.error) problems.push(result.error);
    else {
      root.after = result.text;
      root.labels.push("the root version");
    }
  }

  for (const copy of config.versionCopies ?? []) {
    const file = open(copy.path);
    if (file.before === null) {
      problems.push(`${naming(copy)} is missing`);
      continue;
    }
    const read = readVersionCopy(copy, file.after);
    if (read.error) {
      problems.push(read.error);
      continue;
    }
    if (copy.form === "build-number") {
      const numbers = read.values.map((value) => Number(value));
      if (numbers.some((value) => !Number.isInteger(value) || value <= 0)) {
        problems.push(
          `${naming(copy)}: not every match is a positive integer (${read.values.join(", ")})`,
        );
        continue;
      }
      // One number for the whole file: a project whose debug and release
      // configurations carry the same counter must move both together, or
      // the store rejects the next upload from the lower one.
      const next = String(Math.max(...numbers) + 1);
      file.after = rewriteCaptures(file.after, copy.pattern, copy.flags, () => next);
    } else {
      const want = copy.form === "v-prefixed" ? `v${version}` : version;
      file.after = rewriteCaptures(file.after, copy.pattern, copy.flags, () => want);
    }
    file.labels.push(copy.label);
  }

  const changes = [];
  for (const [path, file] of files) {
    if (file.before === null || file.after === file.before) continue;
    changes.push({ path, before: file.before, after: file.after, label: file.labels.join(", ") });
  }
  return { changes, problems };
}

/**
 * Why `next` cannot be released from a tree at `current`, or null.
 *
 * `next` must be newer than `current`, with one exception: the version the
 * tree already carries may be released while no tag has it yet. That is the
 * first release (the repo has said 0.1.0 since before any tag), and it is
 * also a bump someone committed by hand before running the command.
 *
 * @param {object} input
 * @param {string} input.current the version in the root version file
 * @param {string} input.next the version that was typed
 * @param {string[]} input.tags every known tag, local and remote
 * @param {string} [input.tagPrefix]
 * @returns {string | null}
 */
export function versionRefusal({ current, next, tags, tagPrefix = "v" }) {
  const parsed = parseVersion(next);
  if (!parsed) return `"${next}" is not an X.Y.Z version`;
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`;
  const tag = `${tagPrefix}${version}`;
  const known = Array.isArray(tags) ? tags : [];
  if (known.includes(tag)) return `the tag ${tag} already exists`;
  const order = compareVersions(version, current);
  if (Number.isNaN(order)) return `the current version "${current}" is not a semver version`;
  if (order < 0) return `${version} is lower than the current version ${current}`;
  return null;
}
