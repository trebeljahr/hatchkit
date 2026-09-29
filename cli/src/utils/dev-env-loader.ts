/*
 * Teach a scaffolded server to load `.env.development.local`.
 *
 * `hatchkit add` writes provisioned development credentials to the
 * gitignored `.env.development.local` (see `utils/dev-env-secrets.ts`).
 * The starter's `packages/server/src/config/env.ts` loads it first.
 * A project scaffolded before 2026-09-29 loads only `.env.development`,
 * so the credentials would sit in a file its server never reads.
 *
 * `upgradeServerEnvLoader` rewrites exactly the loader block every
 * earlier starter shipped, and nothing else. A loader that no longer
 * matches it was edited by hand; that one is reported, not touched.
 * `cli/test-secret-hygiene.ts` pins `CURRENT_LOADER` to the starter's
 * own `env.ts`, so the two cannot drift apart.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_LOCAL_ENV_FILE } from "./dev-env-secrets.js";

/** The server's env module, relative to the directory holding its env files. */
export const SERVER_ENV_MODULE = join("src", "config", "env.ts");

/** The loader block every starter shipped before `.env.development.local`. */
export const LEGACY_LOADER = `const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
const envPath = resolve(serverRoot, envFile);
if (existsSync(envPath)) {
  dotenvxConfig({ path: envPath });
}`;

/** The block that replaces it. Verbatim in the starter's `env.ts`. */
export const CURRENT_LOADER = `// Gitignored .env.development.local first: dotenvx keeps the first
// value it reads for a key, so provisioned credentials win over defaults.
const envFiles =
  process.env.NODE_ENV === "production"
    ? [".env.production"]
    : [".env.development.local", ".env.development"];
const envPaths = envFiles.map((f) => resolve(serverRoot, f)).filter((p) => existsSync(p));
if (envPaths.length > 0) {
  dotenvxConfig({ path: envPaths });
}`;

export type LoaderUpgrade =
  /** Rewrote the legacy block. */
  | "upgraded"
  /** Already loads `.env.development.local`. */
  | "current"
  /** Has an env module, but not one this code recognises. */
  | "custom"
  /** No `src/config/env.ts` here: not a starter server (Next.js and
   *  Vite load `.env.development.local` on their own). */
  | "absent";

/** Upgrade `<envDir>/src/config/env.ts` in place when it still has the
 *  legacy loader. Idempotent. `dryRun` reports without writing. */
export function upgradeServerEnvLoader(
  envDir: string,
  opts: { dryRun?: boolean } = {},
): {
  status: LoaderUpgrade;
  path: string;
} {
  const path = join(envDir, SERVER_ENV_MODULE);
  if (!existsSync(path)) return { status: "absent", path };
  const text = readFileSync(path, "utf-8");
  if (text.includes(DEV_LOCAL_ENV_FILE)) return { status: "current", path };
  if (!text.includes(LEGACY_LOADER)) return { status: "custom", path };
  if (!opts.dryRun) writeFileSync(path, text.replace(LEGACY_LOADER, CURRENT_LOADER));
  return { status: "upgraded", path };
}
