/**
 * Stopping a whole process group, for `scripts/dev.mjs` and its reaper.
 *
 * `pnpm run dev` is a tree five levels deep — concurrently, a shell, pnpm, tsx
 * watch, the server — and a signal sent to one pid reaches that pid only. The
 * dev script therefore starts concurrently as the leader of a process group of
 * its own and stops the tree by signalling the group (`kill(-pgid)`), which
 * reaches every descendant at once, including ones whose parent already died.
 *
 * POSIX only. Windows has no process groups to signal; callers skip it there.
 */

/** How long a group gets between SIGTERM and SIGKILL. tsx watch waits 5s. */
export const GROUP_GRACE_MS = 8000;

/** Send `signal` to every process in the group. False when the group is gone. */
export const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false; // ESRCH: nothing left in the group
  }
};

/** True while any process is still a member of the group. */
export const groupAlive = (pgid) => signalGroup(pgid, 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true once the group is empty, false if `timeoutMs` passes first. */
export const waitForGroupExit = async (pgid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
};

/**
 * SIGTERM (or `signal`) to the group, then SIGKILL to whatever is still there
 * after the grace period. Resolves once the group is empty.
 */
export const terminateGroup = async (
  pgid,
  { signal = "SIGTERM", graceMs = GROUP_GRACE_MS } = {},
) => {
  if (!signalGroup(pgid, signal)) return;
  if (await waitForGroupExit(pgid, graceMs)) return;
  signalGroup(pgid, "SIGKILL");
  await waitForGroupExit(pgid, 2000);
};
