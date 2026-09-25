/*
 * cli/src/features/client-core/strip.ts — remove the `client-core` kit from a
 * freshly-copied starter when the user did not select it.
 *
 * Same contract as the `websocket` and `stripe` strips in scaffold/app.ts: the
 * starter ships every feature and create deletes what was not asked for. The
 * difference is that this feature also adds a workspace PACKAGE, which three
 * other manifests reference. Deleting the directory and leaving the references
 * gives a scaffold whose very first `pnpm install` fails with
 * ERR_PNPM_WORKSPACE_PKG_NOT_FOUND — so the references go in the same pass, and
 * `test-client-core.ts` asserts that nothing in the output names the package.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeIfExists, rewriteFile } from "../../scaffold/starter-files.js";
import { stripMarkedBlocks } from "./markers.js";
import {
  CLIENT_CORE_CHAINED_SCRIPTS,
  CLIENT_CORE_MARKED_FILES,
  CLIENT_CORE_OWNED_PATHS,
  CLIENT_CORE_PACKAGE_DEPENDENTS,
  CLIENT_CORE_ROOT_SCRIPTS,
  CORE_BUILD_SEGMENT,
  CORE_PACKAGE_NAME,
} from "./types.js";

/**
 * Strip the feature from `projectDir` in place.
 *
 * Returns the modification lines for the scaffold summary. Idempotent: every
 * step is a no-op on a tree that has already been stripped, which matters
 * because `hatchkit adopt` can run it over a repo of unknown provenance.
 */
export function stripClientCore(projectDir: string): string[] {
  const modifications: string[] = [];

  for (const rel of CLIENT_CORE_OWNED_PATHS) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    removeIfExists(path);
  }

  for (const rel of CLIENT_CORE_MARKED_FILES) {
    rewriteFile(join(projectDir, rel), stripMarkedBlocks);
  }

  stripCoreFromRootPackageJson(projectDir);
  for (const [rel, names] of Object.entries(CLIENT_CORE_CHAINED_SCRIPTS)) {
    if (rel === "package.json") continue; // handled above, with the scripts it owns
    unchainCoreScripts(join(projectDir, rel), names);
  }
  for (const rel of CLIENT_CORE_PACKAGE_DEPENDENTS) {
    stripCoreDependency(join(projectDir, rel));
  }

  modifications.push("removed: client-core (offline-first client kit not selected)");
  return modifications;
}

/**
 * Drop the feature's own scripts and unchain `@starter/core` from `build` and
 * `typecheck`.
 *
 * The unchaining is the part that bites. `pnpm --filter @starter/core run
 * build` against a workspace with no such package is an error, not a skip, so a
 * stripped scaffold would fail `pnpm run build` before it compiled a line. Both
 * positions in the `&&` chain are handled, and a script that consisted only of
 * that segment is deleted rather than left empty — the same three cases
 * `unchainTypecheckScript` handles for the Electron typecheck.
 */
function stripCoreFromRootPackageJson(projectDir: string): void {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  if (pkg.scripts) {
    for (const name of CLIENT_CORE_ROOT_SCRIPTS) delete pkg.scripts[name];
    for (const [name, script] of Object.entries(pkg.scripts)) {
      const next = unchainSegment(script, CORE_BUILD_SEGMENT);
      if (next === script) continue;
      if (next === "") delete pkg.scripts[name];
      else pkg.scripts[name] = next;
    }
  }
  if (pkg.dependencies) delete pkg.dependencies[CORE_PACKAGE_NAME];
  if (pkg.devDependencies) delete pkg.devDependencies[CORE_PACKAGE_NAME];

  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

/**
 * Drop the `@starter/core` build from named scripts in a package manifest.
 *
 * Same hazard as the root scripts: `pnpm --filter @starter/core run build` in a
 * workspace without that package fails the script outright, so a stripped
 * scaffold's `pnpm test` would die before running a test.
 */
function unchainCoreScripts(manifestPath: string, names: readonly string[]): void {
  if (!existsSync(manifestPath)) return;
  const pkg = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  if (!pkg.scripts) return;
  let changed = false;
  for (const name of names) {
    const script = pkg.scripts[name];
    if (script === undefined) continue;
    const next = unchainSegment(script, CORE_BUILD_SEGMENT);
    if (next === script) continue;
    if (next === "") delete pkg.scripts[name];
    else pkg.scripts[name] = next;
    changed = true;
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

function stripCoreDependency(manifestPath: string): void {
  if (!existsSync(manifestPath)) return;
  const pkg = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  let changed = false;
  for (const bucket of [pkg.dependencies, pkg.devDependencies]) {
    if (bucket && CORE_PACKAGE_NAME in bucket) {
      delete bucket[CORE_PACKAGE_NAME];
      changed = true;
    }
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

/**
 * `script` with `segment` and its surrounding `&&` removed. An exact match
 * returns the empty string so the caller can delete the script.
 *
 * The segment is escaped before it reaches a regex: it contains `@` and `/`,
 * and a future segment could contain a `.` or a `+` that would otherwise match
 * more than itself.
 */
export function unchainSegment(script: string, segment: string): string {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const part = `\\s*${escaped}\\s*`;
  return script
    .replace(new RegExp(`&&${part}`), " ")
    .replace(new RegExp(`${part}&&`), " ")
    .replace(new RegExp(`^${part}$`), "")
    .replace(/\s+/g, " ")
    .trim();
}
