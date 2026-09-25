/**
 * What every release channel did for a tag, as one table — the pure half of
 * `scripts/release-status.mjs`, which fetches the runs with `gh api`, and of
 * the summary workflow, which posts the same table to the run summary.
 *
 * WHY THERE IS NOT ONE `if` ABOUT A PARTICULAR SURFACE HERE
 * --------------------------------------------------------
 * Every fact this file states is built from the channel's own row in
 * `.hatchkit-release.json`: `jobPrefixes` become "n/m jobs succeeded",
 * `uploadSteps` become one fact each from that step's conclusion, `gate`
 * becomes what is still owed after the workflow is green, and
 * `missingRunNote` explains a run that is absent on purpose. Adding a store
 * to Hatchkit adds rows there; nothing here changes.
 *
 * A step is matched on its name, or on its name up to `" ("` so a step that
 * names its track in parentheses still matches. A step that was renamed in
 * the workflow and not in the config yields "unknown" — never a wrong
 * answer, which is the only failure mode that would matter in a table
 * someone uses to decide whether a release shipped.
 *
 * Everything here takes GitHub API shapes (a run, its jobs and their steps,
 * a release, check-run annotations) and returns text: no network, no fs.
 */

/** `queued`, `in progress`, … while running; the conclusion once done. */
export function runState(run) {
  if (!run) return "not run";
  if (run.status !== "completed") return String(run.status ?? "unknown").replace(/_/g, " ");
  return run.conclusion ?? "completed";
}

/** Jobs called `prefix`, or `prefix` followed by a matrix leg's name. */
const jobsNamed = (jobs, prefix) =>
  jobs.filter((job) => job.name === prefix || String(job.name ?? "").startsWith(`${prefix} `));

const stepOf = (jobs, name) => {
  for (const job of jobs) {
    const step = (job.steps ?? []).find(
      (candidate) =>
        candidate.name === name || String(candidate.name ?? "").startsWith(`${name} (`),
    );
    if (step) return step;
  }
  return null;
};

/**
 * "Google Play" out of "uploaded to Google Play".
 *
 * `ChannelStep.label` is written as the words for a SUCCESS, which is what
 * the table says most of the time. A skip and a failure need the same
 * subject with different words, so the leading verb comes off rather than
 * the config carrying three phrasings of one fact.
 */
const subjectOf = (label) =>
  String(label ?? "")
    .replace(/^\s*\w+\s+to\s+/i, "")
    .trim() || String(label ?? "");

const clip = (text, limit = 160) =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/**
 * The annotation that says WHY a step was skipped, or null.
 *
 * A deliberate non-upload (no store secrets, a prerelease) and a broken one
 * look identical in a step's conclusion: both are `skipped`. The workflow
 * writes the reason as an annotation, and this finds the one that names
 * this step. When several steps skipped and none of the annotations name
 * one, no reason is attached rather than the wrong one.
 */
const skipReason = (annotations, step, subject) => {
  const mentions = (annotations ?? [])
    .map(
      (text) =>
        String(text ?? "")
          .trim()
          .split("\n")[0],
    )
    .filter((text) => text !== "" && /skip/i.test(text));
  const needles = [step.step, subject, step.label]
    .map((text) => String(text ?? "").toLowerCase())
    .filter((text) => text !== "");
  const named = mentions.find((text) =>
    needles.some((needle) => text.toLowerCase().includes(needle)),
  );
  if (named) return clip(named);
  // One skip, one annotation about skipping: it is that step's reason.
  return mentions.length === 1 ? clip(mentions[0]) : null;
};

/** One fact per upload step, from that step's conclusion. */
const uploadFacts = (channel, jobs, annotations) => {
  const facts = [];
  for (const step of channel.uploadSteps ?? []) {
    const found = stepOf(jobs, step.step);
    const subject = subjectOf(step.label);
    if (!found) {
      facts.push(`${subject}: unknown (no step named "${step.step}")`);
      continue;
    }
    if (found.conclusion === "success") facts.push(step.label);
    else if (found.conclusion === "failure") facts.push(`${subject} upload failed`);
    else if (found.conclusion === "skipped") {
      const reason = skipReason(annotations, step, subject);
      // An annotation that already names this step is the whole fact; one
      // that only gives the reason is appended to it.
      if (!reason) facts.push(`${subject} upload skipped`);
      else if (reason.toLowerCase().includes(subject.toLowerCase())) facts.push(reason);
      else facts.push(`${subject} upload skipped: ${reason}`);
    } else if (found.conclusion === "cancelled") facts.push(`${subject} upload cancelled`);
    else facts.push(`${subject}: ${found.conclusion ?? found.status ?? "unknown"}`);
  }
  return facts;
};

/** "3/4 build jobs succeeded", once per job prefix the channel names. */
const jobFacts = (channel, jobs) => {
  const facts = [];
  for (const prefix of channel.jobPrefixes ?? []) {
    const named = jobsNamed(jobs, prefix);
    if (named.length === 0) continue;
    const ok = named.filter((job) => job.conclusion === "success").length;
    facts.push(`${ok}/${named.length} ${prefix} jobs succeeded`);
  }
  return facts;
};

/**
 * What is still owed after the workflow is green.
 *
 * A `draft-release` gate is the one the API can answer: the release object
 * says whether the draft is still a draft. The others are owed by a person
 * or by a store, so the gate's own note is the whole answer.
 */
const gateFacts = (gate, { run, release }) => {
  if (!gate) return [];
  if (gate.kind === "draft-release") {
    if (release === undefined) return run ? [gate.note] : [];
    if (release === null) return ["no GitHub Release visible (a draft needs write access to see)"];
    return release.draft ? [gate.note] : ["GitHub Release published"];
  }
  return run ? [gate.note] : [];
};

/**
 * One table row for one channel.
 *
 * @param {object} channel a `ReleaseChannel` row
 * @param {object | null} run the newest run of its workflow for the tag
 * @param {object} extra
 * @param {object[]} [extra.jobs] the run's jobs, with their steps
 * @param {string[]} [extra.annotations] check-run annotation messages
 * @param {object | null} [extra.release] the tag's Release; undefined when not looked up
 * @param {boolean} [extra.missingWorkflow] the workflow file is not on the default branch
 */
export function statusRow(
  channel,
  run,
  { jobs = [], annotations = [], release, missingWorkflow = false } = {},
) {
  const facts = [];
  if (!run) {
    if (missingWorkflow) facts.push("workflow not on the default branch yet");
    else if (channel.missingRunNote) facts.push(channel.missingRunNote);
    else facts.push("expected a run for this tag");
  } else {
    if (run.event && run.event !== "push")
      facts.push(`started by ${String(run.event).replace(/_/g, " ")}`);
    if (run.run_attempt > 1) facts.push(`attempt ${run.run_attempt}`);
    facts.push(...jobFacts(channel, jobs));
    facts.push(...uploadFacts(channel, jobs, annotations));
  }
  facts.push(...gateFacts(channel.gate, { run, release }));
  return {
    channel: channel.label ?? channel.id ?? "",
    workflow: channel.workflowName ?? channel.workflowFile ?? "",
    state: runState(run),
    url: run?.html_url ?? "",
    facts,
  };
}

const pad = (text, width) => text + " ".repeat(Math.max(0, width - text.length));

const EMPTY = "this project has no release channels: the tag is a marker and nothing runs for it";

/** A padded plain-text table, with each run's URL under its row. */
export function renderText(tag, rows) {
  if (rows.length === 0) return [`Release ${tag}`, "", EMPTY].join("\n");
  const header = { channel: "Channel", workflow: "Workflow", state: "Result", facts: "Facts" };
  const widths = {
    channel: Math.max(header.channel.length, ...rows.map((row) => row.channel.length)),
    workflow: Math.max(header.workflow.length, ...rows.map((row) => row.workflow.length)),
    state: Math.max(header.state.length, ...rows.map((row) => row.state.length)),
  };
  const line = (row, factText, url) =>
    `${pad(row.channel, widths.channel)}  ${pad(row.workflow, widths.workflow)}  ` +
    `${pad(row.state, widths.state)}  ${factText}` +
    `${url ? `\n${" ".repeat(widths.channel + 2)}${url}` : ""}`;
  return [
    `Release ${tag}`,
    "",
    line(header, header.facts, ""),
    ...rows.map((row) => line(row, row.facts.join("; "), row.url)),
  ].join("\n");
}

const STATE_MARK = { success: "✅", failure: "❌", cancelled: "⚪", skipped: "⚪", "not run": "·" };

const escapeCell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A Markdown table for GITHUB_STEP_SUMMARY; the mark links to the run. */
export function renderMarkdown(tag, rows) {
  if (rows.length === 0) return [`### Release ${tag}`, "", EMPTY].join("\n");
  return [
    `### Release ${tag}`,
    "",
    "| Channel | Workflow | Result | Facts |",
    "|---|---|---|---|",
    ...rows.map((row) => {
      const state = `${STATE_MARK[row.state] ?? "⏳"} ${row.state}`;
      const result = row.url ? `[${state}](${row.url})` : state;
      const facts = escapeCell(row.facts.join("; ")) || "—";
      return `| ${escapeCell(row.channel)} | ${escapeCell(row.workflow)} | ${result} | ${facts} |`;
    }),
    "",
    "Refreshed as each of these workflows finishes for this tag. " +
      "`node scripts/release-status.mjs` prints the same table locally.",
  ].join("\n");
}
