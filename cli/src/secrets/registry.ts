/*
 * cli/src/secrets/registry.ts — Module-scoped adapter registry.
 *
 * The pattern is intentionally tiny: a single Map<string, ProviderRotator>
 * with no plugin discovery, no manifest, no DI container. Adapters
 * self-register at import time via `register(adapter)`; the orchestrator
 * imports `./adapters/index.js` exactly once for the side-effectful
 * registration calls and then iterates `all()` to drive the rotation.
 *
 * Duplicate-name registration throws — surfaces collisions loudly at
 * startup rather than letting one adapter silently shadow another.
 */

import type { ProviderRotator } from "./types.js";

const adapters = new Map<string, ProviderRotator>();

/** Add an adapter to the registry. Called by each adapter file at
 *  import time. Throws on duplicate `name` collision. */
export function register(adapter: ProviderRotator): void {
  if (adapters.has(adapter.name)) {
    throw new Error(
      `Duplicate secrets adapter "${adapter.name}". ` +
        `Each adapter must declare a unique name; check ` +
        `cli/src/secrets/adapters/ for a name collision.`,
    );
  }
  adapters.set(adapter.name, adapter);
}

/** All registered adapters, in registration (= barrel import) order. */
export function all(): ProviderRotator[] {
  return [...adapters.values()];
}

/** Lookup by name, undefined when not registered. */
export function get(name: string): ProviderRotator | undefined {
  return adapters.get(name);
}

/** Convenience alias — `list()` reads more naturally in some
 *  call-sites; the orchestrator pseudocode uses it. */
export const list = all;
