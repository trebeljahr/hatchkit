import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The units under test are pure: the manifest builder, the bridge
    // decoders, the sign-out marker verdict. Nothing here needs a DOM,
    // and nothing here talks to a real browser API — the few chrome.*
    // calls sit behind injectable storage adapters.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // The client kit, from source for the same reason.
      "@starter/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      // Read the shared protocol from SOURCE. The package's exports map
      // points at `dist/`, so without this a test run in a fresh clone
      // would either fail on a missing build or — worse — pass against
      // a stale one.
      "@starter/shared/extension-bridge": fileURLToPath(
        new URL("../shared/src/extension-bridge.ts", import.meta.url),
      ),
    },
  },
});
