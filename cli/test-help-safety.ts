/**
 * `--help` must document, never act.
 *
 * On 2026-09-02 `hatchkit provision s3 --help` provisioned: an R2
 * bucket, a custom domain, a CORS rule, a scoped R2 account API token
 * and six entries written into a project's .env.production. The
 * `provision` case dispatched on `args[1] === "s3"` and never looked at
 * the rest of the argv, so the usage block below it was reachable only
 * when the subcommand was missing or wrong.
 *
 * Two layers of assertion here, because each covers the other's blind
 * spot:
 *
 *  1. `isHelpRequest` in isolation — cheap, and it pins the rule itself.
 *  2. Real `hatchkit <cmd> --help` subprocesses, run against a probe
 *     that makes any outbound socket fatal. They run in a sandbox
 *     project carrying a valid manifest, so a re-broken command gets
 *     far enough to actually reach for a provider — and dies loudly on
 *     the probe instead of creating a bucket.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { helpTopicForCommand, isHelpRequest } from "./src/help-routing.js";

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// the rule
// ---------------------------------------------------------------------------

// Every one of these reached a provider before the fix.
const DANGEROUS_ARGV: string[][] = [
  ["provision", "s3", "--help"],
  ["provision", "s3", "--with-state-bucket", "--help"],
  ["keys", "rotate", "demo", "--help"],
  ["keys", "push", "demo", "--help"],
  ["secrets", "rotate", "demo", "--help"],
  ["signing", "apply", "--help"],
  ["signing", "org-init", "--help"],
  ["assets", "push", "--help"],
  ["assets", "pull", "--help"],
  ["ses", "verify", "someone@example.com", "--help"],
  ["ses", "unverify", "someone@example.com", "--help"],
  ["email", "setup", "--help"],
  ["email", "ses-mail-from", "setup", "--help"],
  ["dns", "publish", "--help"],
  ["add", "demo", "s3", "--help"],
  ["remove", "demo", "--help"],
  ["server", "add", "--help"],
  ["gh-pages", "--undo", "--help"],
  ["migrate-domain", "--to", "example.com", "--phase", "cutover", "--help"],
];

for (const argv of DANGEROUS_ARGV) {
  check(`help wins: hatchkit ${argv.join(" ")}`, () => {
    assert.equal(isHelpRequest(argv), true);
  });
}

check("-h counts as help wherever it sits", () => {
  assert.equal(isHelpRequest(["provision", "s3", "-h"]), true);
  assert.equal(isHelpRequest(["-h"]), true);
});

check("a plain command is not a help request", () => {
  assert.equal(isHelpRequest(["provision", "s3"]), false);
  assert.equal(isHelpRequest(["sync", "--dry-run"]), false);
  // Substrings and lookalikes must not trip the guard, or a real run
  // would silently turn into a no-op.
  assert.equal(isHelpRequest(["create", "--name", "helper"]), false);
  assert.equal(isHelpRequest(["create", "--no-help"]), false);
});

check("topics resolve for the commands that have one", () => {
  assert.equal(helpTopicForCommand("keys"), "keys");
  assert.equal(helpTopicForCommand("assets"), "assets");
  assert.equal(helpTopicForCommand("pages"), "gh-pages");
});

check("commands with hand-written usage have no topic", () => {
  // index.ts routes these three itself; a topic here would print the
  // wrong help.
  assert.equal(helpTopicForCommand("provision"), undefined);
  assert.equal(helpTopicForCommand("signing"), undefined);
  assert.equal(helpTopicForCommand("ses"), undefined);
  assert.equal(helpTopicForCommand("not-a-command"), undefined);
});

// ---------------------------------------------------------------------------
// the real CLI, with the network poisoned
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL(".", import.meta.url));
const probe = fileURLToPath(new URL("./test-help-no-network.probe.mjs", import.meta.url));
// Resolved from here, not from the child's cwd — the child runs in a
// throwaway directory that has no node_modules.
const tsxLoader = import.meta.resolve("tsx");

// A throwaway project dir: a plausible manifest, so a re-broken command
// gets far enough to try something rather than bailing on "not a
// hatchkit project" and passing this test by accident.
const sandbox = mkdtempSync(join(tmpdir(), "hatchkit-help-"));
writeFileSync(
  join(sandbox, ".hatchkit.json"),
  JSON.stringify(
    {
      version: 4,
      name: "helpsafety",
      domain: "helpsafety.example.com",
      surfaces: "split",
      deploymentMode: "coolify",
      features: [],
    },
    null,
    2,
  ),
);

interface HelpRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHelp(argv: string[]): HelpRun {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "--import", probe, join(here, "src", "index.ts"), ...argv],
    {
      cwd: sandbox,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: {
        ...process.env,
        // Isolate config and any keychain-adjacent lookups from the
        // real machine — a help run must not need them anyway.
        HOME: sandbox,
        HATCHKIT_CONF_DIR: join(sandbox, "conf"),
        NO_COLOR: "1",
        CI: "1",
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function checkHelpRun(argv: string[], expected: string): void {
  check(`hatchkit ${argv.join(" ")} documents and does nothing`, () => {
    const run = runHelp(argv);
    assert.ok(
      !run.stderr.includes("PROVIDER_CALL_ATTEMPTED"),
      `opened a connection during --help:\n${run.stderr}`,
    );
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
    assert.ok(
      run.stdout.includes(expected),
      `expected help containing ${JSON.stringify(expected)}, got:\n${run.stdout}`,
    );
  });
}

// The command that caused the incident, plus one per other subtree that
// dispatched a subcommand ahead of its help check.
checkHelpRun(["provision", "s3", "--help"], "Usage: hatchkit provision s3 [flags]");
checkHelpRun(["provision", "s3", "--with-state-bucket", "-h"], "Usage: hatchkit provision s3");
checkHelpRun(["assets", "push", "--help"], "hatchkit assets — move bytes");
checkHelpRun(["keys", "rotate", "demo", "--help"], "hatchkit keys — manage per-project");
checkHelpRun(["ses", "unverify", "someone@example.com", "--help"], "hatchkit ses — Amazon SES");
checkHelpRun(["signing", "apply", "--help"], "hatchkit signing org-init");
checkHelpRun(["email", "setup", "--help"], "hatchkit email — Cloudflare Email Routing");

// The topic has to be the command's own — root help would satisfy a
// looser assertion while telling the user nothing about what they
// asked for.
check("an unknown command still gets the root help, not a crash", () => {
  const run = runHelp(["not-a-command", "--help"]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes("Usage: hatchkit <command> [options]"), run.stdout);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.join("\n")}\n`);
  console.error(`  ${failures.length} check(s) failed\n`);
  process.exit(1);
}
console.log("\n  help-safety: all checks passed\n");
