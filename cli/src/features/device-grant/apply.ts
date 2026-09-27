/*
 * cli/src/features/device-grant/apply.ts — install the shared device
 * grant into a project.
 *
 * ============================================================
 * WHO CALLS THIS, AND WHY IT IS CALLED MORE THAN ONCE
 * ============================================================
 *
 * Not the feature registry: this unit is not a feature (see `types.ts`).
 * Each DEPENDENT calls it from its own `apply`, which means a project
 * that ships both the browser extension and a launcher extension calls
 * it TWICE in one run. That is the design, not an accident — a
 * dependent may not assume another dependent went first — and it works
 * only because every mutation below goes through `ctx.ledger`, whose
 * primitives compare before they write. The second call reports
 * `unchanged` for every path and adds nothing to `summary().written`.
 *
 * A bare `writeFileSync` anywhere in here would break that AND
 * `--dry-run`, and nothing would catch either one.
 *
 * ============================================================
 * WHICH CLIENT IDS END UP IN THE ALLOWLIST
 * ============================================================
 *
 * The server only lets a client it knows start a pairing flow, so the
 * generated `validateClient` names one id per dependent. Those ids come
 * from `ctx.identifiers.clientIds` — a device-flow client id is carried
 * by every token the server has already issued, so it is read, never
 * derived.
 *
 * The SELECTION is read from `ctx.manifest.features`, not from which
 * dependent happens to be calling. Two reasons, and either alone is
 * enough: the two calls in a both-dependents run would otherwise write
 * two different allowlists and fight over the file on every apply, and
 * `hatchkit update` adding a launcher to a project that already ships
 * the extension has to end with BOTH ids accepted — one id would refuse
 * the other client with `invalid_client`, which reads like an outage.
 */

import type { FeatureContext } from "../contract.js";
import { renderFeatureTemplate } from "../templates.js";
import { type PatchResult, addDeviceClientPlugin, wireDeviceGrant } from "./patches.js";
import { DEVICE_GRANT_TEMPLATES, deviceGrantClientHosts } from "./types.js";

/**
 * Template -> project path for the files the unit writes.
 *
 * Both are SEEDED, not owned: they are the project's own source from the
 * moment they land (somebody will restyle that approval form), so a
 * later `update` keeps what is there instead of taking the edit back.
 */
const SEEDED: ReadonlyArray<readonly [string, string]> = [
  ["client/device-approve.ts", "packages/client/src/lib/device-approve.ts"],
  ["client/device-page.tsx", "packages/client/src/app/device/page.tsx"],
];

/** The paths an apply would write, for `plannedFiles` on a dependent. */
export function deviceGrantPlannedFiles(): string[] {
  return SEEDED.map(([, target]) => target);
}

/**
 * The client ids the server should accept, for this project's selection.
 *
 * Exported so a dependent's test can assert the allowlist without
 * re-deriving it, and so a caller can see what the grant will permit
 * before it runs.
 */
export function deviceGrantClientIds(
  ctx: Pick<FeatureContext, "manifest" | "identifiers">,
): string[] {
  const hosts = deviceGrantClientHosts(ctx.manifest.features);
  return hosts
    .map((host) => ctx.identifiers.clientIds[host as keyof typeof ctx.identifiers.clientIds])
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Apply the device grant. Safe to call once per dependent per run.
 *
 * Returns the manual-wiring lines its patches could not do themselves,
 * for the caller to print. They are returned rather than logged so a
 * dependent can fold them into the list it already prints — two separate
 * lists of manual steps is how one of them gets ignored.
 */
export function applyDeviceGrant(ctx: FeatureContext): string[] {
  const { ledger } = ctx;
  const problems: string[] = [];

  const clientIds = deviceGrantClientIds(ctx);
  if (clientIds.length === 0) {
    // A dependent called this without being in the manifest's feature
    // list. Writing an empty allowlist would scaffold a pairing endpoint
    // that refuses the very client that asked for it, so say so instead.
    problems.push(
      "The device grant was applied with no client id: no pairing client is listed in .hatchkit.json's features, so nothing would be allowed to pair.",
    );
  }

  for (const [template, target] of SEEDED) {
    // The project's own source once written. `exists` first, so a second
    // dependent — or a second `update` — keeps the user's version rather
    // than counting it as unchanged, which it may well not be.
    if (ledger.exists(target)) continue;
    ledger.writeIfChanged(target, renderFeatureTemplate(DEVICE_GRANT_TEMPLATES, template, {}));
  }

  const patch = (target: string, fn: (content: string) => PatchResult): void => {
    const before = ledger.read(target);
    if (before === undefined) {
      problems.push(`${target} is missing: wire the device grant into it by hand.`);
      return;
    }
    const result = fn(before);
    if (result.problem !== undefined) problems.push(result.problem);
    // `result.content` is already the fixed point, so `edit` records
    // `unchanged` on every later run and the ledger reports nothing.
    ledger.edit(target, () => result.content);
  };

  patch("packages/server/src/auth/auth.ts", (content) => wireDeviceGrant(content, clientIds));
  patch("packages/client/src/lib/auth-client.ts", addDeviceClientPlugin);

  return problems;
}
