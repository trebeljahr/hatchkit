/*
 * cli/src/features/signing/types.ts — Shared types for the signing feature.
 *
 * The signing feature templates the desktop+mobile signing pipelines that
 * already live in mesozoic-protocol's repo (build-windows.yml,
 * build-ios.yml, build-android.yml + native config edits + GitHub
 * secrets) into any Hatchkit-managed project. Tier model:
 *
 *   Tier 1 — per-org one-time setup (Apple Dev cert, Azure SP, Play SA)
 *            lives in {@link SigningOrgConfig}, written by
 *            `hatchkit signing org-init`. Hatchkit never tries to create
 *            these; it detects their absence and refuses to continue.
 *   Tier 2 — per-app, automated by Hatchkit:
 *              · Apple Bundle ID + App record + Provisioning Profile
 *              · Android upload keystore generation
 *              · 20 GitHub Actions secrets via `gh secret set`
 *              · workflow file copy + bundle-ID rewrite in native configs
 *            Identifiers (Bundle ID resource id, profile id, app record
 *            id) persist into {@link SigningProjectConfig} for
 *            idempotent re-runs.
 *   Tier 3 — stuck manual (vendor enforces UI step):
 *              · Apple identity validation, Play Console app creation,
 *                first AAB upload, store listing copy.
 *            Hatchkit writes a checklist to `.hatchkit/post-signing.md`
 *            and prints it at the end of the run.
 */

export type SigningPlatform = "windows" | "ios" | "android";

export type SigningMode = "create" | "adopt" | "add";

/** Persisted into the project manifest under `manifest.signing`. Holds
 *  identifiers + names only — NEVER plaintext secrets. Used by
 *  subsequent runs for GET-first ASC idempotency and by destroy. */
export interface SigningProjectConfig {
  enabled: boolean;
  bundleId: string;
  appName: string;
  /** kebab-case slug derived from project name. Used for the Android
   *  keystore filename and (default) Apple SKU. */
  appSlug: string;
  platforms: SigningPlatform[];
  /** Apple App Store Connect "SKU" — a unique-per-team string that
   *  identifies the App record. Defaults to {@link appSlug}. */
  appleSku?: string;
  /** Bundle ID resource id returned by ASC POST /v1/bundleIds. Used by
   *  later runs to GET before re-POSTing. */
  appleBundleIdResourceId?: string;
  /** App record id returned by ASC POST /v1/apps. */
  appleAppRecordId?: string;
  /** Provisioning profile id returned by ASC POST /v1/profiles. */
  appleProvisioningProfileId?: string;
  /** Provisioning profile "Name" field — must match exactly what
   *  PROVISIONING_PROFILE_SPECIFIER references in build-ios.yml. */
  appleProvisioningProfileName?: string;
  /** Reference to where the Android upload keystore is stored on the
   *  user's machine — used to refuse re-generation. Always a local
   *  path under `<projectDir>/.hatchkit/signing/`. Plaintext path —
   *  the keystore *file* never goes into Hatchkit config. */
  androidKeystoreLocalPath?: string;
  /** Reference to the GitHub Actions secret holding the base64
   *  keystore. Format: `github://<secret-name>`. */
  androidKeystoreSecretRef?: string;
}

export interface OrgApple {
  /** 10-char team identifier from developer.apple.com. */
  teamId: string;
  /** Absolute or `~`-prefixed path to the exported Apple Distribution
   *  .p12 file. Hatchkit reads it at runtime; the file never leaves the
   *  user's disk. */
  distributionP12Path: string;
  /** Keychain account name (under the "hatchkit" service) where the
   *  .p12 password is stored. Hatchkit will prompt + store on
   *  org-init. */
  distributionP12PasswordKeychainAccount: string;
  /** App Store Connect Key ID. Public-safe identifier. */
  apiKeyId: string;
  /** App Store Connect Issuer ID (UUID). Public-safe. */
  apiIssuerId: string;
  /** Path to the downloaded AuthKey_<KEY_ID>.p8 file. */
  apiKeyP8Path: string;
}

export interface OrgGoogle {
  /** Absolute / `~`-prefixed path to the Google Cloud service account
   *  JSON file. Used as `PLAY_SERVICE_ACCOUNT_JSON` raw at CI time. */
  serviceAccountJsonPath: string;
  /** Default package prefix used to suggest a Bundle ID
   *  (e.g. `com.mesozoicprotocol`). Optional. */
  packagePrefix?: string;
}

export interface OrgAzure {
  /** Azure AD tenant ID. */
  tenantId: string;
  /** Service principal app ID. */
  clientId: string;
  /** Keychain account name for the SP secret. */
  clientSecretKeychainAccount: string;
  /** Trusted Signing account name (Microsoft.CodeSigning resource). */
  trustedSigningAccount: string;
  /** Certificate profile name (Public Trust or Private Trust). */
  certificateProfile: string;
  /** Trusted Signing endpoint URL, e.g.
   *  `https://wus2.codesigning.azure.net`. */
  endpoint: string;
}

export interface SigningOrgConfig {
  apple?: OrgApple;
  google?: OrgGoogle;
  azure?: OrgAzure;
  /** Optional default GitHub org/user used as a fallback when the repo
   *  remote can't be inferred. */
  githubOrg?: string;
}

/** Subset of `RunLedger` the signing module needs. Decoupled from the
 *  full class so this types file doesn't drag the ledger module into
 *  every consumer; callers pass whatever ledger they have in scope. */
export interface SigningLedgerSink {
  record(step: SigningLedgerStep): void;
}

export type SigningLedgerStep =
  | { kind: "appleBundleId"; resourceId: string; identifier: string }
  | { kind: "appleAppRecord"; resourceId: string; bundleId: string }
  | { kind: "appleProvisioningProfile"; resourceId: string; name: string }
  | { kind: "androidKeystoreLocal"; path: string }
  | { kind: "ghSigningSecret"; repo: string; name: string }
  | { kind: "signingWorkflowFile"; path: string };

/** Input to {@link runSigningSetup}. */
export interface RunSigningSetupOptions {
  mode: SigningMode;
  projectDir: string;
  projectName: string;
  /** Explicit platform set. When omitted, the stepper asks (defaults
   *  derived from detection of src-tauri / ios / android dirs). */
  platforms?: SigningPlatform[];
  /** Skip signing entirely. Honored from the `--no-signing` CLI flag. */
  skip?: boolean;
  /** Don't write files or call GitHub / Apple / Azure / Play APIs.
   *  Stepper + preflight + plan only. */
  dryRun?: boolean;
  /** Pre-resolved bundle ID and app name — when set, the stepper
   *  skips those questions. Used by automation tests. */
  bundleId?: string;
  appName?: string;
  /** Pre-resolved GitHub repo slug, e.g. `owner/repo`. When unset,
   *  derived from the project's git remote. */
  ghRepoSlug?: string;
  /** Default pnpm + node versions written into workflow templates.
   *  Falls back to repo package.json `engines` when omitted. */
  pnpmVersion?: string;
  nodeVersion?: string;
  /** Optional ledger sink for rollback / destroy. When present, every
   *  successful Apple POST, keystore gen, GH secret push, and workflow
   *  file write is recorded so `hatchkit destroy <project>` can undo
   *  Hatchkit-created resources. */
  ledger?: SigningLedgerSink;
}

/** Returned by {@link runSigningSetup}. The CLI prints a human summary;
 *  callers (adopt, create) read the audit shape and feed it to the
 *  ledger. NEVER contains plaintext secrets. */
export interface SigningSetupAudit {
  ok: boolean;
  mode: SigningMode;
  bundleId?: string;
  appName?: string;
  platforms: SigningPlatform[];
  /** Workflow files written / overwritten this run. */
  workflowFiles: string[];
  /** Apple resources resolved or created. */
  appleBundleIdResourceId?: string;
  appleAppRecordId?: string;
  appleProvisioningProfileId?: string;
  appleProvisioningProfileName?: string;
  /** Android keystore: path to local copy + the github://<secret> ref. */
  androidKeystoreLocalPath?: string;
  androidKeystoreSecretRef?: string;
  /** Names of GH Actions secrets pushed this run. */
  pushedSecrets: string[];
  /** Files (in user's project) rewritten this run for bundle ID. */
  rewrittenFiles: string[];
  /** Human-readable lines for the post-signing checklist. */
  manualResidue: string[];
  /** Path to the post-signing checklist on disk. */
  postSigningChecklistPath?: string;
  /** Reasons specific platforms were skipped (e.g. dry-run, missing
   *  org config, user opted out for this project). */
  skipReasons: Partial<Record<SigningPlatform, string>>;
}

/** Sub-result type emitted by adapters (apple/google/azure/github) to
 *  feed both the audit and the ledger uniformly. */
export interface SigningStepResult {
  platform: SigningPlatform;
  ok: boolean;
  skipped?: string;
  pushedSecrets?: string[];
  rewrittenFiles?: string[];
  workflowFiles?: string[];
  notes?: string[];
}
