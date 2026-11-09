/**
 * Search and analytics basics in the starter's web client.
 *
 * The failure these encode, found live on deployed starter apps on
 * 2026-11-10: a title and a meta description and nothing else. No sitemap
 * (two robots files named sitemaps that answered 404), no canonical URL, no
 * Open Graph or Twitter card, no structured data, no analytics — and one
 * app still titled "My App" in production.
 *
 * The properties that keep it from coming back:
 *   1. Applied to the starter's own client, the module writes the owned
 *      `lib/site/` modules, a sitemap and a robots route, a default social
 *      card, and wires the root layout — and the generated config carries
 *      the manifest's domain, name and description.
 *   2. The layout edit is pinned on the starter's REAL layout (read from
 *      `starter/`, never restated): the placeholders go, the starter's
 *      inline Plausible tracker stays the only one, and the result parses.
 *   3. Every layout edit is a fixed point, on the starter and on the
 *      hand-edited shapes deployed apps actually have.
 *   4. The generated code RUNS and says the right thing: canonical "./"
 *      (never a literal "/", which every page would inherit), a complete
 *      social card from `pageMetadata()`, a JSON-LD graph with the app node
 *      only for apps, and a sitemap read off the app directory that leaves
 *      out private, dynamic, sign-in and noindex pages.
 *   5. A robots or sitemap file the project already has is left alone; a
 *      robots file that names no sitemap gets a note. The one-sitemap robots
 *      route hatchkit writes is replaced by docs-in-client's when docs
 *      arrive later.
 *   6. The ledger invariants `update` relies on: a second apply writes
 *      nothing, and a dry run leaves the disk as it was.
 *   7. The social card is a valid 1200×630 PNG with the app icon on it.
 *
 * Run: `pnpm exec tsx test-site-basics.ts`
 */
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "site-basics-conf-"));

const {
  SITE_BASICS_OWNED_FILES,
  SITE_BASICS_TEMPLATE_DIR,
  applySiteBasics,
  decodePng,
  encodePngRgb,
  renderSiteBasicsFile,
  renderSiteBasicsRobotsRoute,
  renderSocialCard,
  siteIdentity,
  wireSiteBasicsInLayout,
} = await import("./src/features/site-basics/index.js");
const { applyOperationalLayer } = await import("./src/features/operational.js");
const { FeatureLedger } = await import("./src/features/contract.js");
const { findUnrenderedTokens, listFeatureTemplates } = await import("./src/features/templates.js");
type OperationalContext = import("./src/features/operational-context.js").OperationalContext;
type OperationalProject = import("./src/features/operational-context.js").OperationalProject;

const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER = join(HERE, "..", "starter");
const STARTER_CLIENT = join(STARTER, "packages", "client");
const STARTER_LAYOUT = readFileSync(join(STARTER_CLIENT, "src/app/layout.tsx"), "utf-8");
const tmp = mkdtempSync(join(tmpdir(), "site-basics-"));

const PROJECT: OperationalProject = {
  name: "demo-app",
  domain: "demo.example.com",
  description: "Plan the week in one place.",
  topology: "single-origin",
  surfaces: "fullstack",
  features: ["mobile"],
};
const IDENTIFIERS = {
  ...(await import("./src/scaffold/identifiers.js")).resolveIdentifiers({
    name: "demo-app",
    productName: "Demo App",
  }),
};

/** A project with the starter's real client: layout, next.config, app
 *  tree, web manifest, and the icon source. */
function starterProject(name: string): string {
  const dir = join(tmp, name);
  const client = join(dir, "packages", "client");
  mkdirSync(client, { recursive: true });
  for (const file of ["package.json", "next.config.ts"]) {
    cpSync(join(STARTER_CLIENT, file), join(client, file));
  }
  cpSync(join(STARTER_CLIENT, "public"), join(client, "public"), { recursive: true });
  cpSync(join(STARTER_CLIENT, "src", "app"), join(client, "src", "app"), { recursive: true });
  mkdirSync(join(dir, "resources"), { recursive: true });
  cpSync(join(STARTER, "resources", "icon.png"), join(dir, "resources", "icon.png"));
  return dir;
}

function context(
  dir: string,
  opts: { dryRun?: boolean; force?: boolean; project?: Partial<OperationalProject> } = {},
): OperationalContext {
  return {
    projectDir: dir,
    project: { ...PROJECT, ...opts.project },
    identifiers: IDENTIFIERS,
    mode: "update",
    ledger: new FeatureLedger(dir, opts.dryRun === true),
    log: () => undefined,
    force: opts.force,
  };
}

function written(ctx: OperationalContext): string[] {
  return ctx.ledger.summary().written;
}

/** Syntax errors only: the generated files import `next` and React, which
 *  this package does not have, so a full typecheck belongs to a real build. */
function syntaxErrors(source: string, fileName: string): string[] {
  const out = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const SRC = "packages/client/src";

// ---------------------------------------------------------------------------
console.log("\nthe starter's client, through the real ledger\n");
// ---------------------------------------------------------------------------

const starterDir = starterProject("starter");
const first = context(starterDir);
const outcome = applySiteBasics(first);

await check("owned modules, both routes and the social card are written", () => {
  const expected = [
    ...SITE_BASICS_OWNED_FILES.map((f) => `${SRC}/${f}`),
    `${SRC}/app/sitemap.ts`,
    `${SRC}/app/robots.ts`,
    "packages/client/public/og.png",
    `${SRC}/app/layout.tsx`,
  ];
  assert.deepEqual([...written(first)].sort(), expected.sort());
  assert.equal(outcome.skipped, undefined);
});

await check("the config carries the manifest's domain, product name and description", () => {
  const config = readFileSync(join(starterDir, SRC, "lib/site/config.ts"), "utf-8");
  assert.match(config, /^ {2}url: "https:\/\/demo\.example\.com",$/m);
  assert.match(config, /^ {2}name: "Demo App",$/m);
  assert.match(config, /^ {2}description: "Plan the week in one place\.",$/m);
  assert.match(config, /^ {2}kind: "app",$/m);
  assert.match(config, /^ {2}operatingSystems: \["Web", "iOS", "Android"\],$/m);
});

await check("the sitemap module reads the starter's src/app with its trailing slash", () => {
  const sitemap = readFileSync(join(starterDir, SRC, "lib/site/sitemap.ts"), "utf-8");
  assert.match(sitemap, /process\.cwd\(\), "src\/app"\);/);
  assert.match(sitemap, /^const TRAILING_SLASH = true;$/m);
});

await check("every shipped template renders with no token left over", () => {
  const identity = siteIdentity(PROJECT, IDENTIFIERS);
  for (const file of SITE_BASICS_OWNED_FILES) {
    const rendered = renderSiteBasicsFile(file, identity, {
      appDir: "src/app",
      trailingSlash: true,
    });
    assert.deepEqual(findUnrenderedTokens(rendered), [], file);
  }
  const templates = listFeatureTemplates(SITE_BASICS_TEMPLATE_DIR);
  assert.deepEqual(templates, [
    "app/robots.ts.tpl",
    "app/sitemap.ts.tpl",
    ...SITE_BASICS_OWNED_FILES.map((f) => `${f}.tpl`).sort(),
  ]);
});

await check("every generated file parses", () => {
  for (const rel of [
    ...SITE_BASICS_OWNED_FILES.map((f) => `${SRC}/${f}`),
    `${SRC}/app/sitemap.ts`,
    `${SRC}/app/robots.ts`,
    `${SRC}/app/layout.tsx`,
  ]) {
    const source = readFileSync(join(starterDir, rel), "utf-8");
    assert.deepEqual(syntaxErrors(source, rel), [], rel);
  }
});

const wiredLayout = readFileSync(join(starterDir, SRC, "app/layout.tsx"), "utf-8");

await check("the starter's placeholder title and description are gone", () => {
  assert.doesNotMatch(wiredLayout, /My App/);
  assert.doesNotMatch(wiredLayout, /A full-stack web application/);
  assert.match(wiredLayout, /^export const metadata: Metadata = withSiteMetadata\(\);$/m);
});

await check("the layout imports through the @/ alias the starter uses", () => {
  assert.match(wiredLayout, /^import \{ withSiteMetadata \} from "@\/lib\/site\/metadata";$/m);
  assert.match(wiredLayout, /^import \{ SiteJsonLd \} from "@\/lib\/site\/json-ld";$/m);
  // Imports stay in the import block: after the last one the starter had.
  const lines = wiredLayout.split("\n");
  const css = lines.indexOf('import "@/styles/globals.css";');
  assert.ok(css !== -1 && lines[css + 1].startsWith("import { withSiteMetadata }"));
});

await check("<SiteJsonLd /> is the first child of <body>, outside every comment", () => {
  assert.match(
    wiredLayout,
    /<body className="min-h-screen bg-background font-sans antialiased">\n {8}<SiteJsonLd \/>\n/,
  );
  assert.equal(wiredLayout.match(/<SiteJsonLd \/>/g)?.length, 1);
});

await check("the starter's inline tracker stays the only Plausible tracker", () => {
  assert.doesNotMatch(wiredLayout, /PlausibleScript/);
  assert.equal(wiredLayout.match(/NEXT_PUBLIC_PLAUSIBLE_DOMAIN \?/g)?.length, 1);
});

await check("outside the three edits, the starter's layout is unchanged", () => {
  const undo = wiredLayout
    .replace('import { withSiteMetadata } from "@/lib/site/metadata";\n', "")
    .replace('import { SiteJsonLd } from "@/lib/site/json-ld";\n', "")
    .replace("\n        <SiteJsonLd />", "")
    .replace(
      "withSiteMetadata();",
      '{\n  title: {\n    default: "My App",\n    template: "%s | My App",\n  },\n  description: "A full-stack web application",\n};',
    );
  assert.equal(undo, STARTER_LAYOUT);
});

await check("a second apply writes nothing", () => {
  const again = context(starterDir);
  applySiteBasics(again);
  assert.equal(again.ledger.touched, false, JSON.stringify(again.ledger.summary()));
});

await check("a dry run on a fresh project says what it would write and writes nothing", () => {
  const dir = starterProject("dry");
  const before = readFileSync(join(dir, SRC, "app/layout.tsx"), "utf-8");
  const dry = context(dir, { dryRun: true });
  applySiteBasics(dry);
  assert.equal(dry.ledger.summary()["would-write"].length, written(first).length);
  assert.equal(existsSync(join(dir, SRC, "lib/site")), false);
  assert.equal(existsSync(join(dir, "packages/client/public/og.png")), false);
  assert.equal(readFileSync(join(dir, SRC, "app/layout.tsx"), "utf-8"), before);
});

await check("the operational layer runs it, after docs-in-client", () => {
  const dir = starterProject("layer");
  const result = applyOperationalLayer({
    projectDir: dir,
    project: PROJECT,
    identifiers: IDENTIFIERS,
    mode: "create",
    only: ["docs-in-client", "site-basics"],
  });
  const ids = result.modules.map((m) => m.id);
  assert.deepEqual(ids, ["docs-in-client", "site-basics"]);
  assert.ok(existsSync(join(dir, SRC, "lib/site/config.ts")));
});

// ---------------------------------------------------------------------------
console.log("\nthe generated code, executed\n");
// ---------------------------------------------------------------------------

/** Import a generated module from the starter project. tsx strips the
 *  type-only `next` imports, so the code runs here unchanged. */
async function load<T>(rel: string): Promise<T> {
  return (await import(pathToFileURL(join(starterDir, SRC, rel)).href)) as T;
}

type MetadataModule = {
  withSiteMetadata: (own?: Record<string, unknown>) => Record<string, any>;
  pageMetadata: (page?: Record<string, unknown>) => Record<string, any>;
};
const meta = await load<MetadataModule>("lib/site/metadata.ts");

await check("root metadata: own origin, per-page canonical, complete social card", () => {
  const m = meta.withSiteMetadata();
  assert.equal(String(m.metadataBase), "https://demo.example.com/");
  assert.deepEqual(m.title, { default: "Demo App", template: "%s | Demo App" });
  assert.equal(m.description, "Plan the week in one place.");
  // "./" resolves per page. A literal "/" would make every page that sets
  // no canonical of its own claim to be the home page.
  assert.equal(m.alternates.canonical, "./");
  assert.equal(m.openGraph.url, "./");
  assert.equal(m.openGraph.siteName, "Demo App");
  assert.equal(m.openGraph.type, "website");
  assert.deepEqual(m.openGraph.images, [
    { url: "/og.png", width: 1200, height: 630, alt: "Demo App" },
  ]);
  assert.equal(m.twitter.card, "summary_large_image");
  assert.deepEqual(m.twitter.images, ["/og.png"]);
});

await check("root metadata: every field the layout sets wins, the card follows its title", () => {
  const m = meta.withSiteMetadata({
    title: { default: "Scales practice", template: "%s · Scales" },
    description: "Short drills.",
    openGraph: { locale: "en_GB" },
    manifest: "/manifest.json",
  });
  assert.deepEqual(m.title, { default: "Scales practice", template: "%s · Scales" });
  assert.equal(m.openGraph.title, "Scales practice");
  assert.equal(m.openGraph.description, "Short drills.");
  assert.equal(m.openGraph.locale, "en_GB");
  assert.equal(m.openGraph.images[0].url, "/og.png", "a partial openGraph keeps the image");
  assert.equal(m.twitter.description, "Short drills.");
  assert.equal(m.manifest, "/manifest.json");
});

await check("pageMetadata: the whole card, never a partial one the merge would lose", () => {
  const m = meta.pageMetadata({ title: "Pricing", description: "What it costs." });
  assert.equal(m.title, "Pricing");
  assert.equal(m.alternates.canonical, "./");
  assert.equal(m.openGraph.title, "Pricing");
  assert.equal(m.openGraph.siteName, "Demo App");
  assert.equal(m.openGraph.url, "./");
  assert.equal(m.openGraph.images[0].url, "/og.png");
  assert.equal(m.twitter.title, "Pricing");
  assert.equal(m.robots, undefined);
  const hidden = meta.pageMetadata({ noIndex: true, image: "/cards/x.png", canonical: "/a/" });
  assert.deepEqual(hidden.robots, { index: false, follow: true });
  assert.deepEqual(hidden.openGraph.images, [{ url: "/cards/x.png" }]);
  assert.equal(hidden.alternates.canonical, "/a/");
  assert.equal(hidden.description, undefined, "no description of its own: the layout's applies");
});

type StructuredModule = {
  siteStructuredData: (o?: Record<string, unknown>) => { "@graph": Array<Record<string, any>> };
  jsonLdText: (d: Record<string, unknown>) => string;
};
const sd = await load<StructuredModule>("lib/site/structured-data.ts");

await check("JSON-LD: WebSite + Organization + SoftwareApplication, linked by @id", () => {
  const graph = sd.siteStructuredData()["@graph"];
  assert.deepEqual(
    graph.map((n) => n["@type"]),
    ["WebSite", "Organization", "SoftwareApplication"],
  );
  const [site, org, app] = graph;
  assert.equal(site.url, "https://demo.example.com/");
  assert.equal(site.publisher["@id"], org["@id"]);
  assert.equal(app.publisher["@id"], org["@id"]);
  assert.equal(app.operatingSystem, "Web, iOS, Android");
  assert.equal(app.description, "Plan the week in one place.");
  // No invented ratings or prices.
  assert.equal(app.offers, undefined);
  assert.equal(app.aggregateRating, undefined);
});

await check("JSON-LD: options merge, `application: false` drops the app node", () => {
  const graph = sd.siteStructuredData({
    organization: { logo: "https://demo.example.com/logo.png" },
    application: false,
  })["@graph"];
  assert.equal(graph.length, 2);
  assert.equal(graph[1].logo, "https://demo.example.com/logo.png");
});

await check("JSON-LD text cannot close its own script element", () => {
  const text = sd.jsonLdText({ name: "</script><script>alert(1)</script>" });
  assert.doesNotMatch(text, /<\/script>/i);
  assert.equal(JSON.parse(text).name, "</script><script>alert(1)</script>");
});

await check("a static site with no shell is a site: no app node", () => {
  const identity = siteIdentity({ ...PROJECT, surfaces: "static", features: [] }, IDENTIFIERS);
  assert.equal(identity.kind, "site");
  assert.deepEqual(identity.operatingSystems, ["Web"]);
  const shell = siteIdentity({ ...PROJECT, surfaces: "static", features: ["desktop"] });
  assert.equal(shell.kind, "app");
  assert.deepEqual(shell.operatingSystems, ["Web", "macOS", "Windows", "Linux"]);
});

type SitemapModule = {
  publicRoutes: (appDir?: string) => string[];
  absoluteUrl: (path: string) => string;
};
const sitemap = await load<SitemapModule>("lib/site/sitemap.ts");

await check("the starter's own sitemap is its landing page alone", () => {
  // (protected) is private, sign-in pages are left out, and the newsletter
  // pages say `index: false`.
  assert.deepEqual(sitemap.publicRoutes(join(starterDir, SRC, "app")), ["/"]);
});

await check("the sitemap follows the app directory's rules", () => {
  const app = join(tmp, "routes", "app");
  const page = (rel: string, body = "export default function P() { return null; }\n"): void => {
    mkdirSync(join(app, rel), { recursive: true });
    writeFileSync(join(app, rel, "page.tsx"), body);
  };
  page("");
  page("pricing");
  page("(marketing)/about");
  page("(protected)/dashboard");
  page("blog/[slug]");
  page("_drafts/x");
  page("@modal/login");
  page("(.)photo");
  page("login");
  page("quiet", 'export const metadata = pageMetadata({ title: "Q", noIndex: true });\n');
  page("legal/terms");
  writeFileSync(
    join(app, "legal", "layout.tsx"),
    "export const metadata = { robots: { index: false } };\n",
  );
  page("docs");
  page("docs/guide");
  assert.deepEqual(sitemap.publicRoutes(app), [
    "/",
    "/about/",
    "/docs/",
    "/docs/guide/",
    "/pricing/",
  ]);
  assert.equal(sitemap.absoluteUrl("/pricing/"), "https://demo.example.com/pricing/");
});

await check("without trailingSlash the sitemap's URLs have none", () => {
  const identity = siteIdentity(PROJECT, IDENTIFIERS);
  const dir = join(tmp, "no-slash", "lib", "site");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.ts"),
    renderSiteBasicsFile("lib/site/config.ts", identity, { appDir: "app", trailingSlash: false }),
  );
  writeFileSync(
    join(dir, "sitemap.ts"),
    renderSiteBasicsFile("lib/site/sitemap.ts", identity, { appDir: "app", trailingSlash: false }),
  );
  return import(pathToFileURL(join(dir, "sitemap.ts")).href).then((mod: SitemapModule) => {
    assert.deepEqual(mod.publicRoutes(join(tmp, "routes", "app")), [
      "/",
      "/about",
      "/docs",
      "/docs/guide",
      "/pricing",
    ]);
  });
});

// ---------------------------------------------------------------------------
console.log("\nlayouts deployed apps actually have\n");
// ---------------------------------------------------------------------------

const WITH_DESCRIPTION = { importBase: "@/lib/site", replaceDescription: true };

await check("a custom title is kept; the placeholder description goes only with a real one", () => {
  const layout = STARTER_LAYOUT.replace('default: "My App"', 'default: "Ledgerly"').replace(
    'template: "%s | My App"',
    'template: "%s | Ledgerly"',
  );
  const out = wireSiteBasicsInLayout(layout, WITH_DESCRIPTION).content;
  assert.match(out, /withSiteMetadata\(\{\n {2}title: \{\n {4}default: "Ledgerly",/);
  assert.doesNotMatch(out, /A full-stack web application/);
  const kept = wireSiteBasicsInLayout(layout, { ...WITH_DESCRIPTION, replaceDescription: false });
  assert.match(kept.content, /description: "A full-stack web application",\n\}\);/);
});

const NO_HEAD_LAYOUT = `import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  metadataBase: new URL("https://scales.example.com"),
  title: {
    default: "Scales practice",
    template: "%s · Scales",
  },
  description:
    "Short drills. Don't {worry} about braces in strings }",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = { themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
`;

await check("no <head> and no tracker: the tracker goes into <body>, the object is kept", () => {
  const { content, blocked } = wireSiteBasicsInLayout(NO_HEAD_LAYOUT, WITH_DESCRIPTION);
  assert.deepEqual(blocked, []);
  assert.match(content, /<body>\n {8}<PlausibleScript \/>\n {8}<SiteJsonLd \/>\n {8}<AppShell>/);
  assert.match(content, /^import \{ PlausibleScript \} from "@\/lib\/site\/plausible";$/m);
  assert.match(
    content,
    /export const metadata: Metadata = withSiteMetadata\(\{\n {2}metadataBase: new URL\("https:\/\/scales\.example\.com"\),[\s\S]*?\n\}\);\n\nexport const viewport/,
  );
  assert.deepEqual(syntaxErrors(content, "layout.tsx"), []);
});

const BARE_LAYOUT = `import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body>{children}</body>
    </html>
  );
}
`;

await check("no metadata export and no alias: one is added, imported relatively", () => {
  const { content } = wireSiteBasicsInLayout(BARE_LAYOUT, {
    importBase: "../lib/site",
    replaceDescription: true,
  });
  assert.match(content, /^export const metadata = withSiteMetadata\(\);\n\nexport default/m);
  assert.match(content, /^import \{ withSiteMetadata \} from "\.\.\/lib\/site\/metadata";$/m);
  assert.match(
    content,
    /<body>\n {8}<SiteJsonLd \/>\{children\}<\/body>|<body>\n\s*<SiteJsonLd \/>/,
  );
  assert.deepEqual(syntaxErrors(content, "layout.tsx"), []);
});

await check("generateMetadata is left alone, with a reason", () => {
  const layout = BARE_LAYOUT.replace(
    "export default",
    "export async function generateMetadata() { return {}; }\n\nexport default",
  );
  const { content, blocked } = wireSiteBasicsInLayout(layout, WITH_DESCRIPTION);
  assert.doesNotMatch(content, /withSiteMetadata/);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /generateMetadata/);
});

await check("every layout edit is a fixed point", () => {
  for (const layout of [STARTER_LAYOUT, NO_HEAD_LAYOUT, BARE_LAYOUT]) {
    for (const replaceDescription of [true, false]) {
      const options = { importBase: "@/lib/site", replaceDescription };
      const once = wireSiteBasicsInLayout(layout, options).content;
      const twice = wireSiteBasicsInLayout(once, options);
      assert.equal(twice.changed, false);
      assert.equal(twice.content, once);
    }
  }
});

await check("a layout already wired by hand is not wired again", () => {
  const handWired = `import { withSiteMetadata } from "@/lib/site/metadata";
import { SiteJsonLd } from "@/lib/site/json-ld";
import { PlausibleScript } from "@/lib/site/plausible";

export const metadata = withSiteMetadata({ title: "X" });

export default function L({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <PlausibleScript />
        <SiteJsonLd application={false} />
        {children}
      </body>
    </html>
  );
}
`;
  assert.equal(wireSiteBasicsInLayout(handWired, WITH_DESCRIPTION).changed, false);
});

// ---------------------------------------------------------------------------
console.log("\nfiles the project already has\n");
// ---------------------------------------------------------------------------

await check("an existing robots route is kept; one naming no sitemap gets a note", () => {
  const dir = starterProject("own-robots");
  const own =
    'export default function robots() { return { rules: [{ userAgent: "*", disallow: "/x/" }] }; }\n';
  writeFileSync(join(dir, SRC, "app/robots.ts"), own);
  const ctx = context(dir);
  const result = applySiteBasics(ctx);
  assert.equal(readFileSync(join(dir, SRC, "app/robots.ts"), "utf-8"), own);
  assert.ok(result.notes.some((n) => n.includes("https://demo.example.com/sitemap.xml")));
});

await check("a robots route that names /sitemap.xml gets no note", () => {
  const dir = starterProject("docs-robots");
  writeFileSync(join(dir, SRC, "app/robots.ts"), "// sitemap: `${SITE_URL}/sitemap.xml`\n");
  const result = applySiteBasics(context(dir));
  assert.ok(!result.notes.some((n) => n.includes("robots")));
});

await check("public/robots.txt: no route is written beside it (Next refuses both)", () => {
  const dir = starterProject("static-robots");
  writeFileSync(join(dir, "packages/client/public/robots.txt"), "User-agent: *\nAllow: /\n");
  const ctx = context(dir);
  const result = applySiteBasics(ctx);
  assert.equal(existsSync(join(dir, SRC, "app/robots.ts")), false);
  assert.ok(result.notes.some((n) => n.includes("Sitemap: https://demo.example.com/sitemap.xml")));
});

await check("a sitemap of the project's own is kept", () => {
  const dir = starterProject("own-sitemap");
  writeFileSync(join(dir, "packages/client/public/sitemap.xml"), "<urlset/>\n");
  applySiteBasics(context(dir));
  assert.equal(existsSync(join(dir, SRC, "app/sitemap.ts")), false);
  const routes = join(dir, SRC, "app/sitemap.ts");
  writeFileSync(routes, "export default function sitemap() { return []; }\n");
  rmSync(join(dir, "packages/client/public/sitemap.xml"));
  applySiteBasics(context(dir));
  assert.equal(readFileSync(routes, "utf-8"), "export default function sitemap() { return []; }\n");
});

await check("an existing og.png is kept", () => {
  const dir = starterProject("own-card");
  writeFileSync(join(dir, "packages/client/public/og.png"), "mine");
  applySiteBasics(context(dir));
  assert.equal(readFileSync(join(dir, "packages/client/public/og.png"), "utf-8"), "mine");
});

await check("docs arriving later replace hatchkit's one-sitemap robots route", async () => {
  const dir = starterProject("docs-later");
  applySiteBasics(context(dir));
  assert.equal(
    readFileSync(join(dir, SRC, "app/robots.ts"), "utf-8"),
    renderSiteBasicsRobotsRoute(),
  );
  mkdirSync(join(dir, "docs-site"), { recursive: true });
  writeFileSync(join(dir, "docs-site", "package.json"), '{ "name": "docs-site" }\n');
  const { applyDocsInClient } = await import("./src/features/docs-in-client/index.js");
  applyDocsInClient(context(dir));
  const robots = readFileSync(join(dir, SRC, "app/robots.ts"), "utf-8");
  assert.match(robots, /\$\{SITE_URL\}\/docs\/sitemap\.xml/);
  assert.match(robots, /\$\{SITE_URL\}\/sitemap\.xml/);
});

await check("no description in the manifest: a note, and the placeholder stays", () => {
  const dir = starterProject("no-description");
  const result = applySiteBasics(context(dir, { project: { description: undefined } }));
  assert.ok(result.notes.some((n) => n.includes("`description`")));
  const layout = readFileSync(join(dir, SRC, "app/layout.tsx"), "utf-8");
  assert.match(
    layout,
    /withSiteMetadata\(\{\n {2}description: "A full-stack web application",\n\}\)/,
  );
  assert.doesNotMatch(layout, /My App/);
});

await check("skipped with a reason: no web client, or not a Next.js client", () => {
  const backend = applySiteBasics(
    context(starterProject("backend"), { project: { surfaces: "backend" } }),
  );
  assert.match(backend.skipped ?? "", /no web client/);
  const dir = join(tmp, "vite");
  mkdirSync(join(dir, "packages/client/src"), { recursive: true });
  writeFileSync(join(dir, "packages/client/package.json"), "{}\n");
  writeFileSync(join(dir, "packages/client/vite.config.ts"), "export default {};\n");
  const vite = applySiteBasics(context(dir));
  assert.match(vite.skipped ?? "", /not a Next\.js app/);
  assert.deepEqual(readdirSync(join(dir, "packages/client/src")), []);
});

// ---------------------------------------------------------------------------
console.log("\nthe social card\n");
// ---------------------------------------------------------------------------

const card = readFileSync(join(starterDir, "packages/client/public/og.png"));
const decoded = decodePng(card);

await check("og.png is a 1200×630 PNG that decodes", () => {
  assert.ok(decoded);
  assert.equal(decoded.width, 1200);
  assert.equal(decoded.height, 630);
});

await check("the app icon sits in the middle, on the manifest background", () => {
  assert.ok(decoded);
  const at = (x: number, y: number): number[] => {
    const i = (y * decoded.width + x) * 4;
    return [...decoded.data.subarray(i, i + 3)];
  };
  const icon = decodePng(readFileSync(join(STARTER, "resources/icon.png")));
  assert.ok(icon);
  const iconCentre = [...icon.data.subarray((512 * 1024 + 512) * 4, (512 * 1024 + 512) * 4 + 3)];
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(at(600, 315)[c] - iconCentre[c]) <= 1);
  assert.deepEqual(at(10, 10), [255, 255, 255]);
  // The rounded corner of the icon shows the background.
  assert.deepEqual(at(451, 166), [255, 255, 255]);
});

await check("the card is deterministic, and plain without an icon", () => {
  const again = renderSocialCard({
    background: [255, 255, 255],
    icon: decodePng(readFileSync(join(STARTER, "resources/icon.png"))),
  });
  assert.ok(Buffer.compare(again, card) === 0);
  const plain = decodePng(renderSocialCard({ background: [10, 20, 30] }));
  assert.ok(plain);
  assert.deepEqual([...plain.data.subarray(0, 4)], [10, 20, 30, 255]);
});

await check("the decoder refuses what it cannot read rather than guessing", () => {
  assert.equal(decodePng(Buffer.from("not a png")), null);
  const rgb = encodePngRgb(2, 1, new Uint8Array([1, 2, 3, 4, 5, 6]));
  const sixteenBit = Buffer.from(rgb);
  sixteenBit[24] = 16; // IHDR bit depth
  assert.equal(decodePng(sixteenBit), null);
  assert.deepEqual([...(decodePng(rgb)?.data ?? [])], [1, 2, 3, 255, 4, 5, 6, 255]);
});

rmSync(tmp, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nall site-basics checks passed");
