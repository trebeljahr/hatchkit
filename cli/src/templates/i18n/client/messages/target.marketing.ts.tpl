/*
 * The public pages in "__HATCHKIT_TARGET_LOCALE__"
 * (__HATCHKIT_TARGET_LABEL_EN__).
 *
 * SEEDED FROM GERMAN — see the note at the top of the shared-vocabulary
 * file next to this one. If __HATCHKIT_TARGET_LABEL_EN__ is not German,
 * treat every message here as an untranslated stub with the right keys.
 *
 * This catalog is read at BUILD time, so these strings end up in the HTML a
 * crawler fetches for /__HATCHKIT_TARGET_LOCALE__/. `seo.title` and
 * `seo.description` are the ones a search result shows: translate them for
 * the words people in __HATCHKIT_TARGET_LABEL_EN__ actually search for,
 * rather than word by word from __HATCHKIT_SOURCE_LOCALE__.
 */

import type { Translation } from "__HATCHKIT_PKG_SCOPE__/shared";
import type { MarketingMessages } from "../__HATCHKIT_SOURCE_LOCALE__/marketing";

export const marketing: Translation<MarketingMessages> = {
  hero: {
    title: "Willkommen bei __HATCHKIT_APP_NAME__",
    subtitle: "Ein Full-Stack-Starter mit Konten, Zahlungen und Live-Updates.",
    badge: "<b>{count, plural, one {# Sprache} other {# Sprachen}}</b> ab dem ersten Build",
    primaryCta: "Konto anlegen",
    secondaryCta: "Anmelden",
  },

  features: {
    heading: "Das ist dabei",
    accounts: {
      title: "Konten",
      body: "Registrierung, Anmeldung und Passwort-Reset laufen ab dem ersten Start.",
    },
    payments: {
      title: "Zahlungen",
      body: "Nimm ein Abo an, ohne den Checkout selbst zu schreiben.",
    },
    live: {
      title: "Live-Updates",
      body: "Jeder offene Tab sieht eine Änderung, sobald sie passiert.",
    },
  },

  cta: {
    heading: "Bereit?",
    body: "Lege ein Konto an und öffne die Übersicht.",
    button: "Jetzt starten",
  },

  footer: {
    languageLabel: "Sprache",
  },

  seo: {
    title: "__HATCHKIT_APP_NAME__ — Konten, Zahlungen und Live-Updates",
    description: "Ein Full-Stack-Starter mit Konten, Zahlungen und Live-Updates.",
  },
};

export default marketing;
