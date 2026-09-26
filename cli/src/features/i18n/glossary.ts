/*
 * cli/src/features/i18n/glossary.ts — The per-target `GLOSSARY.<tgt>.md`.
 *
 * The body is NOT written here. `client/GLOSSARY.md.tpl` is the glossary,
 * it is already an entry in plan.ts (gate `per-target`), and the writer
 * already puts it beside the catalogs it describes. Duplicating its text
 * in TypeScript would give the feature two glossaries that drift: the
 * voice section would be edited in the template and the false-friend
 * warning in the code.
 *
 * So this module is a NAMED ACCESSOR over that one source: it renders the
 * shipped template through render.ts and answers where it lands. That is
 * what lets a caller (or a test) get the body for one target without
 * running the whole writer, and it is why `renderGlossary` takes three
 * facts rather than a full config — the glossary depends on the language
 * pair and the product's name, and on nothing else in the config.
 *
 * plan.ts stays the only module that knows the template's PATH: the
 * glossary entry is found by its destination shape, not by its template
 * name.
 */

import { FeatureLedger } from "../contract.js";
import { renderFeatureTemplate } from "../templates.js";
import { DEFAULT_NAMESPACES } from "./locales.js";
import { type I18nJob, planI18nFiles } from "./plan.js";
import type { I18nConfig, LocaleCode } from "./types.js";

/** The destination every glossary job's path contains. The one string
 *  this module shares with plan.ts, chosen over the template path
 *  because plan.ts owns template paths. */
const GLOSSARY_DEST_MARK = "GLOSSARY.";

export interface RenderGlossaryArgs {
  sourceLocale: LocaleCode;
  target: LocaleCode;
  appName: string;
  /** The workspace scope, including the leading `@` (e.g. `@acme`). The
   *  glossary only needs it for the two `pnpm --filter` commands it
   *  tells the translator to run, so a caller that does not know the
   *  scope gets a visible `<scope>` placeholder rather than a confidently
   *  wrong package name. */
  pkgScope?: string;
}

/** The rendered `GLOSSARY.<target>.md` body. Throws only if the shipped
 *  template is missing from the install, which is a broken package
 *  rather than a user problem. */
export function renderGlossary(args: RenderGlossaryArgs): string {
  const job = glossaryJob(args);
  return renderFeatureTemplate("i18n", job.template, job.tokens);
}

/** Project-relative path of one target's glossary. */
export function glossaryDest(args: RenderGlossaryArgs): string {
  return glossaryJob(args).dest;
}

export interface WriteGlossariesInput {
  projectDir: string;
  config: I18nConfig;
  pkgScope: string;
  appName: string;
  /** Project-relative directory to write the glossaries into, overriding
   *  the planned client path. A server-only project has no
   *  `packages/client`, and writing the translator's file to a client
   *  path there would conjure a package the project does not have — so
   *  the caller puts it beside the catalogs that actually exist. */
  destDir?: string;
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

export interface WriteGlossariesResult {
  written: string[];
  unchanged: string[];
}

/** Write one glossary per target language.
 *
 *  Normally a no-op in the middle of a full run: the writer got there
 *  first with the same bytes from the same template, so every path comes
 *  back `unchanged`. It is called anyway so the glossary is guaranteed
 *  for a caller that wrote only part of the plan — and so the audit can
 *  name the files a translator has to open, which is the one output of
 *  this feature aimed at a person who does not read TypeScript. */
export function writeI18nGlossaries(input: WriteGlossariesInput): WriteGlossariesResult {
  const ledger = input.ledger ?? new FeatureLedger(input.projectDir, false);
  const written: string[] = [];
  const unchanged: string[] = [];

  for (const target of input.config.targetLocales) {
    const args: RenderGlossaryArgs = {
      sourceLocale: input.config.sourceLocale,
      target,
      appName: input.appName,
      pkgScope: input.pkgScope,
    };
    const body = renderGlossary(args);
    const planned = glossaryDest(args);
    const rel =
      input.destDir === undefined
        ? planned
        : `${input.destDir.replace(/\/$/, "")}/${planned.slice(planned.lastIndexOf("/") + 1)}`;
    const action = ledger.writeIfChanged(rel, body);
    if (action === "written" || action === "would-write") written.push(rel);
    else unchanged.push(rel);
  }

  return { written, unchanged };
}

/** Ask plan.ts for the glossary job of one target, so the template path
 *  and the token set both stay in one place. The config below is
 *  synthesised: every gate is off because a glossary is `per-target`
 *  (always included) and none of its tokens depend on which surfaces the
 *  project generates. */
function glossaryJob(args: RenderGlossaryArgs): I18nJob {
  const config: I18nConfig = {
    sourceLocale: args.sourceLocale,
    targetLocales: [args.target],
    namespaces: [...DEFAULT_NAMESPACES],
    publicPages: false,
    serverCatalogs: false,
    pseudoLocale: false,
    gateFailsafeMs: 4000,
  };
  const jobs = planI18nFiles(config, {
    pkgScope: args.pkgScope ?? "<scope>",
    appName: args.appName,
  });
  const job = jobs.find((j) => j.dest.includes(GLOSSARY_DEST_MARK));
  if (!job) {
    throw new Error(
      "i18n plan has no glossary entry — cli/src/features/i18n/plan.ts and glossary.ts disagree.",
    );
  }
  return job;
}
