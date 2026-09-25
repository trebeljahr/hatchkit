/*
 * cli/src/features/docs-in-client/rules.ts — the indexing guarantees a built
 * docs tree has to satisfy before it may ship inside the client image.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * A docs site that is not indexed looks exactly like one that is. It
 * builds, it deploys, every page opens, every link works, and the only
 * symptom is that the pages never appear in a search result — months
 * later, with nothing in any log to point at.
 *
 * The configuration that produces it is the obvious one. A Docusaurus
 * config that reads its own address from an environment variable and falls
 * back to a placeholder (`process.env.DOCS_SITE_URL ?? "https://docs.example.com"`)
 * usually pairs that fallback with `noIndex: true`, a disabled sitemap and
 * a generated `Disallow: /` robots file — sensibly, because a placeholder
 * address must not be indexed. Forget to set the variable in one build
 * environment, which is the image build, and the shipped site carries all
 * three. Nothing fails. Hence the rule the whole feature is built on: the
 * docs address is a LITERAL and indexing is always on.
 *
 * ---------------------------------------------------------------------
 * Why the rules live in a list
 * ---------------------------------------------------------------------
 *
 * The same rules run in two places that cannot share code: here, in
 * TypeScript, driven by the tests; and inside the generated
 * `build-into-client.mjs`, which is plain JavaScript run by `node` inside
 * a Docker build with no TypeScript toolchain. Two hand-maintained copies
 * of a check drift, and a check that drifts is a check that stops failing.
 *
 * So each rule carries both: the TypeScript implementation the audit calls
 * and the JavaScript source that is rendered into the generated script,
 * plus a worked example that must trip it. `cli/test-docs-in-client.ts`
 * runs every example through both implementations and compares the
 * violations, so a change to one and not the other fails the suite instead
 * of shipping a script that silently passes everything.
 */

/** Stable identifiers for the four ways a docs tree can be unshippable.
 *  Stable because they are what a caller matches on and what a test
 *  asserts — the prose in `detail` may be reworded freely, these may not. */
export type DocsViolationCode =
  | "noindex"
  | "canonical-outside-prefix"
  | "sitemap-entry-outside-prefix"
  | "robots-under-docs-prefix";

/** Every code, in the order the rules run. */
export const DOCS_VIOLATION_CODES: readonly DocsViolationCode[] = [
  "noindex",
  "canonical-outside-prefix",
  "sitemap-entry-outside-prefix",
  "robots-under-docs-prefix",
];

/** One thing wrong with a built docs tree. */
export interface DocsViolation {
  /** Which rule fired. */
  code: DocsViolationCode;
  /** The file it fired on, relative to the docs tree root, POSIX
   *  separators. A rule with no file to blame (no sitemap at all) names
   *  the file it expected. */
  path: string;
  /** One sentence, addressed to whoever has to fix it, with no leading
   *  path — the formatter puts the path in front. */
  detail: string;
}

/** What the rules are handed.
 *
 *  `files` holds TEXT files only: the generated script skips anything that
 *  is not HTML, XML, JSON, TOML, Markdown, plain text or extensionless, so
 *  an image or a font is never read into memory or matched against. Every
 *  file any rule looks at is text. */
export interface DocsAuditInput {
  /** Relative path (POSIX separators) to file contents. */
  files: Record<string, string>;
  /** `https://example.com/docs/` — where the tree is published. Always
   *  with a trailing slash, because every check is a `startsWith`. */
  publishedPrefix: string;
}

/** A rule, in both languages, with the example that proves they agree. */
export interface DocsAuditRule {
  code: DocsViolationCode;
  /** Why this rule exists, in one or two sentences. Rendered into the
   *  generated script as the comment above its copy of the check, so the
   *  reason travels with the code into the project. */
  why: string;
  /** The TypeScript implementation. */
  check(input: DocsAuditInput): DocsViolation[];
  /** The same check as JavaScript source: one object literal, indented
   *  for the `RULES` array of the generated script. */
  js: string;
  /** A tree that is clean apart from this one defect. */
  example: DocsAuditInput;
  /** The files {@link example} must be blamed for, and nothing else. */
  expectedPaths: string[];
}

// ---------------------------------------------------------------------------
// Fixtures — the worked examples, shared by the rules and by the drift test
// ---------------------------------------------------------------------------

/** The domain the examples are published under. `.test` is reserved by
 *  RFC 2606, so no example can accidentally name a real site. */
export const EXAMPLE_PREFIX = "https://example.test/docs/";

/** A docs page as Docusaurus writes it: a canonical link under the
 *  published prefix and a robots meta that asks to be indexed. */
function examplePage(canonical: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="robots" content="index, follow">',
    `<link rel="canonical" href="${canonical}">`,
    "<title>Docs</title>",
    "</head><body><main>Docs</main></body></html>",
    "",
  ].join("\n");
}

/** A sitemap listing the given addresses. */
function exampleSitemap(locs: string[]): string {
  const urls = locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls}\n</urlset>\n`;
}

/** A tree that ships: two indexable pages, a sitemap covering both, no
 *  robots file, and a 404 page with no canonical (which is exempt — it is
 *  only ever served with a 404 status, and nothing indexes that).
 *
 *  Exported because the test asserts BOTH implementations pass it. A rule
 *  that fires on everything catches every defect and is still useless. */
export function cleanDocsTree(prefix: string = EXAMPLE_PREFIX): DocsAuditInput {
  return {
    publishedPrefix: prefix,
    files: {
      "index.html": examplePage(prefix),
      "guide/index.html": examplePage(`${prefix}guide/`),
      "404.html":
        '<!doctype html><html lang="en"><head><title>Not found</title></head><body></body></html>\n',
      "sitemap.xml": exampleSitemap([prefix, `${prefix}guide/`]),
    },
  };
}

/** The clean tree, with one file replaced or added. */
function treeWith(overrides: Record<string, string>, prefix = EXAMPLE_PREFIX): DocsAuditInput {
  const base = cleanDocsTree(prefix);
  return { publishedPrefix: prefix, files: { ...base.files, ...overrides } };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Robots directives in a page's head, in any of the three spellings that
 *  reach a crawler: `name="robots"`, a bot-specific `name="googlebot"`, and
 *  the `http-equiv` form of the `X-Robots-Tag` header. */
const ROBOTS_META =
  /<meta[^>]*(?:name=["'](?:robots|googlebot)["']|http-equiv=["']x-robots-tag["'])[^>]*>/gi;

/** An `X-Robots-Tag: noindex` line in a headers file (`_headers`,
 *  `vercel.json`, a Caddy or nginx snippet copied into the tree). */
const ROBOTS_HEADER_LINE = /^[^\n]*x-robots-tag[^\n]*noindex/im;

const CANONICAL_LINK = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i;

/** Pages that are exempt from the canonical rule. A 404 page is served
 *  with a 404 status, which no crawler indexes, and Docusaurus gives it a
 *  canonical of its own file path. */
const UNINDEXED_PAGES = new Set(["404.html", "404/index.html"]);

/** `sitemap.xml`, `sitemap-0.xml`, `sitemap-index.xml`, at any depth. */
const SITEMAP_FILE = /(^|\/)sitemap[^/]*\.xml$/;

export const DOCS_AUDIT_RULES: readonly DocsAuditRule[] = [
  {
    code: "noindex",
    why:
      "A single noindex directive removes the page from every search engine, " +
      "and nothing about the served page looks wrong. It arrives by accident: " +
      "a docs config that falls back to a placeholder address turns indexing " +
      "off along with it, so one unset variable in the image build ships the " +
      "whole site unindexable.",
    check({ files }) {
      const out: DocsViolation[] = [];
      for (const path of Object.keys(files)) {
        const contents = files[path];
        if (path.endsWith(".html")) {
          const tag = (contents.match(ROBOTS_META) ?? []).find((t) => /noindex/i.test(t));
          if (tag) {
            out.push({
              code: "noindex",
              path,
              detail: `carries ${tag.trim()}, which asks search engines not to index it`,
            });
          }
          continue;
        }
        if (ROBOTS_HEADER_LINE.test(contents)) {
          out.push({
            code: "noindex",
            path,
            detail: "sets an X-Robots-Tag noindex header over the docs tree",
          });
        }
      }
      return out;
    },
    js: `  {
    // A single noindex directive removes the page from every search engine,
    // and nothing about the served page looks wrong. It arrives by accident:
    // a docs config that falls back to a placeholder address turns indexing
    // off along with it, so one unset variable in this build ships the whole
    // site unindexable.
    code: "noindex",
    check({ files }) {
      const robotsMeta = /<meta[^>]*(?:name=["'](?:robots|googlebot)["']|http-equiv=["']x-robots-tag["'])[^>]*>/gi;
      const headerLine = /^[^\\n]*x-robots-tag[^\\n]*noindex/im;
      const out = [];
      for (const path of Object.keys(files)) {
        const contents = files[path];
        if (path.endsWith(".html")) {
          const tag = (contents.match(robotsMeta) || []).find((t) => /noindex/i.test(t));
          if (tag) {
            out.push({
              code: "noindex",
              path,
              detail: "carries " + tag.trim() + ", which asks search engines not to index it",
            });
          }
          continue;
        }
        if (headerLine.test(contents)) {
          out.push({
            code: "noindex",
            path,
            detail: "sets an X-Robots-Tag noindex header over the docs tree",
          });
        }
      }
      return out;
    },
  },`,
    example: treeWith({
      "guide/index.html": examplePage(`${EXAMPLE_PREFIX}guide/`).replace(
        '<meta name="robots" content="index, follow">',
        '<meta name="robots" content="noindex, nofollow">',
      ),
    }),
    expectedPaths: ["guide/index.html"],
  },
  {
    code: "canonical-outside-prefix",
    why:
      "A canonical link pointing somewhere else hands the page's ranking to " +
      "that address, and an address that does not exist gets nothing. It is " +
      "what a docs build produces when it was given the wrong site URL or the " +
      "wrong base path — the pages still serve correctly from the right place.",
    check({ files, publishedPrefix }) {
      const out: DocsViolation[] = [];
      for (const path of Object.keys(files)) {
        if (!path.endsWith(".html") || UNINDEXED_PAGES.has(path)) continue;
        const href = files[path].match(CANONICAL_LINK)?.[1];
        if (!href) {
          out.push({
            code: "canonical-outside-prefix",
            path,
            detail: "has no canonical link, so a crawler picks the address it happens to find",
          });
          continue;
        }
        if (!href.startsWith(publishedPrefix)) {
          out.push({
            code: "canonical-outside-prefix",
            path,
            detail: `points its canonical at ${href}, which is not under ${publishedPrefix}`,
          });
        }
      }
      return out;
    },
    js: `  {
    // A canonical link pointing somewhere else hands the page's ranking to
    // that address, and an address that does not exist gets nothing. It is
    // what a docs build produces when it was given the wrong site URL or the
    // wrong base path — the pages still serve correctly from the right place.
    code: "canonical-outside-prefix",
    check({ files, publishedPrefix }) {
      const canonical = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i;
      // A 404 page is only ever served with a 404 status, which nothing
      // indexes, and the generator gives it a canonical of its own file path.
      const exempt = new Set(["404.html", "404/index.html"]);
      const out = [];
      for (const path of Object.keys(files)) {
        if (!path.endsWith(".html") || exempt.has(path)) continue;
        const match = files[path].match(canonical);
        const href = match && match[1];
        if (!href) {
          out.push({
            code: "canonical-outside-prefix",
            path,
            detail: "has no canonical link, so a crawler picks the address it happens to find",
          });
          continue;
        }
        if (!href.startsWith(publishedPrefix)) {
          out.push({
            code: "canonical-outside-prefix",
            path,
            detail: "points its canonical at " + href + ", which is not under " + publishedPrefix,
          });
        }
      }
      return out;
    },
  },`,
    example: treeWith({
      "guide/index.html": examplePage("https://docs.example.test/guide/"),
    }),
    expectedPaths: ["guide/index.html"],
  },
  {
    code: "sitemap-entry-outside-prefix",
    why:
      "The domain's robots.txt points crawlers at the docs sitemap, so the " +
      "sitemap is how the docs are discovered at all. One that lists another " +
      "host, or lists nothing, or was never written because the generator " +
      "turned sitemaps off along with indexing, sends every crawler that " +
      "follows robots.txt to a dead end.",
    check({ files, publishedPrefix }) {
      const out: DocsViolation[] = [];
      const sitemaps = Object.keys(files).filter((path) => SITEMAP_FILE.test(path));
      if (sitemaps.length === 0) {
        return [
          {
            code: "sitemap-entry-outside-prefix",
            path: "sitemap.xml",
            detail: `was never written, and the domain's robots.txt points crawlers at ${publishedPrefix}sitemap.xml`,
          },
        ];
      }
      let entries = 0;
      for (const path of sitemaps) {
        const locs = [...files[path].matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
        entries += locs.length;
        for (const loc of locs) {
          if (loc.startsWith(publishedPrefix)) continue;
          out.push({
            code: "sitemap-entry-outside-prefix",
            path,
            detail: `lists ${loc}, which is not under ${publishedPrefix}`,
          });
        }
      }
      if (entries === 0) {
        out.push({
          code: "sitemap-entry-outside-prefix",
          path: sitemaps[0],
          detail: "lists no pages at all",
        });
      }
      return out;
    },
    js: `  {
    // The domain's robots.txt points crawlers at the docs sitemap, so the
    // sitemap is how the docs are discovered at all. One that lists another
    // host, or lists nothing, or was never written because the generator
    // turned sitemaps off along with indexing, sends every crawler that
    // follows robots.txt to a dead end.
    code: "sitemap-entry-outside-prefix",
    check({ files, publishedPrefix }) {
      const sitemapFile = /(^|\\/)sitemap[^/]*\\.xml$/;
      const out = [];
      const sitemaps = Object.keys(files).filter((path) => sitemapFile.test(path));
      if (sitemaps.length === 0) {
        return [
          {
            code: "sitemap-entry-outside-prefix",
            path: "sitemap.xml",
            detail:
              "was never written, and the domain's robots.txt points crawlers at " +
              publishedPrefix +
              "sitemap.xml",
          },
        ];
      }
      let entries = 0;
      for (const path of sitemaps) {
        const locs = [...files[path].matchAll(/<loc>([^<]+)<\\/loc>/g)].map((m) => m[1].trim());
        entries += locs.length;
        for (const loc of locs) {
          if (loc.startsWith(publishedPrefix)) continue;
          out.push({
            code: "sitemap-entry-outside-prefix",
            path,
            detail: "lists " + loc + ", which is not under " + publishedPrefix,
          });
        }
      }
      if (entries === 0) {
        out.push({
          code: "sitemap-entry-outside-prefix",
          path: sitemaps[0],
          detail: "lists no pages at all",
        });
      }
      return out;
    },
  },`,
    example: treeWith({
      "sitemap.xml": exampleSitemap([EXAMPLE_PREFIX, "https://example.test/guide/"]),
    }),
    expectedPaths: ["sitemap.xml"],
  },
  {
    code: "robots-under-docs-prefix",
    why:
      "A domain has exactly one robots.txt, the one served from its root, and " +
      "that one belongs to the web app. A second file under the docs path is " +
      "never read by a crawler, so whatever it allows or disallows is a " +
      "belief about the site that is not true — and the generator writes a " +
      "`Disallow: /` one by default when it thinks its address is a " +
      "placeholder.",
    check({ files }) {
      return Object.keys(files)
        .filter((path) => path === "robots.txt" || path.endsWith("/robots.txt"))
        .map((path) => ({
          code: "robots-under-docs-prefix" as const,
          path,
          detail: "is not served to anyone: the domain's robots.txt is the web app's",
        }));
    },
    js: `  {
    // A domain has exactly one robots.txt, the one served from its root, and
    // that one belongs to the web app. A second file under the docs path is
    // never read by a crawler, so whatever it allows or disallows is a belief
    // about the site that is not true — and the generator writes a
    // "Disallow: /" one by default when it thinks its address is a placeholder.
    code: "robots-under-docs-prefix",
    check({ files }) {
      return Object.keys(files)
        .filter((path) => path === "robots.txt" || path.endsWith("/robots.txt"))
        .map((path) => ({
          code: "robots-under-docs-prefix",
          path,
          detail: "is not served to anyone: the domain's robots.txt is the web app's",
        }));
    },
  },`,
    example: treeWith({ "robots.txt": "User-agent: *\nDisallow: /\n" }),
    expectedPaths: ["robots.txt"],
  },
];

/** The `RULES` array of the generated script, rendered from the same list
 *  the audit runs. The script cannot import TypeScript, so this is the only
 *  thing keeping the two copies in step — with the drift test as the proof
 *  that they still agree. */
export function renderRulesArray(): string {
  const bodies = DOCS_AUDIT_RULES.map((rule) => rule.js).join("\n");
  return `const RULES = [\n${bodies}\n];`;
}
