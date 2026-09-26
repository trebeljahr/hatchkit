export * from "./types.js";
export * from "./protocol.js";
export * from "./schemas.js";
// ── client-core ──────────────────────────────────────────────────
// The client/server version handshake and the sync feed's wire format. Both
// are re-exported here rather than imported by path, so `@starter/core` and
// every host built on it see one module surface.
//
// This block sits directly under `./schemas.js`, and `./ml-types.js` stays
// BELOW it, because `hatchkit update` puts the block back by anchoring on the
// line above it — and a scaffold with no ML service deletes the `./ml-types.js`
// export, so anchoring on that line would miss in most projects and hand the
// block to a manual checklist. `./schemas.js` is never pruned. Barrel order is
// not otherwise meaningful.
export * from "./api-level.js";
export * from "./sync-protocol.js";
// ── end client-core ──────────────────────────────────────────────
export * from "./ml-types.js";
