// GENERATED — DO NOT EDIT.
//
// The vendored surface of the shared client core: exactly the names this
// extension imports, and nothing else. Written by `scripts/vendor-core.mjs`.
//
// A name is re-exported as `export type` whenever it is a type declaration or
// is only ever imported as one. That distinction is load-bearing: `export {`
// is a RUNTIME import, so value-exporting a module that exists only for its
// types pulls that module — and everything it imports at runtime — into every
// command bundle.

export { ApiError, createApiClient, isTransportFailure } from "./api-client";
export type { Capability } from "./api-level";
export { createId, deviceTimeZone } from "./ids";
export { createLocalCache, drainThenRead, writingThroughQueue } from "./local-cache";
export type { CachedRead, LocalCache } from "./local-cache";
export { createTempId, decodeOfflineMutation, holdBlocksReplay, tempIdOf } from "./offline-ops";
export type { OfflineMutation } from "./offline-ops";
export { OFFLINE_OVERLAY_STORAGE_KEY, applyOverlay, decodeStoredOverlay, emptyOverlay, encodeStoredOverlay, withOptimisticItem, withOptimisticPatch, withOptimisticRemoval, withoutResolved } from "./offline-overlay";
export type { OfflineOverlay } from "./offline-overlay";
export { createOfflineQueue, isQueuedOn, isReplayableBy } from "./offline-queue";
export type { FlushResult, OfflineQueue, QueuedMutation } from "./offline-queue";
export { classifyReplayOutcome, flushVerdictFor, replayOfflineMutation } from "./offline-replay";
export type { OfflineReplayMutators, ReplayIdMap } from "./offline-replay";
export { createServerLevelCache } from "./server-level";
export type { ServerLevelCache } from "./server-level";
export type { KeyValueStorage } from "./storage";
export { createSyncClient } from "./sync-client";
export type { SyncStatus } from "./sync-client";
export type { SyncEvent } from "./sync-protocol";
export { resolveSyncUrl } from "./sync-url";
export type { Item } from "./types";
export type { VersionedSpec } from "./versioned-storage";
