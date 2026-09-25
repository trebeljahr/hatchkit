#!/usr/bin/env node
/**
 * Every copy of the version, against the one the project actually releases.
 *
 *   node --test scripts/release-version-sync.test.mjs
 *
 * The version lives in one file (`project.versionFile`). Everywhere else it
 * appears is a copy, listed in `.hatchkit-release.json`: an image tag, a
 * Gradle `versionName`, an Xcode `MARKETING_VERSION`, a self-host env
 * default. A copy that drifts ships a build reporting a version nobody
 * released, and nothing else in the pipeline notices — so this fails
 * instead, at the first test run after a bump that missed one.
 *
 * `versionReads` are the good cases: files asserted to READ the root
 * version rather than keep a copy of it. They are pinned here so a later
 * refactor cannot quietly turn a build-time read back into a literal.
 *
 * A project with no copies and no reads is a normal, correct project: it
 * gets the one test below and passes it. Same mechanism as the release
 * command and the policy check (`scripts/lib/release-plan.mjs`), so the
 * three can never disagree about what a copy is.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadReleaseConfig, parseVersion } from "./lib/release-config.mjs";
import { checkVersionCopies } from "./lib/release-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const read = (relative) => {
  try {
    return readFileSync(join(ROOT, relative), "utf8");
  } catch {
    return null;
  }
};

let config = null;
let configError = null;
try {
  config = loadReleaseConfig(ROOT);
} catch (caught) {
  configError = caught instanceof Error ? caught.message : String(caught);
}

/** The declared version of the root version file, or null. */
const rootVersionOf = (versionFile) => {
  const text = read(versionFile);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.version === "string") return parsed.version.trim();
  } catch {
    // Not JSON: fall back to the textual form.
  }
  return /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1]?.trim() ?? null;
};

describe("release version copies", () => {
  if (configError !== null) {
    it("the release config can be read", () => {
      assert.fail(configError);
    });
    return;
  }

  const versionFile = config.project.versionFile;
  const rootVersion = rootVersionOf(versionFile);

  it(`${versionFile} carries a semver version`, () => {
    assert.notEqual(rootVersion, null, `${versionFile}: no "version" field to release`);
    assert.notEqual(
      parseVersion(rootVersion),
      null,
      `${versionFile}: "${rootVersion}" is not an X.Y.Z version`,
    );
  });

  for (const copy of config.versionCopies) {
    it(`${copy.path} — ${copy.label} matches ${versionFile}`, () => {
      const { problems } = checkVersionCopies({
        config: { versionCopies: [copy] },
        version: rootVersion,
        readFile: read,
      });
      assert.equal(problems.length, 0, problems.join("\n"));
    });
  }

  for (const source of config.versionReads) {
    it(`${source.path} — ${source.label} still reads the version instead of copying it`, () => {
      const text = read(source.path);
      assert.notEqual(text, null, `${source.path} (${source.label}) is missing`);
      for (const pattern of source.mustMatch ?? []) {
        assert.match(
          text,
          new RegExp(pattern),
          `${source.path} (${source.label}): no match for ${pattern}`,
        );
      }
    });
  }
});
