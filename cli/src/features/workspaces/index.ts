/*
 * cli/src/features/workspaces/index.ts — the `workspaces` feature:
 * tenants, members, roles and invitations for a scaffolded app.
 *
 * ONE entry point, called by both paths:
 *   - `hatchkit create` when the feature is selected, and
 *   - `hatchkit update` when it is added to an existing project.
 *
 * The feature is purely ADDITIVE, which is why there is one function
 * rather than the usual copy-everything-then-strip pair. Nothing in the
 * starter imports these files, so a project without the feature has
 * nothing to remove and cannot fail to compile because a strip codemod
 * missed a call site — the failure mode that dogs every other feature
 * here. The cost is that the emitted source lives under
 * cli/src/templates/workspaces/ rather than in `starter/`, so it is not
 * exercised by the starter's own typecheck; `cli/test-workspaces.ts`
 * covers it instead.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runWorkspaceCodemods } from "./codemods.js";
import { filesFor } from "./file-map.js";
import type { WorkspacesApplyInput, WorkspacesApplyResult, WorkspacesTargets } from "./types.js";
import { writeWorkspaceFiles } from "./writer.js";

export { WORKSPACE_FILES, filesFor, enabledGroups } from "./file-map.js";
export {
  assertFullyRendered,
  defaultTokens,
  getWorkspacesTemplatesDir,
  renderWorkspacesString,
  renderWorkspacesTemplate,
} from "./render.js";
export { runWorkspaceCodemods } from "./codemods.js";
export type { CodemodResult, CodemodOutcome } from "./codemods.js";
export type {
  WorkspacesApplyInput,
  WorkspacesApplyResult,
  WorkspacesTargets,
} from "./types.js";

/**
 * Work out which halves of a project exist. A `static` surface has no
 * server, a `backend` surface has no client, and the per-recipient
 * realtime fan-out only means anything with the websocket feature on.
 */
export function detectTargets(projectDir: string, features: readonly string[]): WorkspacesTargets {
  return {
    server: existsSync(join(projectDir, "packages/server/src/trpc/router.ts")),
    shared: existsSync(join(projectDir, "packages/shared/src/index.ts")),
    client: existsSync(join(projectDir, "packages/client/src/app/layout.tsx")),
    websocket: features.includes("websocket"),
  };
}

/** True when the project already carries the feature's files. */
export function hasWorkspacesFeature(projectDir: string): boolean {
  return existsSync(join(projectDir, "packages/server/src/services/membership/index.ts"));
}

export function applyWorkspacesFeature(input: WorkspacesApplyInput): WorkspacesApplyResult {
  const { projectDir, projectName, targets, dryRun } = input;

  if (!targets.server && !targets.client) {
    return {
      written: [],
      unchanged: [],
      skipped: [],
      patched: [],
      notes: [],
      nextSteps: ["workspaces needs a server or a client package — nothing was written."],
    };
  }

  const files = writeWorkspaceFiles({ projectDir, projectName, targets, dryRun });
  const codemods = runWorkspaceCodemods({
    projectDir,
    server: targets.server,
    shared: targets.shared,
    client: targets.client,
    websocket: targets.websocket,
    dryRun,
  });

  const patched = codemods.filter((c) => c.outcome === "patched").map((c) => c.file);
  const nextSteps: string[] = [];
  for (const c of codemods) {
    if (c.outcome === "manual" && c.hint) nextSteps.push(c.hint);
  }

  const notes: string[] = [];
  if (targets.server && !targets.shared) {
    notes.push(
      "No packages/shared — the membership contract was not written; import it from wherever your app keeps shared types.",
    );
  }
  if (targets.server && !targets.websocket) {
    notes.push(
      "websocket feature is off — membership events publish into a no-op. Add `websocket` to get the per-recipient fan-out.",
    );
  }

  // The postgres overlay rewrites the db layer to Drizzle; the mirror
  // model and the collection accessors here are Mongoose/MongoDB. Say so
  // rather than emitting code that cannot compile against that project.
  if (existsSync(join(projectDir, "packages/server/src/db/schema.ts"))) {
    nextSteps.push(
      "This project uses the Postgres (Drizzle) overlay. The membership mirror and the better-auth collection accessors in services/membership/mirror.ts are MongoDB — port them to Drizzle before the server will build.",
    );
  }

  if (files.skipped.length > 0) {
    nextSteps.push(
      `Left alone because they already exist with different content: ${files.skipped.join(", ")}. Merge by hand if you want the new version.`,
    );
  }

  if (files.written.length > 0) {
    nextSteps.push(
      "Run `pnpm --filter @starter/shared run build` so the server and client pick up the membership contract.",
    );
  }

  return { ...files, patched, notes, nextSteps };
}

/** How many files the feature would write into this project. */
export function workspacesFileCount(targets: WorkspacesTargets): number {
  return filesFor(targets).length;
}
