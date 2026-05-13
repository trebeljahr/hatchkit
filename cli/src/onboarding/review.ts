import { Separator, select } from "@inquirer/prompts";
import chalk from "chalk";

export interface OnboardingStep {
  /** Stable id used as the select value. */
  key: string;
  /** Display label (left of the summary tail). */
  label: string;
  /** Has the user given this step an explicit value? */
  set: boolean;
  /** Right-side tail showing the current value. */
  summary: string;
}

export interface OnboardingStepGroup {
  title: string;
  steps: OnboardingStep[];
}

export interface ProjectOnboardingReviewOptions<TPlan> {
  initial: TPlan;
  buildGroups: (plan: TPlan) => OnboardingStepGroup[];
  editStep: (plan: TPlan, step: string) => Promise<TPlan>;
  proceedLabel: string;
  intro?: string;
  cancelLabel?: string;
  cancelMessage?: string;
}

const PROCEED = "__proceed__";
const CANCEL = "__cancel__";

export async function runProjectOnboardingReview<TPlan>(
  options: ProjectOnboardingReviewOptions<TPlan>,
): Promise<TPlan> {
  let plan = options.initial;

  if (options.intro) {
    console.log(options.intro);
  }

  for (;;) {
    const groups = options.buildGroups(plan);
    const allSteps = groups.flatMap((g) => g.steps);
    const firstUnset = allSteps.find((s) => !s.set);
    const defaultKey = firstUnset?.key ?? PROCEED;

    const choices: Array<Separator | { name: string; value: string }> = [];
    for (const group of groups) {
      choices.push(new Separator(renderOnboardingGroupHeader(group)));
      for (const step of group.steps) {
        choices.push({ name: renderOnboardingStepLabel(step), value: step.key });
      }
    }
    choices.push(new Separator(" "));
    choices.push({
      name: chalk.bold(chalk.green(`✓  ${options.proceedLabel}`)),
      value: PROCEED,
    });
    if (options.cancelLabel) {
      choices.push({ name: chalk.dim(`✗  ${options.cancelLabel}`), value: CANCEL });
    }

    const picked = await select<string>({
      message: "Next step:",
      default: defaultKey,
      pageSize: Math.min(30, choices.length),
      choices,
    });

    if (picked === PROCEED) return plan;
    if (picked === CANCEL) {
      if (options.cancelMessage) {
        console.log(options.cancelMessage);
      }
      throw new Error(`${options.cancelLabel ?? "Onboarding"} cancelled by user`);
    }
    plan = await options.editStep(plan, picked);
  }
}

export function renderOnboardingStepLabel(step: OnboardingStep): string {
  const mark = step.set ? chalk.green("✓") : chalk.dim("·");
  const tail = step.summary ? chalk.dim(` — ${step.summary}`) : "";
  return `${mark}  ${step.label.padEnd(18)}${tail}`;
}

export function renderOnboardingGroupHeader(group: OnboardingStepGroup): string {
  return chalk.bold(`── ${group.title} ──`);
}
