/*
 * cli/src/features/i18n/render.ts — Tiny template renderer for i18n assets.
 *
 * Reuses cli/src/templates/i18n/ as the asset root (auto-copied to dist/ by
 * scripts/copy-templates.mjs). Substitution uses `__HATCHKIT_<TOKEN>__`
 * placeholders rather than Handlebars `{{X}}`, and this is not a style
 * preference here: the templates ARE TypeScript/TSX full of `${…}` template
 * literals and, being i18n catalogs, full of bare ICU `{count}` braces. A
 * mustache renderer would eat both.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** templates/i18n/ inside the compiled cli/dist tree.
 *  dist layout: dist/features/i18n/render.js + dist/templates/i18n/... */
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "i18n");

export type I18nTokens = {
  SOURCE_LOCALE?: string;
  TARGET_LOCALE?: string;
  SOURCE_LABEL?: string;
  TARGET_LABEL?: string;
  TARGET_LABEL_EN?: string;
  TARGET_REGION?: string;
  ALL_LOCALES_JSON?: string;
  PKG_SCOPE?: string;
  APP_NAME?: string;
  GATE_MS?: string;
  PSEUDO_EXPANSION?: string;
  VOICE?: string;
};

const TOKEN_NAMES: Array<keyof I18nTokens> = [
  "SOURCE_LOCALE",
  "TARGET_LOCALE",
  "SOURCE_LABEL",
  "TARGET_LABEL",
  "TARGET_LABEL_EN",
  "TARGET_REGION",
  "ALL_LOCALES_JSON",
  "PKG_SCOPE",
  "APP_NAME",
  "GATE_MS",
  "PSEUDO_EXPANSION",
  "VOICE",
];

/** Substitute `__HATCHKIT_<TOKEN>__` placeholders in `source`. Missing
 *  tokens are left as-is so a partial render is detectable in the output
 *  by a downstream consumer that greps for `__HATCHKIT_`. */
export function renderI18nString(source: string, tokens: I18nTokens): string {
  let out = source;
  for (const name of TOKEN_NAMES) {
    const value = tokens[name];
    if (value === undefined) continue;
    const needle = `__HATCHKIT_${name}__`;
    out = out.split(needle).join(value);
  }
  return out;
}

/** Read a template file from cli/src/templates/i18n/<rel> and render it.
 *  Path separators are forward-slash. */
export function renderI18nTemplate(relPath: string, tokens: I18nTokens): string {
  const full = join(TEMPLATES_DIR, relPath);
  if (!existsSync(full)) {
    throw new Error(`i18n template not found: ${full}`);
  }
  const source = readFileSync(full, "utf-8");
  return renderI18nString(source, tokens);
}

/** Templates dir on disk — exposed for tests that snapshot-compare. */
export function getI18nTemplatesDir(): string {
  return TEMPLATES_DIR;
}
