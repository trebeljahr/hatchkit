/*
 * Tiny helpers for keeping `.env.keys` (and friends) out of git.
 *
 * Used by `hatchkit adopt` because the user's repo predates hatchkit
 * and may not have `.env.keys` in `.gitignore`. The first time we
 * generate `.env.keys`, we MUST also ensure it's gitignored — otherwise
 * the next `git add -A` sweeps the dotenvx private key into the repo,
 * and a `git push` to a public remote leaks it forever.
 *
 * The content probe lives here too: `looksLikeDotenvxPrivateKey` finds
 * a `DOTENV_PRIVATE_KEY_*=<hex>` line in any file. `utils/git-safety.ts`
 * runs it over every staged file, next to its file-name denylist, so a
 * key is refused regardless of `.gitignore` state or file name.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { devNull, homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

/** Marker block we own inside `.gitignore`. The leading newline keeps
 *  the new section visually separate from whatever the user already
 *  had (or no-op'd if they had nothing — git tolerates leading blanks).
 *  The `# hatchkit:` comment is a bread crumb so a curious user can
 *  trace where the line came from. */
const SECTION_HEADER = "# hatchkit: secret files (NEVER commit)";

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

/** A `DOTENV_PRIVATE_KEY_<ENV>=<hex>` assignment: the line dotenvx writes
 *  into `.env.keys`, wherever the file was copied or renamed to. The
 *  value must be bare hex, so a reference to the NAME does not match —
 *  the starter's `config/env.ts` comment, a Dockerfile `ENV` line, a
 *  workflow's `${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}` — and
 *  neither does `DOTENV_PUBLIC_KEY_*`, which every encrypted
 *  `.env.production` carries in its header. */
const DOTENVX_PRIVATE_KEY_LINE =
  /^[ \t]*(?:export[ \t]+)?DOTENV_PRIVATE_KEY[A-Z0-9_]*[ \t]*=[ \t]*(["']?)[0-9a-fA-F]+\1[ \t]*(?:#.*)?$/m;

/** Files larger than this are not scanned: a key file is a few hundred
 *  bytes, and reading every large asset of a scaffold would slow the
 *  commit for nothing. */
const MAX_SCAN_BYTES = 1024 * 1024;

/** True iff the file holds a dotenvx private key value. */
export function looksLikeDotenvxPrivateKey(filePath: string): boolean {
  let text: string;
  try {
    if (!existsSync(filePath) || statSync(filePath).size > MAX_SCAN_BYTES) return false;
    text = readFileSync(filePath, "utf-8");
  } catch {
    // Unreadable or a directory: not a key file.
    return false;
  }
  return DOTENVX_PRIVATE_KEY_LINE.test(text);
}

/** Paths already confirmed ignored this process, so a loop of dotenvx
 *  writes into one file spawns git once, not once per key. */
const confirmedIgnored = new Set<string>();

/** Make sure git ignores `filePath` on every clone of its repo, and
 *  append `pattern` to `.gitignore` when it does not. Call it BEFORE
 *  writing a secret file: once the file exists unignored, the next
 *  `git add -A` stages it.
 *
 *  "Every clone" is the point. The probe runs `git check-ignore` with
 *  the global excludes file switched off, because a machine-wide
 *  `~/.config/git/ignore` that lists the file protects this laptop and
 *  no other checkout of the repo.
 *
 *  Outside a git repo (`hatchkit create` writes env files before
 *  `git init`), the `.gitignore` files between the file and the project
 *  root are read for a literal `pattern` line; the project root is the
 *  nearest ancestor with `.hatchkit.json`, `pnpm-workspace.yaml` or
 *  `.git`, else the file's own directory.
 *
 *  Returns what `ensureGitignoreEntries` did, or null when the path was
 *  already ignored. */
export function ensureIgnoredOnEveryClone(
  filePath: string,
  pattern: string,
): EnsureGitignoreResult | null {
  // Resolve symlinks in the part that exists (macOS tmpdir is
  // /var → /private/var), or `relative` from git's toplevel escapes it.
  const existing = nearestExistingDir(dirname(resolve(filePath)));
  const abs = join(realpathSync(existing), relative(existing, resolve(filePath)));
  const key = `${abs}\0${pattern}`;
  if (confirmedIgnored.has(key)) return null;

  const dir = realpathSync(existing);
  const top = gitToplevel(dir);
  if (top) {
    if (ignoredByRepo(top, relative(top, abs))) {
      confirmedIgnored.add(key);
      return null;
    }
    const result = ensureGitignoreEntries(top, [pattern]);
    confirmedIgnored.add(key);
    return result;
  }

  const root = projectRootFor(dir);
  for (let d = dirname(abs); ; d = dirname(d)) {
    const gi = join(d, ".gitignore");
    if (existsSync(gi) && gitignoreHasLine(readFileSync(gi, "utf-8"), pattern)) {
      confirmedIgnored.add(key);
      return null;
    }
    if (d === root || dirname(d) === d) break;
  }
  const result = ensureGitignoreEntries(root, [pattern]);
  confirmedIgnored.add(key);
  return result;
}

function nearestExistingDir(dir: string): string {
  let d = dir;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

function gitToplevel(cwd: string): string | undefined {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : undefined;
}

/** True when the repo's own ignore rules cover `rel`. `--no-index`
 *  evaluates the patterns even for a tracked path; the empty
 *  `core.excludesFile` drops the machine-wide excludes file. */
function ignoredByRepo(top: string, rel: string): boolean {
  const res = spawnSync(
    "git",
    ["-c", `core.excludesFile=${devNull}`, "check-ignore", "-q", "--no-index", "--", rel],
    { cwd: top },
  );
  return res.status === 0;
}

function projectRootFor(dir: string): string {
  const home = homedir();
  for (let d = dir; ; d = dirname(d)) {
    if ([".hatchkit.json", "pnpm-workspace.yaml", ".git"].some((m) => existsSync(join(d, m)))) {
      return d;
    }
    if (d === home || dirname(d) === d) return dir;
  }
}

function gitignoreHasLine(text: string, pattern: string): boolean {
  const want = pattern.trim().replace(/^\/+/, "");
  return text.split(/\r?\n/).some((l) => l.trim().replace(/^\/+/, "") === want);
}
