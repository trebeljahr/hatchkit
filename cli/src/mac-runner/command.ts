/*
 * `hatchkit mac-runner` — run a repo's Apple jobs (macOS and iOS builds) on
 * this Mac instead of GitHub's macOS runners, on demand.
 *
 * The workflows pick their runner with `${{ vars.APPLE_RUNNER || 'macos-15' }}`.
 * `on` sets the variable to a label; from then on the Apple jobs wait for a
 * runner with that label. `serve` registers a just-in-time runner for the
 * repo, hosts the queued jobs, and deregisters when the runs are done, so a
 * runner exists only while someone runs the command here. Everything after
 * the build (artifacts, TestFlight, Steam, itch, draft releases) is the same
 * workflow as before, so it needs no change.
 *
 * The jobs run as the logged-in user. ./plan.ts → runnerEnv keeps the
 * operator's tokens out of their environment; the workflows keep their
 * signing material in RUNNER_TEMP; `serve` drops leftover temporary
 * keychains from the search list when it stops.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { exec } from "../utils/exec.js";
import {
  DEFAULT_LABEL,
  type JobSummary,
  RUNNER_VARIABLE,
  type RunSummary,
  isActiveRun,
  isRepoSlug,
  jobsForLabel,
  labelProblem,
  parseFields,
  parseKeychainList,
  pickDispatchedRun,
  releaseSha,
  repoFromRemote,
  runIdFromDispatchOutput,
  runnerEnv,
  runnerPackage,
  scrubKeychains,
} from "./plan.js";

export const MAC_RUNNER_USAGE = `Usage:
  hatchkit mac-runner status [--repo <owner/name>] [--json]
  hatchkit mac-runner on [--repo <owner/name>] [--label <label>] [--allow-public]
  hatchkit mac-runner off [--repo <owner/name>]
  hatchkit mac-runner serve [--repo <owner/name>] [--run <id>] [--parallel <n>] [--keep-work]
  hatchkit mac-runner run <workflow> [--repo <owner/name>] [--ref <ref>] [-f key=value]…
                          [--parallel <n>] [--keep-work]

mac-runner moves a repo's Apple jobs (macOS and iOS builds) from GitHub's
macOS runners, which bill 10× Linux minutes in a private repo, to this Mac.
The jobs read the repo variable ${RUNNER_VARIABLE}: unset, they run on GitHub;
set to a label, they wait for this Mac. The rest of each workflow — the
artifacts, TestFlight, Steam, itch, the draft release — stays on GitHub.

status  the variable, and the jobs waiting for this Mac.
on      sets ${RUNNER_VARIABLE} (default label ${DEFAULT_LABEL}). Refuses a public
        repo: a pull request from a fork can name the label and run its code
        here. Its macOS minutes are free anyway.
off     deletes the variable; the Apple jobs go back to GitHub.
serve   registers a just-in-time runner for the repo and hosts the jobs queued
        for the label until the watched runs finish, then deregisters. Watches
        --run, else every run that is queued or in progress (a tag push, an
        agent's dispatch). Nothing runs here unless serve does.
run     dispatches the workflow (gh workflow run) and serves that run.

--parallel runs that many jobs at once (default 1). --keep-work keeps the job
workspaces under ~/Library/Caches/hatchkit/mac-runner (deleted by default).
Jobs run niced, as this user, with a minimal environment (none of your
tokens), and the Mac is kept awake while serve runs.`;

const RUNNER_STATE_FILES = [".runner", ".credentials", ".credentials_rsaparams"];
const TICK_MS = 10_000;
const LOW_DISK_BYTES = 25 * 1024 ** 3;

interface Flags {
  positional: string[];
  repo?: string;
  label?: string;
  run?: string;
  ref?: string;
  parallel: number;
  fields: string[];
  json: boolean;
  keepWork: boolean;
  allowPublic: boolean;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    positional: [],
    parallel: 1,
    fields: [],
    json: false,
    keepWork: false,
    allowPublic: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--repo") flags.repo = value();
    else if (arg === "--label") flags.label = value();
    else if (arg === "--run") flags.run = value();
    else if (arg === "--ref") flags.ref = value();
    else if (arg === "-f" || arg === "--field") flags.fields.push(value());
    else if (arg === "--parallel") flags.parallel = Number(value());
    else if (arg === "--json") flags.json = true;
    else if (arg === "--keep-work") flags.keepWork = true;
    else if (arg === "--allow-public") flags.allowPublic = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown flag ${arg}`);
    else flags.positional.push(arg);
  }
  if (!Number.isInteger(flags.parallel) || flags.parallel < 1 || flags.parallel > 4) {
    throw new Error("--parallel takes 1 to 4");
  }
  if (flags.run !== undefined && !/^\d+$/.test(flags.run)) {
    throw new Error("--run takes a numeric run id");
  }
  return flags;
}

export async function runMacRunnerCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  let flags: Flags;
  try {
    flags = parseArgs(rest);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    console.log(MAC_RUNNER_USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    switch (sub) {
      case "status":
        await status(flags);
        return;
      case "on":
        await turnOn(flags);
        return;
      case "off":
        await turnOff(flags);
        return;
      case "serve":
        process.exitCode = await serve(flags, flags.run ? Number(flags.run) : undefined);
        return;
      case "run":
        process.exitCode = await dispatchAndServe(flags);
        return;
      default:
        console.log(MAC_RUNNER_USAGE);
        if (sub !== undefined) process.exitCode = 1;
    }
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

// ── GitHub ────────────────────────────────────────────────────────────────

async function gh(args: string[]): Promise<string> {
  const res = await exec("gh", args, { silent: true });
  if (res.exitCode !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  return res.stdout;
}

async function ghApi<T>(path: string, extra: string[] = []): Promise<T> {
  return JSON.parse(await gh(["api", ...extra, path])) as T;
}

async function resolveRepo(flag: string | undefined): Promise<string> {
  if (flag) {
    if (!isRepoSlug(flag)) throw new Error(`--repo takes owner/name, got "${flag}"`);
    return flag;
  }
  const res = await exec("git", ["remote", "get-url", "origin"], { silent: true });
  const repo = res.exitCode === 0 ? repoFromRemote(res.stdout) : null;
  if (!repo) throw new Error("No GitHub origin here. Pass --repo <owner/name>.");
  return repo;
}

interface RepoInfo {
  visibility: string;
  default_branch: string;
  permissions?: { admin?: boolean };
}

async function repoInfo(repo: string): Promise<RepoInfo> {
  return ghApi<RepoInfo>(`repos/${repo}`);
}

async function readVariable(repo: string): Promise<string | null> {
  const res = await exec("gh", ["api", `repos/${repo}/actions/variables/${RUNNER_VARIABLE}`], {
    silent: true,
  });
  if (res.exitCode !== 0) {
    if (/404|Not Found/.test(res.stderr + res.stdout)) return null;
    throw new Error(`Could not read ${RUNNER_VARIABLE} on ${repo}: ${res.stderr.trim()}`);
  }
  const value = (JSON.parse(res.stdout) as { value?: string }).value?.trim();
  return value ? value : null;
}

interface RunDetail extends RunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  display_title?: string;
}

async function activeRuns(repo: string): Promise<RunDetail[]> {
  const res = await ghApi<{ workflow_runs: RunDetail[] }>(
    `repos/${repo}/actions/runs?per_page=50&exclude_pull_requests=true`,
  );
  return res.workflow_runs.filter((run) => isActiveRun(run.status));
}

async function runJobs(repo: string, runId: number): Promise<JobSummary[]> {
  const res = await ghApi<{ jobs: JobSummary[] }>(
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return res.jobs;
}

// ── status / on / off ─────────────────────────────────────────────────────

async function status(flags: Flags): Promise<void> {
  const repo = await resolveRepo(flags.repo);
  const [info, label] = await Promise.all([repoInfo(repo), readVariable(repo)]);
  const waiting: Array<{ run: RunDetail; queued: string[]; running: string[] }> = [];
  if (label) {
    for (const run of await activeRuns(repo)) {
      const jobs = jobsForLabel(await runJobs(repo, run.id), label);
      if (jobs.queued.length > 0 || jobs.running.length > 0) waiting.push({ run, ...jobs });
    }
  }
  const installed = installedPackages(runnerRoot());
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          repo,
          visibility: info.visibility,
          variable: RUNNER_VARIABLE,
          label,
          mode: label ? "this-mac" : "github-hosted",
          runnerPackages: installed,
          waiting: waiting.map((w) => ({
            runId: w.run.id,
            workflow: w.run.name,
            url: w.run.html_url,
            queued: w.queued,
            running: w.running,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`${chalk.bold(repo)} (${info.visibility})`);
  if (!label) {
    console.log(`  ${RUNNER_VARIABLE} unset: Apple jobs run on GitHub-hosted macOS runners.`);
    console.log(chalk.dim(`  hatchkit mac-runner on --repo ${repo} moves them to this Mac.`));
    return;
  }
  console.log(`  ${RUNNER_VARIABLE}=${label}: Apple jobs wait for this Mac.`);
  console.log(
    chalk.dim(
      `  Runner package: ${installed.length ? installed.join(", ") : "not downloaded yet (serve downloads it)"}`,
    ),
  );
  if (waiting.length === 0) {
    console.log("  No job is waiting for this Mac.");
    return;
  }
  for (const w of waiting) {
    console.log(`  ${w.run.name} #${w.run.id} ${chalk.dim(w.run.html_url)}`);
    if (w.queued.length) console.log(`    waiting: ${w.queued.join(", ")}`);
    if (w.running.length) console.log(`    running: ${w.running.join(", ")}`);
  }
  console.log(chalk.dim(`  hatchkit mac-runner serve --repo ${repo} runs them.`));
}

async function turnOn(flags: Flags): Promise<void> {
  const repo = await resolveRepo(flags.repo);
  const label = flags.label ?? DEFAULT_LABEL;
  const problem = labelProblem(label);
  if (problem) throw new Error(problem);
  const info = await repoInfo(repo);
  if (info.visibility === "public" && !flags.allowPublic) {
    throw new Error(
      `${repo} is public. Its macOS minutes cost nothing, and a pull request from a fork can name ${label} in its own workflow and run code on this Mac. --allow-public overrides.`,
    );
  }
  await gh(["variable", "set", RUNNER_VARIABLE, "--repo", repo, "--body", label]);
  console.log(chalk.green(`✓ ${repo}: ${RUNNER_VARIABLE}=${label}`));
  if (!workflowsReadVariable()) {
    console.log(
      chalk.yellow(
        `! No workflow in this checkout reads vars.${RUNNER_VARIABLE}, so nothing moves yet. The Apple jobs need runs-on: \${{ vars.${RUNNER_VARIABLE} || 'macos-15' }}.`,
      ),
    );
  }
  console.log(
    `Apple jobs now wait for this Mac. Start them with ${chalk.cyan("hatchkit mac-runner serve")} or ${chalk.cyan("hatchkit mac-runner run <workflow>")}.`,
  );
  console.log(
    chalk.dim(
      `A job nobody serves fails after 24 hours. hatchkit mac-runner off --repo ${repo} sends them back to GitHub.`,
    ),
  );
}

async function turnOff(flags: Flags): Promise<void> {
  const repo = await resolveRepo(flags.repo);
  if ((await readVariable(repo)) === null) {
    console.log(`${repo}: ${RUNNER_VARIABLE} is not set; Apple jobs already run on GitHub.`);
    return;
  }
  await gh(["variable", "delete", RUNNER_VARIABLE, "--repo", repo]);
  console.log(
    chalk.green(`✓ ${repo}: ${RUNNER_VARIABLE} deleted; Apple jobs run on GitHub again.`),
  );
  console.log(
    chalk.dim("Jobs already queued for this Mac keep waiting; serve them or cancel the runs."),
  );
}

/** True when a workflow in the current checkout reads the variable, or when
 *  there is no checkout to look at (--repo from elsewhere). */
function workflowsReadVariable(): boolean {
  const dir = join(process.cwd(), ".github", "workflows");
  if (!existsSync(dir)) return true;
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .some((f) => readFileSync(join(dir, f), "utf-8").includes(`vars.${RUNNER_VARIABLE}`));
}

// ── runner package ────────────────────────────────────────────────────────

function runnerRoot(): string {
  return (
    process.env.HATCHKIT_MAC_RUNNER_DIR ??
    join(homedir(), "Library", "Caches", "hatchkit", "mac-runner")
  );
}

function installedPackages(root: string): string[] {
  const dir = join(root, "package");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((v) => existsSync(join(dir, v, "run.sh")));
}

/** The latest actions/runner release, verified against the SHA-256 in its
 *  release notes. GitHub stops assigning jobs to runners that fall too far
 *  behind, so serve always starts on the latest one. */
async function ensureRunnerPackage(root: string): Promise<string> {
  const release = await ghApi<{ tag_name: string; body: string }>(
    "repos/actions/runner/releases/latest",
  );
  const version = release.tag_name.replace(/^v/, "");
  const dir = join(root, "package", version);
  if (existsSync(join(dir, "run.sh"))) return dir;

  const { name, platform } = runnerPackage(version, process.arch);
  const expected = releaseSha(release.body, platform);
  if (!expected)
    throw new Error(`actions/runner ${release.tag_name} lists no SHA-256 for ${platform}.`);
  const url = `https://github.com/actions/runner/releases/download/v${version}/${name}`;
  console.log(chalk.dim(`Downloading ${name} from github.com/actions/runner …`));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download of ${url} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`${name}: SHA-256 ${actual} does not match the release notes (${expected}).`);
  }
  const staging = `${dir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, name);
  writeFileSync(archive, bytes);
  const untar = await exec("tar", ["-xzf", archive, "-C", staging], { silent: true });
  rmSync(archive, { force: true });
  if (untar.exitCode !== 0) throw new Error(`Could not unpack ${name}: ${untar.stderr.trim()}`);
  renameSync(staging, dir);
  for (const old of installedPackages(root)) {
    if (old !== version) rmSync(join(root, "package", old), { recursive: true, force: true });
  }
  console.log(chalk.dim(`Runner ${version} verified and unpacked.`));
  return dir;
}

// ── serve ─────────────────────────────────────────────────────────────────

interface Slot {
  index: number;
  dir: string;
  child: ChildProcess | null;
  runnerId: number | null;
  busy: string | null;
}

async function dispatchAndServe(flags: Flags): Promise<number> {
  const workflow = flags.positional[0];
  if (!workflow) throw new Error("run needs a workflow file or name, e.g. build-macos.yml");
  const { fields, problem } = parseFields(flags.fields);
  if (problem) throw new Error(problem);
  const repo = await resolveRepo(flags.repo);
  const label = await readVariable(repo);
  if (!label) throw new Error(notOnMessage(repo));
  const [info, me, wf] = await Promise.all([
    repoInfo(repo),
    gh(["api", "user", "--jq", ".login"]).then((s) => s.trim()),
    ghApi<{ id: number; name: string }>(
      `repos/${repo}/actions/workflows/${encodeURIComponent(workflow.replace(/^.*\//, ""))}`,
    ).catch(async () => {
      const out = await gh(["workflow", "view", workflow, "--repo", repo, "--json", "id,name"]);
      return JSON.parse(out) as { id: number; name: string };
    }),
  ]);
  const ref = flags.ref ?? info.default_branch;
  const since = Date.now();
  const dispatched = await gh([
    "workflow",
    "run",
    String(wf.id),
    "--repo",
    repo,
    "--ref",
    ref,
    ...fields.flatMap((f) => ["-f", f]),
  ]);
  console.log(chalk.green(`✓ Dispatched ${wf.name} on ${ref}`));
  // Recent gh prints the new run's URL; older versions print nothing.
  const printed = runIdFromDispatchOutput(dispatched, repo);
  if (printed !== null) return serve({ ...flags, repo }, printed);
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(3000);
    const runs = await ghApi<{ workflow_runs: RunSummary[] }>(
      `repos/${repo}/actions/workflows/${wf.id}/runs?event=workflow_dispatch&per_page=20`,
    );
    const run = pickDispatchedRun(runs.workflow_runs, { since, ref, actor: me });
    if (run) return serve({ ...flags, repo }, run.id);
  }
  throw new Error(
    `The dispatched run did not show up within a minute. Find it with gh run list --repo ${repo} and serve it with --run <id>.`,
  );
}

function notOnMessage(repo: string): string {
  return `${RUNNER_VARIABLE} is not set on ${repo}, so its Apple jobs run on GitHub, not here. hatchkit mac-runner on --repo ${repo} first.`;
}

async function serve(flags: Flags, onlyRun?: number): Promise<number> {
  if (process.platform !== "darwin") throw new Error("mac-runner serves Apple jobs from a Mac.");
  const repo = await resolveRepo(flags.repo);
  const [info, label] = await Promise.all([repoInfo(repo), readVariable(repo)]);
  if (!label) throw new Error(notOnMessage(repo));
  if (info.visibility === "public" && !flags.allowPublic) {
    throw new Error(
      `${repo} is public: a fork's pull request could take this runner. --allow-public overrides.`,
    );
  }

  // Which runs to wait for. A tag push may take a few seconds to show up.
  const watched = new Map<number, RunDetail>();
  if (onlyRun !== undefined) {
    watched.set(onlyRun, await ghApi<RunDetail>(`repos/${repo}/actions/runs/${onlyRun}`));
  } else {
    for (let attempt = 0; attempt < 12 && watched.size === 0; attempt++) {
      for (const run of await activeRuns(repo)) watched.set(run.id, run);
      if (watched.size === 0) {
        if (attempt === 0)
          console.log(chalk.dim("No run is queued or in progress; waiting a minute for one …"));
        await sleep(5000);
      }
    }
    if (watched.size === 0) {
      console.log(`Nothing to serve: ${repo} has no run queued or in progress.`);
      return 0;
    }
  }
  const finished = new Map<number, RunDetail>();
  for (const [id, run] of watched) {
    if (!isActiveRun(run.status)) {
      finished.set(id, run);
      watched.delete(id);
    }
  }

  const root = runnerRoot();
  mkdirSync(root, { recursive: true });
  warnOnLowDisk(root);
  const pkg = await ensureRunnerPackage(root);
  const slotsDir = join(root, "slots");
  const toolCache = join(root, "tool-cache");
  mkdirSync(toolCache, { recursive: true });
  // pnpm and npm read ~/.npmrc, which may hold the operator's registry
  // token; a job installs as GitHub's runners do, with no user config.
  const npmrc = join(root, "npmrc");
  if (!existsSync(npmrc)) writeFileSync(npmrc, "");
  const slots: Slot[] = Array.from({ length: flags.parallel }, (_, index) => ({
    index,
    dir: join(slotsDir, `${process.pid}-${index + 1}`),
    child: null,
    runnerId: null,
    busy: null,
  }));
  const created = new Set<number>();

  console.log(
    `${chalk.bold(repo)}: serving jobs labelled ${chalk.cyan(label)} for ${
      [...watched.values()].map((r) => `${r.name} #${r.id}`).join(", ") ||
      "runs that already finished"
    }`,
  );
  const caffeinate = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
    stdio: "ignore",
  });
  caffeinate.unref();

  let stopping = false;
  let interrupted = false;
  let failedStarts = 0;
  const onSigint = (): void => {
    if (interrupted) {
      for (const slot of slots) killGroup(slot.child, "SIGKILL");
      return;
    }
    interrupted = true;
    stopping = true;
    console.log(chalk.yellow("\nStopping; a running job is cancelled. Ctrl-C again kills it."));
    for (const slot of slots) killGroup(slot.child, "SIGINT");
  };
  process.on("SIGINT", onSigint);

  const startSlot = async (slot: Slot): Promise<void> => {
    if (!existsSync(join(slot.dir, "run.sh"))) {
      mkdirSync(slotsDir, { recursive: true });
      // APFS clone: the copy costs no disk until the runner writes to it.
      const copy = await exec("cp", ["-cR", pkg, slot.dir], { silent: true });
      if (copy.exitCode !== 0) throw new Error(`Could not copy the runner: ${copy.stderr.trim()}`);
    }
    for (const f of RUNNER_STATE_FILES) rmSync(join(slot.dir, f), { force: true });
    const name =
      `${hostname().split(".")[0]}-${process.pid}-${slot.index + 1}-${Date.now() % 100000}`
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 64);
    const jit = await ghApi<{ runner: { id: number }; encoded_jit_config: string }>(
      `repos/${repo}/actions/runners/generate-jitconfig`,
      [
        "-X",
        "POST",
        "-f",
        `name=${name}`,
        "-F",
        "runner_group_id=1",
        "-f",
        `labels[]=${label}`,
        "-f",
        "work_folder=_work",
      ],
    );
    created.add(jit.runner.id);
    slot.runnerId = jit.runner.id;
    const child = spawn("/usr/bin/nice", ["-n", "10", "./run.sh"], {
      cwd: slot.dir,
      env: {
        ...runnerEnv(process.env, homedir()),
        RUNNER_TOOL_CACHE: toolCache,
        NPM_CONFIG_USERCONFIG: npmrc,
        // Read by the runner like --jitconfig, without putting the
        // credential in the process list.
        ACTIONS_RUNNER_INPUT_JITCONFIG: jit.encoded_jit_config,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    slot.child = child;
    const startedAt = Date.now();
    const tag = chalk.dim(`[mac-${slot.index + 1}]`);
    const onLine = (line: string): void => {
      if (!line.trim()) return;
      const running = line.match(/Running job: (.+)$/);
      if (running) slot.busy = running[1].trim();
      if (/Job .+ completed with result/.test(line)) slot.busy = null;
      console.log(`${tag} ${line}`);
    };
    pipeLines(child.stdout, onLine);
    pipeLines(child.stderr, onLine);
    child.on("exit", (code) => {
      slot.child = null;
      slot.busy = null;
      if (code !== 0 && Date.now() - startedAt < 30_000 && !stopping) failedStarts++;
      else failedStarts = 0;
      if (slot.runnerId !== null) void deregister(repo, slot.runnerId, created);
      slot.runnerId = null;
    });
  };

  try {
    let lastLine = "";
    // A dropped connection must not stop serve in the middle of a job: an
    // API call that fails is retried on the next tick, for up to 5 minutes.
    let apiFailures = 0;
    while (true) {
      if (failedStarts >= 3) {
        console.error(chalk.red("✗ The runner exited at start three times in a row; stopping."));
        stopping = true;
      }
      if (apiFailures >= 30) {
        console.error(chalk.red("✗ GitHub has not answered for 5 minutes; stopping."));
        stopping = true;
      }
      if (!stopping) {
        try {
          for (const [id] of watched) {
            const run = await ghApi<RunDetail>(`repos/${repo}/actions/runs/${id}`);
            if (!isActiveRun(run.status)) {
              watched.delete(id);
              finished.set(id, run);
              console.log(
                `${run.conclusion === "success" ? chalk.green("✓") : chalk.red("✗")} ${run.name} #${id}: ${run.conclusion} ${chalk.dim(run.html_url)}`,
              );
            }
          }
          if (watched.size === 0) stopping = true;
          apiFailures = 0;
        } catch (err) {
          apiFailures++;
          if (apiFailures === 1)
            console.error(chalk.yellow(`! ${(err as Error).message}; retrying`));
        }
      }
      if (stopping) {
        // A job from another run may have started on a runner meanwhile;
        // let it finish unless this is an interrupt.
        const busy = slots.filter((s) => s.busy && s.child);
        if (busy.length === 0 || interrupted) break;
        const line = `Waiting for ${busy.map((s) => s.busy).join(", ")} to finish …`;
        if (line !== lastLine) console.log(chalk.dim(line));
        lastLine = line;
      } else {
        for (const slot of slots) {
          if (slot.child) continue;
          try {
            await startSlot(slot);
          } catch (err) {
            apiFailures++;
            if (apiFailures === 1)
              console.error(chalk.yellow(`! ${(err as Error).message}; retrying`));
          }
        }
        const line = await waitingLine(repo, label, [...watched.keys()]);
        if (line && line !== lastLine) console.log(chalk.dim(line));
        lastLine = line;
      }
      await sleep(TICK_MS);
    }
  } finally {
    process.off("SIGINT", onSigint);
    await stopSlots(slots);
    await Promise.all([...created].map((id) => deregister(repo, id, created)));
    await scrubLeftoverKeychains(root);
    if (flags.keepWork) {
      console.log(chalk.dim(`Kept the job workspaces in ${slotsDir}.`));
    } else {
      for (const slot of slots) rmSync(slot.dir, { recursive: true, force: true });
    }
    caffeinate.kill();
  }

  if (interrupted) return 130;
  const failed = [...finished.values()].filter((r) => r.conclusion !== "success");
  return failed.length > 0 ? 1 : 0;
}

async function waitingLine(repo: string, label: string, runIds: number[]): Promise<string> {
  const queued: string[] = [];
  for (const id of runIds) {
    const jobs = jobsForLabel(await runJobs(repo, id).catch(() => []), label);
    queued.push(...jobs.queued);
  }
  return queued.length ? `Queued for this Mac: ${queued.join(", ")}` : "";
}

async function stopSlots(slots: Slot[]): Promise<void> {
  for (const slot of slots) killGroup(slot.child, "SIGINT");
  for (let waited = 0; waited < 30_000 && slots.some((s) => s.child); waited += 500) {
    await sleep(500);
  }
  for (const slot of slots) killGroup(slot.child, "SIGKILL");
}

function killGroup(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

/** A just-in-time runner deregisters itself after its one job. One that was
 *  stopped while listening stays registered (offline) until deleted. */
async function deregister(repo: string, id: number, created: Set<number>): Promise<void> {
  if (!created.has(id)) return;
  created.delete(id);
  await exec("gh", ["api", "-X", "DELETE", `repos/${repo}/actions/runners/${id}`], {
    silent: true,
  });
}

/** A job stopped before its cleanup step leaves its temporary keychain in
 *  the user's search list. Drop the entries under the runner directory; the
 *  files went with the workspace. */
async function scrubLeftoverKeychains(root: string): Promise<void> {
  const list = await exec("security", ["list-keychains", "-d", "user"], { silent: true });
  if (list.exitCode !== 0) return;
  const kept = scrubKeychains(parseKeychainList(list.stdout), root);
  if (!kept) return;
  const set = await exec("security", ["list-keychains", "-d", "user", "-s", ...kept], {
    silent: true,
  });
  if (set.exitCode === 0)
    console.log(chalk.dim("Removed a stopped job's keychain from the search list."));
}

function warnOnLowDisk(root: string): void {
  try {
    const fs = statfsSync(root);
    const free = fs.bavail * fs.bsize;
    if (free < LOW_DISK_BYTES) {
      console.log(
        chalk.yellow(
          `! ${(free / 1024 ** 3).toFixed(0)} GB free. A Tauri universal build or an iOS archive can take 10-20 GB while it runs.`,
        ),
      );
    }
  } catch {
    // statfs is advisory only.
  }
}

function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
