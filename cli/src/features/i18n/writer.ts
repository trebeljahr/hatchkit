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

import { FeatureLedger } from "../contract.js";
import { renderFeatureTemplate } from "../templates.js";
import { planI18nFiles } from "./plan.js";
import type { I18nConfig } from "./types.js";

export interface WriteI18nInput {
  projectDir: string;
  config: I18nConfig;
  pkgScope: string;
  appName: string;
  /**
   * Where every write goes. Supplied by the feature's `apply` so a
   * combined `create`/`update` run reports one plan and `--dry-run`
   * describes this feature without touching the disk — the ledger is the
   * only place the dry-run flag is checked (see `../contract.ts`).
   *
   * Omitted by the tests and by the standalone generator paths, which get
   * a fresh real ledger over `projectDir`. When one IS passed it owns the
   * project directory, and `projectDir` is only read for the paths this
   * module reports.
   */
  ledger?: FeatureLedger;
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

  const ledger = input.ledger ?? new FeatureLedger(input.projectDir, false);
  const written: string[] = [];
  const unchanged: string[] = [];

  for (const job of jobs) {
    const rendered = renderFeatureTemplate("i18n", job.template, job.tokens);
    // Every planned file is one the feature OWNS and regenerates, so
    // write-if-changed is the right primitive: a second run compares
    // equal and reports `unchanged`, which is the idempotency invariant.
    // `would-write` counts as written because a dry run is describing
    // what a real one would do.
    const action = ledger.writeIfChanged(job.dest, rendered);
    if (action === "written" || action === "would-write") written.push(job.dest);
    else unchanged.push(job.dest);
  }

  return { written, unchanged };
}
