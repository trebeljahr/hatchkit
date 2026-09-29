// All CLI tests, including their child processes, use fixture credentials.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
let resultCode = 0;
for (const test of tests) {
  const scratch = mkdtempSync(join(tmpdir(), "hatchkit-tests-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", test], {
      cwd: cli,
      stdio: "inherit",
      env: {
        ...process.env,
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
