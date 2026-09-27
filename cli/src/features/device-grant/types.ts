import type { Feature } from "../../prompts.js";
/*
 * cli/src/features/device-grant/types.ts — the inventory of the shared
 * device-grant unit: who depends on it, what it owns, and what it edits.
 *
 * ============================================================
 * WHY THIS IS NOT A FEATURE
 * ============================================================
 *
 * There is no `registerFeature` call in this directory, no member in the
 * `Feature` union and no `--features` entry, on purpose. What this unit
 * installs is a PAIRING endpoint: RFC 8628 device authorization plus
 * better-auth's `bearer()`, and the page a person approves a code on.
 * Offering that on its own would offer a pairing endpoint with nothing
 * to pair — a server route and a page that no shipped client ever
 * reaches, which is worse than absent because it looks deliberate.
 *
 * So it is applied by whichever DEPENDENT is selected, and removed only
 * when every one of them is absent. {@link DEVICE_GRANT_DEPENDENTS} is
 * the one place that list is written down; the scaffold, `update` and
 * the tests all ask {@link deviceGrantWanted} rather than each carrying
 * their own copy of it. A second copy is how a launcher extension ends
 * up scaffolded with no way to sign in, with nothing failing to say so.
 *
 * ============================================================
 * WHY THE STRIP LIST IS SHORT
 * ============================================================
 *
 * `create` copies the starter and subtracts — but the starter ships
 * none of this. The approval page and its helper are template files,
 * written only by an apply, so there is nothing for a create-time strip
 * to delete on a project that asked for neither dependent. The paths
 * below exist for the two cases where something IS on disk: the
 * `backend` / `static` surface prune in `cli/src/scaffold/surfaces.ts`,
 * which runs over a tree the apply has already touched, and a project
 * whose surface changed after a dependent was added.
 */

/**
 * The features that need the device grant, by id.
 *
 * Typed as `string` rather than `Feature` deliberately: the union lives
 * in `cli/src/prompts.ts`, which a single later registration pass owns,
 * and `raycast` is not in it yet. Typing this as `Feature[]` would force
 * either an edit outside this unit's boundary or a dependent left off
 * the list — and a dependent left off the list is silently stripped.
 *
 * `mcp` is NOT here. It authenticates with an API token minted on the
 * tRPC router by `public-api`, never by pairing, so it needs neither
 * half of this unit.
 */
export const DEVICE_GRANT_DEPENDENTS: readonly Feature[] = ["extension", "raycast"];

/**
 * Whether a selection needs the device grant.
 *
 * The scaffold, `hatchkit update` and the tests all ask this. Comparing
 * against `DEVICE_GRANT_DEPENDENTS` in three places instead would go
 * stale the first time a fourth client surface is added, and the failure
 * is a project that scaffolds a pairing client with the server half
 * missing — the client shows a code, the server answers 404, and nothing
 * in the build says why.
 */
export function deviceGrantWanted(features: readonly string[]): boolean {
  // `string[]` in, deliberately: callers hold a `Feature[]`, but a manifest
  // read off disk can carry an id this build has never heard of, and asking
  // "is it one of mine?" must not require it to be one of mine first.
  const dependents: readonly string[] = DEVICE_GRANT_DEPENDENTS;
  return features.some((feature) => dependents.includes(feature));
}

/**
 * The inverse, spelled out because that is the question the strip asks.
 *
 * "Strip it" and "do not apply it" are the same decision read from
 * opposite ends, and writing both against one predicate is what keeps
 * them from disagreeing: a selection that is neither applied nor
 * stripped leaves a half-installed flow.
 */
export function shouldStripDeviceGrant(features: readonly string[]): boolean {
  return !deviceGrantWanted(features);
}

/**
 * Which dependents in a selection carry a device-flow client id.
 *
 * Order is the order of {@link DEVICE_GRANT_DEPENDENTS}, not the order
 * the user happened to pick, so the generated allowlist is stable across
 * runs — an unstable order would rewrite `auth.ts` on every `update` and
 * break the idempotency the ledger is there to report.
 */
export function deviceGrantClientHosts(features: readonly string[]): string[] {
  return DEVICE_GRANT_DEPENDENTS.filter((dependent) => features.includes(dependent));
}

/**
 * Paths the unit owns outright — written by its apply, removed with it.
 * Relative to the deployable directory. Directories go recursively.
 */
export const DEVICE_GRANT_OWNED_PATHS: readonly string[] = [
  "packages/client/src/app/device",
  "packages/client/src/lib/device-approve.ts",
];

/**
 * Files the starter always ships that the unit EDITS rather than owns.
 *
 * Nothing here is rewritten wholesale: each edit is a fixed point that
 * checks for what it produces, so a re-apply reports nothing written and
 * a user's own lines in these files survive. They are listed because a
 * reader asking "what does selecting a launcher extension touch on the
 * server?" should find the answer in one place, and because a strip that
 * one day has to unwire them needs to know where to look.
 */
export const DEVICE_GRANT_PATCHED_FILES: readonly string[] = [
  "packages/server/src/auth/auth.ts",
  "packages/client/src/lib/auth-client.ts",
];

/** The unit's template directory under `cli/src/templates/`. */
export const DEVICE_GRANT_TEMPLATES = "device-grant";
