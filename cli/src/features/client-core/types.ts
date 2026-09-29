/*
 * cli/src/features/client-core/types.ts — the inventory of what the
 * `client-core` feature owns in the starter.
 *
 * One list, read by both directions. `strip.ts` deletes these paths when the
 * feature was not selected at create time; `add.ts` copies the same paths in
 * when `hatchkit update` layers the feature onto an already-scaffolded project.
 * Keeping it in one place is the point: a file added to the starter and to only
 * one of the two lists is either a scaffold that ships code the user did not
 * ask for, or an `update` that leaves the kit half-installed.
 */

/** The feature id, as it appears in the manifest and in `--features`. */
export const CLIENT_CORE_FEATURE = "client-core";

/**
 * Paths the feature owns outright — created by it, removed with it. Relative
 * to the deployable directory (the repo root, or `projectSubdir` when the
 * project was scaffolded into a subfolder). Directories are removed
 * recursively.
 *
 * `packages/server/contract` is on the list so the strip removes the committed
 * snapshot with the rest of the feature. It is also on
 * `CLIENT_CORE_GENERATED_PATHS`, because the copy the starter ships describes
 * the starter's router and no other.
 */
export const CLIENT_CORE_OWNED_PATHS: readonly string[] = [
  "packages/core",
  "packages/shared/src/api-level.ts",
  "packages/shared/src/sync-protocol.ts",
  "packages/server/src/auth/client-version.ts",
  "packages/server/src/sync",
  "packages/server/src/contract",
  "packages/server/contract",
  "packages/server/src/tests/version-handshake.test.ts",
  "packages/server/src/tests/api-level.test.ts",
  "packages/server/src/tests/trpc-contract.test.ts",
  "packages/client/src/lib/query-client.ts",
  "docs/versioning.md",
];

/**
 * Owned paths whose content is GENERATED from the project's own code, so the
 * starter's copy is never handed to a project.
 *
 * The starter commits `packages/server/contract/trpc-contract.json` so its own
 * server suite passes. That file records the STARTER's router. A scaffold
 * prunes procedures from it (no ML service drops every `ml.*` procedure), and
 * features add some (`workspaces`, `public-api`) or rewrite inputs
 * (`auth-account-security`, `i18n`, the Postgres overlay). A project that
 * gains the feature through `update` has its own router again. The contract
 * test would compare any of those routers with the starter's snapshot and
 * report a removed procedure as BREAKING: "raise MIN_CLIENT_API_LEVEL", which
 * is wrong advice on the first run. With no snapshot at all, the test says
 * "run `pnpm run contract:emit`", which is correct. So `create` removes the
 * starter's copy and writes the project's own after `pnpm install`
 * (`snapshot.ts`). `update` never copies it.
 */
export const CLIENT_CORE_GENERATED_PATHS: readonly string[] = ["packages/server/contract"];

/**
 * Files the starter always ships that carry `// ── client-core ──` blocks.
 *
 * These are the ones the handshake cannot avoid touching: a floor that refuses
 * a request lives in the tRPC init, a level a client can read lives in
 * `/api/health`, and a feed has to be attached to the HTTP server that is
 * already listening. See `markers.ts` for why the blocks are marked rather
 * than matched by regex from here.
 */
export const CLIENT_CORE_MARKED_FILES: readonly string[] = [
  "packages/shared/src/index.ts",
  "packages/server/src/app.ts",
  "packages/server/src/index.ts",
  "packages/server/src/trpc/trpc.ts",
  "packages/server/src/trpc/routers/health.ts",
  "packages/server/src/trpc/routers/items.ts",
  "packages/server/src/trpc/routers/profile.ts",
  // Not a file the feature adds anything to functionally — it yields
  // `/api/sync` to the sync feed's own upgrade listener. Every `upgrade`
  // listener on an HTTP server runs for every upgrade and the first one to
  // destroy the socket wins, so without that block the room socket kills every
  // sync connection before the feed sees it.
  "packages/server/src/ws/handler.ts",
];

/** Root `package.json` scripts the feature adds. */
export const CLIENT_CORE_ROOT_SCRIPTS: readonly string[] = ["contract:emit"];

/**
 * Manifests whose scripts chain `@starter/core`'s build, and the scripts in
 * each. The workspace resolves the package through `dist/`, so anything that
 * imports it has to build it first — and a filter matching no package is an
 * error, not a skip, so the same list drives the removal.
 */
export const CLIENT_CORE_CHAINED_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  "package.json": ["build", "typecheck"],
  "packages/server/package.json": ["test"],
};

/**
 * Workspace packages that depend on `@starter/core`, by the manifest that
 * declares the dependency.
 */
export const CLIENT_CORE_PACKAGE_DEPENDENTS: readonly string[] = [
  "packages/server/package.json",
  "packages/client/package.json",
];

/** The workspace name of the kit itself. */
export const CORE_PACKAGE_NAME = "@starter/core";

/**
 * The segment `@starter/core` occupies in the root `build` and `typecheck`
 * scripts.
 *
 * Both scripts build `@starter/shared` before anything that imports it,
 * because the workspace resolves it through `dist/`. `@starter/core` is the
 * same shape and needs the same treatment — and the same removal, or a
 * stripped scaffold's `pnpm run build` fails on a filter that matches no
 * package (`ERR_PNPM_NO_MATCHING_PACKAGE`), which reads as a broken template
 * rather than a missing feature.
 */
export const CORE_BUILD_SEGMENT = "pnpm --filter @starter/core run build";

/**
 * The identifier-bearing names the starter ships as literals, and where each
 * one's real value comes from.
 *
 * These are the names that become contracts the moment anything is stored or
 * sent — a storage key already written in somebody's browser, a header a
 * receiver matches on — so they are read from the manifest's identifiers and
 * never derived here (docs/feature-authoring.md → "Never derive a name").
 *
 * They are literals in the starter rather than `{{…}}` tokens, which is the
 * exception to that file's usual convention and worth the sentence: a `{{` in an
 * HTTP header NAME makes `new Headers()` throw, so a tokenised
 * `x-{{identifierToken}}-api-level` would leave the starter unable to make a
 * single API request until it had been scaffolded — and the starter is meant to
 * be a monorepo a person can clone and run first. The same applies to the
 * storage keys for consistency, so one table covers both.
 *
 * `test-client-core.ts` asserts both directions: the starter still contains each
 * literal, and nothing the feature applied still does. That is what keeps this
 * table from drifting away from the files it renames.
 */
export const IDENTIFIER_RENAMES: readonly {
  /** The literal the starter ships. */
  from: string;
  /** Which identifier supplies the replacement. */
  to: "clientVersionHeader" | "apiLevelHeader" | "clientHeader" | "storagePrefix";
}[] = [
  // Longest first: `x-starter-client` must not eat `x-starter-client-version`.
  { from: "x-starter-client-version", to: "clientVersionHeader" },
  { from: "x-starter-api-level", to: "apiLevelHeader" },
  { from: "x-starter-client", to: "clientHeader" },
  { from: '"starter.', to: "storagePrefix" },
];
