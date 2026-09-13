/*
 * `hatchkit migrate-domain` — move a live project from one domain to
 * another, provider identities included.
 *
 * ============================================================
 * WHY A NEW COMMAND AND NOT `rename-domain --live`
 * ============================================================
 *
 * `rename-domain` is a file rewriter with a documented promise: it
 * touches nothing live, so you can run it, read the git diff, and
 * decide. That promise is load-bearing. Hanging a `--live` flag off it
 * means one mistyped word turns a reviewable local edit into writes
 * against AWS, Cloudflare, Coolify, Google and Stripe, and it makes the
 * command's own help have to describe two unrelated things.
 *
 * The deeper reason is shape. `rename-domain` is one pass: compute
 * edits, confirm, write, done. A live migration is three passes
 * separated by waits nobody controls — the new SES identity is not
 * verified when you create it, and the new R2 certificate is not issued
 * when you attach it. That needs phases, gates, per-provider resume and
 * a plan table. None of it belongs bolted onto a file rewriter.
 *
 * So: a separate verb, which calls `rename-domain` as its first
 * prepare-phase step. The rewrite logic keeps exactly one home.
 *
 * ============================================================
 * SHAPE
 * ============================================================
 *
 *   hatchkit migrate-domain --to <new> --dry-run     # the whole plan
 *   hatchkit migrate-domain --to <new>               # prepare (default)
 *   hatchkit migrate-domain --to <new> --phase cutover
 *   hatchkit migrate-domain --to <new> --phase cleanup
 *   hatchkit migrate-domain --to <new> --only ses    # retry one provider
 *
 * Default phase is `prepare` because prepare is the only phase that
 * cannot break anything: everything it does is additive. Cutover and
 * cleanup have to be asked for by name.
 *
 * A failed or gated step is recorded in `.hatchkit.json` under
 * `deferred[]` with the exact command that retries it, using the same
 * mechanism `create` / `adopt` / `add` use — so `hatchkit status` says
 * "2 steps deferred" and each one names its own way home.
 */

import { resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import {
  getCoolifyConfig,
  getDnsConfig,
  getGoogleSearchConsoleConfig,
  getListmonkConfig,
  getPlausibleConfig,
  getS3Config,
  getSesConfig,
  getStripeConfig,
} from "../config.js";
import {
  type DeferredStep,
  deferralForStep,
  persistDeferredSteps,
} from "../provision/deferrals.js";
import { findManifestDirUpward, readManifest } from "../scaffold/manifest.js";
import { validateDomain } from "../utils/validate.js";
import {
  type ConfiguredProviders,
  MIGRATION_PROVIDERS,
  type MigrationAction,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationProvider,
  inferOldDomain,
  planDomainMigration,
  selectActions,
} from "./plan.js";
import { renderManualChecklist, renderMigrationPlan } from "./render.js";
import { type StepContext, type StepOutcome, executorFor } from "./steps.js";

export interface MigrateDomainOptions {
  projectDir: string;
  monorepoRoot: string;
  newDomain?: string;
  /** Override the inferred old domain. Needed only when a project's
   *  manifest and its provider identities have diverged in a way the
   *  inference can't untangle. */
  fromDomain?: string;
  phase?: MigrationPhase;
  only?: MigrationProvider;
  dryRun?: boolean;
  yes?: boolean;
}

/** Which global providers have credentials here. Read once, up front,
 *  so the plan can mark an unconfigured provider's step as `manual`
 *  instead of failing halfway through the run with a credential prompt
 *  the operator wasn't expecting. */
async function detectConfigured(): Promise<ConfiguredProviders> {
  const [dns, coolify, ses, listmonk, r2, plausible, searchConsole, stripe] = await Promise.all([
    getDnsConfig(),
    getCoolifyConfig(),
    getSesConfig(),
    getListmonkConfig(),
    getS3Config("r2"),
    getPlausibleConfig(),
    getGoogleSearchConsoleConfig(),
    getStripeConfig(),
  ]);
  return {
    files: true,
    dns: !!dns?.apiToken,
    coolify: !!coolify,
    ses: !!ses,
    listmonk: !!listmonk,
    r2: !!r2,
    plausible: !!plausible,
    "search-console": !!searchConsole,
    stripe: !!stripe,
  };
}

const PHASE_BLURB: Record<MigrationPhase, string> = {
  prepare:
    "Additive only. The old domain keeps working throughout; nothing here can take the project down.",
  cutover:
    "This is the moment traffic, mail and webhooks move. Each step re-checks its gate first and refuses rather than half-moving.",
  cleanup:
    "Destructive. Retires the old identities. Only run this once you have watched the new domain work.",
};

export async function runMigrateDomain(opts: MigrateDomainOptions): Promise<void> {
  const projectDir = findManifestDirUpward(opts.projectDir) ?? opts.projectDir;
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json found in ${opts.projectDir} (or any parent). Run migrate-domain from inside a hatchkit-managed project (or pass --dir <repo-root>).`,
    );
  }

  const newDomain = (
    opts.newDomain ??
    (await input({
      message: `Migrate ${chalk.cyan(manifest.name)} to which domain? (currently ${chalk.dim(manifest.domain)})`,
      validate: validateDomain,
    }))
  )
    .trim()
    .toLowerCase();
  const valid = validateDomain(newDomain);
  if (valid !== true) throw new Error(`--to invalid: ${valid}`);

  if (opts.fromDomain !== undefined) {
    const from = opts.fromDomain.trim().toLowerCase();
    const fromValid = validateDomain(from);
    if (fromValid !== true) throw new Error(`--from invalid: ${fromValid}`);
    if (from === newDomain) {
      throw new Error(
        `--from and --to are both ${newDomain} — --from names the domain you are leaving.`,
      );
    }
  }

  const inferred = opts.fromDomain
    ? { domain: opts.fromDomain.trim().toLowerCase(), source: "--from" }
    : inferOldDomain(manifest, newDomain);
  if (!inferred) {
    console.log(
      chalk.green(
        `\n  ${manifest.name} is already fully on ${newDomain} — manifest, SES identity and assets bucket all agree.`,
      ),
    );
    // After cutover nothing recorded names the old domain any more, so
    // it can't be inferred — but the old identities still exist until
    // cleanup retires them. Say how to get there instead of stopping.
    console.log(
      chalk.dim(
        `  Still to retire the old side? Name it: ${chalk.cyan(`hatchkit migrate-domain --to ${newDomain} --from <old-domain> --phase cleanup`)}\n`,
      ),
    );
    return;
  }

  const phase: MigrationPhase = opts.phase ?? "prepare";
  const configured = await detectConfigured();
  const plan = planDomainMigration({
    manifest,
    newDomain,
    oldDomain: inferred.domain,
    oldDomainSource: inferred.source,
    configured,
    // Cleanup actions are always planned so the table shows the whole
    // arc — what will eventually be retired is part of the blast radius
    // an operator needs to see before starting.
    includeCleanup: true,
  });

  console.log(renderMigrationPlan(plan));

  if (opts.dryRun) {
    console.log(chalk.yellow("  [dry-run] Nothing was written."));
    console.log(renderManualChecklist(plan));
    printNextCommand(plan, phase);
    return;
  }

  const todo = selectActions(plan, { phase, only: opts.only });
  if (todo.length === 0) {
    console.log(
      chalk.green(
        `  Nothing to do in the ${chalk.bold(phase)} phase${opts.only ? ` for ${opts.only}` : ""}.`,
      ),
    );
    printNextCommand(plan, phase);
    return;
  }

  console.log(chalk.bold(`  Running phase: ${phase}`));
  console.log(chalk.dim(`  ${PHASE_BLURB[phase]}`));
  console.log("");

  if (!opts.yes) {
    const ok = await confirm({
      message: `Execute ${todo.length} ${phase} step(s)?`,
      default: phase === "prepare",
    });
    if (!ok) {
      console.log(chalk.dim("  Cancelled — nothing was written."));
      return;
    }
  }

  const ctx: StepContext = {
    projectDir,
    monorepoRoot: opts.monorepoRoot,
    oldDomain: plan.oldDomain,
    newDomain: plan.newDomain,
  };

  const done: string[] = [];
  const deferred: DeferredStep[] = [];

  for (const action of todo) {
    console.log(chalk.bold(`\n  ▸ ${action.provider} — ${action.summary}`));
    let outcome: StepOutcome;
    try {
      outcome = await executorFor(action.id)(ctx);
    } catch (err) {
      const reason = (err as Error).message.split("\n")[0];
      console.log(chalk.red(`    ✗ ${reason}`));
      deferred.push(deferralFor(action, plan, reason));
      continue;
    }

    if (outcome.status === "gated") {
      console.log(chalk.yellow(`    · ${outcome.message}`));
      for (const d of outcome.detail ?? []) console.log(chalk.dim(`      ${d}`));
      // A gate is "not yet", not "broken" — but it is recorded as a
      // deferral all the same, because what an operator needs is a
      // durable note carrying the retry command, and `deferred[]` is
      // where the rest of hatchkit already looks for those.
      deferred.push(deferralFor(action, plan, outcome.message));
      continue;
    }

    const mark = outcome.status === "done" ? chalk.green("✓") : chalk.dim("·");
    console.log(`    ${mark} ${outcome.message}`);
    for (const d of outcome.detail ?? []) console.log(chalk.dim(`      ${d}`));
    done.push(`${action.provider}: ${outcome.message}`);
  }

  const failedKeys = new Set(deferred.map((d) => d.key));
  persistDeferredSteps(
    projectDir,
    deferred,
    // Anything that succeeded this run clears its own earlier deferral.
    todo
      .map(deferralKey)
      .filter((key) => !failedKeys.has(key)),
  );

  console.log("");
  console.log(chalk.bold("  ── Summary ──────────────────────────────────────────────"));
  console.log("");
  console.log(`  Completed: ${done.length > 0 ? chalk.green(done.length) : chalk.dim(0)}`);
  console.log(`  Deferred:  ${deferred.length > 0 ? chalk.yellow(deferred.length) : chalk.dim(0)}`);
  for (const step of deferred) {
    console.log(`    ${chalk.yellow("»")} ${step.label} ${chalk.dim(`— ${step.reason}`)}`);
    console.log(`      ${chalk.dim("→")} ${chalk.cyan(step.command)}`);
  }

  console.log(renderManualChecklist(plan));
  printNextCommand(plan, phase);
}

function deferralKey(action: MigrationAction): string {
  return `migrate:${action.id}`;
}

/** The command that runs `phase` of this migration again.
 *
 *  Always carries `--from`. The old domain is only inferable while some
 *  recorded field still names it; prepare moves `manifest.domain` and
 *  cutover moves the SES identity and assets URL, so by cleanup there
 *  is nothing left to infer from. A retry or next-phase command without
 *  `--from` would report "already fully migrated" and never reach the
 *  old identities it was printed to retire. */
export function migrateCommand(
  plan: Pick<MigrationPlan, "oldDomain" | "newDomain">,
  phase: MigrationPhase,
  only?: MigrationProvider,
): string {
  return [
    `hatchkit migrate-domain --to ${plan.newDomain} --from ${plan.oldDomain} --phase ${phase}`,
    only ? `--only ${only}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function deferralFor(action: MigrationAction, plan: MigrationPlan, reason: string): DeferredStep {
  return deferralForStep({
    key: deferralKey(action),
    label: `migrate-domain / ${action.provider} (${action.phase})`,
    kind: "failed",
    reason,
    command: migrateCommand(plan, action.phase, action.provider),
    hint: action.gate ? [`waiting on: ${action.gate}`] : undefined,
  });
}

function printNextCommand(plan: MigrationPlan, phase: MigrationPhase): void {
  const next: Partial<Record<MigrationPhase, string>> = {
    prepare: migrateCommand(plan, "cutover"),
    cutover: migrateCommand(plan, "cleanup"),
  };
  const cmd = next[phase];
  if (!cmd) return;
  console.log(chalk.dim(`  Next, once the ${phase} phase has settled:`));
  console.log(`    ${chalk.cyan(cmd)}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

const PHASES: MigrationPhase[] = ["prepare", "cutover", "cleanup"];

export async function runMigrateDomainCli(args: string[], monorepoRoot: string): Promise<void> {
  const flagValue = (name: string): string | undefined => {
    const i = args.findIndex((a) => a === `--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // Bare positional: not a flag, and not the VALUE of the flag before it.
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")),
  );

  const newDomain = flagValue("to") ?? positional[0];
  const dirArg = flagValue("dir");

  const phaseArg = flagValue("phase");
  if (phaseArg && !PHASES.includes(phaseArg as MigrationPhase)) {
    throw new Error(`--phase must be one of ${PHASES.join(" | ")} (got "${phaseArg}").`);
  }

  const onlyArg = flagValue("only");
  if (onlyArg && !MIGRATION_PROVIDERS.includes(onlyArg as MigrationProvider)) {
    throw new Error(`--only must be one of ${MIGRATION_PROVIDERS.join(" | ")} (got "${onlyArg}").`);
  }

  await runMigrateDomain({
    projectDir: dirArg ? resolve(dirArg) : resolve("."),
    monorepoRoot,
    newDomain,
    fromDomain: flagValue("from"),
    phase: phaseArg as MigrationPhase | undefined,
    only: onlyArg as MigrationProvider | undefined,
    dryRun: args.includes("--dry-run"),
    yes: args.includes("--yes") || args.includes("-y"),
  });
}
