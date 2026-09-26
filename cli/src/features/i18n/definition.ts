/*
 * cli/src/features/i18n/definition.ts — the feature's registration
 * against the shared contract in `../contract.ts`.
 *
 * Separate from `./index.ts` for the same reason
 * `auth-account-security/definition.ts` is separate from its own: the
 * interactive half must not sit on the path `../all.ts` walks. `all.ts`
 * imports every definition eagerly, so the registry can answer questions
 * about features nobody selected — and `index.ts` imports
 * `@inquirer/prompts` to ask its questions. So the work itself lives in
 * `./apply.js`, which both halves import and neither prompts from.
 *
 * Both invariants the contract demands hold, and neither is incidental:
 *
 * · **Additive.** The starter is single-language and ships nothing for
 *   this feature to strip, so `apply` only writes new files and makes the
 *   anchored edits in `./rewriter.ts` — each of which detects its own
 *   previous output and declines a shape it does not recognise rather
 *   than guessing.
 *
 * · **Idempotent.** Every write is `ledger.writeIfChanged` and every edit
 *   carries a sentinel, so a second apply reports `unchanged` and touches
 *   nothing. `cli/test-i18n-writer.ts` and `cli/test-i18n-rewriter.ts`
 *   pin both halves.
 *
 * ============================================================
 * WHY THE CONFIG COMES OFF THE MANIFEST
 * ============================================================
 *
 * `apply` must not prompt, so it cannot ask which languages the project
 * wants — and it must not fall back to today's defaults either. A project
 * that chose French last month would silently gain German the moment the
 * default moved, and the generated tree would then carry two half-filled
 * catalog sets with no way to tell which one the translator maintains.
 *
 * So `manifest.i18n` is the source of truth, written by whichever entry
 * point collected the answers, and `apply` reads it back. The defaults are
 * used only when the field is absent — a project scaffolded by a CLI that
 * predates the field, where en → de is what that CLI actually produced.
 */

import type { ProjectManifest } from "../../scaffold/manifest.js";
import { type FeatureContext, type FeaturePlanContext, registerFeature } from "../contract.js";
import { applyI18nConfig, narrowI18nJobs, settleI18nSurfaces } from "./apply.js";
import { DEFAULT_NAMESPACES } from "./locales.js";
import { planI18nFiles } from "./plan.js";
import type { I18nConfig } from "./types.js";

/** What `hatchkit create` generated before `manifest.i18n` existed, and
 *  what the picker still offers first: the shipped target catalogs carry
 *  real German, so en → de is the one pair that arrives translated rather
 *  than seeded. */
const LEGACY_DEFAULTS: Omit<I18nConfig, "namespaces"> = {
  sourceLocale: "en",
  targetLocales: ["de"],
  publicPages: true,
  serverCatalogs: true,
  pseudoLocale: true,
  gateFailsafeMs: 4000,
};

/** The config this project's i18n tree was generated from. */
export function recordedI18nConfig(manifest: ProjectManifest): I18nConfig {
  const recorded = manifest.i18n;
  if (recorded) {
    return {
      sourceLocale: recorded.sourceLocale,
      targetLocales: [...recorded.targetLocales],
      namespaces: [...recorded.namespaces],
      publicPages: recorded.publicPages,
      serverCatalogs: recorded.serverCatalogs,
      pseudoLocale: recorded.pseudoLocale,
      gateFailsafeMs: recorded.gateFailsafeMs,
    };
  }
  return { ...LEGACY_DEFAULTS, namespaces: [...DEFAULT_NAMESPACES] };
}

export const i18nFeature = registerFeature({
  id: "i18n",
  title: "Second language (i18n)",
  summary:
    "A typed translation catalog per language, a first-paint locale gate, an account-synced preference, and optional public pages built once per language.",
  /**
   * Every surface that produces a client bundle, plus `backend`: the
   * server catalogs snapshot a document or an email in the language it
   * was issued in, which is useful without any client at all. `apply`
   * narrows to the halves the project actually has and says which it
   * skipped.
   */
  surfaces: ["fullstack", "split", "static", "backend"],
  addableAfterScaffold: true,

  apply(ctx: FeatureContext) {
    const audit = applyI18nConfig({
      projectDir: ctx.projectDir,
      config: recordedI18nConfig(ctx.manifest),
      ledger: ctx.ledger,
      identifiers: ctx.identifiers,
      // The ledger's own summary is what the caller prints; a second
      // report of the same run interleaves with it.
      quiet: true,
    });
    for (const note of audit.skipped) ctx.log(`  i18n: ${note}`);
    for (const step of audit.manualResidue) ctx.log(`  → ${step}`);
  },

  /**
   * Read straight off `plan.ts`, the single source of truth for the
   * template → destination mapping, then narrowed by the same two helpers
   * the apply uses. Nothing here may hardcode a template path:
   * `cli/test-i18n-seams.ts` asserts both directions of that table, and a
   * dry run that named files the apply then refuses to write would be
   * worse than one that named none.
   *
   * `docs/i18n.md` is appended because it is the one file written outside
   * the plan entirely. The glossary IS a plan entry, so it comes along on
   * its own — except for a server-only project, where the apply redirects
   * it beside the catalogs that exist rather than conjuring a
   * `packages/client` the surface prune removed.
   *
   * Only the paths this WRITES. The nine anchored edits to files the
   * starter already shipped are a different thing, and a `+ path` line for
   * a file that is already there reads as a new one.
   */
  plannedFiles(ctx: FeaturePlanContext): readonly string[] {
    const config = recordedI18nConfig(ctx.manifest);
    // Mutates `config`, which is this function's own copy.
    const { serverOnly } = settleI18nSurfaces(ctx.projectDir, config);
    const jobs = narrowI18nJobs(
      planI18nFiles(config, {
        // A prediction, not a write: the scope decides the CONTENTS of a
        // generated import, never a path, so it cannot make the file list
        // wrong. The apply reads the real one off the workspace.
        pkgScope: ctx.identifiers.npmScope,
        appName: ctx.identifiers.productName,
      }),
      serverOnly,
    );
    const dests = jobs.map((job) => job.dest);
    if (serverOnly) {
      for (const target of config.targetLocales) {
        dests.push(`packages/server/src/i18n/GLOSSARY.${target}.md`);
      }
    }
    return [...dests, "docs/i18n.md"];
  },
});
