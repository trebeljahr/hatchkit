/*
 * cli/src/features/client-core/index.ts — entrypoint for the `client-core`
 * feature.
 *
 * `client-core` scaffolds `packages/core`: a host-free client kit that every
 * surface beyond the web app is built on — a typed API client, a one-way
 * realtime sync client whose room comes from its authenticated session, a
 * storage seam each host binds to its own durable store, a versioned offline
 * mutation queue with owner and tenant stamping and a single replay classifier,
 * an optimistic overlay and read cache, network truth taken from the platform
 * radio rather than the browser's flag, and the client/server version
 * handshake with its committed contract snapshot.
 *
 * It is opt-in, additive through `hatchkit update`, and the one feature that
 * adds a workspace package — see `strip.ts` and `add.ts` for the two
 * directions, and `markers.ts` for how the handshake is removed from the files
 * the starter always ships.
 */

export {
  addClientCore,
  anchoredBlocks,
  insertAfter,
  reportAddClientCore,
  spliceAfterSharedBuild,
  wireMarkedFile,
  writeClientCoreChecklist,
  type AddClientCoreResult,
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
export { stripClientCore, unchainSegment } from "./strip.js";
export {
  CLIENT_CORE_FEATURE,
  CLIENT_CORE_MARKED_FILES,
  CLIENT_CORE_OWNED_PATHS,
  CLIENT_CORE_PACKAGE_DEPENDENTS,
  CLIENT_CORE_ROOT_SCRIPTS,
  CORE_BUILD_SEGMENT,
  CORE_PACKAGE_NAME,
} from "./types.js";
