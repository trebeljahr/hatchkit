import type { Metadata } from "next";
import { DEFAULT_SOCIAL_IMAGE, DEFAULT_TWITTER_IMAGE } from "@/lib/seo";

/** Shared by /imprint and /privacy. One address for provider information and
 *  privacy questions: plus-addresses on trebeljahr.com reach the operator. */
export const LEGAL_EMAIL = "imprint+hatchkit@trebeljahr.com";

export const OPERATOR_NAME = "Rico Trebeljahr";
export const OPERATOR_ADDRESS = [
  "c/o Block Services",
  "Stuttgarter Str. 106",
  "70736 Fellbach",
  "Germany",
] as const;

/** Footer and docs-sidebar links. Both pages are real routes outside the docs tree. */
export const LEGAL_LINKS = [
  { text: "Privacy", url: "/privacy" },
  { text: "Imprint", url: "/imprint" },
] as const;

/** Date shown at the top of /privacy and used as its sitemap date. Change it
 *  together with the page. */
export const PRIVACY_UPDATED_AT = "2026-10-19";

export function legalMetadata({
  title,
  path,
  description,
}: {
  title: string;
  path: string;
  description: string;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "article",
      url: path,
      title,
      description,
      images: [DEFAULT_SOCIAL_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [DEFAULT_TWITTER_IMAGE],
    },
  };
}
