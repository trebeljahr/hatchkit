/*
 * cli/src/features/release/workflows.ts — the two workflow files the
 * `release` feature generates: `.github/workflows/release-summary.yml`
 * and `.github/workflows/compat.yml`.
 *
 * WHY THESE TWO, AND NOT THE CHANNEL WORKFLOWS
 * --------------------------------------------
 * The channel workflows already exist in a scaffolded project — one per
 * surface, each reporting on itself. What is missing is the pair of
 * workflows that say something no single channel can:
 *
 *   release-summary.yml   every channel's outcome for one tag, in one
 *                         place, so the release decision is made against
 *                         evidence instead of five open tabs.
 *   compat.yml            the previous release and this one, run against
 *                         each other in both directions, so the minimum
 *                         levels a release declares are checked rather
 *                         than asserted.
 *
 * Both are rendered from the {@link ReleaseConfig} and nothing else.
 * That is why the summary lists the workflow *names* the config carries:
 * GitHub matches `workflow_run` on `name:`, not on the file name, and a
 * derivation that knows the names is the only thing that can keep the
 * two in step.
 *
 * WHY THE YAML IS BUILT FROM PLAIN STRINGS
 * ----------------------------------------
 * A GitHub expression is `${{ … }}`, which a TypeScript template literal
 * would try to interpolate. Every line below is an ordinary
 * double-quoted string, where `${{` is literal and needs no escaping.
 * Indentation is therefore written out, not computed — read a nested
 * block against the two-space steps of the surrounding one.
 */

import type { CompatConfig, ReleaseConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** How this project invokes one of its own package scripts. Only used
 *  for the pointer in a comment, so a reader can print the same table on
 *  their own machine. */
function scriptCommand(
  packageManager: ReleaseConfig["project"]["packageManager"],
  script: string,
  args = "",
): string {
  if (args === "") return `${packageManager} ${script}`;
  if (packageManager === "npm") return `npm run ${script} -- ${args}`;
  return `${packageManager} ${script} ${args}`;
}

/** Escapes a tag prefix for a POSIX extended regular expression. The
 *  prefix is `v` everywhere Hatchkit generates, but a config is data and
 *  a `.` in it would otherwise match any character. */
function escapeEre(value: string): string {
  return value.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

/** Keeps first-seen order while removing repeats. Two extension channels
 *  share one workflow, and `workflow_run` refuses a repeated name. */
function distinct(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** A docker image tag that is legal whatever the project is called. */
function imageSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "app" : slug;
}

/** Emits a `run: |` block scalar with each command indented under it.
 *  Commands may themselves be multi-line; every line is re-indented, so
 *  a command taken from the config cannot break the block. */
function runBlock(indent: string, commands: readonly string[]): string[] {
  const out: string[] = [`${indent}run: |`];
  for (const command of commands) {
    for (const line of command.split("\n")) {
      out.push(line.trim() === "" ? "" : `${indent}  ${line}`);
    }
  }
  return out;
}

/** Joins the lines and guarantees the single trailing newline a YAML
 *  file is expected to end with. */
function yamlFile(lines: readonly string[]): string {
  return `${lines.join("\n").replace(/[ \t]+$/gm, "")}\n`;
}

// ---------------------------------------------------------------------------
// .github/workflows/release-summary.yml
// ---------------------------------------------------------------------------

/**
 * One step summary per tag, holding every channel's outcome.
 *
 * The workflow reads and does nothing else: three read permissions, no
 * secrets, and no checkout of the tag. `scripts/release-status.mjs`
 * comes from the default branch; the tag reaches it as an environment
 * variable, and the script refuses anything that is not a release tag.
 * A tag is text somebody else can choose, so it is never interpolated
 * into a command.
 */
export function renderSummaryWorkflow(config: ReleaseConfig): string {
  const { project, channels } = config;
  const names = distinct(channels.map((channel) => channel.workflowName));
  const statusCommand = scriptCommand(project.packageManager, "release:status");
  const tagPattern = `^${escapeEre(project.tagPrefix)}[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$`;

  const lines: string[] = [];

  lines.push("name: Release Summary");
  lines.push("");
  lines.push("# Every release channel's outcome for one tag, in one place. Each time one of");
  lines.push("# the workflows below finishes a run for a release tag, this runs");
  lines.push("# scripts/release-status.mjs for that tag and writes its table to the step");
  lines.push("# summary. The newest Release Summary run for a tag is the whole picture, so");
  lines.push("# the release decision is made against evidence, not by watching several");
  lines.push(`# workflows. \`${statusCommand}\` prints the same table locally.`);
  lines.push("#");
  lines.push("# It only reads: the runs, their jobs and steps, and the tag's GitHub Release.");
  lines.push("# It does not check out the tag and it takes no secrets. The script comes from");
  lines.push("# the default branch, and the tag reaches it as an environment variable that");
  lines.push("# the script refuses unless it is a release tag. A tag name is text somebody");
  lines.push("# else can choose, so nothing here interpolates it into a command.");
  lines.push("#");
  lines.push("# The names below are each workflow's `name:` field, not its file name: GitHub");
  lines.push("# matches workflow_run on the name. Channels that share a workflow appear once.");
  lines.push("#");
  lines.push("# Generated by `hatchkit update` from .hatchkit-release.json. Hand edits are");
  lines.push("# lost on the next run.");
  lines.push("");
  lines.push("on:");
  lines.push("  workflow_run:");

  if (names.length === 0) {
    // Valid YAML, and correct: with no channels nothing can start this
    // workflow. Saying so here beats deleting the file and surprising
    // the next `hatchkit update` with a missing path.
    lines.push("    # This project has no release channels yet, so no workflow starts this");
    lines.push("    # one. Enable a surface and run `hatchkit update` to fill the list.");
    lines.push("    workflows: []");
  } else {
    lines.push("    workflows:");
    for (const name of names) lines.push(`      - ${name}`);
  }

  lines.push("    types: [completed]");
  lines.push("");
  lines.push("permissions:");
  lines.push("  actions: read");
  lines.push("  # The annotations a channel writes to say why an upload was skipped.");
  lines.push("  checks: read");
  lines.push("  contents: read");
  lines.push("");
  lines.push("# Several channels finish close together for one tag, and each summary");
  lines.push("# re-reads every channel. Only the newest one matters.");
  lines.push("concurrency:");
  lines.push("  group: release-summary-${{ github.event.workflow_run.head_branch }}");
  lines.push("  cancel-in-progress: true");
  lines.push("");
  lines.push("jobs:");
  lines.push("  summary:");
  lines.push("    # head_branch is the tag name for a tag push and for a run dispatched from");
  lines.push("    # a tag. A run on a branch is not a release.");
  lines.push(`    if: startsWith(github.event.workflow_run.head_branch, '${project.tagPrefix}')`);
  lines.push("    runs-on: ubuntu-24.04");
  lines.push("    timeout-minutes: 5");
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("        with:");
  lines.push("          # The default branch, never the tag: the script that reads the run");
  lines.push("          # must be the reviewed one.");
  lines.push("          persist-credentials: false");
  lines.push("");
  lines.push("      - uses: actions/setup-node@v4");
  lines.push("        with:");
  lines.push("          # The status script has no dependencies and is not installed.");
  lines.push("          node-version: 24");
  lines.push("");
  lines.push("      - name: Summarise every channel for the tag");
  lines.push("        env:");
  lines.push("          GH_TOKEN: ${{ github.token }}");
  lines.push("          TAG: ${{ github.event.workflow_run.head_branch }}");
  lines.push("          TRIGGER: ${{ github.event.workflow_run.name }}");
  lines.push(
    ...runBlock("        ", [
      "set -euo pipefail",
      "# The startsWith guard above also matches a branch whose name starts the same way.",
      `if ! [[ "$TAG" =~ ${tagPattern} ]]; then`,
      '  echo "::notice::$TAG is not a release tag, so there is nothing to summarise."',
      "  exit 0",
      "fi",
      "{",
      '  node scripts/release-status.mjs "$TAG" --markdown',
      '  echo ""',
      '  echo "_Started by the ${TRIGGER} run finishing._"',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ]),
  );

  return yamlFile(lines);
}

// ---------------------------------------------------------------------------
// .github/workflows/compat.yml
// ---------------------------------------------------------------------------

/**
 * The previous release and this checkout, run against each other in both
 * directions. `null` when the project has no self-hostable server, or no
 * client that ships on its own: old and new would never meet, and the
 * workflow would test nothing.
 */
export function renderCompatWorkflow(config: ReleaseConfig): string | null {
  const compat = config.compat;
  if (compat === null) return null;

  const { project } = config;
  const prefix = project.tagPrefix;
  const stablePattern = `^${escapeEre(prefix)}[0-9]+\\.[0-9]+\\.[0-9]+$`;
  const localImage = `${imageSlug(project.name)}-server:compat`;
  const install = installCommand(project.packageManager);

  const lines: string[] = [];

  lines.push("# Cross-version compatibility, in both directions, against the previous");
  lines.push(`# stable release (the newest \`${prefix}X.Y.Z\` tag).`);
  lines.push("#");
  lines.push("#   new-client-old-server   this checkout's compat suite against the previous");
  lines.push("#                           release's server image, pulled anonymously and");
  lines.push(`#                           started from that tag's ${compat.composeFile}.`);
  lines.push("#   old-client-new-server   the previous release's compat suite, built from");
  lines.push("#                           that tag in a subdirectory, against a server image");
  lines.push("#                           built from this checkout.");
  lines.push("#");
  lines.push("# Self-hosted servers lag and store clients lead, so old and new meet in the");
  lines.push("# field whether or not anybody planned it. This is the only mechanical check");
  lines.push("# that the minimum levels each release declares are honest.");
  lines.push("#");
  lines.push("# A refusal the suite makes on purpose, because a peer is below the declared");
  lines.push("# minimum level, is the expected answer: the suite exits 0 for it. Every other");
  lines.push("# refusal fails the job. That distinction is the whole value of this workflow,");
  lines.push("# so a failing suite step is followed by a step that names it.");
  lines.push("#");
  lines.push("# Each direction skips with a notice, never a failure: the first while no");
  lines.push(`# release tag exists, the second while no tag contains ${compat.suiteEntry}.`);
  lines.push("# Every stack is its own compose project with its own volumes and database,");
  lines.push("# and nothing is pushed or published.");
  lines.push("#");
  lines.push("# Generated by `hatchkit update` from .hatchkit-release.json. Hand edits are");
  lines.push("# lost on the next run.");
  lines.push("");
  lines.push("name: compat");
  lines.push("");
  lines.push("on:");
  lines.push("  pull_request:");
  lines.push("    branches: [main]");
  lines.push("  workflow_dispatch:");
  lines.push("");
  lines.push("concurrency:");
  lines.push("  group: compat-${{ github.event.pull_request.number || github.ref }}");
  lines.push("  cancel-in-progress: true");
  lines.push("");
  lines.push("permissions:");
  lines.push("  contents: read");
  lines.push("");
  lines.push("env:");
  lines.push(`  SERVER_IMAGE_REPO: ${compat.serverImageRepo}`);
  lines.push(`  SUITE_ENTRY: ${compat.suiteEntry}`);
  lines.push("");
  lines.push("jobs:");

  // -- previous ------------------------------------------------------------
  lines.push("  previous:");
  lines.push("    runs-on: ubuntu-24.04");
  lines.push("    timeout-minutes: 5");
  lines.push("    outputs:");
  lines.push("      tag: ${{ steps.find.outputs.tag }}");
  lines.push("      has-suite: ${{ steps.find.outputs.has-suite }}");
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("        with:");
  lines.push("          # Every tag, to find the newest release.");
  lines.push("          fetch-depth: 0");
  lines.push("");
  lines.push("      - id: find");
  lines.push(
    ...runBlock("        ", [
      "set -euo pipefail",
      `tag="$(git tag -l '${prefix}*' | { grep -E '${stablePattern}' || true; } | sort -V | tail -n 1)"`,
      "has_suite=false",
      'if [ -z "$tag" ]; then',
      `  echo "::notice title=compat skipped::No stable ${prefix}X.Y.Z tag exists yet, so there is no previous release to test against."`,
      'elif git cat-file -e "$tag:$SUITE_ENTRY" 2>/dev/null; then',
      "  has_suite=true",
      "else",
      '  echo "::notice title=old clients skipped::$tag predates the compat suite ($SUITE_ENTRY), so its clients cannot be tested against this server yet."',
      "fi",
      'echo "tag=$tag" >> "$GITHUB_OUTPUT"',
      'echo "has-suite=$has_suite" >> "$GITHUB_OUTPUT"',
      'echo "Previous release: ${tag:-none} (suite: $has_suite)"',
    ]),
  );
  lines.push("");

  // -- new client, old server ---------------------------------------------
  lines.push("  new-client-old-server:");
  lines.push("    needs: previous");
  lines.push("    if: needs.previous.outputs.tag != ''");
  lines.push("    runs-on: ubuntu-24.04");
  lines.push("    timeout-minutes: 30");
  lines.push("    env:");
  lines.push("      TAG: ${{ needs.previous.outputs.tag }}");
  lines.push(
    "      COMPAT_PROJECT: compat-old-server-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("");
  lines.push("      # The compose file that release shipped with, so the old server runs");
  lines.push("      # with its own environment. Checked out beside this one, never over it.");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("        with:");
  lines.push("          ref: ${{ needs.previous.outputs.tag }}");
  lines.push("          path: previous-release");
  lines.push("          sparse-checkout: |");
  lines.push(`            ${compat.composeFile}`);
  lines.push("          sparse-checkout-cone-mode: false");
  lines.push("");
  lines.push(...setupSteps(project.packageManager, null));
  lines.push("");
  lines.push("      - name: Build the compat suite from this checkout");
  lines.push(...runBlock("        ", [install, compat.suiteBuild]));
  lines.push("");
  lines.push("      - name: Start the previous release's server");
  lines.push("        env:");
  lines.push(`          COMPAT_COMPOSE_FILE: previous-release/${compat.composeFile}`);
  lines.push(
    "          COMPAT_SERVER_IMAGE: ${{ env.SERVER_IMAGE_REPO }}:${{ needs.previous.outputs.tag }}",
  );
  lines.push("          # The way a self-hoster with no registry login pulls it.");
  lines.push("          COMPAT_PULL: anonymous");
  lines.push(...runBlock("        ", serverUpCommands(compat)));
  lines.push("");
  lines.push("      - name: This checkout's suite against ${{ needs.previous.outputs.tag }}");
  lines.push("        id: suite");
  lines.push(...runBlock("        ", [compat.suiteRun]));
  lines.push("");
  lines.push(
    ...failureExplainer(
      "New clients broke the previous server",
      "This checkout's clients failed against $TAG's server",
    ),
  );
  lines.push("");
  lines.push(...stopStep(compat));
  lines.push("");

  // -- old client, new server ---------------------------------------------
  lines.push("  old-client-new-server:");
  lines.push("    needs: previous");
  lines.push("    if: needs.previous.outputs.has-suite == 'true'");
  lines.push("    runs-on: ubuntu-24.04");
  lines.push("    timeout-minutes: 45");
  lines.push("    env:");
  lines.push("      TAG: ${{ needs.previous.outputs.tag }}");
  lines.push(
    "      COMPAT_PROJECT: compat-new-server-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("        with:");
  lines.push("          ref: ${{ needs.previous.outputs.tag }}");
  lines.push("          path: previous-release");
  lines.push("");
  lines.push("      - uses: docker/setup-buildx-action@v3");
  lines.push("");
  lines.push("      - name: Build the server image from this checkout");
  lines.push("        uses: docker/build-push-action@v6");
  lines.push("        with:");
  lines.push("          context: .");
  lines.push(`          file: ${compat.serverDockerfile}`);
  lines.push("          load: true");
  lines.push("          push: false");
  lines.push(`          tags: ${localImage}`);
  lines.push("          cache-from: type=gha,scope=compat-server");
  lines.push("          cache-to: type=gha,mode=max,scope=compat-server");
  lines.push("");
  lines.push("      - name: Start this checkout's server");
  lines.push("        env:");
  lines.push(`          COMPAT_COMPOSE_FILE: ${compat.composeFile}`);
  lines.push(`          COMPAT_SERVER_IMAGE: ${localImage}`);
  lines.push("          # The image was built above; there is nothing to pull.");
  lines.push("          COMPAT_PULL: never");
  lines.push(...runBlock("        ", serverUpCommands(compat)));
  lines.push("");
  lines.push("      # The tag's own toolchain pins: its suite is built the way it was built.");
  lines.push(...setupSteps(project.packageManager, "previous-release"));
  lines.push("");
  lines.push("      - name: Build ${{ needs.previous.outputs.tag }}'s suite");
  lines.push("        working-directory: previous-release");
  lines.push(...runBlock("        ", [install, compat.suiteBuild]));
  lines.push("");
  lines.push("      - name: ${{ needs.previous.outputs.tag }}'s suite against this server");
  lines.push("        id: suite");
  lines.push("        working-directory: previous-release");
  lines.push(...runBlock("        ", [compat.suiteRun]));
  lines.push("");
  lines.push(
    ...failureExplainer(
      "This server broke the previous clients",
      "$TAG's clients failed against this checkout's server",
    ),
  );
  lines.push("");
  lines.push(...stopStep(compat));

  return yamlFile(lines);
}

/** Bring the stack up and hand its URL to the later steps. The script
 *  prints `COMPAT_API_URL=…` on its last line; only that line is copied
 *  into the environment, so nothing else the script says can set a
 *  variable. */
function serverUpCommands(compat: CompatConfig): string[] {
  return [
    "set -euo pipefail",
    `bash ${compat.serverScript} up | tee "$RUNNER_TEMP/up.log"`,
    'grep \'^COMPAT_API_URL=\' "$RUNNER_TEMP/up.log" | tail -n 1 >> "$GITHUB_ENV"',
  ];
}

/** Always tear the stack down, and print its logs when the job failed.
 *  `down` removes only this job's own compose project. */
function stopStep(compat: CompatConfig): string[] {
  return [
    "      - name: Stop the stack",
    "        if: always()",
    "        env:",
    "          COMPAT_LOGS: ${{ job.status == 'failure' && '1' || '' }}",
    ...runBlock("        ", [`bash ${compat.serverScript} down`]),
  ];
}

/** Turns a failed suite run into a sentence that says what the failure
 *  means. Scoped to the suite step: a stack that never started is a
 *  different problem and gets no claim about compatibility. */
function failureExplainer(title: string, direction: string): string[] {
  return [
    "      - name: What this failure means",
    "        if: failure() && steps.suite.outcome == 'failure'",
    ...runBlock("        ", [
      `echo "::error title=${title}::${direction}. The suite passes a refusal it makes on purpose, when a peer is below the declared minimum level. Any other failure means the minimum levels this release declares are wrong, or a change broke a peer the release still claims to support."`,
    ]),
  ];
}

/** Install command for the project's package manager, frozen to the
 *  lockfile: a compat run must build what the tag pinned. */
function installCommand(packageManager: ReleaseConfig["project"]["packageManager"]): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "npm":
      return "npm ci";
    case "yarn":
      return "yarn install --immutable";
  }
}

/** Node and package-manager setup. `directory` is `null` for this
 *  checkout, or the path of the previous release's checkout — whose own
 *  pins are used, so its suite is built the way that release built it.
 *  The dependency cache is only wired up for this checkout: a second
 *  lockfile in a subdirectory would share the first one's cache key. */
function setupSteps(
  packageManager: ReleaseConfig["project"]["packageManager"],
  directory: string | null,
): string[] {
  const nvmrc = directory === null ? ".nvmrc" : `${directory}/.nvmrc`;
  const out: string[] = [];

  if (packageManager === "pnpm") {
    out.push("      - uses: pnpm/action-setup@v4");
    if (directory !== null) {
      out.push("        with:");
      out.push(`          package_json_file: ${directory}/package.json`);
    }
  }

  out.push("      - uses: actions/setup-node@v4");
  out.push("        with:");
  out.push(`          node-version-file: ${nvmrc}`);
  if (directory === null) out.push(`          cache: ${packageManager}`);

  return out;
}
