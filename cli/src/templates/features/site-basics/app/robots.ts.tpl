import type { MetadataRoute } from "next";
import { SITE } from "../lib/site/config";

// Written once, at build time, as /robots.txt.
export const dynamic = "force-static";

/**
 * The domain's one robots file. A crawler reads only the one at the root, so
 * every sitemap the domain has is named here. This file is yours: hatchkit
 * writes it only when there is none.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: [`${SITE.url}/sitemap.xml`],
  };
}
