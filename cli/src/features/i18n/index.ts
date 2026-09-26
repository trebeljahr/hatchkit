/*
 * cli/src/features/i18n/index.ts — the feature's INTERACTIVE entry point.
 *
 * All three command paths (`hatchkit create`, `hatchkit update`, `hatchkit
 * add <project> i18n`) route through {@link runI18nSetup}, so the question
 * set has one home. What it does with the answers lives in `./apply.js`,
 * which the registered feature in `./definition.js` shares — see that
 * file's header for why the split is along this line and not another.
 *
 * Three properties the callers depend on:
 *
 *   · IDEMPOTENT. Every write is diff-then-apply and every edit carries a
 *     sentinel, so a second run reports everything unchanged. That is
 *     what makes the feature safe to re-run after a hatchkit upgrade.
 *   · NEVER THROWS for a user-recoverable problem. A project with no
 *     client package, an unknown language, a layout nobody recognises:
 *     each one comes back as `ok:false` or as a manual-residue line. A
 *     `create` that already wrote sixty files must not be rolled back
 *     over a language. (Ctrl+C is the exception — `@inquirer`'s
 *     ExitPromptError propagates to the CLI's own cancellation handler,
 *     as everywhere else in hatchkit.)
 *   · ADDITIVE. The starter is single-language and ships nothing to
 *     strip, so this only ever writes new files and makes the handful of
 *     anchored edits in rewriter.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkbox, confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";
import { FeatureLedger } from "../contract.js";
import { CLIENT_PKG_REL, SERVER_PKG_REL, applyI18nConfig } from "./apply.js";
import { DEFAULT_NAMESPACES, SUPPORTED_LOCALES, isKnownLocale, localeMeta } from "./locales.js";
import { shippedNamespaces } from "./plan.js";
import type { I18nApplyResult, I18nConfig } from "./types.js";

export * from "./types.js";
export { SUPPORTED_LOCALES, localeMeta, isKnownLocale, DEFAULT_NAMESPACES } from "./locales.js";
/** Re-exported so `hatchkit add i18n` and the scaffolder keep one import
 *  site for the feature, while `../all.ts` reaches the non-interactive
 *  half through `./definition.js` and never loads this module. */
export { applyI18nConfig } from "./apply.js";

const DEFAULT_GATE_MS = 4000;

export interface RunI18nSetupOptions {
  projectDir: string;
  mode: "create" | "update" | "add";
  /** Non-interactive answers. Supplying the object at all means headless:
   *  every question then has an answer, either from here or from the
   *  default beside it. */
  presets?: Partial<I18nConfig> & { confirm?: boolean };
  /** Report what would happen and touch nothing. Implemented by handing
   *  {@link applyI18nConfig} a DRY {@link FeatureLedger} rather than by
   *  returning early — so the itemised plan covers the existing-file
   *  edits and the docs too, not just the template writes. Nothing below
   *  checks the flag; the ledger is the only place it is read. */
  dryRun?: boolean;
  /** Record through this ledger instead of a fresh one, so a combined
   *  `create` / `update` run reports one plan. When supplied it decides
   *  whether the run is dry and `dryRun` above is ignored. */
  ledger?: FeatureLedger;
  /** The project's frozen identifier set, for the human-facing app name.
   *  See {@link applyI18nConfig} for why this is not detected. */
  identifiers?: ProjectIdentifiers;
}

export async function runI18nSetup(opts: RunI18nSetupOptions): Promise<I18nApplyResult> {
  // `create` runs inside runScaffoldSteps, where a spinner owns the
  // terminal — printing there interleaves with it. The caller records the
  // audit as scaffold modifications instead.
  const quiet = opts.mode === "create";
  const result: I18nApplyResult = {
    ok: false,
    written: [],
    unchanged: [],
    rewritten: [],
    skipped: [],
    manualResidue: [],
    config: defaultConfig(false),
  };

  const hasClient = existsSync(join(opts.projectDir, CLIENT_PKG_REL));
  const hasServer = existsSync(join(opts.projectDir, SERVER_PKG_REL));

  // A project with neither package is not a surface this feature knows
  // how to localise, and guessing a layout for it would write files
  // nothing imports.
  if (!hasClient && !hasServer) {
    return fail(
      result,
      quiet,
      `No packages/client in ${opts.projectDir} — i18n localises a client surface. Run it inside a scaffolded project, or re-scaffold with a client.`,
    );
  }

  const answers = opts.presets
    ? fromPresets(opts.presets, hasServer)
    : await askI18nQuestions(hasServer);
  if (answers === null) {
    result.skipped.push("i18n: declined at the confirmation step");
    return fail(result, quiet, "i18n setup declined — nothing was written.");
  }

  const invalid = validateConfig(answers);
  if (invalid) return fail(result, quiet, invalid);
  result.config = answers;

  return applyI18nConfig({
    projectDir: opts.projectDir,
    config: answers,
    ledger: opts.ledger ?? new FeatureLedger(opts.projectDir, opts.dryRun === true),
    identifiers: opts.identifiers,
    quiet,
  });
}

/**
 * Everything the feature does once its config is settled.
 *
 * Split out of {@link runI18nSetup} so the feature's two entry points
 * share it: the interactive front door above, and the registered
 * feature's non-interactive `apply` in `./definition.js`, which reads the
 * config back off the manifest instead of asking. Neither may drift from
 * the other — a `create` and a later re-apply that wrote different
 * projects is the failure this arrangement prevents.
 *
 * Prompts nothing. Every write goes through `ledger`, so a dry run is
 * just a dry ledger.
 */

// ---------------------------------------------------------------------------
// Questions.
// ---------------------------------------------------------------------------

/** The worked example the shipped templates contain: the target catalogs
 *  carry real German, so English → German is the one pair that arrives
 *  translated rather than seeded. */
function defaultConfig(hasServer: boolean): I18nConfig {
  return {
    sourceLocale: "en",
    targetLocales: ["de"],
    namespaces: [...DEFAULT_NAMESPACES],
    publicPages: true,
    serverCatalogs: hasServer,
    pseudoLocale: true,
    gateFailsafeMs: DEFAULT_GATE_MS,
  };
}

function fromPresets(
  presets: Partial<I18nConfig> & { confirm?: boolean },
  hasServer: boolean,
): I18nConfig | null {
  // Only an explicit `false` declines: a headless caller that omits the
  // field asked for the feature by selecting it in the first place.
  if (presets.confirm === false) return null;
  const base = defaultConfig(hasServer);
  return {
    sourceLocale: presets.sourceLocale ?? base.sourceLocale,
    targetLocales: presets.targetLocales ? [...presets.targetLocales] : base.targetLocales,
    namespaces: presets.namespaces ? [...presets.namespaces] : base.namespaces,
    publicPages: presets.publicPages ?? base.publicPages,
    serverCatalogs: presets.serverCatalogs ?? base.serverCatalogs,
    pseudoLocale: presets.pseudoLocale ?? base.pseudoLocale,
    gateFailsafeMs: presets.gateFailsafeMs ?? base.gateFailsafeMs,
  };
}

async function askI18nQuestions(hasServer: boolean): Promise<I18nConfig | null> {
  const base = defaultConfig(hasServer);
  const codes = Object.keys(SUPPORTED_LOCALES).sort();

  const sourceLocale = await select<string>({
    message: "Source language (what the code and the prerendered HTML are written in):",
    default: base.sourceLocale,
    choices: codes.map((code) => ({
      name: `${code} — ${localeMeta(code).englishName} (${localeMeta(code).endonym})`,
      value: code,
    })),
  });

  const targetLocales = await checkbox<string>({
    message: "Translate into:",
    // @inquirer's checkbox, not hatchkit's multiselect: this prompt is a
    // plain list with no detection hints to show, and its own help line
    // already explains space-to-toggle.
    choices: codes
      .filter((code) => code !== sourceLocale)
      .map((code) => ({
        name: `${code} — ${localeMeta(code).englishName} (${localeMeta(code).endonym})`,
        value: code,
        checked: base.targetLocales.includes(code),
      })),
    validate: (picked) => (picked.length > 0 ? true : "Pick at least one language."),
  });

  const publicPages = await confirm({
    message: "Build the public pages once per language, under /<locale>/?",
    default: base.publicPages,
  });

  const serverCatalogs = hasServer
    ? await confirm({
        message: "Generate the server catalogs (email + documents, snapshotted per document)?",
        default: base.serverCatalogs,
      })
    : false;

  const pseudoLocale = await confirm({
    message: "Ship the pseudo-locale (non-production builds only)?",
    default: base.pseudoLocale,
  });

  return {
    sourceLocale,
    targetLocales,
    namespaces: base.namespaces,
    publicPages,
    serverCatalogs,
    pseudoLocale,
    gateFailsafeMs: base.gateFailsafeMs,
  };
}

/** Returns a message rather than throwing: an unknown language code from
 *  a flag is a typo, and the fix is the message. */
function validateConfig(config: I18nConfig): string | null {
  if (!isKnownLocale(config.sourceLocale)) {
    return unknownLocaleMessage(config.sourceLocale);
  }
  if (config.targetLocales.length === 0) {
    return "i18n needs at least one target language. Pass `targetLocales` or pick one in the prompt.";
  }
  for (const code of config.targetLocales) {
    if (!isKnownLocale(code)) return unknownLocaleMessage(code);
    if (code === config.sourceLocale) {
      return `"${code}" is both the source and a target language. The source is already written; drop it from the targets.`;
    }
  }
  if (new Set(config.targetLocales).size !== config.targetLocales.length) {
    return `Duplicate target language in [${config.targetLocales.join(", ")}].`;
  }
  if (config.namespaces.length === 0) {
    return (
      "i18n needs at least one namespace (the default set is: " +
      DEFAULT_NAMESPACES.join(", ") +
      ")."
    );
  }
  // Each namespace is a hand-written pair of catalog templates, so one
  // hatchkit does not ship has no file to render. Caught here rather than
  // by render.ts, which would report a missing template path — true, but
  // not the fix.
  const shipped = shippedNamespaces();
  const unknownNs = config.namespaces.filter((ns) => !shipped.includes(ns));
  if (unknownNs.length > 0) {
    return (
      `No catalog template for namespace ${unknownNs.map((n) => `"${n}"`).join(", ")}. ` +
      `Hatchkit ships: ${shipped.join(", ")}. Generate with those, then add your own ` +
      `namespace to \`messages/index.ts\` and write its catalogs by hand — or add ` +
      `source/target templates for it to cli/src/templates/i18n/client/messages/ and ` +
      `list it in cli/src/features/i18n/plan.ts.`
    );
  }
  if (!Number.isFinite(config.gateFailsafeMs) || config.gateFailsafeMs <= 0) {
    return `gateFailsafeMs must be a positive number of milliseconds (got ${config.gateFailsafeMs}). It is the timeout after which the first-paint gate lifts regardless.`;
  }
  return null;
}

function unknownLocaleMessage(code: string): string {
  const known = Object.keys(SUPPORTED_LOCALES).sort().join(", ");
  return `Unknown language "${code}". Hatchkit knows: ${known}.`;
}

function fail(result: I18nApplyResult, quiet: boolean, message: string): I18nApplyResult {
  result.ok = false;
  result.manualResidue.push(message);
  if (!quiet) console.log(chalk.yellow(`\n  i18n: ${message}\n`));
  return result;
}
