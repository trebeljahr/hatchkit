/*
 * deployed-version — is the artefact answering on the public domain the
 * commit the repo's deployed branch is at?
 *
 * ---------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------
 *
 * `deploy/deployed-ref.ts` answers a question one step earlier in the
 * chain: does the commit Coolify will CLONE contain the compose file the
 * app is configured to build from. This one answers the last step: is
 * what is RUNNING the thing that commit builds.
 *
 * They fail differently and both fail silently. A deploy can succeed at
 * every checkpoint hatchkit and Coolify can see — the workflow is green,
 * ghcr's `main` tag points at the new digest, the Coolify dashboard
 * reports the new commit — and the container serving traffic can still
 * be the previous build, because Docker keeps the image it already has
 * for a mutable tag. That happened (tracktime, 2026-09-08) and cost an
 * afternoon: a client that had been migrated to a new API host kept
 * calling the old one for hours.
 *
 * The generated pipeline now gates on exactly this comparison after
 * every deploy (see scaffold/deploy-verification.ts). This module is the
 * same check outside CI, which is what catches a deploy that silently
 * never happened at all — no failing run to look at, because no run.
 *
 * ---------------------------------------------------------------------
 * What it compares
 * ---------------------------------------------------------------------
 *
 *   expected — `git rev-parse <remote>/<branch>`, the commit Coolify
 *              would clone. NOT local HEAD: unpushed work is not a
 *              deploy failure, it is unpushed work, and reporting it as
 *              drift would cry wolf on every dirty checkout.
 *   actual   — `version` from the server's `/api/health` and `commit`
 *              from the client's `/version.json`, both baked in as the
 *              COMMIT_SHA build arg.
 *
 * Read-only: HTTP GETs against public endpoints plus git plumbing.
 */

import { exec } from "../utils/exec.js";

/** One artefact's self-reported build commit. */
export interface DeployedVersionProbe {
  /** Human label for the report line, e.g. `api` / `web`. */
  label: string;
  url: string;
  /** The commit the artefact reports. Undefined when it reported none —
   *  which is its own finding: an image built before COMMIT_SHA was
   *  wired up cannot answer this question at all. */
  sha?: string;
  /** Why the probe produced no answer. Distinguishes "unreachable" from
   *  "answered, but does not report a version" — completely different
   *  fixes. */
  error?: string;
}

export interface DeployedVersionReport {
  /** False when there was nothing to compare against — no remote ref,
   *  no probes. The caller reports `skip`, not a pass. */
  ran: boolean;
  /** Why it didn't run. */
  skipped?: string;
  /** Commit the deployed branch is at. */
  expected?: string;
  remote: string;
  branch: string;
  probes: DeployedVersionProbe[];
  /** Probes reporting a commit that is not {@link expected}. */
  stale: DeployedVersionProbe[];
  /** Probes that could not answer at all. */
  unknown: DeployedVersionProbe[];
}

/** Short form used in report lines. Full shas are unreadable in a
 *  terminal table and the first 8 are unambiguous at this scale. */
export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : "<none>";
}

/** Read one artefact's build commit out of its JSON response.
 *
 *  Tolerant on purpose: an artefact predating this feature answers 200
 *  with perfectly valid JSON that simply has no such field, and that is
 *  a finding to report rather than a parse error to throw. */
export function versionFromJson(body: string, field: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Sort probes into fresh / stale / unknown against the expected commit.
 *
 *  Pure, so the interesting part is testable without a live deployment.
 *  A probe with no sha is `unknown`, never `stale`: "the deployed image
 *  is old" and "the deployed image cannot tell us" need different
 *  advice, and conflating them sends the user hunting a deploy bug that
 *  is really a missing build arg. */
export function classifyDeployedVersions(
  expected: string,
  probes: DeployedVersionProbe[],
): { stale: DeployedVersionProbe[]; unknown: DeployedVersionProbe[] } {
  const stale: DeployedVersionProbe[] = [];
  const unknown: DeployedVersionProbe[] = [];
  for (const probe of probes) {
    if (!probe.sha) unknown.push(probe);
    else if (probe.sha !== expected) stale.push(probe);
  }
  return { stale, unknown };
}

/** One-line summary for the doctor row. */
export function summarizeDeployedVersion(report: DeployedVersionReport): string {
  if (!report.ran) return report.skipped ?? "not checked";
  const ref = `${report.remote}/${report.branch} @ ${shortSha(report.expected)}`;
  if (report.stale.length > 0) {
    const parts = report.stale.map((p) => `${p.label} @ ${shortSha(p.sha)}`);
    return `${parts.join(", ")} — ${ref} is not what is running`;
  }
  if (report.unknown.length > 0) {
    return `${report.unknown.map((p) => p.label).join(", ")} report no build commit (${ref})`;
  }
  return `every artefact reports ${ref}`;
}

/** Actionable hint lines for a drifted or unanswerable deployment. */
export function renderDeployedVersion(report: DeployedVersionReport): string[] {
  const lines: string[] = [];
  for (const probe of report.probes) {
    const state = probe.error
      ? probe.error
      : !probe.sha
        ? "no build commit in the response"
        : probe.sha === report.expected
          ? "current"
          : `built from ${shortSha(probe.sha)}`;
    lines.push(`  ${probe.label.padEnd(4)} ${probe.url} — ${state}`);
  }
  if (report.stale.length > 0) {
    lines.push(
      "",
      `Expected ${shortSha(report.expected)} (${report.remote}/${report.branch}).`,
      "The running container is an older build. Usual causes, in order:",
      "  1. The deploy never ran — check the repo's Actions tab for a run on this commit.",
      "  2. The deploy ran against a MUTABLE tag. Docker keeps the image it already has",
      "     for `:main`, so the container restarts on the previous build while every",
      "     status surface reports the new commit. `pull_policy: always` in the compose",
      "     file and the deploy job's image pin both exist to stop this:",
      "       hatchkit regen-infra        # adds both to a project scaffolded without them",
      "  3. The deploy failed after being accepted — read the Coolify deployment log.",
    );
  }
  if (report.unknown.length > 0) {
    lines.push(
      "",
      "An artefact that reports no build commit was built before COMMIT_SHA was wired",
      "up, so this check (and the pipeline's own post-deploy gate) cannot verify it:",
      "  hatchkit regen-infra        # bakes COMMIT_SHA into the images + workflow",
      "  git push                    # then let CI rebuild",
    );
  }
  return lines;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const res = await exec("git", args, { cwd, silent: true });
  return { ok: res.exitCode === 0, out: res.stdout.trim() };
}

/** Commit the deployed branch is at on the remote.
 *
 *  Fetches first: a stale remote-tracking ref is exactly how this check
 *  would produce a confident wrong answer ("your deploy is behind" when
 *  it is the local copy of the ref that is behind). Best-effort — an
 *  offline machine falls back to whatever the ref already says. */
export async function remoteHeadSha(
  projectDir: string,
  branch: string,
  remote = "origin",
): Promise<string | undefined> {
  await git(projectDir, ["fetch", "--quiet", remote, branch]);
  const res = await git(projectDir, ["rev-parse", `${remote}/${branch}`]);
  return res.ok && /^[0-9a-f]{40}$/i.test(res.out) ? res.out : undefined;
}

/** GET one artefact's version document.
 *
 *  Cache-busted, because the question is what the ORIGIN serves right
 *  now and a CDN hit would return exactly the stale copy being tested
 *  for. Short timeout: an unreachable deployment is an answer, and
 *  `hatchkit doctor` must not hang on one. */
export async function probeDeployedVersion(
  label: string,
  url: string,
  field: string,
  timeoutMs = 5000,
): Promise<DeployedVersionProbe> {
  const bust = `${url}${url.includes("?") ? "&" : "?"}hatchkit_cb=${Date.now()}`;
  try {
    const res = await fetch(bust, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "cache-control": "no-cache" },
    });
    if (!res.ok) return { label, url, error: `HTTP ${res.status}` };
    const sha = versionFromJson(await res.text(), field);
    return sha ? { label, url, sha } : { label, url };
  } catch (err) {
    return { label, url, error: (err as Error).message.split("\n")[0] };
  }
}

export interface DeployedVersionCheckInput {
  /** Any directory inside the repo. */
  projectDir: string;
  /** Public API origin, or empty when the project has no server half. */
  apiUrl: string;
  /** Public web origin, or empty when the project has no client half. */
  webUrl: string;
  /** Branch Coolify clones. Defaults to `main`. */
  branch?: string;
  remote?: string;
}

/** Compare what is deployed against what the deployed branch is at.
 *  See the module header. */
export async function checkDeployedVersion(
  input: DeployedVersionCheckInput,
): Promise<DeployedVersionReport> {
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? "main";
  const base: DeployedVersionReport = {
    ran: false,
    remote,
    branch,
    probes: [],
    stale: [],
    unknown: [],
  };

  const targets: Array<{ label: string; url: string; field: string }> = [];
  if (input.apiUrl) {
    targets.push({
      label: "api",
      url: `${input.apiUrl.replace(/\/$/, "")}/api/health`,
      field: "version",
    });
  }
  if (input.webUrl) {
    targets.push({
      label: "web",
      url: `${input.webUrl.replace(/\/$/, "")}/version.json`,
      field: "commit",
    });
  }
  if (targets.length === 0) {
    return { ...base, skipped: "no public URL to probe" };
  }

  const expected = await remoteHeadSha(input.projectDir, branch, remote);
  if (!expected) {
    return {
      ...base,
      skipped: `${remote}/${branch} doesn't resolve — nothing to compare against`,
    };
  }

  const probes = await Promise.all(
    targets.map((t) => probeDeployedVersion(t.label, t.url, t.field)),
  );
  const { stale, unknown } = classifyDeployedVersions(expected, probes);
  return { ...base, ran: true, expected, probes, stale, unknown };
}
