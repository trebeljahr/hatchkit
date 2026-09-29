/*
 * write-env — write provisioned credentials directly into a project's
 * `.env.development.local` (plain, gitignored) and `.env.production`
 * (dotenvx-encrypted, committed).
 *
 * Motivation: printing env blocks to stdout leaks secret values into
 * the user's terminal scrollback / shell history / any process log
 * capturing the CLI. Writing straight into the project repo means:
 *   · dev values land in `.env.development.local`, which every hatchkit
 *     `.gitignore` covers (`.env.*.local`) and `writeDevEnv` checks
 *   · prod values land in a commit-safe encrypted `.env.production`
 *   · nothing with a live secret crosses stdout
 *
 * NOT `.env.development`. That file is committed on purpose (the
 * starter's `!.env.development` re-includes it past a machine-wide
 * ignore) and holds only safe local defaults. Until 2026-09-29 dev
 * credentials went there, so the Listmonk Admin token and the SES SMTP
 * password were one `git add` away from the repo. `writeDevEnv` now
 * refuses that file and moves any provisioned secret it finds there
 * into `.env.development.local`. See `utils/dev-env-secrets.ts`.
 *
 * The starter lays env files under `packages/server/`; we detect that
 * layout first and fall back to the project root otherwise.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";
import { upgradeServerEnvLoader } from "../utils/dev-env-loader.js";
import {
  DEV_ENV_FILE,
  DEV_LOCAL_ENV_FILE,
  LOCAL_ENV_IGNORE_PATTERN,
  findDevEnvSecrets,
} from "../utils/dev-env-secrets.js";
import { dotenvxSet } from "../utils/dotenvx-safe.js";
import { envFileCandidates, resolveEnvFileTarget } from "../utils/env-files.js";
import {
  describeGitFileState,
  ensureIgnoredOnEveryClone,
  gitFileState,
} from "../utils/gitignore.js";

/** One `KEY=VALUE` pair parsed out of a provisioned env block. */
export interface EnvPair {
  key: string;
  value: string;
}

export interface WriteResult {
  devPath: string;
  prodPath: string;
  devWrittenKeys: string[];
  prodEncryptedKeys: string[];
}

/** Read the set of KEY names already present in an env file, regardless
 *  of whether the values are plaintext or dotenvx-encrypted. Used by
 *  `adopt --resume` to decide whether a given service's credentials are
 *  already wired up (so re-runs don't mint duplicates). Returns an empty
 *  set when the file doesn't exist. */
export function readEnvKeys(envPath: string): Set<string> {
  if (!existsSync(envPath)) return new Set();
  const text = readFileSync(envPath, "utf-8");
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** Parse a list of `KEY=VALUE` lines into structured pairs. Blank
 *  lines and comments are ignored, which matches the format the
 *  provision orchestrator emits today. */
export function parseEnvLines(lines: string[]): EnvPair[] {
  const out: EnvPair[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return out;
}

/** Resolve where `.env.{development,production}` should live. The
 *  starter keeps them under `packages/server/`; other layouts (a
 *  hand-maintained project root, an `apps/server` monorepo) are also
 *  accepted.
 *
 *  Delegates to `utils/env-files.ts`, the same resolver the READERS
 *  use (`hatchkit keys`, `sync`'s env pass). A writer that guesses its
 *  own layout can seed a file no reader resolves — and, worse, mint a
 *  second dotenvx keypair for it. See that module's header.
 *
 *  When `projectSubdir` is supplied (mirrored from
 *  `manifest.projectSubdir`), `projectDir` is treated as the enclosing
 *  repo root and the search is rebased into the subdir. Callers
 *  without manifest awareness can omit the second arg — the shared
 *  resolver reads `projectSubdir` off `.hatchkit.json` itself. */
export function resolveEnvTarget(
  projectDir: string,
  projectSubdir?: string,
): {
  baseDir: string;
  layout: "starter" | "root";
} {
  const root = projectSubdir ? join(projectDir, projectSubdir) : projectDir;
  const baseDir = dirname(resolveEnvFileTarget(root, ".env.production"));
  return { baseDir, layout: baseDir === root ? "root" : "starter" };
}

/** Where provisioned development credentials go: the gitignored
 *  `.env.development.local` in `envDir` (the directory that holds
 *  `.env.development`). */
export function devLocalEnvPath(envDir: string): string {
  return join(envDir, DEV_LOCAL_ENV_FILE);
}

/** Upsert plain-text KEY=VALUE entries into a gitignored local env
 *  file, normally `devLocalEnvPath(envDir)`. If the file already has a
 *  line for a given key, we replace it in place so re-runs don't
 *  duplicate entries.
 *
 *  Throws on `.env.development`: that file is committed. Before the
 *  first write it makes the repo ignore the target, and moves any
 *  provisioned secret still in the sibling `.env.development` into it
 *  (`migrateDevSecretsToLocal`). */
export function writeDevEnv(envPath: string, pairs: EnvPair[]): string[] {
  if (basename(envPath) === DEV_ENV_FILE) {
    throw new Error(
      `writeDevEnv refuses ${envPath}: .env.development is committed. ` +
        `Write provisioned values to ${DEV_LOCAL_ENV_FILE} (devLocalEnvPath).`,
    );
  }
  ensureParent(envPath);
  ensureIgnoredOnEveryClone(envPath, ignorePatternFor(envPath));
  if (basename(envPath) === DEV_LOCAL_ENV_FILE) {
    ensureDevLocalLoaded(dirname(envPath));
    reportMigration(migrateDevSecretsToLocal(dirname(envPath)));
  }
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = existing === "" ? [] : existing.split("\n");

  const wroteKeys: string[] = [];
  for (const { key, value } of pairs) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${serializeDevValue(value)}`;
    if (idx >= 0) {
      lines[idx] = line;
    } else {
      lines.push(line);
    }
    wroteKeys.push(key);
  }

  // Trim trailing newlines then re-add exactly one so diffs stay clean.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return wroteKeys;
}

/** Encrypt each KEY into `.env.production` via dotenvx. First call
 *  generates the keypair and writes `.env.keys`. */
export function writeProdEnv(envPath: string, pairs: EnvPair[]): string[] {
  ensureParent(envPath);
  const encrypted: string[] = [];
  for (const { key, value } of pairs) {
    dotenvxSet(key, value, { path: envPath, encrypt: true });
    encrypted.push(key);
  }
  return encrypted;
}

/** Delete each `KEY=` line in `keys` from an env file, encrypted or
 *  plain; other lines, comments and the dotenvx header stay as they
 *  are. Returns the keys it found and removed. A missing file is a
 *  no-op. Single-line values only — every key hatchkit writes is one. */
export function removeEnvKeys(envPath: string, keys: readonly string[]): string[] {
  if (!existsSync(envPath) || keys.length === 0) return [];
  const text = readFileSync(envPath, "utf-8");
  const removed: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !keys.includes(m[1])) return true;
    if (!removed.includes(m[1])) removed.push(m[1]);
    return false;
  });
  if (removed.length > 0) writeFileSync(envPath, kept.join("\n"), { mode: 0o600 });
  return removed;
}

/** Append a block of comment lines to an env file ONCE. The first line
 *  acts as a sentinel — if it already appears in the file, the call is
 *  a no-op. dotenvx-encrypted files preserve comments verbatim, so this
 *  works the same on `.env.production` (encrypted) and
 *  `.env.development` (plain). Used by Stripe's "skip" path to drop a
 *  visible "wire this up later" recipe above the CHANGE_ME placeholders. */
export function appendCommentBlock(envPath: string, comments: string[]): void {
  if (comments.length === 0) return;
  ensureParent(envPath);
  const sentinel = comments[0];
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  if (existing.includes(sentinel)) return;
  const prefix = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const block = `${comments.join("\n")}\n`;
  writeFileSync(envPath, existing + prefix + block, { mode: 0o600 });
}

export interface DevSecretsMigration {
  /** Keys moved out of `.env.development`, in file order. */
  moved: string[];
  from: string;
  to: string;
}

/** Move every provisioned secret with a real value out of the committed
 *  `<envDir>/.env.development` into `<envDir>/.env.development.local`.
 *  A key the local file already sets keeps the local value: the local
 *  file is the newer one, and it is what the server loads first. Safe
 *  to call repeatedly; returns `moved: []` when there is nothing to do.
 *
 *  Moving the line out of the working tree does not remove it from git
 *  history. The caller warns: a value that was ever committed has to be
 *  rotated. */
export function migrateDevSecretsToLocal(envDir: string): DevSecretsMigration {
  const from = join(envDir, DEV_ENV_FILE);
  const to = join(envDir, DEV_LOCAL_ENV_FILE);
  if (!existsSync(from)) return { moved: [], from, to };
  const text = readFileSync(from, "utf-8");
  const hits = findDevEnvSecrets(text);
  if (hits.length === 0) return { moved: [], from, to };

  ensureIgnoredOnEveryClone(to, LOCAL_ENV_IGNORE_PATTERN);
  const lines = text.split("\n");
  const localText = existsSync(to) ? readFileSync(to, "utf-8") : "";
  const localKeys = readEnvKeysFromText(localText);
  const carried = hits.filter((h) => !localKeys.has(h.key)).map((h) => lines[h.line]);
  if (carried.length > 0) {
    const sep = localText === "" || localText.endsWith("\n") ? "" : "\n";
    const header =
      localText === ""
        ? "# Provisioned development credentials. Gitignored: never commit this file.\n"
        : "";
    writeFileSync(to, `${localText}${sep}${header}${carried.join("\n")}\n`, { mode: 0o600 });
  }
  const drop = new Set(hits.map((h) => h.line));
  writeAtomically(from, lines.filter((_, i) => !drop.has(i)).join("\n"));
  return { moved: hits.map((h) => h.key), from, to };
}

/** Directories whose loader was already checked this process. */
const loaderChecked = new Set<string>();

/** Make the server in `envDir` load `.env.development.local`, so the
 *  values about to be written there reach it. Upgrades the starter's
 *  legacy loader in place; warns about a hand-edited one. */
export function ensureDevLocalLoaded(envDir: string): void {
  if (loaderChecked.has(envDir)) return;
  loaderChecked.add(envDir);
  const { status, path } = upgradeServerEnvLoader(envDir);
  if (status === "upgraded") {
    console.error(chalk.dim(`  · ${path} now loads ${DEV_LOCAL_ENV_FILE} before ${DEV_ENV_FILE}`));
  } else if (status === "custom") {
    console.error(
      chalk.yellow(
        `  ⚠ ${path} does not load ${DEV_LOCAL_ENV_FILE}, and hatchkit did not recognise its loader to update it.\n` +
          `    Load ${DEV_LOCAL_ENV_FILE} before ${DEV_ENV_FILE}, or the dev credentials hatchkit writes there never reach the server.`,
      ),
    );
  }
}

/** `hatchkit update`'s pass over a project scaffolded before
 *  2026-09-29: for every env directory with a `.env.development`, make
 *  its server load `.env.development.local` and move provisioned
 *  credentials there. Returns the keys moved, per file. */
export function retrofitDevEnvSecrets(projectDir: string): DevSecretsMigration[] {
  const out: DevSecretsMigration[] = [];
  for (const devPath of envFileCandidates(projectDir, DEV_ENV_FILE)) {
    if (!existsSync(devPath)) continue;
    const envDir = dirname(devPath);
    ensureDevLocalLoaded(envDir);
    const m = migrateDevSecretsToLocal(envDir);
    reportMigration(m);
    if (m.moved.length > 0) out.push(m);
  }
  return out;
}

/** Warnings go to stderr: `secrets rotate --json` writes its audit to
 *  stdout, and a line of prose there breaks every JSON consumer.
 *
 *  Every claim about `.env.development` comes from git. On 2026-09-29
 *  this warning said "is committed" about two files git never saw, in
 *  the middle of a key-leak response, and sent us looking for a second
 *  leak. Names keys and paths, never values. */
function reportMigration(m: DevSecretsMigration): void {
  if (m.moved.length === 0) return;
  const belongs = `Provisioned credentials belong in the gitignored ${DEV_LOCAL_ENV_FILE}.`;
  const history = "If any of those commits held these values, they are in git history:";
  const rotate =
    "rotate each one with its provider (`hatchkit secrets rotate` covers the supported ones).";
  const state = gitFileState(m.from);
  const facts = describeGitFileState(m.from, state);
  let lines: string[];
  switch (state.kind) {
    case "tracked":
      lines =
        state.commits > 0
          ? [
              ...facts,
              "Commit this change too, so the committed copy drops these values.",
              history,
              rotate,
            ]
          : [
              ...facts,
              "Stage this change before you commit, so the first commit does not record these values.",
            ];
      break;
    case "in-history":
      lines = [...facts, history, rotate];
      break;
    case "never-committed":
      lines = [...facts, belongs];
      break;
    case "unknown":
      lines = [
        `Hatchkit projects commit ${DEV_ENV_FILE}. ${belongs}`,
        `If ${m.from} was ever committed with these values, they are in git history:`,
        rotate,
      ];
      break;
  }
  console.error(
    chalk.yellow(
      `  ⚠ Moved ${m.moved.join(", ")} from ${DEV_ENV_FILE} to ${DEV_LOCAL_ENV_FILE}.\n` +
        lines.map((l) => `    ${l}`).join("\n"),
    ),
  );
}

function readEnvKeysFromText(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** `.env.*.local` for the local env files, the file's own name otherwise. */
function ignorePatternFor(envPath: string): string {
  const name = basename(envPath);
  return /^\.env\..+\.local$/.test(name) ? LOCAL_ENV_IGNORE_PATTERN : name;
}

/** Replace a file's contents via a sibling temp file, so an interrupted
 *  run never leaves a half-written `.env.development`. */
function writeAtomically(path: string, text: string): void {
  const tmp = `${path}.hatchkit-tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

function ensureParent(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

/** Quote a dev-env value if it contains whitespace or shell-special
 *  characters. Plain alphanumerics / common URL/token shapes stay
 *  unquoted so the file reads naturally. */
function serializeDevValue(value: string): string {
  if (/^[A-Za-z0-9_\-./:=+@]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
