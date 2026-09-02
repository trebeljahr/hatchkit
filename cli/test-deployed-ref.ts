import assert from "node:assert/strict";
/**
 * Deploy-ref preflight: does the commit Coolify clones contain the
 * compose file the application builds from?
 *
 * The bug these tests exist for (tracktime, 2026-09-02): sync created
 * two split apps at `/docker-compose.client.yml` and
 * `/docker-compose.server.yml`, every deploy failed, and the Coolify
 * log ended with
 *
 *     fatal: could not read Username for 'https://github.com'
 *
 * while `git ls-remote`, `git clone`, `git fetch` and `git log -1` in
 * the SAME log all succeeded. Nothing was wrong with the credentials.
 * `origin/main` was 55 commits behind local `main` and neither compose
 * file existed at that commit, so Coolify's `loadComposeFile()` failed
 * on a path that genuinely wasn't there.
 *
 * Fixtures are real git repositories (a bare "remote" plus a clone) so
 * the plumbing is exercised for real — `git cat-file -e <sha>:<path>`
 * against a tree, not a mock of one. Goldens lock in:
 *
 *   1. Path joining: `base_directory` + `docker_compose_location`, the
 *      way Coolify resolves them.
 *   2. `pinnedCommitOf` treats Coolify's literal "HEAD" as "no pin".
 *   3. An unpushed compose file blocks, is reported as unpushed (not
 *      as missing), and counts the commits the branch is ahead.
 *   4. Pushing it clears the finding.
 *   5. A branch that was never pushed blocks with its own wording.
 *   6. A pinned commit is probed instead of the branch tip, in both
 *      directions.
 *   7. A `projectSubdir` project probes the subdir path.
 *   8. Outside a git repo the check skips — it never fails a sync for
 *      being unable to look.
 *   9. The rendered text names the misleading Coolify error, so the
 *      next person doesn't spend the afternoon on credentials.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkDeployedRef,
  composePathAtRepoRoot,
  pinnedCommitOf,
  renderDeployedRef,
  summarizeDeployedRef,
} from "./src/deploy/deployed-ref.js";

const failures: string[] = [];

async function expect(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    // stderr dropped: `git clone` of a fresh bare repo warns about the
    // empty repository, which is expected here and only noise.
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hatchkit-test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "hatchkit-test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

/** A bare "remote" plus a working clone with one pushed commit
 *  ("Initial scaffold" — the same subject the real incident's `git
 *  log -1` printed). Returns the clone's path. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hatchkit-deployed-ref-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  mkdirSync(remote, { recursive: true });
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", "--quiet", remote, work);
  git(work, "config", "user.email", "test@example.invalid");
  git(work, "config", "user.name", "hatchkit-test");
  write(work, "README.md", "# fixture\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Initial scaffold");
  git(work, "push", "--quiet", "-u", "origin", "main");
  return work;
}

/** The split pair, added locally and deliberately NOT pushed. */
function addSplitCompose(work: string): void {
  write(work, "docker-compose.client.yml", "services:\n  client: {}\n");
  write(work, "docker-compose.server.yml", "services:\n  server: {}\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "chore: split the compose file in two");
}

const SPLIT_PATHS = [
  { appName: "tracktime-client", path: "docker-compose.client.yml" },
  { appName: "tracktime-server", path: "docker-compose.server.yml" },
];

// ---------------------------------------------------------------------------

console.log("composePathAtRepoRoot:");

await expect("repo-root project strips the leading slash", () => {
  assert.equal(composePathAtRepoRoot("/docker-compose.server.yml"), "docker-compose.server.yml");
});

await expect("projectSubdir joins the way Coolify resolves base_directory", () => {
  // Coolify reads docker_compose_location INSIDE base_directory, and
  // hatchkit's scaffolder writes the file there to match.
  assert.equal(composePathAtRepoRoot("/docker-compose.yml", "site"), "site/docker-compose.yml");
  assert.equal(
    composePathAtRepoRoot("/docker-compose.yml", "/apps/web"),
    "apps/web/docker-compose.yml",
  );
  assert.equal(composePathAtRepoRoot("docker-compose.yml", "./site/"), "site/docker-compose.yml");
});

await expect('a "/" base directory means repo root, not a directory named "/"', () => {
  assert.equal(composePathAtRepoRoot("/docker-compose.yml", "."), "docker-compose.yml");
  assert.equal(composePathAtRepoRoot("/docker-compose.yml", ""), "docker-compose.yml");
});

console.log("\npinnedCommitOf:");

await expect('Coolify\'s literal "HEAD" is not a pin', () => {
  // Coolify stores "HEAD" to mean "track the branch tip". Probing it
  // as a commit would resolve to the LOCAL head and pass a check that
  // should have failed.
  assert.equal(pinnedCommitOf("HEAD"), undefined);
  assert.equal(pinnedCommitOf("head"), undefined);
  assert.equal(pinnedCommitOf(""), undefined);
  assert.equal(pinnedCommitOf(undefined), undefined);
  assert.equal(pinnedCommitOf("not-a-sha"), undefined);
});

await expect("a real sha is a pin", () => {
  assert.equal(pinnedCommitOf("26fdc06"), "26fdc06");
  assert.equal(
    pinnedCommitOf(" 8f5ddafb0c1e2d3f4a5b6c7d8e9f0a1b2c3d4e5f "),
    "8f5ddafb0c1e2d3f4a5b6c7d8e9f0a1b2c3d4e5f",
  );
});

console.log("\ncheckDeployedRef — the tracktime failure:");

await expect("an unpushed compose file blocks, and says it was never pushed", async () => {
  const work = makeRepo();
  addSplitCompose(work);

  const report = await checkDeployedRef({ projectDir: work, paths: SPLIT_PATHS });

  assert.equal(report.ran, true);
  assert.equal(report.blocking, true, "an absent compose path must block");
  assert.equal(report.ref, "origin/main");
  assert.equal(report.refSubject, "Initial scaffold", "Coolify clones origin/main, not HEAD");
  assert.equal(report.ahead, 1);
  assert.equal(report.behind, 0);
  assert.deepEqual(report.missing.map((m) => m.path).sort(), [
    "docker-compose.client.yml",
    "docker-compose.server.yml",
  ]);
  // "exists here, never pushed" and "path is simply wrong" need
  // different fixes, so the report has to tell them apart.
  assert.ok(
    report.missing.every((m) => m.localPresent),
    "both files exist locally — the report must say so",
  );
  const text = renderDeployedRef(report).join("\n");
  assert.match(text, /never been pushed/);
  assert.match(text, /git push origin main/);
});

await expect("pushing the branch clears the finding", async () => {
  const work = makeRepo();
  addSplitCompose(work);
  git(work, "push", "--quiet", "origin", "main");

  const report = await checkDeployedRef({ projectDir: work, paths: SPLIT_PATHS });

  assert.equal(report.blocking, false);
  assert.equal(report.missing.length, 0);
  assert.equal(report.ahead, 0);
  assert.ok(report.probes.every((p) => p.present));
  assert.match(summarizeDeployedRef(report), /has every compose files?/);
});

await expect("a branch that was never pushed blocks on its own terms", async () => {
  const work = makeRepo();
  addSplitCompose(work);

  const report = await checkDeployedRef({
    projectDir: work,
    paths: SPLIT_PATHS,
    branch: "release",
  });

  assert.equal(report.ran, true);
  assert.equal(report.blocking, true);
  assert.equal(report.refSha, undefined);
  const text = renderDeployedRef(report).join("\n");
  assert.match(text, /origin\/release does not exist/);
  assert.match(text, /git push -u origin release/);
});

await expect("a pinned commit is probed instead of the branch tip", async () => {
  const work = makeRepo();
  const scaffold = git(work, "rev-parse", "HEAD");
  addSplitCompose(work);
  const withCompose = git(work, "rev-parse", "HEAD");
  git(work, "push", "--quiet", "origin", "main");

  // Branch tip has the files; the pin does not. Tracking the branch
  // would report all-clear for a deploy that cannot work.
  const pinned = await checkDeployedRef({
    projectDir: work,
    paths: SPLIT_PATHS,
    pinnedCommit: scaffold,
  });
  assert.equal(pinned.blocking, true);
  assert.equal(pinned.missing.length, 2);
  assert.match(renderDeployedRef(pinned).join("\n"), /clear the pinned commit/);

  const pinnedOk = await checkDeployedRef({
    projectDir: work,
    paths: SPLIT_PATHS,
    pinnedCommit: withCompose,
  });
  assert.equal(pinnedOk.blocking, false);
});

await expect("a projectSubdir project probes the subdir path", async () => {
  const work = makeRepo();
  write(work, "site/docker-compose.yml", "services:\n  app: {}\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "feat: add the site compose");
  git(work, "push", "--quiet", "origin", "main");

  const path = composePathAtRepoRoot("/docker-compose.yml", "site");
  const ok = await checkDeployedRef({ projectDir: work, paths: [{ appName: "site", path }] });
  assert.equal(ok.blocking, false);

  // The same file at the repo root is a different path, and absent.
  const wrong = await checkDeployedRef({
    projectDir: work,
    paths: [{ appName: "site", path: composePathAtRepoRoot("/docker-compose.yml") }],
  });
  assert.equal(wrong.blocking, true);
  assert.equal(
    wrong.missing[0].localPresent,
    false,
    "not on disk either — a wrong path, not an unpushed one",
  );
  assert.match(renderDeployedRef(wrong).join("\n"), /and from the working tree/);
});

await expect("the check runs from a subdirectory of the repo", async () => {
  const work = makeRepo();
  addSplitCompose(work);
  mkdirSync(join(work, "packages", "server"), { recursive: true });

  const report = await checkDeployedRef({
    projectDir: join(work, "packages", "server"),
    paths: SPLIT_PATHS,
  });
  // Paths are repo-root-relative because that is what Coolify clones.
  assert.equal(report.blocking, true);
  assert.equal(report.missing.length, 2);
});

console.log("\ncheckDeployedRef — when it can't look:");

await expect("outside a git repo the check skips rather than failing", async () => {
  const loose = mkdtempSync(join(tmpdir(), "hatchkit-deployed-ref-loose-"));
  roots.push(loose);
  const report = await checkDeployedRef({ projectDir: loose, paths: SPLIT_PATHS });
  assert.equal(report.ran, false);
  assert.equal(report.blocking, false, "inability to look is not a finding");
  assert.match(report.skipped ?? "", /not inside a git repository/);
});

await expect("a repo with no remote skips — there is nothing to clone from", async () => {
  const root = mkdtempSync(join(tmpdir(), "hatchkit-deployed-ref-noremote-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main", ".");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "hatchkit-test");
  write(root, "docker-compose.yml", "services: {}\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "init");

  const report = await checkDeployedRef({
    projectDir: root,
    paths: [{ appName: "app", path: "docker-compose.yml" }],
  });
  assert.equal(report.ran, false);
  assert.equal(report.blocking, false);
  assert.match(report.skipped ?? "", /no "origin" remote/);
});

console.log("\nrenderDeployedRef — the message that was missing:");

await expect("names the misleading Coolify error so nobody re-debugs credentials", async () => {
  const work = makeRepo();
  addSplitCompose(work);
  const report = await checkDeployedRef({ projectDir: work, paths: SPLIT_PATHS });
  const text = renderDeployedRef(report).join("\n");

  // The whole point: the log's trailing git error is not the cause.
  assert.match(text, /could not read Username/);
  assert.match(text, /that error is not the cause/i);
  assert.match(text, /Initial scaffold/, "quote the commit Coolify actually clones");
  assert.match(text, /1 commit\(s\) ahead/);
  // And each finding names the app it belongs to.
  assert.match(text, /tracktime-client/);
  assert.match(text, /tracktime-server/);
});

await expect("a clean, in-sync ref renders no fix advice", async () => {
  const work = makeRepo();
  addSplitCompose(work);
  git(work, "push", "--quiet", "origin", "main");
  const text = renderDeployedRef(
    await checkDeployedRef({ projectDir: work, paths: SPLIT_PATHS }),
  ).join("\n");
  assert.doesNotMatch(text, /Fix:/);
  assert.doesNotMatch(text, /could not read Username/);
});

for (const root of roots) rmSync(root, { recursive: true, force: true });

console.log();
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("All deployed-ref tests passed.");
