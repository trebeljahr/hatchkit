import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";

export interface Step<T> {
  name: string;
  run: (state: T) => Promise<T>;
  skip?: (state: T) => boolean;
}

export async function runSteps<T>(steps: Step<T>[], initial: T): Promise<T> {
  const history: T[] = [initial];
  let i = 0;

  while (i < steps.length) {
    const step = steps[i];
    const state = history[i];

    if (step.skip?.(state)) {
      history[i + 1] = state;
      i++;
      continue;
    }

    const pos = `${i + 1}/${steps.length}`;
    const back = i > 0 ? chalk.dim("  Ctrl+C to go back") : "";
    console.log(chalk.dim(`\n  [${pos}] ${step.name}${back}`));

    try {
      const next = await step.run(state);
      history[i + 1] = next;
      i++;
    } catch (err) {
      if (err instanceof ExitPromptError && i > 0) {
        console.log(chalk.dim("  ← back"));
        i--;
        continue;
      }
      throw err;
    }
  }

  return history[i];
}
