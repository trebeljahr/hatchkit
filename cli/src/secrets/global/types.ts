/*
 * cli/src/secrets/global/types.ts — contract for GLOBAL credentials.
 *
 * A per-project `ProviderRotator` owns one credential in one project. A
 * global credential is one upstream secret that hatchkit copies into
 * many places: the SES IAM key behind every project's SES_SMTP_* pair,
 * the ListMonk API user behind every LISTMONK_API_TOKEN. Rotating one
 * means minting once and then updating every consumer: local projects'
 * env files, Coolify apps that carry the value as an env var, and
 * services configured through an API (ListMonk's own SMTP settings).
 *
 * Same redaction rule as the per-project flow: values travel rotator →
 * keychain / env writer / Coolify, never into an audit or a log line.
 */

import type { NewCred, OldCred, RevokePolicy, VerifyOutcome } from "../types.js";

export type GlobalCredentialName = "ses" | "listmonk";

/** Env names that carry each global credential in a consumer. Also used
 *  by the per-project run to tell the operator which shared credentials
 *  a project holds. */
export const SHARED_CREDENTIAL_KEYS: Readonly<Record<GlobalCredentialName, readonly string[]>> = {
  ses: ["SES_SMTP_USERNAME", "SES_SMTP_PASSWORD"],
  listmonk: ["LISTMONK_API_TOKEN"],
};

export interface GlobalRotationContext {
  readonly dryRun: boolean;
  readonly revokePolicy: RevokePolicy;
  /** Prompts allowed (stdin is a TTY and the run is not `--json`). */
  readonly interactive: boolean;
  /** `--resume`: the OLD credential from the rollback blob. Set only
   *  when finishing an interrupted rotation, where the keychain already
   *  holds the new credential. */
  readonly resumeOld?: OldCred;
  /** Adapter-private state across phases. The orchestrator never reads it. */
  scratch: Record<string, unknown>;
}

/** What a rotator reports about its own auth before anything mutates. */
export interface GlobalPreflight {
  /** False when the rotator cannot mint or revoke with what it has. */
  ready: boolean;
  /** One line per fact the operator should see in the plan. */
  notes: string[];
  /** Exact steps to make `ready` true. Printed when it is false. */
  remedy?: string[];
}

export interface GlobalRotator {
  readonly name: GlobalCredentialName;
  readonly label: string;
  /** Env names each consumer holds for this credential. The rotated
   *  values come from `NewCred.values` under the same names. */
  readonly consumerKeys: readonly string[];
  /** The env name whose CURRENT value identifies a copy of the old
   *  credential. A local consumer is rewritten only when its value
   *  equals the old one, so a project wired to a different account is
   *  left alone. */
  readonly matchKey: string;
  /** Consequences and constraints to show in the plan. */
  planNotes(ctx: GlobalRotationContext): string[];
  /** Resolve the credentials needed to mint and revoke. May prompt for a
   *  one-off admin credential (never stored) when interactive. */
  preflight(ctx: GlobalRotationContext): Promise<GlobalPreflight>;
  /** The current credential, keyed by consumer env name for matching,
   *  plus whatever `revoke` and a rollback need. */
  captureOld(ctx: GlobalRotationContext): Promise<OldCred>;
  createNew(ctx: GlobalRotationContext): Promise<NewCred>;
  verify(ctx: GlobalRotationContext, fresh: NewCred): Promise<VerifyOutcome>;
  /** Remove a fresh credential that failed verify, so no orphan is left
   *  (IAM allows two keys per user; a stray one blocks the next run). */
  discard(ctx: GlobalRotationContext, fresh: NewCred): Promise<void>;
  /** Persist the new credential where hatchkit reads it (keychain,
   *  config meta). Runs right after verify: the secret exists only in
   *  memory until then. */
  commit(ctx: GlobalRotationContext, fresh: NewCred): Promise<void>;
  /** Rebuild the NEW credential from where `commit` put it. Used by
   *  `--resume` after an interrupted fan-out. `newHandle` is what the
   *  rollback blob recorded under `new.*`. */
  loadCommitted(ctx: GlobalRotationContext, newHandle: Record<string, string>): Promise<NewCred>;
  /** Consumers configured through an API rather than an env var
   *  (ListMonk's SMTP settings). */
  updateServices?(
    ctx: GlobalRotationContext,
    old: OldCred,
    fresh: NewCred,
  ): Promise<ConsumerAuditEntry[]>;
  /** Describe `updateServices` for the plan without mutating. */
  planServices?(ctx: GlobalRotationContext): Promise<ConsumerAuditEntry[]>;
  revoke(ctx: GlobalRotationContext, old: OldCred, fresh: NewCred): Promise<void>;
  /** After a successful run: cleanup such as offering to delete a
   *  one-off admin user. Returns lines for `nextSteps`. */
  finish?(ctx: GlobalRotationContext): Promise<string[]>;
}

export type ConsumerStatus = "planned" | "updated" | "unchanged" | "skipped" | "failed";

export interface ConsumerAuditEntry {
  kind: "project" | "coolify-app" | "service";
  /** Project slug, Coolify app name, or service label. */
  name: string;
  /** Project directory, for `kind: 'project'`. */
  location?: string;
  /** Env names written (or to be written). Names only. */
  keys: string[];
  /** Env files written, relative to `location`. */
  files?: string[];
  /** Deploy targets updated for a project (keys that already existed). */
  targets?: string[];
  status: ConsumerStatus;
  /** Why it was skipped / failed / left unchanged. Value-free. */
  reason?: string;
}

export type GlobalRotationOutcome =
  /** Dry run: the plan only. */
  | "planned"
  /** Preflight said the rotation cannot run (missing rights, config). */
  | "blocked"
  /** The operator declined at the confirmation prompt. */
  | "cancelled"
  /** The new credential failed verify and was deleted again. */
  | "verify-failed"
  /** New credential live, but a consumer failed or revoke was held or
   *  failed. `--resume` finishes it. */
  | "partial"
  | "done";

export interface GlobalRotationAudit {
  credential: GlobalCredentialName;
  outcome: GlobalRotationOutcome;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  resumed: boolean;
  verificationResult: VerifyOutcome;
  oldRevoked: boolean | "held";
  consumers: ConsumerAuditEntry[];
  notes: string[];
  nextSteps: string[];
}
