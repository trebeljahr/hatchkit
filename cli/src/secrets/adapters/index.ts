/*
 * cli/src/secrets/adapters/index.ts — Adapter barrel.
 *
 * Side-effect imports for every concrete `ProviderRotator`. The
 * orchestrator imports this file once at module-top, which triggers
 * each adapter's top-level `register(adapter)` call. Adapter run
 * order is the order of imports below.
 *
 * Adding a new adapter:
 *   1. Drop the file under `cli/src/secrets/adapters/<name>.ts`.
 *   2. Add one `import "./<name>.js"` line here.
 * No orchestrator changes required.
 */

import "./glitchtip.js";
import "./openpanel.js";
// Other adapters (stripe, r2-token, dotenvx-key) will land here as one
// import line each.
