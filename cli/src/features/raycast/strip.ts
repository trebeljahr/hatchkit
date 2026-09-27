/*
 * cli/src/features/raycast/strip.ts — remove the launcher extension from a
 * freshly-copied starter when the user did not select it.
 *
 * Same contract as every other create-time strip: the starter ships every
 * feature and `create` deletes what was not asked for. Two consequences come
 * with deleting a workspace PACKAGE, and both land on the user rather than on
 * the scaffold:
 *
 *  - the committed lockfile still declares an importer for it, and every
 *    scaffolded project's CI and both its Dockerfiles run
 *    `pnpm install --frozen-lockfile`, which refuses over a stale importer
 *    (`features/lockfile.ts` explains the failure text);
 *  - a root script with `pnpm --filter <package>` in it is an ERROR rather
 *    than a skip when the filter matches nothing, so a stripped scaffold's
 *    `pnpm run test:raycast` would fail rather than not exist.
 *
 * Both are handled here, in the same pass, so a caller cannot forget one.
 *
 * Idempotent: every step is a no-op on a tree that has already been stripped,
 * which matters because `hatchkit adopt` can run it over a repo of unknown
 * provenance.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeIfExists } from "../../scaffold/starter-files.js";
import { unchainSegment } from "../client-core/index.js";
import { reconcileLockfile } from "../lockfile.js";
import { RAYCAST_OWNED_PATHS, RAYCAST_SCRIPT_NAMES, RAYCAST_TEST_SEGMENT } from "./types.js";

/**
 * Strip the feature from `projectDir` in place.
 *
 * Returns the modification lines for the scaffold summary.
 */
export function stripRaycast(projectDir: string): string[] {
  const modifications: string[] = [];

  let removedAnything = false;
  for (const rel of RAYCAST_OWNED_PATHS) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    removeIfExists(path);
    removedAnything = true;
  }

  const scriptsRemoved = stripRaycastScripts(projectDir);

  if (!removedAnything && scriptsRemoved === 0) return [];

  modifications.push("removed: raycast (launcher extension not selected)");
  modifications.push(...reconcileLockfile(projectDir));
  return modifications;
}

/**
 * Drop the feature's root scripts, and report how many went.
 *
 * Matched by NAME rather than by value: the value names the package, which is
 * `identifiers.slug` in a scaffolded project and the starter's placeholder in
 * the template, and a strip that had to know which one it was looking at
 * would miss in exactly one of the two cases.
 */
export function stripRaycastScripts(projectDir: string): number {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return 0;

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(path, "utf-8")) as { scripts?: Record<string, string> };
  } catch {
    // A manifest we cannot read is one we must not rewrite.
    return 0;
  }
  if (!pkg.scripts) return 0;

  let removed = 0;
  for (const name of RAYCAST_SCRIPT_NAMES) {
    if (pkg.scripts[name] === undefined) continue;
    delete pkg.scripts[name];
    removed += 1;
  }

  // …and unchain the segment the aggregate names. `test:unit` is an explicit
  // list rather than a `pnpm -r` sweep, so it has to name this package — and
  // a stripped project whose `test:unit` still ran `pnpm run test:raycast`
  // would fail on a script that is no longer there, which reads as a broken
  // template rather than as a feature nobody selected.
  for (const [name, script] of Object.entries(pkg.scripts)) {
    const next = unchainSegment(script, RAYCAST_TEST_SEGMENT);
    if (next === script) continue;
    // A script that was only that segment is deleted, not left empty: an
    // empty script is reported by `pnpm run` as a mysterious success.
    if (next === "") delete pkg.scripts[name];
    else pkg.scripts[name] = next;
    removed += 1;
  }

  if (removed > 0) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  return removed;
}
