/*
 * cli/src/secrets/types.ts — Provider rotation adapter contract.
 *
 * Every credential a hatchkit-managed project can rotate is modelled
 * as a `ProviderRotator`. Adapters live one-per-file under
 * `cli/src/secrets/adapters/<name>.ts` and self-register on import via
 * `register(adapter)` from `../registry.js`. The orchestrator iterates
 * the registry — adding a new provider is "drop a file, import it from
 * the barrel, done". No switch statements, no central manifest.
 *
 * IMPORTANT: never log or return a credential value from any of the
 * methods on this interface. The orchestrator inspects only the
 * `RotationAudit` shape (names + booleans + outcomes). Values flow
 * adapter → keychain/dotenvxSet/CoolifyApi/gh, never adapter →
 * orchestrator → stdout.
 */

import type { ProjectManifest } from "../scaffold/manifest.js";

/** The full set of push targets the orchestrator can fan a new
 *  credential out to. Mirrors the existing `KeysTarget` shape in
 *  `cli/src/deploy/keys.ts` so the two flows can share helpers. */
export type DeployTarget = "coolify" | "gh";

/** Three on-disk env-file scopes a rotation can write to. Adapters
 *  declare which scope a key belongs in via `EnvKeySpec.scope`. The
 *  orchestrator translates those into actual file paths via
 *  `provision/write-env.ts:resolveEnvTarget`. */
export type EnvScope = "production" | "development" | "both";

/** Reasons the orchestrator may skip a step. Mirrors the
 *  `SkipReason` union in `deploy/keys.ts` so audit consumers learn
 *  one vocabulary. */
export type RotationSkipReason =
  | "no-coolify-config"
  | "coolify-app-not-found"
  | "no-git-remote"
  | "no-push-flag"
  | "adapter-not-detected"
  | "verify-failed"
  | "revoke-held";

/** Outcome of the verification step. `'skipped'` means the adapter
 *  declined to verify (e.g. no upstream probe is feasible); the
 *  orchestrator still considers the rotation a success but never
 *  revokes the old credential. */
export type VerifyOutcome = "ok" | "failed" | "skipped";

/** When the old credential should be revoked. Defaults to
 *  `'after-verify'`. `'never'` is the safe-but-leaky option for
 *  audit replays; `'immediate'` is for emergency rotations where the
 *  user has already pulled the old key out of every system manually
 *  and just wants hatchkit to make it explicit. */
export type RevokePolicy = "after-verify" | "never" | "immediate";

/** A single env-var the adapter manages. Names only — the value is
 *  carried separately inside `NewCred` so it can be redacted from
 *  any structured output the orchestrator produces. */
export interface EnvKeySpec {
  /** Env-var name, e.g. `OPENPANEL_CLIENT_SECRET`. */
  name: string;
  /** Where this value lives on disk. */
  scope: EnvScope;
  /** Whether the value is a secret. Non-secret values (e.g. an
   *  `OPENPANEL_CLIENT_ID` paired with a new secret) may be logged
   *  in human output; secret values never are. */
  secret: boolean;
}

/** Context passed to every adapter method. Constructed once per
 *  rotation and reused across createNew/verify/revoke for one
 *  adapter so the adapter can stash adapter-private intermediate
 *  state (e.g. a CloudflareApi instance) on `scratch`. */
export interface RotationContext {
  /** Slug used for keychain account names, Coolify app lookup, etc.
   *  Matches `manifest.name`. */
  readonly projectName: string;
  /** Absolute path to the project root the user invoked `hatchkit
   *  secrets rotate` against. Resolved by the orchestrator before
   *  any adapter runs. */
  readonly projectDir: string;
  /** The migrated v3 manifest, read once at orchestrator entry via
   *  `readManifest(projectDir)`. Adapters MUST treat as readonly. */
  readonly manifest: ProjectManifest;
  /** Snapshot of relevant env-var names → presence (NOT values)
   *  scanned from every `.env.*` under projectDir. Adapters use
   *  this in `detect()` instead of re-reading files themselves. */
  readonly envPresence: ReadonlySet<string>;
  /** True when the user passed `--dry-run`. createNew/verify/revoke
   *  MUST short-circuit to a no-op return when set, but should still
   *  populate the audit shape so the user sees the plan. */
  readonly dryRun: boolean;
  /** Which deploy targets the user opted into (defaults to
   *  ['coolify','gh'] — the orchestrator silently filters to
   *  whatever's configured + detected). */
  readonly pushTargets: ReadonlyArray<DeployTarget>;
  /** Revoke policy from `--revoke=after-verify|never|immediate`. */
  readonly revokePolicy: RevokePolicy;
  /** Free-form scratchpad. Adapter writes during createNew, reads
   *  during verify/revoke. Orchestrator never inspects it. */
  scratch: Record<string, unknown>;
}

/** The new credential an adapter just minted. Values are typed as
 *  `string` (the only shape any push target understands) and
 *  carried by reference through the orchestrator — they are NEVER
 *  serialized into the audit or printed to any stream. */
export interface NewCred {
  /** Map of env-var name → new plaintext value. Becomes the input
   *  to `writeProdEnv` / `writeDevEnv` / `CoolifyApi.setAppEnv` /
   *  `gh secret set`. */
  readonly values: Readonly<Record<string, string>>;
  /** Adapter-private identifiers needed by `revoke` to delete the
   *  OLD credential (e.g. Stripe webhook endpoint id, R2 token id,
   *  OpenPanel client id). Persisted into the rollback store by
   *  the orchestrator so `--resume` works across crashes. */
  readonly handle: Readonly<Record<string, string>>;
}

/** The old credential captured BEFORE createNew runs. Stored in
 *  the rollback temp store so a failed rotation can be replayed
 *  in reverse. Same redaction rules apply: never log values. */
export interface OldCred {
  readonly values: Readonly<Record<string, string>>;
  readonly handle: Readonly<Record<string, string>>;
}

/** The shape every adapter exports. The barrel at
 *  `cli/src/secrets/adapters/index.ts` imports each file for its
 *  side effect (the `register(adapter)` call). */
export interface ProviderRotator {
  /** Stable slug used in CLI flags (`--only=openpanel`), audit
   *  records, and the rollback-store keychain account. Must be
   *  unique across the registry. Snake-case is fine; the
   *  orchestrator does not transform it. */
  readonly name: string;

  /** Human-readable label for log output. */
  readonly label: string;

  /** Return true when this adapter should run against the given
   *  project. Combines env-var presence (`ctx.envPresence`) with
   *  manifest hints (`ctx.manifest.integrations`, `manifest.ses`,
   *  `manifest.s3Buckets`, etc.) — the same fusion
   *  `servicesAlreadyAdded` in `cli/src/index.ts` already does.
   *  MUST be pure / read-only — no network, no disk writes. */
  detect(ctx: RotationContext): boolean;

  /** The env-var names this adapter owns. Returned upfront (before
   *  createNew) so dry-run can print them and so the orchestrator
   *  can collision-check against other adapters. Names only — the
   *  values flow through `NewCred.values`. */
  envKeys(ctx: RotationContext): ReadonlyArray<EnvKeySpec>;

  /** Read the CURRENT credential from wherever it actually lives
   *  (keychain account, .env.production via dotenvx decrypt, etc.)
   *  so the orchestrator can stash it in the rollback store BEFORE
   *  any mutation. Adapters that can't recover the old value
   *  (truly unrecoverable) return an empty `values` map — the
   *  orchestrator will refuse `--revoke=after-verify` for that
   *  adapter and force `--revoke=never` with a warning. */
  captureOld(ctx: RotationContext): Promise<OldCred>;

  /** Mint a fresh credential from the upstream provider. MUST be
   *  side-effect-only against the upstream API: do NOT write to
   *  disk, keychain, or deploy targets — the orchestrator owns
   *  those steps. Returning the value lets the orchestrator
   *  redact it consistently. */
  createNew(ctx: RotationContext): Promise<NewCred>;

  /** Smoke-test the NEW credential against the upstream provider.
   *  Implementation choice per adapter: e.g. fetch /me with the
   *  new token, sign a webhook with the new secret, list buckets
   *  with the new key. Return `'skipped'` when no cheap probe
   *  exists — the orchestrator will not revoke the old key in
   *  that case. */
  verify(ctx: RotationContext, fresh: NewCred): Promise<VerifyOutcome>;

  /** Revoke the OLD credential upstream. Must be idempotent: a
   *  404/already-deleted response is success. Throw only on
   *  genuine API failure that an operator should see. */
  revoke(ctx: RotationContext, old: OldCred): Promise<void>;
}

/** What the orchestrator emits per adapter in the final audit
 *  block. Matches the user-facing JSON shape described in
 *  `auditFormat`. Carries names + outcomes only — never values. */
export interface AdapterAuditEntry {
  provider: string;
  envKeysChanged: string[];
  deployTargetsUpdated: DeployTarget[];
  verificationResult: VerifyOutcome;
  /** `true` when revoke succeeded; `false` when not yet performed
   *  but expected to be; `'held'` when revoke was deliberately
   *  skipped (verify failed, `--revoke=never`, or the adapter
   *  reported it can't recover an old credential). */
  oldRevoked: boolean | "held";
  /** Populated when the orchestrator skipped a step entirely.
   *  See `RotationSkipReason` for the vocabulary. */
  skipReason?: RotationSkipReason;
}

/** Returned by `runSecretsRotate` for the whole command. The CLI
 *  serializes this directly under `--json`. */
export interface RotationAudit {
  project: string;
  projectDir: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  adapters: AdapterAuditEntry[];
}
