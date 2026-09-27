/**
 * Raycast's own lint rules, over this package's sources MINUS the vendored
 * tree.
 *
 * `src/vendor/**` is a byte-for-byte generated copy of `packages/core` and
 * `packages/shared` (scripts/vendor-core.mjs). Linting it produces a diff the
 * generator overwrites on its next run, so every fix is lost and every
 * regeneration reads as drift. The exclusion is repeated in `.prettierignore`,
 * which scripts/export-store.mjs copies into the exported package — the store
 * copy has the same vendored tree for the same reason.
 */
import { defineConfig } from "eslint/config";
import raycastConfig from "@raycast/eslint-config";

export default defineConfig([
  { ignores: ["src/vendor/**", "dist/**", "raycast-env.d.ts"] },
  ...raycastConfig,
]);
