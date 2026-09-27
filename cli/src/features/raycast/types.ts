/*
 * cli/src/features/raycast/types.ts — the inventory of what the `raycast`
 * feature owns in the starter, and the names it writes into it.
 *
 * One list, read by both directions. `strip.ts` deletes these paths when the
 * feature was not selected at create time; `apply.ts` copies the same paths in
 * when `hatchkit update` layers the feature onto an already-scaffolded project.
 * A path added to the starter and to only one of the two is either a scaffold
 * that ships a launcher extension the user did not ask for, or an `update` that
 * leaves the package half-installed — and half of this package does not build,
 * because `src/vendor/` is generated from a file list.
 */

/** The feature id, as it appears in the manifest and in `--features`. */
export const RAYCAST_FEATURE = "raycast";

/**
 * Paths the feature owns outright — created by it, removed with it. Relative
 * to the deployable directory. Directories are removed recursively.
 *
 * One entry, because the package is self-contained on purpose: it vendors the
 * shared client core rather than depending on it (see the package's
 * `scripts/vendor-core.mjs`), so it adds no dependency to any other manifest
 * and edits no file outside its own directory.
 */
export const RAYCAST_OWNED_PATHS: readonly string[] = ["packages/raycast"];

/**
 * Top-level paths the feature ships, for the `backend` / `static` surface
 * prune in `cli/src/scaffold/surfaces.ts`.
 *
 * The same single path. The feature refuses those surfaces outright, so this
 * only catches a project whose surface CHANGED after the launcher was added.
 */
export const RAYCAST_TOP_LEVEL_PATHS: readonly string[] = ["packages/raycast"];

/**
 * The workspace name of the package.
 *
 * It is NOT `@<scope>/raycast`, and that is forced rather than chosen: Raycast
 * reads `package.json`'s `name` as the extension's store slug, which must be
 * a bare lowercase identifier. One `name` field has to serve both, so the
 * workspace package is named after the store slug and every `pnpm --filter`
 * that targets it uses that name.
 *
 * In the starter it is the literal below; in a scaffolded project it is
 * `identifiers.slug`, written by {@link RAYCAST_IDENTIFIER_RENAMES}.
 */
export const RAYCAST_STARTER_PACKAGE_NAME = "starter-launcher";

/**
 * Root `package.json` scripts the feature adds, for a given package name.
 *
 * ============================================================
 * WHY THE AGGREGATES HAVE TO NAME THIS PACKAGE
 * ============================================================
 *
 * A host package is outside the main build graph: nothing in
 * `packages/{shared,core,server,client}` imports it, so `pnpm run build`
 * never compiles it and a change that breaks it goes green through the whole
 * pipeline. The starter's root `typecheck` and `lint` happen to reach it
 * already, because both are `pnpm -r` over every workspace package — but
 * `test:unit` is an explicit list and does not, so `test:raycast` below has to
 * be chained into it by hand.
 *
 * `vendor:raycast` is separate from `build:raycast` although `build` runs it
 * anyway: regenerating the vendored copy is the thing somebody needs after
 * changing `packages/core`, and it is not a build.
 */
export function raycastRootScripts(): Record<string, string> {
  // Filtered by PATH, never by name.
  //
  // The launcher's manifest `name` is its Raycast Store identity, which the
  // rename sets to the project's slug — and the ROOT workspace package is
  // named the project's slug too. `pnpm --filter <slug>` then matches both,
  // picks the root, and `pnpm run test:raycast` re-enters the root `test`
  // script: a recursive run that fails several layers down with an error
  // naming the root package, never the launcher.
  //
  // A path filter names exactly one directory and cannot collide. Renaming
  // the launcher to dodge this is not an option — the store identity is
  // permanent, and Raycast keys every install's encrypted storage by it.
  return {
    "vendor:raycast": "pnpm --filter ./packages/raycast run vendor",
    "build:raycast": "pnpm --filter ./packages/raycast run build",
    "test:raycast": "pnpm --filter ./packages/raycast run test",
    "typecheck:raycast": "pnpm --filter ./packages/raycast run typecheck",
    "lint:raycast": "pnpm --filter ./packages/raycast run lint",
  };
}

/**
 * The aggregate the package's own tests must be named in, and the segment
 * that names them.
 *
 * The root `typecheck` and `lint` are `pnpm -r` sweeps and reach this package
 * on their own; `test:unit` is an explicit list and does not. Without the
 * chain the launcher's vendor-drift check never runs in CI, which is the one
 * check that catches a silent behaviour fork between this surface and every
 * other client.
 */
export const RAYCAST_TEST_AGGREGATE = "test:unit";
export const RAYCAST_TEST_SEGMENT = "pnpm run test:raycast";

/** The script names, for the surface prune that has to remove them again. */
export const RAYCAST_SCRIPT_NAMES: readonly string[] = Object.keys(raycastRootScripts());

/**
 * The identifier-bearing names the starter's launcher package ships as
 * literals, and where each one's real value comes from.
 *
 * ============================================================
 * WHY LITERALS AND NOT `{{…}}` TOKENS
 * ============================================================
 *
 * The same exception `client-core` documents on its own table, for a different
 * parser. `packages/raycast/package.json` is validated by Raycast's own
 * toolchain, which rejects a `name` or an `author` that is not a bare
 * lowercase identifier — so a tokenised `"name": "{{projectSlug}}"` would make
 * the starter's launcher package fail `ray lint` and `ray develop` before it
 * had ever been scaffolded. The starter is meant to be a monorepo a person can
 * clone and run.
 *
 * So the starter ships working placeholder values and this table rewrites
 * them. Every entry is quoted or unmistakably specific, so only the intended
 * occurrence is touched: `"starter-raycast"` cannot match inside
 * `starter-launcher`, and `Starter Launcher` cannot match `@starter/core`.
 *
 * `cli/test-raycast.ts` asserts both directions — the starter still contains
 * every literal, and nothing the feature applied still does. That is what
 * keeps this table from drifting away from the files it renames.
 */
export type RaycastRenameTarget =
  /** The store slug AND the workspace package name — permanent once published. */
  | "slug"
  /** The store publisher handle placeholder. Replaced again at export time. */
  | "authorPlaceholder"
  /** The device-flow client id the server allowlists for this surface. */
  | "raycastClientId"
  /** Every user-visible mention of the product. */
  | "productName"
  /** Where a release build's requests go. */
  | "releaseApiOrigin"
  /** Where a release build sends a person to approve a pairing code. */
  | "releaseWebOrigin"
  /** The repository's pinned dev API port. */
  | "devApiOrigin"
  /** The repository's pinned dev client port. */
  | "devWebOrigin";

export const RAYCAST_IDENTIFIER_RENAMES: readonly {
  /** The literal the starter ships. */
  from: string;
  to: RaycastRenameTarget;
}[] = [
  // Quoted, so only the manifest field and the constants are touched.
  { from: '"starter-launcher"', to: "slug" },
  { from: '"starter-author"', to: "authorPlaceholder" },
  { from: '"starter-raycast"', to: "raycastClientId" },
  // Unquoted: it also appears in the README's heading and the command
  // subtitle. `@starter/core` cannot match — different case, and a space.
  { from: "Starter Launcher", to: "productName" },
  // `.example` is the reserved documentation TLD, so the starter's own value
  // can never resolve to somebody's real host.
  { from: "https://api.starter.example", to: "releaseApiOrigin" },
  { from: "https://app.starter.example", to: "releaseWebOrigin" },
  // The PINNED dev ports. A launcher extension bakes its origin in at build
  // time and cannot follow a port that changes per run, so these are the
  // fixed ones — never the auto-picked ones a worktree serves.
  { from: "http://localhost:5000", to: "devApiOrigin" },
  { from: "http://localhost:3000", to: "devWebOrigin" },
];

/**
 * Extensions copied byte-for-byte instead of rendered.
 *
 * `writeIfChanged` round-trips content through a UTF-8 string, which corrupts
 * a PNG — and `assets/extension-icon.png` is not optional decoration: `ray
 * build` and `ray develop` both fail outright when it is missing or unreadable.
 */
export const RAYCAST_BINARY_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".ico",
  ".gif",
  ".webp",
];

/** True when `rel` must be copied rather than rendered. */
export function isBinaryAsset(rel: string): boolean {
  const lower = rel.toLowerCase();
  return RAYCAST_BINARY_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
