#!/usr/bin/env node
/*
 * release — the whole hatchkit release, in an order that can be resumed.
 *
 *   node scripts/release.mjs patch|minor|major   prep, bump, then finish
 *   node scripts/release.mjs resume              finish a release that stopped
 *
 * Finish = build, typecheck, publish every package npm does not have
 * yet (release-packages.mjs), push the version commit and its tag,
 * install the CLI globally.
 *
 * Publishing comes before the push. A publish that stops (npm's 2FA,
 * the network) leaves nothing on GitHub, and `pnpm release:resume`
 * runs the finish again: build and typecheck repeat, packages already
 * on npm are skipped, and the push is a no-op once done.
 *
 * pnpm is resolved once (release-lib.mjs) and put on PATH for every
 * step, so the release also runs where `pnpm` itself is not on PATH.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envWithPnpm, pushArgs, resolvePnpm } from "./release-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, "..");
const RESUME = [
  "      pnpm release:resume",
  "",
  "  or, without pnpm on PATH:",
  "",
  "      node cli/scripts/release.mjs resume",
].join("\n");

const kind = process.argv[2];
if (!["patch", "minor", "major", "resume"].includes(kind)) {
  console.error(`release: expected patch|minor|major|resume, got ${kind ?? "(nothing)"}`);
  process.exit(1);
}

const pnpm = resolvePnpm();
if (!pnpm) {
  const pinned = String(readJson(join(cliDir, "package.json")).packageManager ?? "pnpm");
  console.error(
    [
      "",
      "  ✗ release: pnpm not found. Nothing was changed.",
      "",
      "  This shell has no `pnpm` and no `corepack` on PATH, and the release",
      "  was not started by pnpm. Put pnpm on PATH, for example with",
      "",
      `      npm install -g ${pinned.split("+")[0]}`,
      "",
      "  or `corepack enable pnpm` on a Node that ships corepack, then run",
      "  the release again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
const { env, cleanup } = envWithPnpm(pnpm);
process.on("exit", cleanup);

const repoRoot = git(["rev-parse", "--show-toplevel"]);

if (kind === "resume") {
  checkResumable();
} else {
  step("prep", process.execPath, [join(here, "release-prep.mjs")]);
  step("bump", process.execPath, [join(here, "release-bump.mjs"), kind], {
    hint: "  The version bump did not finish. Check `git status` and `git log -1` before retrying.",
  });
}

const version = readJson(join(cliDir, "package.json")).version;
const notPushed = [
  `  v${version} is committed and tagged here; nothing is pushed yet.`,
  "  Fix the cause above, then finish the release with",
  "",
  RESUME,
  "",
  "  Packages that already reached npm are skipped.",
].join("\n");

step("build", pnpm.command, [...pnpm.args, "run", "build"], { hint: notPushed });
step("typecheck", pnpm.command, [...pnpm.args, "run", "typecheck"], { hint: notPushed });
step("publish", process.execPath, [join(here, "release-packages.mjs")], { hint: notPushed });

const branch = gitMaybe(["symbolic-ref", "--quiet", "--short", "HEAD"]);
const remote = (branch && gitMaybe(["config", `branch.${branch}.remote`])) || "origin";
const branchRef = branch && gitMaybe(["config", `branch.${branch}.merge`]);
step("push", "git", pushArgs({ remote, branchRef, version }), {
  cwd: repoRoot,
  hint: [
    `  Every package of v${version} is on npm, but the push to ${remote} failed.`,
    "  Fix the cause above, then push with",
    "",
    RESUME,
  ].join("\n"),
});

step("global install", "npm", ["install", "-g", "."], {
  hint: `  v${version} is on npm and GitHub. Only the global install failed:\n\n      cd ${cliDir} && npm install -g .`,
});

console.log(`\n  ✓ release: v${version} is on npm and pushed to ${remote}.`);

/** `resume` finishes the release HEAD is tagged for. It refuses a dirty
 *  tree (the build would publish uncommitted changes) and a tag that is
 *  not at HEAD (what gets published must be what the tag names). */
function checkResumable() {
  const { version } = readJson(join(cliDir, "package.json"));
  const tag = `v${version}`;
  const fail = (lines) => {
    console.error(["", `  ✗ release resume: ${lines[0]}`, ...lines.slice(1), ""].join("\n"));
    process.exit(1);
  };
  const dirty = git(["status", "--porcelain"]);
  if (dirty) fail(["the working tree has changes. Commit or stash them first.", "", dirty]);
  const tagged = gitMaybe(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (!tagged) {
    fail([
      `no tag ${tag}, so there is no stopped release of cli/package.json's version.`,
      "  Start a new release with `pnpm release` instead.",
    ]);
  }
  if (tagged !== git(["rev-parse", "HEAD"])) {
    fail([
      `${tag} does not point at HEAD.`,
      "  If you committed a fix after the release stopped, move the tag onto it:",
      "",
      `      git tag -fa ${tag} -m ${tag}`,
    ]);
  }
  console.log(`  release: resuming ${tag}.`);
}

function step(label, command, args, { cwd = cliDir, hint } = {}) {
  console.log(`\n  ▸ release: ${label}`);
  const res = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (res.status === 0) return;
  const why = res.error ? res.error.message : `exit ${res.status ?? res.signal}`;
  console.error(`\n  ✗ release: ${label} failed (${why}).`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(res.status || 1);
}

function git(args) {
  return spawnSync("git", args, { cwd: cliDir, encoding: "utf-8" }).stdout?.trim() ?? "";
}

function gitMaybe(args) {
  const res = spawnSync("git", args, { cwd: cliDir, encoding: "utf-8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}
