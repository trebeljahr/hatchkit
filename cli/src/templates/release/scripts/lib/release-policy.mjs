/**
 * The release policy, evaluated. One branch per `PolicyRule.kind`, and no
 * knowledge whatsoever of which surfaces a project has: a new store adds a
 * rule row to `.hatchkit-release.json`, never a branch here.
 *
 * The rules are the questions nobody remembers to ask at 11pm — does the
 * package version actually match the tag, did every copy of it move, is
 * this prerelease about to reach a store, is half a credential set
 * configured (which builds something and uploads nothing, or uploads
 * something unsigned). `release.mjs` runs this against the commit it is
 * about to tag, and the release workflow runs it again at the tag before
 * anything is built, so a failure costs nothing both times.
 *
 * TWO THINGS THIS FILE REFUSES TO DO
 * ----------------------------------
 *   1. Pass a rule it did not evaluate. A local run cannot see repo
 *      secrets; `secretsPresent: null` says so, and the credential rules
 *      then emit a NOTE explaining they were skipped — never a pass.
 *   2. Ignore a rule kind it does not understand. That means the config is
 *      newer than these scripts, which is a problem, not a pass.
 *
 * Pure: no fs, no git, no network. Files arrive through `readFile`, which
 * the caller binds to a git ref.
 */
import { compareVersions, parseTag } from "./release-config.mjs";
import { checkVersionCopies } from "./release-plan.mjs";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A `release-record` rule's `headingPattern` with the version put in.
 *
 * The pattern is a regex source that has to name a version the rule cannot
 * know when it is written, so it carries a placeholder. Every spelling a
 * generator might reasonably use is accepted, because the alternative — a
 * pattern whose placeholder was not recognised — matches nothing and turns
 * a rule about the changelog into a rule that always fails.
 */
const withVersion = (pattern, version) => {
  const escaped = escapeRegExp(version);
  return String(pattern ?? "")
    .replaceAll("{{version}}", escaped)
    .replaceAll("{version}", escaped)
    .replaceAll("__VERSION__", escaped)
    .replaceAll("%s", escaped);
};

/** The version a version file declares, or null. */
const readRootVersion = (readFile, versionFile) => {
  const text = readFile(versionFile);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.version === "string") return parsed.version.trim();
  } catch {
    // Not JSON; fall through to the textual form below.
  }
  return /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1]?.trim() ?? null;
};

/** A channel row by id, or a stand-in so a stale rule still reads well. */
const channelOf = (config, id) =>
  (config.channels ?? []).find((channel) => channel.id === id) ?? {
    id,
    label: id,
    publicDistribution: false,
  };

const labelsOf = (config, ids) =>
  (ids ?? []).map((id) => channelOf(config, id).label ?? id).join(", ");

/** What a channel does when its credentials are absent, in words. */
const ABSENT_IN_WORDS = {
  skip: "the upload is skipped and the build is attached to the run instead",
  unsigned: "the artifact is built unsigned and is not uploaded anywhere installable",
  fail: "the workflow fails",
};

/**
 * Every problem with releasing `tag`, and every note worth printing.
 *
 * @param {object} input
 * @param {object} input.config the release config
 * @param {string} input.tag the tag being released, e.g. `v1.2.3`
 * @param {string[]} input.tags existing tag names
 * @param {(path: string) => string | null} input.readFile files at the release's ref
 * @param {Set<string> | null} input.secretsPresent configured secret names,
 *   or null when that is not knowable from where this runs
 * @returns {{ problems: { ruleId: string, severity: string, message: string, detail: string }[],
 *             notes: string[] }}
 */
export function evaluatePolicy({ config, tag, tags, readFile, secretsPresent }) {
  const problems = [];
  const notes = [];
  const prefix = config.project?.tagPrefix ?? "v";
  const warnOnly = new Set(config.policy?.warnOnly ?? []);
  const known = Array.isArray(tags) ? tags : [];

  const add = (rule, detail) =>
    problems.push({
      ruleId: rule.id,
      severity: warnOnly.has(rule.id) ? "warn" : "error",
      message: rule.message ?? `${rule.id} failed`,
      detail,
    });

  const parsed = parseTag(tag, prefix);
  if (!parsed) {
    problems.push({
      ruleId: "tag-format",
      severity: "error",
      message: `"${tag}" is not a ${prefix}X.Y.Z tag`,
      detail: `Release tags look like ${prefix}1.2.3 or ${prefix}1.2.3-rc.1.`,
    });
    return { problems, notes };
  }
  const version = parsed.version;
  const versionFile = config.project?.versionFile ?? "package.json";

  for (const rule of config.policy?.rules ?? []) {
    switch (rule.kind) {
      case "version-matches-tag": {
        const current = readRootVersion(readFile, versionFile);
        if (current === null) add(rule, `${versionFile} is missing or declares no version`);
        else if (current !== version)
          add(rule, `${versionFile} says ${current}; ${tag} says ${version}`);
        else notes.push(`${rule.id}: ${versionFile} says ${version}, which is ${tag}`);
        break;
      }

      case "version-copies-match": {
        const result = checkVersionCopies({ config, version, readFile });
        for (const detail of result.problems) add(rule, detail);
        if (result.problems.length === 0) {
          notes.push(
            result.checked.length === 0
              ? `${rule.id}: this project keeps no copies of the version`
              : `${rule.id}: ${result.checked.length} version cop(ies) agree with ${version}`,
          );
        }
        break;
      }

      case "no-prerelease-to-public": {
        const channels = rule.channels ?? [];
        if (parsed.prerelease === null) {
          notes.push(`${rule.id}: ${tag} is not a prerelease`);
        } else if (channels.length === 0) {
          notes.push(`${rule.id}: no channel of this project distributes publicly`);
        } else {
          add(
            rule,
            `${tag} is a prerelease (-${parsed.prerelease}) and these channels reach people who did ` +
              `not ask for one: ${labelsOf(config, channels)}`,
          );
        }
        break;
      }

      case "credential-set-complete": {
        const secrets = rule.secrets ?? [];
        const channel = channelOf(config, rule.channelId);
        if (secretsPresent === null) {
          notes.push(
            `${rule.id}: NOT EVALUATED — repo secrets are not visible from here. The release ` +
              "workflow sets RELEASE_SECRETS_PRESENT from its own secret context; a local run cannot.",
          );
        } else {
          const present = secrets.filter((name) => secretsPresent.has(name));
          const missing = secrets.filter((name) => !secretsPresent.has(name));
          if (present.length > 0 && missing.length > 0) {
            add(
              rule,
              `${channel.label}: ${present.join(", ")} set but ${missing.join(", ")} missing. ` +
                "Half a credential set is the shape that builds something and publishes nothing.",
            );
          } else if (missing.length === 0 && secrets.length > 0) {
            notes.push(`${rule.id}: ${channel.label} has all ${secrets.length} of its credentials`);
          } else {
            const consequence = ABSENT_IN_WORDS[channel.absent] ?? "the channel does not publish";
            notes.push(
              `${rule.id}: ${channel.label} has none of its credentials, so ${consequence}`,
            );
          }
        }
        break;
      }

      case "no-unsigned-publish": {
        const signing = rule.signingSecrets ?? [];
        const channel = channelOf(config, rule.channelId);
        if (secretsPresent === null) {
          notes.push(
            `${rule.id}: NOT EVALUATED — repo secrets are not visible from here, so whether ` +
              `${channel.label} can sign is unknown. The release workflow evaluates it.`,
          );
        } else {
          const missing = signing.filter((name) => !secretsPresent.has(name));
          // The credentials that make the channel UPLOAD, as opposed to
          // the ones that make it sign. With none of them set, nothing
          // leaves the run and there is nothing to refuse — which is the
          // state every project is in before its stores are set up. Only
          // the combination "can upload, cannot sign" ships an unsigned
          // artifact, and that is the one this rule exists to stop.
          const uploadSecrets = (channel.credentials ?? []).filter(
            (name) => !signing.includes(name),
          );
          const wouldUpload =
            uploadSecrets.length > 0 && uploadSecrets.every((name) => secretsPresent.has(name));

          if (missing.length === 0) {
            notes.push(`${rule.id}: ${channel.label} can sign what it publishes`);
          } else if (!channel.publicDistribution) {
            notes.push(
              `${rule.id}: ${channel.label} cannot sign (${missing.join(", ")}), but it does not publish publicly`,
            );
          } else if (wouldUpload) {
            add(
              rule,
              `${channel.label} has its upload credentials (${uploadSecrets.join(", ")}) but cannot ` +
                `sign: ${missing.join(", ")} missing. That combination uploads an unsigned artifact.`,
            );
          } else {
            const consequence = ABSENT_IN_WORDS[channel.absent] ?? "the channel does not publish";
            notes.push(
              `${rule.id}: ${channel.label} cannot sign (${missing.join(", ")}) and has no upload ` +
                `credentials either, so ${consequence}`,
            );
          }
        }
        break;
      }

      case "tag-is-new": {
        // The tag itself is excluded: in CI this runs AT the tag, where the
        // tag necessarily exists. The question is whether anything else is
        // already at or above it.
        const others = known.filter((name) => name !== tag);
        const newest = others
          .map((name) => ({ name, parsed: parseTag(name, prefix) }))
          .filter((row) => row.parsed !== null)
          .sort((a, b) => compareVersions(a.parsed.version, b.parsed.version))
          .at(-1);
        if (!newest) notes.push(`${rule.id}: ${tag} is the first release`);
        else if (compareVersions(version, newest.parsed.version) > 0) {
          notes.push(`${rule.id}: ${tag} is newer than ${newest.name}`);
        } else {
          add(rule, `${tag} is not newer than the existing tag ${newest.name}`);
        }
        break;
      }

      case "release-record": {
        if (parsed.prerelease !== null) {
          notes.push(
            `${rule.id}: not checked for a prerelease; the written record is the stable tag's`,
          );
          break;
        }
        const text = readFile(rule.path);
        if (text === null) {
          add(rule, `${rule.path} does not exist; write the record of what changed before tagging`);
          break;
        }
        // `__VERSION__` rather than `{version}`: the pattern is a regex
        // source, and braces there are quantifier syntax.
        const source = withVersion(rule.headingPattern, version);
        let heading;
        try {
          heading = new RegExp(source, "m");
        } catch {
          add(rule, `the rule's headingPattern (${rule.headingPattern}) is not a valid regex`);
          break;
        }
        if (heading.test(text)) notes.push(`${rule.id}: ${rule.path} has a heading for ${version}`);
        else add(rule, `${rule.path} has no heading matching ${heading} for ${version}`);
        break;
      }

      default:
        // Not a silent pass: an unreadable rule means these scripts are
        // older than the config, and the release is unchecked either way.
        problems.push({
          ruleId: rule.id ?? "unknown-rule",
          severity: warnOnly.has(rule.id) ? "warn" : "error",
          message: `the policy rule "${rule.id ?? "?"}" is of a kind these scripts do not understand`,
          detail: `kind "${rule.kind}" is unknown here; run \`hatchkit update\` to refresh scripts/.`,
        });
    }
  }

  if ((config.policy?.rules ?? []).length === 0) {
    notes.push("no policy rules are configured for this project");
  }
  return { problems, notes };
}
