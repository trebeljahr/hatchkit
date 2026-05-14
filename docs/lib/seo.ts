import { statSync } from "node:fs";
import { join } from "node:path";

export const SITE_URL = "https://hatchkit.trebeljahr.com";
export const SITE_NAME = "hatchkit";
export const SITE_DESCRIPTION =
  "Interactive CLI for scaffolding full-stack TypeScript projects with composable GPU-backed ML services on infrastructure you own.";
export const DEFAULT_SOCIAL_IMAGE = "/opengraph-image";
export const DEFAULT_TWITTER_IMAGE = "/twitter-image";

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
