#!/usr/bin/env node
// Starts shared, client, server and (optionally) docs for development.
//
// Modes — three of them, because the callers want opposite things:
//
//   node scripts/dev.mjs             The pinned ports — the DEV_*_PORT
//                                    constants below, which is the one place
//                                    they are written down. A busy port warns
//                                    and falls back to a random high one for
//                                    that run. Inside a linked git worktree
//                                    this behaves like --auto.
//   node scripts/dev.mjs --auto      Every port auto-picked from 49152-65535,
//                                    for agents and second instances.
//   node scripts/dev.mjs --fixed     The pinned ports or nothing: exit non-zero
//                                    when one is busy. Pinned even in a
//                                    worktree.
//   node scripts/dev.mjs --docs      Also start the docs site.
//   node scripts/dev.mjs --dry-run   Resolve and print the plan, start nothing.
//
// Environment overrides — each one beats the mode:
//
//   PORT, API_PORT, DOCS_PORT   pin one port each
//   WEB_HOST                    browser-facing host (default localhost)
//   TRUSTED_ORIGINS             extra origins the API trusts, comma-separated
//   WATCHPACK_POLLING=true      poll instead of watching, when watches run out
//   FORCE_COLOR                 forwarded to the runner and its children

import { execSync, spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { createServer } from "net";
import { constants } from "os";
import { dirname, resolve } from "path";
import {
  describeStrayWatchers,
  describeWatcherFailure,
  findRepoWatchers,
  parsePs,
  watcherFailureIn,
} from "./lib/dev-watchers.mjs";
import { terminateGroup } from "./lib/process-group.mjs";

const autoMode = process.argv.includes("--auto");
const fixedMode = process.argv.includes("--fixed");
const includeDocs = process.argv.includes("--docs");
// Resolve ports and print the plan without building or starting anything.
const dryRun = process.argv.includes("--dry-run");

const repoRoot = process.cwd();

// The one host the browser talks to. localhost and 127.0.0.1 are different
// origins AND different sites, so mixing them breaks CORS and stops
// SameSite=Lax session cookies from reaching the API. Everything
// browser-facing — the printed URLs, the client's API/WS URLs and
// FRONTEND_URL — therefore uses this single value.
const WEB_HOST = process.env.WEB_HOST ?? "localhost";

// ── Ports ────────────────────────────────────────────────────────────
//
// The default PINS all three. Every client that is not the web app bakes or
// stores the API origin — a browser extension bakes it at build time, desktop
// and mobile shells bake it too — and a port that moves per run makes each of
// them a copy-paste chore. Saved logins, password managers, bookmarks and
// OAuth redirect allowlists key off the client origin for the same reason.
//
// Agents get `--auto` (automatic in a worktree), which is where random ports
// belong: nothing types those, and several can run at once.
//
// Change them here — one number, one place. Anything that bakes the API URL in
// at build time has to follow.
const DEV_CLIENT_PORT = 3000;
const DEV_API_PORT = 5000;
const DEV_DOCS_PORT = 4000;

// `--auto`, and any pinned port that turns out to be busy, comes out of the
// ephemeral range, which no conventional dev server uses.
const HIGH_PORT_MIN = 49152;
const HIGH_PORT_MAX = 65535;

/**
 * True in a linked worktree. Git points `--git-dir` at
 * `<main>/.git/worktrees/<name>` there while `--git-common-dir` still points at
 * the main `.git`, so the two differ only in a worktree.
 *
 * Worktrees are where agents run, often several at once. They must never fight
 * over the pinned ports, so the default behaves like `--auto` there even if
 * someone forgets the longer command. `--fixed` overrides that, for the case
 * where a worktree is the thing being tested against a baked-in API URL.
 */
function isLinkedWorktree() {
  try {
    const read = (flag) =>
      execSync(`git rev-parse ${flag}`, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    return (
      resolve(repoRoot, read("--git-dir")) !==
      resolve(repoRoot, read("--git-common-dir"))
    );
  } catch {
    return false; // not a git checkout at all — treat it as the main one
  }
}

const inWorktree = isLinkedWorktree();
const autoPorts = autoMode || inWorktree;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

// Ports handed out in this run. A free port stays free until something listens
// on it, so without this two children could be given the same number.
const claimed = new Set();

async function findRandomFreePort(maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = randomInt(HIGH_PORT_MIN, HIGH_PORT_MAX);
    if (claimed.has(port)) continue;
    if (await isPortFree(port)) {
      claimed.add(port);
      return port;
    }
  }
  throw new Error(
    `Could not find a free port in ${HIGH_PORT_MIN}-${HIGH_PORT_MAX} after ${maxAttempts} attempts`,
  );
}

/**
 * An explicit env var wins, then the mode, then the pinned port.
 *
 * A busy pinned port does not block dev: say who to look for and fall back to a
 * random one for this run. `--fixed` is the opposite promise — a caller that
 * asked for exact ports wants to hear that it cannot have them, not to be
 * silently moved somewhere the client it is testing cannot reach.
 */
async function pickPort(envValue, pinned, label) {
  if (envValue) return parseInt(envValue, 10);
  // --fixed still wins inside a worktree: asking for these exact ports is the
  // one reason to run it there (testing a client that has the API baked in).
  if (autoPorts && !fixedMode) return findRandomFreePort();

  if (await isPortFree(pinned)) {
    claimed.add(pinned);
    return pinned;
  }

  const who = `lsof -nP -iTCP:${pinned} -sTCP:LISTEN`;
  if (fixedMode) {
    console.error(
      `\n  ${label} port ${pinned} is in use, and --fixed means exactly these` +
        `\n  ports. See who has it:  ${who}\n`,
    );
    process.exit(1);
  }

  const fallback = await findRandomFreePort();
  console.warn(
    `\n  ${label} port ${pinned} is already in use — something else is` +
      `\n  listening on it (${who}).` +
      `\n  Using ${fallback} for this run.\n`,
  );
  return fallback;
}

const clientPort = await pickPort(process.env.PORT, DEV_CLIENT_PORT, "Client");
const apiPort = await pickPort(process.env.API_PORT, DEV_API_PORT, "API");
// Only when --docs asked for it: a docs port nobody starts should not warn
// about being busy, nor fail a --fixed run over it.
const docsPort = includeDocs
  ? await pickPort(process.env.DOCS_PORT, DEV_DOCS_PORT, "Docs")
  : null;

// ── Trusted origins ──────────────────────────────────────────────────
//
// The API refuses a cross-origin request from anything not on this list. A
// browser sends `Sec-Fetch-Site`/`Sec-Fetch-Mode` on every real fetch, which
// makes the auth layer validate `Origin` even with no cookie on the request,
// so a missing entry answers sign-in with `403 INVALID_ORIGIN` before the
// password is ever checked.
//
// These are passed on the server child's command line rather than written into
// an env file, because a key already in the environment wins over the file.

// The native shells' document origins. A Capacitor WebView serves the bundled
// app from capacitor://localhost (iOS) or https://localhost (Android), and an
// Electron build serving a static export from its own scheme (app://-) is
// cross-site to the API for the same reason. Empty until the project actually
// ships one of those shells — every entry here widens what the dev API trusts.
const NATIVE_ORIGINS = [];

// An unpacked extension's id is a hash of the absolute path Chrome loaded it
// from, so the dev server can DERIVE its origin instead of asking a person to
// run `pnpm run extension:id` and paste the result into an env file. The id is
// a fact about the path, not a secret.
//
// The derivation is NOT repeated here. `scripts/extension-package.mjs id`
// already owns it, and a dev server that trusts a DIFFERENT id than Chrome
// assigns fails as a flat `403 INVALID_ORIGIN` with nothing on either side
// saying the two disagreed — so there is exactly one implementation and this
// asks it.
//
// Dev only. A production extension's origin comes from a pinned manifest key
// and belongs in the deployed server's env, where it is reviewed.
const extensionOrigins = readDevExtensionOrigins();

const trustedOrigins = [
  ...(process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...extensionOrigins,
  ...NATIVE_ORIGINS,
];

const portMode = fixedMode
  ? "pinned ports (--fixed: no fallback)"
  : autoPorts
    ? `auto ports (${autoMode ? "--auto" : "worktree"})`
    : "pinned ports";
console.log(`\n  Mode:     ${portMode}`);
console.log(`  Client:   http://${WEB_HOST}:${clientPort}`);
if (includeDocs) {
  console.log(`  Docs:     http://${WEB_HOST}:${docsPort}`);
}
console.log(`  Server:   http://${WEB_HOST}:${apiPort}`);
console.log(`  Trusts:   ${trustedOrigins.length > 0 ? trustedOrigins.join(", ") : "(same-origin only)"}`);
console.log();

if (dryRun) process.exit(0);

// `@starter/shared` resolves through package.json exports to dist/. The server
// and the client both consume it, so a fresh checkout with no dist/ fails with
// ERR_MODULE_NOT_FOUND. Build once here, then watch in parallel so edits
// propagate.
console.log("  Building @starter/shared...");
try {
  execSync("pnpm --filter @starter/shared run build", { stdio: "inherit" });
} catch {
  process.exit(1);
}

const clientEnv = [
  `PORT=${clientPort}`,
  `NEXT_PUBLIC_API_URL=http://${WEB_HOST}:${apiPort}`,
  `NEXT_PUBLIC_WS_URL=ws://${WEB_HOST}:${apiPort}`,
].join(" ");

const serverEnv = [
  `PORT=${apiPort}`,
  `FRONTEND_URL=http://${WEB_HOST}:${clientPort}`,
  `TRUSTED_ORIGINS=${trustedOrigins.join(",")}`,
].join(" ");

// The server runs under `tsx watch`, whose built-in `**/node_modules/**` ignore
// resolves against the PACKAGE directory. In a pnpm workspace that leaves the
// root dependency tree — node_modules/.pnpm, thousands of files — watched by
// every server process, which is how a machine runs out of file descriptors.
// Excluding it explicitly keeps reload from packages/shared/src intact: that
// path is a workspace link, not a copy under the root node_modules.
// The exclude itself lives in that package's own `dev` script, not here, so a
// project that edits it sees the change under `pnpm dev` too.
const serverCommand = "pnpm --filter @starter/server run dev";

const processes = [
  "pnpm --filter @starter/shared run dev",
  `node scripts/wait-for-port.mjs ${apiPort} && ${clientEnv} pnpm --filter @starter/client run dev`,
  `${serverEnv} ${serverCommand}`,
];
const names = ["shared", "client", "server"];
const colors = ["green", "yellow", "cyan"];

if (includeDocs) {
  processes.push(`pnpm --filter docs-site run start -- --port ${docsPort}`);
  names.push("docs");
  colors.push("magenta");
}

// ── Run, and take every child down with this script ──────────────────
//
// A signal aimed at this script's pid alone — SIGTERM from a preview or agent
// harness, SIGKILL, a crash — reaches this script only. The runner, the shells
// under it, pnpm, `tsx watch` and `next dev` are then reparented to init and
// keep running for days, each `tsx watch` holding thousands of file watches,
// until a fresh `next dev` can open none and answers 404 on every route while
// public/ files still load.
//
// So the runner leads a process group of its own, and every way out goes
// through `terminateGroup`, which signals that group and so reaches every
// descendant, including ones whose parent is already gone:
//
//   * SIGINT / SIGTERM / SIGHUP to this script  → forwarded to the group
//   * the runner exiting on its own             → leftovers in the group stopped
//   * this script's stdout breaking (EPIPE)     → a closed agent shell is a
//                                                 hangup, not a crash
//   * this script reparented (its parent died)  → treated as a hangup
//   * SIGKILL or a crash of this script         → `lib/dev-reaper.mjs`, which
//     sees its stdin pipe close and stops the group
//
// Output is piped through here rather than inherited, so a watcher that cannot
// be opened is caught and explained instead of scrolling past.
const posix = process.platform !== "win32";
const repoCommonRoot = gitCommonRoot();

// Preflight: watchers of this repo whose run is gone. A warning only — which
// of them are safe to stop is not this script's call, and nothing here ever
// kills a process it did not start.
if (posix) {
  const stray = describeStrayWatchers(scanWatchers(), repoCommonRoot);
  if (stray) console.warn(stray);
}

// Resolved rather than shelled out to: `npx concurrently` adds a process layer
// between this script and the group leader for nothing.
const require = createRequire(import.meta.url);
const concurrentlyBin = resolve(
  dirname(require.resolve("concurrently/package.json")),
  "dist/bin/concurrently.js",
);

// --kill-others-on-fail, NOT -k: a child exiting 0 must not tear down the rest.
// `next dev` can return 0 while its dev server keeps running, and with -k that
// clean exit killed the API server and the tsc watcher with it.
const runner = spawn(
  process.execPath,
  [
    concurrentlyBin,
    "--kill-others-on-fail",
    "-n",
    names.join(","),
    "-c",
    colors.join(","),
    ...processes,
  ],
  {
    // A group of its own (setsid). stdin is ignored: nothing in the tree reads
    // it, and a reader outside the terminal's foreground group would stop.
    detached: posix,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Piping would otherwise strip the runner's (and its children's) colors.
      ...(process.stdout.isTTY && !process.env.FORCE_COLOR
        ? { FORCE_COLOR: String(colorLevel(process.stdout.getColorDepth())) }
        : {}),
    },
  },
);
const runnerGroup = runner.pid;

if (posix && runnerGroup) {
  const reaper = resolve(repoRoot, "scripts/lib/dev-reaper.mjs");
  spawn(process.execPath, [reaper, String(runnerGroup)], {
    detached: true,
    // The pipe on stdin is the whole mechanism: the kernel closes it when this
    // script exits, however it exits.
    stdio: ["pipe", "ignore", "ignore"],
  }).unref();
}

const reportedFailures = new Set();
const watchOutput = (source, target) => {
  let partial = "";
  source.on("data", (chunk) => {
    target.write(chunk);
    const lines = (partial + chunk.toString()).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const code = watcherFailureIn(line);
      if (!code || reportedFailures.has(code)) continue;
      reportedFailures.add(code); // the box is worth printing once, not per line
      const prefix = line.match(/\[(\w+)\]/)?.[1] ?? null;
      console.error(
        describeWatcherFailure({
          code,
          source: prefix,
          watchers: posix ? scanWatchers() : [],
          repoRoot: repoCommonRoot,
        }),
      );
    }
  });
};
watchOutput(runner.stdout, process.stdout);
watchOutput(runner.stderr, process.stderr);

let stopping = null;
const stop = (signal) => {
  if (stopping) {
    // A second Ctrl+C means now.
    if (signal === "SIGINT" && runnerGroup) {
      try {
        process.kill(-runnerGroup, "SIGKILL");
      } catch {}
      process.exit(128 + constants.signals.SIGINT);
    }
    return;
  }
  stopping = signal;
  if (!posix) {
    runner.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    return;
  }
  // SIGINT keeps Next's and tsx's own Ctrl+C handling; anything else is a stop.
  const forwarded = signal === "SIGINT" ? "SIGINT" : "SIGTERM";
  terminateGroup(runnerGroup, { signal: forwarded }).then(() =>
    process.exit(128 + constants.signals[signal]),
  );
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(signal));
}
// A reader that went away (a closed agent shell) is a hangup, not a crash.
process.stdout.on("error", () => stop("SIGHUP"));
process.stderr.on("error", () => stop("SIGHUP"));

// Reparenting means whoever started this is gone. Polling is the only portable
// way to notice: no signal is delivered for it.
const startParent = process.ppid;
setInterval(() => {
  if (process.ppid !== startParent) stop("SIGHUP");
}, 2000).unref();

runner.on("exit", async (code, signal) => {
  // The runner is gone, but a child it lost track of may not be — a Next dev
  // server can outlive the `next dev` that started it.
  if (posix && runnerGroup) await terminateGroup(runnerGroup);
  if (stopping) process.exit(128 + constants.signals[stopping]);
  process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1));
});

/** `getColorDepth()` bits → the FORCE_COLOR level chalk and supports-color read. */
function colorLevel(depth) {
  return depth >= 24 ? 3 : depth >= 8 ? 2 : 1;
}

/** The directory holding the common `.git`, so worktrees resolve to one root. */
function gitCommonRoot() {
  try {
    const commonDir = execSync(
      "git rev-parse --path-format=absolute --git-common-dir",
      { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    return dirname(commonDir);
  } catch {
    return repoRoot;
  }
}

// This run's own watchers are attached to it, so they are never reported.
function scanWatchers() {
  try {
    const ps = execSync("ps -Ao pid=,ppid=,etime=,command=", {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    }).toString();
    return findRepoWatchers(parsePs(ps), repoCommonRoot);
  } catch {
    return [];
  }
}

/**
 * The dev extension's `chrome-extension://<id>` origin, or none.
 *
 * Empty for a project with no extension package: an empty or bogus origin in
 * the trust list is worse than a short list, because it looks like the id was
 * derived and then failed. A packager that cannot answer is reported and
 * skipped rather than failing the dev run — the rest of the stack still works,
 * only the extension cannot reach it.
 */
function readDevExtensionOrigins() {
  const packager = resolve(repoRoot, "scripts/extension-package.mjs");
  if (!existsSync(resolve(repoRoot, "packages/extension")) || !existsSync(packager)) return [];
  const result = spawnSync(process.execPath, [packager, "id"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const origin = result.stdout?.trim().split("\n").pop() ?? "";
  if (result.status !== 0 || !origin.startsWith("chrome-extension://")) {
    console.warn(
      "\n  Could not derive the dev extension's origin from" +
        "\n  `node scripts/extension-package.mjs id`; the extension will be refused" +
        "\n  by CORS until its origin is in TRUSTED_ORIGINS.\n",
    );
    return [];
  }
  return [origin];
}
