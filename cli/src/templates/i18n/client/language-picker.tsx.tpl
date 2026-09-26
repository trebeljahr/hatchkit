"use client";

/*
 * The language picker: a plain <select>, because that is the control every
 * platform already renders as a native list the reader can type into.
 *
 * It sets the PREFERENCE, not the language — see i18n/locale-sync.tsx. The
 * choice is written to localStorage synchronously, so the very next cold start
 * paints in it, and <LocaleSync> carries it to the account if one is signed
 * in. "Follow my device" is the default and is not the same word as the theme
 * picker's "System": one means the operating system's appearance, the other
 * the browser's language list.
 *
 * Every language is listed by its ENDONYM — „Deutsch“, not "German". A reader
 * who cannot read the current interface language still recognises their own,
 * which is the only case where this control matters.
 *
 * The labels come from the `app` catalog (`settings.language`,
 * `settings.languageSystem`, `settings.languageHint`). The marketing footer
 * passes its own `label`, since it says "Language" in its own voice.
 */

import * as React from "react";
import { LOCALE_ENDONYMS, SUPPORTED_LOCALES } from "__HATCHKIT_PKG_SCOPE__/shared";

import { isPseudoActive, setPseudoOverride, subscribe } from "@/i18n/store";
import { useLocalePreference, useSetLocalePreference, useT } from "@/i18n/use-t";

/** Not a language. A development build offers the pseudo-locale here so the
 *  expansion can be checked on a real screen without a translation. */
const PSEUDO_OPTION = "__pseudo";
const DEV = process.env.NODE_ENV !== "production";

function returnFalse(): boolean {
  return false;
}

export function LanguagePicker({
  id = "language-picker",
  label,
  hint,
  className,
}: {
  id?: string;
  label?: string;
  hint?: string;
  className?: string;
}): React.JSX.Element {
  const t = useT("app");
  const preference = useLocalePreference();
  const setPreference = useSetLocalePreference();
  const pseudo = React.useSyncExternalStore(subscribe, isPseudoActive, returnFalse);

  function onChange(event: React.ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value;
    if (DEV && value === PSEUDO_OPTION) {
      setPseudoOverride(true);
      return;
    }
    if (DEV && pseudo) setPseudoOverride(false);
    setPreference(value === "system" ? "system" : (value as (typeof SUPPORTED_LOCALES)[number]));
  }

  return (
    <div className={className}>
      <label className="block text-sm font-medium" htmlFor={id}>
        {label ?? t("settings.language")}
      </label>
      <select
        className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        id={id}
        onChange={onChange}
        value={pseudo ? PSEUDO_OPTION : preference}
      >
        <option value="system">{t("settings.languageSystem")}</option>
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LOCALE_ENDONYMS[locale]}
          </option>
        ))}
        {DEV && <option value={PSEUDO_OPTION}>Pseudo-locale (development only)</option>}
      </select>
      <p className="mt-1 text-xs text-muted-foreground">{hint ?? t("settings.languageHint")}</p>
    </div>
  );
}
