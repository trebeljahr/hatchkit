/*
 * cli/src/features/verified-deploy/rollback-target.ts — what a failed
 * deploy is allowed to go back to.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * A rollback is only as good as the reference it restores. Three values
 * look like a rollback target and are not:
 *
 *   1. A MUTABLE tag. The compose files default the image variable to
 *      `:main`, and after a push `:main` already points at the build
 *      that just failed. "Restoring" it redeploys the failure, the gate
 *      fails again, and a job that believes it recovered reports a
 *      rollback that changed nothing.
 *   2. A value the token may not read. The platform omits `value` from
 *      its env listing entirely when the token lacks permission for
 *      sensitive values. Read as an empty string that would pin an empty
 *      image reference; read as "unknown" it correctly stops the run.
 *   3. The preview copy of the variable. The platform keeps one beside
 *      the production row, and it is not what production runs.
 *
 * All three have to end the run with an error rather than a retry — see
 * the module header of index.ts for why "no target" never loops.
 */

import type { PlatformEnvEntry, RollbackTarget } from "./types.js";

/** A full commit sha: the only tag an image reference may carry for the
 *  reference to name one immutable build. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** True for a full 40-character lowercase commit sha. Abbreviated shas
 *  are deliberately rejected here: an image tag is written by the build,
 *  never typed, so a short one means something else produced it. */
export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && FULL_SHA.test(value);
}

/**
 * The commit an image reference is pinned to, or null.
 *
 * Splits on the LAST colon so a registry with a port
 * (`registry.example.com:5000/app:<sha>`) still resolves, and rejects
 * anything that is not a full sha — which is the whole point: `:main`,
 * `:latest` and `:v2` all name a moving target.
 */
export function shaFromImageRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const colon = value.lastIndexOf(":");
  if (colon === -1) return null;
  const tag = value.slice(colon + 1);
  return isFullSha(tag) ? tag : null;
}

/**
 * The production value of `key` in the platform's env listing, or null
 * when it is absent, a preview copy, or unreadable.
 *
 * Null rather than `""` on purpose. The caller has to be able to tell
 * "there is no such variable" and "the token cannot see this variable"
 * apart from "the variable is set to the empty string", and treating all
 * three as "no target" is the safe collapse — none of them names a build
 * to go back to.
 */
export function findEnvValue(
  entries: readonly PlatformEnvEntry[] | null | undefined,
  key: string,
): string | null {
  if (!Array.isArray(entries)) return null;
  const rows = entries.filter((row) => row && typeof row === "object" && row.key === key);
  const row = rows.find((candidate) => candidate.is_preview !== true) ?? null;
  return row && typeof row.value === "string" && row.value !== "" ? row.value : null;
}

/**
 * Which value a rollback may restore for one image variable, and when
 * there is none, the sentence that says why.
 *
 * The reasons are written for the person reading a failed run, so each
 * one names the fix: create the variable, pin it, or widen the token.
 */
export function selectRollbackTarget(
  entries: readonly PlatformEnvEntry[] | null | undefined,
  key: string,
): RollbackTarget {
  const value = findEnvValue(entries, key);
  if (value === null) {
    return {
      kind: "none",
      reason: `no ${key} value could be read: this is a first deploy, the variable does not exist on the application, or the token may not read variable values`,
    };
  }
  const sha = shaFromImageRef(value);
  if (sha === null) {
    return {
      kind: "none",
      reason: `${key} is ${value}, which is a moving tag rather than a commit — after this push it already points at the build that just failed, so restoring it would redeploy the failure`,
    };
  }
  return { kind: "target", value, sha };
}
