/**
 * Release-feature derivation: does a project get exactly the channels,
 * version copies, credentials and policy rules its own surfaces imply?
 *
 * The whole feature rests on one property: it degrades cleanly. A
 * project with only a web deploy must get a small, correct, useful
 * result, and each extra surface must add its own rows and nothing
 * else. Nothing may assume a surface the project did not enable.
 *
 * So the bulk of this file is the same derivation run over a ladder of
 * projects, asserting at each rung that what appeared is what that rung
 * added — and, just as importantly, that nothing appeared for a surface
 * the project does not have.
 *
 * Every input here is a plain object. No temp directory, no git, no
 * network: `exists` / `list` / `read` are the only doors to a
 * filesystem, and these tests close them.
 *
 * Run: pnpm --filter hatchkit test:release-channels
 */

import { buildReleaseConfig } from "./src/features/release/config.js";
import { deriveChannels } from "./src/features/release/channels.js";
import { deriveCredentials, signingSecretsFor } from "./src/features/release/credentials.js";
import { derivePolicy } from "./src/features/release/policy-rules.js";
import type { ReleaseConfig, ReleaseDerivationInput } from "./src/features/release/types.js";
import { deriveVersionCopies } from "./src/features/release/version-targets.js";
import { legacyIdentifiers } from "./src/scaffold/identifiers.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

/** A project as a bag of files, turned into the input the derivation
 *  takes. Anything not listed does not exist. */
function project(
  facts: Partial<ReleaseDerivationInput> & { name?: string },
  files: Record<string, string> = {},
): ReleaseDerivationInput {
  const paths = new Set(Object.keys(files));
  const name = facts.name ?? "demo";
  return {
    name,
    // The frozen identifier set, exactly as a real project supplies it:
    // the release surfaces read `envPrefix` and `slug` from here rather
    // than deriving a second spelling of the project's own names.
    identifiers: facts.identifiers ?? legacyIdentifiers(name),
    features: facts.features ?? [],
    surfaces: facts.surfaces,
    deploymentMode: facts.deploymentMode,
    signing: facts.signing,
    exists: (relative) => paths.has(relative),
    list: (relative) => {
      const prefix = relative.endsWith("/") ? relative : `${relative}/`;
      const seen = new Set<string>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const next = path.slice(prefix.length).split("/")[0];
        if (next) seen.add(next);
      }
      return [...seen];
    },
    read: (relative) => files[relative] ?? null,
  };
}

const PKG = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "demo", version: "1.2.3", private: true, ...extra }, null, 2);

const BASE_FILES: Record<string, string> = {
  "package.json": PKG(),
  "pnpm-lock.yaml": "",
  "docker-compose.yml": "services:\n  server:\n    image: x\n",
  Dockerfile: "FROM node:24\n",
};

const ids = (config: ReleaseConfig) => config.channels.map((channel) => channel.id);
const ruleIds = (config: ReleaseConfig) => config.policy.rules.map((rule) => rule.id);

// ─────────────────────────────────────────────────────────────────────
section("A project with only a web deploy");
// ─────────────────────────────────────────────────────────────────────

const webOnly = buildReleaseConfig(
  project({ surfaces: "fullstack" }, BASE_FILES),
  { cliVersion: "0.0.0-test", generatedAt: "2026-01-01T00:00:00.000Z" },
);

assert(webOnly.channels.length > 0, "web-only project gets at least one channel");
assert(ids(webOnly).includes("web"), "web-only project has the web channel");
for (const absent of ["desktop-electron", "mobile", "extension-chrome", "extension-firefox"]) {
  assert(!ids(webOnly).includes(absent), `web-only project has no ${absent} channel`);
}
assert(
  webOnly.credentials.every((group) => ids(webOnly).includes(group.channelId)),
  "every credential group names a channel this project has",
);
assert(
  webOnly.policy.rules.length >= 3,
  "web-only project still gets the version/tag rules that apply to everything",
);
for (const required of ["version-matches-tag", "version-copies-match", "tag-is-new"]) {
  assert(ruleIds(webOnly).includes(required), `web-only project has the ${required} rule`);
}
assert(
  !ruleIds(webOnly).some((id) => id.startsWith("no-unsigned-publish")),
  "web-only project gets no unsigned-publish rule — it signs nothing",
);
assert(webOnly.compat === null, "web-only project gets no compat workflow — no detached client");
assert(
  webOnly.project.packageManager === "pnpm",
  "package manager comes from the lockfile on disk",
);

// ─────────────────────────────────────────────────────────────────────
section("A static project deployed to GitHub Pages");
// ─────────────────────────────────────────────────────────────────────

const pages = buildReleaseConfig(
  project(
    { surfaces: "static", deploymentMode: "gh-pages" },
    { "package.json": PKG(), "pnpm-lock.yaml": "", ".github/workflows/gh-pages.yml": "name: x\n" },
  ),
);
assert(ids(pages).includes("web"), "a Pages project still has a web channel");
assert(
  pages.channels.find((channel) => channel.id === "web")?.trigger === "branch",
  "a branch-deployed site is not started by a tag, and says so",
);
assert(
  !pages.policy.rules.some((rule) => rule.id === "no-prerelease-to-public"),
  "a project whose only public channel is branch-deployed gets no prerelease rule — a tag cannot reach it",
);
assert(
  !ids(pages).includes("container"),
  "a static project gets no container channel — there is no server to image",
);
assert(pages.compat === null, "a static project gets no compat workflow");
assert(
  pages.channels.every((channel) => channel.workflowFile.endsWith(".yml")),
  "every channel names a workflow file",
);

// ─────────────────────────────────────────────────────────────────────
section("scaffold-only: nothing ships from a tag");
// ─────────────────────────────────────────────────────────────────────

const scaffoldOnly = buildReleaseConfig(
  project({ surfaces: "static", deploymentMode: "scaffold-only" }, { "package.json": PKG() }),
);
assert(!ids(scaffoldOnly).includes("web"), "scaffold-only gets no web channel");
assert(
  scaffoldOnly.credentials.length === 0,
  "scaffold-only needs no credentials",
);
assert(
  scaffoldOnly.policy.rules.length >= 3,
  "scaffold-only still gets the universal rules, so a version bump stays honest",
);

// ─────────────────────────────────────────────────────────────────────
section("Adding a desktop app adds exactly its own rows");
// ─────────────────────────────────────────────────────────────────────

const desktopFiles = { ...BASE_FILES, electron: "", "build/": "" };
const desktop = buildReleaseConfig(
  project({ surfaces: "fullstack", features: ["desktop"] }, desktopFiles),
);
assert(ids(desktop).includes("desktop-electron"), "the desktop feature adds the Electron channel");
assert(!ids(desktop).includes("mobile"), "the desktop feature does not add a mobile channel");

const desktopAdded = ids(desktop).filter((id) => !ids(webOnly).includes(id));
assert(
  desktopAdded.length === 1 && desktopAdded[0] === "desktop-electron",
  `adding desktop adds exactly one channel (got ${desktopAdded.join(", ") || "none"})`,
);

const electron = desktop.channels.find((channel) => channel.id === "desktop-electron");
assert(electron?.gate !== null && electron?.gate !== undefined, "the desktop channel has a gate — a draft is not a release");
assert((electron?.effect.length ?? 0) > 20, "the desktop channel says what it does in a sentence");

// ─────────────────────────────────────────────────────────────────────
section("Signing changes what absence means, not whether it is allowed");
// ─────────────────────────────────────────────────────────────────────

const signedDesktop = buildReleaseConfig(
  project(
    {
      surfaces: "fullstack",
      features: ["desktop"],
      signing: { enabled: true, platforms: ["windows"] },
    },
    desktopFiles,
  ),
);
const signedElectron = signedDesktop.channels.find((c) => c.id === "desktop-electron");
assert(
  signedElectron?.credentials.some((name) => name.startsWith("AZURE_")),
  "a Windows-signing project's desktop channel needs the Azure secrets",
);
assert(
  signedElectron?.absent === "unsigned",
  "with signing configured, missing credentials mean an unsigned build, not a silent publish",
);
assert(
  signedDesktop.policy.rules.some((rule) => rule.id === "no-unsigned-publish:desktop-electron"),
  "a signing desktop channel gets the unsigned-publish refusal",
);
assert(
  desktop.channels
    .find((c) => c.id === "desktop-electron")
    ?.credentials.every((name) => !name.startsWith("AZURE_")) ?? false,
  "without signing configured, the desktop channel does not claim to need Azure secrets",
);

// A desktop build always has a macOS leg, and an unsigned macOS bundle
// is one Gatekeeper refuses to open. The credential list has to say so
// whether or not the project opted into Windows signing.
for (const [label, config] of [
  ["unsigned", desktop],
  ["windows-signed", signedDesktop],
] as const) {
  const channel = config.channels.find((entry) => entry.id === "desktop-electron");
  assert(
    channel?.credentials.some((name) => name.startsWith("APPLE_DEVELOPER_ID_")),
    `${label}: the desktop channel names the macOS Developer ID secrets its workflow reads`,
  );
  assert(
    channel?.absent === "unsigned",
    `${label}: a desktop build without a Developer ID certificate is unsigned, not merely unuploaded`,
  );
  assert(
    signingSecretsFor("desktop-electron").some((name) => name.startsWith("APPLE_DEVELOPER_ID_")),
    `${label}: the macOS certificate counts as signing, not as an upload key`,
  );
  assert(
    !signingSecretsFor("desktop-electron").some((name) => name.startsWith("ITCH_")),
    `${label}: a missing itch key is a skipped push, not an unsigned artifact`,
  );
}

// ─────────────────────────────────────────────────────────────────────
section("Phone stores");
// ─────────────────────────────────────────────────────────────────────

const mobile = buildReleaseConfig(
  project(
    {
      surfaces: "fullstack",
      features: ["mobile"],
      signing: { enabled: true, platforms: ["ios", "android"] },
    },
    {
      ...BASE_FILES,
      "android/app/build.gradle": 'android {\n  versionCode 7\n  versionName "1.2.3"\n}\n',
      "ios/App/App.xcodeproj/project.pbxproj":
        "MARKETING_VERSION = 1.2.3;\nCURRENT_PROJECT_VERSION = 7;\n",
    },
  ),
);
const mobileChannel = mobile.channels.find((channel) => channel.id === "mobile");
assert(mobileChannel !== undefined, "the mobile feature adds a mobile channel");
assert(
  mobileChannel?.absent === "unsigned",
  "a phone build without a signing key must not be uploaded",
);
assert(
  (mobileChannel?.uploadSteps.length ?? 0) >= 2,
  "the mobile channel reports on both store uploads",
);
assert(
  signingSecretsFor("mobile").length > 0,
  "the mobile channel has a signing subset distinct from its store keys",
);
assert(
  !signingSecretsFor("mobile").includes("PLAY_SERVICE_ACCOUNT_JSON"),
  "a missing Play API key is a skipped upload, not an unsigned artifact",
);

const mobileCopies = deriveVersionCopies(
  project(
    { features: ["mobile"] },
    {
      "package.json": PKG(),
      "android/app/build.gradle": 'android {\n  versionCode 7\n  versionName "1.2.3"\n}\n',
      "ios/App/App.xcodeproj/project.pbxproj":
        "MARKETING_VERSION = 1.2.3;\nCURRENT_PROJECT_VERSION = 7;\n",
    },
  ),
);
assert(
  mobileCopies.some((copy) => copy.path === "android/app/build.gradle" && copy.form === "semver"),
  "the Android version name is a version copy",
);
assert(
  mobileCopies.some((copy) => copy.form === "build-number"),
  "build numbers are tracked as build numbers, not compared to the semver",
);
for (const copy of mobileCopies) {
  const contents = project(
    {},
    {
      "android/app/build.gradle": 'android {\n  versionCode 7\n  versionName "1.2.3"\n}\n',
      "ios/App/App.xcodeproj/project.pbxproj":
        "MARKETING_VERSION = 1.2.3;\nCURRENT_PROJECT_VERSION = 7;\n",
      "package.json": PKG(),
    },
  ).read(copy.path);
  const matches = contents === null ? [] : [...contents.matchAll(new RegExp(copy.pattern, copy.flags))];
  assert(matches.length > 0, `${copy.label}: the derived pattern matches the real file`);
}

// ─────────────────────────────────────────────────────────────────────
section("Extension stores come from disk, not from the manifest");
// ─────────────────────────────────────────────────────────────────────

const extension = buildReleaseConfig(
  project(
    { surfaces: "fullstack" },
    { ...BASE_FILES, "packages/extension/manifest.config.ts": "export const x = 1;\n" },
  ),
);
assert(ids(extension).includes("extension-chrome"), "an extension package adds the Chrome channel");
assert(ids(extension).includes("extension-firefox"), "an extension package adds the Firefox channel");
assert(
  !ids(webOnly).includes("extension-chrome"),
  "a project without an extension package gets no extension channel",
);
const chrome = extension.channels.find((channel) => channel.id === "extension-chrome");
const firefox = extension.channels.find((channel) => channel.id === "extension-firefox");
assert(
  chrome?.workflowFile === firefox?.workflowFile,
  "the two stores share one workflow file, and the config says so",
);
assert(
  chrome?.credentials.join() !== firefox?.credentials.join(),
  "the two stores need different credentials",
);

// ─────────────────────────────────────────────────────────────────────
section("A publishable package gets a package channel; a private one does not");
// ─────────────────────────────────────────────────────────────────────

const publicPkg = buildReleaseConfig(
  project({ surfaces: "backend" }, { ...BASE_FILES, "package.json": PKG({ private: false }) }),
);
assert(ids(publicPkg).includes("package"), "a public package.json gets the package channel");
assert(!ids(webOnly).includes("package"), "a private package.json gets no package channel");

// ─────────────────────────────────────────────────────────────────────
section("Everything at once");
// ─────────────────────────────────────────────────────────────────────

const everything = buildReleaseConfig(
  project(
    {
      surfaces: "split",
      features: ["desktop", "mobile", "s3", "websocket"],
      signing: { enabled: true, platforms: ["windows", "ios", "android"] },
    },
    {
      ...BASE_FILES,
      "package.json": PKG({ private: false }),
      "docker-compose.selfhost.yml": "services:\n  server:\n    image: ${DEMO_VERSION:-v1.2.3}\n",
      "packages/server/Dockerfile": "FROM node:24\n",
      "packages/extension/manifest.config.ts": "export const x = 1;\n",
      "packages/shared/src/compat/run.ts": "export {};\n",
      "android/app/build.gradle": 'android {\n  versionCode 7\n  versionName "1.2.3"\n}\n',
      electron: "",
      "CHANGELOG.md": "# Changelog\n\n## 1.2.3\n",
    },
  ),
);

assert(everything.channels.length >= 6, `everything-project has every channel (${everything.channels.length})`);
assert(everything.compat !== null, "a self-hostable server plus a detached client gets a compat workflow");
assert(
  new Set(ids(everything)).size === ids(everything).length,
  "channel ids are unique",
);
assert(
  everything.credentials.every((group) => ids(everything).includes(group.channelId)),
  "no credential group names a channel that does not exist",
);
const prereleaseRule = everything.policy.rules.find(
  (rule) => rule.id === "no-prerelease-to-public",
);
assert(prereleaseRule !== undefined, "a project with tag-reachable public channels refuses a prerelease");
assert(
  prereleaseRule !== undefined &&
    "channels" in prereleaseRule &&
    !prereleaseRule.channels.includes("web"),
  "the prerelease refusal does not name a channel the tag could never have reached",
);
assert(
  prereleaseRule !== undefined &&
    "channels" in prereleaseRule &&
    prereleaseRule.channels.every((id) =>
      everything.channels.some(
        (channel) => channel.id === id && channel.publicDistribution && channel.trigger !== "branch",
      ),
    ),
  "every channel named in the prerelease refusal is public and tag-reachable",
);
assert(
  everything.policy.rules.some((rule) => rule.id === "release-record"),
  "a project with a CHANGELOG must write one entry per release",
);
assert(
  !webOnly.policy.rules.some((rule) => rule.id === "release-record"),
  "a project without a CHANGELOG is not made to invent one",
);
assert(
  new Set(ruleIds(everything)).size === ruleIds(everything).length,
  "policy rule ids are unique",
);

// ─────────────────────────────────────────────────────────────────────
section("Nothing in a config claims something it cannot back up");
// ─────────────────────────────────────────────────────────────────────

for (const [label, config] of Object.entries({
  webOnly,
  pages,
  scaffoldOnly,
  desktop,
  mobile,
  extension,
  everything,
})) {
  for (const channel of config.channels) {
    assert(channel.id.length > 0 && channel.label.length > 0, `${label}: every channel is named`);
    assert(channel.effect.trim().length > 0, `${label}/${channel.id}: says what it does`);
    assert(
      ["skip", "unsigned", "fail"].includes(channel.absent),
      `${label}/${channel.id}: absence has a defined behaviour`,
    );
  }
  for (const group of config.credentials) {
    assert(group.secrets.length > 0, `${label}/${group.channelId}: no empty credential group`);
    assert(
      !/quiet|silent/i.test(group.absentNote),
      `${label}/${group.channelId}: absence never means a quiet publish`,
    );
    for (const secret of group.secrets) {
      assert(secret.what.trim().length > 0, `${label}: ${secret.name} says what it is`);
      assert(secret.where.trim().length > 0, `${label}: ${secret.name} says where it comes from`);
    }
  }
  for (const copy of config.versionCopies) {
    let compiled = true;
    try {
      new RegExp(copy.pattern, copy.flags);
    } catch {
      compiled = false;
    }
    assert(compiled, `${label}: ${copy.label} has a compilable pattern`);
  }
}

// ─────────────────────────────────────────────────────────────────────
section("Derivation is a pure function of its input");
// ─────────────────────────────────────────────────────────────────────

const input = project({ surfaces: "fullstack", features: ["desktop"] }, desktopFiles);
const once = deriveChannels(input);
const twice = deriveChannels(input);
assert(JSON.stringify(once) === JSON.stringify(twice), "deriveChannels is deterministic");
assert(
  JSON.stringify(deriveCredentials(once)) === JSON.stringify(deriveCredentials(twice)),
  "deriveCredentials is deterministic",
);
assert(
  JSON.stringify(derivePolicy(input, once, deriveCredentials(once))) ===
    JSON.stringify(derivePolicy(input, twice, deriveCredentials(twice))),
  "derivePolicy is deterministic",
);

// ─────────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\n✓ release channel derivation");
