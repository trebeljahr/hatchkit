/*
 * The signed-in surface, in the source locale "__HATCHKIT_SOURCE_LOCALE__":
 * the auth screens, the protected nav and the item screens.
 *
 * Nothing here is prerendered for a crawler, so a date or a time argument is
 * safe: it is formatted on the reader's device, in the reader's zone. The
 * `marketing` catalog is the one where that is a trap.
 *
 * Read `common` before adding a key. A second "Save" in a second wording is
 * how a product ends up saying two things for one action.
 */

export const app = {
  shell: {
    signedInAs: "Signed in as {name}",
  },

  login: {
    title: "Log in",
    subtitle: "Enter your credentials to reach your account.",
    submitting: "Logging in…",
    failed: "We cannot log you in. Check your email address and password.",
    noAccount: "No account yet?",
  },

  signup: {
    title: "Create an account",
    subtitle: "Enter your details to get started.",
    submitting: "Creating your account…",
    failed: "We cannot create your account.",
    haveAccount: "Already have an account?",
  },

  forgotPassword: {
    title: "Forgot password",
    subtitle: "Enter your email address and we send you a reset link.",
    submitting: "Sending…",
    // Two arguments in one message, on purpose: the parity check compares
    // argument NAMES, and a translation that renames one of two still type
    // checks and still renders raw braces to the reader.
    sent: "If an account exists for {email}, a reset link reaches it within {minutes, plural, one {# minute} other {# minutes}}.",
  },

  resetPassword: {
    title: "Choose a new password",
    submitting: "Saving your new password…",
    failed: "We cannot reset your password. The link may have expired.",
    done: "Your new password is set. Log in with it now.",
  },

  dashboard: {
    title: "Dashboard",
    subtitle: "Manage your items.",
    titlePlaceholder: "Item title",
    descriptionPlaceholder: "Description (optional)",
    creating: "Creating…",
    loading: "Loading your items…",
    empty: "No items yet. Add the first one above.",
    // A nested argument inside a plural branch. Both `count` and `changed`
    // must survive translation; dropping the inner one is exactly what the
    // parity test catches.
    summary:
      "{count, plural, =0 {Nothing here yet} one {# item, last changed {changed, date, medium}} other {# items, last changed {changed, date, medium}}}",
  },

  item: {
    created: "Added {created, date, medium}",
    // A `select`, which is not a plural: the branches are the app's own
    // values and a translator must keep the keys and translate only the
    // bodies. Renaming `team` here breaks the message for that value alone.
    visibility:
      "{scope, select, private {Only you can open this item} team {Everyone in your team can open this item} other {Anyone with the link can open this item}}",
    deleteConfirm: "Delete “{title}”? This cannot be undone.",
    deleted: "“{title}” is deleted.",
    // Two number arguments. `number` formats in the reader's locale, which
    // is the whole reason it goes through an ICU argument instead of being
    // pasted into the string by the component.
    quota: "{used, number} of {limit, number} items used",
  },

  profile: {
    title: "Profile",
    subtitle: "Manage your profile information.",
    bio: "Bio",
    bioEmpty: "No bio yet.",
    edit: "Edit profile",
  },

  settings: {
    title: "Settings",
    subtitle: "Manage your account settings.",
    appearance: "Appearance",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    notifications: "Notifications",
    notificationsLabel: "Send me email notifications",
    language: "Language",
    // "System" for a language means the device, not the operating system's
    // theme — say which, because the theme picker above uses the same word.
    languageSystem: "Follow my device",
    languageHint:
      "Your language is stored with your account and applies on every device you sign in on.",
    dangerZone: "Danger zone",
    dangerHint: "Delete your account and everything in it, for good.",
    deleteAccount: "Delete account",
  },

  session: {
    // A time and a date argument in one message. On a signed-in screen the
    // reader's own zone applies, which is what makes this safe here.
    expires: "Your session ends at {at, time} on {day, date, medium}.",
  },
} as const;

export type AppMessages = typeof app;

export default app;
