#!/usr/bin/env node
/*
 * This project's Windows hand-off (`pnpm prod:win`): cross-build the unpacked
 * Windows app on this Mac, then stage it in the shared drop folder through the
 * project-agnostic tool in scripts/crossplat/vm-drop.mjs. A person opens that
 * folder in a Windows VM and double-clicks the launcher.
 *
 *   pnpm prod:win                          # build, then drop
 *   pnpm prod:win --x64                    # for an x64 VM (default: arm64)
 *   pnpm prod:win --skip-build             # drop whatever release/ holds
 *   pnpm prod:win --note "auth rewrite"    # recorded in DROP.json and INDEX.txt
 *
 * This is the counterpart to `test:desktop:linux`, and the split is on
 * purpose. Linux can be proven automatically: the app is Chromium, so a
 * container can start it under a virtual framebuffer and read a screenshot
 * back over CDP. Windows cannot — there is no Windows container that runs a
 * GUI app on a Mac — so the most this can do is put a correct build one
 * double-click away from a person, and then get out of the way.
 *
 * electron-builder cross-builds an unpacked Windows app on macOS with no Wine.
 * Only `--dir`: an NSIS installer needs tooling this deliberately does not
 * pull in, and an unpacked folder is what a VM wants anyway.
 *
 * Safe for agents up to the drop itself: nothing opens on the host's screen.
 * Starting the VM is opt-in and belongs to a person — see the tool's
 * `--start-vm`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

/* electron-builder names the Windows executable after `productName`, NOT after
 * `linux.executableName` — the two differ for any project whose display name
 * is not its slug, and a launcher pointing at the wrong one fails in the VM
 * with nothing to read but "Windows cannot find …". */
const execFlag = args.indexOf("--exec");
const execName = execFlag === -1 ? "{{productName}}" : args[execFlag + 1];

const noteFlag = args.indexOf("--note");
const note = noteFlag === -1 ? null : args[noteFlag + 1];

const arch = args.includes("--x64") ? "x64" : "arm64";
const appDir = `release/win-${arch}-unpacked`;

function fail(message) {
  console.error(`\n  prod:win — ${message}\n`);
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

if (!args.includes("--skip-build")) {
  // A build whose API URL is wrong is worse than no build: it installs, opens
  // and fails on its first request, in a VM with no devtools open. The build
  // script already refuses an empty NEXT_PUBLIC_API_URL, so the only thing to
  // add here is the reason it matters.
  if (!process.env.NEXT_PUBLIC_API_URL) {
    fail(
      "NEXT_PUBLIC_API_URL is not set. Next bakes it into the bundle at build " +
        "time, so a drop built without it reaches no server and cannot be " +
        "repaired in the VM. Pass the origin this build should talk to:\n" +
        "    NEXT_PUBLIC_API_URL=https://api.example.com pnpm prod:win",
    );
  }
  run("node", ["scripts/build-desktop.mjs", "--package", "--win", `--${arch}`, "--dir"]);
}

if (!existsSync(join(repoRoot, appDir, `${execName}.exe`))) {
  fail(
    `${appDir}/${execName}.exe does not exist. electron-builder names the ` +
      "executable after `productName` in electron-builder.config.mjs. Pass " +
      "`--exec <name>` if the build names it something else.",
  );
}

run("node", [
  "scripts/crossplat/vm-drop.mjs",
  "--project",
  "{{projectSlug}}",
  "--platform",
  `windows-${arch}`,
  "--source",
  appDir,
  "--launch",
  `${execName}.exe`,
  ...(note ? ["--note", note] : []),
]);
