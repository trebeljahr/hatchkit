/*
 * cli/src/features/i18n/plan.ts — The single source of truth mapping i18n
 * templates to project destinations.
 *
 * Nothing else in the feature may hardcode a template path. The writer, the
 * CLI tests and `hatchkit destroy`'s ledger all read the same table, so a
 * file that moves moves in exactly one place and the idempotency tests keep
 * covering it.
 *
 * Two axes expand one entry into several jobs:
 *
 *   · TARGET — any entry whose template or destination mentions `{tgt}` is
 *     rendered once per target locale. That is why the axis is derived from
 *     the path rather than from {@link I18nGate}: the per-target marketing
 *     page is gated on `publicPages` AND per-target, and a single-valued
 *     gate cannot say both. The gate decides INCLUSION; `{tgt}` decides
 *     REPETITION. `gate: "per-target"` therefore means "always included,
 *     once per target" — the translation catalogs and the glossary.
 *   · NAMESPACE — `perNamespace` entries are rendered once per configured
 *     namespace, with `{ns}` substituted in both the template path and the
 *     destination. The catalogs really are one hand-written template per
 *     namespace (`source.common.ts.tpl`, `source.app.ts.tpl`, …): their
 *     content differs, so there is nothing to generate from a loop.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { localeMeta } from "./locales.js";
import { type I18nTokens, getI18nTemplatesDir } from "./render.js";
import type { I18nConfig } from "./types.js";

export type I18nGate =
  /** core: store, useT, format, catalogs, first paint */
  | "always"
  /** rendered once per target locale */
  | "per-target"
  | "public-pages"
  | "server"
  | "pseudo"
  | "tests";

export interface I18nTemplateEntry {
  /** path under cli/src/templates/i18n/ */
  template: string;
  /** project-relative destination; may contain {src} {tgt} {ns} */
  dest: string;
  gate: I18nGate;
  /** present => rendered once per namespace with {ns} substituted */
  perNamespace?: boolean;
}

export interface I18nJob {
  template: string;
  dest: string;
  tokens: I18nTokens;
}

/** How much longer the pseudo-locale is than the source, as a ratio. ~35%
 *  is the figure that makes German-length clipping show up in an English
 *  build; the pseudo template and its test both read it from here. */
export const PSEUDO_EXPANSION_RATIO = 0.35;

export const I18N_TEMPLATES: readonly I18nTemplateEntry[] = [
  // Core — the translation runtime. Present for every config, because
  // everything below imports from it.
  { template: "client/store.ts.tpl", dest: "packages/client/src/i18n/store.ts", gate: "always" },
  { template: "client/use-t.ts.tpl", dest: "packages/client/src/i18n/use-t.ts", gate: "always" },
  { template: "client/format.ts.tpl", dest: "packages/client/src/i18n/format.ts", gate: "always" },
  {
    template: "client/locale-root.tsx.tpl",
    dest: "packages/client/src/i18n/locale-root.tsx",
    gate: "always",
  },
  {
    template: "client/fixed-locale.tsx.tpl",
    dest: "packages/client/src/i18n/fixed-locale.tsx",
    gate: "always",
  },
  {
    template: "client/locale-sync.tsx.tpl",
    dest: "packages/client/src/i18n/locale-sync.tsx",
    gate: "always",
  },
  {
    template: "client/language-picker.tsx.tpl",
    dest: "packages/client/src/components/language-picker.tsx",
    gate: "always",
  },
  {
    template: "client/messages-index.ts.tpl",
    dest: "packages/client/src/i18n/messages/index.ts",
    gate: "always",
  },
  {
    template: "client/pre-paint.ts.tpl",
    dest: "packages/client/src/app/pre-paint.ts",
    gate: "always",
  },
  { template: "shared/locale.ts.tpl", dest: "packages/shared/src/locale.ts", gate: "always" },
  {
    template: "shared/format-duration.ts.tpl",
    dest: "packages/shared/src/format-duration.ts",
    gate: "always",
  },

  // Catalogs. The source catalog is the typed original; the target catalog
  // is annotated against it, so tsc catches a missing or misspelled key.
  {
    template: "client/messages/source.{ns}.ts.tpl",
    dest: "packages/client/src/i18n/messages/{src}/{ns}.ts",
    gate: "always",
    perNamespace: true,
  },
  {
    template: "client/messages/target.{ns}.ts.tpl",
    dest: "packages/client/src/i18n/messages/{tgt}/{ns}.ts",
    gate: "per-target",
    perNamespace: true,
  },
  {
    template: "client/GLOSSARY.md.tpl",
    dest: "packages/client/src/i18n/GLOSSARY.{tgt}.md",
    gate: "per-target",
  },

  // Pseudo-locale — non-production only, and a production build must
  // contain no trace of it.
  { template: "client/pseudo.ts.tpl", dest: "packages/client/src/i18n/pseudo.ts", gate: "pseudo" },

  // The tests that pin what the types cannot see: first paint, parity,
  // and the byte-identical shared-helper contract.
  {
    template: "client/tests/pre-paint.test.ts.tpl",
    dest: "packages/client/src/app/pre-paint.test.ts",
    gate: "tests",
  },
  {
    template: "client/tests/locale-root.test.tsx.tpl",
    dest: "packages/client/src/i18n/locale-root.test.tsx",
    gate: "tests",
  },
  {
    template: "client/tests/catalog-parity.test.ts.tpl",
    dest: "packages/client/src/i18n/catalog-parity.test.ts",
    gate: "tests",
  },
  {
    template: "client/tests/format.test.ts.tpl",
    dest: "packages/client/src/i18n/format.test.ts",
    gate: "tests",
  },
  {
    template: "shared/tests/locale.test.ts.tpl",
    dest: "packages/shared/src/locale.test.ts",
    gate: "tests",
  },
  {
    template: "shared/tests/format-duration.test.ts.tpl",
    dest: "packages/shared/src/format-duration.test.ts",
    gate: "tests",
  },

  // Public pages, built once per language under a prefix. Never a
  // `[locale]` segment at the root — it competes with the app routes and
  // turns unknown paths into pages instead of a not-found.
  {
    template: "client/marketing/page-component.tsx.tpl",
    dest: "packages/client/src/components/marketing/pages/landing-page.tsx",
    gate: "public-pages",
  },
  {
    template: "client/marketing/marketing-shell.tsx.tpl",
    dest: "packages/client/src/components/marketing/marketing-shell.tsx",
    gate: "public-pages",
  },
  {
    template: "client/marketing/metadata.ts.tpl",
    dest: "packages/client/src/components/marketing/metadata.ts",
    gate: "public-pages",
  },
  {
    template: "client/marketing/localized-path.ts.tpl",
    dest: "packages/client/src/components/marketing/localized-path.ts",
    gate: "public-pages",
  },
  // `.example`, NOT app/page.tsx: the user's own landing page is theirs.
  // The orchestrator records a manual-residue note to swap it in.
  {
    template: "client/marketing/source-page.tsx.tpl",
    dest: "packages/client/src/app/page.i18n.tsx.example",
    gate: "public-pages",
  },
  {
    template: "client/marketing/target-page.tsx.tpl",
    dest: "packages/client/src/app/{tgt}/page.tsx",
    gate: "public-pages",
  },

  // Server catalogs — a document or an email is snapshotted in the
  // language it was issued in.
  { template: "server/index.ts.tpl", dest: "packages/server/src/i18n/index.ts", gate: "server" },
  {
    template: "server/resolve.ts.tpl",
    dest: "packages/server/src/i18n/resolve.ts",
    gate: "server",
  },
  {
    template: "server/messages/source.email.ts.tpl",
    dest: "packages/server/src/i18n/messages/{src}/email.ts",
    gate: "server",
  },
  {
    template: "server/messages/source.document.ts.tpl",
    dest: "packages/server/src/i18n/messages/{src}/document.ts",
    gate: "server",
  },
  {
    template: "server/messages/target.email.ts.tpl",
    dest: "packages/server/src/i18n/messages/{tgt}/email.ts",
    gate: "server",
  },
  {
    template: "server/messages/target.document.ts.tpl",
    dest: "packages/server/src/i18n/messages/{tgt}/document.ts",
    gate: "server",
  },
  {
    template: "server/tests/i18n-catalog.test.ts.tpl",
    dest: "packages/server/src/tests/i18n-catalog.test.ts",
    gate: "server",
  },
];

/** The namespaces the shipped templates cover.
 *
 *  Each one is a hand-written pair of catalog templates — their CONTENT
 *  differs, so there is nothing to generate from a loop — and a namespace
 *  with no template makes `planI18nFiles` name a file that is not there.
 *  Derived from the table rather than listed a second time, so adding
 *  `source.billing.ts.tpl` + `target.billing.ts.tpl` and one entry is the
 *  whole change. */
export function shippedNamespaces(): string[] {
  const dir = getI18nTemplatesDir();
  const perNs = I18N_TEMPLATES.filter((e) => e.perNamespace === true);
  if (perNs.length === 0) return [];
  const candidates = new Set<string>();
  for (const entry of perNs) {
    const [prefix, suffix] = entry.template.split("{ns}");
    const parent = join(dir, dirname(prefix));
    if (!existsSync(parent)) continue;
    const head = basename(prefix);
    for (const file of readdirSync(parent)) {
      if (!file.startsWith(head) || !file.endsWith(suffix)) continue;
      candidates.add(file.slice(head.length, file.length - suffix.length));
    }
  }
  // Only a namespace EVERY per-namespace entry has a template for is
  // usable: a source catalog with no translation beside it would leave the
  // target locale silently missing a namespace.
  return [...candidates]
    .filter((ns) => perNs.every((e) => existsSync(join(dir, e.template.split("{ns}").join(ns)))))
    .sort();
}

function isIncluded(gate: I18nGate, config: I18nConfig): boolean {
  switch (gate) {
    case "public-pages":
      return config.publicPages;
    case "server":
      return config.serverCatalogs;
    case "pseudo":
      return config.pseudoLocale;
    // "tests" has no opt-out on purpose: the parity and first-paint tests
    // ARE the feature's contract, and a project that drops them silently
    // ships a half-translated page or an invisible one.
    default:
      return true;
  }
}

/** Voice note seeded into the glossary. Languages without an informal
 *  second person still owe the translator a register decision, so say so
 *  rather than leaving the token empty. */
function voiceNote(target: string): string {
  const informal = localeMeta(target).informalSecondPerson;
  return informal
    ? `informal second person ("${informal}")`
    : "polite register, no second-person pronoun";
}

function tokensFor(config: I18nConfig, ctx: PlanContext, target: string): I18nTokens {
  const source = localeMeta(config.sourceLocale);
  const tgt = localeMeta(target);
  return {
    SOURCE_LOCALE: config.sourceLocale,
    TARGET_LOCALE: target,
    SOURCE_LABEL: source.endonym,
    TARGET_LABEL: tgt.endonym,
    TARGET_LABEL_EN: tgt.englishName,
    TARGET_REGION: tgt.defaultRegion,
    // Source first: the supported list's order is the fallback order, and
    // the source locale is what the prerendered HTML already contains.
    ALL_LOCALES_JSON: JSON.stringify([config.sourceLocale, ...config.targetLocales]),
    PKG_SCOPE: ctx.pkgScope,
    APP_NAME: ctx.appName,
    GATE_MS: String(config.gateFailsafeMs),
    PSEUDO_EXPANSION: String(PSEUDO_EXPANSION_RATIO),
    VOICE: voiceNote(target),
  };
}

export interface PlanContext {
  pkgScope: string;
  appName: string;
}

/** Resolve I18N_TEMPLATES into concrete (template, dest, tokens) jobs. */
export function planI18nFiles(config: I18nConfig, ctx: PlanContext): I18nJob[] {
  // Files with no `{tgt}` still need a TARGET_LOCALE for their headers and
  // for the picker's default; the first target is the primary one.
  const primary = config.targetLocales[0] ?? config.sourceLocale;
  const jobs: I18nJob[] = [];

  for (const entry of I18N_TEMPLATES) {
    if (!isIncluded(entry.gate, config)) continue;

    const perTarget = entry.dest.includes("{tgt}") || entry.template.includes("{tgt}");
    const targets = perTarget ? config.targetLocales : [primary];
    const namespaces = entry.perNamespace ? config.namespaces : [null];

    for (const target of targets) {
      const tokens = tokensFor(config, ctx, target);
      for (const ns of namespaces) {
        jobs.push({
          template: expand(entry.template, config.sourceLocale, target, ns),
          dest: expand(entry.dest, config.sourceLocale, target, ns),
          tokens,
        });
      }
    }
  }

  return jobs;
}

function expand(path: string, src: string, tgt: string, ns: string | null): string {
  let out = path.split("{src}").join(src).split("{tgt}").join(tgt);
  if (ns !== null) out = out.split("{ns}").join(ns);
  return out;
}
