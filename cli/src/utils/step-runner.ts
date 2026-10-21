import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";

export interface Step<T> {
  name: string;
  run: (state: T) => Promise<T>;
  skip?: (state: T) => boolean;
}

type PromptMemory = { answers: unknown[]; cursor: number; backWithinStep: boolean };
let active: PromptMemory | undefined;

/** Replay answers before the last prompt when a multi-prompt step goes back. */
export function rememberStepPrompt<T extends (...args: never[]) => Promise<unknown>>(prompt: T): T {
  return (async (...args: Parameters<T>) => {
    const memory = active;
    if (!memory) return prompt(...args);
    const index = memory.cursor++;
    if (index < memory.answers.length) return memory.answers[index];
    try {
      const answer = await prompt(...args);
      memory.answers[index] = answer;
      return answer;
    } catch (error) {
      if (error instanceof ExitPromptError && index > 0) {
        memory.answers.length = index - 1;
        memory.backWithinStep = true;
      }
      throw error;
    }
  }) as T;
}

export async function runSteps<T>(steps: Step<T>[], initial: T): Promise<T> {
  const history: T[] = [initial];
  const visited: number[] = [];
  const memories = new Map<number, PromptMemory>();
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    const state = history[i];
    if (step.skip?.(state)) {
      history[i + 1] = state;
      i++;
      continue;
    }
    console.log(
      chalk.dim(
        `\n  [${i + 1}/${steps.length}] ${step.name}${visited.length ? "  Ctrl+C to go back" : ""}`,
      ),
    );
    const memory = memories.get(i) ?? { answers: [], cursor: 0, backWithinStep: false };
    memory.cursor = 0;
    memory.backWithinStep = false;
    memories.set(i, memory);
    active = memory;
    try {
      history[i + 1] = await step.run(state);
      visited.push(i);
      i++;
    } catch (error) {
      if (!(error instanceof ExitPromptError)) throw error;
      if (memory.backWithinStep) continue;
      const previous = visited.pop();
      if (previous === undefined) throw error;
      console.log(chalk.dim("  ← back"));
      i = previous;
      const prior = memories.get(i);
      if (prior) prior.answers.length = Math.max(0, prior.answers.length - 1);
      for (const key of memories.keys()) if (key > i) memories.delete(key);
    } finally {
      active = undefined;
    }
  }
  return history[i];
}
