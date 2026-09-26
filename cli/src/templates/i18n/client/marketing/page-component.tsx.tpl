/*
 * The landing page, written ONCE and rendered once per language.
 *
 * `locale` is a prop, not a hook: the per-language route files pass it in,
 * `next build` renders this component once per language, and the translated
 * words land in the HTML file. So there is nothing here that reads the
 * locale store — no `useT`, no `useLocale`, no `useFormat`. A hook would
 * answer the SOURCE language during hydration by construction, which is
 * exactly right for the app and exactly wrong for a page whose markup is
 * already in another language.
 *
 * NEVER PASS A DATE OR A TIME into a message on this page. The value would
 * be formatted on the build machine, in the build machine's zone, and baked
 * into the file every reader downloads — "today" would mean the day of the
 * deploy, forever. Numbers are safe; anything a clock answers is not.
 *
 * Add a page by copying this file, not by adding a dynamic segment: see
 * ../localized-path.ts for why the root has no `[locale]`.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { SUPPORTED_LOCALES, type SupportedLocale } from "__HATCHKIT_PKG_SCOPE__/shared";
import { MarketingShell, marketingT } from "@/components/marketing/marketing-shell";

export default function LandingPage({ locale }: { locale: SupportedLocale }) {
  const t = marketingT(locale);

  // Written out rather than looped over a key prefix: the translator's keys
  // are typed against the source catalog's literal types, and a key built by
  // string concatenation gives that away.
  const features = [
    { title: t("features.accounts.title"), body: t("features.accounts.body") },
    { title: t("features.payments.title"), body: t("features.payments.body") },
    { title: t("features.live.title"), body: t("features.live.body") },
  ];

  return (
    <MarketingShell locale={locale} path="/">
      <section className="flex flex-col items-center justify-center px-8 py-24 text-center">
        <p className="mb-6 rounded-full border px-4 py-1 text-sm text-muted-foreground">
          {t.rich("hero.badge", {
            count: SUPPORTED_LOCALES.length,
            // Annotated rather than inferred: the tag callbacks are the one
            // place where the translator hands React a value back.
            b: (chunks: ReactNode) => (
              <strong className="font-semibold text-foreground">{chunks}</strong>
            ),
          })}
        </p>

        <h1 className="mb-4 max-w-2xl text-4xl font-bold tracking-tight">{t("hero.title")}</h1>
        <p className="mb-8 max-w-2xl text-lg text-muted-foreground">{t("hero.subtitle")}</p>

        {/* Auth and app routes exist ONCE, at the root, and follow the
            reader's own preference at runtime. They are not prerendered per
            language, so they must not go through `localizedPath` — /de/login/
            is a 404. Only public pages carry a language prefix. */}
        <div className="flex justify-center gap-4">
          <Link
            href="/signup"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("hero.primaryCta")}
          </Link>
          <Link
            href="/login"
            className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-8 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {t("hero.secondaryCta")}
          </Link>
        </div>
      </section>

      <section className="border-t px-8 py-16">
        <div className="container">
          <h2 className="mb-8 text-center text-2xl font-semibold">{t("features.heading")}</h2>
          <div className="grid gap-8 sm:grid-cols-3">
            {features.map((feature) => (
              <div key={feature.title}>
                <h3 className="mb-2 font-medium">{feature.title}</h3>
                <p className="text-sm text-muted-foreground">{feature.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t px-8 py-16 text-center">
        <h2 className="mb-2 text-2xl font-semibold">{t("cta.heading")}</h2>
        <p className="mb-6 text-muted-foreground">{t("cta.body")}</p>
        <Link
          href="/signup"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("cta.button")}
        </Link>
      </section>
    </MarketingShell>
  );
}
