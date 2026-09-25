#!/usr/bin/env node
/*
 * This project's Linux smoke test (`pnpm test:desktop:linux`): build the
 * unpacked Linux app for the Docker daemon's architecture, then start it in a
 * container under Xvfb through the project-agnostic runner in
 * scripts/crossplat/linux-smoke.mjs.
 *
 *   pnpm test:desktop:linux                # build, then smoke
 *   pnpm test:desktop:linux --skip-build   # smoke whatever release/ holds
 *   pnpm test:desktop:linux --exec other   # a different executable name
 *
 * This is the proof that the app RENDERS on Linux. The e2e harness cannot
 * give it: on X11 a window that was never shown has no surface to copy from,
 * so a screenshot of a headless launch is queued and never answered. Here the
 * window is shown, on Xvfb's virtual display, which reaches no real screen.
 *
 * Safe for agents: nothing opens on the host's screen.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

/** electron-builder's `linux.executableName`. Overridable, so a project that
 *  renames the binary does not have to edit this script. */
const execFlag = args.indexOf("--exec");
const execName = execFlag === -1 ? "{{projectSlug}}" : args[execFlag + 1];

function fail(message) {
  console.error(`\n  test:desktop:linux — ${message}\n`);
  process.exit(1);
}

function run(command, cmdArgs, env = {}) {
  const result = spawnSync(command, cmdArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Asked first, so a missing daemon costs seconds rather than a whole build.
const info = spawnSync("docker", ["info", "--format", "{{.Architecture}}"], { encoding: "utf8" });
if (info.error) fail("no `docker` CLI on PATH (`brew install docker`, then `colima start`).");
if (info.status !== 0) fail("the Docker daemon is not reachable; start it with `colima start`.");
const arch = info.stdout.trim() === "aarch64" ? "arm64" : "x64";
// electron-builder names the x64 folder without an arch suffix.
const appDir = arch === "arm64" ? "release/linux-arm64-unpacked" : "release/linux-unpacked";

if (!args.includes("--skip-build")) {
  // No API is needed to boot to the login screen; a dead loopback port keeps
  // the build's API check honest without pointing a test at a real server.
  const env = process.env.NEXT_PUBLIC_API_URL ? {} : { NEXT_PUBLIC_API_URL: "http://127.0.0.1:59999" };
  run("node", ["scripts/build-desktop.mjs", "--package", "--linux", `--${arch}`, "--dir"], env);
}

if (!existsSync(join(repoRoot, appDir, execName))) {
  fail(
    `${appDir}/${execName} does not exist. The runner needs the executable's name; ` +
      "electron-builder takes it from `linux.executableName` in electron-builder.config.mjs. " +
      "Pass `--exec <name>` if the build names it something else.",
  );
}

run("node", [
  "scripts/crossplat/linux-smoke.mjs",
  "--app-dir", appDir,
  "--exec", execName,
  "--expect-url-prefix", "app://-",
  // Deliberately NOT {{envPrefix}}_HEADLESS: a never-shown window gives CDP no
  // frames on X11 and the screenshot hangs. Xvfb is virtual, so the shown
  // window reaches no real screen.
  "--env", "{{envPrefix}}_USER_DATA_DIR=/tmp/{{projectSlug}}-smoke",
  // A container has no update feed to reach, and a check would add a network
  // timeout to every run.
  "--env", "{{envPrefix}}_DISABLE_UPDATES=1",
  "--out", "test-results/linux-smoke",
]);
