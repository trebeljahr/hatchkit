/*
 * /__HATCHKIT_TARGET_LOCALE__/ — the landing page in
 * __HATCHKIT_TARGET_LABEL__ (__HATCHKIT_TARGET_LABEL_EN__).
 *
 * A re-export and a <head>, nothing else. The page itself lives in
 * components/marketing/pages/landing-page.tsx so the
 * __HATCHKIT_SOURCE_LOCALE__ and __HATCHKIT_TARGET_LOCALE__ versions cannot
 * drift apart: markup added here would appear in one language only. Add it
 * to the shared component instead.
 */

import { marketingMetadata } from "@/components/marketing/metadata";
import LandingPage from "@/components/marketing/pages/landing-page";

export const metadata = marketingMetadata({ locale: "__HATCHKIT_TARGET_LOCALE__", path: "/" });

export default function Page() {
  return <LandingPage locale="__HATCHKIT_TARGET_LOCALE__" />;
}
