/** Public installation, blocked credentials and backwards navigation regressions. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { PassThrough } from "node:stream";
import { ExitPromptError } from "@inquirer/core";
import { getStore } from "./src/config.js";
import { collectStatus, verifyProviderCredentials } from "./src/status.js";
import { rememberStepPrompt, runSteps } from "./src/utils/step-runner.js";
import spinner from "./src/utils/spinner.js";

const visits: string[] = [];
let back = true;
const state = await runSteps([
  { name: "first", run: async () => { visits.push("first"); return 1; } },
  { name: "preset", skip: () => true, run: async () => { throw new Error("preset prompt ran"); } },
  { name: "last", run: async () => { if (back) { back = false; throw new ExitPromptError(); } return 2; } },
], 0);
assert.equal(state, 2);
assert.deepEqual(visits, ["first", "first"], "back must cross skipped steps");

const counts = [0, 0, 0];
const ask = rememberStepPrompt(async (i: number) => {
  counts[i]++;
  if (i === 2 && counts[i] === 1) throw new ExitPromptError();
  return `${i}:${counts[i]}`;
});
const answers = await runSteps([{ name: "three prompts", run: async () => [await ask(0), await ask(1), await ask(2)] }], [] as string[]);
assert.deepEqual(counts, [1, 2, 2], "only the last completed prompt is asked again");
assert.deepEqual(answers, ["0:1", "1:2", "2:2"]);

const stream = Object.assign(new PassThrough(), { isTTY: true, columns: 0, rows: 0 });
const zero = spinner({ text: "zero columns", stream });
assert.equal(zero.isEnabled, false);
zero.start().succeed();
stream.destroy();

getStore().set("providers.listmonk", { status: "configured", url: "https://listmonk.test", apiUser: "fixture" });
const before = collectStatus();
const checked = await verifyProviderCredentials(before, { listmonk: async () => { throw new Error("Keychain read failed: OS keychain access is disabled"); } });
const row = checked.providers.find((p) => p.key === "listmonk");
assert.equal(row?.verification, "blocked");
assert.equal(row?.verified, undefined);
assert.ok(!checked.suggestions.some((s) => /credential is broken/.test(s.why)));

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
  const unavailable = await verifyProviderCredentials(collectStatus(), { listmonk: async () => ({ url: "https://listmonk.test", apiUser: "fixture", apiToken: "fixture" }) });
  const service = unavailable.providers.find((p) => p.key === "listmonk");
  assert.equal(service?.verification, "unavailable");
  assert.equal(service?.verified, undefined);
  assert.ok(!unavailable.suggestions.some((s) => /credential is broken/.test(s.why)));
} finally { globalThis.fetch = originalFetch; }

const dir = mkdtempSync(join(tmpdir(), "hatchkit-readiness-"));
try {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tailscale"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const stdout = (() => {
    try {
      return execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "src/index.ts"), "doctor", "--json"], {
        cwd: dir, encoding: "utf8", env: { ...process.env, HATCHKIT_CONF_DIR: join(dir, "config"), HATCHKIT_DEV_CONFIG_DIR: join(dir, "dev"), HATCHKIT_KEYCHAIN_ACCESS: "deny", PATH: `${bin}${delimiter}${process.env.PATH}` },
      });
    } catch (error) {
      const result = error as { status: number; stdout: string; stderr?: string };
      assert.doesNotMatch(String(result.stderr ?? ""), /Tests cannot run a real/);
      assert.equal(result.status, 1); // unauthenticated fixture GitHub
      return result.stdout;
    }
  })();
  const result = JSON.parse(stdout);
  assert.ok(result.summary.unverified > 0);
  assert.ok(result.checks.some((r: { unverified?: boolean }) => r.unverified));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("Readiness: skipped-step and per-prompt back navigation, zero-column terminal, blocked status and doctor JSON passed.");
