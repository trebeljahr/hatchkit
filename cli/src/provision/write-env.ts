/*
 * write-env — write provisioned credentials directly into a project's
 * `.env.development` (plain) and `.env.production` (dotenvx-encrypted).
 *
 * Motivation: printing env blocks to stdout leaks secret values into
 * the user's terminal scrollback / shell history / any process log
 * capturing the CLI. Writing straight into the project repo means:
 *   · dev values land in a gitignored `.env.development`
 *   · prod values land in a commit-safe encrypted `.env.production`
 *   · nothing with a live secret crosses stdout
 *
 * The starter lays env files under `packages/server/`; we detect that
 * layout first and fall back to the project root otherwise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { set as dotenvxSet } from "@dotenvx/dotenvx";
import { resolveEnvFileTarget } from "../utils/env-files.js";

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

/** Upsert plain-text KEY=VALUE entries into `.env.development`. If the
 *  file already has a line for a given key, we replace it in place so
 *  re-runs don't duplicate entries. */
export function writeDevEnv(envPath: string, pairs: EnvPair[]): string[] {
  ensureParent(envPath);
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
