#!/usr/bin/env node
/**
 * Cuts a release locally: one commit and one annotated tag, never a push.
 *
 *   <pm> release X.Y.Z [--dry-run] [--skip-tests] [--yes]
 *
 * A tag on this project starts several workflows at once — whichever
 * surfaces it has — and they are not recoverable once started: an image is
 * pulled, a store submission is queued, a draft release is there for
 * someone to publish. So every check that can be made before the tag exists
 * is made here, where a failure costs nothing:
 *
 *  1. Preflight. Refuses a dirty tree, a branch other than the default one,
 *     a default branch behind its remote, tags origin has that this
 *     checkout lacks, an existing tag, and a version that is not newer.
 *     Under --dry-run these are collected and the plan is printed anyway.
 *  2. Plan. Every file the release rewrites — the root version and every
 *     copy listed in `.hatchkit-release.json` — computed, not written
 *     (`scripts/lib/release-plan.mjs`).
 *  3. Policy check against the PLANNED commit. The plan is turned into a
 *     real commit object in a throwaway git index, and
 *     `release-policy-check.mjs` is run against it. That is what makes "a
 *     mismatch fails before anything is uploaded" true: the check reads the
 *     release exactly as it will be tagged, without HEAD or the working
 *     tree moving at all. It is the single most important property here.
 *  4. Write and test. The files are written and `project.testCommand` runs;
 *     a failure restores every file this run wrote.
 *  5. Commit and tag. The commit's tree is compared with the one the policy
 *     check passed — a commit hook can change what was committed — and only
 *     then is the annotated tag created.
 *
 * Then it prints what each channel will do on this tag, which is the reason
 * the command exists rather than `npm version && git tag`.
 *
 * `--dry-run` does 1–3 and prints the diff; it writes only unreferenced git
 * objects, which `git gc` removes. `--yes` skips the confirmation prompt.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadReleaseConfig } from "./lib/release-config.mjs";
import { planVersionRewrite, versionRefusal } from "./lib/release-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const git = (args, options = {}) =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

const fail = (text) => {
  console.error(`\nrelease: ${text}`);
  process.exit(1);
};

/** Installed beside this script by the same feature, so its path is
 *  fixed rather than configured. */
const VERSION_SYNC_TEST = "scripts/release-version-sync.test.mjs";

const FLAGS = ["--dry-run", "--skip-tests", "--yes", "--help"];
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
const unknown = [...flags].filter((flag) => !FLAGS.includes(flag));

let config;
try {
  config = loadReleaseConfig(ROOT);
} catch (caught) {
  fail(caught instanceof Error ? caught.message : String(caught));
}
const project = config.project;
const usage = `usage: ${project.packageManager} release X.Y.Z [--dry-run] [--skip-tests] [--yes]`;

if (flags.has("--help")) {
  console.log(usage);
  process.exit(0);
}
if (unknown.length > 0 || positional.length !== 1) {
  fail(`${unknown.length > 0 ? `unknown ${unknown.join(" ")}\n` : ""}${usage}`);
}

const dryRun = flags.has("--dry-run");
const skipTests = flags.has("--skip-tests");
const yes = flags.has("--yes");
const version = positional[0].replace(new RegExp(`^${project.tagPrefix}`), "");
const tag = `${project.tagPrefix}${version}`;

// ── 1. Preflight ────────────────────────────────────────────────────────

/** In a dry run a refusal is reported and the plan is still printed. */
const refusals = [];
const refuse = (text) => {
  if (!dryRun) fail(text);
  refusals.push(text);
};

const hasRef = (ref) =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT }).status === 0;

/** What origin calls its default branch, or the usual names, or HEAD. */
const defaultBranch = () => {
  const head = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  if (head.status === 0 && head.stdout.trim() !== "")
    return head.stdout.trim().replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (hasRef(`refs/heads/${name}`)) return name;
  }
  return git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
};

const mainBranch = defaultBranch();
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
if (branch !== mainBranch)
  refuse(`releases are cut from ${mainBranch}; this checkout is on ${branch}`);

const dirty = git(["status", "--porcelain"]).trim();
if (dirty !== "") refuse(`the working tree is not clean:\n${dirty}`);

if (hasRef(`refs/remotes/origin/${mainBranch}`)) {
  const behind = git(["rev-list", "--count", `HEAD..origin/${mainBranch}`]).trim();
  if (behind !== "0") {
    refuse(
      `${mainBranch} is ${behind} commit(s) behind origin/${mainBranch} as of the last fetch; rebase first`,
    );
  }
}

const localTags = git(["tag", "-l"]).split("\n").filter(Boolean);
let remoteTags = [];
try {
  remoteTags = git(["ls-remote", "--tags", "--refs", "origin"], { timeout: 20_000 })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1].replace(/^refs\/tags\//, ""));
} catch {
  console.warn("release: could not list origin's tags (offline?); checking local tags only.");
}
// The policy check answers "is this tag newer" from LOCAL tags. Without the
// remote's, it compares against nothing and waves through a version that
// someone else already released.
const missing = remoteTags.filter(
  (name) => name.startsWith(project.tagPrefix) && !localTags.includes(name),
);
if (missing.length > 0) {
  refuse(
    `origin has tags this checkout lacks (${missing.join(", ")}); run: git fetch --tags origin`,
  );
}

/** A file as it is at HEAD — what the release is planned against. */
const readHead = (path) => {
  const result = spawnSync("git", ["show", `HEAD:${path}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
};

const currentText = readHead(project.versionFile);
if (currentText === null)
  fail(`${project.versionFile} is not in HEAD; it holds the version this project releases`);
let current;
try {
  current = JSON.parse(currentText).version;
} catch {
  current = /"version"\s*:\s*"([^"]+)"/.exec(currentText)?.[1];
}
const knownTags = [...new Set([...localTags, ...remoteTags])];
const versionProblem = versionRefusal({
  current,
  next: version,
  tags: knownTags,
  tagPrefix: project.tagPrefix,
});
if (versionProblem) fail(versionProblem);

// ── 2. Plan ─────────────────────────────────────────────────────────────

const plan = planVersionRewrite({ config, version, readFile: readHead });
for (const problem of plan.problems) refuse(problem);

console.log(
  `Release ${tag} of ${project.name} (from ${current}${current === version ? ", untagged" : ""})`,
);
if (plan.changes.length === 0)
  console.log("  no file needs rewriting: every copy of the version already says it");
for (const change of plan.changes) console.log(`  update ${change.path}  (${change.label})`);

// ── 3. Policy check against the planned tree ────────────────────────────

const commitMessage = `chore(release): ${tag}`;
const scratch = mkdtempSync(join(tmpdir(), "hatchkit-release-"));
let plannedTree;
let plannedCommit;
try {
  // A throwaway index: the planned commit becomes a real object the policy
  // check can read at a ref, while HEAD and the working tree stay put.
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  git(["read-tree", "HEAD"], { env });
  for (const change of plan.changes) {
    const mode = git(["ls-tree", "HEAD", "--", change.path]).split(" ")[0] || "100644";
    const blob = git(["hash-object", "-w", "--stdin"], { input: change.after }).trim();
    git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${change.path}`], { env });
  }
  plannedTree = git(["write-tree"], { env }).trim();
  plannedCommit = git(["commit-tree", plannedTree, "-p", "HEAD", "-m", commitMessage]).trim();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
const policy = spawnSync(
  process.execPath,
  [join(HERE, "release-policy-check.mjs"), tag, plannedCommit],
  {
    cwd: ROOT,
    stdio: "inherit",
  },
);
const policyPassed = policy.status === 0;

if (dryRun) {
  console.log(`\n── Planned changes (git diff HEAD ${plannedCommit.slice(0, 10)}) ──\n`);
  spawnSync("git", ["--no-pager", "diff", "--stat", "HEAD", plannedCommit], {
    cwd: ROOT,
    stdio: "inherit",
  });
  spawnSync("git", ["--no-pager", "diff", "HEAD", plannedCommit], { cwd: ROOT, stdio: "inherit" });
  const alsoTests = skipTests
    ? ""
    : ` A real run also runs node --test ${VERSION_SYNC_TEST}` +
      `${project.testCommand === null ? "" : ` and ${project.testCommand}`}.`;
  console.log(`\nDry run: nothing was written.${alsoTests}`);
  for (const text of refusals) console.log(`A real run would refuse: ${text}`);
  if (!policyPassed) console.log("A real run would stop at the release policy check above.");
  process.exit(refusals.length > 0 || !policyPassed ? 1 : 0);
}

if (!policyPassed) fail("the release policy check failed; nothing was changed.");

/** Asks, unless --yes or nothing is there to answer (CI). */
const confirmed = (question) => {
  if (yes || !process.stdin.isTTY) return true;
  process.stdout.write(`${question} [y/N] `);
  const buffer = Buffer.alloc(64);
  let read = 0;
  try {
    read = readSync(0, buffer, 0, buffer.length, null);
  } catch {
    return false;
  }
  return /^y(es)?$/i.test(buffer.toString("utf8", 0, read).trim());
};
const question =
  plan.changes.length === 0
    ? `\nNothing needs rewriting. Tag ${tag} at HEAD?`
    : `\nCommit these ${plan.changes.length} change(s) and tag ${tag}?`;
if (!confirmed(question)) fail("nothing was changed.");

// ── 4. Write and test ───────────────────────────────────────────────────

const written = [];
const restore = () => {
  // `before` is the file at HEAD and the tree was clean, so writing it back
  // is an exact restore — and it touches nothing this run did not write.
  for (const change of written) writeFileSync(join(ROOT, change.path), change.before);
};
for (const change of plan.changes) {
  writeFileSync(join(ROOT, change.path), change.after);
  written.push(change);
}

if (!skipTests) {
  // The version-sync test always runs, whether or not this project has a
  // test script and whether or not that script was wired to include it.
  // hatchkit does not edit the project's `test` script — silently
  // rewriting somebody's test command on every update is worse than the
  // problem — so this is where the guarantee that every copy of the
  // version agrees is actually kept at cut time. The policy check above
  // asserts the same thing, and CI asserts it again at the tag; this is
  // the copy that runs against the files as just written.
  const commands = [
    `node --test ${VERSION_SYNC_TEST}`,
    ...(project.testCommand === null ? [] : [project.testCommand]),
  ];
  for (const command of commands) {
    console.log(`\nRunning ${command} …\n`);
    // The command comes from this project's own committed config, so a shell
    // is the right reading of it: it may be a pipeline or carry quoting.
    const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: "inherit" });
    if (result.status !== 0) {
      restore();
      fail(`${command} failed; every file this run wrote was restored.`);
    }
  }
}

// ── 5. Commit and tag ───────────────────────────────────────────────────

const paths = plan.changes.map((change) => change.path);
// Nothing to rewrite means the tree at HEAD already IS the release (a
// first release, or a bump committed by hand); it gets the tag, not an
// empty commit that says a release changed something.
if (paths.length > 0) {
  try {
    git(["add", "--", ...paths]);
    git(["commit", "-m", commitMessage], { stdio: ["pipe", "inherit", "inherit"] });
  } catch {
    restore();
    git(["reset", "--quiet", "--", ...paths]);
    fail("git commit failed; every file this run wrote was restored.");
  }
}

// A commit hook can change what was committed. The tag must name the tree
// the policy check passed, or the check vouched for something else.
const committedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
if (committedTree !== plannedTree) {
  fail(
    `the commit's tree (${committedTree}) is not the one the policy check passed (${plannedTree}).\n` +
      "A commit hook probably changed files. The commit stays; NO tag was created. Inspect it with git show.",
  );
}
git(["tag", "-a", tag, "-m", `${project.name} ${version}`]);

const sha = git(["rev-parse", "--short", "HEAD"]).trim();
console.log(
  paths.length > 0
    ? `\nCommitted ${sha} ${commitMessage} and tagged ${tag}. Nothing was pushed.`
    : `\nTagged ${tag} at ${sha}; no file needed rewriting. Nothing was pushed.`,
);

// ── What the tag starts ─────────────────────────────────────────────────

if (config.channels.length === 0) {
  console.log(`\n${tag} starts no workflows: this project has no release channels yet.`);
} else {
  const width = Math.max(...config.channels.map((channel) => channel.label.length));
  console.log(`\nWhat ${tag} starts:\n`);
  for (const channel of config.channels) {
    const manual =
      channel.trigger === "branch"
        ? " (not started by the tag)"
        : channel.trigger === "tag-dispatch"
          ? " (needs a manual dispatch from the tag)"
          : "";
    const gate = channel.gate ? ` — then: ${channel.gate.note}` : "";
    console.log(`  ${channel.label.padEnd(width)}  ${channel.effect}${manual}${gate}`);
  }
}

console.log(
  `\nPush when ready, the branch first, so the tag's commit is on ${mainBranch} when its workflows start:\n`,
);
console.log(`  git push origin ${mainBranch}`);
console.log(`  git push origin ${tag}`);
const undo =
  paths.length > 0 ? `git tag -d ${tag} && git reset --hard HEAD~1` : `git tag -d ${tag}`;
console.log(`\nThen: node scripts/release-status.mjs ${tag}\nTo undo before pushing: ${undo}`);
