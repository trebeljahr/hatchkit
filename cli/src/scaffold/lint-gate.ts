/*
 * The lint gate: one root command, a pre-push hook, and a CI job, all at
 * zero tolerance for warnings.
 *
 * Three surfaces on purpose. The root command is the one a person runs
 * and the one the other two call, so there is a single definition of
 * "lint passes". The hook catches it before a push, when fixing is cheap.
 * The CI job catches it when the hook was skipped — `--no-verify` exists,
 * people use it, and a gate that only runs locally is not a gate.
 *
 * Zero tolerance is the point rather than a preference. A warning that
 * never fails anything accumulates until the output is noise, and then the
 * real one scrolls past. `--max-warnings 0` for ESLint; Biome treats its
 * diagnostics as errors already.
 *
 * The gate ships GREEN against the starter as it stands. A gate that
 * arrives red is switched off within a week, so a rule that fires on
 * template code is turned off in the config with a reason rather than
 * left to fail.
 *
 * Nothing here writes the workspace packages' own `lint` scripts — those
 * ship in the starter. This module owns the root wiring, which is what
 * has to be retrofitted onto projects scaffolded before the gate existed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setPackageJsonScript } from "./pkg-json.js";

export const HOOKS_DIR_REL = ".githooks";
export const PRE_PUSH_HOOK_REL_PATH = ".githooks/pre-push";
export const LINT_WORKFLOW_REL_PATH = ".github/workflows/lint.yml";

/**
 * Every workspace package that defines a `lint` script, in one command.
 *
 * `--if-present` rather than a hardcoded list of filters: scaffolding
 * prunes packages a feature set does not need, and a root script naming a
 * package that is not there fails for the wrong reason. `-r` propagates a
 * non-zero exit from any package, which is what makes this a gate.
 */
export const ROOT_LINT_SCRIPT = "pnpm -r --if-present run lint";
export const ROOT_LINT_FIX_SCRIPT = "pnpm -r --if-present run lint:fix";

/**
 * Point git at the tracked hooks directory.
 *
 * `prepare` runs on every `pnpm install`, including in CI and inside a
 * tarball extracted somewhere that is not a git repository — so the
 * command must never fail the install. `git config` in a checkout is
 * local to that checkout and touches nothing global.
 *
 * `core.hooksPath` rather than writing into `.git/hooks`: the hook is
 * then tracked, reviewable, and updated by a pull like any other file.
 */
export const PREPARE_SCRIPT = `git config core.hooksPath ${HOOKS_DIR_REL} 2>/dev/null || true`;

/** True when the root package.json already routes git at the tracked
 *  hooks. Matches any form of the command so a hand-edited `prepare`
 *  that already does the job is left alone. */
export function hasHooksPathPrepare(pkgJson: string): boolean {
  try {
    const pkg = JSON.parse(pkgJson);
    const prepare = pkg?.scripts?.prepare;
    return typeof prepare === "string" && /core\.hooksPath/.test(prepare);
  } catch {
    return false;
  }
}

/**
 * Add `prepare` without discarding one the project already has.
 *
 * `prepare` is a popular hook for husky, for building on install, for
 * anything — so appending is right and overwriting is not. Returns the
 * value to write, or `null` when the project already routes git at the
 * tracked hooks and nothing needs to change.
 */
export function mergePrepareScript(existing: string | undefined): string | null {
  if (existing === undefined || existing.trim() === "") return PREPARE_SCRIPT;
  if (/core\.hooksPath/.test(existing)) return null;
  return `${existing.trim()} && ${PREPARE_SCRIPT}`;
}

export interface LintGateResult {
  /** True when the root package.json was changed — or, in a dry run,
   *  would have been. */
  changed: boolean;
  /** Scripts this call wrote (or, in a dry run, would write), for the
   *  caller to report. */
  wrote: string[];
}

export interface LintGateOptions {
  /** Work out what would be written without touching package.json, so
   *  `hatchkit update --dry-run` can report the retrofit. */
  dryRun?: boolean;
}

/**
 * Wire the root command and the hook installer.
 *
 * Idempotent: re-running against a project that already carries the gate
 * writes nothing and reports `changed: false`, so `hatchkit update` can
 * call it unconditionally without touching the file's mtime.
 */
export function applyLintGate(outputDir: string, options: LintGateOptions = {}): LintGateResult {
  const path = join(outputDir, "package.json");
  if (!existsSync(path)) return { changed: false, wrote: [] };

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { changed: false, wrote: [] };
  }
  const scripts = pkg.scripts ?? {};
  const wrote: string[] = [];

  for (const [name, value] of [
    ["lint", ROOT_LINT_SCRIPT],
    ["lint:fix", ROOT_LINT_FIX_SCRIPT],
  ] as const) {
    // An edited root lint command is a project decision. Only write when
    // the script is absent — the gate is "there is one root command", not
    // "it is exactly this one".
    if (scripts[name] === undefined) {
      if (!options.dryRun) setPackageJsonScript(outputDir, name, value);
      wrote.push(name);
    }
  }

  const prepare = mergePrepareScript(scripts.prepare);
  if (prepare !== null) {
    if (!options.dryRun) setPackageJsonScript(outputDir, "prepare", prepare);
    wrote.push("prepare");
  }

  return { changed: wrote.length > 0, wrote };
}

/** Files the gate needs on disk, for `hatchkit update` to copy out of the
 *  starter when a project predates it. */
export const LINT_GATE_FILES: readonly string[] = [
  PRE_PUSH_HOOK_REL_PATH,
  LINT_WORKFLOW_REL_PATH,
  "biome.json",
];
