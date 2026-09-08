/*
 * Plan rendering — turning a MigrationPlan into the table the operator
 * reads before anything is written.
 *
 * Kept out of `plan.ts` so the planners stay pure data and can be
 * asserted on directly in tests without matching against chalk escape
 * codes.
 *
 * The table groups by phase (the safety ordering) and then by provider,
 * and it prints EVERY action including the no-ops. A row saying
 * "SES identity already mail.<new>" is the most valuable line in a
 * resumed run: it is the difference between "hatchkit skipped it" and
 * "hatchkit decided it was already done".
 */

import chalk from "chalk";
import {
  type ActionKind,
  type MigrationAction,
  type MigrationPhase,
  type MigrationPlan,
  PHASE_ORDER,
} from "./plan.js";

const PHASE_TITLE: Record<MigrationPhase, string> = {
  prepare: "prepare — additive; nothing that works today stops working",
  cutover: "cutover — the pointers move here",
  cleanup: "cleanup — retires the old side; run only once the new side is proven",
};

const KIND_MARK: Record<ActionKind, string> = {
  create: chalk.green("+"),
  update: chalk.yellow("~"),
  retire: chalk.red("-"),
  noop: chalk.dim("·"),
  manual: chalk.magenta("!"),
};

const KIND_LABEL: Record<ActionKind, string> = {
  create: chalk.green("create"),
  update: chalk.yellow("update"),
  retire: chalk.red("retire"),
  noop: chalk.dim("ok    "),
  manual: chalk.magenta("manual"),
};

function renderAction(action: MigrationAction): string[] {
  const lines: string[] = [];
  lines.push(
    `    ${KIND_MARK[action.kind]} ${KIND_LABEL[action.kind]}  ${chalk.cyan(
      action.provider.padEnd(14),
    )} ${action.summary}`,
  );
  for (const d of action.detail ?? []) {
    lines.push(chalk.dim(`                             ${d}`));
  }
  if (action.gate) {
    lines.push(chalk.dim(`                             ${chalk.bold("gate:")} ${action.gate}`));
  }
  return lines;
}

export function renderMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("  ── hatchkit migrate-domain ────────────────────────────────"));
  lines.push("");
  lines.push(`  Project:    ${chalk.cyan(plan.projectName)}`);
  lines.push(`  From → To:  ${chalk.dim(plan.oldDomain)} → ${chalk.green(plan.newDomain)}`);
  lines.push(chalk.dim(`  old domain read from ${plan.oldDomainSource}`));

  for (const phase of PHASE_ORDER) {
    const actions = plan.actions.filter((a) => a.phase === phase);
    if (actions.length === 0) continue;
    lines.push("");
    lines.push(
      `  ${chalk.bold(phase)} ${chalk.dim(`— ${PHASE_TITLE[phase].split("—")[1].trim()}`)}`,
    );
    lines.push("");
    for (const action of actions) lines.push(...renderAction(action));
  }

  const counts = countByKind(plan);
  lines.push("");
  lines.push(
    chalk.dim(
      `  ${counts.create} to create, ${counts.update} to update, ${counts.retire} to retire, ` +
        `${counts.noop} already correct, ${counts.manual} for you.`,
    ),
  );
  lines.push("");
  return lines.join("\n");
}

export function countByKind(plan: MigrationPlan): Record<ActionKind, number> {
  const out: Record<ActionKind, number> = {
    create: 0,
    update: 0,
    retire: 0,
    noop: 0,
    manual: 0,
  };
  for (const a of plan.actions) out[a.kind] += 1;
  return out;
}

/** The manual items, rendered as a standalone checklist for the end of
 *  a run. Same content as the `manual` rows in the table — repeated at
 *  the bottom because that is where an operator looks for "what's left
 *  for me", and burying it mid-table guarantees it gets skimmed past. */
export function renderManualChecklist(plan: MigrationPlan): string {
  const manual = plan.actions.filter((a) => a.kind === "manual");
  if (manual.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("  ── Hatchkit can't do these for you ────────────────────────"));
  lines.push("");
  manual.forEach((action, i) => {
    lines.push(`  ${i + 1}. ${action.summary} ${chalk.dim(`(${action.phase})`)}`);
    for (const d of action.detail ?? []) lines.push(chalk.dim(`     ${d}`));
  });
  lines.push("");
  return lines.join("\n");
}
