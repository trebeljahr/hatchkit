/*
 * cli/src/features/i18n/rewriter.ts — The surgical half of the i18n
 * generator: idempotent edits to files the STARTER already ships.
 *
 * writer.ts owns files hatchkit creates and may therefore overwrite
 * wholesale. This module owns files the USER also edits, so every rule
 * here exists to avoid breaking them:
 *
 *   · Each transform anchors on a distinctive string and reports
 *     "absent" when it cannot find it. Nothing here throws and nothing
 *     writes a half-applied edit, so a hand-rewritten layout degrades to
 *     a documented manual step instead of a corrupted file.
 *   · Each transform leaves a `hatchkit:i18n` sentinel behind, so a
 *     second run reports "unchanged". `hatchkit add i18n` after a
 *     hatchkit upgrade has to be reviewable as an empty diff.
 *   · The layout transform is all-or-nothing. Its three edits are one
 *     mechanism — the script resolves the language, the gate hides the
 *     app while the answer is not the served one, `<LocaleRoot>` lifts
 *     the gate — and a layout we only half recognise is left alone.
 *
 * Two edits here are additive to the contract's list and are called out
 * where they are defined: `rewriteServerPackageJson` (the generated
 * server imports `use-intl/core` too) and `rewriteSharedPackageJson`
 * (the generated shared tests are vitest suites in a package that has no
 * test runner, and `tsc` compiles src/ wholesale — without the dev
 * dependency the package stops typechecking).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FeatureLedger } from "../contract.js";
import type { I18nConfig } from "./types.js";

/** Left behind by every edit below, and the reason a second run is a
 *  no-op. Grep-able in a generated project: it answers "did hatchkit
 *  touch this file, or did I?". */
const I18N_MARKER = "hatchkit:i18n";

/** The attribute globals.css hides and `<LocaleRoot>` releases. Kept in
 *  lockstep with `GATE_SCOPE_ATTR` in the generated store.ts — the CSS
 *  rule, the layout wrapper and the store all name the same string. */
const GATE_SCOPE_ATTR = "data-locale-gate";
/** Set on `<html>` by the pre-paint script while the rendered language
 *  is not the one in the served markup. */
const GATE_ATTR = "data-locale-pending";
/** `<FixedLocale>`'s opt-out: a prerendered per-language page is already
 *  in its own language and has nothing to wait for. */
const GATE_EXEMPT_ATTR = "data-locale-fixed";

/** The version the templates were written against — `createTranslator`
 *  and the `_Translator` type both come from `use-intl/core`. */
const USE_INTL_VERSION = "^4.14.4";
/** Only used when the client does not pin a version of its own. */
const FALLBACK_VITEST_VERSION = "^4.1.6";

export type RewriteStatus = "rewritten" | "unchanged" | "absent";

export interface RewriteInput {
  projectDir: string;
  config: I18nConfig;
  pkgScope: string;
  /** False for a project with no `packages/client`. Its client-side
   *  files are then not missing, they are out of scope — and telling
   *  somebody to hand-wire a layout they do not have is worse than
   *  saying nothing. Defaults to true. */
  clientSurface?: boolean;
  /** False for a project with no `packages/server`, same reasoning. */
  serverSurface?: boolean;
  /**
   * Where every edit goes. Supplied by the feature's `apply` so the
   * whole run reports one plan and `--dry-run` describes these edits
   * without performing them — the ledger is the only place the dry-run
   * flag is checked (see `../contract.ts`).
   *
   * Omitted by the tests and by the standalone generator paths, which
   * get a fresh real ledger over `projectDir`.
   */
  ledger?: FeatureLedger;
}

export interface RewriteOutcome {
  rewritten: string[];
  unchanged: string[];
  /** "<path>: <reason>" — absent, or a shape this module declines to edit. */
  skipped: string[];
  manualResidue: string[];
}

const LAYOUT_REL = "packages/client/src/app/layout.tsx";
const GLOBALS_CSS_REL = "packages/client/src/styles/globals.css";
const SHARED_BARREL_REL = "packages/shared/src/index.ts";
const SHARED_SCHEMAS_REL = "packages/shared/src/schemas.ts";
const SHARED_PKG_REL = "packages/shared/package.json";
const PROFILE_MODEL_REL = "packages/server/src/models/Profile.ts";
const PROFILE_ROUTER_REL = "packages/server/src/trpc/routers/profile.ts";
const CLIENT_PKG_REL = "packages/client/package.json";
const SERVER_PKG_REL = "packages/server/package.json";

/** The stored preference, as both the zod enum and the mongoose enum
 *  list it: the word "system" plus every language the project ships.
 *  "system" is a device question, so the server stores it and never
 *  resolves it. */
export function localePreferenceValues(config: I18nConfig): string[] {
  return ["system", config.sourceLocale, ...config.targetLocales];
}

function tsLiteralList(values: string[]): string {
  return `[${values.map((v) => `"${v}"`).join(", ")}]`;
}

function ledgerFor(input: RewriteInput): FeatureLedger {
  return input.ledger ?? new FeatureLedger(input.projectDir, false);
}

/**
 * Read one project file, transform it, and commit the result through the
 * ledger.
 *
 * `transform` returns one of three things, and the difference is the
 * whole degradation contract of this module:
 *
 *   · the SAME string — the edit is already there (ours or the user's
 *     own). Reported `unchanged`.
 *   · a DIFFERENT string — committed. Reported `rewritten`.
 *   · `null` — a shape this module declines to edit. Reported `absent`,
 *     and nothing is recorded in the ledger: the file is not missing,
 *     and recording it as `unchanged` would hide the manual step the
 *     caller owes the user. `applyI18nRewrites` turns it into a skip
 *     plus a residue note.
 *
 * The closure handed to `ledger.edit` is constant, so it is a fixed
 * point by construction — the re-run safety lives in `transform`'s own
 * sentinel check, one line up.
 */
function editThrough(
  input: RewriteInput,
  rel: string,
  transform: (before: string) => string | null,
): RewriteStatus {
  const ledger = ledgerFor(input);
  const before = ledger.read(rel);
  if (before === undefined) return "absent";
  const after = transform(before);
  if (after === null) return "absent";
  return ledger.edit(rel, () => after) === "unchanged" ? "unchanged" : "rewritten";
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
// app/layout.tsx — the one that matters.
// ---------------------------------------------------------------------------

/** Three edits, applied together or not at all:
 *
 *   1. The pre-paint script goes in FIRST inside `<head>`, ahead of the
 *      analytics tags. Anything above it paints before the language is
 *      known, and the point of the script is that nothing does.
 *   2. `{children}` is wrapped in `<LocaleRoot>`, which activates the
 *      store after hydration and releases the gate in the same flush.
 *   3. The gate attribute goes on a wrapper INSIDE `<body>` — never on
 *      `<body>` itself. A script that mutates `<body>` before hydration
 *      makes its attributes disagree with the served HTML, and hiding
 *      `<body>` hides the gate-exempt prerendered pages with it.
 *
 *  `<html lang>` is deliberately untouched: the served markup IS the
 *  source locale, so that is what the attribute must say until the
 *  script rewrites it before paint. Changing it here would make every
 *  prerendered file claim a language its text is not in. */
export function rewriteRootLayout(input: RewriteInput): RewriteStatus {
  return editThrough(input, LAYOUT_REL, (before) => {
    // Either sentinel means the wiring is there, ours or the user's.
    if (before.includes("LOCALE_SCRIPT") || before.includes(GATE_SCOPE_ATTR)) return before;

    const withScript = injectPrePaintScript(before);
    if (withScript === null) return null;
    const withGate = wrapChildrenInGate(withScript);
    if (withGate === null) return null;
    return addLayoutImports(withGate);
  });
}

function injectPrePaintScript(content: string): string | null {
  // A `<head>` on its own line is what every Next.js layout in the wild
  // looks like, and matching only that shape is what lets us bail
  // instead of guessing where a one-line `<head>…</head>` ends.
  const match = content.match(/^([ \t]*)<head>[ \t]*$/m);
  if (!match || match.index === undefined) return null;
  const indent = match[1];
  const inner = `${indent}  `;
  const block = [
    `${inner}{/* ${I18N_MARKER} — resolve the reader's language before the first`,
    `${inner}    paint and mark the gate. FIRST in <head>: a tag above this one`,
    `${inner}    can paint before the answer is known. */}`,
    `${inner}<script dangerouslySetInnerHTML={{ __html: LOCALE_SCRIPT }} />`,
  ].join("\n");
  const at = match.index + match[0].length;
  return `${content.slice(0, at)}\n${block}${content.slice(at)}`;
}

function wrapChildrenInGate(content: string): string | null {
  // Only the JSX half can contain the children slot; the props
  // destructure above it mentions `children` too.
  const returnAt = content.indexOf("return (");
  if (returnAt < 0) return null;
  const jsx = content.slice(returnAt);
  if (jsx.split("{children}").length - 1 !== 1) return null;
  if (!/<body[\s>]/.test(jsx)) return null;

  const at = returnAt + jsx.indexOf("{children}");
  const lineStart = content.lastIndexOf("\n", at) + 1;
  const lineEndRaw = content.indexOf("\n", at);
  const lineEnd = lineEndRaw < 0 ? content.length : lineEndRaw;
  const line = content.slice(lineStart, lineEnd);
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const trimmed = line.trim();
  const slotAt = trimmed.indexOf("{children}");
  const head = trimmed.slice(0, slotAt);
  const tail = trimmed.slice(slotAt + "{children}".length);

  // `{children}` usually shares its line with the provider that wraps
  // it (`<AuthProvider>{children}</AuthProvider>`), so the line is split
  // rather than replaced — the wrapper needs its own lines to stay
  // readable, and the surrounding tags must keep their nesting.
  const pad = head.length > 0 ? `${indent}  ` : indent;
  const lines: string[] = [];
  if (head.length > 0) lines.push(`${indent}${head}`);
  lines.push(
    `${pad}{/* ${I18N_MARKER} — the first-paint gate. globals.css hides this`,
    `${pad}    subtree while <html> carries ${GATE_ATTR}, and <LocaleRoot>`,
    `${pad}    clears the mark in the same flush as the translated render.`,
    `${pad}    It has to be an element INSIDE <body>: hiding <body> would`,
    `${pad}    hide the prerendered per-language pages too. */}`,
    `${pad}<div ${GATE_SCOPE_ATTR}>`,
    `${pad}  <LocaleRoot>{children}</LocaleRoot>`,
    `${pad}</div>`,
  );
  if (tail.length > 0) lines.push(`${indent}${tail}`);

  return `${content.slice(0, lineStart)}${lines.join("\n")}${content.slice(lineEnd)}`;
}

function addLayoutImports(content: string): string | null {
  const imports = [
    `import { LocaleRoot } from "@/i18n/locale-root";`,
    `import { LOCALE_SCRIPT } from "@/app/pre-paint";`,
  ].join("\n");

  // Ahead of the stylesheet side-effect import when there is one: CSS
  // import order decides cascade order, and the layout's stylesheet
  // should stay the last thing the module pulls in.
  const css = content.match(/^import "[^"]*\.css";[ \t]*$/m);
  if (css && css.index !== undefined) {
    return `${content.slice(0, css.index)}${imports}\n${content.slice(css.index)}`;
  }

  const lines = content.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("import ")) lastImport = i;
  }
  if (lastImport < 0) return null;
  lines.splice(lastImport + 1, 0, imports);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// globals.css — the gate rule itself.
// ---------------------------------------------------------------------------

export function rewriteGlobalsCss(input: RewriteInput): RewriteStatus {
  return editThrough(input, GLOBALS_CSS_REL, (before) => {
    if (before.includes(I18N_MARKER) || before.includes(GATE_SCOPE_ATTR)) return before;

    const block = [
      `/* ${I18N_MARKER} — first-paint locale gate.`,
      ` *`,
      ` * The pre-paint script sets [${GATE_ATTR}] on <html> when the reader's`,
      ` * language is not the one the served markup is in. Everything inside the`,
      ` * [${GATE_SCOPE_ATTR}] wrapper in app/layout.tsx stays invisible until`,
      ` * <LocaleRoot> clears the mark, so nobody sees a frame of the source`,
      ` * language. A failsafe in the script lifts it regardless: a page in the`,
      ` * wrong language beats an invisible one.`,
      ` *`,
      ` * visibility, not display: the subtree keeps its box, so releasing the`,
      ` * gate costs no reflow. Unlayered on purpose — a layered rule loses to`,
      ` * any utility class on the same element, and this one must win.`,
      ` *`,
      ` * A prerendered per-language page opts back in through <FixedLocale>'s`,
      ` * [${GATE_EXEMPT_ATTR}]: its markup is already in its own language.`,
      ` */`,
      `[${GATE_ATTR}] [${GATE_SCOPE_ATTR}] {`,
      `  visibility: hidden;`,
      `}`,
      ``,
      `[${GATE_EXEMPT_ATTR}] {`,
      `  visibility: visible;`,
      `}`,
    ].join("\n");

    return `${before.trimEnd()}\n\n${block}\n`;
  });
}

// ---------------------------------------------------------------------------
// packages/shared — the barrel and the test runner the new tests need.
// ---------------------------------------------------------------------------

/** `locale.ts` is THE resolver and `format-duration.ts` the byte-stable
 *  formatter; both are imported as `@<scope>/shared`, which is the
 *  barrel. Missing exports here are the whole feature failing to
 *  resolve, not a cosmetic omission. */
export function rewriteSharedBarrel(input: RewriteInput): RewriteStatus {
  return editThrough(input, SHARED_BARREL_REL, (before) => {
    if (before.includes(`"./locale.js"`)) return before;

    const lines = before.split("\n");
    let lastExport = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^export \* from "\.\//.test(lines[i])) lastExport = i;
    }
    if (lastExport < 0) return null;
    lines.splice(
      lastExport + 1,
      0,
      `export * from "./locale.js";`,
      `export * from "./format-duration.js";`,
    );
    return lines.join("\n");
  });
}

/** Additive to the contract's rewriter list, and not optional: the
 *  generated `locale.test.ts` / `format-duration.test.ts` are vitest
 *  suites, `packages/shared` ships no test runner, and its tsconfig
 *  compiles all of src/ — so without the dev dependency the package
 *  stops typechecking the moment the feature lands. */
export function rewriteSharedPackageJson(input: RewriteInput): RewriteStatus {
  // Deliberately NOT `ledger.mergePackageJson`: that primitive reports a
  // differing value as a conflict, and here a `test` script the project
  // already chose is simply none of this feature's business — only its
  // ABSENCE is something to fix. Same for the vitest pin, whose version
  // is read off the client so pnpm resolves one copy for the workspace.
  return editThrough(input, SHARED_PKG_REL, (before) => {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(before) as Record<string, unknown>;
    } catch {
      return null;
    }

    const scripts = asRecord(pkg.scripts) ?? {};
    const devDeps = asRecord(pkg.devDependencies) ?? {};
    const hasRunner = typeof devDeps.vitest === "string";
    const hasScript = typeof scripts.test === "string";
    if (hasRunner && hasScript) return before;

    if (!hasScript) scripts.test = "vitest run";
    pkg.scripts = scripts;
    pkg.devDependencies = hasRunner
      ? devDeps
      : withEntry(
          devDeps,
          "vitest",
          readClientVitestVersion(input.projectDir) ?? FALLBACK_VITEST_VERSION,
        );
    return `${JSON.stringify(pkg, null, 2)}\n`;
  });
}

/** Same version the client already resolved, so pnpm installs one copy
 *  of vitest for the workspace rather than two. */
function readClientVitestVersion(projectDir: string): string | undefined {
  const raw = readIfPresent(join(projectDir, CLIENT_PKG_REL));
  if (raw === null) return undefined;
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const dev = asRecord(pkg.devDependencies);
    const version = dev?.vitest;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The synced preference: schema, model, router. One value, three files.
// ---------------------------------------------------------------------------

/** `preferences.locale` is stored beside `theme` because it is the same
 *  kind of setting: an account-level answer the device interprets. The
 *  zod enum is the outer edge — an unknown language never reaches the
 *  database. */
export function rewriteProfileSchema(input: RewriteInput): RewriteStatus {
  return editThrough(input, SHARED_SCHEMAS_REL, (before) => {
    if (before.includes(I18N_MARKER) || /locale: z\.enum\(/.test(before)) return before;

    // Scoped to updateProfileSchema: `notifications` is a common enough
    // field name that a file-wide match could land in another schema.
    const schemaAt = before.indexOf("updateProfileSchema");
    if (schemaAt < 0) return null;
    const tail = before.slice(schemaAt);
    const anchor = tail.match(/\n([ \t]*)notifications: z\.boolean\(\)\.optional\(\),/);
    if (!anchor || anchor.index === undefined) return null;

    const indent = anchor[1];
    const values = tsLiteralList(localePreferenceValues(input.config));
    const block = [
      ``,
      `${indent}// ${I18N_MARKER} — the synced language preference. "system" means`,
      `${indent}// "follow the device", which only a device can answer: the server`,
      `${indent}// stores the word and never resolves it to a language.`,
      `${indent}locale: z.enum(${values}).optional(),`,
    ].join("\n");

    const at = schemaAt + anchor.index + anchor[0].length;
    return `${before.slice(0, at)}${block}${before.slice(at)}`;
  });
}

/** The mongoose half. `default: "system"` on purpose: a profile row
 *  written before the feature landed should follow the reader's device,
 *  which is what "system" says. (A DOCUMENT snapshot is the opposite
 *  case and deliberately has no default — see server/i18n/resolve.ts.) */
export function rewriteProfileModel(input: RewriteInput): RewriteStatus {
  return editThrough(input, PROFILE_MODEL_REL, (before) => {
    if (before.includes(I18N_MARKER) || before.includes("LocalePreference")) return before;

    const ifaceAnchor = before.match(/\n([ \t]*)notifications: boolean;/);
    const schemaAnchor = before.match(/\n([ \t]*)notifications: \{ type: Boolean[^\n]*\n/);
    if (!ifaceAnchor || ifaceAnchor.index === undefined) return null;
    if (!schemaAnchor || schemaAnchor.index === undefined) return null;

    const values = tsLiteralList(localePreferenceValues(input.config));
    const ifaceIndent = ifaceAnchor[1];
    const ifaceBlock = [
      ``,
      `${ifaceIndent}/** ${I18N_MARKER} — "system" = follow the reader's device. Optional`,
      `${ifaceIndent} *  because a row written before the feature landed has no value. */`,
      `${ifaceIndent}locale?: LocalePreference;`,
    ].join("\n");
    const schemaIndent = schemaAnchor[1];
    const schemaBlock = [
      `${schemaIndent}locale: {`,
      `${schemaIndent}  type: String,`,
      `${schemaIndent}  enum: ${values},`,
      `${schemaIndent}  default: "system",`,
      `${schemaIndent}},`,
      ``,
    ].join("\n");

    // Later edit first, so the earlier offset stays valid.
    const schemaAt = schemaAnchor.index + schemaAnchor[0].length;
    const ifaceAt = ifaceAnchor.index + ifaceAnchor[0].length;
    let after = `${before.slice(0, schemaAt)}${schemaBlock}${before.slice(schemaAt)}`;
    after = `${after.slice(0, ifaceAt)}${ifaceBlock}${after.slice(ifaceAt)}`;

    return addLocalePreferenceImport(after, input.pkgScope);
  });
}

/** Prefers widening the existing `@<scope>/shared` type import over
 *  adding a second one — the model already imports `ThemePreference`
 *  from there, and one import line per module is what the file's own
 *  style says. */
function addLocalePreferenceImport(content: string, pkgScope: string): string | null {
  const shared = content.match(/import type \{([^}]*)\} from ("[^"]*\/shared");/);
  if (shared && shared.index !== undefined) {
    const names = shared[1]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (!names.includes("LocalePreference")) names.push("LocalePreference");
    const replacement = `import type { ${names.join(", ")} } from ${shared[2]};`;
    return `${content.slice(0, shared.index)}${replacement}${content.slice(shared.index + shared[0].length)}`;
  }

  const lines = content.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("import ")) lastImport = i;
  }
  if (lastImport < 0) return null;
  lines.splice(lastImport + 1, 0, `import type { LocalePreference } from "${pkgScope}/shared";`);
  return lines.join("\n");
}

/** Carries the value both ways: `update` copies it onto the dotted path
 *  mongoose needs for a nested field, and the `get` upsert seeds it so a
 *  profile created by the first visit already has the key.
 *
 *  The update half is the load-bearing one — without it the picker's
 *  choice never leaves the device — so the seed is best-effort: a `get`
 *  we do not recognise costs nothing, since the mongoose default covers
 *  the same case. */
export function rewriteProfileRouter(input: RewriteInput): RewriteStatus {
  return editThrough(input, PROFILE_ROUTER_REL, (before) => {
    if (before.includes(I18N_MARKER) || before.includes(`"preferences.locale"`)) return before;

    const anchor = before.match(
      /\n([ \t]*)if \(input\.preferences\.notifications !== undefined\) \{\n[\s\S]*?\n\1\}\n/,
    );
    if (!anchor || anchor.index === undefined) return null;

    const indent = anchor[1];
    const block = [
      `${indent}// ${I18N_MARKER} — stored verbatim, including "system". Resolving it`,
      `${indent}// here would pick a language from the server's own environment.`,
      `${indent}if (input.preferences.locale !== undefined) {`,
      `${indent}  update["preferences.locale"] = input.preferences.locale;`,
      `${indent}}`,
      ``,
    ].join("\n");

    const at = anchor.index + anchor[0].length;
    return seedUpsertPreference(`${before.slice(0, at)}${block}${before.slice(at)}`);
  });
}

function seedUpsertPreference(content: string): string {
  const match = content.match(/preferences: \{([^{}]*)\}/);
  if (!match || match.index === undefined) return content;
  const inner = match[1];
  if (/\blocale\b/.test(inner)) return content;
  const trimmed = inner.trimEnd();
  const seeded = trimmed.endsWith(",")
    ? `${trimmed} locale: "system" `
    : `${trimmed}, locale: "system" `;
  const replacement = `preferences: {${seeded}}`;
  return `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
}

// ---------------------------------------------------------------------------
// package.json dependency edits.
// ---------------------------------------------------------------------------

export function rewriteClientPackageJson(input: RewriteInput): RewriteStatus {
  return addDependency(input, CLIENT_PKG_REL, "use-intl", USE_INTL_VERSION);
}

/** Additive to the contract's list: `packages/server/src/i18n/index.ts`
 *  imports `createTranslator` from `use-intl/core` as well, so a server
 *  half without the dependency does not compile. Only called when the
 *  server catalogs are part of the config. */
export function rewriteServerPackageJson(input: RewriteInput): RewriteStatus {
  return addDependency(input, SERVER_PKG_REL, "use-intl", USE_INTL_VERSION);
}

function addDependency(
  input: RewriteInput,
  rel: string,
  name: string,
  version: string,
): RewriteStatus {
  // As in rewriteSharedPackageJson: not `ledger.mergePackageJson`, because
  // a version the user pinned is theirs rather than a conflict to report.
  return editThrough(input, rel, (before) => {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(before) as Record<string, unknown>;
    } catch {
      return null;
    }
    const deps = asRecord(pkg.dependencies) ?? {};
    // A pinned version the user chose is theirs: only the absence of the
    // package is something to fix.
    if (typeof deps[name] === "string") return before;
    pkg.dependencies = withEntry(deps, name, version);
    return `${JSON.stringify(pkg, null, 2)}\n`;
  });
}

function asRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, string>;
}

/** Insert one entry at its alphabetical position and leave every
 *  existing key where it already is. Re-sorting the whole map would turn
 *  a one-line addition into a whole-file diff nobody can review. */
function withEntry(
  deps: Record<string, string>,
  name: string,
  version: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  let placed = false;
  for (const [key, value] of Object.entries(deps)) {
    if (!placed && key > name) {
      out[name] = version;
      placed = true;
    }
    out[key] = value;
  }
  if (!placed) out[name] = version;
  return out;
}

// ---------------------------------------------------------------------------
// The whole set.
// ---------------------------------------------------------------------------

interface RewriteStep {
  relPath: string;
  apply(input: RewriteInput): RewriteStatus;
  /** Recorded when the file is absent or its shape is not one we edit. */
  residue: string;
  /** Non-null when this project cannot have the file at all. Reported as
   *  skipped WITHOUT a manual step, because there is nothing to do. */
  outOfScope?(input: RewriteInput): string | null;
}

const noClient = (input: RewriteInput): string | null =>
  input.clientSurface === false ? "project has no packages/client" : null;
const noServer = (input: RewriteInput): string | null =>
  input.serverSurface === false ? "project has no packages/server" : null;

const STEPS: readonly RewriteStep[] = [
  {
    relPath: LAYOUT_REL,
    apply: rewriteRootLayout,
    outOfScope: noClient,
    residue: `Wire ${LAYOUT_REL} by hand: put \`<script dangerouslySetInnerHTML={{ __html: LOCALE_SCRIPT }} />\` first inside <head>, wrap {children} in \`<div ${GATE_SCOPE_ATTR}><LocaleRoot>…</LocaleRoot></div>\` inside <body>, and leave <html lang> on the source locale.`,
  },
  {
    relPath: GLOBALS_CSS_REL,
    apply: rewriteGlobalsCss,
    outOfScope: noClient,
    residue: `Add the gate rule to ${GLOBALS_CSS_REL} by hand: \`[${GATE_ATTR}] [${GATE_SCOPE_ATTR}] { visibility: hidden }\` plus \`[${GATE_EXEMPT_ATTR}] { visibility: visible }\`. Without it the reader sees a frame of the source language.`,
  },
  {
    relPath: SHARED_BARREL_REL,
    apply: rewriteSharedBarrel,
    residue: `Export the new shared modules from ${SHARED_BARREL_REL}: \`export * from "./locale.js";\` and \`export * from "./format-duration.js";\`.`,
  },
  {
    relPath: SHARED_PKG_REL,
    apply: rewriteSharedPackageJson,
    residue: `Add \`"test": "vitest run"\` and a \`vitest\` devDependency to ${SHARED_PKG_REL} — the generated shared tests are vitest suites and the package's tsconfig compiles all of src/.`,
  },
  {
    relPath: SHARED_SCHEMAS_REL,
    apply: rewriteProfileSchema,
    residue: `Add \`locale: z.enum(["system", …]).optional()\` inside \`updateProfileSchema.preferences\` in ${SHARED_SCHEMAS_REL}, or the language picker's choice is rejected by the API.`,
  },
  {
    relPath: PROFILE_MODEL_REL,
    apply: rewriteProfileModel,
    outOfScope: noServer,
    residue: `Add \`preferences.locale\` to ${PROFILE_MODEL_REL} (mongoose field + the IProfile interface) so the preference survives a device change.`,
  },
  {
    relPath: PROFILE_ROUTER_REL,
    apply: rewriteProfileRouter,
    outOfScope: noServer,
    residue: `Carry \`input.preferences.locale\` through to \`update["preferences.locale"]\` in ${PROFILE_ROUTER_REL}; without it <LocaleSync> writes a value the server drops.`,
  },
  {
    relPath: CLIENT_PKG_REL,
    apply: rewriteClientPackageJson,
    outOfScope: noClient,
    residue: `Add \`use-intl\` to the dependencies in ${CLIENT_PKG_REL} and re-run \`pnpm install\`.`,
  },
  {
    relPath: SERVER_PKG_REL,
    apply: rewriteServerPackageJson,
    outOfScope: (input) =>
      noServer(input) ??
      (input.config.serverCatalogs ? null : "server catalogs are not part of this configuration"),
    residue: `Add \`use-intl\` to the dependencies in ${SERVER_PKG_REL} — the generated server catalogs import \`use-intl/core\`.`,
  },
];

/** Run every applicable edit. Collects rather than throws: a project
 *  that has diverged from the starter should end up with a list of
 *  documented manual steps, not a stack trace halfway through. */
export function applyI18nRewrites(rawInput: RewriteInput): RewriteOutcome {
  // Resolve the ledger ONCE, so the whole set records into one plan
  // rather than nine — which is what lets `--dry-run` print the edits
  // beside the writes, and a real run report them together.
  const input: RewriteInput = { ...rawInput, ledger: ledgerFor(rawInput) };
  const outcome: RewriteOutcome = {
    rewritten: [],
    unchanged: [],
    skipped: [],
    manualResidue: [],
  };

  for (const step of STEPS) {
    const outOfScope = step.outOfScope?.(input) ?? null;
    if (outOfScope !== null) {
      outcome.skipped.push(`${step.relPath}: ${outOfScope}`);
      continue;
    }
    let status: RewriteStatus;
    try {
      status = step.apply(input);
    } catch (err) {
      // Reaching here means a bug in this module rather than a project
      // we do not recognise, and the user still needs the manual step.
      outcome.skipped.push(`${step.relPath}: rewrite failed — ${(err as Error).message}`);
      outcome.manualResidue.push(step.residue);
      continue;
    }
    if (status === "rewritten") outcome.rewritten.push(step.relPath);
    else if (status === "unchanged") outcome.unchanged.push(step.relPath);
    else {
      outcome.skipped.push(`${step.relPath}: not found, or its shape is not one hatchkit edits`);
      outcome.manualResidue.push(step.residue);
    }
  }

  return outcome;
}
