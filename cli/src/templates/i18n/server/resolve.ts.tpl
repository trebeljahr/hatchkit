/**
 * Which language a mail or a document goes out in.
 *
 * Both answers are SNAPSHOTTED onto the row at issue time and never
 * recomputed, for the same reason the amounts on an invoice are: a PDF and a
 * mail are things a person KEEPS, and re-rendering one must never change the
 * language of a document somebody already holds. So store the result of these
 * functions beside the document — `Document.locale`, `Message.locale` — and
 * read the stored value on every later render.
 *
 * The stored field has no default, on purpose. A row without one predates
 * localisation and stays in __HATCHKIT_SOURCE_LABEL__ forever, which is what
 * it was written in; a default would rewrite history the first time somebody
 * opened an old download.
 *
 * "system" is not an answer here. The server has no device to ask what it
 * means, and a request header is the wrong thing to guess from: the language
 * of a kept document would then depend on which machine pressed the button.
 * It therefore falls through as if the preference were unset. That is also
 * why these functions do not simply call `resolveLocale` from the shared
 * resolver three times — that one answers SOURCE_LOCALE where this one needs
 * "no opinion, ask the next candidate".
 */
import {
  type LocalePreference,
  SOURCE_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from "__HATCHKIT_PKG_SCOPE__/shared";

/** A preference that names a language, or null for "no opinion". Anything
 *  unrecognised is no opinion too: a locale removed from the project must not
 *  render a document in a catalog that is no longer there. */
function explicit(pref: LocalePreference | string | null | undefined): SupportedLocale | null {
  if (pref === null || pref === undefined || pref === "system") return null;
  return isSupportedLocale(pref) ? pref : null;
}

/**
 * The language a transactional mail is written in: the RECIPIENT's explicit
 * preference, then the sender's, then the source language.
 *
 * The recipient comes first because the mail is for them. The sender is the
 * fallback for an address with no account yet — an invitation is more likely
 * to be readable in the inviter's language than in ours.
 */
export function resolveEmailLocale(a: {
  recipient?: LocalePreference | null;
  sender?: LocalePreference | null;
}): SupportedLocale {
  return explicit(a.recipient) ?? explicit(a.sender) ?? SOURCE_LOCALE;
}

/**
 * The language a generated document is written in: an explicit override on
 * the document, then the SUBJECT of it (the customer a receipt is addressed
 * to — their language, whoever issued it), then the issuer, then the source
 * language.
 *
 * Call this once, when the document is created, and store what it returns.
 */
export function resolveDocumentLocale(a: {
  override?: LocalePreference | null;
  subject?: LocalePreference | null;
  issuer?: LocalePreference | null;
}): SupportedLocale {
  return explicit(a.override) ?? explicit(a.subject) ?? explicit(a.issuer) ?? SOURCE_LOCALE;
}
