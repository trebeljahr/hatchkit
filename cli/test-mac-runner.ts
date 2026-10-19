/**
 * `hatchkit mac-runner` decisions (src/mac-runner/plan.ts).
 *
 * The rules that fail quietly if broken:
 *   - a label that is also a GitHub-hosted label sends the Apple jobs back
 *     to GitHub, billed, with nothing saying so;
 *   - the keychain scrub must only ever drop paths under the runner
 *     directory — dropping the login keychain from the search list breaks
 *     every app that signs or reads a password;
 *   - the jobs' environment must not carry the operator's tokens;
 *   - the runner package is only trusted with the SHA-256 from its release.
 *
 * Run: pnpm --filter hatchkit test:mac-runner
 */
import assert from "node:assert/strict";
import {
  DEFAULT_LABEL,
  isActiveRun,
  jobsForLabel,
  labelProblem,
  parseFields,
  parseKeychainList,
  pickDispatchedRun,
  releaseSha,
  repoFromRemote,
  runnerEnv,
  runnerPackage,
  scrubKeychains,
} from "./src/mac-runner/plan.js";

const failures: string[] = [];
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

check("the default label is a valid custom label", () => {
  assert.equal(labelProblem(DEFAULT_LABEL), null);
});

check("GitHub-hosted and default runner labels are refused", () => {
  for (const label of [
    "macos-15",
    "macos-latest",
    "ubuntu-24.04",
    "self-hosted",
    "macOS",
    "ARM64",
  ]) {
    assert.notEqual(labelProblem(label), null, label);
  }
  assert.notEqual(labelProblem("has space"), null);
  assert.notEqual(labelProblem(""), null);
});

check("repo slugs come from https and ssh remotes", () => {
  assert.equal(
    repoFromRemote("git@github.com:trebeljahr/mesozoic-protocol.git"),
    "trebeljahr/mesozoic-protocol",
  );
  assert.equal(repoFromRemote("https://github.com/trebeljahr/tiao.git\n"), "trebeljahr/tiao");
  assert.equal(repoFromRemote("https://github.com/trebeljahr/ricos.site"), "trebeljahr/ricos.site");
  assert.equal(repoFromRemote("https://gitlab.com/a/b.git"), null);
});

check("the runner package matches the Mac's architecture", () => {
  assert.deepEqual(runnerPackage("2.338.0", "arm64"), {
    name: "actions-runner-osx-arm64-2.338.0.tar.gz",
    platform: "osx-arm64",
  });
  assert.equal(runnerPackage("2.338.0", "x64").platform, "osx-x64");
});

check("the SHA-256 is read for the asked platform only", () => {
  const arm = "a".repeat(64);
  const x64 = "b".repeat(64);
  const body = [
    "- OSX x64 <!-- BEGIN SHA osx-x64 -->",
    `${x64}<!-- END SHA osx-x64 -->`,
    `- OSX arm64 <!-- BEGIN SHA osx-arm64 -->${arm}<!-- END SHA osx-arm64 -->`,
  ].join("\n");
  assert.equal(releaseSha(body, "osx-arm64"), arm);
  assert.equal(releaseSha(body, "osx-x64"), x64);
  assert.equal(releaseSha(body, "linux-x64"), null);
  assert.equal(
    releaseSha("<!-- BEGIN SHA osx-arm64 -->nothex<!-- END SHA osx-arm64 -->", "osx-arm64"),
    null,
  );
});

check("the keychain scrub drops only temporary keychains under the runner directory", () => {
  const root = "/Users/me/Library/Caches/hatchkit/mac-runner";
  const output = [
    `    "${root}/slots/123-1/_work/_temp/build.keychain"`,
    '    "/Users/me/Library/Keychains/login.keychain-db"',
    `    "${root}-other/x.keychain"`,
    '    "/Library/Keychains/System.keychain"',
  ].join("\n");
  const list = parseKeychainList(output);
  assert.equal(list.length, 4);
  assert.deepEqual(scrubKeychains(list, root), [
    "/Users/me/Library/Keychains/login.keychain-db",
    `${root}-other/x.keychain`,
    "/Library/Keychains/System.keychain",
  ]);
  assert.equal(scrubKeychains(list.slice(1), root), null, "nothing to drop → no write");
  assert.equal(scrubKeychains(list, `${root}/`)?.length, 3, "trailing slash is the same root");
});

check("the jobs' environment carries no tokens", () => {
  const env = runnerEnv(
    {
      GH_TOKEN: "ghp_x",
      GITHUB_TOKEN: "ghp_y",
      CLOUDFLARE_API_TOKEN: "cf",
      AWS_SECRET_ACCESS_KEY: "aws",
      USER: "me",
      SHELL: "/bin/zsh",
      PATH: "/Users/me/.nvm/versions/node/v20/bin:/usr/bin",
    },
    "/Users/me",
  );
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "SHELL", "USER"]);
  assert.equal(env.HOME, "/Users/me");
  assert.ok(env.PATH.startsWith("/Users/me/.cargo/bin:/opt/homebrew/bin"), env.PATH);
  assert.ok(!env.PATH.includes(".nvm"), "the operator's PATH is not inherited");
});

check("the dispatched run is this actor's newest dispatch on the ref, after the dispatch", () => {
  const since = Date.parse("2026-10-19T12:00:00Z");
  const run = (
    id: number,
    at: string,
    extra: Partial<Parameters<typeof pickDispatchedRun>[0][0]> = {},
  ) => ({
    id,
    created_at: at,
    head_branch: "main",
    event: "workflow_dispatch",
    actor: { login: "rico" },
    ...extra,
  });
  const runs = [
    run(1, "2026-10-19T11:50:00Z"),
    run(2, "2026-10-19T12:00:04Z", { actor: { login: "someone" } }),
    run(3, "2026-10-19T12:00:03Z", { head_branch: "other" }),
    run(4, "2026-10-19T12:00:02Z", { event: "push" }),
    run(5, "2026-10-19T11:59:55Z"),
  ];
  assert.equal(pickDispatchedRun(runs, { since, ref: "main", actor: "rico" })?.id, 5);
  assert.equal(pickDispatchedRun(runs, { since, ref: "refs/heads/other", actor: "rico" })?.id, 3);
  assert.equal(pickDispatchedRun(runs.slice(0, 1), { since, ref: "main", actor: "rico" }), null);
});

check("jobs are matched to the label, not to any self-hosted runner", () => {
  const jobs = [
    { name: "macos / build", status: "queued", labels: ["hatchkit-mac"], runner_name: null },
    { name: "ios / build", status: "in_progress", labels: ["hatchkit-mac"], runner_name: "mac-1" },
    { name: "linux / build", status: "queued", labels: ["ubuntu-latest"], runner_name: null },
    { name: "done", status: "completed", labels: ["hatchkit-mac"], runner_name: "mac-1" },
  ];
  assert.deepEqual(jobsForLabel(jobs, "hatchkit-mac"), {
    queued: ["macos / build"],
    running: ["ios / build"],
  });
});

check("run states", () => {
  for (const s of ["queued", "in_progress", "waiting", "requested", "pending"])
    assert.ok(isActiveRun(s), s);
  assert.equal(isActiveRun("completed"), false);
  assert.equal(isActiveRun(null), false);
});

check("workflow inputs are key=value", () => {
  assert.equal(parseFields(["upload=true", "demo=false"]).problem, null);
  assert.notEqual(parseFields(["upload"]).problem, null);
  assert.notEqual(parseFields(["=x"]).problem, null);
});

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("mac-runner: all checks passed");
