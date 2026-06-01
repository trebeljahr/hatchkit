/*
 * cli/src/secrets/orchestrator.ts — `runSecretsRotate` entry point.
 *
 * The orchestrator is the ONLY place that touches: dotenvx (via
 * env-writer), Coolify, GitHub Actions, the keychain (other than
 * adapter handle saves through rollback-store), the audit emitter,
 * and the safety guards. Adapters touch only upstream provider APIs.
 * That separation is what lets a new adapter be a drop-in file.
 *
 * Two-phase per-adapter pipeline:
 *
 *   captureOld → saveRollback → createNew → write envs → push targets
 *   → verify   → (if ok && policy=after-verify) revoke
 *
 * On verify-failed, the old credential stays live and the rollback
 * blob stays in the keychain so the operator can `hatchkit secrets
 * rollback`. Emergency `--revoke=immediate` flips revoke BEFORE
 * verify for leak-race scenarios.
 */

import { readManifest } from "../scaffold/manifest.js";
import type { ProjectManifest } from "../scaffold/manifest.js";
import type { EnvPair } from "../provision/write-env.js";
import { buildAudit, printAudit, redactErrorMessage } from "./audit.js";
import {
  assertEnvKeysNotTracked,
  resolveDevEnvPath,
  resolveProdEnvPath,
  scanEnvVarNames,
  setDevPairs,
  setProdPairs,
  warnIfNotEncrypted,
} from "./env-writer.js";
import { type PushPair, type PushResult, detectRepoSlug, push } from "./push.js";
import { all as listAdapters } from "./registry.js";
import { clearRollback, saveRollback } from "./rollback-store.js";
import type {
  AdapterAuditEntry,
  DeployTarget,
  NewCred,
  OldCred,
  ProviderRotator,
  RevokePolicy,
  RotationAudit,
  RotationContext,
  RotationSkipReason,
  VerifyOutcome,
} from "./types.js";

import "./adapters/index.js";

export interface RunSecretsRotateOptions {
  /** Project slug. Used for keychain accounts, Coolify app lookup,
   *  and the audit's `project` field. Must match `manifest.name`. */
  projectName: string;
  /** Absolute path to the project root. Defaults to `process.cwd()`. */
  projectDir?: string;
  /** Plan-only mode: no upstream mutations, no env writes, no pushes.
   *  The audit shape is still populated from each adapter's
   *  `envKeys()` declaration so JSON consumers see the plan. */
  dryRun?: boolean;
  /** When true, no deploy-target push happens (overrides pushTargets).
   *  Equivalent to passing `pushTargets: []`. */
  noPush?: boolean;
  /** Subset of deploy targets to push to. Defaults to
   *  `['coolify', 'gh']`; the orchestrator silently filters to
   *  whatever's actually configured + detected. */
  pushTargets?: DeployTarget[];
  /** When the OLD credential should be revoked. See `RevokePolicy`. */
  revokePolicy?: RevokePolicy;
  /** Adapter-name filter. When non-empty, only adapters whose `name`
   *  appears here will be considered. Unknown names are ignored
   *  silently (the CLI surface should validate against
   *  `registry.list().map(a => a.name)` before calling). */
  only?: string[];
  /** Emit the audit as one JSON line on stdout instead of human text. */
  json?: boolean;
  /** Override the auto-detected `<owner>/<repo>` for GH Actions pushes. */
  ghRepo?: string;
  /** Override the Coolify app name (otherwise the candidate-walker
   *  in `push.ts` tries `<p>`, `<p>-web`, `<p>-server`, `<p>-client`). */
  coolifyAppName?: string;
}

/** Top-level entry. Returns the same audit it printed. */
export async function runSecretsRotate(
  opts: RunSecretsRotateOptions,
): Promise<RotationAudit> {
  const projectDir = opts.projectDir ?? process.cwd();
  const startedAt = new Date().toISOString();

  // ── Phase 0: pre-flight guards (no adapter calls yet) ──
  const manifest = assertManifest(projectDir);
  await assertEnvKeysNotTracked(projectDir);
  warnIfNotEncrypted(safeResolveProdPath(projectDir));

  // ── Phase 0.5: build the shared RotationContext base ──
  const envPresence = scanEnvVarNames(projectDir);
  const pushTargets: ReadonlyArray<DeployTarget> = opts.noPush
    ? []
    : (opts.pushTargets ?? ["coolify", "gh"]);
  const revokePolicy: RevokePolicy = opts.revokePolicy ?? "after-verify";

  const ctxBase = {
    projectName: opts.projectName,
    projectDir,
    manifest,
    envPresence,
    dryRun: !!opts.dryRun,
    pushTargets,
    revokePolicy,
  };

  // ── Phase 1: select adapters ──
  let adapters = listAdapters();
  if (opts.only && opts.only.length > 0) {
    const allow = new Set(opts.only);
    adapters = adapters.filter((a) => allow.has(a.name));
  }

  const auditEntries: AdapterAuditEntry[] = [];

  // Auto-detect the GH repo slug once so each adapter doesn't
  // re-shell `git remote get-url origin`. Falls back to undefined
  // when no GH remote exists; `push.ts` handles that as a skip.
  const ghRepoSlug =
    opts.ghRepo ?? (pushTargets.includes("gh") ? await detectRepoSlug(projectDir) : undefined);

  // ── Phase 2: per-adapter two-phase rotation ──
  for (const adapter of adapters) {
    const ctx: RotationContext = { ...ctxBase, scratch: {} };

    if (!adapter.detect(ctx)) {
      auditEntries.push({
        provider: adapter.name,
        envKeysChanged: [],
        deployTargetsUpdated: [],
        verificationResult: "skipped",
        oldRevoked: "held",
        skipReason: "adapter-not-detected",
      });
      continue;
    }

    const specs = adapter.envKeys(ctx);

    if (ctx.dryRun) {
      auditEntries.push({
        provider: adapter.name,
        envKeysChanged: specs.map((s) => s.name),
        deployTargetsUpdated: [...ctx.pushTargets],
        verificationResult: "skipped",
        oldRevoked: "held",
      });
      continue;
    }

    auditEntries.push(
      await rotateOneAdapter(adapter, ctx, {
        ghRepoSlug,
        coolifyAppName: opts.coolifyAppName,
      }),
    );
  }

  const audit: RotationAudit = {
    project: opts.projectName,
    projectDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    adapters: auditEntries,
  };

  const built = buildAudit(audit);
  printAudit(built, { json: !!opts.json });
  return built;
}

/** Run the full two-phase pipeline for one adapter. Pure orchestration —
 *  the adapter is asked for createNew/verify/revoke and the
 *  orchestrator owns disk writes, deploy pushes, and rollback bookkeeping.
 *
 *  Any exception from an adapter call (captureOld/createNew/revoke) is
 *  wrapped (value-redacted) and re-thrown UP THE STACK — the caller's
 *  loop stops, but other adapters that ran earlier keep their audit
 *  entries. A thrown `push()` (Coolify 5xx, `gh` auth expired, network)
 *  is CAUGHT locally: the env file stays written, revoke is
 *  force-skipped (deploy targets still hold the OLD value), and the
 *  audit reports `skipReason: 'push-failed'` with a redacted
 *  `pushError` so each adapter's outcome reaches the operator. The
 *  rollback blob is preserved on every failure path so the operator
 *  can recover. */
async function rotateOneAdapter(
  adapter: ProviderRotator,
  ctx: RotationContext,
  options: { ghRepoSlug: string | undefined; coolifyAppName: string | undefined },
): Promise<AdapterAuditEntry> {
  const specs = adapter.envKeys(ctx);

  // Capture OLD credential and stash in the keychain BEFORE any
  // mutation. captureOld can return empty values when truly
  // unrecoverable — we downgrade revoke policy for that adapter
  // below.
  let oldCred: OldCred;
  try {
    oldCred = await adapter.captureOld(ctx);
  } catch (err) {
    throw wrapAdapterError(adapter.name, "captureOld", err);
  }
  await saveRollback(ctx.projectName, adapter.name, oldCred);

  // Adapters that can't recover the old credential MUST NOT be
  // told to revoke — `after-verify` silently downgrades to `held`
  // for that adapter. Audit picks this up via `revoke-held` skipReason.
  // `let` (not `const`) because a thrown push() further downgrades
  // this to `'never'` so the OLD credential stays live for the deploy
  // targets that didn't receive the new value.
  let effectivePolicy: RevokePolicy =
    Object.keys(oldCred.values).length === 0 && Object.keys(oldCred.handle).length === 0
      ? "never"
      : ctx.revokePolicy;

  // === Two-phase step 1: createNew + persist + push ===
  let newCred: NewCred;
  try {
    newCred = await adapter.createNew(ctx);
  } catch (err) {
    throw wrapAdapterError(adapter.name, "createNew", err);
  }

  const prodPairs: EnvPair[] = [];
  const devPairs: EnvPair[] = [];
  for (const spec of specs) {
    const value = newCred.values[spec.name];
    if (value === undefined) continue;
    if (spec.scope === "production" || spec.scope === "both") {
      prodPairs.push({ key: spec.name, value });
    }
    if (spec.scope === "development" || spec.scope === "both") {
      devPairs.push({ key: spec.name, value });
    }
  }

  const writtenKeys = new Set<string>();
  if (prodPairs.length > 0) {
    const path = resolveProdEnvPath(ctx.projectDir);
    for (const k of setProdPairs(path, prodPairs)) writtenKeys.add(k);
  }
  if (devPairs.length > 0) {
    const path = resolveDevEnvPath(ctx.projectDir);
    for (const k of setDevPairs(path, devPairs)) writtenKeys.add(k);
  }

  // Push only production-scope values to deploy targets. Coolify
  // and GH Actions are production-only surfaces in hatchkit's model.
  const pushPairs: PushPair[] = prodPairs.map((p) => ({ key: p.key, value: p.value }));
  let pushResults: PushResult[] = [];
  // When push() throws (Coolify 5xx, gh auth expired, network), the
  // env file is already on disk (the in-disk new value is good) but
  // the deploy targets still hold the OLD credential. Record the
  // failure and continue to verify+revoke against local state — the
  // operator gets per-adapter audit visibility instead of losing every
  // earlier adapter's entry to a bubbled exception.
  let pushError: string | undefined;
  if (ctx.pushTargets.length > 0 && pushPairs.length > 0) {
    try {
      pushResults = await push(ctx.pushTargets, ctx.projectName, pushPairs, {
        ghRepoSlug: options.ghRepoSlug,
        coolifyAppName: options.coolifyAppName,
        cwd: ctx.projectDir,
      });
    } catch (err) {
      pushError = redactErrorMessage(err instanceof Error ? err.message : String(err));
      console.error(`  · ${adapter.name} push failed: ${pushError}`);
      // Force-hold the OLD credential: deploy targets are still
      // pointing at it, so revoking would break production until
      // the operator pushes the new value manually.
      effectivePolicy = "never";
    }
  }

  const deployTargetsUpdated: DeployTarget[] = [];
  let firstPushSkipReason: RotationSkipReason | undefined;
  for (const r of pushResults) {
    if (r.pushed.length > 0) {
      deployTargetsUpdated.push(r.target);
    } else if (r.skipReason && !firstPushSkipReason) {
      firstPushSkipReason = r.skipReason;
    }
  }

  // === Two-phase step 2: verify (+ revoke depending on policy) ===
  let verifyOutcome: VerifyOutcome;
  let oldRevoked: boolean | "held" = "held";

  if (effectivePolicy === "immediate") {
    // Emergency: revoke first, verify second. Used when the user is
    // racing a leak — they accept the risk of a verify-failed state
    // where neither old nor new credential works rather than leave
    // the old key live for the duration of the verify probe.
    try {
      await adapter.revoke(ctx, oldCred);
      oldRevoked = true;
    } catch (err) {
      // Don't throw — operator may still want to know the verify
      // outcome and revoke manually. Wrap-and-log via the audit
      // shape (`oldRevoked: false`).
      console.error(
        `  · ${adapter.name} revoke failed (--revoke=immediate): ${redactErrorMessage((err as Error).message)}`,
      );
      oldRevoked = false;
    }
    verifyOutcome = await runVerify(adapter, ctx, newCred);
  } else {
    verifyOutcome = await runVerify(adapter, ctx, newCred);
    if (verifyOutcome === "ok" && effectivePolicy === "after-verify") {
      try {
        await adapter.revoke(ctx, oldCred);
        oldRevoked = true;
      } catch (err) {
        console.error(
          `  · ${adapter.name} revoke failed: ${redactErrorMessage((err as Error).message)}`,
        );
        oldRevoked = false;
      }
    }
    // verify === 'failed' OR effectivePolicy === 'never' → oldRevoked stays 'held'
  }

  // Clear rollback only on full success — on verify-failed leave the
  // blob in the keychain so the operator can run `secrets rollback`.
  if (verifyOutcome === "ok" && oldRevoked === true) {
    await clearRollback(ctx.projectName, adapter.name);
  }

  // Compose the skipReason. Precedence (most → least important):
  //   verify-failed   → new credential itself doesn't work
  //   push-failed     → env+upstream good, deploy targets behind
  //   revoke-held     → captureOld empty (downgrade) or --revoke=never
  //   <push skip>     → graceful (no-coolify-config, no-git-remote, …)
  // Adapter-not-detected was handled before we got here.
  let skipReason: RotationSkipReason | undefined;
  if (verifyOutcome === "failed") {
    skipReason = "verify-failed";
  } else if (pushError) {
    skipReason = "push-failed";
  } else if (effectivePolicy === "never" && ctx.revokePolicy !== "never") {
    // Downgraded from `after-verify` to `never` because captureOld
    // returned empty — still report as revoke-held so the operator
    // sees that the old credential wasn't touched.
    skipReason = "revoke-held";
  } else if (ctx.revokePolicy === "never") {
    skipReason = "revoke-held";
  } else if (firstPushSkipReason) {
    skipReason = firstPushSkipReason;
  }

  return {
    provider: adapter.name,
    envKeysChanged: [...writtenKeys],
    deployTargetsUpdated,
    verificationResult: verifyOutcome,
    oldRevoked,
    skipReason,
    ...(pushError ? { pushError } : {}),
  };
}

async function runVerify(
  adapter: ProviderRotator,
  ctx: RotationContext,
  fresh: NewCred,
): Promise<VerifyOutcome> {
  try {
    return await adapter.verify(ctx, fresh);
  } catch (err) {
    console.error(
      `  · ${adapter.name} verify threw: ${redactErrorMessage((err as Error).message)}`,
    );
    return "failed";
  }
}

/** REFUSE-level guard. Throws if `.hatchkit.json` is absent or
 *  unparseable. Secrets rotate needs a project identity to look up
 *  keychain accounts, Coolify app candidates, and run-ledger entries
 *  — fail fast with a recovery hint. */
export function assertManifest(projectDir: string): ProjectManifest {
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json at ${projectDir}. \`hatchkit secrets rotate\` requires a project manifest. Run \`hatchkit adopt\` first to bring this repo under hatchkit conventions.`,
    );
  }
  return manifest;
}

function safeResolveProdPath(projectDir: string): string | undefined {
  try {
    return resolveProdEnvPath(projectDir);
  } catch {
    return undefined;
  }
}

/** Build an Error whose message is value-redacted, so any
 *  accidentally-included credential value in an adapter throw doesn't
 *  reach stderr. Preserves the original `cause` so the underlying
 *  stack is still attachable if a higher-level handler wants it. */
function wrapAdapterError(adapterName: string, phase: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const safe = redactErrorMessage(message);
  const wrapped = new Error(`adapter[${adapterName}].${phase} failed: ${safe}`);
  if (err instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = err;
  }
  return wrapped;
}
