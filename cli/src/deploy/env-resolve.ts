/*
 * Resolve a project's production environment for pushing to Coolify.
 *
 * ---------------------------------------------------------------------
 * The model this implements
 * ---------------------------------------------------------------------
 *
 * Coolify's environment is the RUNTIME source of truth. The
 * dotenvx-encrypted `.env.production` is the AT-REST store: committed,
 * written by `hatchkit secrets rotate`, and read here so `hatchkit sync`
 * can push the resolved values onto each Coolify application.
 *
 * The encrypted file is deliberately not shipped into the image (see
 * starter/packages/server/Dockerfile). It could never cover the client
 * half — Next.js inlines NEXT_PUBLIC_* into the browser bundle at image
 * BUILD time, so those arrive as Docker build args — and pairing
 * ciphertext with its own decryption key in one image buys little.
 *
 * Under `split` this is not merely tidier, it is the only thing that
 * works: the two applications sit on separate Docker networks with no
 * in-stack mongo or redis to fall back on, so `MONGODB_URI` / `REDIS_URL`
 * reach the server through Coolify env or not at all.
 *
 * ---------------------------------------------------------------------
 * Decryption
 * ---------------------------------------------------------------------
 *
 * dotenvx finds the private key in `DOTENV_PRIVATE_KEY_PRODUCTION` (the
 * process env, on CI) or in a local `.env.keys` beside the file (a dev
 * workstation). We hand it a `processEnv` object of our own so decrypted
 * secrets land in a value we control instead of being scattered through
 * `process.env`, where every later child process would inherit them.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { locateEnvProductionFile } from "./keys.js";

/** Names that describe the encryption itself rather than the app's
 *  configuration. Pushing them to Coolify would be noise at best; the
 *  private key would be an outright leak into a second system. */
const NON_RUNTIME_KEYS = /^DOTENV_(PUBLIC|PRIVATE)_KEY/;

/** Scaffold placeholders. `hatchkit create` writes these for values it
 *  can't know yet, and a provision step is meant to overwrite them.
 *  When one survives to a sync it means that step never ran. */
const PLACEHOLDER_VALUE = /^(CHANGE_ME|REPLACE_ME|TODO)\b|^CHANGE_ME/;

export interface ResolvedProdEnv {
  /** Absolute path of the file the values came from. */
  path: string;
  /** Path relative to the project root, for log lines. */
  relPath: string;
  /** Decrypted name → value, minus the dotenvx key metadata. */
  values: Record<string, string>;
  /** Names still holding `encrypted:` ciphertext after the decrypt
   *  attempt — i.e. the private key was missing or wrong. Pushing these
   *  would put ciphertext into Coolify as though it were a value, so
   *  callers must refuse rather than push a half-resolved env. */
  undecrypted: string[];
  /** Names whose value is still a scaffold placeholder (`CHANGE_ME…`).
   *  Present in `values` — some are genuinely optional and a project can
   *  ship without them — but callers should surface them, because
   *  pushing one is how an app ends up configured with a string that
   *  looks like a value and isn't. */
  placeholders: string[];
}

/** Read and decrypt a project's `.env.production`.
 *
 *  Returns null when there is no such file — a project holding every
 *  value directly in Coolify is a legitimate setup, and a freshly
 *  scaffolded one hasn't written the file yet. Callers treat null as
 *  "nothing to push from here", never as "the env is empty". */
export async function resolveProductionEnv(projectDir: string): Promise<ResolvedProdEnv | null> {
  const path = locateEnvProductionFile(projectDir);
  if (!path || !existsSync(path)) return null;

  // Isolated sink: dotenvx writes decrypted values here rather than
  // into process.env, so nothing this CLI spawns later inherits a
  // production secret it has no business seeing.
  const captured: Record<string, string> = {};
  try {
    const { config } = await import("@dotenvx/dotenvx");
    (config as unknown as (o: unknown) => unknown)({
      path,
      processEnv: captured,
      quiet: true,
      override: true,
    });
  } catch {
    // Decryption is best-effort; fall through to the raw parse below so
    // a plaintext (not yet encrypted) file still resolves.
  }

  // A file that predates encryption, or one dotenvx declined to touch,
  // still has usable plaintext values. Parse it directly and let
  // anything dotenvx already resolved win.
  const parsed = parseDotenv(readFileSync(path, "utf-8"));
  const merged: Record<string, string> = { ...parsed, ...captured };

  const values: Record<string, string> = {};
  const undecrypted: string[] = [];
  const placeholders: string[] = [];
  for (const [name, value] of Object.entries(merged)) {
    if (NON_RUNTIME_KEYS.test(name)) continue;
    if (typeof value !== "string") continue;
    if (value.startsWith("encrypted:")) {
      undecrypted.push(name);
      continue;
    }
    if (PLACEHOLDER_VALUE.test(value)) placeholders.push(name);
    values[name] = value;
  }

  return { path, relPath: relative(projectDir, path), values, undecrypted, placeholders };
}

/** Minimal `.env` parser — `KEY=value`, optional `export`, optional
 *  single/double quotes, `#` comments outside quotes.
 *
 *  Deliberately not a dependency: this only ever runs as the fallback
 *  for a file dotenvx already declined, and the shapes hatchkit writes
 *  are the ones covered here. Multi-line values are not supported and
 *  are skipped rather than half-parsed. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing comment only on unquoted values, so a `#`
      // inside a quoted secret survives.
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}
