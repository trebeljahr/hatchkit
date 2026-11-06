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
mkdirSync(confDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

function runCli(args) {
  const res = spawnSync(TSX, [ENTRY, ...args], {
    cwd: workDir,
    encoding: "utf8",
    env: {
      ...process.env,
      HATCHKIT_CONF_DIR: confDir,
      HATCHKIT_KEYCHAIN_ACCESS: "deny",
      HATCHKIT_LOCAL_DEV: "0",
      NODE_NO_WARNINGS: "1",
      FORCE_COLOR: "1",
      COLUMNS: "110",
    },
  });
  const text = `${res.stdout}${res.stderr}`;
  return text
    .split(realpathSync(CLI_ROOT).replace(/\/cli$/, ""))
    .join("~/hatchkit")
    .split(workDir)
    .join("~/projects")
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

function terminalHtml({ title, command, lines, width }) {
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
  .term{padding:18px 22px 22px;font:400 15.5px/1.5 "JetBrains Mono",monospace;color:#d7dbe4;
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

mkdirSync(SCREENSHOT_DIR, { recursive: true });
const browser = await launchChromium();
try {
  for (const s of shots) {
    const width = s.file === "help.png" ? 1120 : 1040;
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
