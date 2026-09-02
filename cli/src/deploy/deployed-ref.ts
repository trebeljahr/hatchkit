/*
 * deployed-ref — does the commit Coolify will clone actually contain
 * the compose file the application is configured to build from?
 *
 * ---------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------
 *
 * Coolify does not deploy your working tree. It clones the git remote
 * at the application's branch (or its pinned `git_commit_sha`) and
 * reads `base_directory + docker_compose_location` out of THAT commit.
 * A compose file that exists on disk but has never been pushed is,
 * from Coolify's point of view, a file that does not exist.
 *
 * The failure this produces is spectacularly misleading. Coolify's
 * deployment log shows `git ls-remote`, `git clone --depth=1`,
 * `git fetch` and `git log -1` ALL SUCCEEDING — and then ends with:
 *
 *     Deployment failed: Failed to read Git source:
 *     fatal: could not read Username for 'https://github.com':
 *       No such device or address
 *     fatal: expected flush after ref listing
 *
 * which reads as a credentials problem and is not one. The clone
 * worked; `loadComposeFile()` then failed looking for a path that
 * isn't in the cloned tree, and the generic git error is what gets
 * surfaced. Diagnosing that from the message costs hours. The `git
 * log -1` line in the same log holds the actual answer: it prints the
 * subject of the commit that was cloned, and it is not the commit you
 * are looking at locally.
 *
 * Concretely (tracktime, 2026-09-02): sync created two split apps at
 * `/docker-compose.client.yml` and `/docker-compose.server.yml`, every
 * deploy failed with the message above, and `origin/main` was still at
 * the initial scaffold commit — 55 commits behind local `main`, which
 * is where both compose files first appear. Nothing was wrong with the
 * credentials, the apps, the routing, or Coolify.
 *
 * ---------------------------------------------------------------------
 * What this checks
 * ---------------------------------------------------------------------
 *
 *   1. The remote ref exists at all. A branch that was never pushed
 *      cannot be cloned.
 *   2. Every compose path a routed app will build from EXISTS at that
 *      ref (`git cat-file -e <sha>:<path>`). This is the check that
 *      catches the failure above instantly, and it generalises: any
 *      app whose compose location is absent at the deployed ref is
 *      guaranteed to fail, whatever the reason.
 *   3. How far the local branch has run ahead of the remote — context
 *      for (2), and worth saying on its own even when every path is
 *      present, because "the deploy succeeded but shipped old code" is
 *      the same misunderstanding with a quieter symptom.
 *
 * Read-only throughout: `git fetch` is the only network call, and it
 * writes nothing but remote-tracking refs. Everything else is plumbing
 * against the object database.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../utils/exec.js";

/** One compose path that must exist at the deployed ref. */
export interface DeployedPathProbe {
  /** Coolify application this path belongs to. */
  appName: string;
  /** Repo-root-relative path, as Coolify resolves it:
   *  `base_directory` joined with `docker_compose_location`. */
  path: string;
  /** True when the path exists in the deployed ref's tree. */
  present: boolean;
  /** True when the file exists in the local working tree. Separates
   *  "you forgot to push" from "this path is simply wrong", which need
   *  completely different fixes. */
  localPresent: boolean;
}

export interface DeployedRefReport {
  /** Whether the check reached a verdict. False means it was skipped
   *  (not a git repo, no remote, git unavailable) — never a failure. */
  ran: boolean;
  /** Populated when `ran` is false: why the check couldn't run. */
  skipped?: string;
  /** Git remote Coolify clones from. */
  remote: string;
  /** Branch Coolify clones. */
  branch: string;
  /** Human label of the ref actually probed — `origin/main`, or the
   *  pinned sha when the application pins one. */
  ref: string;
  /** Set when the Coolify app pins a specific commit rather than
   *  tracking the branch tip. Branch progress is then irrelevant. */
  pinnedCommit?: string;
  /** Whether the pre-check `git fetch` succeeded. When false the ref
   *  below is whatever the local clone last saw, which can be stale —
   *  said out loud rather than silently trusted. */
  fetched: boolean;
  fetchError?: string;
  /** Resolved sha + subject of the deployed ref. Undefined when the
   *  ref doesn't resolve, which is itself blocking. */
  refSha?: string;
  refSubject?: string;
  /** Local HEAD, for the "you are N commits ahead" line. */
  headSha?: string;
  headSubject?: string;
  headBranch?: string;
  /** Commits on local HEAD that the deployed ref doesn't have, and
   *  vice versa. Undefined when either side didn't resolve. */
  ahead?: number;
  behind?: number;
  probes: DeployedPathProbe[];
  /** Probes that came back absent — the actionable subset. */
  missing: DeployedPathProbe[];
  /** True when this ref cannot produce a working deploy: it doesn't
   *  exist, or a required compose path is absent from it. */
  blocking: boolean;
}

/** Where Coolify looks for an application's compose file, as a
 *  repo-root-relative path.
 *
 *  Coolify resolves `docker_compose_location` INSIDE `base_directory`
 *  — an app with `base_directory: "/site"` and
 *  `docker_compose_location: "/docker-compose.yml"` builds from
 *  `site/docker-compose.yml`. That is also where hatchkit's scaffolder
 *  writes it for a `projectSubdir` project, so the two agree by
 *  construction; this function is the one place that spells the join
 *  out, so a caller can hand git a path git will recognise. */
export function composePathAtRepoRoot(composeLocation: string, projectSubdir?: string): string {
  const file = composeLocation.replace(/^\/+/, "").replace(/\\/g, "/");
  const dir = (projectSubdir ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!dir || dir === ".") return file;
  return `${dir}/${file}`;
}

/** A Coolify `git_commit_sha` that actually pins a commit. Coolify
 *  stores the literal string `"HEAD"` (and older builds an empty
 *  string) to mean "track the branch tip", which is not a commit and
 *  must not be probed as one. */
export function pinnedCommitOf(gitCommitSha: string | undefined): string | undefined {
  const raw = gitCommitSha?.trim();
  if (!raw) return undefined;
  if (raw.toUpperCase() === "HEAD") return undefined;
  if (!/^[0-9a-f]{7,40}$/i.test(raw)) return undefined;
  return raw;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const res = await exec("git", args, { cwd, silent: true });
  return { ok: res.exitCode === 0, out: res.stdout.trim() };
}

/** Resolve the enclosing git work tree, so a project living in a
 *  subfolder still probes paths relative to the repo root Coolify
 *  clones. Falls back to the project dir when git says nothing. */
export async function resolveRepoRoot(projectDir: string): Promise<string | undefined> {
  const res = await git(projectDir, ["rev-parse", "--show-toplevel"]);
  return res.ok && res.out ? res.out : undefined;
}

export interface DeployedRefCheckInput {
  /** Any directory inside the repo; the repo root is resolved from it. */
  projectDir: string;
  /** Compose paths to probe, one per routed app. Already joined with
   *  the base directory — see {@link composePathAtRepoRoot}. */
  paths: Array<{ appName: string; path: string }>;
  /** Branch Coolify clones. Defaults to `main`, the branch every
   *  hatchkit-created application is configured with. */
  branch?: string;
  /** Commit the application pins, when it pins one. */
  pinnedCommit?: string;
  /** Remote name. Defaults to `origin`. */
  remote?: string;
  /** Run `git fetch` first so the remote-tracking ref isn't stale.
   *  Default on — a stale ref is exactly how this check would produce
   *  a confident wrong answer. */
  fetch?: boolean;
}

/** Probe one deployed ref. See the module header for what and why. */
export async function checkDeployedRef(input: DeployedRefCheckInput): Promise<DeployedRefReport> {
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? "main";
  const base: DeployedRefReport = {
    ran: false,
    remote,
    branch,
    ref: input.pinnedCommit ?? `${remote}/${branch}`,
    ...(input.pinnedCommit ? { pinnedCommit: input.pinnedCommit } : {}),
    fetched: false,
    probes: [],
    missing: [],
    blocking: false,
  };

  const repoRoot = await resolveRepoRoot(input.projectDir);
  if (!repoRoot) return { ...base, skipped: `${input.projectDir} is not inside a git repository` };

  const remoteUrl = await git(repoRoot, ["remote", "get-url", remote]);
  if (!remoteUrl.ok) {
    return { ...base, skipped: `no "${remote}" remote — nothing for Coolify to clone from` };
  }

  // Fetch before resolving. Without this the check reads whatever the
  // local clone last saw, which on a repo that hasn't been fetched in
  // a while is a confidently wrong answer in either direction.
  let fetched = false;
  let fetchError: string | undefined;
  if (input.fetch !== false) {
    const res = await exec("git", ["fetch", "--quiet", remote, branch], {
      cwd: repoRoot,
      silent: true,
    });
    fetched = res.exitCode === 0;
    if (!fetched) {
      fetchError =
        (res.stderr || res.stdout).trim().split("\n")[0] ||
        `git fetch ${remote} exited ${res.exitCode}`;
    }
  }

  // Resolve the ref Coolify will actually check out. A pinned commit
  // wins over the branch; otherwise prefer the remote-tracking ref and
  // fall back to FETCH_HEAD, which a fresh fetch always writes even on
  // a repo whose refspec doesn't mirror this branch.
  const candidates = input.pinnedCommit
    ? [input.pinnedCommit]
    : [`refs/remotes/${remote}/${branch}`, ...(fetched ? ["FETCH_HEAD"] : [])];
  let refSha: string | undefined;
  for (const candidate of candidates) {
    const res = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
    if (res.ok && res.out) {
      refSha = res.out;
      break;
    }
  }

  const head = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const headBranchRes = await git(repoRoot, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  const headSubject = head.ok
    ? (await git(repoRoot, ["log", "-1", "--format=%s", head.out])).out
    : undefined;

  const partial: DeployedRefReport = {
    ...base,
    ran: true,
    fetched,
    ...(fetchError ? { fetchError } : {}),
    ...(head.ok ? { headSha: head.out } : {}),
    ...(headSubject ? { headSubject } : {}),
    ...(headBranchRes.ok && headBranchRes.out ? { headBranch: headBranchRes.out } : {}),
  };

  if (!refSha) {
    // Nothing to clone. Coolify's failure here is guaranteed and its
    // message will be just as unhelpful as the compose-path one.
    return {
      ...partial,
      blocking: true,
      probes: input.paths.map((p) => ({
        appName: p.appName,
        path: p.path,
        present: false,
        localPresent: existsSync(join(repoRoot, p.path)),
      })),
      missing: input.paths.map((p) => ({
        appName: p.appName,
        path: p.path,
        present: false,
        localPresent: existsSync(join(repoRoot, p.path)),
      })),
    };
  }

  const refSubject = (await git(repoRoot, ["log", "-1", "--format=%s", refSha])).out;

  // `--left-right --count` prints "<behind>\t<ahead>" for
  // `<ref>...HEAD`: left-only commits are on the ref and not local,
  // right-only are local and not on the ref.
  let ahead: number | undefined;
  let behind: number | undefined;
  if (head.ok) {
    const counts = await git(repoRoot, [
      "rev-list",
      "--left-right",
      "--count",
      `${refSha}...${head.out}`,
    ]);
    if (counts.ok) {
      const [left, right] = counts.out.split(/\s+/).map((n) => Number.parseInt(n, 10));
      if (Number.isFinite(left)) behind = left;
      if (Number.isFinite(right)) ahead = right;
    }
  }

  const probes: DeployedPathProbe[] = [];
  for (const p of input.paths) {
    const res = await git(repoRoot, ["cat-file", "-e", `${refSha}:${p.path}`]);
    probes.push({
      appName: p.appName,
      path: p.path,
      present: res.ok,
      localPresent: existsSync(join(repoRoot, p.path)),
    });
  }
  const missing = probes.filter((p) => !p.present);

  return {
    ...partial,
    refSha,
    ...(refSubject ? { refSubject } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    probes,
    missing,
    blocking: missing.length > 0,
  };
}

/** Short sha, the way every git UI shows it. */
function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "?";
}

/** Render one report as plain lines, no colour — so the same text can
 *  go through sync's chalk rendering, doctor's `hint[]` array and an
 *  inventory `drift[]` list without three copies of the wording. */
export function renderDeployedRef(report: DeployedRefReport): string[] {
  if (!report.ran) return [`deploy-ref check skipped: ${report.skipped}`];

  const lines: string[] = [];
  const refLabel = report.pinnedCommit ? `pinned commit ${short(report.refSha)}` : report.ref;

  if (!report.refSha) {
    lines.push(
      `${report.ref} does not exist — the branch has never been pushed to "${report.remote}".`,
    );
    lines.push(`Coolify clones ${report.ref}; there is nothing there to clone.`);
    lines.push(`Fix: git push -u ${report.remote} ${report.branch}`);
    return lines;
  }

  lines.push(`${refLabel} @ ${short(report.refSha)} "${report.refSubject ?? "?"}"`);
  if (report.headSha && report.headSha !== report.refSha) {
    const local = report.headBranch ? `local ${report.headBranch}` : "local HEAD";
    lines.push(`${local} @ ${short(report.headSha)} "${report.headSubject ?? "?"}"`);
  }
  if (report.ahead) {
    lines.push(
      `local is ${report.ahead} commit(s) ahead of ${report.ref} — Coolify deploys ${report.ref}, not your working tree.`,
    );
  }
  if (report.behind) {
    lines.push(`local is ${report.behind} commit(s) behind ${report.ref}.`);
  }
  if (!report.fetched && report.fetchError) {
    lines.push(`(could not fetch ${report.remote}: ${report.fetchError} — ref may be stale)`);
  }

  for (const p of report.missing) {
    lines.push(
      p.localPresent
        ? `${p.path} is missing from ${refLabel} — it exists locally but has never been pushed (${p.appName}).`
        : `${p.path} is missing from ${refLabel} and from the working tree (${p.appName}).`,
    );
  }

  if (report.missing.length > 0) {
    lines.push(
      "Coolify clones that commit and reads the compose file out of it, so every deploy will fail.",
    );
    lines.push(
      "The log will show ls-remote / clone / fetch SUCCEEDING and then a trailing \"could not read Username for 'https://github.com'\" — that error is not the cause.",
    );
    const pushable = report.missing.some((p) => p.localPresent);
    if (pushable && !report.pinnedCommit) {
      lines.push(`Fix: git push ${report.remote} ${report.branch}`);
    } else if (report.pinnedCommit) {
      lines.push(
        `Fix: point the application at a commit that contains it, or clear the pinned commit so it tracks ${report.remote}/${report.branch}.`,
      );
    } else {
      lines.push(
        "Fix: add the compose file (or correct the application's docker_compose_location / base_directory).",
      );
    }
  }

  return lines;
}

/** One-line summary for a `detail` field. */
export function summarizeDeployedRef(report: DeployedRefReport): string {
  if (!report.ran) return report.skipped ?? "skipped";
  if (!report.refSha) return `${report.ref} does not exist on ${report.remote}`;
  if (report.missing.length > 0) {
    return `${report.missing.map((m) => m.path).join(", ")} absent at ${report.ref} @ ${short(report.refSha)}`;
  }
  const compose = report.probes.length === 1 ? "compose file" : "compose files";
  const aheadNote = report.ahead ? `; local is ${report.ahead} commit(s) ahead` : "";
  return `${report.ref} @ ${short(report.refSha)} has every ${compose}${aheadNote}`;
}
