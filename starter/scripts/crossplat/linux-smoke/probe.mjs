/*
 * Runs INSIDE the linux-smoke container (see ../linux-smoke.mjs, which
 * mounts the app at /app, this folder at /crossplat and the output at /out).
 *
 * Starts Xvfb, launches the app with a CDP port, attaches playwright-core,
 * waits for a page whose URL starts with SMOKE_EXPECT_URL_PREFIX, lets it
 * settle, screenshots it and checks the process is still alive. Writes
 * /out/result.json, /out/screenshot.png and /out/app.log; exits 0 on a pass.
 */
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(`${process.env.NODE_PATH ?? "/usr/local/lib/node_modules"}/`);
const { chromium } = require("playwright-core");

const exec = process.env.SMOKE_EXEC;
const extraArgs = JSON.parse(process.env.SMOKE_ARGS ?? "[]");
const expectPrefix = process.env.SMOKE_EXPECT_URL_PREFIX ?? "";
const settleMs = Number(process.env.SMOKE_SETTLE_MS ?? "5000");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? "60000");
const port = 9222;

const result = {
  ok: false,
  url: null,
  title: null,
  consoleErrors: [],
  pageErrors: [],
  screenshot: false,
  problem: null,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(problem) {
  result.problem = problem;
  result.ok = problem === null;
  writeFileSync("/out/result.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log(result.ok ? "PASS" : `FAIL: ${problem}`);
  process.exit(result.ok ? 0 : 1);
}

if (!exec) finish("SMOKE_EXEC is not set");

const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" });
process.on("exit", () => xvfb.kill());
// A session bus, so Chromium and libnotify have one to talk to. The system
// bus stays absent; its connection errors in app.log are expected.
const busAddress = "unix:path=/tmp/smoke-session-bus";
const bus = spawn("dbus-daemon", ["--session", "--nofork", `--address=${busAddress}`], { stdio: "ignore" });
process.on("exit", () => bus.kill());
await sleep(500);

const log = createWriteStream("/out/app.log");
const app = spawn(exec, ["--no-sandbox", `--remote-debugging-port=${port}`, ...extraArgs], {
  env: { ...process.env, DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: busAddress },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.pipe(log);
app.stderr.pipe(log);
let exited = null;
app.on("exit", (code, signal) => {
  exited = { code, signal };
});
process.on("exit", () => app.kill("SIGKILL"));

const deadline = Date.now() + timeoutMs;
let cdpUp = false;
while (Date.now() < deadline && !exited) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) {
      cdpUp = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await sleep(250);
}
if (exited) finish(`the app exited before opening CDP (code ${exited.code}, signal ${exited.signal}); see app.log`);
if (!cdpUp) finish(`no CDP endpoint on :${port} within ${timeoutMs} ms; see app.log`);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
while (Date.now() < deadline && !page) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(expectPrefix)) ?? null;
  if (!page) await sleep(250);
}
if (!page) {
  const seen = browser.contexts().flatMap((c) => c.pages()).map((p) => p.url());
  finish(`no page with a URL starting "${expectPrefix}" (saw: ${seen.join(", ") || "none"})`);
}
page.on("console", (msg) => {
  if (msg.type() === "error") result.consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => result.pageErrors.push(String(err)));

await page.waitForLoadState("load", { timeout: Math.max(1000, deadline - Date.now()) }).catch(() => {});
await sleep(settleMs);
result.url = page.url();
result.title = await page.title().catch(() => null);
// A window that was never shown produces no frames on X11, and the capture
// then waits forever: an app run with its own "headless" switch has to show
// its window here (Xvfb is virtual, so nothing reaches a real screen).
let screenshotError = null;
await page
  .screenshot({ path: "/out/screenshot.png", timeout: 15000 })
  .then(() => {
    result.screenshot = true;
  })
  .catch((err) => {
    screenshotError = String(err).split("\n")[0];
  });

if (exited) finish(`the app exited after ${settleMs} ms (code ${exited.code}, signal ${exited.signal}); see app.log`);
if (result.pageErrors.length) finish(`${result.pageErrors.length} uncaught page error(s): ${result.pageErrors[0]}`);
if (screenshotError) finish(`no screenshot (is the window shown?): ${screenshotError}`);
finish(null);
