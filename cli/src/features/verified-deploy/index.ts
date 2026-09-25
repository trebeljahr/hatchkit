/*
 * cli/src/features/verified-deploy/index.ts — write the verified deploy
 * into a project.
 *
 * ---------------------------------------------------------------------
 * What this module is
 * ---------------------------------------------------------------------
 *
 * `scaffold/deploy-verification.ts` already makes the pipeline assert
 * that the thing running is the thing it just built: it pins immutable
 * image references and polls the origins until they name this run's
 * commit. This module is the next step — a deploy that also UNDOES
 * itself when that assertion fails, and the manual rollback workflow
 * that shares its script.
 *
 * In order, one deploy:
 *
 *   1. Reads the rollback target BEFORE pinning. Only a value already
 *      pinned to a full commit sha counts; a moving tag points at the
 *      new build the moment the push lands, so restoring it would
 *      redeploy the failure.
 *   2. Pins the immutable references, reads them back, and queues the
 *      deploy.
 *   3. Polls each half until it reports the commit this run built. A
 *      queued deploy is not a finished one.
 *   4. Runs the gate: health and database, the API origin the client
 *      was BUILT against, an unauthenticated session call, and the
 *      cross-origin preflight.
 *   5. Restores the values from step 1 when 3 or 4 fails, and runs the
 *      same poll and gate against the restored commit. The run fails
 *      either way — a rollback is never a green run, because the commit
 *      on the default branch is still broken.
 *
 * ---------------------------------------------------------------------
 * The two things that never loop
 * ---------------------------------------------------------------------
 *
 * No rollback target, and a rollback that itself fails. Both end the run
 * with one error that names which it was. A second automatic attempt
 * against a state nobody has looked at is how an outage grows, so there
 * is none.
 *
 * ---------------------------------------------------------------------
 * Where the decisions live
 * ---------------------------------------------------------------------
 *
 * Nothing here decides anything. `gate.ts` decides whether a deploy
 * worked, `rollback-target.ts` decides what may be restored,
 * `migration-guard.ts` decides whether the server may go back at all,
 * and `plan.ts` decides what a given project can check. This module
 * only writes files, and it writes every one of them through
 * `ctx.ledger` — so `--dry-run` and the idempotency invariant are
 * structural here rather than remembered. See
 * `docs/feature-authoring.md` → "Editing a file the user also edits".
 */

import {
  type OperationalContext,
  type OperationalOutcome,
  applied,
  skipped,
} from "../operational-context.js";
import { planVerifiedDeploy } from "./plan.js";
import {
  DEPLOY_ENTRY_REL_PATH,
  DEPLOY_LIB_REL_PATH,
  renderDeployEntry,
  renderDeployLib,
} from "./script.js";
import type { VerifiedDeployOverrides } from "./types.js";
import {
  ROLLBACK_WORKFLOW_REL_PATH,
  renderRollbackWorkflow,
  verifiedDeployRetrofits,
} from "./workflow.js";

export * from "./types.js";
export { applicableChecks, evaluateGate, isWaiting } from "./gate.js";
export {
  breakingMigrations,
  canRollBackServer,
  readMigrationRegistry,
  EMPTY_REGISTRY,
} from "./migration-guard.js";
export {
  findEnvValue,
  isFullSha,
  selectRollbackTarget,
  shaFromImageRef,
} from "./rollback-target.js";
export {
  DEPLOY_CONCURRENCY_GROUP,
  type VerifiedDeployPlanInput,
  deployAppsFor,
  planVerifiedDeploy,
} from "./plan.js";
export {
  DEPLOY_ENTRY_REL_PATH,
  DEPLOY_LIB_REL_PATH,
  renderDeployEntry,
  renderDeployLib,
} from "./script.js";
export {
  DEPLOY_STEP_NAME,
  ROLLBACK_WORKFLOW_REL_PATH,
  deployStepYaml,
  renderRollbackWorkflow,
  verifiedDeployRetrofits,
  withDeployCheckoutHistory,
  withDeployJobConcurrency,
  withVerifiedDeployStep,
  withoutPushCancellation,
  withoutSupersededDeploySteps,
} from "./workflow.js";

/**
 * Write the verified deploy into a project: the logic module, the entry
 * script, the manual rollback workflow, and the retrofits that give the
 * existing deploy job its concurrency group, its full history and the
 * script invocation.
 *
 * Two kinds of write, and they need different primitives:
 *
 *   · The logic module, the entry script and the rollback workflow are
 *     OWNED — this module generates them from the plan and regenerates
 *     them whenever the plan changes, which is exactly what
 *     `writeIfChanged` is for. Each carries a header comment saying so,
 *     because an owned file that does not announce itself is a file
 *     somebody edits and then loses on the next `hatchkit update`.
 *   · The retrofits EDIT `build-and-deploy.yml`, which is the project's
 *     own file and full of prose a user may have added to. Those go
 *     through `ledger.edit` with the transforms from `workflow.ts`: each
 *     is a fixed point and each returns its input unchanged when its
 *     anchor is missing, so a hand-rolled workflow is left alone rather
 *     than half-rewritten.
 *
 * `ctx.force` is deliberately not read. It exists for a module that
 * would otherwise refuse to touch a file the user has changed; the three
 * files here are regenerated on every apply either way, and the
 * retrofits only ever add what is not there yet.
 *
 * `overrides` is a second parameter rather than a field on the context,
 * so `applyVerifiedDeploy(ctx)` is the shape the operational layer
 * calls while a project whose migration registry lives elsewhere, or
 * whose gate needs a longer poll, can still get a tuned plan without
 * forking the generator.
 */
export function applyVerifiedDeploy(
  ctx: OperationalContext,
  overrides: VerifiedDeployOverrides = {},
): OperationalOutcome {
  const plan = planVerifiedDeploy(ctx, overrides);

  if (plan.apps.length === 0) {
    return skipped("this project deploys neither a server nor a client half");
  }

  ctx.ledger.writeIfChanged(DEPLOY_LIB_REL_PATH, renderDeployLib(plan));
  ctx.ledger.writeIfChanged(DEPLOY_ENTRY_REL_PATH, renderDeployEntry(plan));
  ctx.ledger.writeIfChanged(ROLLBACK_WORKFLOW_REL_PATH, renderRollbackWorkflow(plan));

  // A project with no deploy workflow records `absent` and is not an
  // error: a repo hatchkit did not scaffold may have none, and inventing
  // one would be guessing at somebody else's pipeline.
  for (const [, relPath, transform] of verifiedDeployRetrofits(plan)) {
    ctx.ledger.edit(relPath, transform);
  }

  // Everything below is a step only a person can take. What changed on
  // disk is the ledger's account to give, not this list's.
  const notes: string[] = [];
  for (const app of plan.apps) {
    if (!plan.imageBase[app]) {
      notes.push(
        `No image reference is known for the ${app} half, so the deploy script falls back to IMAGE_OWNER_REPO at run time — set it, or run \`hatchkit regen-infra\` once the compose files exist`,
      );
    }
    notes.push(
      `Create ${plan.imageEnvKeys[app]} once on the ${app} application: the platform's env API accepts an update for a key that does not exist and silently does nothing, so the pin would be a no-op`,
    );
  }
  notes.push(
    `The deploy and the manual rollback share the \`${plan.concurrencyGroup}\` concurrency group and neither is cancelled in progress — a queued manual rollback has to be watched, not dispatched and forgotten`,
  );

  return applied(notes);
}
