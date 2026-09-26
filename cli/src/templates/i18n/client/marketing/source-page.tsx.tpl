/*
 * THIS FILE IS AN EXAMPLE, NOT A PAGE. Hatchkit wrote it beside your own
 * app/page.tsx instead of over it — your landing page is yours, and an
 * overwrite would be unrecoverable.
 *
 * To finish wiring the __HATCHKIT_SOURCE_LOCALE__ landing page:
 *
 *   1. `diff app/page.tsx app/page.i18n.tsx.example`
 *   2. Move whatever your own page does that this one does not into
 *      components/marketing/pages/landing-page.tsx — the shared component
 *      both languages render, where copy belongs. Replace each literal
 *      string with a key in i18n/messages/<locale>/marketing.ts.
 *   3. `mv app/page.i18n.tsx.example app/page.tsx`
 *
 * Until step 3, / is your original page in __HATCHKIT_SOURCE_LOCALE__ only,
 * and the per-language pages under their prefixes are already live — so the
 * language links in their footer point back at an untranslated root.
 *
 * Why the source language is NOT under a prefix: / is the address old links,
 * sent email and existing search results already point at. Moving it costs
 * every one of them a redirect.
 */

import { marketingMetadata } from "@/components/marketing/metadata";
import LandingPage from "@/components/marketing/pages/landing-page";

export const metadata = marketingMetadata({ locale: "__HATCHKIT_SOURCE_LOCALE__", path: "/" });

export default function Page() {
  return <LandingPage locale="__HATCHKIT_SOURCE_LOCALE__" />;
}
