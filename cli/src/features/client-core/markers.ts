/*
 * cli/src/features/client-core/markers.ts — the marker-block convention
 * that lets `client-core` be stripped back out of the starter.
 *
 * Most features are whole files or whole directories, so removing them is a
 * recursive delete. This one is not: the version handshake has to sit INSIDE
 * files the starter always ships — the tRPC init, `/api/health`, the server
 * entrypoint — because that is the only place a floor can refuse a request or
 * a health read can report a level.
 *
 * The existing coarse strips for `websocket` and `stripe` solve the same
 * problem with hand-written regexes per call site
 * (`stripWebSocketFromServerIndex`). That works for two call sites and rots
 * for a dozen: the regex lives in the CLI, the code lives in the starter, and
 * nothing fails when they drift — the strip silently leaves a dangling import
 * behind and the first `pnpm run build` in the scaffolded project dies with
 * TS2307.
 *
 * So the starter marks its own blocks instead:
 *
 *     // ── client-core ──────────────────────────────────────────────────
 *     setupSyncFeed(server);
 *     // ── end client-core ──────────────────────────────────────────────
 *
 * The CLI removes what is between the markers, whatever it is. A block that
 * moves, grows or is added does not need a matching change here, and
 * `test-client-core.ts` asserts the inverse property that actually protects
 * the user: after a strip, no marker and no `@starter/core` reference is left
 * anywhere in the output.
 */

/** The opening line, using // for source or # for Dockerfiles. */
const OPEN = /^[ \t]*(?:\/\/|#)[ \t]*──[ \t]*client-core[ \t]*─*[ \t]*$/;

/** The closing line. */
const CLOSE = /^[ \t]*(?:\/\/|#)[ \t]*──[ \t]*end client-core[ \t]*─*[ \t]*$/;

export const MARKER_OPEN = "// ── client-core ──────────────────────────────────────────────────";
export const MARKER_CLOSE = "// ── end client-core ──────────────────────────────────────────────";

/** True when `content` carries at least one marked block. */
export function hasMarkedBlocks(content: string): boolean {
  return content.split("\n").some((line) => OPEN.test(line));
}

export class UnbalancedMarkerError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = "UnbalancedMarkerError";
    this.line = line;
  }
}

/**
 * `content` with every marked block — markers included — removed.
 *
 * A block that opens and never closes is an error rather than a silent
 * truncation: swallowing the rest of the file would produce a scaffold that
 * looks fine in the diff summary and fails to compile, which is the exact
 * failure this convention exists to prevent.
 *
 * Nesting is refused for the same reason. One pair per block, always.
 */
export function stripMarkedBlocks(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let openedAt: number | null = null;

  for (const [index, line] of lines.entries()) {
    if (OPEN.test(line)) {
      if (openedAt !== null) {
        throw new UnbalancedMarkerError(
          `Nested client-core marker at line ${index + 1} (opened at line ${openedAt + 1})`,
          index + 1,
        );
      }
      openedAt = index;
      continue;
    }
    if (CLOSE.test(line)) {
      if (openedAt === null) {
        throw new UnbalancedMarkerError(
          `client-core marker closed at line ${index + 1} without an opening marker`,
          index + 1,
        );
      }
      openedAt = null;
      continue;
    }
    if (openedAt === null) kept.push(line);
  }

  if (openedAt !== null) {
    throw new UnbalancedMarkerError(
      `client-core marker opened at line ${openedAt + 1} is never closed`,
      openedAt + 1,
    );
  }

  return collapseBlankRuns(kept).join("\n");
}

/**
 * Every marked block in `content`, markers excluded, in source order.
 *
 * `hatchkit update` reads these out of the STARTER and inserts them into an
 * already-scaffolded project, so the block's text has exactly one home — the
 * starter — and the CLI only has to know where to put it.
 */
export function readMarkedBlocks(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const [index, line] of lines.entries()) {
    if (OPEN.test(line)) {
      if (current !== null) {
        throw new UnbalancedMarkerError(
          `Nested client-core marker at line ${index + 1}`,
          index + 1,
        );
      }
      current = [];
      continue;
    }
    if (CLOSE.test(line)) {
      if (current === null) {
        throw new UnbalancedMarkerError(
          `client-core marker closed at line ${index + 1} without an opening marker`,
          index + 1,
        );
      }
      blocks.push(current.join("\n").replace(/\n+$/, ""));
      current = null;
      continue;
    }
    current?.push(line);
  }

  if (current !== null) {
    throw new UnbalancedMarkerError("client-core marker is never closed", lines.length);
  }
  return blocks;
}

/**
 * Removing a block usually leaves the blank line above it next to the blank
 * line below it. Harmless to a compiler, ugly in a scaffold people read on day
 * one — and it makes the strip's output unstable, so a test cannot assert on
 * it. Two or more consecutive blank lines become one.
 */
function collapseBlankRuns(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const blank = line.trim() === "";
    const previousBlank = out.length > 0 && out[out.length - 1]?.trim() === "";
    if (blank && previousBlank) continue;
    out.push(line);
  }
  return out;
}

/**
 * The line ranges every marked block occupies, `[openIndex, closeIndex]`
 * inclusive, in source order.
 *
 * `add.ts` needs it to build an anchor out of lines that survive a strip: a
 * line inside another marked block is not in the stripped file, so anchoring to
 * it could never match.
 */
export function blockRanges(content: string): Array<[number, number]> {
  const lines = content.split("\n");
  const ranges: Array<[number, number]> = [];
  let openedAt: number | null = null;
  for (const [index, line] of lines.entries()) {
    if (OPEN.test(line)) openedAt = index;
    else if (CLOSE.test(line) && openedAt !== null) {
      ranges.push([openedAt, index]);
      openedAt = null;
    }
  }
  return ranges;
}
