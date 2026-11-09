import type { MetadataRoute } from "next";
import { siteSitemap } from "../lib/site/sitemap";

// Written once, at build time, as /sitemap.xml.
export const dynamic = "force-static";

/**
 * Every public page under app/, found at build time — lib/site/sitemap.ts
 * says what counts. This file is yours: hatchkit writes it only when there
 * is none.
 *
 * Pages the folder cannot list, such as one per `[slug]`, go in here:
 *
 *   return siteSitemap(posts.map((p) => ({ url: absoluteUrl(`/blog/${p.slug}/`) })));
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return siteSitemap();
}
