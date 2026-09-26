/*
 * cli/src/features/all.ts — import every registered feature, for its
 * side effect.
 *
 * `registerFeature` runs at module load, so the registry only knows
 * about a feature whose module has been imported. Anything that asks
 * the registry a question about a feature it did not import itself —
 * `expandFeatureSelection` closing a selection over prerequisites, a
 * picker listing what exists — gets a truthful answer about a subset,
 * which is the worst shape an answer can have: `requires: ["x"]` reads
 * as "unknown feature x" rather than pulling x in.
 *
 * So the import list lives here, in one place, and callers import this
 * module rather than guessing which feature modules matter to them.
 * Adding a feature means adding one line.
 */

import "./client-core/index.js";
import "./workspaces/index.js";
import "./auth-account-security/definition.js";
import "./token-client-auth/index.js";
import "./extension/index.js";
import "./release/index.js";
import "./i18n/definition.js";

export { allFeatures, expandFeatureSelection, getFeature } from "./contract.js";
