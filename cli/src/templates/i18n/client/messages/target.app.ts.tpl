/*
 * The signed-in surface in "__HATCHKIT_TARGET_LOCALE__"
 * (__HATCHKIT_TARGET_LABEL_EN__).
 *
 * SEEDED FROM GERMAN — see the note at the top of the shared-vocabulary
 * file next to this one. If __HATCHKIT_TARGET_LABEL_EN__ is not German,
 * treat every message here as an untranslated stub with the right keys.
 *
 * Voice: __HATCHKIT_VOICE__. Pick it once and hold it; a screen that
 * switches register reads as two products.
 */

import type { Translation } from "__HATCHKIT_PKG_SCOPE__/shared";
import type { AppMessages } from "../__HATCHKIT_SOURCE_LOCALE__/app";

export const app: Translation<AppMessages> = {
  shell: {
    signedInAs: "Angemeldet als {name}",
  },

  login: {
    title: "Anmelden",
    subtitle: "Gib deine Zugangsdaten ein, um zu deinem Konto zu kommen.",
    submitting: "Wird angemeldet…",
    failed: "Wir können dich nicht anmelden. Prüfe E-Mail-Adresse und Passwort.",
    noAccount: "Noch kein Konto?",
  },

  signup: {
    title: "Konto anlegen",
    subtitle: "Gib deine Daten ein, um zu starten.",
    submitting: "Konto wird angelegt…",
    failed: "Wir können dein Konto nicht anlegen.",
    haveAccount: "Du hast schon ein Konto?",
  },

  forgotPassword: {
    title: "Passwort vergessen",
    subtitle: "Gib deine E-Mail-Adresse ein und wir senden dir einen Link zum Zurücksetzen.",
    submitting: "Wird gesendet…",
    sent: "Wenn es ein Konto für {email} gibt, erreicht ein Link zum Zurücksetzen es innerhalb von {minutes, plural, one {# Minute} other {# Minuten}}.",
  },

  resetPassword: {
    title: "Neues Passwort wählen",
    submitting: "Neues Passwort wird gespeichert…",
    failed: "Wir können dein Passwort nicht zurücksetzen. Der Link ist vielleicht abgelaufen.",
    done: "Dein neues Passwort ist gesetzt. Melde dich damit an.",
  },

  dashboard: {
    title: "Übersicht",
    subtitle: "Verwalte deine Einträge.",
    titlePlaceholder: "Titel des Eintrags",
    descriptionPlaceholder: "Beschreibung (optional)",
    creating: "Wird angelegt…",
    loading: "Deine Einträge werden geladen…",
    empty: "Noch keine Einträge. Lege oben den ersten an.",
    summary:
      "{count, plural, =0 {Noch nichts hier} one {# Eintrag, zuletzt geändert am {changed, date, medium}} other {# Einträge, zuletzt geändert am {changed, date, medium}}}",
  },

  item: {
    created: "Angelegt am {created, date, medium}",
    visibility:
      "{scope, select, private {Nur du kannst diesen Eintrag öffnen} team {Alle in deinem Team können diesen Eintrag öffnen} other {Alle mit dem Link können diesen Eintrag öffnen}}",
    deleteConfirm: "„{title}“ löschen? Das lässt sich nicht widerrufen.",
    deleted: "„{title}“ ist gelöscht.",
    quota: "{used, number} von {limit, number} Einträgen belegt",
  },

  profile: {
    title: "Profil",
    subtitle: "Verwalte deine Profilangaben.",
    bio: "Über mich",
    bioEmpty: "Noch kein Text.",
    edit: "Profil bearbeiten",
  },

  settings: {
    title: "Einstellungen",
    subtitle: "Verwalte die Einstellungen deines Kontos.",
    appearance: "Darstellung",
    themeLight: "Hell",
    themeDark: "Dunkel",
    themeSystem: "System",
    notifications: "Benachrichtigungen",
    notificationsLabel: "Schick mir E-Mail-Benachrichtigungen",
    language: "Sprache",
    languageSystem: "Meinem Gerät folgen",
    languageHint:
      "Deine Sprache ist an dein Konto gebunden und gilt auf jedem Gerät, auf dem du dich anmeldest.",
    dangerZone: "Kritischer Bereich",
    dangerHint: "Lösche dein Konto und alles darin, endgültig.",
    deleteAccount: "Konto löschen",
  },

  session: {
    // German puts the date before the time. The argument NAMES stay as the
    // source spells them; their order in the sentence is the translator's.
    expires: "Deine Sitzung endet am {day, date, medium} um {at, time}.",
  },
};

export default app;
