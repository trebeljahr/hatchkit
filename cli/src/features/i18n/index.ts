/*
 * cli/src/features/i18n/index.ts — Top-level entrypoint for the i18n
 * feature. All three command paths (`hatchkit create`, `hatchkit update`,
 * `hatchkit add <project> i18n`) route through {@link runI18nSetup}, so
 * the question set, the detection heuristics and the report have one
 * home.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkbox, confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import { readManifest } from "../../scaffold/manifest.js";
import { writeI18nProjectDocs } from "./docs.js";
import { writeI18nGlossaries } from "./glossary.js";
import { DEFAULT_NAMESPACES, SUPPORTED_LOCALES, isKnownLocale, localeMeta } from "./locales.js";
import { planI18nFiles, shippedNamespaces } from "./plan.js";
import { renderI18nTemplate } from "./render.js";
import { applyI18nRewrites } from "./rewriter.js";
import type { I18nApplyResult, I18nConfig } from "./types.js";
import { type WriteI18nResult, writeI18nFiles } from "./writer.js";

export * from "./types.js";
export { SUPPORTED_LOCALES, localeMeta, isKnownLocale, DEFAULT_NAMESPACES } from "./locales.js";

const CLIENT_PKG_REL = "packages/client/package.json";
const SERVER_PKG_REL = "packages/server/package.json";
const SHARED_PKG_REL = "packages/shared/package.json";
const LAYOUT_REL = "packages/client/src/app/layout.tsx";
/** The starter's placeholder title. A manifest name beats it. */
const PLACEHOLDER_APP_NAME = "My App";
const DEFAULT_GATE_MS = 4000;

export interface RunI18nSetupOptions {
  projectDir: string;
  mode: "create" | "update" | "add";
  /** Non-interactive answers. Supplying the object at all means headless:
   *  every question then has an answer, either from here or from the
   *  default beside it. */
  presets?: Partial<I18nConfig> & { confirm?: boolean };
  dryRun?: boolean;
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

  const { scope: pkgScope, guessed } = detectPkgScope(opts.projectDir);
  const appName = detectAppName(opts.projectDir);
  if (guessed) {
    result.manualResidue.push(
      `Hatchkit could not read a workspace scope from the package names and used \`${pkgScope}\`. Check the \`${pkgScope}/shared\` imports in the generated files.`,
    );
  }

  // The client half is where the store, the gate and the public pages
  // live. Without it, only the server catalogs and the shared helpers
  // they import make sense — written, and said out loud.
  const serverOnly = !hasClient;
  if (serverOnly) {
    answers.publicPages = false;
    result.skipped.push(
      "packages/client: absent — wrote the server catalogs and the shared helpers only",
    );
  }
  if (!hasServer && answers.serverCatalogs) {
    answers.serverCatalogs = false;
    result.skipped.push(
      "packages/server: absent — per-document catalogs need a server to issue a document",
    );
  }

  const jobs = planI18nFiles(answers, { pkgScope, appName });
  const planned = serverOnly ? jobs.filter((j) => isServerHalf(j.dest)) : jobs;

  if (opts.dryRun) {
    result.ok = true;
    result.manualResidue.push(
      `Dry run: would write ${planned.length} files (${answers.sourceLocale} → ${answers.targetLocales.join(", ")}), edit up to 9 existing files, and write docs/i18n.md.`,
    );
    if (!quiet) {
      console.log(chalk.bold("\ni18n dry run."));
      console.log(`  Languages:  ${answers.sourceLocale} → ${answers.targetLocales.join(", ")}`);
      for (const job of planned) console.log(chalk.dim(`  + ${job.dest}`));
    }
    return result;
  }

  const files: WriteI18nResult = serverOnly
    ? writeSubset(opts.projectDir, planned)
    : writeI18nFiles({ projectDir: opts.projectDir, config: answers, pkgScope, appName });
  result.written.push(...files.written);
  result.unchanged.push(...files.unchanged);

  const rewrites = applyI18nRewrites({
    projectDir: opts.projectDir,
    config: answers,
    pkgScope,
    clientSurface: hasClient,
    serverSurface: hasServer,
  });
  result.rewritten.push(...rewrites.rewritten);
  result.unchanged.push(...rewrites.unchanged);
  result.skipped.push(...rewrites.skipped);
  result.manualResidue.push(...rewrites.manualResidue);

  // Same template the writer already rendered, so these come back
  // unchanged in a full run. Called anyway: a server-only run writes a
  // subset, and the audit should still name the translator's files.
  //
  // A server-only project gets them beside the catalogs that exist. The
  // planned path is under `packages/client`, and writing there would
  // conjure a client package this project does not have — a stray
  // directory the surface prune deliberately removed.
  const glossaries = writeI18nGlossaries({
    projectDir: opts.projectDir,
    config: answers,
    pkgScope,
    appName,
    destDir: serverOnly ? "packages/server/src/i18n" : undefined,
  });
  recordOnce(result, glossaries);

  const docs = writeI18nProjectDocs({
    projectDir: opts.projectDir,
    config: answers,
    pkgScope,
    appName,
  });
  if (docs.status === "written") result.written.push(docs.relPath);
  else result.unchanged.push(docs.relPath);

  result.manualResidue.push(...residueFor(opts.projectDir, answers, hasClient, hasServer));
  result.ok = true;

  if (!quiet) printReport(result, { appName, docsRel: docs.relPath });
  return result;
}

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

// ---------------------------------------------------------------------------
// Detection.
// ---------------------------------------------------------------------------

/** The workspace scope, INCLUDING the leading `@`, as the templates
 *  write it (`__HATCHKIT_PKG_SCOPE__/shared`). Read from a package name
 *  rather than from the directory name, because that is the string the
 *  generated imports have to match. */
function detectPkgScope(projectDir: string): { scope: string; guessed: boolean } {
  for (const rel of [CLIENT_PKG_REL, SERVER_PKG_REL, SHARED_PKG_REL]) {
    const name = readPackageName(join(projectDir, rel));
    const scope = name?.match(/^(@[^/]+)\//)?.[1];
    if (scope) return { scope, guessed: false };
  }
  const root = readPackageName(join(projectDir, "package.json"));
  const base = root?.replace(/^@/, "").split("/")[0];
  return { scope: `@${base && base.length > 0 ? base : "app"}`, guessed: true };
}

/** The product's display name — it ends up in the glossary header, the
 *  docs and the marketing catalog's page title. The layout's metadata
 *  title is the display name a person chose, so it wins; the starter's
 *  own placeholder does not. */
function detectAppName(projectDir: string): string {
  const fromLayout = readLayoutTitle(projectDir);
  if (fromLayout && fromLayout !== PLACEHOLDER_APP_NAME) return fromLayout;
  const fromManifest = readManifest(projectDir)?.name;
  if (fromManifest) return fromManifest;
  return fromLayout ?? PLACEHOLDER_APP_NAME;
}

function readLayoutTitle(projectDir: string): string | undefined {
  const raw = readIfPresent(join(projectDir, LAYOUT_REL));
  if (raw === null) return undefined;
  const nested = raw.match(/title:\s*\{[^}]*default:\s*"([^"]+)"/);
  if (nested) return nested[1];
  return raw.match(/title:\s*"([^"]+)"/)?.[1];
}

function readPackageName(path: string): string | undefined {
  const raw = readIfPresent(path);
  if (raw === null) return undefined;
  try {
    const pkg = JSON.parse(raw) as { name?: string };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function readIfPresent(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writing a subset (server-only project).
// ---------------------------------------------------------------------------

function isServerHalf(dest: string): boolean {
  // The shared half comes along: the server's resolver and its byte-stable
  // formatters live in packages/shared and the server imports them.
  return dest.startsWith("packages/server/") || dest.startsWith("packages/shared/");
}

/** writer.ts writes the whole plan, which is the right behaviour for a
 *  project that has every package. A server-only project needs a subset,
 *  so the subset is written here rather than by giving the writer a
 *  filter nothing else would use. */
function writeSubset(projectDir: string, jobs: ReturnType<typeof planI18nFiles>): WriteI18nResult {
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const job of jobs) {
    const rendered = renderI18nTemplate(job.template, job.tokens);
    const dest = join(projectDir, job.dest);
    if (existsSync(dest) && readFileSync(dest, "utf-8") === rendered) {
      unchanged.push(job.dest);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, rendered, "utf-8");
    written.push(job.dest);
  }
  return { written, unchanged };
}

// ---------------------------------------------------------------------------
// Manual residue — the steps hatchkit will not take on the user's behalf.
// ---------------------------------------------------------------------------

function residueFor(
  projectDir: string,
  config: I18nConfig,
  hasClient: boolean,
  hasServer: boolean,
): string[] {
  const notes: string[] = [];
  const primary = config.targetLocales[0];

  notes.push("Run `pnpm install` — the feature added `use-intl` to the workspace.");

  if (hasClient) {
    notes.push(
      `Translate \`packages/client/src/i18n/messages/<locale>/*.ts\`. They are SEEDED, not translated: hatchkit ships one worked German example, so a target that is not German contains German text with the right keys and the right ICU arguments. Start from \`i18n/GLOSSARY.<locale>.md\`.`,
    );
    notes.push(
      "Mount `<LocaleSync />` inside the authenticated part of the tree (beside the theme sync, not in the root layout): it must never run during hydration of a public page.",
    );
    notes.push(
      "Put `<LanguagePicker />` on the settings screen. It reads `app.settings.language`, `app.settings.languageSystem` and `app.settings.languageHint` from the catalogs.",
    );
  }

  if (config.publicPages) {
    notes.push(
      "Swap `packages/client/src/app/page.i18n.tsx.example` in over `app/page.tsx` when you are ready. Hatchkit will not overwrite your landing page; the example is the one-line re-export the per-language pages already use.",
    );
    notes.push(
      "Set `NEXT_PUBLIC_SITE_URL` at build time. Without it the canonical, `hreflang` and `og:url` addresses stay relative and the alternates point at Next's localhost default.",
    );
  }

  if (config.targetLocales.length > 1) {
    notes.push(
      `Wire the extra languages into \`packages/client/src/i18n/messages/index.ts\` at the \`hatchkit:locale-imports\` marker (hatchkit wired \`${config.sourceLocale}\` and \`${primary}\`). The record is total, so \`tsc\` names every language that is still missing.`,
    );
    if (config.serverCatalogs) {
      notes.push(
        "Wire the extra languages into `packages/server/src/i18n/index.ts` at the `hatchkit:i18n-server-catalogs` marker. Until then an unregistered language falls back to the source language and logs a warning once.",
      );
    }
  }

  if (config.serverCatalogs && hasServer) {
    notes.push(
      "Translate `packages/server/src/i18n/messages/<locale>/*.ts`. Each value is the source string behind a local `todo()` wrapper, so `grep -c 'todo('` counts what is left.",
    );
  }

  // Client-only: the pseudo-locale is a layout tool, and a project with
  // no client graph has nowhere to put the import and no layout to check.
  if (config.pseudoLocale && hasClient) {
    notes.push(
      'Add `import "@/i18n/pseudo";` once anywhere in the client graph for development builds. The module self-registers; with nothing registered `?locale=pseudo` renders the source language.',
    );
  }

  // A pre-existing bare toLocale* call the generated format.test.ts has
  // to exempt to stay green. Named so the exemption is a debt with an
  // owner rather than a permanent hole in the grep.
  const viewer = "packages/client/src/components/ml/result-viewer-3d.tsx";
  if (hasClient && existsSync(join(projectDir, viewer))) {
    notes.push(
      `Route the \`toLocaleString()\` call in ${viewer} through \`useFormat()\` and delete its exemption from \`i18n/format.test.ts\`.`,
    );
  }

  notes.push(
    "Run the generated tests before the first translation lands: they are the feature's contract, not a formality.",
  );

  return notes;
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function printReport(result: I18nApplyResult, ctx: { appName: string; docsRel: string }): void {
  const { config } = result;
  console.log(chalk.bold("\ni18n setup complete."));
  console.log(`  App name:       ${ctx.appName}`);
  console.log(`  Languages:      ${config.sourceLocale} → ${config.targetLocales.join(", ")}`);
  console.log(`  Namespaces:     ${config.namespaces.join(", ")}`);
  console.log(
    `  Surfaces:       core${config.publicPages ? ", public pages" : ""}${config.serverCatalogs ? ", server catalogs" : ""}${config.pseudoLocale ? ", pseudo-locale" : ""}`,
  );
  console.log(`  Written:        ${result.written.length} files`);
  if (result.unchanged.length > 0) {
    console.log(chalk.dim(`  Unchanged:      ${result.unchanged.length} files`));
  }
  if (result.rewritten.length > 0) {
    console.log(`  Rewrote:        ${result.rewritten.join(", ")}`);
  }
  for (const skip of result.skipped) console.log(chalk.yellow(`  Skipped ${skip}`));
  console.log(chalk.dim(`  Docs:           ${ctx.docsRel}`));
  // Read back off the audit rather than re-deriving the planned path: a
  // server-only run puts the glossaries beside the server catalogs, and a
  // report that names a file the run did not write sends the translator
  // looking in a directory that is not there.
  for (const rel of [...result.written, ...result.unchanged].filter((p) =>
    p.includes("GLOSSARY."),
  )) {
    console.log(chalk.dim(`  Glossary:       ${rel}`));
  }
  if (result.manualResidue.length > 0) {
    console.log(chalk.bold("\n  Still yours to do:"));
    for (const note of result.manualResidue) console.log(chalk.yellow(`  · ${note}`));
  }
  console.log("");
}

/** Fold a subset write into the audit without listing a path twice — the
 *  glossary writer runs after the file writer and covers the same paths. */
function recordOnce(result: I18nApplyResult, files: WriteI18nResult): void {
  for (const path of files.written) {
    if (!result.written.includes(path)) result.written.push(path);
  }
  for (const path of files.unchanged) {
    if (!result.written.includes(path) && !result.unchanged.includes(path)) {
      result.unchanged.push(path);
    }
  }
}

function fail(result: I18nApplyResult, quiet: boolean, message: string): I18nApplyResult {
  result.ok = false;
  result.manualResidue.push(message);
  if (!quiet) console.log(chalk.yellow(`\n  i18n: ${message}\n`));
  return result;
}
