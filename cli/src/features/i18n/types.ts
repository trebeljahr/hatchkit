/*
 * cli/src/features/i18n/types.ts — Shared types for the i18n feature.
 *
 * The i18n feature is a GENERATOR, not a switch: the Hatchkit starter is
 * English-only and stays that way, and `hatchkit add <project> i18n` writes
 * a second language into a target project. So the types here describe an
 * ANSWER SET (what the user chose) plus an AUDIT (what the run did), never
 * runtime state — nothing in this module is loaded by the generated app.
 *
 * Two constraints shape every field:
 *
 *   · The generated project is a static export (`output: "export"`), so
 *     there is no middleware and no server-side locale negotiation. The
 *     preference is synced per account, the language is resolved per
 *     device, and the source locale is what the prerendered HTML contains.
 *     {@link I18nConfig.gateFailsafeMs} exists because of that: a
 *     source-language page beats an invisible one.
 *   · Every gate is a boolean the user answered, because each one costs a
 *     surface a translator has to keep honest. Turning `publicPages` on
 *     doubles the page count; `serverCatalogs` adds per-document language
 *     snapshots; `pseudoLocale` must leave no trace in a production build.
 */

/** BCP-47 primary subtag, e.g. "de". Never a region-qualified tag: the
 *  region comes from the reader's device, not from the catalog. */
export type LocaleCode = string;

/** Not a real language. Derived from the source catalog at runtime and
 *  present only in non-production builds. */
export const PSEUDO_LOCALE = "pseudo";

export interface LocaleMeta {
  /** "de" */
  code: LocaleCode;
  /** "Deutsch" — what the language calls itself, which is what a picker
   *  must show: a reader who cannot read the current UI language still
   *  recognises their own. */
  endonym: string;
  /** "German" — for hatchkit's own output and the glossary header. */
  englishName: string;
  /** "DE" — Intl region used for date/number defaults when the device
   *  offers none. */
  defaultRegion: string;
  /** "du" — the informal second person, seeded into the glossary as a
   *  voice decision. Absent for languages that do not make the choice
   *  this way (Japanese drops the pronoun entirely). */
  informalSecondPerson?: string;
}

/** What the user answered / what the manifest records. */
export interface I18nConfig {
  sourceLocale: LocaleCode;
  /** At least one, and never contains {@link sourceLocale}. */
  targetLocales: LocaleCode[];
  namespaces: string[];
  /** Build public pages once per language under /<locale>/. */
  publicPages: boolean;
  /** Generate the server-side per-document catalogs (email + documents). */
  serverCatalogs: boolean;
  /** Ship the non-production pseudo-locale. */
  pseudoLocale: boolean;
  /** ms before the first-paint gate lifts regardless. */
  gateFailsafeMs: number;
}

export interface I18nApplyResult {
  ok: boolean;
  /** project-relative paths this run created/changed */
  written: string[];
  /** rendered identical to what was on disk */
  unchanged: string[];
  /** existing project files this run edited */
  rewritten: string[];
  /** "<path>: <reason>" — file absent, already wired… */
  skipped: string[];
  /** things the user must do by hand */
  manualResidue: string[];
  config: I18nConfig;
}
