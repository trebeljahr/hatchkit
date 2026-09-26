#!/usr/bin/env node
/**
 * Stops a dev process group once `scripts/dev.mjs` is gone, however it went.
 *
 *   node scripts/lib/dev-reaper.mjs <pgid>
 *
 * `dev.mjs` stops its own children on SIGINT, SIGTERM and SIGHUP. It cannot do
 * that when it is killed with SIGKILL, crashes, or has its whole process group
 * killed by an agent harness — and every one of those used to leave `tsx
 * watch` and `next dev` running for days, holding thousands of file watches
 * until a new `next dev` could not open any and answered 404 on every route.
 *
 * So `dev.mjs` starts this process in a process group of its own, with a pipe
 * on its stdin. The kernel closes that pipe when `dev.mjs` exits for ANY
 * reason, SIGKILL included, and the close is the whole signal: no polling, no
 * pid that could be reused. If `dev.mjs` already cleaned up, the group is empty
 * and this exits at once.
 */
import { terminateGroup } from "./process-group.mjs";

const pgid = Number(process.argv[2]);
if (!Number.isInteger(pgid) || pgid <= 1) {
  console.error(`dev-reaper: expected a process group id, got ${process.argv[2]}`);
  process.exit(2);
}

// A Ctrl+C or hangup aimed at the dev script must not take this out before it
// has done its one job. It is in its own group, so this is belt and braces.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});

let reaping = false;
const reap = async () => {
  if (reaping) return;
  reaping = true;
  await terminateGroup(pgid);
  process.exit(0);
};

process.stdin.on("end", reap);
process.stdin.on("close", reap);
process.stdin.on("error", reap);
process.stdin.resume();
