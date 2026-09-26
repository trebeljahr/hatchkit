/*
 * The public pages, in the source locale "__HATCHKIT_SOURCE_LOCALE__".
 *
 * These messages are read at BUILD time, once per language, so the HTML a
 * crawler fetches is already translated. Two consequences:
 *
 *   · Never add a date or a time argument to a message on this catalog. The
 *     build machine's zone and clock would be baked into the file every
 *     reader gets. A number is fine; "today" is not.
 *   · `seo.title` and `seo.description` are what `marketingMetadata` puts
 *     in <title> and the description meta tag. Keep the title under about
 *     60 characters and the description under about 155, or a search result
 *     shows a cut sentence.
 */

export const marketing = {
  hero: {
    title: "Welcome to __HATCHKIT_APP_NAME__",
    subtitle: "A full-stack starter with accounts, payments and live updates.",
    // A rich tag around a plural, so the parity check has both to compare.
    // The count is the number of languages this build ships, which the page
    // reads from the supported-locale list — not a figure anyone maintains.
    badge: "<b>{count, plural, one {# language} other {# languages}}</b> from the first build",
    primaryCta: "Create an account",
    secondaryCta: "Log in",
  },

  features: {
    heading: "What you get",
    accounts: {
      title: "Accounts",
      body: "Sign-up, log-in and password reset work on the first run.",
    },
    payments: {
      title: "Payments",
      body: "Take a subscription without writing the checkout flow yourself.",
    },
    live: {
      title: "Live updates",
      body: "Every open tab sees a change as it happens.",
    },
  },

  cta: {
    heading: "Ready to start?",
    body: "Create an account and open the dashboard.",
    button: "Get started",
  },

  footer: {
    // The only string the shell itself needs: the label on the
    // language list. Every language name in it stays in its own language.
    languageLabel: "Language",
  },

  seo: {
    // The app name alone would be byte-identical in every language, and the
    // parity check reads an identical sentence as a forgotten string. Say
    // what the product does after the name; that is also the better title.
    title: "__HATCHKIT_APP_NAME__ — accounts, payments and live updates",
    description: "A full-stack starter with accounts, payments and live updates.",
  },
} as const;

export type MarketingMessages = typeof marketing;

export default marketing;
