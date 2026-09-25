/*
 * cli/src/features/client-core/add.ts — placing a marked block inside a file the
 * user also edits, and reporting what could not be placed.
 *
 * The feature's own `apply` (`apply.ts`) writes everything through the ledger;
 * this module is the part it could not get from a ledger primitive. Three
 * strategies, in order, per shared file:
 *
 *  1. **Untouched → copy.** If the project's copy is the starter's with the
 *     marked blocks stripped out, the user never touched it and the starter's
 *     version is strictly better. It is also the only strategy that can carry a
 *     change to an EXISTING line — the tRPC `create()` call gains an
 *     `errorFormatter` — which no insertion can do.
 *  2. **Edited, anchor unique → insert.** The block goes after the shortest run
 *     of preceding lines that occurs exactly once. That run comes from the
 *     starter itself rather than from a regex here, so a block that moves or
 *     grows needs no change in the CLI.
 *  3. **Anchor gone or ambiguous → tell the user.** The block is written to
 *     `.hatchkit/post-client-core.md` with the lines it was looking for and the
 *     text to paste. A wrong guess is a scaffold that does not compile or,
 *     worse, a version floor that silently never refuses anything.
 */

import { blockRanges, stripMarkedBlocks } from "./markers.js";

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

/** Where the leftover wiring is written, relative to the project. */
export const CLIENT_CORE_CHECKLIST_PATH = ".hatchkit/post-client-core.md";

/**
 * The leftover wiring as a Markdown document, or null when there is none.
 *
 * A pure renderer on purpose: the caller writes it through the ledger, which is
 * what keeps the checklist out of a dry run and out of a second apply's diff.
 * It is the same place the signing feature leaves its post-setup steps.
 */
export function renderClientCoreChecklist(manual: readonly ManualWiring[]): string | null {
  if (manual.length === 0) return null;

  const body = [
    "# client-core: wiring left to do",
    "",
    "`hatchkit` copied the shared client kit in and merged the package manifests.",
    "The blocks below belong inside files you have edited since this project was",
    "scaffolded, so they were not applied automatically — pasting them in the wrong",
    "place would either fail to compile or, worse, leave a version floor that",
    "silently never refuses anything.",
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
  return body.join("\n");
}
