/*
 * Tiny helper for keeping `.env.production` *in* the Docker build context.
 *
 * hatchkit-managed projects commit a dotenvx-encrypted `.env.production`
 * to git (encryption is the whole point — the file's content is
 * `KEY="encrypted:..."`, safe to ship). Many existing repos already
 * carry a defensive `.dockerignore` that wildcards out the entire
 * `.env*` family, which inadvertently strips the encrypted file from
 * the build context too. dotenvx then can't find the file at build
 * (or runtime) and silently exports zero env vars — `next build` /
 * `pnpm build` runs with empty NEXT_PUBLIC_* values, baking broken
 * URLs into the image.
 *
 * The fix is one line: append `!.env.production` so the encrypted file
 * survives the wildcard. We do NOT remove the user's existing exclude
 * rules — those still keep plaintext `.env`, `.env.local`, and (most
 * importantly) `.env.keys` (the private key) out of the image.
 *
 * No-op when `.dockerignore` doesn't exist: Docker copies everything by
 * default, so the encrypted file is already in the context.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECTION_HEADER =
  "# hatchkit: dotenvx-encrypted .env.production must remain in the build context (decrypted in-memory by `dotenvx run`)";

export interface EnsureDockerignoreResult {
  /** Absolute path we inspected (whether or not it existed). */
  path: string;
  /** True iff there was no `.dockerignore` before this call. We never
   *  create one — see the module docstring for why. */
  fileExisted: boolean;
  /** True iff we appended a hatchkit-managed line. False when the
   *  negation was already present, or when there was no file. */
  modified: boolean;
}

/** Idempotently ensure `<repoRoot>/.dockerignore` allows `.env.production`
 *  through. Appends `!.env.production` (with a `# hatchkit:` bread crumb)
 *  when the negation is missing AND a `.dockerignore` exists.
 *
 *  The negation is a safe append — if nothing actually excluded
 *  `.env.production`, the line is a redundant no-op. We don't try to
 *  parse the user's patterns to decide whether the line is needed; the
 *  parsing surface area (globs, `**`, anchored vs. unanchored, repeated
 *  rule overrides) isn't worth getting subtly wrong when the redundant
 *  case is harmless.
 */
export function ensureDockerignoreAllowsEnvProduction(repoRoot: string): EnsureDockerignoreResult {
  const path = join(repoRoot, ".dockerignore");
  if (!existsSync(path)) {
    return { path, fileExisted: false, modified: false };
  }
  const existing = readFileSync(path, "utf-8");
  // Match `!.env.production` exactly — trim whitespace, ignore inline
  // comments. We don't accept `!**/.env.production` or other variants
  // here; they're rare enough that erring on the side of duplicate
  // negations is fine.
  const hasNegate = existing.split(/\r?\n/).some((l) => l.trim() === "!.env.production");
  if (hasNegate) {
    return { path, fileExisted: true, modified: false };
  }

  // Append with a leading blank line + comment so the appended block
  // visually separates from whatever the user already had. End with a
  // trailing newline so a future append doesn't glue onto our line.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = `${needsLeadingNewline ? "\n" : ""}\n${SECTION_HEADER}\n!.env.production\n`;
  writeFileSync(path, existing + block);
  return { path, fileExisted: true, modified: true };
}
