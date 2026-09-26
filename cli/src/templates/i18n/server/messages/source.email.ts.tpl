/**
 * `email` — the SOURCE catalog for transactional mail, in this project's
 * source language (__HATCHKIT_SOURCE_LABEL__).
 *
 * The seeded wording below is English, because that is the language
 * hatchkit's own templates are written in. If your source language is not
 * English, rewrite these values in place — they are the original, not a
 * translation, so nothing else has to move.
 *
 * `as const` is load-bearing: these literal types are what type-check the
 * keys AND the ICU arguments at every call site, and what each translation
 * file is annotated against. Add a key here first, then in every
 * `../<locale>/email.ts` — `tsc` names the ones you missed.
 *
 * Three rules for writing in this file:
 *
 *   · One whole sentence per key. The mail builder lays the values out as
 *     subject, paragraphs and a button label, so a translator never has to
 *     fit words around HTML and no message carries markup of its own.
 *     Arguments are escaped once, in code, rather than trusted in a message.
 *   · Pass dates, times and money in ALREADY FORMATTED — `{amount}`, not
 *     `{amount, number, currency}`. A mail has no viewer to take a time zone
 *     or a currency from, and the formatting decision belongs to the caller
 *     that knows which document this is about.
 *   · Never put anything a machine reads in here. Error codes,
 *     `problem+json` types and webhook fields stay in the source language in
 *     every locale.
 *
 * The language is the RECIPIENT's, resolved once by `resolveEmailLocale` and
 * stored on the message — not the language of whoever triggered the send.
 */
export const email = {
  /** Shared across every mail below. Edited deliberately: a change here
   *  changes the opening line of everything the server sends. */
  common: {
    greeting: "Hello {name},",
    /** For an address with no account, and therefore no name. */
    greetingAnonymous: "Hello,",
    signOff: "The __HATCHKIT_APP_NAME__ team",
    action: "Open __HATCHKIT_APP_NAME__",
    pasteUrl: "If the button does not work, paste this link into your browser:",
    footer: "You received this mail because you have a __HATCHKIT_APP_NAME__ account.",
    support: "Reply to this mail if you need help.",
  },

  welcome: {
    subject: "Welcome to __HATCHKIT_APP_NAME__",
    intro: "Your account is ready.",
    body: "Sign in whenever you like. Everything you save is yours, and you can export it at any time.",
    action: "Open __HATCHKIT_APP_NAME__",
  },

  passwordReset: {
    subject: "Reset your password",
    intro: "Open this link to choose a new password for your __HATCHKIT_APP_NAME__ account:",
    action: "Choose a new password",
    expiry: "The link works for {hours, plural, one {# hour} other {# hours}}.",
    ignore: "If you did not ask for this, ignore this mail. Your password stays the same.",
  },

  verification: {
    subject: "Confirm your address",
    intro: "Open this link to confirm this address belongs to your __HATCHKIT_APP_NAME__ account:",
    action: "Confirm my address",
    ignore: "If you did not create an account, ignore this mail.",
  },

  invitation: {
    subject: "{inviter} invited you to {workspace}",
    intro: "{inviter} invited you to join {workspace} on __HATCHKIT_APP_NAME__.",
    action: "Accept the invitation",
    expiry: "The invitation expires in {days, plural, one {# day} other {# days}}.",
    /** Stands in for `inviter` when the invitation carries no name. */
    someone: "Someone",
    /** Stands in for `workspace` when the invitation carries no name. */
    aWorkspace: "a shared workspace",
  },

  receipt: {
    subject: "Your receipt {number}",
    heading: "Receipt {number}",
    /** `date` and `amount` arrive formatted — see the header. */
    paidOn: "Paid on {date}.",
    total: "Total: {amount}",
    method: "Charged to {method}.",
    action: "View your receipts",
    keep: "Keep this mail for your records. You can download the receipt again later.",
  },
} as const;
