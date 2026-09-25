import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  artifactPatterns,
  builderEnvFor,
  channelForPlatform,
  DESKTOP_TARGET_ENV,
  desktopTarget,
  expandArtifactName,
  parseTarget,
  feedProblems,
  releasePlan,
  resolveSigning,
  SIGNING_CREDENTIAL_VARS,
  SIGNING_SETS,
  tagMismatch,
  UPDATE_FEED,
  updateFeedFor,
} from "./desktop-release.mjs";

const all = (names, value = "x") => Object.fromEntries(names.map((name) => [name, value]));

describe("resolveSigning", () => {
  it("builds unsigned when no secret is set, and treats empty strings as unset", () => {
    assert.deepEqual(resolveSigning("mac", {}), { mode: "unsigned" });
    assert.deepEqual(resolveSigning("mac", all(SIGNING_SETS.mac[0], "")), { mode: "unsigned" });
    assert.deepEqual(resolveSigning("win", all(SIGNING_SETS.win[1], "  ")), { mode: "unsigned" });
  });

  it("signs with a complete set", () => {
    assert.equal(resolveSigning("mac", all(SIGNING_SETS.mac[0])).mode, "signed");
    assert.deepEqual(resolveSigning("win", all(SIGNING_SETS.win[0])).set, SIGNING_SETS.win[0]);
    assert.deepEqual(resolveSigning("win", all(SIGNING_SETS.win[1])).set, SIGNING_SETS.win[1]);
  });

  it("refuses a partial set and names what is missing", () => {
    assert.throws(
      () => resolveSigning("mac", { CSC_LINK: "x", CSC_KEY_PASSWORD: "y" }),
      /Missing: APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER/,
    );
    assert.throws(() => resolveSigning("win", { AZURE_TENANT_ID: "t" }), /AZURE_CLIENT_ID/);
  });

  it("does not start signing from the credentials the iOS release shares", () => {
    assert.deepEqual(
      resolveSigning("mac", { APPLE_API_KEY: "k", APPLE_API_KEY_ID: "i", APPLE_API_ISSUER: "s" }),
      { mode: "unsigned" },
    );
  });

  it("refuses two complete Windows configurations", () => {
    assert.throws(
      () => resolveSigning("win", { ...all(SIGNING_SETS.win[0]), ...all(SIGNING_SETS.win[1]) }),
      /Two complete/,
    );
  });

  it("refuses a partial set even when another set is complete", () => {
    assert.throws(
      () => resolveSigning("win", { ...all(SIGNING_SETS.win[0]), AZURE_TENANT_ID: "t" }),
      /incomplete/,
    );
  });

  it("has nothing to sign on Linux", () => {
    assert.deepEqual(resolveSigning("linux", { CSC_LINK: "x" }), { mode: "unsigned" });
  });

  it("rejects an unknown channel", () => {
    assert.throws(() => resolveSigning("tauri", {}), /Unknown desktop channel/);
  });
});

describe("channelForPlatform", () => {
  it("reads the platform flag build-desktop.mjs was given", () => {
    assert.equal(channelForPlatform(["--package", "--mac", "--arm64"]), "mac");
    assert.equal(channelForPlatform(["--package", "--win", "--x64"]), "win");
    assert.equal(channelForPlatform(["--package", "--linux", "--arm64"]), "linux");
  });

  it("is null for a build that names no platform or two", () => {
    assert.equal(channelForPlatform(["--package", "--dir"]), null);
    assert.equal(channelForPlatform(["--mac", "--win"]), null);
  });
});

describe("desktopTarget", () => {
  it("names the channel, and says when nothing signed the build", () => {
    assert.equal(desktopTarget("mac", "signed"), "mac");
    assert.equal(desktopTarget("mac", "unsigned"), "mac-unsigned");
    assert.equal(desktopTarget("win", "unsigned"), "win-unsigned");
    // Nothing on Linux is signed, so a suffix on every Linux build says nothing.
    assert.equal(desktopTarget("linux", "unsigned"), "linux");
    assert.equal(desktopTarget(null, "unsigned"), "local");
  });

  it("reads back what it wrote", () => {
    for (const [channel, mode, unsigned] of [
      ["mac", "signed", false],
      ["mac", "unsigned", true],
      ["win", "signed", false],
      ["linux", "unsigned", false],
    ]) {
      assert.deepEqual(parseTarget(desktopTarget(channel, mode)), { channel, unsigned }, channel);
    }
    assert.deepEqual(parseTarget("local"), { channel: null, unsigned: false });
    assert.deepEqual(parseTarget(undefined), { channel: null, unsigned: false });
  });
});

describe("builderEnvFor", () => {
  it("marks an unsigned build and turns keychain discovery off", () => {
    const env = builderEnvFor("mac", { PATH: "/bin" }, { mode: "unsigned" });
    assert.equal(env[DESKTOP_TARGET_ENV], "mac-unsigned");
    assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    assert.equal(env.PATH, "/bin");
  });

  it("never inherits the unsigned marker into a signed build", () => {
    const env = builderEnvFor("mac", { [DESKTOP_TARGET_ENV]: "mac-unsigned" }, { mode: "signed", set: [] });
    assert.equal(env[DESKTOP_TARGET_ENV], "mac");
    // A named certificate must not fall back to whatever the keychain holds.
    assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  });

  it("strips every credential electron-builder would sign with on its own", () => {
    // WIN_CSC_LINK falls back to CSC_LINK in electron-builder, so a Developer ID
    // p12 in the shell would otherwise sign a Windows build named -unsigned.
    const signing = resolveSigning("win", { CSC_LINK: "x" });
    const env = builderEnvFor("win", { ...all(SIGNING_CREDENTIAL_VARS), KEEP: "1" }, signing);
    for (const name of SIGNING_CREDENTIAL_VARS) assert.equal(env[name], undefined, name);
    assert.equal(env.KEEP, "1");
    assert.equal(env[DESKTOP_TARGET_ENV], "win-unsigned");
  });

  it("keeps the credentials of a signed build", () => {
    const signing = resolveSigning("win", all(SIGNING_SETS.win[0]));
    const env = builderEnvFor("win", all(SIGNING_SETS.win[0]), signing);
    for (const name of SIGNING_SETS.win[0]) assert.equal(env[name], "x", name);
  });
});

describe("artifact names", () => {
  it("says -unsigned in every name a person might download", () => {
    const patterns = artifactPatterns("mac-unsigned");
    for (const key of ["dmg", "zip", "nsis"]) assert.match(patterns[key], /-unsigned\./, key);
    assert.doesNotMatch(artifactPatterns("mac").dmg, /unsigned/);
    // Nothing on Linux is signed, so no Linux name carries the suffix either.
    assert.doesNotMatch(artifactPatterns("linux").linux, /unsigned/);
  });

  it("carries no space, which the updater's GitHub provider would turn into a dash", () => {
    for (const target of ["mac", "mac-unsigned", "win", "win-unsigned", "linux"]) {
      for (const [key, pattern] of Object.entries(artifactPatterns(target))) {
        assert.doesNotMatch(pattern, / /, `${target} ${key}`);
      }
    }
  });

  it("expands like electron-builder and refuses a missing value", () => {
    const { dmg } = artifactPatterns("mac");
    const values = { name: "my-app", version: "0.1.0", arch: "arm64", ext: "dmg" };
    assert.equal(expandArtifactName(dmg, values), "my-app-0.1.0-mac-arm64.dmg");
    assert.throws(() => expandArtifactName(dmg, { name: "my-app" }), /No value for \$\{version\}/);
  });
});

describe("tagMismatch", () => {
  it("only checks tag runs", () => {
    assert.equal(tagMismatch({ refType: "branch", refName: "main", version: "0.1.0" }), null);
    assert.equal(tagMismatch({ refType: "tag", refName: "v0.1.0", version: "0.1.0" }), null);
    assert.match(
      tagMismatch({ refType: "tag", refName: "v0.2.0", version: "0.1.0" }),
      /expected v0.1.0/,
    );
  });
});

describe("updateFeedFor", () => {
  it("gives signed direct downloads and every Linux build a GitHub feed", () => {
    assert.equal(updateFeedFor("mac"), UPDATE_FEED);
    assert.equal(updateFeedFor("win"), UPDATE_FEED);
    assert.equal(updateFeedFor("linux"), UPDATE_FEED);
    assert.equal(UPDATE_FEED.releaseType, "draft");
  });

  it("is null, not undefined, for everything else", () => {
    // Undefined would let electron-builder guess a GitHub feed from the
    // GH_TOKEN every CI runner has.
    for (const target of ["mac-unsigned", "win-unsigned", "local", "", undefined]) {
      assert.strictEqual(updateFeedFor(target), null, JSON.stringify(target));
    }
  });
});

describe("releasePlan", () => {
  const signed = [
    {
      channel: "mac",
      mode: "signed",
      files: [
        "a/app-0.2.0-mac-arm64.dmg",
        "a/app-0.2.0-mac-arm64.zip",
        "a/app-0.2.0-mac-arm64.zip.blockmap",
        "a/latest-mac.yml",
        "a/SHA256SUMS-mac.txt",
      ],
    },
    {
      channel: "win",
      mode: "signed",
      files: ["c/app-Setup-0.2.0.exe", "c/app-Setup-0.2.0.exe.blockmap", "c/latest.yml"],
    },
    {
      channel: "linux-x64",
      mode: "unsigned",
      files: [
        "e/app-0.2.0-linux-x64.AppImage",
        "e/app_0.2.0_amd64.deb",
        "e/app_0.2.0_amd64.snap",
        "e/latest-linux.yml",
      ],
    },
  ];

  it("attaches downloads and feeds, never store packages or per-leg checksums", () => {
    const plan = releasePlan(signed);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.feeds, ["a/latest-mac.yml", "c/latest.yml", "e/latest-linux.yml"]);
    assert.equal(plan.upload.some((file) => /\.(pkg|appx|snap)$|SHA256SUMS/.test(file)), false);
    assert.ok(plan.upload.includes("e/app_0.2.0_amd64.deb"));
  });

  it("leaves unsigned mac and win files off the release page and says so", () => {
    const plan = releasePlan([
      { channel: "mac", mode: "unsigned", files: ["a/app-0.2.0-mac-arm64-unsigned.dmg"] },
      signed[2],
    ]);
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.upload.some((file) => file.includes("unsigned")), false);
    assert.match(plan.warnings[0], /mac was built unsigned/);
  });

  it("refuses a leg with a feed that did not bring it, and a release with nothing to attach", () => {
    const noFeed = releasePlan([{ ...signed[1], files: ["c/app-Setup-0.2.0.exe"] }]);
    assert.match(noFeed.problems[0], /win leg has no latest\.yml/);
    const empty = releasePlan([{ channel: "linux-x64", mode: "unsigned", files: ["e/x.snap"] }]);
    assert.match(empty.problems.at(-1), /Nothing to attach/);
  });
});

describe("feedProblems", () => {
  const attached = new Map([["app-0.2.0-mac-arm64.zip", { sha512: "abc", size: 10 }]]);

  it("accepts a feed whose files are attached with matching checksums", () => {
    const feed = { files: [{ url: "app-0.2.0-mac-arm64.zip", sha512: "abc", size: 10 }] };
    assert.deepEqual(feedProblems([{ name: "latest-mac.yml", feed }], attached), []);
  });

  it("names a missing file, a checksum and a size mismatch, and an empty feed", () => {
    const problems = feedProblems(
      [
        {
          name: "latest-mac.yml",
          feed: { files: [{ url: "app-0.2.0-mac-x64.zip", sha512: "abc" }] },
        },
        {
          name: "latest-mac.yml",
          feed: { files: [{ url: "app-0.2.0-mac-arm64.zip", sha512: "zzz" }] },
        },
        {
          name: "latest-mac.yml",
          feed: { files: [{ url: "app-0.2.0-mac-arm64.zip", sha512: "abc", size: 11 }] },
        },
        { name: "latest.yml", feed: {} },
      ],
      attached,
    );
    assert.equal(problems.length, 4);
    assert.match(problems[0], /not attached/);
    assert.match(problems[1], /sha512/);
    assert.match(problems[2], /size/);
    assert.match(problems[3], /no files/);
  });
});
