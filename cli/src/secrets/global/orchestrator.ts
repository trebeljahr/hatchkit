/*
 * cli/src/secrets/global/orchestrator.ts — `hatchkit secrets rotate
 * --global <ses|listmonk>`.
 *
 *   preflight (auth; may prompt for a one-off admin credential)
 *   → captureOld → discover consumers (read-only) → plan / confirm
 *   → saveRollback → createNew → verify ─ failed → discard, stop
 *   → commit (keychain) → [immediate: revoke]
 *   → fan out: local projects, Coolify apps, services
 *   → [after-verify, no consumer failed: revoke] → clear rollback
 *
 * The new secret is persisted (commit) right after verify: until then
 * it exists only in memory, and SES / ListMonk show it exactly once.
 * The rollback blob (`secrets-rollback:@global:<name>`) keeps the old
 * credential plus the new one's ids, so `--resume` can finish an
 * interrupted fan-out and revoke later.
 *
 * `immediate` here means "revoke as soon as the new credential
 * verifies, before the fan-out" — the fan-out is the slow part.
 */

import chalk from "chalk";
import { redactErrorMessage, redactValues } from "../audit.js";
import { clearRollback, loadRollback, saveRollback } from "../rollback-store.js";
import type { DeployTarget, NewCred, OldCred, RevokePolicy, VerifyOutcome } from "../types.js";
import {
  type CoolifyDiscovery,
  type ProjectPlan,
  applyCoolifyApp,
  applyProject,
  defaultProjectRoots,
  discoverCoolifyApps,
  discoverProjects,
  planProject,
} from "./consumers.js";
import { listmonkRotator } from "./listmonk.js";
import { sesRotator } from "./ses.js";
import type {
  ConsumerAuditEntry,
  GlobalCredentialName,
  GlobalRotationAudit,
  GlobalRotationContext,
  GlobalRotator,
} from "./types.js";

export const GLOBAL_ROTATORS: Readonly<Record<GlobalCredentialName, GlobalRotator>> = {
  ses: sesRotator,
  listmonk: listmonkRotator,
};

/** Rollback-store "project" for global credentials. `@` cannot start a
 *  hatchkit project slug, so it never collides with one. */
export const GLOBAL_ROLLBACK_SCOPE = "@global";

export interface RunGlobalRotateOptions {
  credential: GlobalCredentialName;
  dryRun?: boolean;
  json?: boolean;
  revokePolicy?: RevokePolicy;
  /** Directories whose direct children are scanned for projects. */
  projectRoots?: string[];
  /** Project slugs or Coolify app names to leave alone. */
  exclude?: string[];
  /** Deploy targets to update: `coolify` (apps holding the key names)
   *  and `gh` (Actions secrets a consumer repo already holds). */
  pushTargets?: DeployTarget[];
  /** Operator states rotated dotenvx keypairs: lets undecidable key
   *  histories through (a proven leak still skips the project). */
  keysRotated?: boolean;
  /** Finish an interrupted rotation from its rollback blob. */
  resume?: boolean;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Prompts allowed. Defaults to stdin being a TTY and not `json`. */
  interactive?: boolean;
  /** Test seam: replace the rotator (same `name`). */
  rotator?: GlobalRotator;
}

export async function runGlobalRotate(opts: RunGlobalRotateOptions): Promise<GlobalRotationAudit> {
  const rotator = opts.rotator ?? GLOBAL_ROTATORS[opts.credential];
  const startedAt = new Date().toISOString();
  const revokePolicy = opts.revokePolicy ?? "after-verify";
  const pushTargets = opts.pushTargets ?? ["coolify", "gh"];
  const exclude = new Set(opts.exclude ?? []);
  const interactive = opts.interactive ?? (!!process.stdin.isTTY && !opts.json);
  const roots = opts.projectRoots && opts.projectRoots.length > 0 ? opts.projectRoots : defaultProjectRoots();

  let resumeOld: OldCred | undefined;
  let resumeNewHandle: Record<string, string> = {};
  if (!opts.resume && !opts.dryRun) {
    // A fresh run would overwrite the blob that remembers the ORIGINAL
    // credential, which then never gets revoked.
    const pending = await loadRollback(GLOBAL_ROLLBACK_SCOPE, rotator.name, { force: true });
    if (pending && Object.keys(pending.handle).some((k) => k.startsWith("new."))) {
      throw new Error(
        `An interrupted ${rotator.name} rotation from ${pending.timestamp} is not finished. Run \`hatchkit secrets rotate --global ${rotator.name} --resume\` first.`,
      );
    }
  }
  if (!opts.dryRun && !opts.yes && !interactive) {
    throw new Error(
      "A live --global rotation changes every consumer. Without a terminal to confirm in, pass --yes (check the plan with --dry-run first).",
    );
  }
  if (opts.resume) {
    const blob = await loadRollback(GLOBAL_ROLLBACK_SCOPE, rotator.name);
    if (!blob) {
      throw new Error(`No interrupted ${rotator.name} rotation to resume (no rollback blob in the keychain).`);
    }
    const oldHandle: Record<string, string> = {};
    for (const [k, v] of Object.entries(blob.handle)) {
      if (k.startsWith("new.")) resumeNewHandle[k.slice(4)] = v;
      else oldHandle[k] = v;
    }
    if (Object.keys(resumeNewHandle).length === 0) {
      throw new Error(
        `The ${rotator.name} rollback blob records no new credential: the interrupted run stopped before verify. Nothing to resume; run the rotation again.`,
      );
    }
    resumeOld = { values: blob.values, handle: oldHandle };
  }

  const ctx: GlobalRotationContext = {
    dryRun: !!opts.dryRun,
    revokePolicy,
    interactive,
    ...(resumeOld ? { resumeOld } : {}),
    scratch: {},
  };

  const audit: GlobalRotationAudit = {
    credential: rotator.name,
    outcome: opts.dryRun ? "planned" : "done",
    startedAt,
    finishedAt: startedAt,
    dryRun: !!opts.dryRun,
    resumed: !!opts.resume,
    verificationResult: "skipped",
    oldRevoked: "held",
    consumers: [],
    notes: [...rotator.planNotes(ctx), `Project roots: ${roots.join(", ")}`],
    nextSteps: [],
  };

  // ── Auth + current credential ──
  const pre = await rotator.preflight(ctx);
  audit.notes.push(...pre.notes);
  const blocked = (remedy: string[] | undefined): GlobalRotationAudit => {
    if (!opts.dryRun) audit.outcome = "blocked";
    audit.nextSteps.push(...(remedy ?? []));
    return finish(audit, opts);
  };
  let old: OldCred;
  let fresh0: NewCred | undefined;
  try {
    old = resumeOld ?? (await rotator.captureOld(ctx));
    fresh0 = resumeOld ? await rotator.loadCommitted(ctx, resumeNewHandle) : undefined;
  } catch (err) {
    if (!pre.ready) return blocked(pre.remedy);
    throw err;
  }

  // ── Discover consumers (read-only) ──
  const projects = discoverProjects(roots).filter((p) => !exclude.has(p.name));
  const plans: ProjectPlan[] = [];
  for (const project of projects) {
    const plan = await planProject(project, rotator, old, {
      keysRotated: opts.keysRotated,
      freshMatchValue: fresh0?.values[rotator.matchKey],
    });
    if (plan) plans.push(plan);
  }
  let coolify: CoolifyDiscovery = { configured: false, apps: [] };
  if (pushTargets.includes("coolify")) {
    coolify = await discoverCoolifyApps(rotator.consumerKeys);
    coolify.apps = coolify.apps.filter((a) => !exclude.has(a.name));
    if (coolify.error) audit.notes.push(`Coolify app scan failed: ${coolify.error}`);
    else if (!coolify.configured) audit.notes.push("Coolify is not configured: no app scan.");
  }
  const services = rotator.planServices ? await rotator.planServices(ctx) : [];

  // Consumers that still hold the old credential but cannot be updated in
  // this run. Revoking would break them, so after-verify holds the revoke.
  const pending = plans.filter((p) => p.prodPending).map((p) => p.project.name);
  if (coolify.error) pending.push("Coolify apps (scan failed)");
  if (pending.length > 0 && revokePolicy === "after-verify") {
    audit.notes.push(
      `The old credential will be held for: ${pending.join(", ")}. They still hold it and are skipped. Fix them, then run \`hatchkit secrets rotate --global ${rotator.name} --resume\` to update them and revoke. --revoke-old=immediate revokes regardless and breaks them until then.`,
    );
  }

  const planned: ConsumerAuditEntry[] = [
    ...plans.map((p) => p.entry),
    ...coolify.apps.map(
      (a): ConsumerAuditEntry => ({ kind: "coolify-app", name: a.name, keys: a.keys, status: "planned" }),
    ),
    ...services,
  ];

  if (opts.dryRun || !pre.ready) {
    audit.consumers = planned;
    return pre.ready ? finish(audit, opts) : blocked(pre.remedy);
  }

  if (interactive && !opts.yes) {
    renderGlobalAuditHuman({ ...audit, consumers: planned, dryRun: true });
    const { confirm } = await import("@inquirer/prompts");
    const go = await confirm({
      message: `${opts.resume ? "Resume" : "Rotate"} the ${rotator.name} credential and update the consumers above?`,
      default: false,
    });
    if (!go) {
      audit.consumers = planned;
      audit.outcome = "cancelled";
      audit.notes.push("Cancelled at the confirmation prompt; nothing changed.");
      return finish(audit, opts);
    }
  }

  // ── Mint + verify + persist ──
  let fresh: NewCred;
  if (fresh0) {
    fresh = fresh0;
    audit.verificationResult = "ok";
  } else {
    await saveRollback(GLOBAL_ROLLBACK_SCOPE, rotator.name, old);
    try {
      fresh = await rotator.createNew(ctx);
    } catch (err) {
      await clearRollback(GLOBAL_ROLLBACK_SCOPE, rotator.name);
      throw new Error(`${rotator.name}: creating the new credential failed: ${redactErrorMessage((err as Error).message)}`);
    }
    audit.verificationResult = await safeVerify(rotator, ctx, fresh);
    if (audit.verificationResult !== "ok") {
      try {
        await rotator.discard(ctx, fresh);
        audit.notes.push("Verify failed: the new credential was deleted again. Nothing else changed.");
      } catch (err) {
        audit.notes.push(
          `Verify failed, and deleting the new credential failed too (${redactErrorMessage((err as Error).message)}). Remove it by hand.`,
        );
      }
      await clearRollback(GLOBAL_ROLLBACK_SCOPE, rotator.name);
      audit.outcome = "verify-failed";
      audit.consumers = planned.map((c) =>
        c.status === "planned" ? { ...c, status: "skipped" as const, reason: "verify failed" } : c,
      );
      return finish(audit, opts);
    }
    await rotator.commit(ctx, fresh);
    await saveRollback(GLOBAL_ROLLBACK_SCOPE, rotator.name, {
      values: old.values,
      handle: { ...old.handle, ...prefixKeys("new.", fresh.handle) },
    });
  }

  if (revokePolicy === "immediate") {
    audit.oldRevoked = await safeRevoke(rotator, ctx, old, fresh, audit);
  }

  // ── Fan out ──
  const results: ConsumerAuditEntry[] = [];
  for (const plan of plans) {
    if (plan.writeProd || plan.writeDev) {
      results.push(await applyProject(plan, rotator, fresh, { pushGh: pushTargets.includes("gh") }));
    } else {
      results.push(plan.entry);
    }
  }
  for (const app of coolify.apps) results.push(await applyCoolifyApp(app, fresh));
  if (rotator.updateServices) results.push(...(await rotator.updateServices(ctx, old, fresh)));
  audit.consumers = results;

  const failed = results.filter((r) => r.status === "failed");
  if (revokePolicy === "after-verify") {
    if (failed.length === 0 && pending.length === 0) {
      audit.oldRevoked = await safeRevoke(rotator, ctx, old, fresh, audit);
    } else {
      audit.notes.push(
        `Old credential held for: ${[...failed.map((f) => f.name), ...pending].join(", ")}. They still depend on it and would break if it were revoked.`,
      );
    }
  }

  if (audit.oldRevoked === true && failed.length === 0 && pending.length === 0) {
    await clearRollback(GLOBAL_ROLLBACK_SCOPE, rotator.name);
  } else {
    audit.outcome = "partial";
    const resume = `hatchkit secrets rotate --global ${rotator.name} --resume`;
    audit.nextSteps.push(
      failed.length > 0 || pending.length > 0 || audit.oldRevoked === false
        ? `Fix what failed or was skipped, then run \`${resume}\` to update the remaining consumers and revoke the old credential.`
        : `The old credential is still active (--revoke-old=${revokePolicy}). Once every consumer runs on the new one, run \`${resume}\` to revoke it.`,
    );
  }
  if (rotator.finish) audit.nextSteps.push(...(await rotator.finish(ctx)));
  audit.nextSteps.unshift(...consumerNextSteps(results));
  return finish(audit, opts);
}

async function safeVerify(
  rotator: GlobalRotator,
  ctx: GlobalRotationContext,
  fresh: NewCred,
): Promise<VerifyOutcome> {
  try {
    return await rotator.verify(ctx, fresh);
  } catch (err) {
    console.error(`  · ${rotator.name} verify threw: ${redactErrorMessage((err as Error).message)}`);
    return "failed";
  }
}

async function safeRevoke(
  rotator: GlobalRotator,
  ctx: GlobalRotationContext,
  old: OldCred,
  fresh: NewCred,
  audit: GlobalRotationAudit,
): Promise<boolean> {
  try {
    await rotator.revoke(ctx, old, fresh);
    return true;
  } catch (err) {
    audit.notes.push(`Revoking the old credential failed: ${redactErrorMessage((err as Error).message)}`);
    return false;
  }
}

function prefixKeys(prefix: string, rec: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[`${prefix}${k}`] = v;
  return out;
}

/** Commit-and-redeploy instructions for the consumers that changed.
 *  hatchkit never commits or pushes a consumer repo itself. */
function consumerNextSteps(results: ConsumerAuditEntry[]): string[] {
  const steps: string[] = [];
  for (const r of results) {
    if (r.status !== "updated") continue;
    if (r.kind === "project" && r.location) {
      const committed = (r.files ?? []).filter((f) => !f.endsWith(".env.development"));
      if (committed.length > 0) {
        steps.push(
          `Commit and push ${r.name}: git -C ${r.location} add ${committed.join(" ")} && git -C ${r.location} commit -m "chore: rotate shared credentials" (then push and let it redeploy).`,
        );
      }
    } else if (r.kind === "coolify-app") {
      steps.push(`Redeploy Coolify app ${r.name} so it reads the new env var.`);
    }
  }
  return steps;
}

function finish(audit: GlobalRotationAudit, opts: RunGlobalRotateOptions): GlobalRotationAudit {
  audit.finishedAt = new Date().toISOString();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(redactValues(audit))}\n`);
  } else {
    renderGlobalAuditHuman(audit);
  }
  return audit;
}

const STATUS_COLOR: Record<ConsumerAuditEntry["status"], (s: string) => string> = {
  planned: chalk.cyan,
  updated: chalk.green,
  unchanged: chalk.dim,
  skipped: chalk.yellow,
  failed: chalk.red,
};

export function renderGlobalAuditHuman(audit: GlobalRotationAudit): void {
  console.log("");
  console.log(
    chalk.bold(
      `  hatchkit secrets rotate --global ${audit.credential}${audit.dryRun ? chalk.yellow(" (plan)") : ""}${audit.resumed ? chalk.yellow(" (resume)") : ""}`,
    ),
  );
  for (const note of audit.notes) console.log(chalk.dim(`  · ${note}`));
  console.log("");
  if (audit.consumers.length === 0) {
    console.log(chalk.dim("  No consumers found."));
  }
  for (const c of audit.consumers) {
    const where = c.kind === "project" ? "project" : c.kind === "coolify-app" ? "coolify" : "service";
    const keys = c.keys.length > 0 ? c.keys.join(", ") : chalk.dim("(no keys)");
    console.log(`  ${STATUS_COLOR[c.status](c.status.padEnd(9))} ${chalk.dim(where.padEnd(8))} ${c.name}  ${keys}`);
    if (c.files?.length) console.log(chalk.dim(`              files: ${c.files.join(", ")}`));
    if (c.targets?.length) console.log(chalk.dim(`              deploy targets: ${c.targets.join(", ")}`));
    if (c.reason) console.log(chalk.dim(`              ${c.reason}`));
  }
  if (!audit.dryRun) {
    console.log("");
    const verify =
      audit.verificationResult === "ok" ? chalk.green("ok") : audit.verificationResult === "failed" ? chalk.red("failed") : chalk.dim("skipped");
    console.log(`  verify: ${verify}`);
    const revoke =
      audit.oldRevoked === true
        ? chalk.green("old credential revoked")
        : audit.oldRevoked === false
          ? chalk.red("revoke failed — the old credential may still work")
          : chalk.yellow("old credential held (rollback blob kept in the keychain)");
    console.log(`  revoke: ${revoke}`);
  }
  if (audit.nextSteps.length > 0) {
    console.log("");
    console.log(chalk.bold(audit.dryRun ? "  Before a live run:" : "  Next steps (hatchkit never pushes):"));
    for (const step of audit.nextSteps) console.log(`  ${step}`);
  }
  console.log("");
}
