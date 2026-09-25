/*
 * cli/src/features/release/policy-rules.ts — derives the policy rules
 * that a project's release must satisfy.
 *
 * The policy exists to refuse the combinations that are known to ship
 * something wrong. Each rule below corresponds to a way a release has
 * actually gone bad, and each is refused before a tag exists rather than
 * after an upload:
 *
 *   · the version and the tag disagree, so the app reports a version
 *     nobody can find a changelog for;
 *   · a copy of the version drifted, so one surface reports a different
 *     version from the rest and nothing fails anywhere;
 *   · a prerelease tag reaches a store, so people who never asked for a
 *     beta get one, and the store's review queue holds it for days;
 *   · half a credential set is present, which builds an artifact and
 *     then either drops it silently or uploads it unsigned, depending on
 *     which half is missing;
 *   · a signing key is absent and the artifact would be published
 *     anyway, which is the one outcome no channel may have.
 *
 * Derivation is over the project's OWN channels, so a project with a web
 * deploy and nothing else gets three rules and no mention of stores. The
 * evaluator that applies these lives in the emitted
 * `scripts/lib/release-policy.mjs`; this file only decides which rules
 * are in force and what each one says when it fires.
 */

import { signingSecretsFor } from "./credentials.js";
import type {
  CredentialGroup,
  PolicyRule,
  ReleaseChannel,
  ReleaseDerivationInput,
  ReleasePolicy,
} from "./types.js";

/** Files that count as the written record of what changed, in the order
 *  they are preferred. The rule is only added when one exists — a
 *  project without a changelog is not made to invent one. */
const RELEASE_RECORD_CANDIDATES = ["CHANGELOG.md", "docs/CHANGELOG.md", "CHANGES.md"] as const;

/** Matches a heading naming a specific version: `## 1.2.3`, `## [1.2.3]`,
 *  `## v1.2.3 - 2026-01-01`. The emitted evaluator substitutes the
 *  version for `__VERSION__` before compiling, so the pattern travels as
 *  a literal and needs no escaping at either end. */
const RELEASE_RECORD_HEADING = String.raw`^#{1,3}\s*\[?v?__VERSION__\]?(\s|$|\])`;

export function derivePolicy(
  input: ReleaseDerivationInput,
  channels: readonly ReleaseChannel[],
  credentials: readonly CredentialGroup[],
): ReleasePolicy {
  const rules: PolicyRule[] = [];

  // ── Rules every project gets ─────────────────────────────────────────
  // These three need no surface at all. A project with only a web deploy
  // still gets a release whose version, copies and tag agree.

  rules.push({
    id: "version-matches-tag",
    kind: "version-matches-tag",
    message:
      `The version in ${input.name === "" ? "package.json" : "package.json"} must equal the tag without its prefix. ` +
      "A tag that names a different version ships an app that reports one number and a changelog that documents another.",
  });

  rules.push({
    id: "version-copies-match",
    kind: "version-copies-match",
    message:
      "Every copy of the version must equal the root version. A copy that drifted ships one surface " +
      "reporting a different version from the rest, and nothing else fails anywhere.",
  });

  rules.push({
    id: "tag-is-new",
    kind: "tag-is-new",
    message:
      "The tag must be newer than the newest existing release tag. Re-tagging a released version gives two " +
      "different artifacts the same name, and the channels that already published the first one will not " +
      "replace it.",
  });

  // ── Prerelease containment ───────────────────────────────────────────
  // Only meaningful once something reaches people who did not opt in.

  // Only channels a tag can actually reach. A branch-deployed site
  // distributes publicly, but a prerelease tag never starts it, so
  // naming it in this refusal would be false.
  const publicChannels = channels.filter(
    (channel) => channel.publicDistribution && channel.trigger !== "branch",
  );
  if (publicChannels.length > 0) {
    rules.push({
      id: "no-prerelease-to-public",
      kind: "no-prerelease-to-public",
      channels: publicChannels.map((channel) => channel.id),
      message:
        `A prerelease tag must not reach ${listPhrase(publicChannels.map((channel) => channel.label))}. ` +
        "Those channels reach people who did not ask for a prerelease. Cut a stable tag, or disable the " +
        "channel for this release.",
    });
  }

  // ── Credential sets ──────────────────────────────────────────────────
  // A set of one cannot be half-present, so those produce no rule.

  for (const group of credentials) {
    if (group.secrets.length < 2) continue;
    rules.push({
      id: `credential-set-complete:${group.channelId}`,
      kind: "credential-set-complete",
      channelId: group.channelId,
      secrets: group.secrets.map((secret) => secret.name),
      message:
        `${group.label}: set all of these repo secrets or none of them. ` +
        `A partial set ${absentPhrase(group.absent)}, and the run still reports success.`,
    });
  }

  // ── Unsigned publishing ──────────────────────────────────────────────
  // The rule that has no acceptable failure mode.

  for (const channel of channels) {
    if (!channel.publicDistribution) continue;
    const signing = signingSecretsFor(channel.id).filter((name) =>
      channel.credentials.includes(name),
    );
    if (signing.length === 0) continue;
    rules.push({
      id: `no-unsigned-publish:${channel.id}`,
      kind: "no-unsigned-publish",
      channelId: channel.id,
      signingSecrets: signing,
      message:
        `${channel.label} publishes to people, so it must not publish an unsigned artifact. ` +
        "Configure its signing secrets, or let the channel build without uploading.",
    });
  }

  // ── The written record ───────────────────────────────────────────────

  const recordPath = RELEASE_RECORD_CANDIDATES.find((candidate) => input.exists(candidate));
  if (recordPath) {
    rules.push({
      id: "release-record",
      kind: "release-record",
      path: recordPath,
      headingPattern: RELEASE_RECORD_HEADING,
      message:
        `${recordPath} must have a heading for this version. It is what someone deciding whether to ` +
        "upgrade reads, and it is the only part of a release a tool cannot write for you.",
    });
  }

  return { rules, warnOnly: [] };
}

/** "the Chrome Web Store, the Firefox add-on listing and Google Play" —
 *  a list a sentence can contain, rather than a bracketed array. */
function listPhrase(items: readonly string[]): string {
  if (items.length === 0) return "any public channel";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What a half-present credential set actually causes, in a clause that
 *  fits after "A partial set". Never says "publishes quietly", because
 *  no channel is allowed to. */
function absentPhrase(absent: CredentialGroup["absent"]): string {
  switch (absent) {
    case "skip":
      return "builds the artifact and then uploads nothing";
    case "unsigned":
      return "builds an artifact nobody can install and uploads nothing";
    case "fail":
      return "fails the run partway through";
  }
}
