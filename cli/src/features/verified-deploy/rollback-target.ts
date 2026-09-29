/*
 * cli/src/features/verified-deploy/rollback-target.ts — what a failed
 * deploy is allowed to go back to.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * A rollback is only as good as the reference it restores. Deploys pick
 * their image by moving a `:live` tag in the registry, so "go back" means
 * pointing `:live` at an older `:<sha>` again — and three things look
 * like a place to go back to and are not:
 *
 *   1. Nothing. A half that reported no commit before the run (a first
 *      deploy, or one that was down) names no build.
 *   2. A MUTABLE reference. A half reporting `main` or an abbreviated
 *      sha names no immutable image tag.
 *   3. An image the registry no longer has. Restoring it would fail the
 *      promote, half way through a rollback.
 *
 * The target is what each half was SERVING before the run moved
 * anything, read from its own health or build-info endpoint: that is
 * what was actually running, not what something last asked for. All
 * three "none" cases end the run with an error rather than a retry —
 * see the module header of index.ts for why "no target" never loops.
 *
 * The generated lib (script.ts) carries the same function; the tests
 * hold the two to the same cases.
 */

import type { RollbackTarget } from "./types.js";

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

/** The immutable reference of `base` at `sha`. */
function imageRef(base: string, sha: string): string {
  return `${base}:${sha}`;
}

/**
 * Which image a rollback may restore for one half, and when there is
 * none, the sentence that says why. Each reason names the fix.
 */
export function selectRollbackTarget(input: {
  app: string;
  /** The commit the half reported before the run, or null/undefined
   *  when it reported none. */
  served: unknown;
  /** The half's image, without a tag. */
  base: string;
  /** Whether the registry still has `base:served`. */
  inRegistry: boolean;
}): RollbackTarget {
  const { app, served, base } = input;
  if (served === undefined || served === null || served === "") {
    return {
      kind: "none",
      reason: `the ${app} half reported no commit before the deploy: this is a first deploy, or it was not answering`,
    };
  }
  if (!isFullSha(served)) {
    return {
      kind: "none",
      reason: `the ${app} half reported ${String(served)}, which is not a full commit sha, so no image tag names it`,
    };
  }
  if (input.inRegistry !== true) {
    return {
      kind: "none",
      reason: `${imageRef(base, served)} is not in the registry, so there is no image to go back to`,
    };
  }
  return { kind: "target", value: imageRef(base, served), sha: served };
}
