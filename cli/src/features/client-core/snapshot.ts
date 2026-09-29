/*
 * cli/src/features/client-core/snapshot.ts — the project's own tRPC contract
 * snapshot.
 *
 * `packages/server/src/tests/trpc-contract.test.ts` fails when
 * `packages/server/contract/trpc-contract.json` is missing, and it never
 * writes the file itself: a test that generates its own expectation cannot
 * fail. So a project needs the snapshot before its first `pnpm test`.
 *
 * The snapshot must describe THIS project's router, and only the project's
 * installed code can produce it. The JSON Schema comes from the project's own
 * zod, run over the routers this scaffold kept. The starter's copy does not
 * fit (see `CLIENT_CORE_GENERATED_PATHS`). So `create` does two things:
 *
 *  - The scaffold removes the starter's copy (`dropStarterContractSnapshot`).
 *  - After `pnpm install`, `create` runs the project's own `contract:emit`
 *    (`emitContractSnapshot`). This happens before the initial commit, so the
 *    snapshot is in the first commit.
 *
 * With no install, or a failed emit, the project has no snapshot. The test
 * then names the one command to run, which is the right advice. A stale
 * snapshot would classify the scaffold's own pruning as a breaking change.
 *
 * `update` does not install, so it cannot run the emitter. It tells the user
 * to run it, like every feature that adds a workspace package.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { removeIfExists } from "../../scaffold/starter-files.js";
import { exec } from "../../utils/exec.js";
import { CLIENT_CORE_GENERATED_PATHS } from "./types.js";

/** Where `pnpm run contract:emit` writes the snapshot, relative to the project. */
export const CONTRACT_SNAPSHOT_PATH = "packages/server/contract/trpc-contract.json";

/**
 * Remove the starter's contract snapshot from a freshly-copied starter.
 *
 * Returns the modification lines for the scaffold summary. Idempotent.
 */
export function dropStarterContractSnapshot(projectDir: string): string[] {
  let removed = false;
  for (const rel of CLIENT_CORE_GENERATED_PATHS) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    removeIfExists(path);
    removed = true;
  }
  return removed
    ? ["removed: the starter's tRPC contract snapshot (the project writes its own)"]
    : [];
}

/**
 * Run the project's `contract:emit` in `projectDir`. The dependencies must be
 * installed.
 *
 * Returns true when the snapshot exists afterwards. Never throws: a failed
 * emit is a missing file, and the contract test says how to write it.
 */
export async function emitContractSnapshot(projectDir: string): Promise<boolean> {
  try {
    const result = await exec("pnpm", ["run", "contract:emit"], {
      cwd: projectDir,
      spinner: "Writing the tRPC contract snapshot...",
    });
    return result.exitCode === 0 && existsSync(join(projectDir, CONTRACT_SNAPSHOT_PATH));
  } catch {
    return false;
  }
}
