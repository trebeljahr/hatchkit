/*
 * env-files — the single place that decides WHICH `.env.*` file a
 * hatchkit project owns.
 *
 * Readers (`hatchkit keys`, `sync`'s env pass) and writers (the
 * provisioners) must agree on this, or a provisioner seeds credentials
 * into a file nothing reads. That exact split shipped once: `provision
 * s3` wrote `<repo>/.env.production` — minting a SECOND dotenvx
 * keypair and a second `.env.keys` at the root — while every reader
 * resolved `packages/server/.env.production`, which held the project's
 * real keypair. The values were encrypted, committed, deployed, and
 * invisible to the app.
 *
 * Search order is the starter's layout, most-specific first: the
 * server package owns the env in a split monorepo (it is the only
 * package with secrets), then the client package, then the repo root
 * for single-package projects.
 *
 * `locateEnvFile` answers "which file exists?" (readers).
 * `resolveEnvFileTarget` answers "which file should I create/update?"
 * (writers) — the same answer once the file exists, and the directory
 * that already holds sibling env files when it doesn't.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Directories scanned for `.env.*`, in precedence order. `""` is the
 *  project root. Shared by every reader and writer. */
export const ENV_FILE_DIRS = [
  "packages/server",
  "apps/server",
  "packages/client",
  "apps/client",
  "",
] as const;

/** Env files that mark a directory as "this is where env lives",
 *  used when the file we want to write doesn't exist yet. */
const ENV_SIBLINGS = [".env.production", ".env.development", ".env.example", ".env.keys"];

/** Every path `name` could live at for this project, in precedence
 *  order. Rebased through the manifest's `projectSubdir` when set. */
export function envFileCandidates(projectDir: string, name: string): string[] {
  const root = resolveEnvSearchRoot(projectDir);
  return ENV_FILE_DIRS.map((dir) => (dir ? join(root, dir, name) : join(root, name)));
}

/** The existing `name` for this project, or undefined when it has none. */
export function locateEnvFile(projectDir: string, name: string): string | undefined {
  return envFileCandidates(projectDir, name).find((p) => existsSync(p));
}

/** Where a writer should put `name`. Prefers, in order:
 *    1. the file itself, when it already exists (never fork a second
 *       copy of a file a reader is already resolving),
 *    2. the highest-precedence directory that already holds OTHER env
 *       files — a project whose env lives in `packages/server` gets
 *       its new `.env.production` there, next to the keypair that
 *       already encrypts `.env.development`'s production twin,
 *    3. the highest-precedence directory that exists at all,
 *    4. the project root. */
export function resolveEnvFileTarget(projectDir: string, name: string): string {
  const existing = locateEnvFile(projectDir, name);
  if (existing) return existing;

  const candidates = envFileCandidates(projectDir, name);
  const withSiblings = candidates.find((p) =>
    ENV_SIBLINGS.some((sibling) => existsSync(join(dirname(p), sibling))),
  );
  if (withSiblings) return withSiblings;

  const inExistingDir = candidates.find((p) => existsSync(dirname(p)));
  if (inExistingDir) return inExistingDir;

  return candidates[candidates.length - 1];
}

/** Resolve which directory to scan for `.env.*` given a project dir.
 *  When the project's manifest records a `projectSubdir`, walks into
 *  it; otherwise falls back to the supplied dir. The manifest lookup
 *  tolerates either the projectDir itself or an enclosing dir carrying
 *  it — so `cd /repo && hatchkit keys push <name>` AND `cd /repo/site
 *  && hatchkit keys push <name>` both resolve to the same env files. */
export function resolveEnvSearchRoot(projectDir: string): string {
  const manifestDir = findManifestDir(projectDir);
  if (!manifestDir) return projectDir;
  try {
    const raw = readFileSync(join(manifestDir, ".hatchkit.json"), "utf-8");
    const parsed = JSON.parse(raw) as { projectSubdir?: unknown };
    if (typeof parsed.projectSubdir === "string" && parsed.projectSubdir.trim()) {
      return join(manifestDir, parsed.projectSubdir);
    }
  } catch {
    // Unreadable / malformed manifest — fall back to the supplied dir.
  }
  return manifestDir;
}

function findManifestDir(projectDir: string): string | undefined {
  let dir = projectDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".hatchkit.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
