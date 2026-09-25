/*
 * cli/src/features/docs-in-client/paths.ts — where the docs live, on the
 * domain and in the repository.
 *
 * One module owns both addresses because they have to agree. The docs are
 * built with a base path, copied into the client's build output under that
 * same path, linked to from the marketing pages with that same path, and
 * audited against the resulting absolute prefix. Five places, one source: a
 * project that computes the prefix twice eventually computes it differently,
 * and the failure that produces is a docs site that builds, deploys and
 * serves perfectly while search engines are told to ignore it.
 */

import { defaultWebOrigin } from "../operational-context.js";

/** Where the docs sit on the domain, unless the caller says otherwise. */
export const DEFAULT_DOCS_BASE_PATH = "/docs/";

/** The workspace package that holds the Docusaurus site. Matches the
 *  starter's `docs-site` workspace member; a project that renamed it passes
 *  its own name through {@link DocsLayoutInput}. */
export const DEFAULT_DOCS_PACKAGE = "docs-site";

/** The client package, as every generated Dockerfile and workflow spells it.
 *  Hardcoded for the same reason `scaffold/deploy-verification.ts` hardcodes
 *  it: every transform here anchors on paths that only exist in that layout,
 *  and a project laid out differently is left alone rather than half-edited. */
export const CLIENT_PACKAGE_DIR = "packages/client";

/** The copy-and-audit step the client image runs after the client build. */
export const DOCS_SCRIPT_REL_PATH = "scripts/docs/build-into-client.mjs";

/** The domain's one robots file — a Next.js metadata route. */
export const ROBOTS_ROUTE_REL_PATH = `${CLIENT_PACKAGE_DIR}/src/app/robots.ts`;

/** The shared absolute-links constant the marketing pages import. */
export const DOCS_LINKS_REL_PATH = `${CLIENT_PACKAGE_DIR}/src/lib/docs-links.ts`;

/** The client image's Dockerfile, which the copy step is retrofitted into. */
export const CLIENT_DOCKERFILE_REL_PATH = `${CLIENT_PACKAGE_DIR}/Dockerfile`;

/** The generated deploy workflow. Mirrors `DEPLOY_WORKFLOW_REL_PATH` in
 *  scaffold/deploy-verification.ts; repeated rather than imported so this
 *  feature does not drag that module's whole constant table in with it. */
export const DEPLOY_WORKFLOW_REL_PATH = ".github/workflows/build-and-deploy.yml";

/** The standalone pull-request check, written only for a project whose
 *  deploy workflow the retrofit could not match. */
export const DOCS_WORKFLOW_REL_PATH = ".github/workflows/docs-verify.yml";

/** The docs site's own configuration, inside the docs workspace package.
 *  A `.ts` config is what the starter ships and what the retrofit anchors
 *  on; a project that writes its config as JavaScript keeps whatever it has
 *  and is told what to set instead. */
export const DOCS_CONFIG_FILENAME = "docusaurus.config.ts";

/** What a caller has to say to place the docs. */
export interface DocsLayoutInput {
  /** Production domain, bare hostname — `OperationalProject["domain"]`. */
  domain: string;
  /** Path under the domain. Leading and trailing slashes are added when
   *  missing, so `docs`, `/docs` and `/docs/` all mean the same thing. */
  basePath?: string;
  /** Workspace package holding the Docusaurus site. */
  docsPackage?: string;
}

/** Every address the feature writes, derived once. */
export interface DocsLayout {
  /** `https://example.com` — the origin the robots file and the links
   *  module are written against. */
  origin: string;
  /** `/docs/` — always with both slashes, because it is concatenated onto
   *  an origin and joined onto an output directory. */
  basePath: string;
  /** `https://example.com/docs/` — the prefix every canonical link and
   *  every sitemap entry has to start with. */
  publishedPrefix: string;
  /** The Docusaurus workspace package. */
  docsPackage: string;
}

/** Normalise a base path to the `/…/` form the rest of the feature assumes.
 *  An empty or `/` base path is rejected by returning the default: docs at
 *  the domain root would collide with the web app on every route, and a
 *  caller that passed nothing meant "the usual place". */
export function normalizeDocsBasePath(basePath?: string): string {
  const trimmed = (basePath ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_DOCS_BASE_PATH;
  return `/${trimmed}/`;
}

/** Resolve the one layout every renderer and every check reads from. */
export function docsLayout(input: DocsLayoutInput): DocsLayout {
  const origin = defaultWebOrigin(input.domain);
  const basePath = normalizeDocsBasePath(input.basePath);
  return {
    origin,
    basePath,
    publishedPrefix: `${origin}${basePath}`,
    docsPackage: input.docsPackage ?? DEFAULT_DOCS_PACKAGE,
  };
}

/** Where the docs site's config lives, relative to the project root.
 *
 *  Derived rather than a constant, because the workspace package that holds
 *  the site is a layout decision: the transform has to open the config of
 *  the package this project actually has, not the one the starter ships. */
export function docsConfigRelPath(layout: DocsLayout): string {
  return `${layout.docsPackage}/${DOCS_CONFIG_FILENAME}`;
}
