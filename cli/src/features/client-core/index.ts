/*
 * cli/src/features/client-core/index.ts — the `client-core` feature.
 *
 * `client-core` scaffolds `packages/core`: a host-free client kit that every
 * surface beyond the web app is built on — a typed API client, a one-way
 * realtime sync client whose room comes from its authenticated session, a
 * storage seam each host binds to its own durable store, a versioned offline
 * mutation queue with owner and tenant stamping and a single replay classifier,
 * an optimistic overlay and read cache, network truth taken from the platform
 * radio rather than the browser's flag, and the client/server version handshake
 * with its committed contract snapshot.
 *
 * It is the first feature registered through `features/contract.ts`, so
 * `apply` writes only through the ledger and `--dry-run` needs no flag of its
 * own. Two directions:
 *
 *  - `create` copies the whole starter and SUBTRACTS what was not selected, so
 *    the create-time path is `strip.ts`.
 *  - `update` layers the feature onto an existing project, which is `apply.ts`.
 *
 * `markers.ts` explains how the handshake is removed from the files the starter
 * always ships, and why that is a marked block rather than a regex in the CLI.
 */

import { type FeatureContext, registerFeature } from "../contract.js";
import { applyClientCore } from "./apply.js";

export const clientCoreFeature = registerFeature({
  id: "client-core",
  title: "Shared client core",
  summary: "Offline queue, sync client and version handshake, shared by every surface.",
  /**
   * `fullstack` and `split` only.
   *
   * The kit is a CLIENT kit whose server half is a floor on every tRPC
   * procedure and a WebSocket feed, so it needs both halves present. A `static`
   * surface has no server to declare an API level, and a `backend` surface has
   * no client package to hold the query-client wiring — in either case most of
   * what the feature installs would be a package nothing imports.
   */
  surfaces: ["fullstack", "split"],
  addableAfterScaffold: true,
  apply(ctx: FeatureContext) {
    ctx.log("  client-core: shared client kit + version handshake");
    applyClientCore(ctx);
    ctx.log(
      "    Run `pnpm install` for the new workspace package, then\n" +
        "    `pnpm run contract:emit` once and commit the snapshot it writes.",
    );
  },
});

export { applyClientCore, chainCoreBuild, starterFilesUnder } from "./apply.js";
export {
  CLIENT_CORE_CHECKLIST_PATH,
  anchoredBlocks,
  insertAfter,
  renderClientCoreChecklist,
  type ManualWiring,
} from "./add.js";
export {
  MARKER_CLOSE,
  MARKER_OPEN,
  UnbalancedMarkerError,
  blockRanges,
  hasMarkedBlocks,
  readMarkedBlocks,
  stripMarkedBlocks,
} from "./markers.js";
export {
  findStarterIdentifierLiterals,
  renameClientCoreIdentifiers,
  renameStarterIdentifiers,
  renameStarterIdentifiersAcross,
} from "./rename.js";
export { stripClientCore, unchainSegment } from "./strip.js";
export {
  CLIENT_CORE_CHAINED_SCRIPTS,
  CLIENT_CORE_FEATURE,
  CLIENT_CORE_MARKED_FILES,
  CLIENT_CORE_OWNED_PATHS,
  CLIENT_CORE_PACKAGE_DEPENDENTS,
  CLIENT_CORE_ROOT_SCRIPTS,
  CORE_BUILD_SEGMENT,
  CORE_PACKAGE_NAME,
  IDENTIFIER_RENAMES,
} from "./types.js";
