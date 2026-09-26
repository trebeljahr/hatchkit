/*
 * cli/src/features/i18n/writer.ts — Write the planned i18n files into the
 * user's project, with __HATCHKIT_*__ token substitution.
 *
 * A pure function of its input: the plan decides WHAT, this decides only
 * whether a byte already on disk needs replacing. That is what makes
 * `hatchkit add i18n` safe to re-run — a second run reports every file
 * unchanged and touches nothing, so a project can be re-synced after a
 * hatchkit upgrade without a diff to review.
 *
 * Existing project files are NOT this module's business: the surgical edits
 * to layout.tsx, globals.css and friends live in rewriter.ts, which reports
 * "absent" instead of overwriting a shape it does not recognise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planI18nFiles } from "./plan.js";
import { renderI18nTemplate } from "./render.js";
import type { I18nConfig } from "./types.js";

export interface WriteI18nInput {
  projectDir: string;
  config: I18nConfig;
  pkgScope: string;
  appName: string;
}

export interface WriteI18nResult {
  written: string[];
  /** Files whose on-disk contents already matched the rendered template —
   *  counted toward idempotency, NOT toward `written`. */
  unchanged: string[];
}

export function writeI18nFiles(input: WriteI18nInput): WriteI18nResult {
  const jobs = planI18nFiles(input.config, {
    pkgScope: input.pkgScope,
    appName: input.appName,
  });

  const written: string[] = [];
  const unchanged: string[] = [];

  for (const job of jobs) {
    const rendered = renderI18nTemplate(job.template, job.tokens);
    const dest = join(input.projectDir, job.dest);
    if (writeIfChanged(dest, rendered) === "written") written.push(job.dest);
    else unchanged.push(job.dest);
  }

  return { written, unchanged };
}

function writeIfChanged(absPath: string, content: string): "written" | "unchanged" {
  if (existsSync(absPath)) {
    const cur = readFileSync(absPath, "utf-8");
    if (cur === content) return "unchanged";
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
  return "written";
}
