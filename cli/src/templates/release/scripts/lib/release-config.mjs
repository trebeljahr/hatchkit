/**
 * Reads `.hatchkit-release.json` — the one file the release scripts know
 * anything from — and the version arithmetic every one of them needs.
 *
 * Hatchkit generates that config from the project manifest. These scripts
 * are copied into the project verbatim and never regenerated on their own,
 * so the two halves can drift: a project can get a newer config while its
 * `scripts/` stay where they were. `loadReleaseConfig` refuses that case by
 * `configVersion` rather than half-reading a shape it does not know, which
 * is the difference between "run hatchkit update" and a release that
 * skipped a check nobody noticed was missing.
 *
 * Everything but `loadReleaseConfig` is pure, so the rest of the release
 * mechanism — and its tests — can use it without a project on disk.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-root file Hatchkit writes. Committed; it carries no secrets. */
export const RELEASE_CONFIG_FILENAME = ".hatchkit-release.json";

/** The newest `configVersion` these scripts can read end to end. */
export const SUPPORTED_CONFIG_VERSION = 1;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const message = (caught) => (caught instanceof Error ? caught.message : String(caught));

/**
 * Fills in every list the config may omit, so no consumer has to guard.
 * An empty list is always a valid answer: a project whose only surface is a
 * web deploy really does have no credential groups and no version copies.
 */
const normalize = (raw) => ({
  configVersion: Number(raw.configVersion ?? SUPPORTED_CONFIG_VERSION),
  generatedBy: String(raw.generatedBy ?? "unknown"),
  generatedAt: String(raw.generatedAt ?? ""),
  project: {
    name: String(raw.project?.name ?? "this project"),
    versionFile: String(raw.project?.versionFile ?? "package.json"),
    tagPrefix: String(raw.project?.tagPrefix ?? "v"),
    packageManager: String(raw.project?.packageManager ?? "pnpm"),
    testCommand: raw.project?.testCommand ?? null,
  },
  channels: Array.isArray(raw.channels) ? raw.channels : [],
  versionCopies: Array.isArray(raw.versionCopies) ? raw.versionCopies : [],
  versionReads: Array.isArray(raw.versionReads) ? raw.versionReads : [],
  credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
  policy: {
    rules: Array.isArray(raw.policy?.rules) ? raw.policy.rules : [],
    warnOnly: Array.isArray(raw.policy?.warnOnly) ? raw.policy.warnOnly : [],
  },
  compat: raw.compat ?? null,
});

/**
 * The config at `rootDir`, normalized. Throws an Error whose message names
 * the fix — these scripts run in CI, where the only debugging anyone gets
 * is the line that failed.
 *
 * @param {string} rootDir repo root
 */
export function loadReleaseConfig(rootDir) {
  const path = join(rootDir, RELEASE_CONFIG_FILENAME);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `${RELEASE_CONFIG_FILENAME} is missing from ${rootDir}. It is generated: run ` +
        "`hatchkit update` in this project and enable the release feature.",
    );
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (caught) {
    throw new Error(
      `${RELEASE_CONFIG_FILENAME} is not valid JSON (${message(caught)}). Restore it with ` +
        "`git checkout -- " +
        `${RELEASE_CONFIG_FILENAME}\`, or regenerate it with \`hatchkit update\`.`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${RELEASE_CONFIG_FILENAME} is not a JSON object; regenerate it with \`hatchkit update\`.`,
    );
  }
  const configVersion = Number(raw.configVersion ?? 0);
  if (Number.isFinite(configVersion) && configVersion > SUPPORTED_CONFIG_VERSION) {
    throw new Error(
      `${RELEASE_CONFIG_FILENAME} is configVersion ${configVersion}; these scripts read up to ` +
        `${SUPPORTED_CONFIG_VERSION}. Your scripts/ is older than ${RELEASE_CONFIG_FILENAME}; ` +
        "run `hatchkit update` to refresh them.",
    );
  }
  return normalize(raw);
}

/**
 * True for `v1.2.3` and `v1.2.3-pre.1`. Anything else never reaches a
 * `gh api` path or a `git tag` argument.
 *
 * @param {unknown} tag
 * @param {string} [prefix] tag prefix; `v` everywhere Hatchkit generates
 */
export function isReleaseTag(tag, prefix = "v") {
  return parseTag(tag, prefix) !== null;
}

/**
 * `{ version, prerelease }` for a release tag, or null. `version` is the
 * tag without its prefix, prerelease part included, so it can be compared
 * straight against the root package version.
 *
 * @param {unknown} tag
 * @param {string} [prefix]
 */
export function parseTag(tag, prefix = "v") {
  if (typeof tag !== "string") return null;
  const stripped = new RegExp(`^${escapeRegExp(prefix)}(.*)$`).exec(tag.trim());
  if (!stripped) return null;
  const parsed = parseVersion(stripped[1]);
  if (!parsed) return null;
  return { version: formatVersion(parsed), prerelease: parsed.prerelease };
}

/**
 * `{ major, minor, patch, prerelease }`, or null when `text` is not a
 * semver version. Strict: a leading `v` makes it null, because a package
 * version that carries one is itself the bug this would hide.
 *
 * @param {unknown} text
 */
export function parseVersion(text) {
  const match = VERSION.exec(String(text ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** `1.2.3` / `1.2.3-rc.1` from a parsed version. */
const formatVersion = (parsed) =>
  `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`;

/**
 * Semver precedence: -1, 0 or 1, and NaN when either side is unreadable
 * (callers that care check `Number.isNaN` and say so rather than ordering
 * two things they could not parse).
 *
 * A prerelease sorts BELOW its own release — `1.2.0-rc.1` < `1.2.0` — which
 * is the rule the whole "is this tag newer" question rests on.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return Number.NaN;
  for (const part of ["major", "minor", "patch"]) {
    if (pa[part] !== pb[part]) return pa[part] > pb[part] ? 1 : -1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  const ia = pa.prerelease.split(".");
  const ib = pb.prerelease.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb) {
      if (Number(ia[i]) !== Number(ib[i])) return Number(ia[i]) > Number(ib[i]) ? 1 : -1;
    } else if (na !== nb) {
      // Numeric identifiers always have lower precedence (semver §11).
      return na ? -1 : 1;
    } else if (ia[i] !== ib[i]) {
      return ia[i] > ib[i] ? 1 : -1;
    }
  }
  return 0;
}

/**
 * The newest stable tag in `tags` strictly below `tag`, or null when `tag`
 * is the first release. Prereleases are never the answer: "what did people
 * have before this" means the last thing that reached them.
 *
 * @param {string[]} tags existing tag names
 * @param {string} tag the tag being released
 * @param {string} [prefix]
 */
export function previousStableTag(tags, tag, prefix = "v") {
  const target = parseTag(tag, prefix);
  if (!target) return null;
  const below = (Array.isArray(tags) ? tags : [])
    .map((name) => ({ name, parsed: parseTag(name, prefix) }))
    .filter(({ parsed }) => parsed !== null && parsed.prerelease === null)
    .filter(({ parsed }) => compareVersions(parsed.version, target.version) < 0)
    .sort((a, b) => compareVersions(a.parsed.version, b.parsed.version));
  return below.at(-1)?.name ?? null;
}
