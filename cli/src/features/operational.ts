/*
 * cli/src/features/operational.ts — the operational layer, as one call.
 *
 * Seven modules, each answering one question a deployed project
 * eventually asks:
 *
 *   · verified-deploy    — did the thing I just built actually land, and
 *                          what happens when it did not?
 *   · topology-guidance  — why is this two applications on two hosts,
 *                          and where may those hosts live?
 *   · env-agreement      — does everything that carries the API origin
 *                          carry the SAME one, and does production env
 *                          reach the container at all?
 *   · self-host          — can a stranger run this, and does CI prove it?
 *   · docs-in-client     — are the docs served, indexed and linked?
 *   · deploy-recovery    — what happens to a tab that was open during a
 *                          deploy?
 *   · error-reporting    — where do client errors go, and what may they
 *                          carry?
 *
 * Why they are applied here rather than registered in `contract.ts`:
 * see the header of operational-context.ts. In short, they are not
 * choices — every deployed project needs them — but they use the same
 * ledger and obey the same two invariants.
 *
 * `create` writes them into a fresh project, `update` re-applies them to
 * an old one, and both want ONE report at the end rather than seven.
 * Adding a module means adding a row to {@link OPERATIONAL_MODULES},
 * not editing two call sites and hoping they stay in step.
 */

import { isTopology } from "../deploy/routing.js";
import type { Surface } from "../prompts.js";
import type { ProjectIdentifiers } from "../scaffold/identifiers.js";
import type { ProjectManifest } from "../scaffold/manifest.js";
import { FeatureLedger } from "./contract.js";
import { applyDeployRecovery } from "./deploy-recovery/index.js";
import { applyDocsInClient } from "./docs-in-client/index.js";
import { applyEnvAgreement } from "./env-agreement/index.js";
import { applyErrorReporting } from "./error-reporting/index.js";
import type {
  OperationalContext,
  OperationalModuleId,
  OperationalOutcome,
  OperationalProject,
} from "./operational-context.js";
import { applySelfHost } from "./selfhost/index.js";
import { applyTopologyGuidance } from "./topology-guidance/index.js";
import { applyVerifiedDeploy } from "./verified-deploy/index.js";

export interface OperationalModule {
  id: OperationalModuleId;
  /** One short phrase, used as the heading of this module's lines. */
  label: string;
  apply: (ctx: OperationalContext) => OperationalOutcome;
}

/**
 * The modules, in the order they are applied and reported.
 *
 * Order is deliberate rather than alphabetical, for the same reason
 * `expandFeatureSelection` sorts topologically: two modules that both
 * edit one file produce a different result depending on who goes first,
 * and a run whose order varies produces a diff that varies for no
 * reason.
 *
 * `verified-deploy` is first because it rewrites the deploy workflow,
 * and a later module's managed block anchors on the shape it leaves.
 * `topology-guidance` and `env-agreement` follow because they explain
 * the constraints the rest assume. The three client-side modules come
 * last: none is load-bearing for a deploy that works.
 */
export const OPERATIONAL_MODULES: readonly OperationalModule[] = [
  { id: "verified-deploy", label: "verified deploy + rollback", apply: applyVerifiedDeploy },
  { id: "topology-guidance", label: "deployment topology", apply: applyTopologyGuidance },
  { id: "env-agreement", label: "API origin + env sources", apply: applyEnvAgreement },
  { id: "self-host", label: "self-host path", apply: applySelfHost },
  { id: "docs-in-client", label: "docs in the client image", apply: applyDocsInClient },
  { id: "deploy-recovery", label: "deploy recovery in an open tab", apply: applyDeployRecovery },
  { id: "error-reporting", label: "client error reporting", apply: applyErrorReporting },
] as const;

export interface OperationalModuleOutcome {
  id: OperationalModuleId;
  label: string;
  outcome: OperationalOutcome;
}

export interface OperationalLayerResult {
  /** The ledger every module wrote through. Its `summary()` is the
   *  authoritative account of what changed, in both real and dry runs. */
  ledger: FeatureLedger;
  modules: OperationalModuleOutcome[];
  /** Every manual step, de-duplicated, in module order. */
  manualSteps: string[];
}

export interface ApplyOperationalLayerArgs {
  projectDir: string;
  project: OperationalProject;
  identifiers?: ProjectIdentifiers;
  mode: "create" | "update";
  /** Reuse a caller's ledger, so one run reports the whole change
   *  together. A fresh one is made when absent. */
  ledger?: FeatureLedger;
  dryRun?: boolean;
  force?: boolean;
  log?: (message: string) => void;
  /** Restrict the run to these modules. Absent means all of them. */
  only?: readonly OperationalModuleId[];
}

/**
 * Run every operational module against one project.
 *
 * A module that does not apply is a `skipped` outcome with a reason,
 * never an exception — "this project has no browser half" is
 * information, not a failure. Anything else propagates: a half-written
 * deploy workflow is worse than a loud failure, and `create` already
 * has a rollback ledger for the rest.
 */
export function applyOperationalLayer(args: ApplyOperationalLayerArgs): OperationalLayerResult {
  const ledger = args.ledger ?? new FeatureLedger(args.projectDir, args.dryRun === true);
  const log = args.log ?? ((): void => undefined);
  const selected = args.only
    ? OPERATIONAL_MODULES.filter((m) => args.only?.includes(m.id))
    : OPERATIONAL_MODULES;

  const modules: OperationalModuleOutcome[] = [];
  for (const module of selected) {
    ledger.scopeTo(module.id);
    modules.push({
      id: module.id,
      label: module.label,
      outcome: module.apply({
        projectDir: args.projectDir,
        project: args.project,
        identifiers: args.identifiers,
        mode: args.mode,
        ledger,
        log,
        force: args.force,
      }),
    });
  }
  ledger.scopeTo(undefined);

  const seen = new Set<string>();
  const manualSteps: string[] = [];
  for (const m of modules) {
    for (const note of m.outcome.notes) {
      if (seen.has(note)) continue;
      seen.add(note);
      manualSteps.push(note);
    }
  }

  return { ledger, modules, manualSteps };
}

/** Build an {@link OperationalProject} from a manifest.
 *
 *  Both optional fields fall back the way every other reader in the CLI
 *  falls back: absent `topology` means `single-origin` (every manifest
 *  written before the field came from a run that produced exactly that
 *  shape) and absent `surfaces` means `fullstack`. `isTopology` guards a
 *  hand-edited manifest carrying a value the type no longer has. */
export function operationalProjectFromManifest(
  manifest: ProjectManifest,
  repoSlug?: string,
): OperationalProject {
  return {
    name: manifest.name,
    domain: manifest.domain,
    aliases: manifest.aliases,
    topology: isTopology(manifest.topology) ? manifest.topology : "single-origin",
    surfaces: (manifest.surfaces ?? "fullstack") as Surface,
    features: manifest.features,
    repoSlug,
  };
}

/**
 * Render the run for the terminal, from the ledger rather than from a
 * parallel list the modules maintain by hand.
 *
 * `would-write` and `would-remove` carry the same information as their
 * real counterparts, so this one code path renders a dry run and a real
 * one — which is the property that stopped the two from drifting.
 */
export function renderOperationalLayer(result: OperationalLayerResult): string[] {
  const lines: string[] = [];
  const byModule = new Map<string, string[]>();
  for (const entry of result.ledger.entries) {
    if (entry.action === "unchanged" || entry.action === "absent") continue;
    const key = String(entry.feature ?? "");
    const list = byModule.get(key) ?? [];
    list.push(`  ${entry.action} ${entry.file}${entry.detail ? ` — ${entry.detail}` : ""}`);
    byModule.set(key, list);
  }

  for (const m of result.modules) {
    const written = byModule.get(m.id) ?? [];
    if (m.outcome.skipped !== undefined) {
      lines.push(`${m.label}: skipped — ${m.outcome.skipped}`);
      continue;
    }
    if (written.length === 0) {
      lines.push(`${m.label}: already up to date`);
      continue;
    }
    lines.push(`${m.label}:`);
    lines.push(...written);
  }

  const conflicts = result.ledger.conflicts();
  if (conflicts.length > 0) {
    lines.push("not applied — these differ from what hatchkit would write:");
    for (const c of conflicts) {
      lines.push(`  ${c.file}${c.detail ? ` — ${c.detail}` : ""}`);
    }
  }
  return lines;
}
