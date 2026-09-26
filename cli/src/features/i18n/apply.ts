/*
 * cli/src/features/i18n/apply.ts — everything the i18n feature does once
 * its config is settled.
 *
 * Split out of `./index.ts` so the feature's two entry points can share
 * it without sharing a prompt library:
 *
 *   · `./index.ts` — the interactive front door (`runI18nSetup`). It
 *     imports `@inquirer/prompts` in order to ask its questions.
 *   · `./definition.ts` — the registration against `../contract.ts`,
 *     whose `apply` reads the answers back off the manifest instead of
 *     asking. `../all.ts` imports every definition EAGERLY, so that the
 *     registry can answer questions about features nobody selected, and
 *     a definition therefore drags in whatever it reaches every time
 *     hatchkit closes a feature selection over its prerequisites.
 *
 * That second point is why this file exists rather than `definition.ts`
 * importing `index.ts`: the definition would then reach a prompt library
 * in order to state a feature's title. `auth-account-security` avoids the
 * same thing by having its questions asked by the caller; i18n owns its
 * question set, so the split has to happen here instead.
 *
 * Nothing here prompts. Every write goes through the `FeatureLedger` the
 * caller supplies, so a dry run is a dry ledger and no function below
 * checks a flag — see the header of `../contract.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";
import { readManifest } from "../../scaffold/manifest.js";
import type { FeatureLedger } from "../contract.js";
import { renderFeatureTemplate } from "../templates.js";
import { writeI18nProjectDocs } from "./docs.js";
import { writeI18nGlossaries } from "./glossary.js";
import { planI18nFiles } from "./plan.js";
import { applyI18nRewrites } from "./rewriter.js";
import type { I18nApplyResult, I18nConfig } from "./types.js";
import { type WriteI18nResult, writeI18nFiles } from "./writer.js";

/** Paths the feature probes to decide which halves a project has. Shared
 *  with `./index.ts`, which checks the same two before asking anything. */
export const CLIENT_PKG_REL = "packages/client/package.json";
export const SERVER_PKG_REL = "packages/server/package.json";
const SHARED_PKG_REL = "packages/shared/package.json";
const LAYOUT_REL = "packages/client/src/app/layout.tsx";
/** The starter's placeholder title. Only reachable as a last resort now —
 *  see the note on `identifiers` in {@link applyI18nConfig}. */
const PLACEHOLDER_APP_NAME = "My App";

/**
 * Everything the feature does once its config is settled.
 *
 * Both of the feature's entry points come through here — `runI18nSetup` in
 * `./index.ts` after it has asked its questions, and the registered
 * feature's `apply` in `./definition.ts` after it has read the answers off
 * the manifest. That is the point: a `create` and a later re-apply that
 * wrote different projects is the failure this arrangement prevents, and
 * it is a failure that hides well — each entry point is self-consistent,
 * so only comparing them catches it.
 *
 * Prompts nothing, and prints only the closing report. Every write goes
 * through `ledger`, so a dry run is a dry ledger and nothing below checks
 * a flag.
 */
export function applyI18nConfig(opts: {
  projectDir: string;
  /** Adjusted in place when the project is missing a half — the caller
   *  reads the settled answer back off `result.config`. */
  config: I18nConfig;
  ledger: FeatureLedger;
  /**
   * The project's frozen identifier set. `identifiers.productName` is the
   * human-facing app name every catalog, glossary and doc renders —
   * "Welcome to <name>" and the marketing titles.
   *
   * Passed in rather than detected, because a feature does not derive a
   * name (docs/feature-authoring.md, "Never derive a name"). The local
   * {@link detectAppName} used to do exactly that, and the two call sites
   * disagreed: at `create` the manifest is written AFTER this runs, so
   * detection fell through to the starter's placeholder title and baked
   * "Welcome to My App" into the catalogs; a later re-apply found the
   * manifest and produced the raw slug instead. Neither was the product
   * name, and the re-apply silently rewrote nine generated files.
   *
   * Detection survives only as the fallback for a project with no
   * manifest at all — `hatchkit add i18n` inside a repo hatchkit never
   * scaffolded.
   */
  identifiers?: ProjectIdentifiers;
  /** Suppress the closing report. True under `create`, whose spinner owns
   *  the terminal. */
  quiet?: boolean;
}): I18nApplyResult {
  const { projectDir, config: answers, ledger } = opts;
  const quiet = opts.quiet === true;
  const result: I18nApplyResult = {
    ok: false,
    written: [],
    unchanged: [],
    rewritten: [],
    skipped: [],
    manualResidue: [],
    config: answers,
  };

  const hasClient = existsSync(join(projectDir, CLIENT_PKG_REL));
  const hasServer = existsSync(join(projectDir, SERVER_PKG_REL));

  // The SCOPE stays detected: it has to match the workspace package names
  // actually on disk, and `create` does not rename them — a project called
  // "probe-app" still ships `@starter/client`, so `identifiers.npmScope`
  // would render imports that resolve nowhere. `cli/test-i18n-seams.ts`
  // checks every generated import against the real package names.
  const { scope: pkgScope, guessed } = detectPkgScope(projectDir);
  const appName = opts.identifiers?.productName ?? detectAppName(projectDir);
  if (guessed) {
    result.manualResidue.push(
      `Hatchkit could not read a workspace scope from the package names and used \`${pkgScope}\`. Check the \`${pkgScope}/shared\` imports in the generated files.`,
    );
  }

  const surfaces = settleI18nSurfaces(projectDir, answers);
  result.skipped.push(...surfaces.notes);
  const { serverOnly } = surfaces;

  const planned = narrowI18nJobs(planI18nFiles(answers, { pkgScope, appName }), serverOnly);

  // No `if (dryRun)` branch: a dry ledger records `would-write` for each
  // of these and touches nothing, so the run below IS the dry run. The
  // early return this replaced could only ever report the template
  // writes, and re-derived their count by hand; the ledger reports the
  // existing-file edits and docs/i18n.md as well.
  const files: WriteI18nResult = serverOnly
    ? writeSubset(ledger, planned)
    : writeI18nFiles({ projectDir, config: answers, pkgScope, appName, ledger });
  result.written.push(...files.written);
  result.unchanged.push(...files.unchanged);

  const rewrites = applyI18nRewrites({
    projectDir,
    config: answers,
    pkgScope,
    clientSurface: hasClient,
    serverSurface: hasServer,
    ledger,
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
    projectDir,
    config: answers,
    pkgScope,
    appName,
    destDir: serverOnly ? "packages/server/src/i18n" : undefined,
    ledger,
  });
  recordOnce(result, glossaries);

  const docs = writeI18nProjectDocs({
    projectDir,
    config: answers,
    pkgScope,
    appName,
    ledger,
  });
  if (docs.status === "written") result.written.push(docs.relPath);
  else result.unchanged.push(docs.relPath);

  result.manualResidue.push(...residueFor(projectDir, answers, hasClient, hasServer));
  result.ok = true;

  if (!quiet) printReport(result, { appName, docsRel: docs.relPath });
  return result;
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

/**
 * Switch off the gates whose surface this project does not have, and say
 * which. Mutates `config` — the caller reads the settled answer back and
 * records THAT, so a later re-apply plans the same files.
 *
 * Shared with the feature's `plannedFiles` in `./definition.ts`: a dry run
 * that listed the client catalogs for a project with no client would be
 * describing files the apply then refuses to write.
 */
export function settleI18nSurfaces(
  projectDir: string,
  config: I18nConfig,
): { serverOnly: boolean; hasClient: boolean; hasServer: boolean; notes: string[] } {
  const hasClient = existsSync(join(projectDir, CLIENT_PKG_REL));
  const hasServer = existsSync(join(projectDir, SERVER_PKG_REL));
  const notes: string[] = [];

  // The client half is where the store, the gate and the public pages
  // live. Without it, only the server catalogs and the shared helpers
  // they import make sense — written, and said out loud.
  const serverOnly = !hasClient;
  if (serverOnly) {
    config.publicPages = false;
    notes.push("packages/client: absent — wrote the server catalogs and the shared helpers only");
  }
  if (!hasServer && config.serverCatalogs) {
    config.serverCatalogs = false;
    notes.push("packages/server: absent — per-document catalogs need a server to issue a document");
  }
  return { serverOnly, hasClient, hasServer, notes };
}

/** The jobs a run will actually write, given what {@link
 *  settleI18nSurfaces} found. The other half of the same seam. */
export function narrowI18nJobs<T extends { dest: string }>(
  jobs: readonly T[],
  serverOnly: boolean,
): T[] {
  return serverOnly ? jobs.filter((job) => isServerHalf(job.dest)) : [...jobs];
}

function isServerHalf(dest: string): boolean {
  // The shared half comes along: the server's resolver and its byte-stable
  // formatters live in packages/shared and the server imports them.
  return dest.startsWith("packages/server/") || dest.startsWith("packages/shared/");
}

/** writer.ts writes the whole plan, which is the right behaviour for a
 *  project that has every package. A server-only project needs a subset,
 *  so the subset is written here rather than by giving the writer a
 *  filter nothing else would use. */
function writeSubset(
  ledger: FeatureLedger,
  jobs: ReturnType<typeof planI18nFiles>,
): WriteI18nResult {
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const job of jobs) {
    const rendered = renderFeatureTemplate("i18n", job.template, job.tokens);
    const action = ledger.writeIfChanged(job.dest, rendered);
    if (action === "written" || action === "would-write") written.push(job.dest);
    else unchanged.push(job.dest);
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
