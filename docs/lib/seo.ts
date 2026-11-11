import { statSync } from "node:fs";
import { join } from "node:path";

/** Canonical origin used for `metadata.metadataBase`, the sitemap, and
 *  every `absoluteUrl()` call. Forks override via
 *  `NEXT_PUBLIC_SITE_URL` (e.g. in `docs/.env.production`). The fallback
 *  points at this repo's published docs so a local `pnpm dev` still
 *  produces sensible canonical URLs without any env wiring. */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://hatchkit.trebeljahr.com";
export const SITE_NAME = "hatchkit";
export const SITE_DESCRIPTION =
  "Interactive CLI for scaffolding full-stack TypeScript projects with composable GPU-backed ML services on infrastructure you own.";
// The link preview: docs/app/opengraph-image.jpg and twitter-image.jpg (file
// convention), the og-wordmark card in docs/marketing/social-preview as JPEG.
// Pages that set their own openGraph/twitter name them, or they lose them.
export const SOCIAL_IMAGE_ALT =
  "hatchkit logo and the line Automates the drudgery of starting a new project, beside hatchkit create wired to nine services: repo, DNS, server, app, error tracking, analytics, email, backups and secrets";
export const DEFAULT_SOCIAL_IMAGE = {
  url: "/opengraph-image.jpg",
  type: "image/jpeg",
  width: 1200,
  height: 630,
  alt: SOCIAL_IMAGE_ALT,
};
export const DEFAULT_TWITTER_IMAGE = { ...DEFAULT_SOCIAL_IMAGE, url: "/twitter-image.jpg" };

const FALLBACK_LAST_MODIFIED = new Date("2026-05-14T00:00:00.000Z");

export function absoluteUrl(pathname: string): string {
  return new URL(pathname, SITE_URL).toString();
}

export function docDescription(description: string | undefined, title: string): string {
  const trimmed = description?.trim();
  if (trimmed) return trimmed;
  return `${title} documentation for hatchkit, the CLI for scaffolding, provisioning, and deploying full-stack TypeScript apps on infrastructure you own.`;
}

export function docSourcePath(slug: string[] | undefined): string {
  const file = slug && slug.length > 0 ? `${slug.join("/")}.mdx` : "index.mdx";
  return join(process.cwd(), "content", "docs", file);
}

export function lastModifiedForFile(pathname: string): Date {
  try {
    return statSync(pathname).mtime;
  } catch {
    return FALLBACK_LAST_MODIFIED;
  }
}

export function lastModifiedForDoc(slug: string[] | undefined): Date {
  return lastModifiedForFile(docSourcePath(slug));
}
