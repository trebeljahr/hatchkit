/*
 * The shared vocabulary in "__HATCHKIT_TARGET_LOCALE__"
 * (__HATCHKIT_TARGET_LABEL_EN__).
 *
 * SEEDED FROM GERMAN. Hatchkit ships one worked example translation, and it
 * is German. If __HATCHKIT_TARGET_LABEL_EN__ is not German, every message
 * below is still German: it is a stub with the right keys and the right ICU
 * arguments, waiting for a translator. Nothing catches that for you — the
 * types only prove the shape, and the parity check only fails on a message
 * left in __HATCHKIT_SOURCE_LOCALE__. Work through it with
 * GLOSSARY.__HATCHKIT_TARGET_LOCALE__.md open.
 *
 * `Translation<CommonMessages>` is what makes a missing, misspelled or extra
 * key a compile error. The source is imported as a TYPE only, so the
 * __HATCHKIT_SOURCE_LOCALE__ catalog does not get bundled into the
 * __HATCHKIT_TARGET_LOCALE__ chunk alongside it.
 *
 * Keep every `{argument}` and every <tag> spelled exactly as the source
 * spells it. A renamed argument compiles and then renders literal braces to
 * the reader; that is the bug catalog-parity.test.ts exists to catch.
 */

import type { Translation } from "__HATCHKIT_PKG_SCOPE__/shared";
import type { CommonMessages } from "../__HATCHKIT_SOURCE_LOCALE__/common";

export const common: Translation<CommonMessages> = {
  actions: {
    save: "Speichern",
    cancel: "Abbrechen",
    delete: "Löschen",
    edit: "Bearbeiten",
    create: "Anlegen",
    confirm: "Bestätigen",
    close: "Schließen",
    back: "Zurück",
    retry: "Erneut versuchen",
  },

  state: {
    loading: "Wird geladen…",
    saving: "Wird gespeichert…",
    saved: "Gespeichert",
  },

  fields: {
    name: "Name",
    email: "E-Mail",
    password: "Passwort",
    newPassword: "Neues Passwort",
    confirmPassword: "Passwort bestätigen",
    title: "Titel",
    description: "Beschreibung",
    optional: "optional",
  },

  auth: {
    logIn: "Anmelden",
    logOut: "Abmelden",
    signUp: "Registrieren",
    forgotPassword: "Passwort vergessen?",
  },

  nav: {
    dashboard: "Übersicht",
    profile: "Profil",
    settings: "Einstellungen",
    playground: "Spielwiese",
  },

  validation: {
    required: "Fülle dieses Feld aus.",
    emailInvalid: "Gib eine E-Mail-Adresse ein.",
    passwordShort: "Verwende mindestens <b>8 Zeichen</b>.",
    passwordMismatch: "Die beiden Passwörter sind unterschiedlich.",
  },

  errors: {
    generic: "Etwas ist schiefgegangen. Versuche es erneut.",
    network: "Wir erreichen den Server nicht. Prüfe deine Verbindung.",
    unauthorized: "Melde dich erneut an, um weiterzumachen.",
    notFound: "Wir finden diese Seite nicht.",
  },

  counts: {
    items: "{count, plural, =0 {Keine Einträge} one {# Eintrag} other {# Einträge}}",
    selected: "{count, plural, one {# ausgewählt} other {# ausgewählt}}",
  },
};

export default common;
