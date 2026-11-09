/*
 * Plausible build-variable delivery — getting the site `hatchkit add …
 * plausible` provisioned to the place the client build actually reads it.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * The starter's root layout renders Plausible's tracker from
 * NEXT_PUBLIC_PLAUSIBLE_DOMAIN (and NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL), and
 * Next inlines both at BUILD time. `add` wrote them to the client's
 * `.env.production` and nowhere else. The client image build never sees
 * that file — `.dockerignore` excludes every `.env.*` — and it gets the two
 * values as build args from the repo VARIABLES of the same name
 * (`vars.NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, scaffold/client-build-args.ts),
 * which nothing set. An unset variable builds as "", the layout renders no
 * tracker, and the site counts nothing while every step reported success.
 * Checked live on 2026-11-10: no starter app had a tracker in its HTML.
 * GlitchTip's DSN had the same gap (glitchtip-delivery.ts).
 *
 * ---------------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------------------
 *
 *   1. Read before writing; a variable that already holds the value is
 *      left alone.
 *   2. Write only what is absent, empty or a `CHANGE_ME` placeholder. Any
 *      other value is kept and reported with the command that would
 *      replace it: it may be counting the site under another Plausible
 *      domain, and overwriting it would silently split the stats.
 *   3. Confirm each write by reading it back.
 *   4. `write: false` (`--no-write`) changes nothing and prints the exact
 *      `gh variable set` commands.
 *   5. Never throws: each variable gets an outcome, and one that is not
 *      delivered says how to finish it by hand.
 *
 * Neither value is a secret: both ship in every page the site serves.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { findManifestDirUpward } from "../scaffold/manifest.js";
import { detectRepoSlug } from "../secrets/push.js";
import { exec } from "../utils/exec.js";

export const PLAUSIBLE_DOMAIN_VAR = "NEXT_PUBLIC_PLAUSIBLE_DOMAIN";
export const PLAUSIBLE_SCRIPT_VAR = "NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL";

export type RepoVariable = { kind: "absent" } | { kind: "value"; value: string };

export type RepoVariableDecision = "create" | "replace" | "in-sync" | "keep";

/** Rules 1 and 2, for one variable. */
export function decideRepoVariableWrite(live: RepoVariable, want: string): RepoVariableDecision {
  if (live.kind === "absent") return "create";
  const value = live.value.trim();
  if (value === want) return "in-sync";
  if (value === "" || value.startsWith("CHANGE_ME")) return "replace";
  return "keep";
}

export type PlausibleDeliveryStatus =
  | "created"
  | "updated"
  | "in-sync"
  | "kept"
  | "would-write"
  | "skipped"
  | "failed";

export interface PlausibleDeliveryOutcome {
  variable: string;
  /** `owner/repo`, or "-" when there is none. */
  repo: string;
  status: PlausibleDeliveryStatus;
  /** The exact command that sets this variable. */
  command: string;
  detail?: string;
}

/** Runs `gh` with these arguments. A seam for tests. */
export type GhRunner = (args: string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

const realGh: GhRunner = (args) => exec("gh", args, { silent: true });

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function ghVariableCommand(repo: string | undefined, name: string, value: string): string {
  return `gh variable set ${name} --repo ${repo ?? "<owner/name>"} --body ${shellQuote(value)}`;
}

async function readVariable(gh: GhRunner, repo: string, name: string): Promise<RepoVariable> {
  const res = await gh(["api", `repos/${repo}/actions/variables/${name}`]);
  if (res.exitCode !== 0) {
    if (/404|Not Found/.test(res.stderr + res.stdout)) return { kind: "absent" };
    throw new Error((res.stderr || res.stdout).trim() || `gh api exited ${res.exitCode}`);
  }
  return { kind: "value", value: (JSON.parse(res.stdout) as { value?: string }).value ?? "" };
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/** True when some workflow passes the variable into a build. Undefined
 *  when there is no workflow directory to look in. */
export function workflowsReadVariable(rootDir: string, name: string): boolean | undefined {
  const dir = join(rootDir, ".github", "workflows");
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .some((f) => readFileSync(join(dir, f), "utf-8").includes(`vars.${name}`));
}

export interface DeliverPlausibleArgs {
  /** The project (or its deploy subdir); the repo is its `origin`. */
  projectDir?: string;
  /** The Plausible site domain, e.g. `example.com`. */
  domain: string;
  /** The tracker URL, e.g. `https://plausible.example.com/js/script.js`. */
  scriptUrl: string;
  write: boolean;
  /** Test seams. Default: the project's origin remote, real `gh`, console. */
  repoSlug?: string | null;
  gh?: GhRunner;
  log?: (line: string) => void;
}

/** Set the two build variables on the project's GitHub repo. */
export async function deliverPlausibleBuildVars(
  args: DeliverPlausibleArgs,
): Promise<PlausibleDeliveryOutcome[]> {
  const log = args.log ?? ((line: string) => console.log(line));
  const gh = args.gh ?? realGh;
  const repo =
    args.repoSlug === undefined
      ? await detectRepoSlug(args.projectDir ?? process.cwd())
      : (args.repoSlug ?? undefined);
  const wanted: Array<[string, string]> = [
    [PLAUSIBLE_DOMAIN_VAR, args.domain],
    [PLAUSIBLE_SCRIPT_VAR, args.scriptUrl],
  ];

  log(chalk.bold("\n  ── Plausible build variables ─────────────────────────────\n"));

  if (!repo) {
    log(
      chalk.yellow(
        "  ! No GitHub origin remote to set the build variables on. Run, with the repo filled in:",
      ),
    );
    return wanted.map(([name, value]) => {
      const command = ghVariableCommand(undefined, name, value);
      log(`      ${command}`);
      return { variable: name, repo: "-", status: "skipped" as const, command };
    });
  }

  const rootDir = args.projectDir
    ? (findManifestDirUpward(args.projectDir) ?? args.projectDir)
    : undefined;
  if (rootDir && workflowsReadVariable(rootDir, PLAUSIBLE_DOMAIN_VAR) === false) {
    log(
      chalk.yellow(
        `  ! No workflow in ${join(rootDir, ".github", "workflows")} reads vars.${PLAUSIBLE_DOMAIN_VAR}, so the client build won't see it. Pass both as build args: ${PLAUSIBLE_DOMAIN_VAR}=\${{ vars.${PLAUSIBLE_DOMAIN_VAR} }}.`,
      ),
    );
  }

  const outcomes: PlausibleDeliveryOutcome[] = [];
  for (const [name, value] of wanted) {
    outcomes.push(await deliverOne({ gh, repo, name, value, write: args.write, log }));
  }
  if (outcomes.some((o) => o.status === "created" || o.status === "updated")) {
    log(
      chalk.yellow(
        "  The client build inlines both at build time: the next client build starts counting.",
      ),
    );
  }
  return outcomes;
}

async function deliverOne(args: {
  gh: GhRunner;
  repo: string;
  name: string;
  value: string;
  write: boolean;
  log: (line: string) => void;
}): Promise<PlausibleDeliveryOutcome> {
  const { gh, repo, name, value, log } = args;
  const command = ghVariableCommand(repo, name, value);
  const base = { variable: name, repo, command };
  const fail = (detail: string): PlausibleDeliveryOutcome => {
    log(chalk.red(`  ✗ ${detail}`));
    return { ...base, status: "failed", detail };
  };

  let live: RepoVariable | undefined;
  try {
    live = await readVariable(gh, repo, name);
  } catch (err) {
    if (args.write)
      return fail(`couldn't read ${name} on ${repo}: ${firstLine(err)}. Run: ${command}`);
  }
  const decision = live ? decideRepoVariableWrite(live, value) : "create";
  if (decision === "in-sync") {
    log(chalk.green(`  ✓ ${repo}: ${name} already holds ${value}`));
    return { ...base, status: "in-sync" };
  }
  if (decision === "keep") {
    const current = live?.kind === "value" ? live.value : "";
    const detail = `${name} holds "${current}"; left as is. To point the build at this site instead, run: ${command}`;
    log(chalk.yellow(`  ! ${repo}: ${detail}`));
    return { ...base, status: "kept", detail };
  }
  if (!args.write) {
    log(chalk.dim(`  · ${repo}: not written (--no-write). To set ${name}, run:`));
    log(`      ${command}`);
    return { ...base, status: "would-write" };
  }
  try {
    const res = await gh(["variable", "set", name, "--repo", repo, "--body", value]);
    if (res.exitCode !== 0) {
      throw new Error((res.stderr || res.stdout).trim() || `gh exited ${res.exitCode}`);
    }
    const check = await readVariable(gh, repo, name);
    if (check.kind !== "value" || check.value.trim() !== value) {
      throw new Error("read-back doesn't match the value that was written");
    }
  } catch (err) {
    return fail(`${name} on ${repo} not confirmed: ${firstLine(err)}. Run: ${command}`);
  }
  const status = live?.kind === "absent" ? "created" : "updated";
  log(
    chalk.green(
      `  ✓ ${repo}: ${name} ${status === "created" ? "set" : "replaced the empty value"} (read back)`,
    ),
  );
  return { ...base, status };
}

/** What `add`, `create` and `adopt` call after the Plausible step. A client
 *  that is not a Next app reads other names at build time (its own
 *  `PUBLIC_PLAUSIBLE_*`), which no hatchkit workflow passes in, so it is
 *  told so rather than given variables nothing reads. */
export async function deliverProvisionedPlausible(
  site: { domain: string; scriptUrl: string; projectDir?: string; clientIsNext: boolean },
  options: { projectDir?: string; write: boolean; log?: (line: string) => void },
): Promise<PlausibleDeliveryOutcome[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (!site.clientIsNext) {
    log(
      chalk.yellow(
        "  ! The client is not a Next.js app, so no NEXT_PUBLIC_PLAUSIBLE_* build variable was set. " +
          "Pass PUBLIC_PLAUSIBLE_DOMAIN and PUBLIC_PLAUSIBLE_SCRIPT_URL to its build yourself.",
      ),
    );
    return [];
  }
  return deliverPlausibleBuildVars({
    projectDir: site.projectDir ?? options.projectDir,
    domain: site.domain,
    scriptUrl: site.scriptUrl,
    write: options.write,
    log,
  });
}
