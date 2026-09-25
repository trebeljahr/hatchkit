/*
 * cli/src/features/verified-deploy/workflow.ts — the two workflows that
 * drive the generated deploy script, and the retrofits that bring an
 * existing deploy job up to the shape it needs.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * A deploy that can undo itself has a window — between pinning the new
 * images and putting the old ones back — in which stopping it leaves the
 * platform on a build nobody verified. Two things create that window:
 *
 *   1. `cancel-in-progress: true`. The generated workflow cancelled a
 *      running deploy when a new push arrived. A run cancelled inside
 *      the window leaves the new images pinned, the gate unfinished and
 *      no rollback. So the push deploy is NEVER cancelled in progress; a
 *      newer push waits instead. The platform keeps one waiting run per
 *      group, so a burst of pushes still deploys once more, not once per
 *      push.
 *   2. Two workflows pinning at once. The push deploy and the manual
 *      rollback write the same variables on the same applications, so
 *      they share ONE concurrency group. That also means a manual
 *      rollback queued behind a running deploy can be dropped when a
 *      third run joins the group — which is why the generated comments
 *      say to WATCH a dispatched rollback rather than fire it and walk
 *      away.
 *
 * The third retrofit is `fetch-depth: 0` on the deploy job's checkout.
 * The migration guard compares the registry of two commits out of git,
 * and a shallow checkout makes that comparison fail as "unknown" — which
 * the guard correctly refuses to treat as safe, so every rollback on a
 * shallow checkout leaves the server on the failed build.
 *
 * Every transform here is idempotent and returns its input UNCHANGED
 * when its anchor is missing: a hand-rolled workflow is safer left alone
 * than half-rewritten.
 */

import { DEPLOY_WORKFLOW_REL_PATH } from "../../scaffold/deploy-verification.js";
import { DEPLOY_ENTRY_REL_PATH } from "./script.js";
import type { VerifiedDeployPlan } from "./types.js";

/** Project-relative path of the manual rollback workflow. */
export const ROLLBACK_WORKFLOW_REL_PATH = ".github/workflows/hosted-rollback.yml";

/** The `- name:` of the step the retrofit inserts. Also its idempotency
 *  marker: a workflow that already has it is left alone. */
export const DEPLOY_STEP_NAME = "Deploy, gate and roll back on failure";

/** Steps the generated script replaces. Each pinned, deployed or checked
 *  part of what the script now does end to end, and leaving them in
 *  would deploy twice and poll twice. */
const SUPERSEDED_STEPS = [
  "- name: Pin image tags to this commit",
  "- name: Deploy via Coolify API",
  "- name: Deploy server app via Coolify API (split topology)",
  "- name: Deploy client app via Coolify API (split topology)",
  "- name: Deploy via webhook (fallback)",
  "- name: Verify the deployment is actually live",
];

// ---------------------------------------------------------------------------
// Small YAML helpers — line ranges, not a parser
// ---------------------------------------------------------------------------
//
// Deliberately textual. The generated workflow carries long comment
// blocks that explain which failure each step prevents, and a YAML
// round-trip drops every one of them. These transforms edit lines and
// leave everything they did not touch byte for byte.

/** Indentation width of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Line range `[start, end)` of the job named `job`, body included.
 *  Undefined when there is no such job. */
function jobRange(lines: string[], job: string): [number, number] | undefined {
  const start = lines.findIndex((line) => new RegExp(`^  ${job}:\\s*$`).test(line));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= 2) {
      end = i;
      break;
    }
  }
  return [start, end];
}

/** Line range `[start, end)` of the step whose `- name:` line contains
 *  `marker`, including the comment block attached above it. */
function stepRange(
  lines: string[],
  marker: string,
  from: number,
  to: number,
): [number, number] | undefined {
  let at = -1;
  for (let i = from; i < to; i++) {
    if (lines[i].includes(marker)) {
      at = i;
      break;
    }
  }
  if (at === -1) return undefined;
  const indent = indentOf(lines[at]);

  // Walk up over the comment block that explains this step. It belongs
  // to the step, and leaving it behind turns a removal into a paragraph
  // of prose about a step that is no longer there.
  let start = at;
  while (start - 1 >= from) {
    const above = lines[start - 1];
    if (above.trim().startsWith("#") && indentOf(above) === indent) start -= 1;
    else break;
  }

  let end = at + 1;
  for (let i = at + 1; i < to; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= indent) break;
    end = i + 1;
  }
  return [start, end];
}

// ---------------------------------------------------------------------------
// Retrofits
// ---------------------------------------------------------------------------

/**
 * Stop a new push cancelling a deploy that is mid-flight.
 *
 * Anchored on the workflow-level `concurrency:` block. A run cancelled
 * between pinning the new images and restoring the old ones leaves the
 * platform on a build nobody verified, and there is no step that can
 * clean up after a cancellation — so the answer is to never cancel.
 */
export function withoutPushCancellation(content: string): string {
  const lines = content.split("\n");
  const at = lines.findIndex((line) => /^concurrency:\s*$/.test(line));
  if (at === -1) return content;
  const cancel = lines.findIndex(
    (line, i) => i > at && /^\s+cancel-in-progress:\s*true\s*$/.test(line),
  );
  if (cancel === -1 || indentOf(lines[cancel]) === 0) return content;
  lines.splice(
    cancel,
    1,
    "  # Never cancelled in progress. A cancelled run can be between pinning",
    "  # the new images and putting the old ones back after a failed gate, and",
    "  # nothing runs after a cancellation to finish that. A newer push waits",
    "  # instead; only the newest waiting run is kept, so a burst of pushes",
    "  # still deploys once more rather than once per push.",
    "  cancel-in-progress: false",
  );
  return lines.join("\n");
}

/**
 * Give the deploy job the concurrency group it shares with the manual
 * rollback, so the two never pin the same variables at once.
 *
 * Inserted after the job's `needs:` (or `runs-on:`) line. No-op when the
 * job already declares a group.
 */
export function withDeployJobConcurrency(content: string, group: string): string {
  const lines = content.split("\n");
  const range = jobRange(lines, "deploy");
  if (!range) return content;
  const [start, end] = range;
  for (let i = start; i < end; i++) {
    if (/^\s+concurrency:\s*$/.test(lines[i])) return content;
  }
  let anchor = -1;
  for (let i = start + 1; i < end; i++) {
    if (/^\s+(needs|runs-on):/.test(lines[i])) anchor = i;
  }
  if (anchor === -1) return content;
  lines.splice(
    anchor + 1,
    0,
    `    # Shared with ${ROLLBACK_WORKFLOW_REL_PATH}, and never cancelled: a`,
    "    # deploy stopped between pinning the new images and restoring the old",
    "    # ones leaves the platform on a build nobody verified. A second run",
    "    # waits for the first. Only one run waits per group, so a manual",
    "    # rollback queued behind a deploy has to be watched, not dispatched",
    "    # and forgotten.",
    "    concurrency:",
    `      group: ${group}`,
    "      cancel-in-progress: false",
  );
  return lines.join("\n");
}

/**
 * Make sure the deploy job checks the repository out with its full
 * history.
 *
 * The migration guard reads the registry of two commits out of git. With
 * a shallow checkout that read fails, the guard answers "unknown", and
 * an unknown answer blocks every server rollback — so this is not a
 * nicety, it is what makes the guard able to say yes.
 *
 * Adds `fetch-depth: 0` to the job's existing checkout, or inserts a
 * checkout plus a Node setup at the head of its steps when it has none.
 */
export function withDeployCheckoutHistory(content: string): string {
  const lines = content.split("\n");
  const range = jobRange(lines, "deploy");
  if (!range) return content;
  const [start, end] = range;
  for (let i = start; i < end; i++) {
    if (/^\s+fetch-depth:\s*0\s*$/.test(lines[i])) return content;
  }

  const stepsAt = lines.findIndex((line, i) => i > start && i < end && /^\s+steps:\s*$/.test(line));
  if (stepsAt === -1) return content;

  const comment = [
    "      # The full history, because the migration guard compares the",
    "      # registry of the commit being deployed with the one it replaces.",
    "      # A shallow checkout makes that comparison unreadable, and an",
    "      # unreadable comparison blocks every server rollback.",
  ];

  const checkoutAt = lines.findIndex(
    (line, i) => i > stepsAt && i < end && /^\s+- uses: actions\/checkout@/.test(line),
  );
  if (checkoutAt !== -1) {
    const indent = indentOf(lines[checkoutAt]);
    const withAt = lines.findIndex(
      (line, i) =>
        i > checkoutAt && i < end && indentOf(line) > indent && /^\s+with:\s*$/.test(line),
    );
    if (withAt !== -1 && withAt === checkoutAt + 1) {
      lines.splice(withAt + 1, 0, `${" ".repeat(indent + 4)}fetch-depth: 0`);
    } else {
      lines.splice(
        checkoutAt + 1,
        0,
        `${" ".repeat(indent + 2)}with:`,
        `${" ".repeat(indent + 4)}fetch-depth: 0`,
      );
    }
    lines.splice(checkoutAt, 0, ...comment);
    return lines.join("\n");
  }

  lines.splice(
    stepsAt + 1,
    0,
    ...comment,
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version-file: .nvmrc",
  );
  return lines.join("\n");
}

/** Remove the steps the generated script now does end to end. Leaving
 *  them in would pin twice, deploy twice and poll twice — and the second
 *  poll would be the one that could not roll anything back. */
export function withoutSupersededDeploySteps(content: string): string {
  let out = content;
  for (const marker of SUPERSEDED_STEPS) {
    const lines = out.split("\n");
    const job = jobRange(lines, "deploy");
    if (!job) return content;
    const range = stepRange(lines, marker, job[0], job[1]);
    if (!range) continue;
    lines.splice(range[0], range[1] - range[0]);
    out = lines.join("\n");
  }
  return out;
}

/** The workflow step that runs the generated deploy script. */
export function deployStepYaml(plan: VerifiedDeployPlan): string {
  return [
    "      # Pin the immutable image references, deploy, wait until the new",
    "      # commit is actually being served, run the gate, and put the",
    "      # previous images back when it fails. The run fails either way: a",
    "      # rollback is never a green run, because the commit on the default",
    "      # branch is still broken.",
    "      #",
    `      # The logic and its tests live in ${DEPLOY_ENTRY_REL_PATH} and the`,
    "      # module beside it. With no platform credentials set the script",
    "      # prints a notice and does nothing; with only some of them it",
    "      # fails, because half a deploy is worse than none.",
    `      - name: ${DEPLOY_STEP_NAME}`,
    "        env:",
    "          COOLIFY_BASE_URL: ${{ secrets.COOLIFY_BASE_URL }}",
    "          COOLIFY_API_TOKEN: ${{ secrets.COOLIFY_API_TOKEN }}",
    "          COOLIFY_RESOURCE_UUID: ${{ secrets.COOLIFY_RESOURCE_UUID }}",
    "          COOLIFY_SERVER_RESOURCE_UUID: ${{ secrets.COOLIFY_SERVER_RESOURCE_UUID }}",
    "          COOLIFY_CLIENT_RESOURCE_UUID: ${{ secrets.COOLIFY_CLIENT_RESOURCE_UUID }}",
    "          IMAGE_OWNER_REPO: ${{ github.repository }}",
    `          HATCHKIT_WEB_URL: ${plan.webOrigin}`,
    `          HATCHKIT_API_URL: ${plan.apiOrigin}`,
    `        run: node ${DEPLOY_ENTRY_REL_PATH} deploy --sha "\${{ github.sha }}" --rollback`,
    "",
  ].join("\n");
}

/**
 * Put the deploy-script invocation into the deploy job, in place of the
 * steps it supersedes.
 *
 * Anchored on the job's `steps:` list having one of those steps. A job
 * that has none of them is not the generated deploy job, and is returned
 * unchanged.
 */
export function withVerifiedDeployStep(content: string, plan: VerifiedDeployPlan): string {
  if (content.includes(`- name: ${DEPLOY_STEP_NAME}`)) return content;
  const lines = content.split("\n");
  const job = jobRange(lines, "deploy");
  if (!job) return content;
  // The EARLIEST superseded step in the file, not the first one named in
  // the list: the new step takes the place of the block it replaces, and
  // the list's order is about what to remove, not where things sit.
  const found = SUPERSEDED_STEPS.map((marker) => stepRange(lines, marker, job[0], job[1])).filter(
    (range): range is [number, number] => range !== undefined,
  );
  if (found.length === 0) return content;
  const anchor = found.reduce((earliest, range) => (range[0] < earliest[0] ? range : earliest));

  const stripped = withoutSupersededDeploySteps(content).split("\n");
  // The insertion point is where the first superseded step began, which
  // stripping did not move: everything removed was at or after it.
  stripped.splice(anchor[0], 0, ...deployStepYaml(plan).split("\n"));
  return stripped.join("\n");
}

/** Every transform that brings an existing deploy workflow up to the
 *  shape the verified deploy needs, in one table — so `hatchkit update`
 *  and `hatchkit regen-infra` cannot apply different subsets. Each entry
 *  is idempotent and no-ops on a file missing its anchor. */
export function verifiedDeployRetrofits(
  plan: VerifiedDeployPlan,
): Array<[label: string, relPath: string, fn: (content: string) => string]> {
  return [
    [
      "deploy workflow",
      DEPLOY_WORKFLOW_REL_PATH,
      (content) => {
        let out = withoutPushCancellation(content);
        out = withDeployJobConcurrency(out, plan.concurrencyGroup);
        out = withDeployCheckoutHistory(out);
        out = withVerifiedDeployStep(out, plan);
        return out;
      },
    ],
  ];
}

// ---------------------------------------------------------------------------
// The manual rollback workflow
// ---------------------------------------------------------------------------

/**
 * The manual rollback: the same pin, deploy, poll and gate as the push
 * deploy, against a commit a person chooses.
 *
 * Four things it does that the push deploy does not:
 *
 *   · Resolves an abbreviated sha, and REFUSES a commit that is not
 *     reachable from the default branch — only commits the deploy
 *     workflow built have images, so a commit from a branch would pin a
 *     reference that does not exist and the deploy would fail with a
 *     pull error rather than a useful message.
 *   · Honours the migration guard in the other direction: deploying an
 *     OLDER server asks the same question a rollback does, and is
 *     refused for the same reason, with an explicit force input for an
 *     operator who has restored a dump from before that migration.
 *   · Leaves the images that were live before the run alone by default.
 *     After a manual rollback those are usually the build being escaped,
 *     so putting them back would re-pin it. The opt-in is for a rollback
 *     that is a TRIAL of an older build rather than an escape from the
 *     current one.
 *   · Shares the push deploy's concurrency group, and is never cancelled
 *     in progress.
 */
export function renderRollbackWorkflow(plan: VerifiedDeployPlan): string {
  const which =
    plan.apps.length > 1 ? `[both, ${plan.apps.join(", ")}]` : `[${plan.apps.join(", ")}]`;
  return `name: hosted-rollback

# Generated and OWNED by hatchkit: every \`hatchkit update\` regenerates this
# workflow from the project manifest, so an edit made here is lost on the next
# run. Change the generator, or copy this file to a workflow of your own.
#
# Put ${plan.name} on the images of an earlier commit, by hand, with the same
# pin, deploy, poll and gate as the push deploy in
# ${DEPLOY_WORKFLOW_REL_PATH}.
#
#   gh workflow run hosted-rollback.yml -f sha=<commit> -f which=both
#
# Only commits the deploy workflow built have images, so the commit must be
# reachable from the default branch. This run resolves an abbreviated sha and
# refuses anything that is not.
#
# When the gate fails, the run fails and the images of \`sha\` stay pinned: the
# images that were live before this run are usually the build being escaped,
# and putting them back would re-pin it. \`restore_on_failure\` puts them back
# instead — for a rollback that is a trial of an older build rather than an
# escape from the current one.
#
# This workflow and the push deploy share ONE concurrency group, and only one
# run waits per group: a rollback queued behind a running deploy can be
# dropped when a third run joins. Watch a dispatched rollback rather than
# firing it and walking away:
#
#   sleep 5   # the run appears in the list a moment after the dispatch
#   gh run watch --exit-status "\$(gh run list --workflow hosted-rollback.yml \\
#     --limit 1 --json databaseId --jq '.[0].databaseId')"
#
# The server is refused when the database it would start on carries a
# migration it cannot read: it would not start. \`which: client\` moves the web
# half alone; \`force_server\` is for after the database was restored from a
# dump taken before that migration.
on:
  workflow_dispatch:
    inputs:
      sha:
        description: Commit to deploy (full or abbreviated sha)
        required: true
        type: string
      which:
        description: Which half to move
        required: true
        type: choice
        default: ${plan.apps.length > 1 ? "both" : plan.apps[0]}
        options: ${which}
      force_server:
        description: Deploy the server even past a migration it cannot read (only after restoring a dump)
        required: false
        type: boolean
        default: false
      restore_on_failure:
        description: When the gate fails, pin the images that were live before this run again (off, since those are usually the build being escaped)
        required: false
        type: boolean
        default: false

permissions:
  contents: read

jobs:
  rollback:
    runs-on: ubuntu-latest
    # The same group as the deploy job of ${DEPLOY_WORKFLOW_REL_PATH},
    # so a push deploy and a rollback never pin images at the same time,
    # and neither is ever cancelled between pinning and restoring.
    concurrency:
      group: ${plan.concurrencyGroup}
      cancel-in-progress: false
    # A deploy that never lands polls for ten minutes, and its rollback
    # polls for ten more.
    timeout-minutes: 45
    steps:
      # Full history: the sha is resolved and checked against the default
      # branch here, and the migration registries of two commits are
      # compared out of git.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      - name: Resolve the commit
        id: resolve
        env:
          INPUT_SHA: \${{ inputs.sha }}
          DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}
        run: |
          set -euo pipefail
          if ! printf '%s' "\$INPUT_SHA" | grep -Eq '^[0-9a-fA-F]{7,40}\$'; then
            echo "::error::'\$INPUT_SHA' is not a commit sha."
            exit 1
          fi
          if ! sha=\$(git rev-parse --verify --quiet "\${INPUT_SHA}^{commit}"); then
            echo "::error::\$INPUT_SHA is not a commit in this repository."
            exit 1
          fi
          if ! git merge-base --is-ancestor "\$sha" "origin/\$DEFAULT_BRANCH"; then
            echo "::error::\$sha is not on \$DEFAULT_BRANCH, so no images were ever built for it."
            exit 1
          fi
          echo "sha=\$sha" >> "\$GITHUB_OUTPUT"
          echo "Deploying \$sha: \$(git log -1 --format='%s (%cs)' "\$sha")"

      # The script prints a notice and does nothing when no platform
      # credential is set, and fails when only some of them are.
      - name: Deploy the chosen commit and gate it
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          COOLIFY_API_TOKEN: \${{ secrets.COOLIFY_API_TOKEN }}
          COOLIFY_RESOURCE_UUID: \${{ secrets.COOLIFY_RESOURCE_UUID }}
          COOLIFY_SERVER_RESOURCE_UUID: \${{ secrets.COOLIFY_SERVER_RESOURCE_UUID }}
          COOLIFY_CLIENT_RESOURCE_UUID: \${{ secrets.COOLIFY_CLIENT_RESOURCE_UUID }}
          IMAGE_OWNER_REPO: \${{ github.repository }}
          HATCHKIT_WEB_URL: ${plan.webOrigin}
          HATCHKIT_API_URL: ${plan.apiOrigin}
          SHA: \${{ steps.resolve.outputs.sha }}
          WHICH: \${{ inputs.which }}
          FORCE_SERVER: \${{ inputs.force_server }}
          RESTORE_ON_FAILURE: \${{ inputs.restore_on_failure }}
        run: |
          set -euo pipefail
          args=(deploy --sha "\$SHA" --which "\$WHICH" --guard-server-downgrade)
          if [ "\$FORCE_SERVER" = "true" ]; then args+=(--force-server); fi
          if [ "\$RESTORE_ON_FAILURE" = "true" ]; then args+=(--rollback); fi
          node ${DEPLOY_ENTRY_REL_PATH} "\${args[@]}"
`;
}
