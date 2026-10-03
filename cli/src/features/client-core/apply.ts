/*
 * cli/src/features/client-core/apply.ts — the feature's `apply`, layering the
 * shared client kit onto a project through the ledger.
 *
 * Every mutation goes through `ctx.ledger`, so `--dry-run` and idempotency are
 * structural rather than remembered (docs/feature-authoring.md → "--dry-run").
 * Three primitives, one per kind of file:
 *
 *  - The kit's own source (`packages/core`, the contract tooling, the sync feed)
 *    is copied ONLY when absent. `writeIfChanged` alone would be wrong here even
 *    though the feature generates these files: `packages/core/src/offline-queue.ts`
 *    is source a user edits, and overwriting it on the next `update` would
 *    silently undo their work. Copy-if-absent keeps the additive invariant and
 *    is idempotent by construction.
 *  - The three `package.json` manifests go through `mergePackageJson`, which is
 *    add-only and REPORTS a differing value instead of reverting it.
 *  - The files the starter always ships get their marked blocks inserted through
 *    `edit`, with a fixed-point transform: the block is the idempotency key, so
 *    a second apply finds it and changes nothing.
 *
 * Why not `ensureManagedBlock`, which exists for exactly the third case: its
 * anchor is a single substring and it APPENDS AT END OF FILE when the anchor is
 * not found. For a `.gitignore` that is fine. For an import, a middleware chain
 * or a call inside a function body it is a compile error in the user's repo. The
 * transforms here anchor on a run of preceding lines that occurs exactly once
 * and REFUSE to place a block they cannot place safely, handing it to the
 * checklist instead. See `add.ts` for that machinery, and the trade-off it
 * accepts in return: a block already in a file is left alone rather than being
 * replaced wholesale, so a later CLI version cannot rewrite it in place.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { substituteIdentifierTokens } from "../../scaffold/identifiers.js";
import type { FeatureContext } from "../contract.js";
import {
  CLIENT_CORE_CHECKLIST_PATH,
  type ManualWiring,
  anchoredBlocks,
  insertAfter,
  renderClientCoreChecklist,
} from "./add.js";
import { hasMarkedBlocks, stripMarkedBlocks } from "./markers.js";
import { renameStarterIdentifiers } from "./rename.js";
import { unchainSegment } from "./strip.js";
import {
  CLIENT_CORE_CHAINED_SCRIPTS,
  CLIENT_CORE_GENERATED_PATHS,
  CLIENT_CORE_MARKED_FILES,
  CLIENT_CORE_OWNED_PATHS,
  CLIENT_CORE_PACKAGE_DEPENDENTS,
  CLIENT_CORE_ROOT_SCRIPTS,
  CORE_BUILD_SEGMENT,
  CORE_PACKAGE_NAME,
} from "./types.js";

/** Monorepo root → the starter template, two hops up from the compiled file. */
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

/** What an apply could not place. Written to the post-apply checklist. */
export type ApplyClientCoreResult = { manual: ManualWiring[] };

/**
 * Layer the kit onto `ctx.projectDir`.
 *
 * `starterRoot` is injectable so a test can point at a fixture instead of the
 * real template; it defaults to the checkout's `starter/`.
 */
export function applyClientCore(
  ctx: FeatureContext,
  starterRoot: string = STARTER_ROOT,
): ApplyClientCoreResult {
  if (!existsSync(starterRoot)) {
    ctx.log(
      `  client-core: starter template not found at ${starterRoot} — re-clone or pull the latest main.`,
    );
    return { manual: [] };
  }

  // Installing a feed that imports a newer Redis API into an older generated
  // server would break its build and could report false readiness. Refuse before
  // copying or wiring anything; the existing datastore adapter is user-owned.
  const redis = ctx.ledger.read("packages/server/src/db/redis.ts") ?? "";
  const health = ctx.ledger.read("packages/server/src/app.ts") ?? "";
  if (
    !["getRedis", "setRedisSubscriber", "isRedisReady"].every((name) =>
      new RegExp(`export (?:async )?function ${name}\\b`).test(redis),
    ) ||
    !health.includes("isRedisReady()")
  ) {
    throw new Error(
      "client-core requires the replica-aware Redis adapter and readiness route before installation. " +
        "Update packages/server/src/db/redis.ts to expose getRedis, setRedisSubscriber, and isRedisReady; " +
        "include isRedisReady() in /api/health. Preserve existing datastore settings and configure REDIS_URL " +
        "before a production rollout. No client-core files were changed.",
    );
  }

  copyOwnedFiles(ctx, starterRoot);
  mergeManifests(ctx, starterRoot);
  const manual = wireMarkedFiles(ctx, starterRoot);

  // A block that could not be placed safely is never guessed at — it goes to a
  // checklist, written through the ledger like everything else so a dry run
  // leaves no file behind and a second apply does not churn its mtime.
  const checklist = renderClientCoreChecklist(manual);
  if (checklist !== null) {
    ctx.ledger.writeIfChanged(CLIENT_CORE_CHECKLIST_PATH, checklist);
    ctx.log(
      `  client-core: ${manual.length} wiring step(s) need you — see ${CLIENT_CORE_CHECKLIST_PATH}\n` +
        "    (those files were edited since scaffold, so nothing was overwritten).",
    );
  }

  for (const conflict of ctx.ledger.conflicts()) {
    ctx.log(`  client-core: ${conflict.file} — ${conflict.detail ?? "not applied"}`);
  }
  return { manual };
}

/**
 * Copy every file the feature owns, substituting identifier tokens.
 *
 * The substitution is why this is not a plain directory copy: the kit's storage
 * keys and the handshake's header names carry the project's identifier
 * (`{{storagePrefix}}`, `{{clientHeader}}`), and those are contracts the moment
 * anything is stored or sent — read from `ctx.identifiers`, never derived here.
 * See `cli/src/scaffold/identifiers.ts`.
 */
function copyOwnedFiles(ctx: FeatureContext, starterRoot: string): void {
  for (const rel of CLIENT_CORE_OWNED_PATHS) {
    // The contract snapshot records the starter's router, not this project's.
    // See `CLIENT_CORE_GENERATED_PATHS`.
    if (CLIENT_CORE_GENERATED_PATHS.includes(rel)) continue;
    for (const file of starterFilesUnder(starterRoot, rel)) {
      // Copy-if-absent: see the header. A file that is already there is the
      // user's, whatever this build would have written.
      if (ctx.ledger.exists(file)) continue;
      const content = readStarterFile(starterRoot, file);
      if (content === null) continue;
      ctx.ledger.writeIfChanged(file, render(content, ctx));
    }
  }
}

/**
 * Add the workspace dependency and the build chaining the kit needs.
 *
 * `@starter/core` resolves through `dist/`, exactly as `@starter/shared` does,
 * so anything that imports it has to build it first — and a `--filter` matching
 * no package is an error rather than a skip, which is why the segment is added
 * and removed as a unit.
 */
function mergeManifests(ctx: FeatureContext, starterRoot: string): void {
  const rootPkg = readStarterJson(starterRoot, "package.json");
  if (rootPkg !== null) {
    const scripts: Record<string, string> = {};
    for (const name of CLIENT_CORE_ROOT_SCRIPTS) {
      const value = rootPkg.scripts?.[name];
      if (value) scripts[name] = value;
    }
    ctx.ledger.mergePackageJson("package.json", { scripts });
  }

  for (const rel of CLIENT_CORE_PACKAGE_DEPENDENTS) {
    ctx.ledger.mergePackageJson(rel, {
      dependencies: { [CORE_PACKAGE_NAME]: "workspace:*" },
    });
  }

  for (const [rel, names] of Object.entries(CLIENT_CORE_CHAINED_SCRIPTS)) {
    const starterPkg = readStarterJson(starterRoot, rel);
    if (starterPkg === null) continue;
    ctx.ledger.edit(rel, (content) => chainCoreBuild(content, starterPkg.scripts ?? {}, names));
  }
}

/**
 * `content` with the core build chained into each named script.
 *
 * A fixed point: a script that already names the package is left alone, so a
 * second apply changes nothing. A script that is somebody's own command is left
 * alone too — see `restoreCoreSegment` for where the line between the two is
 * drawn, and why it is not simply "equal to the starter's minus this segment".
 */
export function chainCoreBuild(
  content: string,
  starterScripts: Readonly<Record<string, string>>,
  names: readonly string[],
): string {
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(content) as { scripts?: Record<string, string> };
  } catch {
    return content;
  }
  if (!pkg.scripts) return content;
  let changed = false;
  for (const name of names) {
    const starterScript = starterScripts[name];
    const current = pkg.scripts[name];
    if (!starterScript || current === undefined) continue;
    if (current.includes(CORE_PACKAGE_NAME)) continue;
    const restored = restoreCoreSegment(starterScript, current);
    if (restored === null) continue;
    pkg.scripts[name] = restored;
    changed = true;
  }
  return changed ? `${JSON.stringify(pkg, null, 2)}\n` : content;
}

/** The `&&`-separated commands of a script, trimmed and without empties. */
function scriptSegments(script: string): string[] {
  return script
    .split("&&")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/**
 * `current` with the core build put back where the starter has it, or null when
 * this cannot say where that is.
 *
 * The obvious rule — restore only a script that is EXACTLY the starter's with
 * this one segment removed — is the rule this used to have, and it is too
 * strict, because a scaffold strips one segment per feature the user did not
 * select. A project without `desktop` has a root `typecheck` that is the
 * starter's minus BOTH the core build and `pnpm typecheck:electron`, so it never
 * matches, the build is never chained, and `pnpm run typecheck` then fails on
 * `Cannot find module '@starter/core'` — the package resolves through `dist/`
 * and nothing built it. That is a project hatchkit produced, failing its own
 * typecheck after `hatchkit update`.
 *
 * So: exact match first, because the starter's whole script is strictly better
 * when it applies (it carries any other change the starter made since).
 * Otherwise place the segment after the one it follows in the starter, which is
 * the only position that matters — `@starter/core` has to be built before
 * anything that compiles against it, and after `@starter/shared`, which it
 * imports. A script that no longer contains that preceding segment, or contains
 * it more than once, is somebody's own command: prepending a build step to one
 * silently is not a call to make, and a missing `dist/` reports itself on the
 * first run with a message that names the package.
 */
function restoreCoreSegment(starterScript: string, current: string): string | null {
  if (!starterScript.includes(CORE_BUILD_SEGMENT)) return null;
  if (unchainSegment(starterScript, CORE_BUILD_SEGMENT) === current) return starterScript;

  const starterSegments = scriptSegments(starterScript);
  const at = starterSegments.indexOf(CORE_BUILD_SEGMENT);
  if (at < 0) return null; // the segment is there but not as a whole command

  const segments = scriptSegments(current);
  if (at === 0) return [CORE_BUILD_SEGMENT, ...segments].join(" && ");

  const precededBy = starterSegments[at - 1] as string;
  if (segments.filter((segment) => segment === precededBy).length !== 1) return null;
  segments.splice(segments.indexOf(precededBy) + 1, 0, CORE_BUILD_SEGMENT);
  return segments.join(" && ");
}

/**
 * Insert the handshake's marked blocks into the files the starter always ships.
 *
 * Two strategies and a refusal, in order — see `add.ts` for why each one is
 * where it is. Everything writes through `ctx.ledger.edit`, whose transform is a
 * fixed point because the presence of a block is the idempotency key.
 */
function wireMarkedFiles(ctx: FeatureContext, starterRoot: string): ManualWiring[] {
  const manual: ManualWiring[] = [];

  for (const rel of CLIENT_CORE_MARKED_FILES) {
    const starterContent = readStarterFile(starterRoot, rel);
    if (starterContent === null || !hasMarkedBlocks(starterContent)) continue;
    // A narrower surface prunes whole packages, so the file a block belongs in
    // may legitimately not be here. `edit` records that as `absent`.
    if (!ctx.ledger.exists(rel)) continue;

    const rendered = render(starterContent, ctx);
    const stripped = stripMarkedBlocks(rendered);
    const blocks = anchoredBlocks(rendered);

    ctx.ledger.edit(rel, (content) => {
      if (hasMarkedBlocks(content)) return content; // already wired — fixed point
      // Untouched since scaffold: the starter's copy is strictly better, and it
      // is the only strategy that can carry a change to an EXISTING line (the
      // tRPC `create()` call gains an `errorFormatter`), which no insertion can.
      if (normalize(stripped) === normalize(content)) return rendered;

      let next = content;
      const unresolved: ManualWiring[] = [];
      for (const { anchor, block } of blocks) {
        const inserted = insertAfter(next, anchor, block);
        if (inserted === null) {
          unresolved.push({ file: rel, anchor, block, reason: "anchor-not-found" });
          continue;
        }
        next = inserted;
      }
      // Docker's manifest copy, source copy and build form one dependency
      // chain. A partial insertion leaves a broken image and any inserted
      // marker would make the next apply incorrectly treat it as complete.
      if (rel.endsWith("/Dockerfile") && unresolved.length > 0) {
        manual.push(
          ...blocks.map(
            ({ anchor, block }): ManualWiring => ({
              file: rel,
              anchor,
              block,
              reason: "anchor-not-found",
            }),
          ),
        );
        return content;
      }
      manual.push(...unresolved);
      return next;
    });
  }
  return manual;
}

/**
 * One starter file, with the project's own names in it.
 *
 * Two passes, because the starter carries two kinds of placeholder: `{{…}}`
 * tokens (the documented convention) and the identifier-bearing literals in
 * `IDENTIFIER_RENAMES`, which cannot be tokens because a brace in an HTTP header
 * name makes `new Headers()` throw. See `rename.ts`.
 */
function render(content: string, ctx: FeatureContext): string {
  return renameStarterIdentifiers(
    substituteIdentifierTokens(content, ctx.identifiers),
    ctx.identifiers,
  );
}

/** Every file under `rel` in the starter, as project-relative posix paths. */
export function starterFilesUnder(starterRoot: string, rel: string): string[] {
  const abs = join(starterRoot, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(starterRoot, path).split(sep).join(posix.sep));
    }
  };
  walk(abs);
  return out.sort();
}

function readStarterFile(starterRoot: string, rel: string): string | null {
  const abs = join(starterRoot, rel);
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
  return readFileSyncSafe(abs);
}

function readStarterJson(
  starterRoot: string,
  rel: string,
): { scripts?: Record<string, string> } | null {
  const raw = readStarterFile(starterRoot, rel);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
}

function readFileSyncSafe(abs: string): string | null {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** Trailing whitespace is not a user edit. */
function normalize(content: string): string {
  return content.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n");
}
