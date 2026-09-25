/*
 * cli/src/features/docs-in-client/index.ts — publish a documentation site
 * from a path of the main domain, built into the web client's image.
 *
 * ---------------------------------------------------------------------
 * The shape, and why it is this one
 * ---------------------------------------------------------------------
 *
 * The docs are served from `https://<domain>/docs/` by the same application
 * that serves the web app, out of the same image.
 *
 * A folder of the main domain rather than a host of its own, because a
 * subdomain is a separate site to a search engine: the pages that answer the
 * questions the product is found by would build authority for a host the
 * product does not live on. And a folder of the client's own image rather
 * than a third application or a proxy path, because that needs no routing at
 * all — the proxy merges the site blocks of two applications claiming the
 * same host, and a proxy path strips the prefix a `/docs/` build needs to
 * keep. Both of those failed in practice before this shape was settled on.
 *
 * The costs are deliberate and small: a docs-only change rebuilds and
 * redeploys the client image (which never restarts the server), and the
 * image build installs the docs site's dependencies.
 *
 * ---------------------------------------------------------------------
 * The failure it is all defending against
 * ---------------------------------------------------------------------
 *
 * A docs site that search engines are told to ignore looks exactly like one
 * they are not. It builds, deploys, serves every page, and the only symptom
 * arrives months later as an absence. The configuration that produces it is
 * the obvious one: read the docs address from a variable, fall back to a
 * placeholder, and turn indexing off for the placeholder. One unset variable
 * in one build environment then ships the whole site unindexable.
 *
 * So: the docs address is a LITERAL, indexing is always on, and the build
 * fails on any evidence to the contrary — in the image build, and on the
 * pull request before it.
 *
 * ---------------------------------------------------------------------
 * How it writes
 * ---------------------------------------------------------------------
 *
 * Every mutation goes through `ctx.ledger`, so `--dry-run` is handled in one
 * place and this module never asks whether it is in one. The primitive is
 * chosen per file, weakest that does the job:
 *
 *   · `writeIfChanged` for the three artefacts the feature OWNS and
 *     regenerates — the copy step, the marketing pages' link constant, and
 *     the standalone pull-request workflow. Each says so in its own header.
 *   · `edit` with the idempotent transforms in `retrofit.ts` for the three
 *     files that already exist in a scaffolded project: the client
 *     Dockerfile, the deploy workflow's verify job, and the docs site's own
 *     config. Each returns its input unchanged when its anchor is missing,
 *     so a hand-rolled file is left alone and reported rather than
 *     half-edited.
 *   · The robots route is neither. See {@link writeRobotsRoute}.
 */

import {
  type OperationalContext,
  type OperationalOutcome,
  applied,
  hasClientHalf,
  skipped,
} from "../operational-context.js";
import {
  CLIENT_DOCKERFILE_REL_PATH,
  DEPLOY_WORKFLOW_REL_PATH,
  DOCS_LINKS_REL_PATH,
  DOCS_SCRIPT_REL_PATH,
  DOCS_WORKFLOW_REL_PATH,
  type DocsLayout,
  ROBOTS_ROUTE_REL_PATH,
  docsConfigRelPath,
  docsLayout,
} from "./paths.js";
import {
  renderDocsBuildScript,
  renderDocsLinksModule,
  renderDocsVerifyWorkflow,
  renderRobotsRoute,
  sitemapsInRobotsRoute,
} from "./render.js";
import {
  dockerfileHasDocsStep,
  docsSiteConfigAddress,
  upgradeClientDockerfileDocs,
  upgradeDocsSiteConfig,
  upgradeWorkflowDocsCheck,
  workflowHasDocsCheck,
} from "./retrofit.js";

export { auditDocsOutput, formatDocsViolations } from "./audit.js";
export type { DocsAuditInput, DocsAuditResult, DocsViolation, DocsViolationCode } from "./audit.js";
export { DOCS_AUDIT_RULES, DOCS_VIOLATION_CODES, cleanDocsTree } from "./rules.js";
export * from "./paths.js";
export {
  docsVerifyWorkflowStep,
  renderDocsBuildScript,
  renderDocsLinksModule,
  renderDocsVerifyWorkflow,
  renderRobotsRoute,
  sitemapsInRobotsRoute,
} from "./render.js";
export {
  dockerfileHasDocsStep,
  docsSiteConfigAddress,
  upgradeClientDockerfileDocs,
  upgradeDocsSiteConfig,
  upgradeWorkflowDocsCheck,
  workflowHasDocsCheck,
} from "./retrofit.js";
export type { DocsSiteConfigAddress } from "./retrofit.js";

/** Where the docs go, for a caller that does not want the defaults.
 *
 *  Not part of the operational context, because neither value is in the
 *  manifest: every project hatchkit deploys today publishes its docs at
 *  `/docs/` out of the `docs-site` workspace package. The seam exists so
 *  that a project which renamed either one can still be served — and so the
 *  tests can drive a second layout without a second code path. */
export interface DocsLayoutOverrides {
  /** Path under the domain. Defaults to `/docs/`. */
  basePath?: string;
  /** Workspace package holding the documentation site. Defaults to
   *  `docs-site`, which is what the starter ships. */
  docsPackage?: string;
}

/**
 * Write the docs-in-client module into a project.
 *
 * Writes the copy step, the domain's one robots file and the marketing
 * pages' link constant; retrofits the client image, the pull-request check
 * and the docs site's own address.
 *
 * What comes back is only what a person still has to do. What changed on
 * disk is the ledger's account, not this function's — a note that restates a
 * file hatchkit just wrote is how a generated report stops being read.
 */
export function applyDocsInClient(ctx: OperationalContext): OperationalOutcome {
  return applyDocsInClientAt(ctx, {});
}

/**
 * The same module against a non-default layout.
 *
 * Separate from {@link applyDocsInClient} so the entry point the operational
 * layer calls keeps the one signature every module has, while a project that
 * publishes its docs somewhere other than `/docs/` still has a way in.
 */
export function applyDocsInClientAt(
  ctx: OperationalContext,
  overrides: DocsLayoutOverrides,
): OperationalOutcome {
  // A backend-only project has no client image to build the docs into, and
  // no marketing pages to link them from. Publishing docs for it is a
  // different feature (a site of its own), not this one with a flag.
  if (!hasClientHalf(ctx.project.surfaces)) {
    return skipped("no client image to build the docs into (the project is backend-only)");
  }

  const layout = docsLayout({
    domain: ctx.project.domain,
    basePath: overrides.basePath,
    docsPackage: overrides.docsPackage,
  });
  const notes: string[] = [];

  ctx.ledger.writeIfChanged(DOCS_SCRIPT_REL_PATH, renderDocsBuildScript(layout));
  writeRobotsRoute(ctx, layout, notes);
  ctx.ledger.writeIfChanged(DOCS_LINKS_REL_PATH, renderDocsLinksModule(layout));

  retrofitClientImage(ctx, layout, notes);
  retrofitPullRequestCheck(ctx, layout);

  if (!ctx.ledger.exists(layout.docsPackage)) {
    notes.push(
      `No ${layout.docsPackage}/ in this project yet — the copy step builds that workspace package.`,
    );
  }
  retrofitDocsSiteConfig(ctx, layout, notes);

  return applied(notes);
}

/** Point the docs site at the one address it is published from.
 *
 *  The site's own config is what decides whether the audit passes: the
 *  canonical link on every page and every `<loc>` of the sitemap are written
 *  from its `url` + `baseUrl`. So the config is rewritten rather than
 *  reported — a project told to set it by hand is a project whose first
 *  image build fails on a canonical link pointing at a placeholder host.
 *
 *  `edit` rather than `writeIfChanged`, because the file is the docs site's
 *  and only two declarations in it are hatchkit's. The transform is a fixed
 *  point and returns its input untouched when those declarations are not
 *  there, so a config hatchkit did not write survives intact.
 *
 *  The note is left for the one case where nothing could be set: a config
 *  this transform does not recognise, or a docs package that is not there
 *  yet. When the address was written, the ledger says so and this says
 *  nothing — telling somebody to set a value that has just been set for them
 *  is how a generated report stops being read at all. */
function retrofitDocsSiteConfig(
  ctx: OperationalContext,
  layout: DocsLayout,
  notes: string[],
): void {
  const relPath = docsConfigRelPath(layout);
  const before = ctx.ledger.read(relPath);
  const action = ctx.ledger.edit(relPath, (content) => upgradeDocsSiteConfig(content, layout));
  if (action === "written" || action === "would-write") return;

  if (before !== undefined) {
    // Unchanged because it already says the right thing: nothing to report.
    const address = docsSiteConfigAddress(before);
    if (address.url === layout.origin && address.baseUrl === layout.basePath) return;
  }
  notes.push(
    `Set the docs site's url and baseUrl in ${relPath} to the literals "${layout.origin}" and ` +
      `"${layout.basePath}", with indexing on, a sitemap that carries no lastmod, and no robots ` +
      "file of its own. A config that reads its address from a variable ships an unindexable site " +
      "when the variable is unset; the copy step fails the build on it, but only after the build.",
  );
}

/** The domain's robots file, which is the web app's and names both
 *  sitemaps.
 *
 *  Written when it is absent, which is every scaffolded project — the
 *  starter ships no robots route. When one is already there it is left
 *  alone, and the note says exactly which line is missing from it.
 *
 *  Neither of the two primitives that would automate that is right here.
 *  `writeIfChanged` would replace somebody's crawler rules with hatchkit's
 *  on the next `update`, and a disallow rule silently dropped from a robots
 *  file is a whole site handed to crawlers that were told to stay out.
 *  `ensureManagedBlock` cannot help either: what has to be added is one
 *  entry inside the array a function already returns, and a block appended
 *  to the end of the module would be a declaration nothing references —
 *  dead code in the best case, and a build failure under
 *  `noUnusedLocals` in the usual one. Adding a sitemap entry is one line a
 *  person can add in the right place; guessing where that place is, is not
 *  a trade worth making. */
function writeRobotsRoute(ctx: OperationalContext, layout: DocsLayout, notes: string[]): void {
  const existing = ctx.ledger.read(ROBOTS_ROUTE_REL_PATH);
  if (existing === undefined || ctx.force) {
    ctx.ledger.writeIfChanged(ROBOTS_ROUTE_REL_PATH, renderRobotsRoute(layout));
    return;
  }
  const docsSitemap = `${layout.publishedPrefix}sitemap.xml`;
  if (sitemapsInRobotsRoute(existing).includes(docsSitemap)) return;
  notes.push(
    `Add ${docsSitemap} to the sitemap list in ${ROBOTS_ROUTE_REL_PATH}: it is the domain's only ` +
      "robots file, so it is the only place the docs sitemap can be named.",
  );
}

/** Run the copy step in the web image, after the client build. */
function retrofitClientImage(ctx: OperationalContext, layout: DocsLayout, notes: string[]): void {
  const action = ctx.ledger.edit(CLIENT_DOCKERFILE_REL_PATH, (content) =>
    upgradeClientDockerfileDocs(content, layout),
  );
  if (action === "absent") {
    notes.push(
      `No ${CLIENT_DOCKERFILE_REL_PATH} — run \`node ${DOCS_SCRIPT_REL_PATH}\` after the client ` +
        "build in whatever builds the web image, or the deployed image carries no docs.",
    );
    return;
  }
  if (action !== "unchanged") return;
  // Unchanged is two different situations: the step is already there, or
  // the transform found none of its anchors and refused to guess.
  if (!dockerfileHasDocsStep(ctx.ledger.read(CLIENT_DOCKERFILE_REL_PATH) ?? "")) {
    notes.push(
      `${CLIENT_DOCKERFILE_REL_PATH} does not look like a generated one, so it was left alone — ` +
        `add \`RUN node ${DOCS_SCRIPT_REL_PATH}\` after the client build yourself.`,
    );
  }
}

/** Run the same check on a pull request. The standalone workflow is the
 *  fallback, not the default: one more checkout and one more install to run
 *  a single command is worth paying only when there is no verify job to put
 *  the step in. */
function retrofitPullRequestCheck(ctx: OperationalContext, layout: DocsLayout): void {
  const action = ctx.ledger.edit(DEPLOY_WORKFLOW_REL_PATH, upgradeWorkflowDocsCheck);
  if (action === "written" || action === "would-write") return;
  // Unchanged because the step is already there: nothing more to do. A dry
  // run takes the branch above, so the two modes agree on whether the
  // standalone workflow is needed.
  if (
    action === "unchanged" &&
    workflowHasDocsCheck(ctx.ledger.read(DEPLOY_WORKFLOW_REL_PATH) ?? "")
  ) {
    return;
  }
  ctx.ledger.writeIfChanged(DOCS_WORKFLOW_REL_PATH, renderDocsVerifyWorkflow(layout));
}
