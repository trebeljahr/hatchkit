#!/usr/bin/env node
// Captures the README / marketing terminal screenshots from real CLI runs.
//
//   node scripts/marketing/capture-screenshots.mjs      (or: pnpm marketing:screenshots)
//
// Each shot runs the CLI from this repo's source (tsx) in a throwaway sandbox:
// HATCHKIT_CONF_DIR points at a fresh temp dir, the keychain is denied and
// local-dev wiring is off, so no stored credentials or projects are read and
// nothing is written outside the temp dir. The coloured output is rendered
// into a terminal frame with Playwright and saved to docs/marketing/screenshots/.
//
// The secrets shot scaffolds a real project, which needs a keychain. It uses
// the CLI test suite's fixture keychain (cli/test-support/setup.mjs swaps the
// native keytar module for files in the sandbox), so the OS keychain is never
// read or written. A source checkout's create also writes two infra files
// into <checkout>/infra; the script refuses to run if they already exist and
// deletes them afterwards.
//
// Display edits, all listed in docs/marketing/README.md: the sandbox path is
// shown as ~/projects, the repo path as ~/hatchkit, runs of blank lines are
// collapsed to one, and an elided block of output is marked with a dim ⋮ line.
//
// Env: HATCHKIT_CLI_ROOT (a cli/ dir with node_modules installed; default:
// this repo's cli/), PLAYWRIGHT_MODULE (see lib.mjs).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FONTS_HREF,
  REPO_ROOT,
  SCREENSHOT_DIR,
  ansiLineToHtml,
  escapeHtml,
  launchChromium,
  renderHtml,
  stripAnsi,
} from "./lib.mjs";

const CLI_ROOT = process.env.HATCHKIT_CLI_ROOT ?? join(REPO_ROOT, "cli");
const TSX = join(CLI_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = join(CLI_ROOT, "src", "index.ts");
if (!existsSync(TSX)) {
  console.error(`tsx not found at ${TSX}. Run pnpm install, or set HATCHKIT_CLI_ROOT.`);
  process.exit(1);
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hatchkit-shots-")));
const confDir = join(sandbox, "conf");
const workDir = join(sandbox, "projects");
// The secrets shot gets its own config dir and a fixture keychain dir.
const secretsConfDir = join(sandbox, "conf-secrets");
const keychainDir = join(sandbox, "keychain");
for (const dir of [confDir, workDir, secretsConfDir, keychainDir]) mkdirSync(dir, { recursive: true });

// keychain "deny": the OS keychain is off. "fixture": the test suite's
// file-backed keychain inside the sandbox (never the OS one).
function runCli(args, { cwd = workDir, keychain = "deny" } = {}) {
  const env = {
    ...process.env,
    HATCHKIT_CONF_DIR: confDir,
    HATCHKIT_KEYCHAIN_ACCESS: "deny",
    HATCHKIT_LOCAL_DEV: "0",
    NODE_NO_WARNINGS: "1",
    FORCE_COLOR: "1",
    COLUMNS: "110",
  };
  if (keychain === "fixture") {
    Object.assign(env, {
      HATCHKIT_CONF_DIR: secretsConfDir,
      HATCHKIT_TEST_KEYCHAIN_DIR: keychainDir,
      HATCHKIT_KEYCHAIN_ACCESS: "allow",
      NODE_OPTIONS: `--import=${join(CLI_ROOT, "test-support", "setup.mjs")}`,
    });
  }
  const res = spawnSync(TSX, [ENTRY, ...args], { cwd, encoding: "utf8", env });
  return displayLines(`${res.stdout}${res.stderr}`);
}

function displayLines(text) {
  return text
    .split(realpathSync(CLI_ROOT).replace(/\/cli$/, ""))
    .join("~/hatchkit")
    .split(workDir)
    .join("~/projects")
    .split(secretsConfDir)
    .join("~/.config/hatchkit")
    .split(confDir)
    .join("~/.config/hatchkit")
    .split(homedir())
    .join("~")
    .replace(/\n+$/, "")
    .split("\n")
    .filter((l, i, all) => !(isBlank(l) && i > 0 && isBlank(all[i - 1])));
}

const isBlank = (line) => stripAnsi(line).trim() === "";

// Keeps lines [from, to] (inclusive, by index) and marks the cut with ⋮.
function keep(lines, ranges) {
  const out = [];
  ranges.forEach(([from, to], i) => {
    if (i > 0) out.push("\x1b[2m  ⋮\x1b[22m");
    out.push(...lines.slice(from, to + 1));
  });
  return out;
}

const findLine = (lines, re, start = 0) => {
  for (let i = start; i < lines.length; i++) if (re.test(stripAnsi(lines[i]))) return i;
  throw new Error(`no line matches ${re}`);
};

function terminalHtml({ title, command, lines, width, fontSize = 15.5 }) {
  const cmd = command.map((c, i) => (i === 0 ? `<span class="p">$</span> ${escapeHtml(c)}` : `    ${escapeHtml(c)}`));
  const body = lines.map((l) => `<div class="l">${ansiLineToHtml(l) || "&nbsp;"}</div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${FONTS_HREF}">
<style>
  html,body{margin:0;background:transparent}
  .shot{padding:0;width:${width}px}
  .win{background:#0b0d12;border:1px solid #232838;border-radius:14px;overflow:hidden;
       box-shadow:0 1px 0 rgba(255,255,255,.04) inset}
  .bar{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid #1a1f2e;
       background:#10131b}
  .dot{width:12px;height:12px;border-radius:50%}
  .t{flex:1;text-align:center;margin-right:52px;color:#7c8596;font:500 13px/1 Inter,sans-serif}
  .term{padding:18px 22px 22px;font:400 ${fontSize}px/1.5 "JetBrains Mono",monospace;color:#d7dbe4;
        white-space:pre-wrap;font-variant-ligatures:none}
  .cmd{color:#ffffff;margin-bottom:4px}
  .p{color:#818cf8;font-weight:700}
</style></head><body><div class="shot"><div class="win">
<div class="bar"><span class="dot" style="background:#f87171"></span><span class="dot" style="background:#fbbf24"></span><span class="dot" style="background:#34d399"></span><span class="t">${escapeHtml(title)}</span></div>
<div class="term"><div class="cmd">${cmd.join(" \\\n")}</div>${body}</div>
</div></div></body></html>`;
}

const shots = [];

// 1. create --dry-run: the full plan for a new project, nothing written.
{
  // One string per displayed command line; joined with " \" continuations.
  const command = [
    "hatchkit create --dry-run --yes --name nimbus",
    "--domain nimbus.example.com --deploy-target new",
    "--features websocket,stripe,analytics --no-local-dev",
  ];
  const lines = runCli(command.join(" ").split(" ").slice(1));
  const start = findLine(lines, /^\s*✓ GitHub/);
  const ports = findLine(lines, /^\s*Ports:/);
  const done = findLine(lines, /Dry run complete/);
  shots.push({
    file: "create-dry-run.png",
    title: "~/projects — hatchkit create",
    command,
    lines: keep(lines, [[start, ports], [done, done]]),
  });
}

// 2. status on a fresh machine: what is configured and the next step.
{
  const lines = runCli(["status"]);
  const start = findLine(lines, /Provider Status/);
  const next = findLine(lines, /^\s*Next:/);
  shots.push({
    file: "status.png",
    title: "~/projects — hatchkit status",
    command: ["hatchkit status"],
    lines: lines.slice(start - 1, next + 1),
  });
}

// 3. --help: the command groups, from first run to maintenance.
{
  const lines = runCli(["--help"]);
  const start = findLine(lines, /Getting started:/);
  const end = findLine(lines, /^\s*sync\s/);
  shots.push({
    file: "help.png",
    title: "~/projects — hatchkit --help",
    command: ["hatchkit --help"],
    lines: [...lines.slice(start, end + 1), "\x1b[2m    ⋮\x1b[22m"],
  });
}

// 4. Secrets: a real scaffold encrypts .env.production and stores the
// dotenvx key in the keychain (here the fixture one); `secrets rotate
// --dry-run` then names the deploy targets a new value would go to. Sized
// for the terminal slot of social preview C.
{
  const name = "nimbus";
  const infraRoot = join(realpathSync(CLI_ROOT), "..", "infra");
  const strays = [
    join(infraRoot, "stacks", `${name}.env`),
    join(infraRoot, "terraform", "stacks", "node-realtime", `${name}.tfvars`),
    join(infraRoot, "terraform", "stacks", "dns-only-cloudflare", `${name}.tfvars`),
  ];
  const clash = strays.find((p) => existsSync(p));
  if (clash) throw new Error(`${clash} already exists; move it away and re-run.`);
  const command = [
    `hatchkit create --yes --name ${name} --domain ${name}.example.com`,
    "--features websocket,analytics --deployment-mode scaffold-only",
    "--no-github --no-install --no-local-dev",
  ];
  let created;
  try {
    created = runCli(command.join(" ").split(" ").slice(1), { keychain: "fixture" });
  } finally {
    // Only this run can have made them: the clash check above refused otherwise.
    for (const p of strays) if (existsSync(p)) rmSync(p);
  }
  const projectDir = join(workDir, name);
  const grepCmd = "grep _SECRET= packages/server/.env.production | cut -c1-58";
  const grep = spawnSync("sh", ["-c", grepCmd], { cwd: projectDir, encoding: "utf8" });
  if (grep.status !== 0) throw new Error(`grep failed: ${grep.stderr}`);
  const rotateCmd = `hatchkit secrets rotate ${name} --dry-run`;
  const rotate = runCli(rotateCmd.split(" ").slice(1), { cwd: projectDir, keychain: "fixture" });
  const rStart = findLine(rotate, /^\s*· glitchtip/);
  const rDeploy = findLine(rotate, /^\s*deploy:/, rStart);
  const prompt = (cmd) => `\x1b[1;38;2;129;140;248m$\x1b[22;39m \x1b[97m${cmd}\x1b[39m`;
  shots.push({
    file: "create-secrets.png",
    title: "~/projects — hatchkit create",
    command,
    width: 656,
    fontSize: 14.5,
    lines: [
      created[findLine(created, /Encrypted \d+ values into \.env\.production/)],
      created[findLine(created, /dotenvx private key stored/)],
      "",
      prompt(`cd ${name}`),
      prompt(grepCmd),
      ...displayLines(grep.stdout),
      "",
      prompt(rotateCmd),
      ...rotate.slice(rStart, rDeploy + 1),
      "\x1b[2m  ⋮\x1b[22m",
    ],
  });
}

mkdirSync(SCREENSHOT_DIR, { recursive: true });
const browser = await launchChromium();
try {
  for (const s of shots) {
    const width = s.width ?? (s.file === "help.png" ? 1120 : 1040);
    const out = join(SCREENSHOT_DIR, s.file);
    await renderHtml(browser, terminalHtml({ ...s, width }), out, {
      width: width + 40,
      height: 400,
      scale: 2,
      selector: ".shot",
      transparent: true,
    });
    writeFileSync(join(SCREENSHOT_DIR, s.file.replace(/\.png$/, ".txt")), `${s.lines.map(stripAnsi).join("\n")}\n`);
    console.log(`wrote ${out}`);
  }
} finally {
  await browser.close();
  rmSync(sandbox, { recursive: true, force: true });
}
