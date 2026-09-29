/*
 * cli/src/secrets/key-history.ts — "is this project's CURRENT dotenvx
 * private key already readable from git history?"
 *
 * Why this guard exists (2026-09-28, collection-of-beauty): `.env.keys`
 * was committed once and removed two days later. The file left the tree
 * but not the history, and the key in it was still the one encrypting
 * `.env.production` five months on. Every value hatchkit writes into
 * that file is encrypted to that public key — so rotating a provider
 * credential BEFORE the keypair would publish the new value on the next
 * push, exactly like the old one.
 *
 * `assertEnvKeysNotTracked` (env-writer.ts) only sees the index. This
 * module walks history on every ref, reads each committed `.env.keys`
 * blob in memory, and compares the public key each committed private
 * key derives against `DOTENV_PUBLIC_KEY_PRODUCTION` in the current
 * `.env.production`. No key material is printed, logged or written:
 * the report carries short commit ids and paths only.
 */

import { derivePublicKey, locateEnvProductionFile, parseEnvKeysEntries, readPublicKey } from "../deploy/keys.js";
import { exec } from "../utils/exec.js";

export type KeyHistoryStatus =
  /** Not inside a git work tree — there is no history to leak from. */
  | "not-a-repo"
  /** `.env.keys` was never committed on any ref. */
  | "clean"
  /** Committed at some point, but none of the committed private keys
   *  derives the current public key: the keypair was rotated since. */
  | "superseded"
  /** A committed private key derives the current public key. Anything
   *  written to `.env.production` now is readable from history. */
  | "leaked"
  /** Committed, and hatchkit cannot tell whether it is the current key
   *  (no public key in `.env.production`, or a blob it could not read). */
  | "unknown";

export interface KeyHistoryReport {
  status: KeyHistoryStatus;
  /** Short ids of the commits that added or changed a `.env.keys`. For
   *  `leaked`, only the commits holding the CURRENT key. */
  commits: string[];
  /** Repo-relative paths those commits touched. */
  paths: string[];
}

/** Walk every ref's history for `.env.keys` at any path and classify it
 *  against the current `.env.production` public key. Read-only. */
export async function inspectEnvKeysHistory(projectDir: string): Promise<KeyHistoryReport> {
  const inRepo = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectDir,
    silent: true,
  });
  if (inRepo.exitCode !== 0 || inRepo.stdout.trim() !== "true") {
    return { status: "not-a-repo", commits: [], paths: [] };
  }

  const log = await exec(
    "git",
    [
      "log",
      "--all",
      "--format=%H",
      "--name-only",
      "--diff-filter=AMRC",
      "--",
      ":(top,glob)**/.env.keys",
    ],
    { cwd: projectDir, silent: true },
  );
  if (log.exitCode !== 0) {
    // A repo with no commits yet answers non-zero; nothing is committed.
    return { status: "clean", commits: [], paths: [] };
  }

  const entries: Array<{ sha: string; path: string }> = [];
  let sha: string | undefined;
  for (const raw of log.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[0-9a-f]{40}$/.test(line)) {
      sha = line;
      continue;
    }
    if (sha) entries.push({ sha, path: line });
  }
  if (entries.length === 0) return { status: "clean", commits: [], paths: [] };

  const allCommits = unique(entries.map((e) => e.sha.slice(0, 8)));
  const allPaths = unique(entries.map((e) => e.path));

  const prodPath = locateEnvProductionFile(projectDir);
  const currentPublic = prodPath ? readPublicKey(prodPath)?.toLowerCase() : undefined;
  if (!currentPublic) {
    return { status: "unknown", commits: allCommits, paths: allPaths };
  }

  const leaked: Array<{ sha: string; path: string }> = [];
  let unreadable = false;
  for (const entry of entries) {
    const blob = await exec("git", ["show", `${entry.sha}:${entry.path}`], {
      cwd: projectDir,
      silent: true,
    });
    if (blob.exitCode !== 0) {
      unreadable = true;
      continue;
    }
    const keys = parseEnvKeysEntries(blob.stdout) ?? [];
    for (const key of keys) {
      let derived: string | undefined;
      try {
        derived = derivePublicKey(key).toLowerCase();
      } catch {
        continue; // not a valid secp256k1 key — cannot be the current one
      }
      if (derived === currentPublic) {
        leaked.push(entry);
        break;
      }
    }
  }

  if (leaked.length > 0) {
    return {
      status: "leaked",
      commits: unique(leaked.map((e) => e.sha.slice(0, 8))),
      paths: unique(leaked.map((e) => e.path)),
    };
  }
  return {
    status: unreadable ? "unknown" : "superseded",
    commits: allCommits,
    paths: allPaths,
  };
}

export interface AssertKeysNotLeakedOptions {
  /** The operator states the keypair was rotated after the leak. Lets
   *  an `unknown` result through; never overrides a proven `leaked`. */
  keysRotated?: boolean;
  /** Used in the recovery command the error prints. */
  projectName: string;
}

/** REFUSE-level guard. Throws when a committed `.env.keys` holds the key
 *  that encrypts `.env.production` today, or when that cannot be ruled
 *  out and the operator has not passed `--keys-rotated`. Returns the
 *  report so callers can print a note for `superseded`. */
export async function assertKeysNotLeaked(
  projectDir: string,
  opts: AssertKeysNotLeakedOptions,
): Promise<KeyHistoryReport> {
  const report = await inspectEnvKeysHistory(projectDir);
  if (report.status === "leaked") {
    throw new Error(keyHistoryRefusal(report, opts));
  }
  if (report.status === "unknown" && !opts.keysRotated) {
    throw new Error(keyHistoryRefusal(report, opts));
  }
  return report;
}

/** Operator-facing refusal text. Exported so the global fan-out can put
 *  the same recovery recipe on a skipped consumer. */
export function keyHistoryRefusal(report: KeyHistoryReport, opts: AssertKeysNotLeakedOptions): string {
  const where = `${report.paths.join(", ")} (commit ${report.commits.join(", ")})`;
  const recipe =
    `  hatchkit keys rotate ${opts.projectName}\n` +
    "  git add <the re-encrypted .env.production> && git commit\n" +
    `Then retry${report.status === "unknown" ? " with --keys-rotated" : ""}.`;
  if (report.status === "leaked") {
    const flagNote = opts.keysRotated
      ? " --keys-rotated was passed, but the committed key still derives the current public key, so the keypair has not been rotated."
      : "";
    return (
      `REFUSE: the dotenvx private key that encrypts .env.production today is in git history: ${where}. ` +
      `A new credential written now is readable by anyone with that history.${flagNote} Rotate the keypair first:\n${recipe}`
    );
  }
  return (
    `REFUSE: .env.keys appears in git history: ${where}, and hatchkit cannot tell whether that key still encrypts .env.production. ` +
    `If it does, a new credential written now is readable by anyone with that history. Rotate the keypair first:\n${recipe}`
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
