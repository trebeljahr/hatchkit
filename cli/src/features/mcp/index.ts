/*
 * cli/src/features/mcp/index.ts — the `mcp` feature.
 *
 * It scaffolds `packages/mcp`: a stdio MCP server that lets a model read and
 * change the project's records through the PUBLIC REST API, with a scoped
 * token pasted into the host's configuration.
 *
 * ============================================================
 * WHAT IT DELIBERATELY DOES NOT SCAFFOLD
 * ============================================================
 *
 * Any server code at all. `/api/v1`, the `ApiToken` model, the scope
 * vocabulary, the minting path and the OpenAPI document are `public-api`'s,
 * and this feature is a CLIENT of that surface — which is the whole reason it
 * exists as a separate feature rather than as a second REST implementation.
 *
 * That is stated as `requires: ["client-core", "public-api"]` and not as a
 * comment, because going through the public token path is what keeps
 * authorization, row visibility and field projection the server's decisions.
 * A tool that reached around them would be the first place restricted data
 * leaked past a visibility rule, and it would fail silently: a model reports
 * whatever it is handed, so data that should have been withheld reads exactly
 * like data that was allowed.
 *
 * ── A NOTE FOR WHOEVER REGISTERS THIS ───────────────────────────────
 *
 * `public-api` is applied through `applyServerFeatures`
 * (`features/server-platform/`) and is NOT in the feature registry, so
 * `expandFeatureSelection(["mcp"])` reports it as an unknown feature today.
 * The prerequisite is real and is named here on purpose; the registration
 * pass has to either register the three server-platform features or teach the
 * expansion about them. Until then `apply` also checks for the route table on
 * disk and says so, so a user is told rather than left with ten tools that
 * 404.
 *
 * ============================================================
 * WHERE THE FILES LIVE
 * ============================================================
 *
 * In `starter/packages/mcp/`, not in `cli/src/templates/`. The package has to
 * be a real, buildable, type-checked workspace member that a person can clone
 * and run before any scaffold has happened — its binary is the thing a host
 * launches, and a template that had never been compiled would ship its first
 * type error to a user. That choice costs a create-time strip (`strip.ts`)
 * and buys a package this repository's own tooling keeps honest.
 */

import { clientCoreFeature } from "../client-core/index.js";
import { type FeatureContext, type FeatureId, registerFeature } from "../contract.js";
import { applyMcp, mcpPlannedFiles } from "./apply.js";

/** Annotated, never asserted: the annotation is what proves the `Feature`
 *  union names this id, so a typo is a build error rather than a feature
 *  that is silently never offered. */
const MCP_ID: FeatureId = "mcp";

export const mcpFeature = registerFeature({
  id: MCP_ID,
  title: "MCP server",
  summary: "A stdio MCP server over the public REST API, for a model to read and change records.",
  // `client-core` is referenced through its definition rather than by string,
  // so importing this module registers the one it needs — an id the registry
  // has never seen reads as "unknown feature" rather than as a prerequisite.
  // `public-api` has no definition to reference yet; see the header.
  requires: [clientCoreFeature.id, "public-api"],
  // The tools call a server, and the credential is minted from the web app's
  // typed API — so neither a `static` project (no server) nor a `backend` one
  // (no web app to mint from) can carry it.
  surfaces: ["fullstack", "split"],
  // Everything it writes is its own package plus two add-only root scripts,
  // so `update` can add it to a project that has been running for months.
  addableAfterScaffold: true,
  apply(ctx: FeatureContext): void {
    ctx.log("  mcp: stdio MCP server over /api/v1");
    const { manual } = applyMcp(ctx);
    for (const line of manual) ctx.log(`    ${line}`);
  },
  plannedFiles() {
    // Read off the same table `apply` writes from, never a second list.
    return mcpPlannedFiles();
  },
});

export { apiOriginFor, applyMcp, mcpPlannedFiles } from "./apply.js";
export {
  findMcpIdentifierLiterals,
  renameMcpLiterals,
  renameMcpTree,
  retargetApiOrigin,
  setProductName,
} from "./rename.js";
export { stripMcp } from "./strip.js";
export {
  MCP_FEATURE,
  MCP_IDENTIFIER_RENAMES,
  MCP_OWNED_PATHS,
  MCP_PACKAGE_NAME,
  MCP_PREREQUISITE,
  MCP_ROOT_SCRIPTS,
  MCP_STARTER_DEV_ORIGIN,
  MCP_STARTER_PRODUCT_NAME,
  MCP_TEST_AGGREGATE,
  MCP_TEST_SEGMENT,
  PUBLIC_API_ROUTE_TABLE,
} from "./types.js";

/**
 * Null when `surfaces` can carry the MCP server, otherwise the sentence to
 * show. Shared by the create flow, the non-interactive validator and
 * `hatchkit update`, so the three cannot answer differently.
 */
export function mcpPrerequisiteProblem(surfaces: string): string | null {
  if (surfaces === "static") {
    return "The `mcp` feature needs a server runtime: every tool it offers is a call to the project's own `/api/v1`. A `static` project has no server. Pick `fullstack` or `split`.";
  }
  if (surfaces === "backend") {
    return "The `mcp` feature needs a web app: its credential is minted from the typed API the web app calls. A `backend` project ships no client. Pick `fullstack` or `split`.";
  }
  return null;
}
