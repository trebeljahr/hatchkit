/*
 * cli/src/features/site-basics/index.ts — the search and analytics basics
 * every public web client needs, written into a project's Next.js client.
 *
 * ---------------------------------------------------------------------
 * The failure it closes
 * ---------------------------------------------------------------------
 *
 * Deployed starter apps were checked live on 2026-11-10. Every one had a
 * `<title>` and a meta description, and none had anything else: no
 * sitemap (and two whose robots file named sitemaps that answered 404), no
 * canonical URL, no Open Graph or Twitter card, no structured data — and
 * one still titled "My App" in production. The starter shipped none of it,
 * so each app would have had to add it by hand, and none did.
 *
 * ---------------------------------------------------------------------
 * What it writes, and who owns each file
 * ---------------------------------------------------------------------
 *
 * Under the client source root (`packages/client/src` in the starter):
 *
 *   · `lib/site/` — config.ts (rendered from the manifest), metadata.ts,
 *     structured-data.ts, json-ld.tsx, sitemap.ts, plausible.tsx. OWNED:
 *     `writeIfChanged`, regenerated on every `update`, each saying so in its
 *     header. A later CLI can fix them everywhere at once, and the manifest
 *     stays the one place the site's name, domain and description live.
 *   · `app/sitemap.ts`, `app/robots.ts` — the project's: written only when
 *     absent (or under `--force`). A project that lists its blog posts in
 *     its sitemap, or tells a crawler to stay out of a folder, keeps that.
 *     An existing robots file that names no `/sitemap.xml` gets a note.
 *   · `public/og.png` — the default social card, written only when absent
 *     (og-image.ts).
 *   · `app/layout.tsx` — the project's, edited in place by a fixed-point
 *     transform (layout.ts).
 *
 * Everything per page goes through the page itself: `pageMetadata()` for
 * the title, description, card and canonical, `<JsonLd />` for structured
 * data of its own, and `noIndex: true` to keep it out of search results and
 * out of the sitemap at once.
 *
 * ---------------------------------------------------------------------
 * Why it is an operational module and not a picker feature
 * ---------------------------------------------------------------------
 *
 * Nobody opts into being findable. Like the docs being indexable, it is
 * what a deployed web client needs, so `create` writes it into every new
 * project and `update` re-applies it to an old one. Both are the same call
 * through the same ledger, so re-running changes nothing.
 *
 * Analytics: the starter's layout already renders Plausible's tracker from
 * NEXT_PUBLIC_PLAUSIBLE_DOMAIN. What never worked is the value reaching the
 * build — `hatchkit add … plausible` wrote it to `.env.production`, which
 * the client image build never sees. That half is
 * provision/plausible-delivery.ts; this module only mounts
 * `<PlausibleScript />` in a layout that renders no tracker at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectIdentifiers, legacyIdentifiers } from "../../scaffold/identifiers.js";
import type { FileAction } from "../contract.js";
import {
  type OperationalContext,
  type OperationalOutcome,
  type OperationalProject,
  applied,
  defaultWebOrigin,
  hasClientHalf,
  resolveClientDir,
  resolveSourceRoot,
  skipped,
} from "../operational-context.js";
import { renderFeatureTemplate } from "../templates.js";
import { LAYOUT_CANDIDATES, siteImportBase, wireSiteBasicsInLayout } from "./layout.js";
import { decodePng, parseHexColor, renderSocialCard } from "./og-image.js";

export { blankComments, matchBrace, siteImportBase, wireSiteBasicsInLayout } from "./layout.js";
export {
  CARD_HEIGHT,
  CARD_WIDTH,
  decodePng,
  encodePngRgb,
  parseHexColor,
  renderSocialCard,
} from "./og-image.js";

/** Where the templates live under `cli/src/templates/`. */
export const SITE_BASICS_TEMPLATE_DIR = "features/site-basics";

/** The owned modules, relative to the client source root, each with its
 *  template. Order is the order they are written and reported. */
export const SITE_BASICS_OWNED_FILES = [
  "lib/site/config.ts",
  "lib/site/metadata.ts",
  "lib/site/structured-data.ts",
  "lib/site/json-ld.tsx",
  "lib/site/sitemap.ts",
  "lib/site/plausible.tsx",
] as const;

/** Route files the project owns once written. */
export const SITEMAP_ROUTE = "app/sitemap.ts";
export const ROBOTS_ROUTE = "app/robots.ts";
/** The default social card, relative to the client package. */
export const SOCIAL_CARD = "public/og.png";

const NEXT_CONFIGS = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"];

/** Icon sources for the social card, in order. Project-relative paths are
 *  marked with a leading "/"; the rest are relative to the client package. */
const ICON_SOURCES = [
  "/resources/icon.png",
  "public/icon-512.png",
  "public/icon.png",
  "public/apple-touch-icon.png",
  "/build/icon.png",
];

/** The site-wide values every generated file reads. */
export interface SiteIdentity {
  url: string;
  name: string;
  description: string;
  kind: "app" | "site";
  operatingSystems: string[];
}

/** The site's identity, from the manifest projection. The name is the
 *  frozen product name — never re-derived — with the legacy derivation for
 *  a manifest written before identifiers existed, as `update` does. */
export function siteIdentity(
  project: OperationalProject,
  identifiers?: ProjectIdentifiers,
): SiteIdentity {
  const ids = identifiers ?? legacyIdentifiers(project.name);
  const desktop = project.features.includes("desktop");
  const mobile = project.features.includes("mobile");
  const operatingSystems = ["Web"];
  if (desktop) operatingSystems.push("macOS", "Windows", "Linux");
  if (mobile) operatingSystems.push("iOS", "Android");
  // A static site with no native shell is a website; anything with a
  // server half or a shell is an application someone signs in to or
  // installs.
  const kind = project.surfaces === "static" && !desktop && !mobile ? "site" : "app";
  return {
    url: defaultWebOrigin(project.domain),
    name: ids.productName,
    description: (project.description ?? "").trim(),
    kind,
    operatingSystems,
  };
}

function relJoin(...parts: string[]): string {
  return parts.filter((p) => p !== "" && p !== ".").join("/");
}

/** Render one owned module. Exported so tests pin the exact bytes. */
export function renderSiteBasicsFile(
  file: (typeof SITE_BASICS_OWNED_FILES)[number],
  identity: SiteIdentity,
  layout: { appDir: string; trailingSlash: boolean },
): string {
  return renderFeatureTemplate(SITE_BASICS_TEMPLATE_DIR, `${file}.tpl`, {
    SITE_URL: JSON.stringify(identity.url),
    SITE_NAME: JSON.stringify(identity.name),
    SITE_DESCRIPTION: JSON.stringify(identity.description),
    SITE_KIND: JSON.stringify(identity.kind),
    OPERATING_SYSTEMS: `[${identity.operatingSystems.map((os) => JSON.stringify(os)).join(", ")}]`,
    APP_DIR: JSON.stringify(layout.appDir),
    TRAILING_SLASH: String(layout.trailingSlash),
  });
}

/** The robots route exactly as this module writes it. docs-in-client
 *  recognises it by these bytes and replaces it with the version that also
 *  names the docs sitemap — it is hatchkit's file until somebody edits it. */
export function renderSiteBasicsRobotsRoute(): string {
  return renderFeatureTemplate(SITE_BASICS_TEMPLATE_DIR, `${ROBOTS_ROUTE}.tpl`, {});
}

export function renderSiteBasicsSitemapRoute(): string {
  return renderFeatureTemplate(SITE_BASICS_TEMPLATE_DIR, `${SITEMAP_ROUTE}.tpl`, {});
}

/** The card's bytes for a project: its icon on its manifest background. */
export function socialCardFor(
  read: (rel: string) => Buffer | undefined,
  clientDir: string,
): Buffer {
  let background: [number, number, number] = [255, 255, 255];
  const manifest = read(relJoin(clientDir, "public/manifest.json"));
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest.toString("utf-8")) as { background_color?: unknown };
      background = parseHexColor(parsed.background_color) ?? background;
    } catch {
      // A manifest that does not parse keeps the white card.
    }
  }
  for (const source of ICON_SOURCES) {
    const rel = source.startsWith("/") ? source.slice(1) : relJoin(clientDir, source);
    const bytes = read(rel);
    const icon = bytes ? decodePng(bytes) : null;
    if (icon) return renderSocialCard({ background, icon });
  }
  return renderSocialCard({ background });
}

function firstExisting(exists: (rel: string) => boolean, candidates: string[]): string | undefined {
  return candidates.find((rel) => exists(rel));
}

/** Apply the module. See the file header for what it writes. */
export function applySiteBasics(ctx: OperationalContext): OperationalOutcome {
  const { project, ledger } = ctx;
  if (!hasClientHalf(project.surfaces)) {
    return skipped(`surface mode is "${project.surfaces}" (no web client)`);
  }
  const exists = (rel: string): boolean => ledger.exists(rel);
  const clientDir = resolveClientDir(exists);
  const nextConfig = firstExisting(
    exists,
    NEXT_CONFIGS.map((name) => relJoin(clientDir, name)),
  );
  if (nextConfig === undefined) {
    return skipped(`${clientDir === "." ? "the project root" : clientDir} is not a Next.js app`);
  }
  const sourceInClient = resolveSourceRoot(exists, clientDir);
  const sourceRoot = relJoin(clientDir, sourceInClient);
  if (!exists(relJoin(sourceRoot, "app"))) {
    return skipped(`${relJoin(sourceRoot, "app")} does not exist (no App Router)`);
  }

  const notes: string[] = [];
  const identity = siteIdentity(project, ctx.identifiers);
  const trailingSlash = /\btrailingSlash\s*:\s*true\b/.test(ledger.read(nextConfig) ?? "");
  const layout = { appDir: relJoin(sourceInClient, "app") || "app", trailingSlash };

  for (const file of SITE_BASICS_OWNED_FILES) {
    ledger.writeIfChanged(relJoin(sourceRoot, file), renderSiteBasicsFile(file, identity, layout));
  }

  writeSitemapRoute(ctx, clientDir, sourceRoot);
  writeRobotsRoute(ctx, clientDir, sourceRoot, identity, notes);
  writeSocialCard(ctx, clientDir, sourceRoot, notes);
  wireLayout(ctx, sourceRoot, identity, notes);

  if (!identity.description) {
    notes.push(
      "Add a one-line `description` to .hatchkit.json and run `hatchkit update`: it becomes the " +
        "meta description, the social card's text and the structured data's description, and " +
        "the site has none yet.",
    );
  }
  return applied(notes);
}

function writeSitemapRoute(ctx: OperationalContext, clientDir: string, sourceRoot: string): void {
  const appDir = relJoin(sourceRoot, "app");
  const route = relJoin(sourceRoot, SITEMAP_ROUTE);
  // A sitemap of the project's own, in any form Next serves, is left alone.
  // Two at one path is a build error, not a preference.
  const own = firstExisting(ctx.ledger.exists.bind(ctx.ledger), [
    relJoin(appDir, "sitemap.js"),
    relJoin(appDir, "sitemap.xml"),
    relJoin(clientDir, "public/sitemap.xml"),
  ]);
  if (own !== undefined) return;
  if (ctx.ledger.exists(route) && !ctx.force) return;
  ctx.ledger.writeIfChanged(route, renderSiteBasicsSitemapRoute());
}

function writeRobotsRoute(
  ctx: OperationalContext,
  clientDir: string,
  sourceRoot: string,
  identity: SiteIdentity,
  notes: string[],
): void {
  const { ledger } = ctx;
  const appDir = relJoin(sourceRoot, "app");
  const route = relJoin(sourceRoot, ROBOTS_ROUTE);
  const sitemapUrl = `${identity.url}/sitemap.xml`;

  const publicFile = relJoin(clientDir, "public/robots.txt");
  const staticFile = ledger.read(publicFile);
  if (staticFile !== undefined) {
    if (!/^\s*sitemap\s*:/im.test(staticFile)) {
      notes.push(`Add "Sitemap: ${sitemapUrl}" to ${publicFile}: crawlers find the sitemap there.`);
    }
    return;
  }

  const existingRel = firstExisting(ledger.exists.bind(ledger), [
    route,
    relJoin(appDir, "robots.js"),
    relJoin(appDir, "robots.txt"),
  ]);
  if (existingRel === undefined || (ctx.force && existingRel === route)) {
    ledger.writeIfChanged(route, renderSiteBasicsRobotsRoute());
    return;
  }
  const existing = ledger.read(existingRel) ?? "";
  if (!existing.includes("/sitemap.xml")) {
    notes.push(
      `Name ${sitemapUrl} in ${existingRel}: it is the domain's only robots file, and it names ` +
        "no sitemap.",
    );
  }
}

function writeSocialCard(
  ctx: OperationalContext,
  clientDir: string,
  sourceRoot: string,
  notes: string[],
): void {
  const { ledger } = ctx;
  // A card from Next's file convention wins over the metadata image, so
  // writing og.png next to it would be a file nothing serves.
  const appDir = relJoin(sourceRoot, "app");
  const conventions = ["png", "jpg", "jpeg", "tsx", "ts", "js"].map((ext) =>
    relJoin(appDir, `opengraph-image.${ext}`),
  );
  if (firstExisting(ledger.exists.bind(ledger), conventions) !== undefined) return;

  const rel = relJoin(clientDir, SOCIAL_CARD);
  if (ledger.exists(rel)) {
    // Recorded as unchanged without rendering a card nobody will write.
    ledger.writeBytesIfAbsent(rel, new Uint8Array());
    return;
  }
  const read = (path: string): Buffer | undefined => {
    if (!ledger.exists(path)) return undefined;
    try {
      return readBinary(ledger.projectDir, path);
    } catch {
      return undefined;
    }
  };
  const action: FileAction = ledger.writeBytesIfAbsent(rel, socialCardFor(read, clientDir));
  if (action === "written" || action === "would-write") {
    notes.push(
      `${rel} is a placeholder — the app icon on the manifest's background colour. Replace it ` +
        "with a 1200×630 card that says what the product is.",
    );
  }
}

function wireLayout(
  ctx: OperationalContext,
  sourceRoot: string,
  identity: SiteIdentity,
  notes: string[],
): void {
  const { ledger } = ctx;
  for (const candidate of LAYOUT_CANDIDATES) {
    const rel = relJoin(sourceRoot, candidate);
    const before = ledger.read(rel);
    if (before === undefined) continue;
    const options = {
      importBase: siteImportBase(before),
      replaceDescription: identity.description !== "",
    };
    const result = wireSiteBasicsInLayout(before, options);
    if (result.changed) {
      ledger.edit(rel, (content) => wireSiteBasicsInLayout(content, options).content);
    }
    for (const reason of result.blocked) {
      notes.push(`${rel}: ${reason}.`);
    }
    return;
  }
  notes.push(
    `No root layout in ${relJoin(sourceRoot, "app")} — call withSiteMetadata() for its metadata ` +
      "and mount <SiteJsonLd /> wherever the app's tree begins.",
  );
}

/** The ledger's `read` is UTF-8, which corrupts a PNG. */
function readBinary(projectDir: string, rel: string): Buffer {
  return readFileSync(join(projectDir, rel));
}
