/*
 * The shared vocabulary — the words that appear on more than one screen.
 *
 * Edit this file deliberately, never in passing. A line changed here moves
 * text on every screen at once, including the ones you are not looking at,
 * and a reviewer reading a one-screen pull request will not notice. When a
 * screen needs its own wording, give it its own key in `app` or
 * `marketing` instead of bending a shared one.
 *
 * This is the SOURCE catalog for locale "__HATCHKIT_SOURCE_LOCALE__". Its
 * literal types are what type-check the keys AND the ICU arguments of every
 * translation, so `as const` is load bearing: without it each message
 * widens to `string` and a translation may rename `{count}` unnoticed.
 */

export const common = {
  actions: {
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    create: "Create",
    confirm: "Confirm",
    close: "Close",
    back: "Back",
    retry: "Try again",
  },

  state: {
    loading: "Loading…",
    saving: "Saving…",
    saved: "Saved",
  },

  fields: {
    name: "Name",
    email: "Email",
    password: "Password",
    newPassword: "New password",
    confirmPassword: "Confirm password",
    title: "Title",
    description: "Description",
    // Suffix for a field label, not a sentence: keep it short enough to fit
    // behind the longest label on the screen.
    optional: "optional",
  },

  auth: {
    logIn: "Log in",
    logOut: "Sign out",
    signUp: "Sign up",
    forgotPassword: "Forgot your password?",
  },

  nav: {
    dashboard: "Dashboard",
    profile: "Profile",
    settings: "Settings",
    playground: "Playground",
  },

  validation: {
    required: "Fill in this field.",
    emailInvalid: "Enter an email address.",
    // A rich tag, so the parity check has one to compare: the host decides
    // what <b> renders as, the catalog only says which words carry it.
    passwordShort: "Use at least <b>8 characters</b>.",
    passwordMismatch: "The two passwords are different.",
  },

  errors: {
    generic: "Something went wrong. Try again.",
    network: "We cannot reach the server. Check your connection.",
    unauthorized: "Log in again to continue.",
    notFound: "We cannot find that page.",
  },

  counts: {
    // `#` prints the number in the reader's own digits and grouping. Writing
    // "{count} items" instead hands the number to the app to format, which
    // is how a German page ends up with an English thousands separator.
    items: "{count, plural, =0 {No items} one {# item} other {# items}}",
    selected: "{count, plural, one {# selected} other {# selected}}",
  },
} as const;

export type CommonMessages = typeof common;

export default common;
