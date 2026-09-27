/*
 * cli/src/features/device-grant/strip.ts — remove the shared device
 * grant from a project that has no client to pair.
 *
 * ============================================================
 * WHEN THIS RUNS, AND WHEN IT MUST NOT
 * ============================================================
 *
 * Only when EVERY dependent is absent — ask
 * {@link shouldStripDeviceGrant}, never a hand-written feature check.
 * Stripping while one dependent is still selected deletes the page that
 * client pairs through, and the client fails at the last step of a flow
 * it has already shown a code for.
 *
 * Unlike `client-core`'s strip there is nothing here for a fresh
 * `create` to do: the starter ships neither the approval page nor its
 * helper, so a project that selected no pairing client never had them.
 * This exists for the tree an apply HAS touched — the `backend` /
 * `static` surface prune, and a project whose surface changed after a
 * dependent was added — and for `hatchkit adopt`, which runs over a repo
 * of unknown provenance. Every step is therefore a no-op on a tree that
 * does not have the files, and running it twice changes nothing.
 *
 * It deliberately does NOT unwire `auth.ts` or `auth-client.ts`. Those
 * are edits inside files the project owns and has been editing for
 * months; an automated un-edit of somebody's auth configuration is the
 * one operation in this codebase that can lock every user out of a
 * running deployment. `DEVICE_GRANT_PATCHED_FILES` names them so a
 * person can, and the caller reports it as a manual step.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { removeIfExists } from "../../scaffold/starter-files.js";
import {
  DEVICE_GRANT_OWNED_PATHS,
  DEVICE_GRANT_PATCHED_FILES,
  shouldStripDeviceGrant,
} from "./types.js";

/**
 * Remove the unit's own files from `projectDir`, in place.
 *
 * Returns the modification lines for a scaffold summary, empty when
 * there was nothing to remove — so a caller can print the result
 * unconditionally without claiming it did something it did not.
 */
export function stripDeviceGrant(projectDir: string): string[] {
  const removed: string[] = [];

  for (const rel of DEVICE_GRANT_OWNED_PATHS) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    removeIfExists(path);
    removed.push(rel);
  }

  if (removed.length === 0) return [];
  return [
    `removed: device grant (no pairing client selected) — ${removed.join(", ")}`,
    // Named, not performed. See the file header.
    `device grant: bearer()/deviceAuthorization() are still registered in ${DEVICE_GRANT_PATCHED_FILES[0]} — remove them by hand if you want the endpoints gone.`,
  ];
}

export { shouldStripDeviceGrant };
