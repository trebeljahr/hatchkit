// All CLI tests, including their child processes, use fixture credentials.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../", import.meta.url));
const requested = process.argv.slice(2);
const tests = requested.length
  ? requested
  : JSON.parse(readFileSync(new URL("../test-support/suite.json", import.meta.url), "utf8"));
for (const test of tests) {
  if (basename(test) !== test || !/^test-[\w-]+\.ts$/.test(test)) {
    throw new Error(`Expected a CLI test filename, got ${test}`);
  }
}
const preload = new URL("../test-support/setup.mjs", import.meta.url).href;

/** Can a file written under `dir` be executed? */
function canExecIn(dir) {
  let probeDir;
  try {
    mkdirSync(dir, { recursive: true });
    probeDir = mkdtempSync(join(dir, "exec-probe-"));
    const probe = join(probeDir, "probe");
    writeFileSync(probe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return spawnSync(probe).status === 0;
  } catch {
    return false;
  } finally {
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  }
}

// Many tests put fake binaries (gh, docker, ssh, tailscale…) on PATH from a
// directory under os.tmpdir(). A hardened host mounts /tmp noexec, and there
// every one of them fails with "Permission denied" — a failure of the host,
// not of the code under test. So when the OS temp dir cannot execute files,
// each test gets TMPDIR pointed at a scratch directory that can, which
// os.tmpdir() and mktemp both honour. Where it can (macOS), nothing changes.
const EXEC_SCRATCH_CANDIDATES = [
  join(homedir(), ".cache", "hatchkit-test-tmp"),
  join(cli, "node_modules", ".cache", "hatchkit-test-tmp"),
];
const scratchRoot = canExecIn(tmpdir())
  ? null
  : (EXEC_SCRATCH_CANDIDATES.find(canExecIn) ?? null);

let resultCode = 0;
for (const test of tests) {
  const scratch = mkdtempSync(join(scratchRoot ?? tmpdir(), "hatchkit-tests-"));
  const childTmp = scratchRoot ? join(scratch, "tmp") : undefined;
  if (childTmp) mkdirSync(childTmp);
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", test], {
      cwd: cli,
      stdio: "inherit",
      env: {
        ...process.env,
        // The fallback can sit inside a git checkout (a home directory under
        // version control), where a test's "not a repository" temp dir would
        // find that repository. The ceiling stops git's search at the root.
        ...(childTmp ? { TMPDIR: childTmp, GIT_CEILING_DIRECTORIES: scratchRoot } : {}),
        HATCHKIT_CONF_DIR: join(scratch, "config"),
        HATCHKIT_TEST_KEYCHAIN_DIR: scratch,
        // The backend is the fake installed by setup.mjs, not the OS.
        HATCHKIT_KEYCHAIN_ACCESS: "allow",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      resultCode = result.status ?? 1;
      break;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
process.exitCode = resultCode;
