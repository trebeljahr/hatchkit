/**
 * `hatchkit create --reuse-github-repo`: the scaffold is stacked on an
 * existing repo's history instead of starting a new one.
 *
 * Drives `stackScaffoldOnHistory` against a local bare repo standing in
 * for GitHub, so no network and no `gh`. Checks the shape of `main`:
 * old commits reachable, then an empty-tree "clear" commit, then the
 * scaffold commit holding only the scaffold's files, and that pushing
 * it is a fast-forward when the old repo already had `main`.
 *
 * Run: `node scripts/test.mjs test-github-reuse.ts`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { stackScaffoldOnHistory, REUSED_REPO_BRANCH } = await import("./src/deploy/github.js");

const identity = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
Object.assign(process.env, identity);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env } }).trim();
}

/** A bare "remote" whose `branch` holds two commits of an old app. */
function oldRemote(root: string, branch: string): string {
  const bare = join(root, "remote.git");
  git(root, "init", "--bare", "-q", bare);
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", branch);
  writeFileSync(join(seed, "server.js"), "console.log('2020');\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "Initial commit");
  writeFileSync(join(seed, "README.md"), "# old prototype\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "Add readme");
  git(seed, "push", "-q", bare, `${branch}:${branch}`);
  return bare;
}

function freshScaffold(root: string): string {
  const app = join(root, "app");
  mkdirSync(join(app, "packages"), { recursive: true });
  writeFileSync(join(app, "package.json"), '{ "name": "demo" }\n');
  writeFileSync(join(app, "packages", "index.ts"), "export {};\n");
  git(app, "init", "-q");
  return app;
}

async function test(name: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hatchkit-reuse-"));
  try {
    await fn(root);
    console.log(`  ✓ ${name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const base of ["master", "main"]) {
  await test(`stacks the scaffold on an old ${base} branch`, async (root) => {
    const remote = oldRemote(root, base);
    const oldTip = git(remote, "rev-parse", base);
    const app = freshScaffold(root);

    await stackScaffoldOnHistory(app, remote, base, "demo");

    assert.equal(git(app, "symbolic-ref", "--short", "HEAD"), REUSED_REPO_BRANCH);
    const subjects = git(app, "log", "--format=%s").split("\n");
    assert.deepEqual(subjects, [
      "Initial scaffold",
      "Clear the previous code for a fresh start",
      "Add readme",
      "Initial commit",
    ]);
    // The old tip is an ancestor of main: history kept.
    git(app, "merge-base", "--is-ancestor", oldTip, "HEAD");
    // The clear commit has the empty tree.
    assert.equal(git(app, "ls-tree", "-r", "--name-only", "HEAD~1"), "");
    // The scaffold commit holds only the scaffold's files.
    assert.deepEqual(git(app, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort(), [
      "package.json",
      "packages/index.ts",
    ]);
    assert.equal(git(app, "remote", "get-url", "origin"), remote);

    // Pushing main is accepted; when the old repo had main, it is a
    // fast-forward of it (a plain push without --force succeeds).
    git(app, "push", "-q", "origin", REUSED_REPO_BRANCH);
    assert.equal(git(remote, "rev-parse", REUSED_REPO_BRANCH), git(app, "rev-parse", "HEAD"));
    // An old branch other than main is left untouched.
    if (base !== REUSED_REPO_BRANCH) assert.equal(git(remote, "rev-parse", base), oldTip);
  });
}

await test("an empty repo gets a plain initial commit", async (root) => {
  const remote = join(root, "empty.git");
  git(root, "init", "--bare", "-q", remote);
  const app = freshScaffold(root);

  await stackScaffoldOnHistory(app, remote, null, "demo");

  assert.deepEqual(git(app, "log", "--format=%s").split("\n"), ["Initial scaffold"]);
  assert.equal(git(app, "symbolic-ref", "--short", "HEAD"), REUSED_REPO_BRANCH);
});
