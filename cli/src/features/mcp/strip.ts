/*
 * cli/src/features/mcp/strip.ts — remove `packages/mcp` from a freshly-copied
 * starter when the user did not select the feature.
 *
 * Same contract as the `client-core` strip beside it: the starter ships every
 * feature and `create` deletes what was not asked for. Two consequences come
 * with the directory and have to go in the same pass, because each one breaks
 * a scaffold before a line of it is compiled:
 *
 *  - the root scripts. `pnpm --filter @starter/mcp run build` against a
 *    workspace with no such package is an ERROR, not a skip, so a stripped
 *    scaffold whose `test:unit` still chained `pnpm run test:mcp` would fail
 *    its own test command with `ERR_PNPM_NO_MATCHING_PACKAGE`.
 *  - the lockfile importer. Every scaffolded project's CI and both its
 *    Dockerfiles run `pnpm install --frozen-lockfile`, which refuses over an
 *    importer whose directory is gone.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeIfExists } from "../../scaffold/starter-files.js";
import { unchainSegment } from "../client-core/index.js";
import { reconcileLockfile } from "../lockfile.js";
import { MCP_OWNED_PATHS, MCP_ROOT_SCRIPTS, MCP_TEST_SEGMENT } from "./types.js";

/**
 * Strip the feature from `projectDir` in place.
 *
 * Returns the modification lines for the scaffold summary. Idempotent: every
 * step is a no-op on a tree that has already been stripped, which matters
 * because `hatchkit adopt` runs it over a repo of unknown provenance.
 */
export function stripMcp(projectDir: string): string[] {
  const modifications: string[] = [];

  let removed = false;
  for (const rel of MCP_OWNED_PATHS) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    removeIfExists(path);
    removed = true;
  }

  stripMcpFromRootPackageJson(projectDir);
  if (!removed) return modifications;

  modifications.push("removed: mcp (stdio MCP server not selected)");
  modifications.push(...reconcileLockfile(projectDir));
  return modifications;
}

/** Drop the feature's own scripts and unchain its segment from the aggregate. */
function stripMcpFromRootPackageJson(projectDir: string): void {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8")) as { scripts?: Record<string, string> };
  if (!pkg.scripts) return;

  let changed = false;
  for (const name of Object.keys(MCP_ROOT_SCRIPTS)) {
    if (pkg.scripts[name] === undefined) continue;
    delete pkg.scripts[name];
    changed = true;
  }
  for (const [name, script] of Object.entries(pkg.scripts)) {
    const next = unchainSegment(script, MCP_TEST_SEGMENT);
    if (next === script) continue;
    // A script that consisted only of that segment is deleted rather than
    // left as an empty string, which `pnpm run` reports as a mysterious
    // success.
    if (next === "") delete pkg.scripts[name];
    else pkg.scripts[name] = next;
    changed = true;
  }
  if (changed) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}
