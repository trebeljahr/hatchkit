/**
 * The maintainer release flow: cli/scripts/release*.mjs.
 *
 * The v0.2.19 release stopped half-way: the first publish failed with
 * EOTP because npm's 2FA prompt had no terminal, after the version
 * commit was already pushed; the lightweight tag was not pushed at all;
 * and nested `pnpm` calls failed in a shell without pnpm on PATH.
 *
 * Each case runs the real scripts, copied into a scratch monorepo whose
 * `origin` is a bare repo next to it. Fake `pnpm` and `npm` record every
 * call and keep a registry file, so nothing reaches npm, GitHub or the
 * global install. Git runs without the user's config.
 *
 * What it pins:
 *   · every publish gets the parent's stdin (npm's 2FA prompt needs it);
 *   · the CLI is published with pnpm (which rewrites `workspace:*`);
 *   · nothing is pushed until every package is on npm;
 *   · `resume` publishes only what npm lacks, then pushes;
 *   · a new bump on top of an unfinished release is refused;
 *   · the tag is annotated and reaches the remote;
 *   · a release started without `pnpm` on PATH still runs nested `pnpm`.
 *
 * Run: pnpm --filter hatchkit test:release-flow
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = join(import.meta.dirname, "scripts");
const RELEASE_SCRIPTS = [
  "release.mjs",
  "release-lib.mjs",
  "release-prep.mjs",
  "release-bump.mjs",
  "release-packages.mjs",
];

interface Pnpm {
  command: string;
  args: string[];
}
interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
const lib = (await import(pathToFileURL(join(SCRIPTS, "release-lib.mjs")).href)) as {
  resolvePnpm: (opts: {
    env: Record<string, string | undefined>;
    execPath?: string;
    onPath?: (name: string) => boolean;
  }) => Pnpm | null;
  isPublished: (
    name: string,
    version: string,
    opts: { run: (args: string[]) => RunResult },
  ) => boolean;
  publishCommand: (
    pnpm: Pnpm,
    cwd: string,
    env: object,
  ) => { command: string; args: string[]; options: { stdio: unknown } };
  pushArgs: (opts: { remote: string; branchRef?: string; version: string }) => string[];
};

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

// A space in every path catches unquoted paths in the shim and wrappers.
const root = mkdtempSync(join(tmpdir(), "release flow "));

// ── fake tools ─────────────────────────────────────────────────────────

const FAKE_PNPM = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
// stdio "ignore" hands the child /dev/null; "inherit" hands it ours.
const stdin = fs.fstatSync(0);
const devNull = fs.statSync("/dev/null");
const stdinIsDevNull = stdin.isCharacterDevice() && stdin.rdev === devNull.rdev;
fs.appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ tool: "pnpm", args, cwd: process.cwd(), stdinIsDevNull }) + "\\n",
);
if (args[0] === "run" && args[1] === "build" && process.env.FAKE_NESTED === "1") {
  // The CLI's build script calls pnpm itself.
  const nested = spawnSync("/bin/sh", ["-c", "pnpm nested-probe"], { stdio: "inherit" });
  process.exit(nested.status ?? 1);
}
if (args[0] === "run" && process.env.FAKE_GATE_FAIL === args[1]) process.exit(1);
if (args[0] === "publish") {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (process.env.FAKE_PUBLISH_FAIL === pkg.name) {
    console.error("npm error code EOTP");
    process.exit(1);
  }
  fs.appendFileSync(process.env.FAKE_REGISTRY, pkg.name + "@" + pkg.version + "\\n");
}
`;

const FAKE_NPM = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ tool: "npm", args, cwd: process.cwd() }) + "\\n",
);
if (args[0] === "view") {
  const spec = args[1];
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const wanted = at > 0 ? spec.slice(at + 1) : null;
  const versions = fs
    .readFileSync(process.env.FAKE_REGISTRY, "utf8")
    .split("\\n")
    .filter((line) => line.startsWith(name + "@"))
    .map((line) => line.slice(name.length + 1));
  const found = wanted ? versions.includes(wanted) : versions.length > 0;
  if (!found) {
    console.error("npm error code E404");
    process.exit(1);
  }
  console.log(wanted ?? versions[versions.length - 1]);
}
if (args[0] === "publish") {
  console.error("fake npm: publishing must go through pnpm");
  process.exit(1);
}
`;

const toolBin = join(root, "tool-bin");
const pnpmBin = join(root, "pnpm-bin");
const fakes = join(root, "fakes");
for (const dir of [toolBin, pnpmBin, fakes]) mkdirSync(dir);
writeFileSync(join(fakes, "pnpm.cjs"), FAKE_PNPM);
writeFileSync(join(fakes, "npm.cjs"), FAKE_NPM);
symlinkSync(process.execPath, join(toolBin, "node"));
const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
symlinkSync(realpathSync(gitPath), join(toolBin, "git"));
wrapper(join(toolBin, "npm"), join(fakes, "npm.cjs"));
wrapper(join(pnpmBin, "pnpm"), join(fakes, "pnpm.cjs"));

function wrapper(path: string, target: string): void {
  writeFileSync(path, `#!/bin/sh\nexec node ${JSON.stringify(target)} "$@"\n`);
  chmodSync(path, 0o755);
}

// ── scratch monorepo ──────────────────────────────────────────────────

const DEV = ["dev-shared", "dev-plugin-next", "dev-plugin-vite"];
const ALL = [...DEV.map((name) => `@hatchkit/${name}`), "@hatchkit/mcp", "hatchkit"];
let repoCount = 0;

interface Repo {
  dir: string;
  remote: string;
  log: string;
  registry: string;
  tmp: string;
}

function makeRepo(version = "0.3.0"): Repo {
  const base = join(root, `repo ${++repoCount}`);
  const dir = join(base, "hatchkit");
  const remote = join(base, "origin.git");
  const tmp = join(base, "tmp");
  mkdirSync(join(dir, "cli", "scripts"), { recursive: true });
  mkdirSync(tmp);
  for (const file of RELEASE_SCRIPTS) {
    copyFileSync(join(SCRIPTS, file), join(dir, "cli", "scripts", file));
  }
  writeJson(join(dir, "cli", "package.json"), {
    name: "hatchkit",
    version,
    packageManager: "pnpm@10.33.2",
    dependencies: { "@hatchkit/dev-shared": "workspace:*" },
  });
  for (const name of DEV) {
    mkdirSync(join(dir, "packages", name), { recursive: true });
    writeJson(join(dir, "packages", name, "package.json"), { name: `@hatchkit/${name}`, version });
  }
  mkdirSync(join(dir, "mcp"));
  writeJson(join(dir, "mcp", "package.json"), { name: "@hatchkit/mcp", version });
  const repo: Repo = {
    dir,
    remote,
    log: join(base, "calls.jsonl"),
    registry: join(base, "registry.txt"),
    tmp,
  };
  writeFileSync(repo.log, "");
  writeFileSync(repo.registry, ALL.map((name) => `${name}@${version}\n`).join(""));

  const hooks = join(base, "no-hooks");
  mkdirSync(hooks);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Release Test"]);
  git(repo, ["config", "user.email", "release-test@example.invalid"]);
  git(repo, ["config", "core.hooksPath", hooks]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["init", "-q", "--bare", remote], base);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  return repo;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gitEnv(): Record<string, string> {
  return {
    PATH: toolBin,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(repo: Repo, args: string[], cwd = repo.dir): string {
  const res = spawnSync(join(toolBin, "git"), args, { cwd, env: gitEnv(), encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function remoteGit(repo: Repo, args: string[]): RunResult {
  const res = spawnSync(join(toolBin, "git"), ["--git-dir", repo.remote, ...args], {
    env: gitEnv(),
    encoding: "utf-8",
  });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
}

function release(
  repo: Repo,
  args: string[],
  { pnpmOnPath = true, env = {} as Record<string, string> } = {},
): RunResult {
  const res = spawnSync(
    process.execPath,
    [join(repo.dir, "cli", "scripts", "release.mjs"), ...args],
    {
      cwd: join(repo.dir, "cli"),
      // A pipe, so a publish that got /dev/null instead shows in the log.
      input: "",
      encoding: "utf-8",
      env: {
        ...gitEnv(),
        PATH: pnpmOnPath ? `${toolBin}${delimiter}${pnpmBin}` : toolBin,
        TMPDIR: repo.tmp,
        FAKE_LOG: repo.log,
        FAKE_REGISTRY: repo.registry,
        ...env,
      },
    },
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

interface Call {
  tool: string;
  args: string[];
  cwd: string;
  stdinIsDevNull?: boolean;
}

function calls(repo: Repo): Call[] {
  return readFileSync(repo.log, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
}

/** Package names in the order pnpm was asked to publish them (failed tries too). */
function publishAttempts(repo: Repo, from = 0): string[] {
  return calls(repo)
    .slice(from)
    .filter((call) => call.tool === "pnpm" && call.args[0] === "publish")
    .map((call) => JSON.parse(readFileSync(join(call.cwd, "package.json"), "utf-8")).name);
}

function cliVersion(repo: Repo): string {
  return JSON.parse(readFileSync(join(repo.dir, "cli", "package.json"), "utf-8")).version;
}

// ── units ──────────────────────────────────────────────────────────────

await test("resolvePnpm prefers the running pnpm, then PATH, then corepack", () => {
  const none = () => false;
  const viaEntry = lib.resolvePnpm({
    env: { npm_execpath: "/c/pnpm/10.33.2/bin/pnpm.cjs" },
    execPath: "/n/node",
    onPath: none,
  });
  assert.deepEqual(
    { command: viaEntry?.command, args: viaEntry?.args },
    { command: "/n/node", args: ["/c/pnpm/10.33.2/bin/pnpm.cjs"] },
  );
  // npm sets npm_execpath too; that one is not pnpm.
  const underNpm = lib.resolvePnpm({
    env: { npm_execpath: "/n/lib/node_modules/npm/bin/npm-cli.js" },
    onPath: (name) => name === "pnpm",
  });
  assert.equal(underNpm?.command, "pnpm");
  const corepack = lib.resolvePnpm({ env: {}, onPath: (name) => name === "corepack" });
  assert.deepEqual([corepack?.command, ...(corepack?.args ?? [])], ["corepack", "pnpm"]);
  assert.equal(lib.resolvePnpm({ env: {}, onPath: none }), null);
});

await test("isPublished reads npm view and only treats E404 as missing", () => {
  const view = (res: RunResult) => () => res;
  assert.equal(
    lib.isPublished("hatchkit", "0.2.19", {
      run: view({ status: 0, stdout: "0.2.19\n", stderr: "" }),
    }),
    true,
  );
  assert.equal(
    lib.isPublished("hatchkit", "9.9.9", {
      run: view({ status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 No match" }),
    }),
    false,
  );
  assert.throws(
    () =>
      lib.isPublished("hatchkit", "0.2.20", {
        run: view({ status: 1, stdout: "", stderr: "npm error code ENOTFOUND" }),
      }),
    /ENOTFOUND/,
  );
});

await test("publishes inherit the terminal; the push names the tag", () => {
  const cmd = lib.publishCommand({ command: "pnpm", args: [] }, "/x", {});
  assert.equal(cmd.options.stdio, "inherit");
  assert.deepEqual(cmd.args, ["publish", "--access", "public", "--no-git-checks"]);
  assert.deepEqual(
    lib.pushArgs({ remote: "origin", branchRef: "refs/heads/main", version: "1.2.3" }),
    ["push", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/v1.2.3"],
  );
});

// ── whole flow ─────────────────────────────────────────────────────────

await test("a patch release publishes all five packages, then pushes an annotated tag", () => {
  const repo = makeRepo();
  const run = release(repo, ["patch"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(cliVersion(repo), "0.3.1");
  assert.deepEqual(publishAttempts(repo), ALL);
  for (const call of calls(repo).filter((c) => c.tool === "pnpm" && c.args[0] === "publish")) {
    assert.equal(call.stdinIsDevNull, false, `publish in ${call.cwd} got /dev/null as stdin`);
  }
  const npmCalls = calls(repo).filter((c) => c.tool === "npm");
  assert.ok(!npmCalls.some((c) => c.args[0] === "publish"), "the CLI must not use npm publish");
  assert.ok(
    npmCalls.some((c) => c.args.join(" ") === "install -g hatchkit@0.3.1"),
    "global install ran",
  );

  assert.equal(git(repo, ["cat-file", "-t", "v0.3.1"]), "tag");
  assert.equal(
    remoteGit(repo, ["rev-parse", "refs/tags/v0.3.1^{commit}"]).stdout,
    git(repo, ["rev-parse", "HEAD"]),
  );
  assert.equal(
    remoteGit(repo, ["rev-parse", "refs/heads/main"]).stdout,
    git(repo, ["rev-parse", "HEAD"]),
  );
});

await test("a stopped publish pushes nothing; resume publishes the rest and pushes", () => {
  const repo = makeRepo();
  const before = remoteGit(repo, ["rev-parse", "refs/heads/main"]).stdout;

  const stopped = release(repo, ["patch"], {
    env: { FAKE_PUBLISH_FAIL: "@hatchkit/dev-plugin-vite" },
  });
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /nothing is pushed yet/);
  assert.match(stopped.stderr, /pnpm release:resume/);
  assert.deepEqual(publishAttempts(repo), ALL.slice(0, 3), "stops at the failed publish");
  assert.ok(!readFileSync(repo.registry, "utf-8").includes("dev-plugin-vite@0.3.1"));
  assert.equal(remoteGit(repo, ["rev-parse", "refs/heads/main"]).stdout, before, "main not pushed");
  assert.notEqual(remoteGit(repo, ["rev-parse", "--verify", "refs/tags/v0.3.1"]).status, 0);

  // Starting over would bump past the unfinished v0.3.1.
  const again = release(repo, ["patch"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /v0\.3\.1 is committed and tagged at HEAD/);
  assert.equal(cliVersion(repo), "0.3.1");

  const mark = calls(repo).length;
  const resumed = release(repo, ["resume"]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(publishAttempts(repo, mark), ["@hatchkit/dev-plugin-vite", "@hatchkit/mcp", "hatchkit"]);
  assert.equal(
    remoteGit(repo, ["rev-parse", "refs/tags/v0.3.1^{commit}"]).stdout,
    git(repo, ["rev-parse", "HEAD"]),
  );

  // Everything is out: a second resume publishes nothing and succeeds.
  const done = calls(repo).length;
  assert.equal(release(repo, ["resume"]).status, 0);
  assert.deepEqual(publishAttempts(repo, done), []);
});

await test("resume refuses a dirty tree and a release that was never bumped", () => {
  const repo = makeRepo();
  const untagged = release(repo, ["resume"]);
  assert.notEqual(untagged.status, 0);
  assert.match(untagged.stderr, /no tag v0\.3\.0/);

  writeFileSync(join(repo.dir, "stray.txt"), "x");
  const dirty = release(repo, ["resume"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /working tree has changes/);
  assert.deepEqual(publishAttempts(repo), []);
});

await test("without pnpm on PATH, nested pnpm calls run the pnpm that started the release", () => {
  const repo = makeRepo();
  const run = release(repo, ["patch"], {
    pnpmOnPath: false,
    env: { npm_execpath: join(fakes, "pnpm.cjs"), FAKE_NESTED: "1" },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(
    calls(repo).some((c) => c.tool === "pnpm" && c.args[0] === "nested-probe"),
    "the build's nested `pnpm` reached the fake",
  );
  assert.deepEqual(publishAttempts(repo), ALL);
  assert.deepEqual(readdirSync(repo.tmp), [], "the PATH shim is removed afterwards");
});

await test("with no pnpm anywhere, the release stops before it bumps", () => {
  const repo = makeRepo();
  const head = git(repo, ["rev-parse", "HEAD"]);
  const run = release(repo, ["patch"], { pnpmOnPath: false });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /pnpm not found\. Nothing was changed/);
  assert.match(run.stderr, /npm install -g pnpm@10\.33\.2/);
  assert.equal(cliVersion(repo), "0.3.0");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
});

await test("failed checks or packed-install smoke refuse every publish", () => {
  for (const gate of ["check", "check:package"]) {
    const repo = makeRepo();
    const result = release(repo, ["patch"], { env: { FAKE_GATE_FAIL: gate } });
    assert.notEqual(result.status, 0);
    assert.deepEqual(publishAttempts(repo), []);
    assert.equal(remoteGit(repo, ["rev-parse", "main"]).stdout.trim(), git(repo, ["rev-parse", "HEAD~1"]));
  }
});

rmSync(root, { recursive: true, force: true });

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nrelease-flow: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
