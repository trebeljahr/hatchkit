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
  type EmailRoutingFacts,
  probeEmailRouting,
  summarizeEmailRoutingProbe,
} from "../email/routing-access.js";
import {
  type DeferredStep,
  deferralForStep,
  persistDeferredSteps,
} from "../provision/deferrals.js";
import { findManifestDirUpward, readManifest } from "../scaffold/manifest.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { validateDomain } from "../utils/validate.js";
import {
  type ConfiguredProviders,
  MIGRATION_PROVIDERS,
  type MigrationAction,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationPlanInput,
  type MigrationProvider,
  inferOldDomain,
  planDomainMigration,
  selectActions,
} from "./plan.js";
import { renderManualChecklist, renderMigrationPlan } from "./render.js";
import { type StepContext, type StepFollowUp, type StepOutcome, executorFor } from "./steps.js";

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

/** The credential readers `detectConfigured` consults, one per provider.
 *  Injectable so the failure-degradation behaviour can be unit-tested
 *  without a keychain that throws on demand; production uses the real
 *  `config.ts` getters. Return type is deliberately loose — the only
 *  thing the detector needs from a value is truthiness (and `apiToken`
 *  for DNS). */
export interface ProviderConfigReaders {
  dns: () => Promise<{ apiToken?: string } | null | undefined>;
  coolify: () => Promise<unknown>;
  ses: () => Promise<unknown>;
  listmonk: () => Promise<unknown>;
  r2: () => Promise<unknown>;
  plausible: () => Promise<unknown>;
  searchConsole: () => Promise<unknown>;
  stripe: () => Promise<unknown>;
}

const DEFAULT_PROVIDER_READERS: ProviderConfigReaders = {
  dns: getDnsConfig,
  coolify: getCoolifyConfig,
  ses: getSesConfig,
  listmonk: getListmonkConfig,
  r2: () => getS3Config("r2"),
  plausible: getPlausibleConfig,
  searchConsole: getGoogleSearchConsoleConfig,
  stripe: getStripeConfig,
};

/** Which global providers have credentials here. Read once, up front,
 *  so the plan can mark an unconfigured provider's step as `manual`
 *  instead of failing halfway through the run with a credential prompt
 *  the operator wasn't expecting.
 *
 *  Each read is independent and MUST NOT be allowed to abort the whole
 *  command. A single unreadable credential — a keychain item this `node`
 *  build can't read, a provider left half-configured — used to take the
 *  entire plan down before it ever printed, even for a client-only
 *  static project that touches none of these identities. So a failed
 *  read degrades to "not configured" (the planners then emit `manual`
 *  or `noop` from the manifest alone, which is exactly right for a
 *  provider the project doesn't use) and is surfaced as a dim warning so
 *  a provider that IS in use isn't silently mis-planned. */
export async function detectConfigured(
  readers: ProviderConfigReaders = DEFAULT_PROVIDER_READERS,
): Promise<ConfiguredProviders> {
  const warnings: string[] = [];
  const probe = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      warnings.push(
        `${name}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`,
      );
      return null;
    }
  };
  const [dns, coolify, ses, listmonk, r2, plausible, searchConsole, stripe] = await Promise.all([
    probe("dns", readers.dns),
    probe("coolify", readers.coolify),
    probe("ses", readers.ses),
    probe("listmonk", readers.listmonk),
    probe("r2", readers.r2),
    probe("plausible", readers.plausible),
    probe("search-console", readers.searchConsole),
    probe("stripe", readers.stripe),
  ]);
  if (warnings.length > 0) {
    console.log(
      chalk.dim("  Some provider credentials could not be read — treating them as not configured:"),
    );
    for (const w of warnings) console.log(chalk.dim(`    · ${w}`));
    console.log(chalk.dim("    (Set HATCHKIT_DEBUG=1 for the full stack.)"));
  }
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

/** Read (GET-only) Email Routing state for both sides so the plan can
 *  tell "already receiving" from "needs setup" from "token can't see
 *  it". Any failure degrades to `unknown` — the executor re-probes. */
async function probeEmailRoutingFacts(
  newDomain: string,
  oldDomain: string,
): Promise<MigrationPlanInput["emailRouting"]> {
  // A DNS credential that can't be read must not abort the plan any more
  // than a missing one does — degrade to "not read" and let the executor
  // re-probe at cutover.
  let dns: Awaited<ReturnType<typeof getDnsConfig>>;
  try {
    dns = await getDnsConfig();
  } catch {
    return undefined;
  }
  if (!dns?.apiToken) return undefined;
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
  const read = async (domain: string): Promise<EmailRoutingFacts> => {
    try {
      return summarizeEmailRoutingProbe(
        await probeEmailRouting(cf, domain, { accountId: dns.accountId }),
      );
    } catch (err) {
      return { state: "unknown", reason: (err as Error).message.split("\n")[0] };
    }
  };
  const [newFacts, oldFacts] = await Promise.all([read(newDomain), read(oldDomain)]);
  return { newDomain: newFacts, oldDomain: oldFacts };
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
    emailRouting: await probeEmailRoutingFacts(newDomain, inferred.domain),
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
  // Deferral keys a completed step settles: its own, and its follow-up
  // unless it left a new one.
  const resolved: string[] = [];

  for (const action of todo) {
    console.log(chalk.bold(`\n  ▸ ${action.provider} — ${action.summary}`));
    let outcome: StepOutcome;
    try {
      outcome = await executorFor(action.id)(ctx);
    } catch (err) {
      const reason = (err as Error).message.split("\n")[0];
      console.log(chalk.red(`    ✗ ${reason}`));
      // Errors that know their fix (a token missing scopes) carry it.
      const hint = (err as { hint?: unknown }).hint;
      const fix = Array.isArray(hint) ? (hint as string[]) : undefined;
      for (const line of fix ?? []) console.log(chalk.dim(`      ${line}`));
      deferred.push(deferralFor(action, plan, reason, fix));
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
    resolved.push(deferralKey(action));
    if (outcome.followUp) {
      console.log(chalk.yellow(`    ! ${outcome.followUp.reason}`));
      for (const c of outcome.followUp.commands) console.log(`      ${chalk.cyan(c)}`);
      deferred.push(followUpDeferral(action, plan, outcome.followUp));
    } else {
      resolved.push(followUpKey(action));
    }
  }

  // Anything that succeeded this run clears its own earlier deferral.
  persistDeferredSteps(projectDir, deferred, resolved);

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

function followUpKey(action: MigrationAction): string {
  return `${deferralKey(action)}:follow-up`;
}

/** A follow-up is recorded apart from the step's own deferral: the step
 *  went through, so re-running it is not the fix; `commands` are. A
 *  later run of the step that leaves no follow-up clears it. */
export function followUpDeferral(
  action: MigrationAction,
  plan: Pick<MigrationPlan, "oldDomain" | "newDomain">,
  followUp: StepFollowUp,
): DeferredStep {
  return deferralForStep({
    key: followUpKey(action),
    label: `migrate-domain / ${action.provider} (${action.phase}): manual follow-up`,
    kind: "failed",
    reason: followUp.reason,
    command: followUp.commands.join(" && "),
    hint: [
      `then re-run \`${migrateCommand(plan, action.phase, action.provider)}\` to check and clear this`,
    ],
  });
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

function deferralFor(
  action: MigrationAction,
  plan: MigrationPlan,
  reason: string,
  fix?: string[],
): DeferredStep {
  const hint = [...(action.gate ? [`waiting on: ${action.gate}`] : []), ...(fix ?? [])];
  return deferralForStep({
    key: deferralKey(action),
    label: `migrate-domain / ${action.provider} (${action.phase})`,
    kind: "failed",
    reason,
    command: migrateCommand(plan, action.phase, action.provider),
    hint: hint.length > 0 ? hint : undefined,
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
