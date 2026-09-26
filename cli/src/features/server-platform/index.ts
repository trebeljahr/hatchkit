/*
 * cli/src/features/server-platform/index.ts — one entry point for the
 * three opt-in server platform features.
 *
 * `hatchkit create` and `hatchkit update` both call
 * {@link applyServerFeatures}; neither knows what any individual
 * feature writes. That is what keeps "added at create" and "added
 * later" the same operation instead of two code paths that drift.
 */

import chalk from "chalk";
import { applyPublicApi } from "../public-api/index.js";
import { applyScheduler } from "../scheduler/index.js";
import { applyServerMigrations } from "../server-migrations/index.js";
import {
  SERVER_FEATURE_IDS,
  SERVER_FEATURE_LABELS,
  type ServerFeatureId,
  type ServerFeatureInput,
  type ServerFeatureResult,
} from "./kit.js";

export * from "./kit.js";

const APPLIERS: Record<ServerFeatureId, (input: ServerFeatureInput) => ServerFeatureResult> = {
  "server-migrations": applyServerMigrations,
  scheduler: applyScheduler,
  "public-api": applyPublicApi,
};

export function isServerFeature(value: string): value is ServerFeatureId {
  return (SERVER_FEATURE_IDS as readonly string[]).includes(value);
}

/** Apply features in registry order, not caller order. `public-api`
 *  registers a webhook sweeper with the scheduler and its tokens need
 *  the index preparation, so a run that adds all three has to write
 *  migrations first — leaving the order to whatever the multiselect
 *  returned would make the result depend on click order. */
export function applyServerFeatures(
  ids: readonly ServerFeatureId[],
  input: ServerFeatureInput,
): ServerFeatureResult[] {
  const wanted = new Set(ids);
  const results = SERVER_FEATURE_IDS.filter((id) => wanted.has(id)).map((id) =>
    APPLIERS[id](input),
  );
  return results;
}

/** Print one block per applied feature. Shared by `create` and
 *  `update` so the two report identically. */
export function printServerFeatureResults(results: readonly ServerFeatureResult[]): void {
  for (const result of results) {
    if (result.skipped) {
      console.log(chalk.yellow(`  ⚠ ${result.id}: skipped — ${result.skipped}`));
      continue;
    }
    const label = SERVER_FEATURE_LABELS[result.id].split(" (")[0];
    console.log(
      chalk.green(
        `  ✓ ${label}: ${result.written.length} file(s) written` +
          (result.patched.length > 0 ? `, ${result.patched.length} patched` : "") +
          (result.unchanged.length > 0 ? `, ${result.unchanged.length} already current` : ""),
      ),
    );
    for (const path of result.conflicted) {
      console.log(
        chalk.yellow(
          `    ⚠ ${path} exists and differs — left untouched. Diff it against the starter before re-running.`,
        ),
      );
    }
    for (const note of result.notes) console.log(chalk.dim(`    · ${note}`));
  }
}
