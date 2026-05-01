/*
 * Tiny helpers for keeping `.env.keys` (and friends) out of git.
 *
 * Used by `hatchkit adopt` because the user's repo predates hatchkit
 * and may not have `.env.keys` in `.gitignore`. The first time we
 * generate `.env.keys`, we MUST also ensure it's gitignored — otherwise
 * the next `git add -A` sweeps the dotenvx private key into the repo,
 * and a `git push` to a public remote leaks it forever.
 *
 * The defensive guard lives here too: scan a candidate file's first
 * few lines for the `DOTENV_PRIVATE_KEY` substring (matches both the
 * literal `DOTENV_PRIVATE_KEY_PRODUCTION=…` line and the `.env.keys`
 * banner comment that dotenvx emits). Used as belt-and-braces around
 * `git add` to refuse to stage anything that smells like a private key,
 * regardless of `.gitignore` state.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Marker block we own inside `.gitignore`. The leading newline keeps
 *  the new section visually separate from whatever the user already
 *  had (or no-op'd if they had nothing — git tolerates leading blanks).
 *  The `# hatchkit:` comment is a bread crumb so a curious user can
 *  trace where the line came from. */
const SECTION_HEADER = "# hatchkit: dotenvx private keys (NEVER commit)";

export interface EnsureGitignoreResult {
  /** True iff `.gitignore` did not exist before the call. */
  fileCreated: boolean;
  /** Patterns that were appended this run (subset of the input list). */
  added: string[];
  /** Patterns that were already present (any depth, any form). */
  alreadyPresent: string[];
  /** Absolute path to the `.gitignore` we touched (or would have). */
  path: string;
}

/** Append `patterns` to `<repoRoot>/.gitignore` if not already present.
 *  Creates the file when missing. Considers a pattern "present" when an
 *  existing line matches it exactly after trimming whitespace + a
 *  leading `/` — handles both `.env.keys` and `/.env.keys` / repo-root
 *  patterns the user may already have. */
export function ensureGitignoreEntries(
  repoRoot: string,
  patterns: string[],
): EnsureGitignoreResult {
  const path = join(repoRoot, ".gitignore");
  const fileCreated = !existsSync(path);
  const existing = fileCreated ? "" : readFileSync(path, "utf-8");
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\/+/, ""))
      .filter((l) => l.length > 0 && !l.startsWith("#")),
  );

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const p of patterns) {
    const norm = p.trim().replace(/^\/+/, "");
    if (existingLines.has(norm)) {
      alreadyPresent.push(p);
    } else {
      added.push(p);
    }
  }

  if (added.length === 0) {
    return { fileCreated: false, added, alreadyPresent, path };
  }

  // Build the appended block. End the file with a trailing newline so
  // a subsequent append doesn't glue onto the same physical line.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = `${needsLeadingNewline ? "\n" : ""}${existing.length > 0 ? "\n" : ""}${SECTION_HEADER}\n${added.join("\n")}\n`;
  writeFileSync(path, existing + block);

  return { fileCreated, added, alreadyPresent, path };
}

/** True iff the file's first `lines` lines contain the literal string
 *  `DOTENV_PRIVATE_KEY`. Disjoint from `DOTENV_PUBLIC_KEY` (they share
 *  no common substring beyond `DOTENV_`), so this is safe against the
 *  encrypted-but-public-key header dotenvx writes into `.env.production`. */
export function looksLikeDotenvxPrivateKey(filePath: string, lines = 10): boolean {
  if (!existsSync(filePath)) return false;
  let head: string;
  try {
    head = readFileSync(filePath, "utf-8");
  } catch {
    // Binary / unreadable / permission denied — bail safely (treat as
    // "not a private key" so we don't block staging legit binaries).
    return false;
  }
  const slice = head.split(/\r?\n/, lines).join("\n");
  return slice.includes("DOTENV_PRIVATE_KEY");
}
