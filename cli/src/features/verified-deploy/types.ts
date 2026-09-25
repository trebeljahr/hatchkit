/*
 * cli/src/features/verified-deploy/types.ts — the vocabulary the rest of
 * this feature is written in.
 *
 * The feature generates a deploy that can undo itself, so almost every
 * type here exists to make one question answerable without a network:
 * "given what the origin just said, and what this run expected, did the
 * deploy work, and if not, what exactly is wrong?" Keeping the probe
 * shapes and the check names in one place is what lets `gate.ts` be a
 * pure function and the generated script be a thin driver around the
 * same names.
 *
 * Nothing here is trackyourtime-specific: the paths, the image variable
 * names and the migration registry's location are all fields on
 * {@link VerifiedDeployPlan} with defaults, never literals baked into
 * the logic.
 */

/** The two halves a deploy can move. A project may carry one or both —
 *  see `hasServerHalf` / `hasClientHalf` in operational-context.ts. */
export type DeployApp = "server" | "client";

/**
 * Every check the post-deploy gate can fail, in the order it is
 * evaluated. The order is part of the contract, not an accident:
 *
 *   1. `api-commit`, `web-commit` — "the deploy has not landed yet".
 *      These come FIRST because they are the only failures worth
 *      waiting minutes for: a platform deploy call returns as soon as
 *      the work is queued, so until the origin names this run's commit
 *      nothing else it says is about the build under test. Reporting a
 *      stale build's healthy `/api/health` as a pass is precisely the
 *      failure the gate exists to remove.
 *   2. `api-status`, `api-db` — the server is up and reached its
 *      database.
 *   3. `web-api-url` — the client bundle was built against the API
 *      origin this project actually serves. Baked in at image build
 *      time, so the right commit can still carry the wrong URL.
 *   4. `auth-session` — an unauthenticated session call answers 200,
 *      which proves the auth handler is mounted and its database reads
 *      work. `api-db` alone does not prove that.
 *   5. `cors` — the cross-origin preflight from the web origin is
 *      allowed. Last because it is the only check that needs both
 *      halves live, and under a single-origin project it does not run
 *      at all.
 */
export const GATE_CHECK_ORDER = [
  "api-commit",
  "web-commit",
  "api-status",
  "api-db",
  "web-api-url",
  "auth-session",
  "cors",
] as const;

/** One named check of the post-deploy gate. */
export type GateCheck = (typeof GATE_CHECK_ORDER)[number];

/** The checks that mean "not deployed yet" rather than "deployed and
 *  broken". The poll loop waits on these; everything else gets a few
 *  short retries and no more. */
export const COMMIT_CHECKS: readonly GateCheck[] = ["api-commit", "web-commit"];

/** The server's health document, as far as the gate reads it.
 *
 *  `version` is the same commit under the name older images report it
 *  as — a rollback target can be such an image, so both names are
 *  accepted. Fields are `unknown` on purpose: this is parsed JSON from
 *  a server that may be mid-crash, and the gate has to describe what it
 *  got rather than assume a shape. */
export interface HealthProbe {
  status?: unknown;
  db?: unknown;
  commit?: unknown;
  version?: unknown;
}

/** The client's build-info document (`version.json`), written next to
 *  the static export by the client Dockerfile. */
export interface BuildInfoProbe {
  commit?: unknown;
  apiUrl?: unknown;
}

/** One look at everything the gate checks. A `null` means "no usable
 *  answer" — a 502 from the proxy while the container swaps, a refused
 *  connection, a body that is not JSON. Never an exception: a failure
 *  to reach the origin is a value the gate reports, not a crash. */
export interface GateProbes {
  health: HealthProbe | null;
  buildInfo: BuildInfoProbe | null;
  sessionStatus: number | null;
  corsAllowOrigin: string | null;
}

/** What this run expects the origins to say.
 *
 *  A `null` sha means "this half was not part of this move", which is
 *  how a client-only rollback stops the server's commit from being
 *  compared against a commit it was never asked to run. An empty origin
 *  means "this project has no such half" and skips its checks entirely.
 */
export interface GateExpectations {
  /** Commit the server should report, or null to not compare. */
  serverSha: string | null;
  /** Commit the client should report, or null to not compare. */
  clientSha: string | null;
  /** API origin, no trailing slash. Empty for a project with no API. */
  apiOrigin: string;
  /** Web origin, no trailing slash. Empty for a backend-only project. */
  webOrigin: string;
  /** False when the web and API origins are the same, because then
   *  there is no cross-origin request to make. */
  crossOrigin: boolean;
}

/** The gate's answer. `failed` is the FIRST check in
 *  {@link GATE_CHECK_ORDER} that did not pass, and `detail` is the one
 *  line that goes into the run's error — it names what was seen and
 *  what was expected. */
export interface GateVerdict {
  ok: boolean;
  failed?: GateCheck;
  detail?: string;
}

/** One row of the platform's env-variable listing for an application.
 *
 *  `value` is optional rather than `string`, because the platform omits
 *  it entirely when the token may not read sensitive values — which has
 *  to read as "unknown", never as "empty". */
export interface PlatformEnvEntry {
  key: string;
  value?: string | null;
  /** The platform keeps a preview copy of a variable beside the
   *  production one. Only the production row is a rollback target. */
  is_preview?: boolean;
}

/** What a rollback can go back to, or why it cannot. */
export type RollbackTarget =
  | {
      kind: "target";
      /** The full image reference to pin again. */
      value: string;
      /** The commit that reference is pinned to. */
      sha: string;
    }
  | {
      kind: "none";
      /** Why there is nothing to go back to. One line, shown verbatim
       *  in the run's error. */
      reason: string;
    };

/** One migration, as read out of a project's registry. */
export interface MigrationEntry {
  /** Monotonic id. A build can read a database up to its own highest
   *  applied id. */
  id: number;
  /** File it was read from, so an error can name it. */
  file: string;
  /** Lowest schema version a build must be at to read the database
   *  after this migration ran. */
  minReader: number;
}

/** The migration registry of one commit. `schemaVersion` is the highest
 *  id the tree carries, which is the version a build from that tree can
 *  read up to. */
export interface MigrationRegistry {
  migrations: readonly MigrationEntry[];
  schemaVersion: number;
}

/** A registry read that either produced a registry or explained why it
 *  could not.
 *
 *  The distinction is load-bearing: a project with NO registry reads as
 *  `ok` with an empty one (nothing can block a rollback), while a
 *  registry that exists and cannot be parsed reads as an error — and an
 *  error is treated as unsafe, never waved through. */
export type RegistryRead = { ok: true; registry: MigrationRegistry } | { ok: false; error: string };

/** Whether the server half may be put back, and the sentence that
 *  explains the answer either way. */
export interface ServerRollbackVerdict {
  allowed: boolean;
  /** Always set. When `allowed` is false this is the reason the error
   *  line quotes; when true it says what was compared. */
  reason: string;
}

/**
 * Everything the generated script and workflows need to know about one
 * project. Built by `planVerifiedDeploy` (plan.ts) from the shared
 * `OperationalProject`, with every knob overridable — the point of the
 * feature is that another project with other paths gets the same
 * guarantees without editing the generator.
 */
export interface VerifiedDeployPlan {
  /** Project name, for log lines and workflow titles. */
  name: string;
  /** The halves this project actually deploys, server first. */
  apps: DeployApp[];
  /** Platform env variable holding each half's image reference. */
  imageEnvKeys: Record<DeployApp, string>;
  /** Image reference with the tag stripped, per half — read out of the
   *  project's compose defaults where they exist, so the pin names the
   *  same package the build pushed. */
  imageBase: Partial<Record<DeployApp, string>>;
  /** Public origins, no trailing slash. Empty means "no such half". */
  webOrigin: string;
  apiOrigin: string;
  /** False under a single-origin project. */
  crossOrigin: boolean;
  /** Paths the gate probes, relative to their origin. */
  healthPath: string;
  buildInfoPath: string;
  sessionPath: string;
  /** Where the migration registry lives in the repository, and the
   *  literal field names the reader looks for inside each file. */
  migrationsDir: string;
  idField: string;
  minReaderField: string;
  /** Commit poll: how often, and how many times before giving up. */
  pollIntervalMs: number;
  pollAttempts: number;
  /** Gate retries once the commits match, for a database still
   *  connecting — and no more. */
  gateIntervalMs: number;
  gateAttempts: number;
  /** The one workflow concurrency group the push deploy and the manual
   *  rollback share. */
  concurrencyGroup: string;
  /** `owner/repo`, when known. */
  repoSlug?: string;
}

/** Overrides for {@link VerifiedDeployPlan}, all optional. */
export type VerifiedDeployOverrides = Partial<Omit<VerifiedDeployPlan, "apps">> & {
  apps?: DeployApp[];
};
