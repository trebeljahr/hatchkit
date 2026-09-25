/*
 * cli/src/features/workspaces/writer.ts — render the feature's templates
 * into a project, without ever clobbering something the user wrote.
 *
 * Three outcomes per file, and the difference matters: a file we created
 * is `written`, a file already byte-identical is `unchanged` (a re-run of
 * `hatchkit update` must be a no-op), and a file present with DIFFERENT
 * content is `skipped` — the user edited it, and silently overwriting
 * their members screen on an unrelated `update` would be unforgivable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { filesFor } from "./file-map.js";
import {
  type WorkspacesTokens,
  assertFullyRendered,
  defaultTokens,
  renderWorkspacesTemplate,
} from "./render.js";
import type { WorkspacesApplyResult, WorkspacesTargets } from "./types.js";

export interface WriteFilesInput {
  projectDir: string;
  projectName: string;
  targets: WorkspacesTargets;
  dryRun?: boolean;
  /** Overrides on top of `defaultTokens(projectName)`. */
  tokens?: WorkspacesTokens;
}

export type WriteOutcome = "written" | "unchanged" | "skipped";

/** Write one rendered file, reporting which of the three cases happened. */
export function writeRendered(absPath: string, content: string, dryRun = false): WriteOutcome {
  if (existsSync(absPath)) {
    const current = readFileSync(absPath, "utf-8");
    return current === content ? "unchanged" : "skipped";
  }
  if (!dryRun) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
  }
  return "written";
}

export function writeWorkspaceFiles(
  input: WriteFilesInput,
): Pick<WorkspacesApplyResult, "written" | "unchanged" | "skipped"> {
  const tokens = { ...defaultTokens(input.projectName), ...input.tokens };
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];

  for (const file of filesFor(input.targets)) {
    const rendered = renderWorkspacesTemplate(file.template, tokens);
    assertFullyRendered(file.template, rendered);
    const outcome = writeRendered(join(input.projectDir, file.dest), rendered, input.dryRun);
    if (outcome === "written") written.push(file.dest);
    else if (outcome === "unchanged") unchanged.push(file.dest);
    else skipped.push(file.dest);
  }

  return { written, unchanged, skipped };
}
