#!/usr/bin/env node
/**
 * Fails a release that is not what its tag claims, before anything is built.
 *
 *   node scripts/release-policy-check.mjs vX.Y.Z [ref]
 *
 * Reads the release exactly as it will be tagged — every file through
 * `git show <ref>:<path>`, default `HEAD` — and evaluates the rules in
 * `.hatchkit-release.json` (`scripts/lib/release-policy.mjs`). `release.mjs`
 * runs it against the commit it is about to create, and the release workflow
 * runs it again at the tag before the first build starts, so a mismatch
 * costs nothing both times.
 *
 * Needs the full history and tags (`fetch-depth: 0`) to see what was
 * released before this. Reads only; changes nothing, anywhere.
 *
 * RELEASE_SECRETS_PRESENT
 *   A comma-separated list of the repo secret names that are configured.
 *   Only a workflow can know it — it is built from that workflow's own
 *   `secrets` context — and only the credential rules use it. When the
 *   variable is UNSET those rules are reported as not evaluated rather than
 *   passed, because a rule that silently passes unevaluated is the exact
 *   failure this check exists to prevent. Set it to the empty string to say
 *   "evaluated, and none are configured".
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadReleaseConfig } from "./lib/release-config.mjs";
import { evaluatePolicy } from "./lib/release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const inActions = process.env.GITHUB_ACTIONS === "true";
const error = (text) =>
  console.error(inActions ? `::error::${text.replace(/\n/g, "%0A")}` : `ERROR: ${text}`);
const warn = (text) =>
  console.error(inActions ? `::warning::${text.replace(/\n/g, "%0A")}` : `WARN: ${text}`);
const notice = (text) => console.log(inActions ? `::notice::${text}` : text);

const git = (...args) =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

const [tag, ref = "HEAD"] = process.argv.slice(2);
if (!tag || tag.startsWith("--")) {
  error("usage: node scripts/release-policy-check.mjs vX.Y.Z [ref]");
  process.exit(2);
}

/** A file as it is at `ref`, or null when it is not in that tree. */
const readAtRef = (path) => {
  try {
    return git("show", `${ref}:${path}`);
  } catch {
    return null;
  }
};

/** The configured secret names, or null when this run cannot know them. */
const secretsPresent =
  process.env.RELEASE_SECRETS_PRESENT === undefined
    ? null
    : new Set(
        process.env.RELEASE_SECRETS_PRESENT.split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );

try {
  const config = loadReleaseConfig(ROOT);
  const tags = git("tag", "-l").split("\n").filter(Boolean);
  const result = evaluatePolicy({ config, tag, tags, readFile: readAtRef, secretsPresent });

  console.log(`Release policy: ${tag} at ${ref}, ${config.policy.rules.length} rule(s)`);
  for (const note of result.notes) console.log(`  ${note}`);

  const errors = result.problems.filter((problem) => problem.severity !== "warn");
  for (const problem of result.problems) {
    const text = `${problem.ruleId}: ${problem.message}${problem.detail ? `\n  ${problem.detail}` : ""}`;
    if (problem.severity === "warn") warn(text);
    else error(text);
  }
  if (errors.length > 0) {
    error(
      `${tag} does not follow this project's release policy; nothing should be published from it.`,
    );
    process.exit(1);
  }
  notice(`${tag} follows the release policy.`);
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
