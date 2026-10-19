/*
 * When did hatchkit hold the operator token? The daily audit trusts an
 * audit-log entry by `hatchkit-cloudflare` only when it falls inside one
 * of these windows; outside them the token acted without hatchkit.
 *
 * `getCloudflareToken` calls `recordOperatorUse` when the operator slot
 * answers. The first call in a process appends `{pid, start}` and hooks
 * process exit to append `{pid, end}`. Records older than 30 days are
 * dropped on the next write. With an audit Worker deployed, the same
 * windows go to its bucket, signed (see `recordOperatorUse`).
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStore } from "../config.js";
import { getConfiguredCloudflareAccountId } from "../config.js";
import type { RunWindow } from "./cloudflare.js";
import { publishExpectedToWorker, uploadRunWindow } from "./deploy.js";
import { getAuditWorker } from "./expected.js";

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

let recorded = false;

export function operatorUsesPath(): string {
  return join(dirname(getStore().path), "cloudflare-operator-uses.jsonl");
}

type UseLine = { pid: number; start?: string; end?: string };

function readLines(path: string): UseLine[] {
  if (!existsSync(path)) return [];
  const out: UseLine[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as UseLine;
      if (typeof parsed?.pid === "number") out.push(parsed);
    } catch {
      // A torn line from a crash; skip it.
    }
  }
  return out;
}

/** Windows that ended (or started) after `since`, oldest first. */
export function readOperatorRuns(since: Date, path = operatorUsesPath()): RunWindow[] {
  const open = new Map<number, RunWindow>();
  const runs: RunWindow[] = [];
  for (const line of readLines(path)) {
    if (line.start) {
      const run: RunWindow = { start: line.start };
      open.set(line.pid, run);
      runs.push(run);
    } else if (line.end) {
      const run = open.get(line.pid);
      if (run) {
        run.end = line.end;
        open.delete(line.pid);
      }
    }
  }
  const cutoff = since.getTime();
  return runs.filter((r) => Date.parse(r.end ?? r.start) >= cutoff || !r.end);
}

function prune(path: string, now: Date): void {
  const lines = readLines(path);
  const cutoff = now.getTime() - KEEP_MS;
  // Rewrite at most about once a day (only once the oldest line is a day
  // past the cutoff), through a rename: another hatchkit process may be
  // appending, and a lost `end` line would read as a 2 h window.
  const oldest = Math.min(...lines.map((l) => Date.parse(l.start ?? l.end ?? "")));
  if (!(oldest < cutoff - 24 * 60 * 60 * 1000)) return;
  const kept = lines.filter((l) => Date.parse(l.start ?? l.end ?? "") >= cutoff);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.map((l) => JSON.stringify(l)).join("\n") + (kept.length ? "\n" : ""));
  renameSync(tmp, path);
}

export interface RemoteWindowHooks {
  /** Upload `runs/<key>` with this window (operator token, signed). */
  upload(key: string, run: RunWindow): Promise<void>;
  /** Republish the signed expected state. */
  publish(): Promise<void>;
}

export interface RecordOperatorUseDeps {
  now?: () => Date;
  /** Where windows go besides the local log. Default: the audit Worker's
   *  bucket when one is deployed. Tests pass stubs. */
  remote?: RemoteWindowHooks | null;
}

function defaultRemote(token: string): RemoteWindowHooks | null {
  // Never from the test runner (a real write), never when switched off.
  if (process.env.HATCHKIT_TEST_KEYCHAIN_DIR || process.env.HATCHKIT_AUDIT_AUTOPUBLISH === "0")
    return null;
  if (!getAuditWorker()) return null;
  const accountId = getConfiguredCloudflareAccountId();
  if (!accountId) return null;
  const op = { token, accountId };
  return {
    upload: (key, run) => uploadRunWindow(op, key, run),
    publish: async () => {
      await publishExpectedToWorker({ operator: async () => op });
    },
  };
}

/** Note that this process holds the operator token. Never throws.
 *
 *  Locally: `{pid, start}` now, `{pid, end}` on exit. With an audit
 *  Worker: the signed window goes to its bucket now (so a long run is
 *  covered while it runs), and again with its end plus the expected
 *  state once the command finishes (`beforeExit`; a `process.exit` path
 *  skips it and leaves the 2 h start-only window). */
export function recordOperatorUse(token = "", deps: RecordOperatorUseDeps = {}): void {
  if (recorded) return;
  recorded = true;
  const now = deps.now ?? (() => new Date());
  const start = now().toISOString();
  try {
    const path = operatorUsesPath();
    prune(path, now());
    appendFileSync(path, `${JSON.stringify({ pid: process.pid, start })}\n`);
    process.once("exit", () => {
      try {
        appendFileSync(path, `${JSON.stringify({ pid: process.pid, end: now().toISOString() })}\n`);
      } catch {
        // The audit then reports this run as unmatched: a false alarm, not a miss.
      }
    });
  } catch {
    // Same: losing a window can only cause a false alarm.
  }
  let remote: RemoteWindowHooks | null = null;
  try {
    remote = deps.remote === undefined ? defaultRemote(token) : deps.remote;
  } catch {
    remote = null;
  }
  if (!remote) return;
  const key = `runs/${start.replace(/[:.]/g, "")}-${process.pid}.json`;
  const first = remote.upload(key, { start }).catch(() => undefined);
  let finished = false;
  process.once("beforeExit", () => {
    if (finished) return;
    finished = true;
    void (async () => {
      await first;
      await remote.upload(key, { start, end: now().toISOString() }).catch(() => undefined);
      await remote.publish().catch(() => undefined);
    })();
  });
}

/** Test seam: forget that this process recorded a use. */
export function resetOperatorUseForTests(): void {
  recorded = false;
}
