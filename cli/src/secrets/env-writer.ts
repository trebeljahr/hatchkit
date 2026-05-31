/*
 * cli/src/secrets/env-writer.ts — Pre-flight env-file safety + thin
 * wrappers around the existing dotenvx helpers.
 *
 * Reuses:
 *   · cli/src/deploy/keys.ts        locateEnvKeysFile, locateEnvProductionFile
 *   · cli/src/provision/write-env.ts writeProdEnv, writeDevEnv, resolveEnvTarget
 *   · cli/src/assets/env.ts          loadProjectEnv (only place that decrypts)
 *
 * Nothing here re-imports `set as dotenvxSet` from `@dotenvx/dotenvx`
 * directly — every encrypted write funnels through writeProdEnv so the
 * layout precedence + first-call keypair generation stay consistent.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import chalk from "chalk";
import { loadProjectEnv } from "../assets/env.js";
import { locateEnvKeysFile, locateEnvProductionFile } from "../deploy/keys.js";
import {
  type EnvPair,
  resolveEnvTarget,
  writeDevEnv,
  writeProdEnv,
} from "../provision/write-env.js";
import { execOk } from "../utils/exec.js";

/** REFUSE-level guard. Throws when `.env.keys` is tracked by git for
 *  the project at `projectDir`. Same probe `doctor.checkProjectKeyState`
 *  uses: `git ls-files --error-unmatch <relPath>` (cwd = projectDir).
 *  When no `.env.keys` file exists, returns quietly — nothing to leak.
 *
 *  The error message is operator-facing: it spells out the recovery
 *  recipe and explicitly names this as a credential-leak refusal
 *  (rotating provider creds while the dotenvx private key still sits
 *  in git history is theatre — the encrypted env was already readable
 *  to anyone with repo access). */
export async function assertEnvKeysNotTracked(projectDir: string): Promise<void> {
  const envKeysPath = locateEnvKeysFile(projectDir);
  if (!envKeysPath) return;
  const relPath = relative(projectDir, envKeysPath);
  const tracked = await execOk("git", ["ls-files", "--error-unmatch", relPath], {
    cwd: projectDir,
  });
  if (!tracked) return;
  throw new Error(
    `REFUSE: ${envKeysPath} is tracked by git. The dotenvx private key may already be in your git history — rotating provider credentials now is theatre, because the encrypted .env.production is readable to anyone with repo access. Fix first:\n` +
      `  git rm --cached ${relPath}\n` +
      `  echo .env.keys >> .gitignore\n` +
      `  hatchkit keys rotate <project>\n` +
      `Then retry \`hatchkit secrets rotate\`.`,
  );
}

/** WARN-level guard. Probes the first 2000 bytes of `.env.production`
 *  for the `DOTENV_PUBLIC_KEY_PRODUCTION` sentinel (same probe
 *  `cli/src/adopt.ts` + `cli/src/inventory.ts` use). When absent, prints
 *  a yellow chalk warning and returns — does NOT throw. The downstream
 *  `writeProdEnv` call will encrypt the file going forward.
 *
 *  When the env file doesn't exist yet, returns quietly: a fresh
 *  project's first provision will create the encrypted form. */
export function warnIfNotEncrypted(envProductionPath: string | undefined): void {
  if (!envProductionPath || !existsSync(envProductionPath)) return;
  const probe = readFileSync(envProductionPath, "utf-8").slice(0, 2000);
  if (/DOTENV_PUBLIC_KEY_PRODUCTION/.test(probe)) return;
  console.error(
    chalk.yellow(
      `  ⚠ ${envProductionPath} is not dotenvx-encrypted. Rotation will encrypt it going forward, but past commits may contain plaintext credentials. Consider running \`hatchkit adopt\` first.`,
    ),
  );
}

/** Decrypt and return the parsed `.env.production` for `projectDir`.
 *  Thin wrapper over `loadProjectEnv` — exists so adapters that need
 *  to recover an OLD secret value have ONE entry point and don't
 *  re-import `parse as parseDotenv` directly. Throws when the env
 *  file is absent or the dotenvx private key can't be located. */
export function readEncryptedProd(projectDir: string): Record<string, string> {
  return loadProjectEnv({ projectDir, mode: "prod" });
}

/** Decrypt `.env.development` for `projectDir`. Same wrapper shape as
 *  `readEncryptedProd` but for the dev side (which is plain text — the
 *  helper still works since `parseDotenv` handles unencrypted files). */
export function readDevEnv(projectDir: string): Record<string, string> {
  return loadProjectEnv({ projectDir, mode: "dev" });
}

/** Resolve the absolute path of `.env.production` the rotation should
 *  write to. Prefers the existing on-disk location (`locateEnvProductionFile`
 *  search order matches `deploy/keys.ts`); falls back to the
 *  `resolveEnvTarget` baseDir (`packages/server/` when present, else
 *  project root) for fresh-project paths. */
export function resolveProdEnvPath(projectDir: string): string {
  const located = locateEnvProductionFile(projectDir);
  if (located) return located;
  const { baseDir } = resolveEnvTarget(projectDir);
  return `${baseDir}/.env.production`;
}

/** Resolve the absolute path of `.env.development`. Same precedence as
 *  `resolveProdEnvPath` but for dev: writes always land where
 *  `resolveEnvTarget` says the env layout is rooted. */
export function resolveDevEnvPath(projectDir: string): string {
  const { baseDir } = resolveEnvTarget(projectDir);
  return `${baseDir}/.env.development`;
}

/** Encrypt `pairs` into `.env.production` via the canonical
 *  `writeProdEnv` helper. Returns the list of keys written. Thin
 *  wrapper — exists so adapter call-sites never import dotenvxSet
 *  directly (the orchestrator is the sole gateway for env mutations). */
export function setProdPairs(envPath: string, pairs: EnvPair[]): string[] {
  if (pairs.length === 0) return [];
  return writeProdEnv(envPath, pairs);
}

/** Write `pairs` into `.env.development` plain-text via the canonical
 *  `writeDevEnv` helper. Returns the list of keys written. */
export function setDevPairs(envPath: string, pairs: EnvPair[]): string[] {
  if (pairs.length === 0) return [];
  return writeDevEnv(envPath, pairs);
}

/** Snapshot the env-var NAMES (not values) present across both env
 *  files for `projectDir`. Used to build `RotationContext.envPresence`
 *  so adapters can `detect()` purely from a name set without paying
 *  the decrypt cost themselves. Tolerates missing files (returns an
 *  empty set), missing dotenvx key (skips prod), and parse errors
 *  (swallowed — `detect()` would simply return false). */
export function scanEnvVarNames(projectDir: string): Set<string> {
  const names = new Set<string>();

  try {
    const dev = readDevEnv(projectDir);
    for (const k of Object.keys(dev)) names.add(k);
  } catch {
    // .env.development missing or unparseable — no signal to add.
  }

  try {
    const prod = readEncryptedProd(projectDir);
    for (const k of Object.keys(prod)) names.add(k);
  } catch {
    // .env.production missing, encrypted with an unavailable key, or
    // malformed. detect() falls back to manifest hints alone.
  }

  return names;
}
