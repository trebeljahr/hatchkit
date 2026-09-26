/*
 * Every catalog, assembled. The ONLY file that lists namespaces.
 *
 * Adding a namespace means a file in __HATCHKIT_SOURCE_LOCALE__/, one in
 * every target directory, and a line in each object below. Adding a LANGUAGE
 * means a directory of catalogs and the two lines marked
 * `hatchkit:locale-imports` — see "Adding a language" at the bottom.
 *
 * Every locale is bundled statically, with no dynamic import. A reader whose
 * language is not the prerendered one is looking at a gated (invisible) page
 * until React has rendered in it, so a chunk fetched at that moment is a
 * blank screen on a slow connection; and the whole catalog is small next to
 * one chart library.
 *
 * The source catalog's LITERAL types are the contract: they type-check the
 * keys and the ICU arguments of every call site, and `Translation<Messages>`
 * makes a missing, misspelled or extra key in a translation a `tsc` error.
 * What types cannot see — a renamed `{argument}`, broken ICU, a sentence left
 * in __HATCHKIT_SOURCE_LOCALE__ — is what catalog-parity.test.ts is for.
 */

import type { SupportedLocale, Translation } from "__HATCHKIT_PKG_SCOPE__/shared";

import { app as sourceApp } from "./__HATCHKIT_SOURCE_LOCALE__/app";
import { common as sourceCommon } from "./__HATCHKIT_SOURCE_LOCALE__/common";
import { marketing as sourceMarketing } from "./__HATCHKIT_SOURCE_LOCALE__/marketing";

// hatchkit:locale-imports — one block per target language.
import { app as __HATCHKIT_TARGET_LOCALE___app } from "./__HATCHKIT_TARGET_LOCALE__/app";
import { common as __HATCHKIT_TARGET_LOCALE___common } from "./__HATCHKIT_TARGET_LOCALE__/common";
import { marketing as __HATCHKIT_TARGET_LOCALE___marketing } from "./__HATCHKIT_TARGET_LOCALE__/marketing";

/** The source catalog. Its literal types drive key and argument checking. */
export const SOURCE_MESSAGES = {
  common: sourceCommon,
  app: sourceApp,
  marketing: sourceMarketing,
} as const;

export type Messages = typeof SOURCE_MESSAGES;
export type Namespace = keyof Messages;

/** Typed against the source: a missing or extra key fails `tsc`. */
const __HATCHKIT_TARGET_LOCALE___messages: Translation<Messages> = {
  common: __HATCHKIT_TARGET_LOCALE___common,
  app: __HATCHKIT_TARGET_LOCALE___app,
  marketing: __HATCHKIT_TARGET_LOCALE___marketing,
};

/**
 * Locale to catalog, for every supported locale — the `Record` is total on
 * purpose. Adding a language to SUPPORTED_LOCALES in
 * packages/shared/src/locale.ts without wiring its catalogs here is then a
 * `tsc` error that names the missing language, instead of a second language
 * that silently renders in "__HATCHKIT_SOURCE_LOCALE__" for the readers who
 * asked for it and for nobody who would notice.
 *
 * The cast is safe and unavoidable: a translation differs from the source
 * only in its literal string types, and `Translation<Messages>` has already
 * proved the shapes match.
 */
export const MESSAGES: Record<SupportedLocale, Messages> = {
  "__HATCHKIT_SOURCE_LOCALE__": SOURCE_MESSAGES,
  // hatchkit:locale-imports
  "__HATCHKIT_TARGET_LOCALE__": __HATCHKIT_TARGET_LOCALE___messages as unknown as Messages,
};

/**
 * The catalog for a locale.
 *
 * The fallback cannot be reached through the types; it is here because a
 * locale can also arrive from a stale localStorage value or a hand-typed
 * URL, and a missing catalog would otherwise throw inside a render.
 */
export function messagesFor(locale: SupportedLocale): Messages {
  return MESSAGES[locale] ?? SOURCE_MESSAGES;
}

export const NAMESPACES = Object.keys(SOURCE_MESSAGES) as Namespace[];

/*
 * Adding a language
 * -----------------
 * 1. `cp -r messages/__HATCHKIT_TARGET_LOCALE__ messages/<code>` and translate
 *    every file (the target catalogs are already annotated against the source,
 *    so `tsc` lists whatever you miss).
 * 2. Copy the three imports marked `hatchkit:locale-imports` and the
 *    `Translation<Messages>` object above, with `<code>` in place of
 *    "__HATCHKIT_TARGET_LOCALE__".
 * 3. Add one entry to MESSAGES.
 * 4. Add `<code>` to SUPPORTED_LOCALES in packages/shared/src/locale.ts,
 *    with its region and endonym. Do this step FIRST if you would rather be
 *    told what to do: MESSAGES is a total record, so `tsc` then names the
 *    language that has no catalog yet.
 * 5. Add `app/<code>/page.tsx` as a one-line re-export, the way
 *    app/__HATCHKIT_TARGET_LOCALE__/page.tsx does it.
 */
