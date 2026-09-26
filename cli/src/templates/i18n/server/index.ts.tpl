/**
 * Translated server text: transactional email and generated documents.
 *
 * Separate from the client's catalogs on purpose. The server writes things a
 * person KEEPS — a PDF re-rendered months later, a mail already sitting in an
 * inbox — so its strings are keyed by the DOCUMENT rather than by a screen,
 * and the language comes from the document's own stored locale (see
 * `resolve.ts`), never from the request that happened to trigger the render.
 * It also must not import anything React-facing: the same ICU engine
 * (`use-intl/core`), the same `Translation<>` typing and the same parity test
 * as the client, with no component tree.
 *
 * Deliberately NOT localised, whatever the locale: exported data columns and
 * the importer, REST/tRPC error codes and `problem+json` types, webhook
 * payload fields, API docs, log lines. Those are read by machines, or by
 * integrators who key off the exact string.
 */
import { SOURCE_LOCALE, type SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";
import { type _Translator, createTranslator } from "use-intl/core";

import { document as sourceDocument } from "./messages/__HATCHKIT_SOURCE_LOCALE__/document.js";
import { email as sourceEmail } from "./messages/__HATCHKIT_SOURCE_LOCALE__/email.js";
import { document as targetDocument } from "./messages/__HATCHKIT_TARGET_LOCALE__/document.js";
import { email as targetEmail } from "./messages/__HATCHKIT_TARGET_LOCALE__/email.js";

/**
 * hatchkit:i18n-server-catalogs
 *
 * `hatchkit add i18n` renders this file ONCE, for the first target language,
 * because a template cannot emit a variable number of import statements. A
 * third language is two imports above and one entry here — the catalog files
 * themselves are already on disk under `messages/<locale>/`, written per
 * target. A locale missing from this map falls back to the source language
 * below: a source-language receipt is recoverable, a crash on download is not.
 */
export const serverMessages = {
  __HATCHKIT_SOURCE_LOCALE__: { email: sourceEmail, document: sourceDocument },
  __HATCHKIT_TARGET_LOCALE__: { email: targetEmail, document: targetDocument },
} as const;

/** The source catalogs' literal types are what type-check keys and ICU
 *  arguments; a translation is annotated against them, so it has the same
 *  keys but plain `string` values and is not assignable to this. */
export type ServerMessages = (typeof serverMessages)["__HATCHKIT_SOURCE_LOCALE__"];
export type ServerNamespace = keyof ServerMessages;
export type ServerTranslator<N extends ServerNamespace> = _Translator<ServerMessages, N>;

/** One widening cast, here, so every lookup below is a plain record access
 *  and a locale the map does not carry is a runtime fallback rather than a
 *  compile error in code that never mentions it. */
const catalogs = serverMessages as unknown as Readonly<Record<string, ServerMessages>>;

const translators = new Map<string, unknown>();
const warnedLocales = new Set<string>();

/**
 * A translator for one server namespace, in the language of the thing being
 * rendered — `invoice.locale`, the recipient's stored preference — not the
 * language of whoever triggered it.
 *
 * `timeZone` defaults to UTC because a document has no viewer to take a zone
 * from; dates on one are calendar dates, formatted before they reach a
 * message. A missing message renders as `namespace.key` and never throws: a
 * half-rendered receipt can be fixed and re-sent, a 500 on the download
 * cannot be.
 */
export function serverT<N extends ServerNamespace>(
  locale: SupportedLocale | null | undefined,
  namespace: N,
  timeZone = "UTC",
): ServerTranslator<N> {
  const resolved: SupportedLocale = locale ?? SOURCE_LOCALE;
  const key = `${resolved}:${namespace}:${timeZone}`;
  const cached = translators.get(key);
  if (cached !== undefined) return cached as ServerTranslator<N>;

  const messages = catalogs[resolved];
  // Loud once per language, in the log rather than in the document: a
  // registered language reads correctly, an unregistered one reads in the
  // source language, and the difference must not be invisible.
  if (messages === undefined && !warnedLocales.has(resolved)) {
    warnedLocales.add(resolved);
    console.warn(
      `[i18n] No server catalog registered for "${resolved}" — rendering in "${SOURCE_LOCALE}". ` +
        "Add its imports and its serverMessages entry in src/i18n/index.ts.",
    );
  }

  const translator = createTranslator({
    locale: resolved,
    messages: messages ?? catalogs[SOURCE_LOCALE],
    namespace,
    timeZone,
    onError: () => undefined,
    getMessageFallback: ({ namespace: ns, key: messageKey }) =>
      ns ? `${ns}.${messageKey}` : messageKey,
  }) as unknown as ServerTranslator<N>;

  translators.set(key, translator);
  return translator;
}
