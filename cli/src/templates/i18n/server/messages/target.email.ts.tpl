/**
 * `email` in __HATCHKIT_TARGET_LABEL__ (__HATCHKIT_TARGET_LABEL_EN__) — the
 * transactional mail a person keeps in their inbox.
 *
 * Voice: __HATCHKIT_VOICE__. Terms and false friends:
 * `packages/client/src/i18n/GLOSSARY.__HATCHKIT_TARGET_LOCALE__.md`.
 *
 * SEEDED, NOT TRANSLATED. Hatchkit was given a language code, not a
 * translator, so every value below is still the __HATCHKIT_SOURCE_LABEL__
 * text wrapped in `todo()`. That wrapper is the whole workflow:
 *
 *   · It marks the string visibly, so an untranslated mail looks wrong in a
 *     preview instead of looking like a deliberate choice.
 *   · `grep -c 'todo(' packages/server/src/i18n/messages/__HATCHKIT_TARGET_LOCALE__/*.ts`
 *     is how much work is left.
 *   · Translating a message means deleting `todo(` and its `)` and writing
 *     the sentence. Nothing else moves.
 *
 * What must NOT change while you do that: the key, and every `{placeholder}`
 * inside the string, spelled exactly as in `../__HATCHKIT_SOURCE_LOCALE__/email.ts`.
 * A renamed placeholder type-checks and then prints literal braces to a
 * customer; `tests/i18n-catalog.test.ts` is what catches it.
 *
 * Word order is yours. `{inviter} invited you to {workspace}` may put either
 * argument first, and a plural may have as many categories as the language
 * needs — `one`/`other` is English grammar, not a template.
 */
import type { Translation } from "__HATCHKIT_PKG_SCOPE__/shared";

import type { email as source } from "../__HATCHKIT_SOURCE_LOCALE__/email.js";

/** Remove the call, keep the string: `todo("Hello {name},")` becomes
 *  `"Hallo {name},"`. Delete this helper once nothing calls it. */
const todo = (message: string): string => `TODO(__HATCHKIT_TARGET_LOCALE__) ${message}`;

export const email: Translation<typeof source> = {
  common: {
    greeting: todo("Hello {name},"),
    greetingAnonymous: todo("Hello,"),
    signOff: todo("The __HATCHKIT_APP_NAME__ team"),
    action: todo("Open __HATCHKIT_APP_NAME__"),
    pasteUrl: todo("If the button does not work, paste this link into your browser:"),
    footer: todo("You received this mail because you have a __HATCHKIT_APP_NAME__ account."),
    support: todo("Reply to this mail if you need help."),
  },

  welcome: {
    subject: todo("Welcome to __HATCHKIT_APP_NAME__"),
    intro: todo("Your account is ready."),
    body: todo(
      "Sign in whenever you like. Everything you save is yours, and you can export it at any time.",
    ),
    action: todo("Open __HATCHKIT_APP_NAME__"),
  },

  passwordReset: {
    subject: todo("Reset your password"),
    intro: todo("Open this link to choose a new password for your __HATCHKIT_APP_NAME__ account:"),
    action: todo("Choose a new password"),
    expiry: todo("The link works for {hours, plural, one {# hour} other {# hours}}."),
    ignore: todo("If you did not ask for this, ignore this mail. Your password stays the same."),
  },

  verification: {
    subject: todo("Confirm your address"),
    intro: todo("Open this link to confirm this address belongs to your __HATCHKIT_APP_NAME__ account:"),
    action: todo("Confirm my address"),
    ignore: todo("If you did not create an account, ignore this mail."),
  },

  invitation: {
    subject: todo("{inviter} invited you to {workspace}"),
    intro: todo("{inviter} invited you to join {workspace} on __HATCHKIT_APP_NAME__."),
    action: todo("Accept the invitation"),
    expiry: todo("The invitation expires in {days, plural, one {# day} other {# days}}."),
    someone: todo("Someone"),
    aWorkspace: todo("a shared workspace"),
  },

  receipt: {
    subject: todo("Your receipt {number}"),
    heading: todo("Receipt {number}"),
    paidOn: todo("Paid on {date}."),
    total: todo("Total: {amount}"),
    method: todo("Charged to {method}."),
    action: todo("View your receipts"),
    keep: todo("Keep this mail for your records. You can download the receipt again later."),
  },
};
