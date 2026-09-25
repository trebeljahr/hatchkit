/*
 * cli/src/features/client-core/add.ts — layer `client-core` onto a project
 * that was scaffolded without it.
 *
 * The easy half is the same as every other `hatchkit update` addition: copy the
 * files the feature owns and merge the manifests. The hard half is the six
 * files the starter ALWAYS ships and the handshake has to reach into — the tRPC
 * init, `/api/health`, the server entrypoint, the items router. Those are files
 * the user has been editing since the day the project was scaffolded, so
 * overwriting them is not on the table.
 *
 * Three strategies, in order, per file:
 *
 *  1. **Untouched → copy.** If the project's copy is byte-identical to the
 *     starter's copy with the marked blocks stripped out, the user never
 *     touched it and the starter's version is strictly better. This is the
 *     common case, and it is the only one that can carry a change to an
 *     EXISTING line (the tRPC `create()` call gains an `errorFormatter`), which
 *     no insertion can do.
 *  2. **Edited, anchors intact → insert.** Each marked block is placed after
 *     the line that precedes it in the starter. That anchor comes from the
 *     starter itself rather than from a regex in this file, so a block that
 *     moves or grows needs no change here.
 *  3. **Anchor gone → tell the user.** The block is written into
 *     `.hatchkit/post-client-core.md` with the file, the anchor it was looking
 *     for and the text to paste. A wrong guess here is a scaffold that does not
 *     compile or, worse, a version floor that silently never refuses anything;
 *     a checklist entry is the honest outcome.
 *
 * Nothing here is destructive, and every step is idempotent: a file that
 * already carries the blocks is left alone, so re-running `update` is safe.
 */

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { blockRanges, hasMarkedBlocks, stripMarkedBlocks } from "./markers.js";
import { unchainSegment } from "./strip.js";
import {
  CLIENT_CORE_CHAINED_SCRIPTS,
  CLIENT_CORE_MARKED_FILES,
  CLIENT_CORE_OWNED_PATHS,
  CLIENT_CORE_PACKAGE_DEPENDENTS,
  CLIENT_CORE_ROOT_SCRIPTS,
  CORE_BUILD_SEGMENT,
  CORE_PACKAGE_NAME,
} from "./types.js";

/** A wiring step `update` could not apply, for the post-install checklist. */
export type ManualWiring = {
  /** Project-relative path of the file that needs the block. */
  file: string;
  /**
   * The lines the block follows in the starter — the shortest run of preceding
   * code that occurs exactly once, so "put it after this" is unambiguous.
   */
  anchor: readonly string[];
  /** The block to paste, markers included. */
  block: string;
  reason: "file-missing" | "anchor-not-found";
};

export type AddClientCoreResult = {
  /** Paths copied in, project-relative. */
  copied: string[];
  /** Files whose handshake blocks were wired in automatically. */
  wired: string[];
  /** Blocks that need a human. Written to `.hatchkit/post-client-core.md`. */
  manual: ManualWiring[];
};

/**
 * Copy the kit into `projectDir` and wire the handshake.
 *
 * `resolvedStarter` is the realpath of the starter template, as
 * `scaffold/update.ts` resolves it once per run.
 */
export function addClientCore(projectDir: string, resolvedStarter: string): AddClientCoreResult {
  const copied: string[] = [];
  for (const rel of CLIENT_CORE_OWNED_PATHS) {
    if (copyIfAbsent(resolvedStarter, projectDir, rel)) copied.push(rel);
  }

  mergeRootPackageJson(projectDir, resolvedStarter);
  for (const [rel, names] of Object.entries(CLIENT_CORE_CHAINED_SCRIPTS)) {
    if (rel === "package.json") continue; // handled by mergeRootPackageJson
    chainCoreScripts(join(projectDir, rel), join(resolvedStarter, rel), names);
  }
  for (const rel of CLIENT_CORE_PACKAGE_DEPENDENTS) {
    addCoreDependency(join(projectDir, rel));
  }

  const wired: string[] = [];
  const manual: ManualWiring[] = [];
  for (const rel of CLIENT_CORE_MARKED_FILES) {
    const outcome = wireMarkedFile(projectDir, resolvedStarter, rel);
    if (outcome.wired) wired.push(rel);
    manual.push(...outcome.manual);
  }

  return { copied, wired, manual };
}

/**
 * Wire one marked file. Returns whether anything was written and what still
 * needs a human.
 */
export function wireMarkedFile(
  projectDir: string,
  resolvedStarter: string,
  rel: string,
): { wired: boolean; manual: ManualWiring[] } {
  const starterPath = join(resolvedStarter, rel);
  const projectPath = join(projectDir, rel);
  if (!existsSync(starterPath)) return { wired: false, manual: [] };

  const starterContent = readFileSync(starterPath, "utf-8");
  if (!hasMarkedBlocks(starterContent)) return { wired: false, manual: [] };

  if (!existsSync(projectPath)) {
    // Not an error: a `static` or `backend` surface prunes whole packages, so
    // the file the block belongs in may legitimately not exist here.
    return { wired: false, manual: [] };
  }

  const projectContent = readFileSync(projectPath, "utf-8");
  // Already wired — a re-run, or a project that got the blocks by hand.
  if (hasMarkedBlocks(projectContent)) return { wired: false, manual: [] };

  // Strategy 1: untouched since scaffold, so the starter's copy wins whole.
  if (normalize(stripMarkedBlocks(starterContent)) === normalize(projectContent)) {
    writeFileSync(projectPath, starterContent, "utf-8");
    return { wired: true, manual: [] };
  }

  // Strategy 2: insert each block after the line it follows in the starter.
  const anchored = anchoredBlocks(starterContent);
  let content = projectContent;
  const manual: ManualWiring[] = [];
  let inserted = false;
  for (const { anchor, block } of anchored) {
    const next = insertAfter(content, anchor, block);
    if (next === null) {
      manual.push({ file: rel, anchor, block, reason: "anchor-not-found" });
      continue;
    }
    content = next;
    inserted = true;
  }
  if (inserted) writeFileSync(projectPath, content, "utf-8");
  return { wired: inserted, manual };
}

/**
 * How much preceding context an anchor may grow to before the block is handed
 * to a human instead.
 *
 * A short anchor is worse than no anchor. `}` occurs forty times in a router
 * and `});` occurs in every procedure, so "insert after the line above the
 * block" silently lands a `publishSync` call in the wrong mutation — code that
 * compiles, passes review and publishes the wrong person's change. So an anchor
 * grows until it matches exactly once, and a block whose context is still
 * ambiguous at this depth is written to the checklist.
 */
const MAX_ANCHOR_LINES = 14;

/**
 * Each marked block in `content`, with the shortest run of preceding lines that
 * identifies its position unambiguously.
 *
 * The context is built only from lines that SURVIVE a strip — a line inside
 * another marked block is not in the file `add` is inserting into, so anchoring
 * to it could never match — and only from non-blank lines, so a formatter that
 * adds or removes a blank line does not lose the anchor.
 *
 * Returned in reverse source order, so a caller inserting into one string does
 * not shift positions it has not reached yet.
 */
export function anchoredBlocks(content: string): Array<{ anchor: string[]; block: string }> {
  const lines = content.split("\n");
  const inBlock = new Set<number>();
  for (const [open, close] of blockRanges(content)) {
    for (let index = open; index <= close; index += 1) inBlock.add(index);
  }
  const stripped = stripMarkedBlocks(content);

  const out: Array<{ anchor: string[]; block: string }> = [];
  for (const [open, close] of blockRanges(content)) {
    // Nearest first, skipping blanks and anything inside a marked block.
    const candidates: string[] = [];
    for (let index = open - 1; index >= 0 && candidates.length < MAX_ANCHOR_LINES; index -= 1) {
      const line = lines[index] ?? "";
      if (inBlock.has(index) || line.trim() === "") continue;
      candidates.push(line);
    }

    let anchor: string[] = [];
    for (let depth = 1; depth <= candidates.length; depth += 1) {
      const context = candidates.slice(0, depth).reverse();
      if (countMatches(stripped, context) === 1) {
        anchor = context;
        break;
      }
    }
    out.push({ anchor, block: lines.slice(open, close + 1).join("\n") });
  }
  return out.reverse();
}

/** Non-blank lines of `content`, trimmed, with their original line index. */
function significantLines(content: string): Array<{ index: number; text: string }> {
  return content
    .split("\n")
    .map((text, index) => ({ index, text: text.trim() }))
    .filter((line) => line.text !== "");
}

/**
 * How many places in `content` the non-blank lines `context` appear
 * consecutively, ignoring indentation and any blank lines between them.
 */
function countMatches(content: string, context: readonly string[]): number {
  if (context.length === 0) return 0;
  const wanted = context.map((line) => line.trim());
  const significant = significantLines(content);
  let matches = 0;
  for (let start = 0; start + wanted.length <= significant.length; start += 1) {
    let ok = true;
    for (const [offset, text] of wanted.entries()) {
      if (significant[start + offset]?.text !== text) {
        ok = false;
        break;
      }
    }
    if (ok) matches += 1;
  }
  return matches;
}

/**
 * `content` with `block` inserted after the unique run of lines `anchor`, or
 * null when the anchor is empty, missing, or occurs more than once.
 *
 * Refusing an ambiguous anchor is the whole point: the alternative is putting
 * working-looking code in the wrong place. The caller turns a null into a
 * checklist entry.
 */
export function insertAfter(
  content: string,
  anchor: readonly string[],
  block: string,
): string | null {
  if (anchor.length === 0) return null;
  const wanted = anchor.map((line) => line.trim());
  const significant = significantLines(content);
  let at: number | null = null;
  for (let start = 0; start + wanted.length <= significant.length; start += 1) {
    let ok = true;
    for (const [offset, text] of wanted.entries()) {
      if (significant[start + offset]?.text !== text) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (at !== null) return null; // ambiguous — never guess
    at = significant[start + wanted.length - 1]?.index ?? null;
  }
  if (at === null) return null;
  const lines = content.split("\n");
  lines.splice(at + 1, 0, block);
  return lines.join("\n");
}

/** Copy a file or directory from the starter, never over an existing path. */
function copyIfAbsent(starter: string, projectDir: string, rel: string): boolean {
  const src = join(starter, rel);
  const dst = join(projectDir, rel);
  if (!existsSync(src)) return false;
  if (existsSync(dst)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  return true;
}

/**
 * Adopt the feature's root scripts, and put `@starter/core` back into `build`
 * and `typecheck`.
 *
 * The chain is the part that matters. The workspace resolves `@starter/core`
 * through `dist/`, exactly as it does `@starter/shared`, so a `typecheck` that
 * runs before the package is built fails on a missing `.d.ts` and reads as a
 * broken template. Two cases:
 *
 *  - The project's script is the starter's with the core segment removed — the
 *    scaffold-time strip did precisely that — so the starter's version is
 *    restored whole.
 *  - The user rewrote the script. Then only the segment is spliced in, directly
 *    after the `@starter/shared` build it has to follow. A script with no shared
 *    build to follow is left alone: guessing a position in somebody's own build
 *    pipeline is worse than a `pnpm install` away from an error they can read.
 */
function mergeRootPackageJson(projectDir: string, resolvedStarter: string): void {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return;
  const starterPkg = readJson(join(resolvedStarter, "package.json"));
  const pkg = readJson(path);
  pkg.scripts = pkg.scripts ?? {};

  for (const name of CLIENT_CORE_ROOT_SCRIPTS) {
    const value = starterPkg.scripts?.[name];
    if (value && !pkg.scripts[name]) pkg.scripts[name] = value;
  }

  for (const name of ["build", "typecheck"]) {
    const starterScript = starterPkg.scripts?.[name];
    const current = pkg.scripts[name];
    if (!starterScript || !current) continue;
    if (current.includes(CORE_PACKAGE_NAME)) continue;
    if (unchainSegment(starterScript, CORE_BUILD_SEGMENT) === current) {
      pkg.scripts[name] = starterScript;
      continue;
    }
    const spliced = spliceAfterSharedBuild(current);
    if (spliced !== null) pkg.scripts[name] = spliced;
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

/**
 * `script` with the core build inserted right after the `@starter/shared`
 * build, or null when there is no such segment to follow.
 */
export function spliceAfterSharedBuild(script: string): string | null {
  const shared = /pnpm\s+--filter\s+@starter\/shared\s+run\s+build/;
  const match = shared.exec(script);
  if (match === null) return null;
  const at = match.index + match[0].length;
  return `${script.slice(0, at)} && ${CORE_BUILD_SEGMENT}${script.slice(at)}`;
}

/**
 * Put `@starter/core`'s build back into named scripts of a package manifest.
 *
 * Only when the project's script is the starter's with that segment removed —
 * which is exactly what the scaffold-time strip produces. A script the user
 * rewrote is theirs; prepending a build step to somebody's own test command is
 * not a call this should make silently, and the missing `dist/` reports itself
 * on the first run with a message that names the package.
 */
function chainCoreScripts(
  manifestPath: string,
  starterManifestPath: string,
  names: readonly string[],
): void {
  if (!existsSync(manifestPath) || !existsSync(starterManifestPath)) return;
  const starterPkg = readJson(starterManifestPath);
  const pkg = readJson(manifestPath);
  if (!pkg.scripts) return;
  let changed = false;
  for (const name of names) {
    const starterScript = starterPkg.scripts?.[name];
    const current = pkg.scripts[name];
    if (!starterScript || current === undefined) continue;
    if (current.includes(CORE_PACKAGE_NAME)) continue;
    if (unchainSegment(starterScript, CORE_BUILD_SEGMENT) !== current) continue;
    pkg.scripts[name] = starterScript;
    changed = true;
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

function addCoreDependency(manifestPath: string): void {
  if (!existsSync(manifestPath)) return;
  const pkg = readJson(manifestPath);
  pkg.dependencies = pkg.dependencies ?? {};
  if (pkg.dependencies[CORE_PACKAGE_NAME]) return;
  pkg.dependencies[CORE_PACKAGE_NAME] = "workspace:*";
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

function readJson(path: string): {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Trailing whitespace is not a user edit. */
function normalize(content: string): string {
  return content.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n");
}

/**
 * Write the leftover wiring to `.hatchkit/post-client-core.md`, the same place
 * the signing feature leaves its post-setup steps. Returns the path, or null
 * when there is nothing left to do.
 */
export function writeClientCoreChecklist(
  projectDir: string,
  manual: readonly ManualWiring[],
): string | null {
  if (manual.length === 0) return null;
  const path = join(projectDir, ".hatchkit", "post-client-core.md");
  mkdirSync(dirname(path), { recursive: true });

  const body = [
    "# client-core: wiring left to do",
    "",
    "`hatchkit update` copied the shared client kit in and merged the package",
    "manifests. The blocks below belong inside files you have edited since this",
    "project was scaffolded, so they were not applied automatically — pasting them",
    "in the wrong place would either fail to compile or, worse, leave a version",
    "floor that silently never refuses anything.",
    "",
    "Each block is marked. Keep the markers: `hatchkit` reads them when the feature",
    "is stripped again, and `docs/versioning.md` explains what each block does.",
    "",
  ];
  for (const item of manual) {
    body.push(`## \`${item.file}\``, "");
    if (item.reason === "anchor-not-found" && item.anchor.length > 0) {
      body.push("Paste this directly after these lines:", "", "```ts", ...item.anchor, "```", "");
    } else {
      body.push(
        "Paste this into the file — the starter's surrounding code has changed too",
        "much here to say where automatically:",
        "",
      );
    }
    body.push("```ts", item.block, "```", "");
  }
  writeFileSync(path, body.join("\n"), "utf-8");
  return path;
}

/** The console report for an `update` run that added the feature. */
export function reportAddClientCore(result: AddClientCoreResult, checklist: string | null): void {
  console.log(chalk.dim("\n  Adding client-core (shared client kit + version handshake)..."));
  if (result.copied.length > 0) {
    console.log(chalk.green(`  ✓ copied: ${result.copied.join(", ")}`));
  }
  if (result.wired.length > 0) {
    console.log(chalk.green(`  ✓ wired the handshake into: ${result.wired.join(", ")}`));
  }
  console.log(
    chalk.dim(
      "    Run `pnpm install` for the new workspace package, then\n" +
        "    `pnpm run contract:emit` once and commit the snapshot it writes.",
    ),
  );
  if (checklist !== null) {
    console.log(
      chalk.yellow(
        `\n  ${result.manual.length} wiring step(s) need you — see ${checklist}\n` +
          "    (those files were edited since scaffold, so nothing was overwritten).",
      ),
    );
  }
}
