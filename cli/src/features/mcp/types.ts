/*
 * cli/src/features/mcp/types.ts — the inventory of what the `mcp` feature
 * owns in the starter.
 *
 * One list, read by both directions: `strip.ts` deletes these paths when the
 * feature was not selected at create time, and `apply.ts` copies the same
 * paths in when `hatchkit update` layers the feature onto an already
 * scaffolded project. A file added to the starter and to only one of the two
 * is either a scaffold that ships code the user did not ask for, or an
 * `update` that leaves the package half-installed.
 */

/** The feature id, as it appears in the manifest and in `--features`. */
export const MCP_FEATURE = "mcp";

/** The workspace name of the package itself. */
export const MCP_PACKAGE_NAME = "@starter/mcp";

/**
 * Paths the feature owns outright — created by it, removed with it. Relative
 * to the deployable directory.
 *
 * One directory, and that is the point of this feature: it scaffolds a CLIENT
 * of the public REST API and not a line of server code. `/api/v1`, the token
 * model, the scope vocabulary and the minting path all belong to `public-api`,
 * which is why this feature requires it instead of growing a route of its own.
 */
export const MCP_OWNED_PATHS: readonly string[] = ["packages/mcp"];

/**
 * Root `package.json` scripts the feature adds.
 *
 * A host package is outside the main build graph — nothing in the root `build`
 * imports it — so a change that breaks it compiles green through the whole
 * pipeline unless an aggregate script names it. These two are what make it
 * reachable at all. They are NOT chained into the root `build`: a `--filter`
 * that matches no package is an error rather than a skip, so a project that
 * later removes the package would fail its own build.
 */
/** The runtime workspace dependencies, built before anything imports them. */
export const MCP_DEPENDENCY_BUILD =
  "pnpm --filter @starter/shared run build && pnpm --filter @starter/core run build";

export const MCP_ROOT_SCRIPTS: Readonly<Record<string, string>> = {
  // Both chain the two workspace packages this one imports at RUNTIME.
  //
  // `@starter/shared` and `@starter/core` are consumed through their `dist/`,
  // so in a freshly scaffolded project — where nothing has been built yet —
  // the MCP server's own tests die on ERR_MODULE_NOT_FOUND pointing at a
  // `dist/index.js` that has simply never been emitted. It reads as a broken
  // package rather than as an unbuilt dependency, and it is exactly what a
  // person hits on their first `pnpm run test:unit`.
  //
  // Safe to name them unconditionally: `mcp` requires `client-core`, so a
  // project with this script always has both packages. A `--filter` matching
  // no package is an error, not a skip, which is why the strip removes these
  // scripts wholesale rather than editing them.
  "build:mcp": `${MCP_DEPENDENCY_BUILD} && pnpm --filter ${MCP_PACKAGE_NAME} run build`,
  "test:mcp": `${MCP_DEPENDENCY_BUILD} && pnpm --filter ${MCP_PACKAGE_NAME} run test`,
};

/**
 * The aggregate script the package's own tests have to be named in, and the
 * segment that names them.
 *
 * The root `typecheck` and `lint` reach every workspace package through
 * `pnpm -r`, so they need nothing here. `test:unit` does not: it names its
 * packages one at a time, and a package it does not name is a package whose
 * tests never run in CI — which is indistinguishable from a package whose
 * tests pass.
 */
export const MCP_TEST_AGGREGATE = "test:unit";
export const MCP_TEST_SEGMENT = "pnpm run test:mcp";

/**
 * The identifier-bearing literals the starter ships, and where each one's real
 * value comes from.
 *
 * They are literals rather than `{{…}}` tokens for the same reason
 * `client-core`'s are (docs/feature-authoring.md → "Never derive a name"): the
 * starter has to be a monorepo a person can clone, install and run before it
 * has ever been scaffolded, and `{{identifierToken}}-mcp` as a `bin` key is a
 * brace in a symlink name. So this table is the one place that rewrites them,
 * from `ctx.identifiers` and never from a rule of its own.
 *
 * Every one of them is a contract the moment it has been published: the two
 * variable names sit in every user's host configuration file, and the server
 * name is both the announced name and the installed binary. `cli/test-mcp.ts`
 * asserts both directions — the starter still contains each literal, and
 * nothing the feature applied still does — which is what stops this table from
 * drifting away from the files it renames.
 */
export const MCP_IDENTIFIER_RENAMES: readonly {
  from: string;
  to: "tokenVar" | "originVar" | "serverName";
}[] = [
  { from: "STARTER_API_TOKEN", to: "tokenVar" },
  { from: "STARTER_API_URL", to: "originVar" },
  { from: "starter-mcp", to: "serverName" },
];

/**
 * The two values the feature rewrites, by the exact text the starter ships.
 *
 * Matched on the starter's own VALUE rather than on the name of the constant
 * holding it, and that is what makes the rewrite both a fixed point and safe
 * over a user's edit: after the first apply the starter's text is gone, so a
 * later `update` finds nothing to replace. Matching on the constant's name
 * instead would put the manifest's domain back over a default somebody had
 * deliberately pointed at a staging deployment — silently, on every update.
 *
 * The dev origin is matched as a bare literal because it appears in the
 * config module AND in the README's configuration table and verification
 * output. Rewriting only one of them would leave the setup page telling the
 * user to expect an origin the binary will never print.
 */
export const MCP_STARTER_DEV_ORIGIN = "http://localhost:5000";
export const MCP_STARTER_PRODUCT_NAME = 'export const PRODUCT_NAME = "Starter";';

/** What the feature needs, in the words the CLI shows people. */
export const MCP_PREREQUISITE =
  "the public REST API (`/api/v1`, scoped API tokens) and the shared client core";

/** Where the public REST surface's route table lives, once it exists. */
export const PUBLIC_API_ROUTE_TABLE = "packages/server/src/api/v1/routes-table.ts";
