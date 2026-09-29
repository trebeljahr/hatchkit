/*
 * The one door to `@dotenvx/dotenvx`'s `set`.
 *
 * `set` generates a keypair and writes `.env.keys` whenever the target
 * env file has no public key yet — on the first encrypted write into a
 * new `.env.production`, but also on a write into an env file that was
 * copied, renamed or never encrypted before. If that `.env.keys` is not
 * gitignored, the next `git add -A` stages the private key. That is
 * how the collection-of-beauty key reached a public repo on 2026-04-29.
 *
 * So every hatchkit write goes through `dotenvxSet` here, which makes
 * the repo ignore `.env.keys` BEFORE dotenvx can create it.
 * `cli/test-secret-hygiene.ts` fails on any other import of `set` from
 * `@dotenvx/dotenvx`, so a new call site cannot bypass it.
 */

import { dirname, join } from "node:path";
import { type SetOptions, type SetOutput, set as rawSet } from "@dotenvx/dotenvx";
import { ensureIgnoredOnEveryClone } from "./gitignore.js";

/** `@dotenvx/dotenvx`'s `set`, with `.env.keys` gitignored first.
 *  `path` is required: dotenvx's default (`.env` in the process cwd)
 *  is never where a hatchkit project keeps its env files. */
export function dotenvxSet(
  key: string,
  value: string,
  options: SetOptions & { path: string },
): SetOutput {
  const keysFile = options.envKeysFile ?? join(dirname(options.path), ".env.keys");
  ensureIgnoredOnEveryClone(keysFile, ".env.keys");
  return rawSet(key, value, options);
}
