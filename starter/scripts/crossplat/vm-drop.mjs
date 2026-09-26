#!/usr/bin/env node
/*
 * Hand a build to a VM: copy it into one shared drop folder that every
 * project uses, with a double-clickable launcher next to it.
 * Project-agnostic: see README.md in this folder.
 *
 *   node scripts/crossplat/vm-drop.mjs --project myapp --platform windows-arm64 \
 *     --source release/win-arm64-unpacked --launch "My App.exe" [--note "…"]
 *
 * Layout under the share (CROSSPLAT_SHARE, default ~/VMShare):
 *
 *   INDEX.txt                         every drop of every project, newest first
 *   <project>/<platform>/app/…        the build, replaced whole on each drop
 *   <project>/<platform>/run.cmd      Windows: mirror to local disk, launch
 *   <project>/<platform>/run.sh       Linux:   the same
 *   <project>/<platform>/DROP.json    what this is: commit, time, source, note
 *
 * The launchers copy the drop to the guest's own disk before starting it
 * (robocopy /MIR on Windows, rsync or cp on Linux). Running an app straight
 * off a network share is slow, trips Windows' "file from the internet"
 * prompts, and locks files the host then cannot replace on the next drop.
 *
 * With CROSSPLAT_UTM_VM set (or --start-vm <name>), the UTM VM of that name is
 * started once the drop is written. That opens UTM's window: this is for
 * people, not for agents or CI.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const UTMCTL = "/Applications/UTM.app/Contents/MacOS/utmctl";

function fail(message) {
  console.error(`\n  vm-drop — ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) fail(`unexpected argument ${key}`);
    opts[key.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
  }
  return opts;
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function windowsLauncher({ project, platform, launch }) {
  const lines = [
    "@echo off",
    "setlocal",
    `rem Written by vm-drop for ${project} (${platform}). Copies the drop to this`,
    "rem machine's disk, then starts it from there.",
    'set "SRC=%~dp0app"',
    `set "DST=%LOCALAPPDATA%\\crossplat\\${project}\\${platform}"`,
    "echo Copying %SRC% to %DST% ...",
    'robocopy "%SRC%" "%DST%" /MIR /NFL /NDL /NJH /NJS /NP >nul',
    "if %ERRORLEVEL% GEQ 8 (",
    "  echo Copy failed. Is the app still running? Quit it and try again.",
    "  pause",
    "  exit /b 1",
    ")",
    `start "" "%DST%\\${launch.replaceAll("/", "\\")}"`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function linuxLauncher({ project, platform, launch }) {
  return `#!/bin/sh
# Written by vm-drop for ${project} (${platform}). Copies the drop to this
# machine's disk, then starts it from there.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/app"
DST="\${XDG_CACHE_HOME:-$HOME/.cache}/crossplat/${project}/${platform}"
mkdir -p "$DST"
if command -v rsync >/dev/null 2>&1; then rsync -a --delete "$SRC/" "$DST/"; else rm -rf "$DST" && mkdir -p "$DST" && cp -a "$SRC/." "$DST/"; fi
chmod +x "$DST/${launch}"
exec "$DST/${launch}" "$@"
`;
}

function writeIndex(share) {
  const drops = [];
  for (const project of readdirSync(share)) {
    const projectDir = join(share, project);
    if (!statSync(projectDir).isDirectory() || project.startsWith(".")) continue;
    for (const platform of readdirSync(projectDir)) {
      const file = join(projectDir, platform, "DROP.json");
      if (existsSync(file)) {
        try {
          drops.push(JSON.parse(readFileSync(file, "utf8")));
        } catch {
          // a half-written or foreign file; leave it out of the index
        }
      }
    }
  }
  drops.sort((a, b) => String(b.droppedAt).localeCompare(String(a.droppedAt)));
  const rows = drops.map((d) =>
    [d.droppedAt, d.project, d.platform, d.commit ?? "-", d.platform.startsWith("windows") ? `${d.project}\\${d.platform}\\run.cmd` : `${d.project}/${d.platform}/run.sh`, d.note ?? ""].join("  |  "),
  );
  const text = ["Builds dropped for VM testing (newest first). Double-click the launcher.", "", ...rows, ""].join("\r\n");
  writeFileSync(join(share, "INDEX.txt"), text);
}

const opts = parseArgs(process.argv.slice(2));
const { project, platform, launch } = opts;
if (!project || !platform || !opts.source || !launch) fail("--project, --platform, --source and --launch are required");
if (!SLUG.test(project)) fail(`--project "${project}" must be a lowercase slug`);
if (!/^(windows|linux)-(x64|arm64)$/.test(platform)) fail(`--platform "${platform}" must be windows-x64, windows-arm64, linux-x64 or linux-arm64`);

const source = resolve(opts.source);
if (!existsSync(source)) fail(`${source} does not exist; build it first`);
const sourceIsDir = statSync(source).isDirectory();
const launchPath = sourceIsDir ? launch : basename(source);
if (sourceIsDir && !existsSync(join(source, launch))) fail(`${launch} is not inside ${source}`);

const share = resolve(process.env.CROSSPLAT_SHARE?.trim() || join(homedir(), "VMShare"));
const target = join(share, project, platform);
const incoming = `${target}.incoming`;

console.log(`\n  Dropping ${source}\n        -> ${target}`);
rmSync(incoming, { recursive: true, force: true });
mkdirSync(join(incoming, "app"), { recursive: true });
cpSync(source, sourceIsDir ? join(incoming, "app") : join(incoming, "app", basename(source)), { recursive: true, verbatimSymlinks: true });

const drop = {
  project,
  platform,
  launch: launchPath,
  droppedAt: new Date().toISOString(),
  source,
  commit: git(["rev-parse", "--short", "HEAD"]),
  dirty: git(["status", "--porcelain"]) ? true : false,
  note: opts.note ?? null,
};
writeFileSync(join(incoming, "DROP.json"), `${JSON.stringify(drop, null, 2)}\n`);
if (platform.startsWith("windows")) writeFileSync(join(incoming, "run.cmd"), windowsLauncher({ project, platform, launch: launchPath }));
else writeFileSync(join(incoming, "run.sh"), linuxLauncher({ project, platform, launch: launchPath }), { mode: 0o755 });

// Swap whole: a guest never sees half an old build and half a new one.
rmSync(target, { recursive: true, force: true });
renameSync(incoming, target);
writeIndex(share);

const launcher = platform.startsWith("windows") ? "run.cmd" : "run.sh";
console.log(`\n  In the VM, open the shared folder and run ${project}/${platform}/${launcher}`);
console.log(`  (every drop is listed in ${join(share, "INDEX.txt")})\n`);

const vm = opts.startVm ?? process.env.CROSSPLAT_UTM_VM?.trim();
if (vm) {
  if (!existsSync(UTMCTL)) fail(`CROSSPLAT_UTM_VM is set but UTM is not installed at ${UTMCTL}`);
  const status = spawnSync(UTMCTL, ["status", vm], { encoding: "utf8" });
  if (status.status !== 0) fail(`UTM has no VM named "${vm}":\n    ${(status.stderr || status.stdout).trim()}`);
  if (status.stdout.trim() !== "started") {
    console.log(`  Starting UTM VM "${vm}"`);
    const start = spawnSync(UTMCTL, ["start", vm], { stdio: "inherit" });
    if (start.status !== 0) fail(`utmctl start "${vm}" failed`);
  } else {
    console.log(`  UTM VM "${vm}" is already running`);
  }
}
