/*
 * env-keys-history — has a dotenvx private key ever touched git?
 *
 * Untracking `.env.keys` removes it from the tree, not from history, and
 * making a repo public publishes its whole history. collection-of-beauty
 * committed its key in 98f3e695, untracked it two days later, never
 * rotated it, and then encrypted every later secret to that key. Doctor
 * reported the project healthy the whole time, because it only asked
 * whether the file was tracked NOW.
 *
 * Everything here is read-only and answers in booleans, counts, commit
 * shas and dates. Private keys are read into memory to compare them, and
 * never leave this module: not in a return value, a log line or an error,
 * and not as a fingerprint either.
 *
 * Doctor reads the dates, the older keys and the env versions encrypted
 * to them. `secrets/key-history.ts` reads the commits and paths for
 * `secrets rotate`'s refusal, which asks only "does a committed key
 * derive today's public key?".
 */

import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { PrivateKey } from "eciesjs";
import { execa } from "execa";

/** Per git call. Doctor must stay fast on a big repo and never hang. */
const GIT_TIMEOUT_MS = 15_000;
/** Commits read per log. Far past any real project's key/env churn. */
const MAX_KEY_COMMITS = 1_000;
const MAX_ENV_COMMITS = 5_000;

const KEY_PATHSPECS = [".env.keys", "**/.env.keys"];
const ENV_PATHSPECS = [".env", ".env.*", "**/.env", "**/.env.*"];

export interface CommitRef {
  shortSha: string;
  /** Committer date, YYYY-MM-DD. */
  date: string;
}

export interface EnvExposure {
  /** Committed env-file versions encrypted to the matching keys. */
  count: number;
  first?: string;
  last?: string;
  /** Basenames of those files, e.g. [".env.production"]. */
  files: string[];
}

export interface KeyFiles {
  /** Eight-hex-digit commit shas, in `git log` order (newest first). */
  commits: string[];
  /** Repo-relative paths, e.g. ["packages/server/.env.keys"]. */
  paths: string[];
}

export interface EnvKeysHistory {
  /** False when git could not answer (no git, timeout). Every other
   *  field is then empty. */
  checked: boolean;
  /** Shallow clone: commits past the graft point were not seen. */
  shallow: boolean;
  /** A log hit its commit cap, so the answer may be incomplete. */
  truncated: boolean;
  /** Earliest commit holding a private key still in use. */
  currentKeyCommit?: CommitRef;
  /** Earliest commit holding a private key no longer in use. */
  oldKeyCommit?: CommitRef;
  /** Env-file versions encrypted to a committed key still in use. */
  currentExposure: EnvExposure;
  /** Env-file versions encrypted to a committed key no longer in use. */
  oldExposure: EnvExposure;
  /** Every commit that wrote a `.env.keys`, and the paths it wrote. */
  keyFiles: KeyFiles;
  /** The commits and paths whose `.env.keys` holds a key still in use. */
  currentKeyFiles: KeyFiles;
  /** A committed `.env.keys` could not be read (a shallow or partial
   *  clone lacks it, or `git cat-file` failed), so a key in use may have
   *  gone unseen. */
  unreadable: boolean;
}

export interface ScanOptions {
  /** False skips the env-file walk, and both exposures stay empty.
   *  `secrets rotate` needs only the key files. Default true. */
  exposure?: boolean;
}

export interface CurrentKeys {
  /** Private keys in use today (the on-disk `.env.keys`). */
  privateKeys: string[];
  /** `DOTENV_PUBLIC_KEY_*` values in the working tree's env files.
   *  Catches a burned key even where `.env.keys` isn't on disk. */
  publicKeys: string[];
}

interface GitOut {
  ok: boolean;
  stdout: string;
}

async function git(cwd: string, args: string[]): Promise<GitOut> {
  try {
    const r = await execa("git", args, { cwd, reject: false, timeout: GIT_TIMEOUT_MS });
    return { ok: r.exitCode === 0, stdout: typeof r.stdout === "string" ? r.stdout : "" };
  } catch {
    // No git binary.
    return { ok: false, stdout: "" };
  }
}

export interface IgnoreState {
  ignored: boolean;
  /** Ignored by a `.gitignore` inside the repo, so every clone has it.
   *  False for the global excludes file and `.git/info/exclude`. */
  portable: boolean;
  /** Where the winning pattern lives, as git reports it. */
  source?: string;
  /** The winning pattern is a `!` negation that re-includes the file. */
  negated: boolean;
}

/** Why `path` is (or isn't) ignored. `git check-ignore -v` prints
 *  `<source>:<line>:<pattern>\t<path>`; the source is repo-relative for
 *  a `.gitignore` or `.git/info/exclude`, and absolute for the global
 *  excludes file. It also exits 0 when the winning pattern is a
 *  negation, which means NOT ignored. */
export async function ignoreState(cwd: string, path: string): Promise<IgnoreState> {
  const r = await git(cwd, ["check-ignore", "-v", "--", path]);
  const line = r.stdout.split("\n").find((l) => l.trim());
  if (!r.ok || !line) return { ignored: false, portable: false, negated: false };
  const head = line.split("\t")[0];
  const m = head.match(/^(.*):(\d+):(.*)$/);
  const source = m ? m[1] : head;
  const pattern = m ? m[3] : "";
  const negated = pattern.trim().startsWith("!");
  const portable =
    !isAbsolute(source) && basename(source) === ".gitignore" && !source.startsWith(".git/");
  return { ignored: !negated, portable: !negated && portable, source, negated };
}

/** Private keys on every `DOTENV_PRIVATE_KEY*` line, comma lists split. */
export function parsePrivateKeys(content: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:export\s+)?DOTENV_PRIVATE_KEY(?:_[A-Z0-9_]+)?\s*=\s*["']?([^"'\n#]*)/gm;
  for (const m of content.matchAll(re)) {
    for (const k of m[1].split(",")) {
      const key = k.trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(key)) out.push(key);
    }
  }
  return out;
}

/** The key in use per `DOTENV_PRIVATE_KEY*` line: dotenvx appends on
 *  rotate, so it's the last entry of each comma list. */
export function parseCurrentPrivateKeys(content: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:export\s+)?DOTENV_PRIVATE_KEY(?:_[A-Z0-9_]+)?\s*=\s*["']?([^"'\n#]*)/gm;
  for (const m of content.matchAll(re)) {
    const entries = m[1]
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => /^[0-9a-f]{64}$/.test(k));
    if (entries.length > 0) out.push(entries[entries.length - 1]);
  }
  return out;
}

export function parsePublicKeys(content: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:export\s+)?DOTENV_PUBLIC_KEY(?:_[A-Z0-9_]+)?\s*=\s*["']?([0-9a-fA-F]+)/gm;
  for (const m of content.matchAll(re)) out.push(m[1].toLowerCase());
  return out;
}

function fingerprint(privateKey: string): string {
  return createHash("sha256").update(privateKey.toLowerCase()).digest("hex");
}

function publicKeyOf(privateKey: string): string | undefined {
  try {
    return new PrivateKey(Buffer.from(privateKey, "hex")).publicKey.toHex().toLowerCase();
  } catch {
    // Not a valid secp256k1 scalar.
    return undefined;
  }
}

interface LogCommit {
  sha: string;
  /** Committer time, unix seconds, for ordering. */
  time: number;
  /** Committer date, YYYY-MM-DD. */
  date: string;
}

interface BlobChange {
  blob: string;
  path: string;
  commit: LogCommit;
}

/** Every blob `pathspecs` took across all refs, with the commit that
 *  wrote it. Deletions are dropped: the commit that removes a file
 *  doesn't hold it. `--no-renames` keeps each path on its own line. */
async function blobChanges(
  cwd: string,
  pathspecs: string[],
  maxCount: number,
): Promise<{ ok: boolean; truncated: boolean; changes: BlobChange[] }> {
  const r = await git(cwd, [
    "-c",
    "core.quotePath=false",
    "log",
    "--all",
    "--no-renames",
    "--raw",
    "--no-abbrev",
    `--max-count=${maxCount}`,
    "--format=%x01%H%x09%ct%x09%cs",
    "--",
    ...pathspecs,
  ]);
  if (!r.ok) return { ok: false, truncated: false, changes: [] };
  const changes: BlobChange[] = [];
  let commit: LogCommit | undefined;
  let commits = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("\x01")) {
      const [sha, time, date] = line.slice(1).split("\t");
      commit = { sha, time: Number(time), date: date ?? "" };
      commits++;
      continue;
    }
    if (!commit || !line.startsWith(":")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const blob = line.slice(0, tab).split(" ")[3];
    if (!blob || /^0+$/.test(blob)) continue;
    changes.push({ blob, path: line.slice(tab + 1), commit });
  }
  return { ok: true, truncated: commits >= maxCount, changes };
}

/** Read blobs in one `git cat-file --batch` call. Objects a shallow or
 *  partial clone lacks come back `missing` and are skipped. */
async function readBlobs(cwd: string, blobs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (blobs.length === 0) return out;
  let buf: Buffer;
  try {
    const r = await execa("git", ["cat-file", "--batch"], {
      cwd,
      reject: false,
      timeout: GIT_TIMEOUT_MS,
      input: `${blobs.join("\n")}\n`,
      encoding: "buffer",
    });
    if (r.exitCode !== 0) return out;
    buf = Buffer.from(r.stdout as Uint8Array);
  } catch {
    return out;
  }
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) break;
    const [oid, type, size] = buf.subarray(off, nl).toString("utf8").split(" ");
    if (type !== "blob" || !size) {
      off = nl + 1;
      continue;
    }
    const end = nl + 1 + Number(size);
    out.set(oid, buf.subarray(nl + 1, end).toString("utf8"));
    off = end + 1;
  }
  return out;
}

function earlier(a: LogCommit | undefined, b: LogCommit): LogCommit {
  return !a || b.time < a.time ? b : a;
}

/** Eight hex digits, the same abbreviation `secrets rotate` prints. */
function toRef(commit: LogCommit | undefined): CommitRef | undefined {
  return commit && { shortSha: commit.sha.slice(0, 8), date: commit.date };
}

function emptyExposure(): EnvExposure {
  return { count: 0, files: [] };
}

function addKeyFile(files: KeyFiles, change: BlobChange): void {
  const shortSha = change.commit.sha.slice(0, 8);
  if (!files.commits.includes(shortSha)) files.commits.push(shortSha);
  if (!files.paths.includes(change.path)) files.paths.push(change.path);
}

/** Has any dotenvx private key been committed on any ref, and is it the
 *  one in use today? A committed key counts as current when it equals a
 *  key in `current.privateKeys` (compared by sha256 fingerprint) or
 *  derives a public key the working tree still encrypts to. */
export async function scanEnvKeysHistory(
  repoRoot: string,
  current: CurrentKeys,
  opts: ScanOptions = {},
): Promise<EnvKeysHistory> {
  const result: EnvKeysHistory = {
    checked: false,
    shallow: false,
    truncated: false,
    currentExposure: emptyExposure(),
    oldExposure: emptyExposure(),
    keyFiles: { commits: [], paths: [] },
    currentKeyFiles: { commits: [], paths: [] },
    unreadable: false,
  };

  const keyLog = await blobChanges(repoRoot, KEY_PATHSPECS, MAX_KEY_COMMITS);
  if (!keyLog.ok) return result;
  result.checked = true;
  result.truncated = keyLog.truncated;
  const shallow = await git(repoRoot, ["rev-parse", "--is-shallow-repository"]);
  result.shallow = shallow.ok && shallow.stdout.trim() === "true";
  if (keyLog.changes.length === 0) return result;

  const currentFps = new Set(current.privateKeys.map(fingerprint));
  const currentPubs = new Set(current.publicKeys.map((p) => p.toLowerCase()));
  // Public keys of the committed private keys, split by whether they're
  // still in use. Public keys are safe to hold: they're committed anyway.
  const burnedPubs = new Set<string>();
  const oldPubs = new Set<string>();
  let currentCommit: LogCommit | undefined;
  let oldCommit: LogCommit | undefined;

  const contents = await readBlobs(repoRoot, [...new Set(keyLog.changes.map((c) => c.blob))]);
  for (const change of keyLog.changes) {
    addKeyFile(result.keyFiles, change);
    // An empty blob reads as "", which is not a missing one.
    const content = contents.get(change.blob);
    if (content === undefined) {
      result.unreadable = true;
      continue;
    }
    for (const key of parsePrivateKeys(content)) {
      const pub = publicKeyOf(key);
      const inUse = currentFps.has(fingerprint(key)) || (!!pub && currentPubs.has(pub));
      if (inUse) {
        currentCommit = earlier(currentCommit, change.commit);
        addKeyFile(result.currentKeyFiles, change);
        if (pub) burnedPubs.add(pub);
      } else {
        oldCommit = earlier(oldCommit, change.commit);
        if (pub) oldPubs.add(pub);
      }
    }
  }
  result.currentKeyCommit = toRef(currentCommit);
  result.oldKeyCommit = toRef(oldCommit);
  if (opts.exposure === false || (burnedPubs.size === 0 && oldPubs.size === 0)) return result;

  const envLog = await blobChanges(repoRoot, ENV_PATHSPECS, MAX_ENV_COMMITS);
  if (!envLog.ok) return result;
  if (envLog.truncated) result.truncated = true;
  const envChanges = envLog.changes.filter((c) => basename(c.path) !== ".env.keys");
  const envContents = await readBlobs(repoRoot, [...new Set(envChanges.map((c) => c.blob))]);
  for (const change of envChanges) {
    const content = envContents.get(change.blob);
    if (!content) continue;
    const pubs = parsePublicKeys(content);
    if (pubs.some((p) => burnedPubs.has(p))) addExposure(result.currentExposure, change);
    else if (pubs.some((p) => oldPubs.has(p))) addExposure(result.oldExposure, change);
  }
  return result;
}

function addExposure(exposure: EnvExposure, change: BlobChange): void {
  exposure.count++;
  const { date } = change.commit;
  if (!exposure.first || date < exposure.first) exposure.first = date;
  if (!exposure.last || date > exposure.last) exposure.last = date;
  const file = basename(change.path);
  if (!exposure.files.includes(file)) exposure.files.push(file);
}

/** `owner/repo is PUBLIC` for a GitHub origin, via `gh`. Undefined when
 *  there's no GitHub origin, no `gh`, no auth or no network — doctor
 *  must never fail because of `gh`. */
export async function originVisibility(repoRoot: string): Promise<string | undefined> {
  const url = (await git(repoRoot, ["remote", "get-url", "origin"])).stdout.trim();
  const m =
    url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/) ??
    url.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return undefined;
  const slug = `${m[1]}/${m[2]}`;
  try {
    const r = await execa(
      "gh",
      ["repo", "view", slug, "--json", "visibility", "-q", ".visibility"],
      {
        reject: false,
        timeout: 8_000,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    );
    const visibility = typeof r.stdout === "string" ? r.stdout.trim() : "";
    if (r.exitCode !== 0 || !visibility) return undefined;
    return visibility === "PUBLIC"
      ? `origin (${slug}) is PUBLIC`
      : `origin (${slug}) is ${visibility.toLowerCase()}`;
  } catch {
    return undefined;
  }
}
