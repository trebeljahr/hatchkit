/*
 * cli/src/features/raycast/apply.ts — layer the launcher extension onto a
 * project, through the ledger.
 *
 * Every mutation goes through `ctx.ledger`, so `--dry-run` and idempotency are
 * structural rather than remembered (docs/feature-authoring.md → "--dry-run").
 * Three primitives, one per kind of file:
 *
 *  - Text source is written ONLY WHEN ABSENT. `writeIfChanged` alone would be
 *    wrong even though the feature generates these files: `src/list-items.tsx`
 *    is source a user edits the day after it lands, and overwriting it on the
 *    next `update` would silently undo their work.
 *  - `assets/extension-icon.png` is copied byte-for-byte. A PNG round-tripped
 *    through a UTF-8 string is a PNG Raycast refuses to build with.
 *  - The root `package.json` goes through `mergePackageJson`, which is
 *    add-only and REPORTS a differing script instead of reverting it.
 *
 * The one thing this feature does NOT do is write anything outside
 * `packages/raycast` and the root manifest's scripts. The launcher vendors the
 * shared client core rather than importing it, so it adds no dependency to
 * any other package and needs no marked block anywhere.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { substituteIdentifierTokens } from "../../scaffold/identifiers.js";
import { renameStarterIdentifiers, starterFilesUnder } from "../client-core/index.js";
import type { FeatureContext, FeaturePlanContext } from "../contract.js";
import { applyDeviceGrant } from "../device-grant/index.js";
import { type RaycastNames, raycastNamesFrom, renameRaycastIdentifiers } from "./rename.js";
import { RAYCAST_OWNED_PATHS, isBinaryAsset, raycastRootScripts } from "./types.js";

/** Monorepo root → the starter template, four hops up from the compiled file. */
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

/**
 * The project-relative paths an apply would write.
 *
 * Read off the starter, which is the same table `apply` reads — never a second
 * hand-maintained list. It only READS, which is what `plannedFiles` requires:
 * `hatchkit update --dry-run` calls it INSTEAD of `apply`.
 *
 * An empty list means the starter template is not on disk (the published CLI
 * package ships `dist`, not `starter/`), which is the same situation `apply`
 * reports in its first line.
 */
export function raycastPlannedFiles(
  _ctx: FeaturePlanContext,
  starterRoot: string = STARTER_ROOT,
): string[] {
  return RAYCAST_OWNED_PATHS.flatMap((rel) => starterFilesUnder(starterRoot, rel));
}

/** Layer the launcher onto `ctx.projectDir`. Returns the manual steps left. */
export function applyRaycast(ctx: FeatureContext, starterRoot: string = STARTER_ROOT): string[] {
  if (!existsSync(starterRoot)) {
    ctx.log(
      `  raycast: starter template not found at ${starterRoot} — re-clone or pull the latest main.`,
    );
    return [];
  }

  const names = raycastNamesFrom(ctx.identifiers, ctx.manifest);
  let kept = 0;
  let written = 0;

  for (const rel of RAYCAST_OWNED_PATHS) {
    for (const file of starterFilesUnder(starterRoot, rel)) {
      // Copy-if-absent: a file that is already there is the user's, whatever
      // this build would have written.
      if (ctx.ledger.exists(file)) {
        kept += 1;
        continue;
      }
      const source = join(starterRoot, file);
      if (isBinaryAsset(file)) {
        // Bytes and mode, not a string. See the header.
        ctx.ledger.copyIfAbsent(file, source);
        written += 1;
        continue;
      }
      const content = readStarterFile(source);
      if (content === null) continue;
      ctx.ledger.writeIfChanged(file, render(content, names));
      written += 1;
    }
  }

  if (kept > 0) {
    ctx.log(`  raycast: kept ${kept} existing file(s) — they are yours now.`);
  }

  // The root scripts. The aggregates need to name this package explicitly:
  // nothing in the build graph imports it, so a change that breaks it
  // compiles green through the whole pipeline.
  ctx.ledger.mergePackageJson("package.json", {
    scripts: raycastRootScripts(),
  });

  // The shared device grant: better-auth's `bearer()` and RFC 8628 on the
  // server, plus the page a person approves a pairing code on. Called from
  // here rather than declared as a `requires`, because it is not a feature —
  // see `features/device-grant/index.ts`. A project that also ships the
  // browser extension applies it twice in one run; every mutation goes
  // through the ledger, so the second call writes nothing.
  const problems = applyDeviceGrant(ctx);

  if (written > 0) {
    problems.push(
      "Run `pnpm install` for the new workspace package, then `pnpm run vendor:raycast` " +
        "to write packages/raycast/src/vendor/ from packages/core.",
    );
  }
  return problems;
}

/**
 * One starter file, with the project's own names in it.
 *
 * Three passes, because the launcher package carries three kinds of
 * placeholder: `{{…}}` identifier tokens, the shared kit's literals (which
 * the VENDORED copy carries and which must come out identical to
 * `packages/core`'s), and the launcher's own literals. See `rename.ts`.
 */
function render(content: string, names: RaycastNames): string {
  return renameRaycastIdentifiers(
    renameStarterIdentifiers(
      substituteIdentifierTokens(content, names.identifiers),
      names.identifiers,
    ),
    names,
  );
}

function readStarterFile(abs: string): string | null {
  try {
    if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** Things only a person can do, for a caller to print after a run. */
export function raycastResidue(slug: string): string[] {
  return [
    "The launcher's store slug and publisher handle are PERMANENT once published — Raycast keys its encrypted per-extension store by the pair, so changing either orphans every install's credential and its queue of unsent work. packages/raycast/PUBLISHING.md has the long version.",
    `The workspace package is named "${slug}", not "@<scope>/raycast": Raycast reads package.json's \`name\` as the extension id, and one field has to serve both. \`pnpm --filter ${slug} run dev\` installs it into your own Raycast.`,
    "`pnpm run test:raycast` has to be chained into the root `test:unit` script. A host package is outside the build graph, so nothing else runs its tests — including the check that the vendored copy of packages/core is not stale.",
  ];
}
