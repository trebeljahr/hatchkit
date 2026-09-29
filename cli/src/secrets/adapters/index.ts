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
import "./r2.js";
import "./local-secrets.js";
// Global credentials (SES, ListMonk) are shared across projects and are
// not per-project adapters: see `../global/`. The Stripe webhook secret
// has no API roll (dashboard only), so it has no adapter.
