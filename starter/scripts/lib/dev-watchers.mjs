/**
 * File-watcher trouble in `pnpm run dev`: stray watchers left by earlier runs,
 * and the moment a watcher cannot be opened at all.
 *
 * The failure this exists for is silent. When Watchpack cannot open watches
 * (`EMFILE: too many open files, watch`), `next dev` never scans `app/`, so no
 * route is registered and every page answers a plain 404 while `public/` files
 * still load — no error page, nothing that points at the cause. What exhausted
 * the watches was `tsx watch` processes from earlier dev runs, still alive days
 * after the terminal or agent that started them was gone.
 *
 * Pure functions over `ps` output, so they can be tested without starting
 * anything. Nothing here kills a process: whose process it is is for a person
 * to decide.
 */

/** Dev processes that hold file watches. `next-server` carries no path. */
const WATCHER_PATTERN =
  /tsx\/dist\/cli\.mjs watch|next\/dist\/bin\/next dev|typescript\/bin\/tsc (?:--watch|-w)\b/;

/** Links in a dev tree between a watcher and whatever started it. */
const DEV_LINK_PATTERN = /^(?:\S*\/)?(?:node|npm|npx|pnpm|sh)(?:\s|$)|^next-server\b/;

/** Parse `ps -Ao pid=,ppid=,etime=,command=`. */
export const parsePs = (text) =>
  text
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, etime, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      etime,
      command,
    }));

/**
 * True when nothing but dev tooling stands between the process and pid 1 —
 * the terminal, agent shell or preview that started the tree is gone. A live
 * run always has a shell or an app somewhere above it.
 */
export const isOrphaned = (row, byPid) => {
  let current = row;
  const seen = new Set();
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (current.ppid === 1) return true;
    const parent = byPid.get(current.ppid);
    if (!parent || !DEV_LINK_PATTERN.test(parent.command)) return false;
    current = parent;
  }
  return false;
};

/** Claude Code puts its worktrees here, so name those by their worktree. */
const CLAUDE_WORKTREE_PATTERN = /^(\.claude\/worktrees\/[^/\s]+)/;

/**
 * The checkout a command line runs from: the repo root or one of its worktrees,
 * as a path relative to the root. `null` when the command belongs to neither.
 *
 * `repoRoot` is the directory holding the common `.git`, so linked worktrees
 * placed inside it (which is where agents put them) are matched too.
 *
 * A watcher is always started from a binary under its own checkout's
 * `node_modules`, so everything before the FIRST `node_modules/` segment is
 * that checkout. Taking the first one matters under pnpm, whose virtual store
 * nests a second one (`node_modules/.pnpm/tsx@x/node_modules/tsx/...`).
 */
export const checkoutOf = (command, repoRoot) => {
  const root = repoRoot.replace(/\/$/, "");
  const at = command.indexOf(`${root}/`);
  if (at === -1) return null;
  const rest = command.slice(at + root.length + 1);

  const worktree = rest.match(CLAUDE_WORKTREE_PATTERN);
  if (worktree) return worktree[1];

  const nodeModulesAt = rest.startsWith("node_modules/")
    ? 0
    : rest.indexOf("/node_modules/");
  // No node_modules in the path at all: nothing reliable to cut on, and the
  // main checkout is the honest guess.
  if (nodeModulesAt === -1) return "(main checkout)";
  const relative = rest.slice(0, nodeModulesAt);
  return relative === "" ? "(main checkout)" : relative;
};

/**
 * Every watcher process of this repository — the main checkout and all of its
 * worktrees — with whether it is orphaned.
 */
export const findRepoWatchers = (rows, repoRoot) => {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows
    .filter((row) => WATCHER_PATTERN.test(row.command))
    .map((row) => ({
      ...row,
      checkout: checkoutOf(row.command, repoRoot),
      orphaned: isOrphaned(row, byPid),
    }))
    .filter((row) => row.checkout !== null);
};

/** `ps` columns worth showing for a watcher, shortened to fit a terminal. */
const describeRow = (row) => {
  const kind = /tsx/.test(row.command)
    ? "tsx watch"
    : /next dev/.test(row.command)
      ? "next dev"
      : "tsc --watch";
  return `    ${String(row.pid).padStart(6)}  up ${row.etime.padEnd(12)} ${kind.padEnd(12)} ${row.checkout}`;
};

/** A command that lists this repo's dev watchers, scoped to the repo path. */
export const inspectCommand = (repoRoot) =>
  `ps -Ao pid,ppid,etime,command | grep -F '${repoRoot.replace(/\/$/, "")}/' | grep -E 'tsx/dist/cli.mjs watch|next dev|tsc --watch'`;

/**
 * The preflight warning, or `null` when no watcher is orphaned. Live watchers
 * of other checkouts are normal — agents run side by side — and only counted.
 */
export const describeStrayWatchers = (watchers, repoRoot) => {
  const orphans = watchers.filter((row) => row.orphaned);
  if (orphans.length === 0) return null;
  const live = watchers.length - orphans.length;
  return [
    ``,
    `  ${orphans.length} dev watcher process${orphans.length === 1 ? "" : "es"} of this repo outlived the run that started ${orphans.length === 1 ? "it" : "them"}:`,
    ``,
    ...orphans.map(describeRow),
    ``,
    `  Each one holds file watches. Enough of them and \`next dev\` cannot open`,
    `  its own, and then EVERY route answers 404. ${live} other watcher${live === 1 ? " is" : "s are"} attached to a live run.`,
    `  Inspect:  ${inspectCommand(repoRoot)}`,
    `  If they are yours to stop:  kill ${orphans.map((row) => row.pid).join(" ")}`,
    ``,
  ].join("\n");
};

// The ESC byte is the point: dev output arrives coloured, and a code inside an
// escape sequence must not be read as part of the message.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI colour codes
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * The error code when a line of dev output reports a watcher that could not be
 * opened, else `null`. Watchpack prints `EMFILE: too many open files, watch`;
 * Linux's inotify limit shows up as `ENOSPC` or its own sentence.
 */
export const watcherFailureIn = (line) => {
  const plain = line.replace(ANSI_PATTERN, "");
  const code = plain.match(/\b(EMFILE|ENOSPC)\b.*\bwatch\b/);
  if (code) return code[1];
  if (/System limit for number of file watchers reached/.test(plain)) return "ENOSPC";
  return null;
};

/** What `pnpm run dev` prints, once, the first time a watcher fails. */
export const describeWatcherFailure = ({ code, source, watchers, repoRoot }) => {
  const orphans = watchers.filter((row) => row.orphaned);
  return [
    ``,
    `  ┌─ ${source ? `[${source}] ` : ""}cannot watch files (${code}) ─────────────────────────`,
    `  │ Next never scans app/ when its watcher fails, so EVERY route will`,
    `  │ answer 404 while public/ files still load. It is not your code.`,
    `  │`,
    `  │ The usual cause is dev watchers left over from earlier runs.`,
    `  │ See them:  ${inspectCommand(repoRoot)}`,
    ...(orphans.length > 0
      ? [
          `  │ Outlived the run that started them:`,
          ...orphans.map((row) => `  │${describeRow(row).slice(1)}`),
          `  │ If they are yours to stop:  kill ${orphans.map((row) => row.pid).join(" ")}`,
        ]
      : []),
    `  │`,
    `  │ Stop the ones you started, then restart. Or poll instead of watching:`,
    `  │   WATCHPACK_POLLING=true pnpm run dev`,
    `  └──────────────────────────────────────────────────────────────`,
    ``,
  ].join("\n");
};
