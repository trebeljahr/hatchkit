#!/usr/bin/env node
/*
 * Linux smoke test for an unpacked Electron build, in Docker, under Xvfb.
 * Project-agnostic: see README.md in this folder.
 *
 *   node scripts/crossplat/linux-smoke.mjs \
 *     --app-dir release/linux-arm64-unpacked --exec myapp \
 *     [--expect-url-prefix app://-] [--env KEY=VALUE]... [--arg --flag]... \
 *     [--settle-ms 5000] [--timeout-ms 60000] [--out <dir>]
 *
 * Passes when the app opens a CDP endpoint, shows a page with the expected URL
 * prefix, throws no uncaught page error and is still running after the settle
 * time. Leaves result.json, screenshot.png and app.log in --out.
 *
 * Needs a `docker` CLI talking to a daemon of the same architecture as the
 * build (colima, OrbStack or Docker Desktop). Safe for agents and CI: nothing
 * opens on the host's screen.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const IMAGE = "crossplat-linux-smoke:1";

function fail(message) {
  console.error(`\n  linux-smoke — ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    env: [],
    arg: [],
    expectUrlPrefix: "",
    settleMs: "5000",
    timeoutMs: "60000",
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) fail(`unexpected argument ${key}`);
    const name = key.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (name === "env" || name === "arg") opts[name].push(value);
    else opts[name] = value;
    i++;
  }
  return opts;
}

/** e_machine of an ELF binary, as Docker names the architecture. */
function elfArch(file) {
  const fd = openSync(file, "r");
  const header = Buffer.alloc(20);
  readSync(fd, header, 0, 20, 0);
  closeSync(fd);
  if (header.readUInt32BE(0) !== 0x7f454c46) return null;
  const machine = header.readUInt16LE(18);
  return machine === 0xb7 ? "aarch64" : machine === 0x3e ? "x86_64" : `elf-machine-${machine}`;
}

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options });
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.appDir || !opts.exec) fail("--app-dir and --exec are required");
const appDir = resolve(opts.appDir);
const execPath = join(appDir, opts.exec);
if (!existsSync(execPath)) fail(`${execPath} does not exist; build the unpacked Linux app first`);

const info = docker(["info", "--format", "{{.Architecture}}"]);
if (info.error) {
  fail(
    "no `docker` CLI on PATH. Install one (`brew install docker`) and a daemon " +
      "(`colima start`, OrbStack or Docker Desktop).",
  );
}
if (info.status !== 0) {
  fail(`the Docker daemon is not reachable (start it: \`colima start\`):\n    ${info.stderr.trim()}`);
}
const daemonArch = info.stdout.trim();
const appArch = elfArch(execPath);
// Emulating the other architecture would measure something nobody ships, and
// an Electron app under qemu is slow enough to time out on its own.
if (appArch === null) {
  fail(`${opts.exec} is not a Linux (ELF) executable; point --app-dir at an unpacked Linux build`);
}
if (appArch !== daemonArch) {
  fail(`${opts.exec} is built for ${appArch}, the Docker daemon runs ${daemonArch}; build the app for ${daemonArch}`);
}

console.log(`\n  Building ${IMAGE} (cached after the first run)`);
const build = docker(["build", "-q", "-t", IMAGE, join(here, "linux-smoke")], {
  stdio: ["ignore", "ignore", "inherit"],
});
if (build.status !== 0) fail("docker build failed");

const out = resolve(opts.out ?? join(process.cwd(), "test-results", "linux-smoke"));
mkdirSync(out, { recursive: true });
// A run that dies before writing must not report the previous run's verdict.
for (const name of ["result.json", "screenshot.png", "app.log"]) rmSync(join(out, name), { force: true });

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const envFlags = opts.env.flatMap((pair) => ["-e", pair]);
console.log(`  Running ${opts.exec} under Xvfb (${daemonArch})`);
const run = docker(
  [
    "run", "--rm", "--init", "--shm-size=1g",
    "--user", `${uid}:${gid}`,
    "-e", "HOME=/tmp",
    "-e", `SMOKE_EXEC=/app/${opts.exec}`,
    "-e", `SMOKE_ARGS=${JSON.stringify(opts.arg)}`,
    "-e", `SMOKE_EXPECT_URL_PREFIX=${opts.expectUrlPrefix}`,
    "-e", `SMOKE_SETTLE_MS=${opts.settleMs}`,
    "-e", `SMOKE_TIMEOUT_MS=${opts.timeoutMs}`,
    ...envFlags,
    "-v", `${appDir}:/app:ro`,
    "-v", `${here}/linux-smoke:/crossplat:ro`,
    "-v", `${out}:/out`,
    IMAGE, "node", "/crossplat/probe.mjs",
  ],
  { stdio: "inherit" },
);

const resultFile = join(out, "result.json");
if (existsSync(resultFile)) {
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  console.log(`\n  url:   ${result.url}\n  title: ${result.title}`);
  if (result.consoleErrors.length) {
    console.log(`  console errors (${result.consoleErrors.length}):\n    ${result.consoleErrors.slice(0, 5).join("\n    ")}`);
  }
  console.log(`  screenshot: ${join(out, "screenshot.png")}\n  app log:    ${join(out, "app.log")}\n`);
}
process.exit(run.status ?? 1);
