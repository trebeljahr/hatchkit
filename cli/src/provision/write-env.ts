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
 *  hand-maintained project root, a monorepo not from the starter) are
 *  also accepted. */
export function resolveEnvTarget(projectDir: string): { baseDir: string; layout: "starter" | "root" } {
  const starterDir = join(projectDir, "packages/server");
  if (existsSync(starterDir)) {
    return { baseDir: starterDir, layout: "starter" };
  }
  return { baseDir: projectDir, layout: "root" };
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
