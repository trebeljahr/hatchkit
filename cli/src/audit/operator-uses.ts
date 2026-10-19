/*
 * When did hatchkit hold the operator token? The daily audit trusts an
 * audit-log entry by `hatchkit-cloudflare` only when it falls inside one
 * of these windows; outside them the token acted without hatchkit.
 *
 * `getCloudflareToken` calls `recordOperatorUse` when the operator slot
 * answers. The first call in a process appends `{pid, start}` and hooks
 * process exit to append `{pid, end}`. Records older than 30 days are
 * dropped on the next write. Once `cloudflareAudit.repo` is set, the
 * exit hook also republishes the expected state in a detached `gh`, so
 * the scheduled check sees this run's window.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStore } from "../config.js";
import type { RunWindow } from "./cloudflare.js";
import { EXPECTED_VARIABLE, buildLocalExpected, getAuditRepo } from "./expected.js";

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

export interface RecordOperatorUseDeps {
  now?: () => Date;
  /** Republish on exit; default reads `cloudflareAudit.repo`. Tests pass a stub. */
  onExit?: () => void;
}

/** Note that this process holds the operator token. Never throws. */
export function recordOperatorUse(deps: RecordOperatorUseDeps = {}): void {
  if (recorded) return;
  recorded = true;
  const now = deps.now ?? (() => new Date());
  try {
    const path = operatorUsesPath();
    prune(path, now());
    appendFileSync(path, `${JSON.stringify({ pid: process.pid, start: now().toISOString() })}\n`);
    process.once("exit", () => {
      try {
        appendFileSync(path, `${JSON.stringify({ pid: process.pid, end: now().toISOString() })}\n`);
        (deps.onExit ?? publishOnExit)();
      } catch {
        // The audit then reports this run as unmatched: a false alarm, not a miss.
      }
    });
  } catch {
    // Same: losing a window can only cause a false alarm.
  }
}

/** Test seam: forget that this process recorded a use. */
export function resetOperatorUseForTests(): void {
  recorded = false;
}

/** Exit hook: hand the expected state to a detached `gh`. Sync work only. */
function publishOnExit(): void {
  const repo = getAuditRepo();
  // Never from the test runner: a stray `gh variable set` is a real write.
  if (
    !repo ||
    process.env.HATCHKIT_AUDIT_AUTOPUBLISH === "0" ||
    process.env.HATCHKIT_TEST_KEYCHAIN_DIR
  )
    return;
  const body = JSON.stringify(buildLocalExpected({ now: new Date() }));
  const child = spawn(
    "gh",
    ["variable", "set", EXPECTED_VARIABLE, "--repo", repo, "--body", body],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.on("error", () => undefined);
  child.unref();
}
