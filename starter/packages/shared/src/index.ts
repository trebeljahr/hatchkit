// Relative specifiers in this package carry no extension, on purpose. The web
// client compiles this source directly (its tsconfig maps `@starter/shared` to
// src/), and Next's Turbopack does not map `./x.js` onto `./x.ts`, so a `.js`
// specifier fails the client's first runtime import from this package with
// "Module not found". The package has no "type": "module", so tsc (NodeNext)
// treats it as CommonJS, where an extensionless import is valid and the emitted
// `require("./x")` resolves in dist/ for the server.
export * from "./types";
export * from "./protocol";
export * from "./schemas";
// ── client-core ──────────────────────────────────────────────────
// The client/server version handshake and the sync feed's wire format. Both
// are re-exported here rather than imported by path, so `@starter/core` and
// every host built on it see one module surface.
//
// This block sits directly under `./schemas`, and `./ml-types` stays
// BELOW it, because `hatchkit update` puts the block back by anchoring on the
// line above it — and a scaffold with no ML service deletes the `./ml-types`
// export, so anchoring on that line would miss in most projects and hand the
// block to a manual checklist. `./schemas` is never pruned. Barrel order is
// not otherwise meaningful.
export * from "./api-level";
export * from "./sync-protocol";
// ── end client-core ──────────────────────────────────────────────
export * from "./ml-types";
