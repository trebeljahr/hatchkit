/*
 * cli/src/features/release/command.ts — `hatchkit release`.
 *
 * Four subcommands, three of which are a thin front end over the
 * scripts installed in the project:
 *
 *   plan     print what each surface will do on a tag, and what a
 *            person still owes afterwards. Touches nothing.
 *   cut      node scripts/release.mjs
 *   status   node scripts/release-status.mjs
 *   check    node scripts/release-policy-check.mjs
 *
 * Delegating rather than reimplementing is deliberate. CI runs those
 * scripts with no Hatchkit installed, so they are the real
 * implementation. A second implementation here would be a second thing
 * to keep correct, and the two would disagree on the day it mattered —
 * which is precisely the failure this feature exists to remove.
 *
 * `plan` is the exception, because it is the one question the scripts
 * cannot answer without a tag: what would happen if I cut one?
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { findManifestDirUpward, readManifest } from "../../scaffold/manifest.js";
import { exec } from "../../utils/exec.js";
import { readReleaseConfig } from "./config.js";
import type { ReleaseConfig } from "./types.js";
import { RELEASE_CONFIG_FILENAME } from "./types.js";

const SUBCOMMANDS = ["plan", "cut", "status", "check"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const SCRIPT_FOR: Record<Exclude<Subcommand, "plan">, string> = {
  cut: "scripts/release.mjs",
  status: "scripts/release-status.mjs",
  check: "scripts/release-policy-check.mjs",
};

/** Returns a process exit code. Never calls process.exit itself, so the
 *  router decides what a failure means. */
export async function handleReleaseCommand(args: readonly string[]): Promise<number> {
  const [rawSubcommand, ...rest] = args;
  const subcommand = (rawSubcommand ?? "plan") as Subcommand;
  if (!SUBCOMMANDS.includes(subcommand)) {
    printReleaseUsage();
    console.log(chalk.red(`\n  Unknown subcommand: ${rawSubcommand}`));
    return 2;
  }

  const located = locateProject();
  if ("error" in located) {
    console.log(chalk.red(`\n  ${located.error}`));
    console.log(chalk.dim(`  ${located.hint}`));
    return 1;
  }
  const { projectDir, config } = located;

  if (subcommand === "plan") {
    printPlan(config);
    return 0;
  }

  const script = join(projectDir, SCRIPT_FOR[subcommand]);
  if (!existsSync(script)) {
    console.log(chalk.red(`\n  ${SCRIPT_FOR[subcommand]} is missing from ${projectDir}.`));
    console.log(chalk.dim("  Run `hatchkit update` to reinstall the release scripts."));
    return 1;
  }

  // Inherit stdio through execa's default capture, then echo. These
  // scripts print tables and diffs, so their output is the answer.
  const result = await exec("node", [script, ...rest], { cwd: projectDir, silent: true });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  return result.exitCode;
}

// ---------------------------------------------------------------------------

interface Located {
  projectDir: string;
  config: ReleaseConfig;
}

function locateProject(): Located | { error: string; hint: string } {
  const cwd = resolve(".");
  const manifestDir = findManifestDirUpward(cwd);
  if (!manifestDir) {
    return {
      error: "No .hatchkit.json found here or in any parent directory.",
      hint: "Run this from inside a project hatchkit scaffolded or adopted.",
    };
  }
  const manifest = readManifest(manifestDir);
  const projectDir = manifest?.projectSubdir
    ? join(manifestDir, manifest.projectSubdir)
    : manifestDir;

  const config = readReleaseConfig(projectDir);
  if (!config) {
    return {
      error: `${RELEASE_CONFIG_FILENAME} is missing from ${projectDir}.`,
      hint: "Run `hatchkit update` and pick `release` to opt this project in.",
    };
  }
  return { projectDir, config };
}

/**
 * The channel table, plus the two things a plan is for: what is still
 * owed by a person after every workflow is green, and which credentials
 * are missing-by-design rather than forgotten.
 */
function printPlan(config: ReleaseConfig): void {
  const pm = config.project.packageManager;
  console.log(chalk.bold(`\n  ── Release plan: ${config.project.name} ───────────────────\n`));

  if (config.channels.length === 0) {
    console.log(chalk.yellow("  No release channels. Nothing ships from a version tag yet."));
    console.log(
      chalk.dim("  Add a surface (desktop, mobile, a deploy) and re-run `hatchkit update`."),
    );
    return;
  }

  console.log(chalk.dim(`  One version lives in ${config.project.versionFile}.`));
  const copies = config.versionCopies.length;
  console.log(
    chalk.dim(
      copies === 0
        ? "  Nothing else keeps a copy of it."
        : `  ${copies} other ${copies === 1 ? "file keeps a copy" : "files keep copies"}; ` +
            `\`${pm} run test:version-sync\` fails when one drifts.`,
    ),
  );

  console.log(chalk.bold("\n  On a version tag:\n"));
  for (const channel of config.channels) {
    const marker = channel.trigger === "tag" ? chalk.green("→") : chalk.yellow("·");
    console.log(`  ${marker} ${chalk.bold(channel.label)}  ${chalk.dim(channel.workflowFile)}`);
    console.log(`      ${channel.effect}`);
    if (channel.trigger !== "tag" && channel.missingRunNote) {
      const how = channel.trigger === "branch" ? "Not started by the tag" : "Needs a dispatch";
      console.log(chalk.yellow(`      ${how}: ${channel.missingRunNote}`));
    }
    if (channel.gate) console.log(chalk.yellow(`      Still owed: ${channel.gate.note}`));
    const group = config.credentials.find((entry) => entry.channelId === channel.id);
    if (group && group.secrets.length > 0) {
      console.log(
        chalk.dim(
          `      Needs ${group.secrets.length} repo secrets. Without them: ${group.absentNote}`,
        ),
      );
    }
    console.log("");
  }

  const errors = config.policy.rules.filter((rule) => !config.policy.warnOnly.includes(rule.id));
  console.log(chalk.bold(`  ${errors.length} policy rules will run before the tag is created.`));
  console.log(chalk.dim(`  See docs/releasing.md, or run \`hatchkit release check v<version>\`.`));
  console.log(chalk.dim(`\n  Cut one with: hatchkit release cut <X.Y.Z> --dry-run`));
}

export function printReleaseUsage(): void {
  console.log(`
  ${chalk.bold("hatchkit release")} — coordinate one version across every surface

  ${chalk.bold("Usage:")}
    hatchkit release plan
    hatchkit release cut <X.Y.Z> [--dry-run] [--skip-tests] [--yes]
    hatchkit release status [vX.Y.Z] [--markdown]
    hatchkit release check <vX.Y.Z> [ref]

  ${chalk.bold("What each one does:")}
    plan     What every channel will do on a tag, and what a person still owes
             afterwards. Reads ${RELEASE_CONFIG_FILENAME}; changes nothing.
    cut      Checks the tree and the version, runs the policy check against the
             release exactly as it would be tagged, writes the version into every
             copy, runs the tests, commits and tags. Never pushes.
    status   What each channel produced for a tag, and what is still pending —
             a draft awaiting a person, a store review, an upload that was
             deliberately skipped. Reads GitHub through \`gh api\`.
    check    The policy check on its own, against a tag and an optional ref.

  ${chalk.bold("Notes:")}
    cut, status and check run the scripts in the project, which is what CI runs.
    Start with ${chalk.bold("hatchkit release cut <X.Y.Z> --dry-run")} — it writes nothing.
    Opt a project in with ${chalk.bold("hatchkit update")} and pick ${chalk.bold("release")}.
`);
}
