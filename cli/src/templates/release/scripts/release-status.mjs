#!/usr/bin/env node
/**
 * What every release channel did for a tag, as one table.
 *
 *   node scripts/release-status.mjs [vX.Y.Z] [--markdown]
 *
 * A tag starts several workflows, each of which reports only on itself.
 * This is the one place that says, for one version: did it build, did it
 * reach the store, and what is still owed by a person. Default tag: the
 * newest local tag matching the configured prefix.
 *
 * Reads only, through `gh api`: the newest run of each channel's workflow
 * for the tag, that run's jobs and their steps, and the tag's GitHub
 * Release. Locally that is your `gh` login; in the summary workflow it is
 * the workflow's read-only token, with `--markdown` for the step summary.
 *
 * Several channels can share one workflow file — two extension stores
 * published by one job usually do — so each workflow's runs and each run's
 * jobs are fetched once and reused.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isReleaseTag, loadReleaseConfig } from "./lib/release-config.mjs";
import { renderMarkdown, renderText, statusRow } from "./lib/release-status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fail = (text) => {
  console.error(`release-status: ${text}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const markdown = args.includes("--markdown");
const positional = args.filter((arg) => !arg.startsWith("--"));
const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--markdown");
if (unknown.length > 0 || positional.length > 1) {
  fail("usage: node scripts/release-status.mjs [vX.Y.Z] [--markdown]");
}

let config;
try {
  config = loadReleaseConfig(ROOT);
} catch (caught) {
  fail(caught instanceof Error ? caught.message : String(caught));
}
const prefix = config.project.tagPrefix;

/** git, or null — this command reports, so it never throws a stack trace. */
const git = (...gitArgs) => {
  try {
    return execFileSync("git", gitArgs, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};

let tag = positional[0];
if (tag === undefined) {
  tag = (git("tag", "-l", `${prefix}*`, "--sort=-v:refname") ?? "")
    .split("\n")
    .find((name) => isReleaseTag(name, prefix));
  if (!tag)
    fail(`no local ${prefix}* tag; pass one, e.g. node scripts/release-status.mjs ${prefix}0.1.0`);
}
if (!isReleaseTag(tag, prefix)) fail(`"${tag}" is not a ${prefix}X.Y.Z tag`);

/** owner/name, from the Actions environment or from the origin remote. */
const repository = (() => {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git("remote", "get-url", "origin");
  if (url === null) fail("this checkout has no origin remote; set GITHUB_REPOSITORY=owner/name");
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) fail(`origin (${url}) is not a GitHub remote; set GITHUB_REPOSITORY=owner/name`);
  return match[1];
})();

/** A GET through `gh api`; null on 404, and on 403 when `optional`. */
const api = (path, { optional = false } = {}) => {
  const result = spawnSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    fail(
      `could not run gh (${result.error.message}); install the GitHub CLI, then run: gh auth login`,
    );
  }
  if (result.status === 0) return JSON.parse(result.stdout);
  const detail = `${result.stdout}${result.stderr}`;
  if (/HTTP 404/.test(detail)) return null;
  if (optional && /HTTP 403/.test(detail)) return null;
  if (/HTTP 401/.test(detail) || /gh auth login/.test(detail)) {
    fail(`gh is not authenticated for ${repository}; run: gh auth login`);
  }
  return fail(`gh api ${path} failed:\n${detail.trim()}`);
};

const encodedTag = encodeURIComponent(tag);

// The tag's Release, fetched once: it answers a draft-release gate for
// whichever channel has one. Optional — a fine-grained token without
// `contents: read` only makes that one fact less specific.
const releases = api(`repos/${repository}/releases?per_page=100`, { optional: true });
const release =
  releases === null ? null : (releases.find((candidate) => candidate.tag_name === tag) ?? null);

/** Fetched once per workflow file, once per run id. */
const runCache = new Map();
const jobCache = new Map();
const annotationCache = new Map();

const runFor = (workflowFile) => {
  if (!runCache.has(workflowFile)) {
    const runs = api(
      `repos/${repository}/actions/workflows/${workflowFile}/runs?branch=${encodedTag}&per_page=20`,
    );
    // Newest first; a re-run keeps its run id and raises run_attempt.
    const run =
      runs === null ? null : (runs.workflow_runs.find((c) => c.head_branch === tag) ?? null);
    runCache.set(workflowFile, { run, missingWorkflow: runs === null });
  }
  return runCache.get(workflowFile);
};

const jobsFor = (run) => {
  if (!jobCache.has(run.id)) {
    const jobs = api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    jobCache.set(run.id, jobs?.jobs ?? []);
  }
  return jobCache.get(run.id);
};

/**
 * The annotations of a run's jobs, which is where a workflow writes WHY it
 * skipped an upload. Needs `checks: read`; a token without it degrades that
 * one fact to "upload skipped" rather than failing the table.
 */
const annotationsFor = (run, jobs) => {
  if (!annotationCache.has(run.id)) {
    const messages = jobs.flatMap(
      (job) =>
        api(`repos/${repository}/check-runs/${job.id}/annotations`, { optional: true })?.map(
          (annotation) => annotation.message ?? "",
        ) ?? [],
    );
    annotationCache.set(run.id, messages);
  }
  return annotationCache.get(run.id);
};

const rows = config.channels.map((channel) => {
  const { run, missingWorkflow } = runFor(channel.workflowFile);
  if (run === null) return statusRow(channel, null, { missingWorkflow, release });
  const jobs = jobsFor(run);
  const annotations = (channel.uploadSteps ?? []).length > 0 ? annotationsFor(run, jobs) : [];
  return statusRow(channel, run, { jobs, annotations, release });
});

console.log(markdown ? renderMarkdown(tag, rows) : renderText(tag, rows));
