import type { Config } from "@docusaurus/types";

/**
 * The docs are served from a path of the main domain, out of the web client's
 * own image: `scripts/docs/build-into-client.mjs` builds this site and copies
 * the result into the client's build output, so it ships at
 * `https://<domain>/docs/`. A folder of the main domain rather than a `docs.`
 * host keeps one site for search engines, and a folder of the client's image
 * rather than a second application needs no proxy routing at all.
 *
 * Both addresses below are LITERALS, and hatchkit rewrites them to the
 * project's own domain when it scaffolds or updates the project
 * (`hatchkit`: cli/src/features/docs-in-client — the transform anchors on the
 * exact shape of these two `const` lines, so keep them one string literal
 * each, on one line).
 *
 * The instinct, when reading this, is to make the address configurable again:
 * read it from `process.env.DOCS_SITE_URL`, fall back to a placeholder host,
 * and switch on `noIndex` for the fallback because a placeholder must not be
 * indexed. That is exactly what this file used to do, and it is the bug. One
 * build environment without the variable — the image build, which has almost
 * no environment — ships a site carrying `noindex` on every page, no sitemap
 * and a `Disallow: /` robots file. Nothing fails. Every page opens, every link
 * works, and the only symptom arrives months later as an absence from search
 * results. So: one address, written down, and indexing always on.
 *
 * The copy step audits the built tree and fails the build on any evidence to
 * the contrary — a `noindex` directive, a canonical link or a sitemap entry
 * outside the published prefix, or a robots file under the docs path. It runs
 * on pull requests too, so a docs address that drifts fails the change rather
 * than the deploy after merge.
 */
const siteUrl = "https://example.com";
const baseUrl = "/docs/";

const docsTitle = "Node Realtime Starter Docs";
const docsDescription =
  "Developer documentation for a production-ready Node realtime starter with Express, Next.js, WebSockets, auth, payments, and deployment workflows.";

const config: Config = {
  title: docsTitle,
  tagline: "A stampable starter for multiplayer web games and SaaS apps",
  url: siteUrl,
  baseUrl,
  // Same as the web app (`trailingSlash: true` in
  // packages/client/next.config.ts), so every page on the domain has one
  // address shape and the client's static server resolves `/docs/guide/` to
  // `guide/index.html` exactly as it resolves its own pages.
  trailingSlash: true,
  titleDelimiter: "·",
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",
  favicon: "img/favicon.svg",

  presets: [
    [
      "classic",
      {
        docs: {
          // The docs are the whole site: `baseUrl` already puts them under
          // `/docs/`, so there is no second path segment to add here.
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        // Written to `/docs/sitemap.xml`, and always written: the domain's one
        // robots.txt is the web app's (packages/client/src/app/robots.ts), and
        // it names this sitemap beside its own. That naming is the only way
        // the docs are discovered, so a build with no sitemap sends every
        // crawler that follows robots.txt to a dead end.
        //
        // No `lastmod`: Docusaurus reads it from git history, and the client
        // image builds from a context with no `.git` and no git binary. A git
        // binary with no repository around it fails the build outright, and a
        // missing one drops the field in the image while local builds keep it
        // — a sitemap that differs by where it was built is worse than one
        // with no dates. Crawlers treat lastmod as a hint and refetch anyway.
        sitemap: {
          lastmod: null,
          changefreq: "weekly",
          priority: 0.7,
        },
      },
    ],
  ],

  // No robots plugin. A host has exactly one robots.txt, the one served from
  // its root, and on this domain that one belongs to the web app. A second
  // file under `/docs/` is served and never requested, so whatever it allows
  // or disallows is a belief about the site that nothing acts on — which is
  // why the copy step fails the build when it finds one.

  themeConfig: {
    image: "img/social-card.png",
    metadata: [
      { name: "description", content: docsDescription },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: docsTitle },
      { property: "og:image:alt", content: docsTitle },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image:alt", content: docsTitle },
    ],
    navbar: {
      title: docsTitle,
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        // Back to the web app, which is the same domain but not this site —
        // an absolute href, because the router of neither site owns the other.
        { href: `${siteUrl}/`, label: "Home", position: "right", target: "_self" },
      ],
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
  },
};

export default config;
