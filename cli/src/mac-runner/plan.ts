/*
 * Pure decisions for `hatchkit mac-runner` (./command.ts does the I/O).
 *
 * The Apple jobs of a workflow run on `${{ vars.APPLE_RUNNER || 'macos-15' }}`.
 * With the variable unset they run on GitHub's macOS runners, as before.
 * With it set to a label, they wait for a runner with that label — this Mac,
 * which registers a just-in-time runner only while `mac-runner serve` runs.
 * Nothing listens otherwise, so no job can start here unasked.
 */

export const RUNNER_VARIABLE = "APPLE_RUNNER";
export const DEFAULT_LABEL = "hatchkit-mac";

/** Run states in which a run can still create or start a job. */
const ACTIVE_RUN_STATES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

export function isActiveRun(status: string | null | undefined): boolean {
  return ACTIVE_RUN_STATES.has(status ?? "");
}

/** One custom label. Not a GitHub-hosted label (a job would silently go to
 *  GitHub) and not `self-hosted` (every self-hosted runner has it). */
export function labelProblem(label: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
    return "a label is 1-64 letters, digits, '.', '_' or '-'";
  }
  const lower = label.toLowerCase();
  if (lower === "self-hosted" || lower === "macos" || lower === "arm64" || lower === "x64") {
    return `"${label}" is a default runner label; pick one only this Mac has`;
  }
  if (/^(macos|ubuntu|windows)-/.test(lower)) {
    return `"${label}" is a GitHub-hosted runner label; the jobs would run on GitHub`;
  }
  return null;
}

/** owner/name from an https or ssh GitHub remote URL. */
export function repoFromRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function isRepoSlug(value: string): boolean {
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value);
}

/** The runner package for this Mac. */
export function runnerPackage(version: string, arch: string): { name: string; platform: string } {
  const platform = arch === "arm64" ? "osx-arm64" : "osx-x64";
  return { name: `actions-runner-${platform}-${version}.tar.gz`, platform };
}

/** The SHA-256 that actions/runner publishes in its release notes, between
 *  `<!-- BEGIN SHA osx-arm64 -->` and `<!-- END SHA osx-arm64 -->`. */
export function releaseSha(body: string, platform: string): string | null {
  const escaped = platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(`<!-- BEGIN SHA ${escaped} -->\\s*([0-9a-f]{64})\\s*<!-- END SHA ${escaped} -->`),
  );
  return match ? match[1] : null;
}

/** `security list-keychains -d user` output, one quoted path per line. */
export function parseKeychainList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter((line) => line.length > 0);
}

/** The search list without the temporary keychains a job left under `root`
 *  (a job that was stopped before its cleanup step). Null: nothing to drop.
 *  Only paths under `root` are removed, so the login keychain and anything
 *  else the user added stay where they are. */
export function scrubKeychains(list: string[], root: string): string[] | null {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const kept = list.filter((path) => !path.startsWith(prefix));
  return kept.length === list.length ? null : kept;
}

/** `-f key=value` pairs for `gh workflow run`. */
export function parseFields(values: string[]): { fields: string[]; problem: string | null } {
  for (const value of values) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*=/.test(value)) {
      return { fields: [], problem: `expected key=value, got "${value}"` };
    }
  }
  return { fields: values, problem: null };
}

/** The run id in `gh workflow run` output (`…/<repo>/actions/runs/<id>`),
 *  when this gh prints one and it is for this repo. */
export function runIdFromDispatchOutput(output: string, repo: string): number | null {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`github\\.com/${escaped}/actions/runs/(\\d+)`));
  return match ? Number(match[1]) : null;
}

export interface RunSummary {
  id: number;
  created_at: string;
  head_branch: string | null;
  event: string;
  actor?: { login: string } | null;
}

/** The run a dispatch just created: the newest workflow_dispatch run of this
 *  actor on `ref`, created no earlier than a few seconds before the dispatch
 *  (GitHub's clock and this one disagree a little). */
export function pickDispatchedRun(
  runs: RunSummary[],
  opts: { since: number; ref: string; actor: string },
): RunSummary | null {
  const branch = opts.ref.replace(/^refs\/(heads|tags)\//, "");
  const candidates = runs.filter(
    (run) =>
      run.event === "workflow_dispatch" &&
      Date.parse(run.created_at) >= opts.since - 10_000 &&
      (run.head_branch === branch || run.head_branch === null) &&
      (run.actor?.login ?? opts.actor) === opts.actor,
  );
  candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return candidates[0] ?? null;
}

export interface JobSummary {
  name: string;
  status: string;
  labels: string[];
  runner_name: string | null;
}

/** Jobs of a run that are waiting for, or running on, a runner with `label`. */
export function jobsForLabel(
  jobs: JobSummary[],
  label: string,
): {
  queued: string[];
  running: string[];
} {
  const mine = jobs.filter((job) => job.labels.includes(label));
  return {
    queued: mine
      .filter((job) => job.status === "queued" || job.status === "waiting")
      .map((j) => j.name),
    running: mine.filter((job) => job.status === "in_progress").map((j) => j.name),
  };
}

/** The environment a job sees. The runner hands its own environment to every
 *  step, so it gets a minimal one: the tools the Apple jobs call, and none of
 *  the operator's tokens (a GH_TOKEN would outrank the job's own token). */
export function runnerEnv(env: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const out: Record<string, string> = {
    HOME: home,
    PATH: [
      `${home}/.cargo/bin`,
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    LANG: env.LANG || "en_US.UTF-8",
  };
  for (const key of ["USER", "LOGNAME", "SHELL", "TMPDIR", "DEVELOPER_DIR"]) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}
