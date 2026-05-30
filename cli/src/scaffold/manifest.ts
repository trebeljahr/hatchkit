/*
 * Project manifest — .hatchkit.json at the root of a scaffolded project.
 *
 * Purpose: capture just enough about how this project was scaffolded
 * that `hatchkit update` can diff the current feature set against a
 * desired new one and apply only the delta.
 *
 * ============================================================
 * SECURITY: WHAT GOES IN — AND WHAT ABSOLUTELY DOES NOT
 * ============================================================
 *
 * The manifest file gets committed to the project's git repo. Treat
 * every field as eventually public. The included fields below are all
 * already public in one way or another (package.json `name`, the
 * domain is in DNS + .env.example, feature flags are inferable from
 * dependency lists, ports are in .env.* and docker-compose.yml).
 *
 * Fields that MUST NEVER be written here:
 *   - tokens, passwords, API keys (any credential)
 *   - serverId / serverUuid / serverIp / serverIpv4 / serverIpv6
 *     (Coolify server coordinates)
 *   - s3ExistingAccessKey / SecretKey / Endpoint / Bucket  (user creds)
 *   - serverSize / serverLocation (infrastructure cost signal)
 *
 * ProjectConfig has those fields; the `toManifest` function below is
 * the single choke point that picks out the safe subset. Any time a
 * new field is added to ProjectConfig, it must be triaged here — the
 * default is to NOT include it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDevDomainFromProjectDomain } from "@hatchkit/dev-shared";
import type {
  EmailIntent,
  Feature,
  GpuPlatform,
  MlService,
  ProjectConfig,
  S3Provider,
} from "../prompts.js";
import type { ProjectPorts } from "../utils/ports.js";

export const MANIFEST_FILENAME = ".hatchkit.json";
export const MANIFEST_VERSION = 3;
/** Every schema version readManifest knows how to migrate FROM. The
 *  reader transparently upgrades v1 manifests (3-value surfaces enum:
 *  server-only / client-only / both, plus the unstable
 *  shared/separate values that leaked from the provisioner) and v2
 *  manifests (no `email` intent field — adopted as
 *  `{ transactional: "none", mailingList: "none" }`) on read, and the
 *  next write bumps the file's version field to {@link MANIFEST_VERSION}. */
const MIGRATABLE_VERSIONS = new Set<number>([1, 2, 3]);

export interface ProjectManifest {
  /** Schema version. Increment when the shape changes incompatibly. */
  version: typeof MANIFEST_VERSION;
  /** CLI version that produced this manifest (diagnostic only). */
  cliVersion: string;
  /** ISO timestamp of the scaffold. */
  scaffoldedAt: string;
  /** Project name — duplicated from package.json for convenience. */
  name: string;
  /** Production domain — already public in DNS + .env.example. */
  domain: string;
  /** Human-readable one-liner shown on the Coolify project + application
   *  pages. Optional: when unset, hatchkit falls back to a generic
   *  "Adopted by hatchkit" blurb on create, and leaves the field alone
   *  on subsequent updates. */
  description?: string;
  /** Feature flags selected at scaffold. */
  features: Feature[];
  /** ML services wired into the backend. */
  mlServices: MlService[];
  /** S3 provider name (`hetzner` / `aws` / `r2` / `existing` / `none`).
   *  Credentials are NOT stored here — only the choice. */
  s3Provider: S3Provider;
  /** Where the app deploys. `existing` vs `new` is public-safe; the
   *  actual serverId/IP is not in the manifest. */
  deployTarget: "existing" | "new";
  /** How the project is deployed. Optional for back-compat — older
   *  manifests predate the field; readers should fall back to
   *  `coolify` when absent. `gh-pages` projects skip the Coolify
   *  pipeline entirely; downstream tooling (destroy, regen-infra)
   *  branches on this. */
  deploymentMode?: "coolify" | "gh-pages" | "scaffold-only";
  /** GPU platforms each ML service was deployed to. First entry is
   *  the runtime default (`ML_BACKEND`); change `ML_BACKEND` on the
   *  deploy to flip which one serves traffic. */
  gpuPlatforms?: GpuPlatform[];
  /** HF model ID for custom-hf, if selected. HF models are public. */
  customHfModelId?: string;
  /** GPU tier (T4/A10G/A100/H100) — public product names. */
  customHfGpuType?: string;
  /** Ports assigned to this project. They're already public in the
   *  scaffolded .env.development files and docker-compose.yml. */
  ports: { server: number; client: number; nativeHmr?: number };
  /** Tailscale-served local-dev integration. Present when the project
   *  opted in at scaffold time (or later via `hatchkit dev-setup enable`).
   *  `slug` is the left-hand label and `domain` is the local-dev
   *  wildcard suffix the project is reachable at:
   *    https://<slug>.<domain>/
   *  The host-wide Caddy bridge (set up once via `hatchkit dev-setup
   *  init`) routes by Host header to the dev port. Removing this field
   *  is enough to disable the feature for this project; the Caddy
   *  fragment cleanup happens via `hatchkit dev-setup disable` or
   *  destroy. */
  localDev?: { slug: string; domain?: string };
  /** Provider integrations that don't write runtime env, but should
   *  still be treated as already added for project-level menus. */
  integrations?: {
    email?: { domain: string; configuredAt: string; destinationEmail?: string };
    searchConsole?: { domain: string; siteUrl: string; verifiedAt: string };
  };
  /** What kind of project this is — fullstack / split / backend /
   *  static. Captured by `hatchkit adopt` so subsequent re-runs (and
   *  any future tooling that needs to know whether to look for a
   *  server runtime) don't have to re-infer from disk layout. The
   *  four values disambiguate code topology (one package vs. split
   *  packages vs. single surface) from runtime shape (has a server
   *  runtime vs. pure static).
   *
   *  Optional for back-compat with manifests written before this
   *  field existed; readers should fall back to detection. */
  surfaces?: "fullstack" | "split" | "backend" | "static";
  /** Compose service that should receive the public/bare-domain
   *  routing on Coolify's dockercompose build pack. Coolify rejects
   *  a flat `domains` field for compose apps and requires
   *  `docker_compose_domains` keyed by service name (422 — "Use
   *  docker_compose_domains instead …"); without a correct name
   *  the PATCH silently no-ops, Traefik never gets labels, and
   *  the FQDN stays empty (the symptom that left
   *  mood-magic.trebeljahr.com 503ing after a clean adopt).
   *
   *  Persisted to the manifest so `hatchkit adopt --resume` and
   *  `hatchkit sync` don't have to re-derive from disk on every
   *  run. Source-of-truth precedence:
   *    1. This field (explicit / persisted choice).
   *    2. {@link defaultPublicServiceForSurfaces} based on `surfaces`.
   *    3. Compose-file inference (read services, pick by
   *       surface-aware preference list).
   *
   *  Optional for back-compat with manifests written before this
   *  field existed. Readers without it must fall through to (2)+(3);
   *  `hatchkit doctor` flags older fullstack manifests so the user
   *  can opt in via `hatchkit update`. */
  publicService?: string;
  /** Captured email-intent for this project, independent of the
   *  current `provisionServices` list. Two needs (transactional and
   *  mailing list) can be answered independently; each carries a
   *  provider name. "none" means the user explicitly opted out so a
   *  re-run won't re-prompt; the field being absent or `undefined`
   *  means the manifest predates the prompt and we should treat as
   *  "none" on read.
   *
   *  Drives both provisioning (which env vars to write) and tooling
   *  (`hatchkit update` knows whether the user wants email).
   *
   *  Optional for back-compat with v2 manifests — the v2→v3 migration
   *  in readManifestWithMigrationInfo seeds an explicit default. */
  email?: EmailIntent;
  /** S3 buckets provisioned by `hatchkit provision s3`. Names + the
   *  shared token id go in the manifest (so re-runs are idempotent and
   *  `hatchkit destroy` knows what to undo); credentials never do —
   *  those live encrypted in `.env.production`.
   *
   *  `assets`  is the public bucket fronting NEXT_PUBLIC_ASSETS_BASE_URL
   *           or equivalent. Reachable over HTTPS via either an r2.dev
   *           managed domain or a custom domain on a zone the user owns.
   *  `state`  is the private bucket — used for state files, logs, cron
   *           inputs. Never publicly readable.
   *
   *  `publicUrl` is the canonical no-trailing-slash URL the runtime
   *  should serve assets from. Always present on `assets`; null on
   *  `state` (private buckets aren't publicly reachable).
   *
   *  `tokenId` + `accountId` (top-level) identify the Cloudflare R2
   *  Account API Token whose resource policy is scoped to whichever
   *  buckets exist for this project. ONE token covers both buckets —
   *  the runtime is a single app reading both. Destroy revokes the
   *  token via `DELETE /accounts/{accountId}/tokens/{tokenId}` after
   *  the buckets themselves are gone.
   *
   *  Neither field is a credential — the token id is an identifier
   *  (= S3 access key id), and accountId is already public-safe. The
   *  actual access/secret pair lives encrypted in .env.production.
   *
   *  Both are optional for back-compat with manifests written before
   *  account-token provisioning landed (legacy projects still have
   *  user-tokens stashed in the OS keychain; provision migrates them
   *  on next run). */
  /** Per-project SES state that Hatchkit owns directly. Today this
   *  only covers the Custom MAIL FROM Domain attribute + the two DNS
   *  records (MX + SPF TXT) Hatchkit publishes at the chosen subdomain.
   *  Recording the managed DNS-record contents — not just the names —
   *  lets `email ses-mail-from remove` delete only what Hatchkit added,
   *  even if the user later edited a row by hand.
   *
   *  Optional for back-compat with manifests written before the MAIL
   *  FROM auto-configuration feature shipped; on first run of
   *  `hatchkit update` the field is populated. */
  ses?: {
    /** SES identity name (typically `mail.<projectDomain>`). Mirrors
     *  the derived value `sesSendingSubdomain(domain)` so a
     *  domain-rename can resync via inspection. */
    identity: string;
    /** Active custom MAIL FROM subdomain (typically
     *  `bounce.<sendingDomain>`). Null is encoded as an absent field —
     *  the presence of `ses.mailFromDomain` is itself the signal that
     *  MAIL FROM is configured. */
    mailFromDomain?: string;
    /** Behavior toggle on MX-failure. Defaults to `UseDefaultValue` so
     *  a misconfigured DNS state degrades to `amazonses.com` instead of
     *  bouncing mail. Strict-alignment setups can flip to
     *  `RejectMessage`. */
    mailFromBehaviorOnMxFailure?: "UseDefaultValue" | "RejectMessage";
    /** Subdomain label Hatchkit used when computing
     *  `mailFromDomain = <label>.<sendingDomain>`. Recorded so
     *  re-running the provision keeps the same name even if the
     *  default label changes in a future Hatchkit release. */
    mailFromLabel?: string;
    /** Exact record content Hatchkit upserted at the MAIL FROM
     *  subdomain. Stored by content (not just name) so
     *  `email ses-mail-from remove` can match-and-delete only what
     *  Hatchkit added — user-edited rows at the same name are left
     *  untouched. */
    mailFromManagedDnsRecords?: Array<
      | { type: "MX"; name: string; value: string; priority: number }
      | { type: "TXT"; name: string; value: string }
    >;
  };
  s3Buckets?: {
    assets?: { name: string; publicUrl: string; tokenId?: string; cors?: BucketCors };
    state?: { name: string; publicUrl: null; tokenId?: string };
    /** Shared Cloudflare R2 Account API Token id covering the
     *  built-in `assets`/`state` pair (one token, one resource policy
     *  listing both buckets). Recorded by `hatchkit provision s3`.
     *  Per-bucket tokens minted by `hatchkit add s3` for arbitrary
     *  user-declared buckets live under each bucket entry's own
     *  `tokenId` field instead. */
    tokenId?: string;
    /** Account that owns the buckets and the shared token. */
    accountId?: string;
    /** Arbitrary user-declared bucket entries (beyond the built-in
     *  `assets`/`state` pair) — `hatchkit add <project> s3` mints a
     *  per-bucket scoped R2 token for each one. The union value type
     *  also covers the scalar `tokenId`/`accountId` fields above:
     *  TS requires the index signature to be no narrower than any
     *  named property, so `string` (for those scalars) is part of
     *  the union. Callers narrow on `typeof === "object"` before
     *  reading `name` / `publicUrl` / `tokenId`. */
    [key: string]:
      | { name: string; publicUrl: string | null; tokenId?: string; cors?: BucketCors }
      | string
      | undefined;
  };
}

/** CORS policy applied to the public assets bucket. The single-rule
 *  shape mirrors Cloudflare's R2 limitation (one rule per bucket, not
 *  per-prefix). When `skipped` is true the user explicitly opted out
 *  via `--no-cors` and re-runs of `provision s3` should leave the live
 *  bucket policy alone — useful for projects that manage CORS
 *  out-of-band (e.g. via a Cloudflare Worker rewrite or a manually-
 *  curated dashboard policy).
 *
 *  `origins` records the *resolved* set actually applied — the union
 *  of the manifest defaults (production domain + localhost dev ports)
 *  and `extraOrigins`. The doctor drift check compares this against
 *  the live bucket policy. `extraOrigins` records the user-supplied
 *  inputs separately so a re-run can recompute the resolved list when
 *  the project domain changes (`hatchkit rename-domain`) without
 *  losing the user's explicit additions. */
export interface BucketCors {
  /** Resolved list of origins applied to the bucket. Sorted +
   *  deduplicated by `provisionS3ForProject` so re-runs are stable. */
  origins?: string[];
  /** Allowed methods. Default ["GET","HEAD"] when omitted. */
  methods?: string[];
  /** Preflight cache TTL. Default 86400 (one day) when omitted. */
  maxAgeSeconds?: number;
  /** Extra origins the user passed via `--cors-origin <url>` or in the
   *  manifest. Folded into `origins` on the next run. */
  extraOrigins?: string[];
  /** True when the user opted out of CORS provisioning entirely
   *  (`--no-cors`). `provision s3` skips the CORS step on re-runs;
   *  `doctor` skips drift detection. */
  skipped?: boolean;
}

/** Default `publicService` name keyed by surface, matching the
 *  service names baked into the starter's docker-compose.yml
 *  (`server`, `client`, plus infra). Fullstack / split / static all
 *  bind the bare/public domain to the Next.js `client` image (it
 *  serves the SPA and proxies `/api` to server); backend-only has no
 *  client and routes everything to `server`. Anything else returns
 *  undefined so the caller falls through to compose-file inference. */
export function defaultPublicServiceForSurfaces(
  surfaces: ProjectManifest["surfaces"] | undefined,
): string | undefined {
  switch (surfaces) {
    case "fullstack":
    case "split":
    case "static":
      return "client";
    case "backend":
      return "server";
    default:
      return undefined;
  }
}

/** Build a manifest from the internal ProjectConfig, explicitly
 *  whitelisting only the safe fields. Any new field on ProjectConfig
 *  will NOT leak into the manifest unless added here on purpose. */
export function toManifest(
  config: ProjectConfig,
  ports: ProjectPorts,
  cliVersion: string,
): ProjectManifest {
  return {
    version: MANIFEST_VERSION,
    cliVersion,
    scaffoldedAt: new Date().toISOString(),
    name: config.name,
    description: config.description?.trim() || undefined,
    domain: config.domain,
    features: [...config.features],
    mlServices: [...config.mlServices],
    s3Provider: config.s3Provider,
    deployTarget: config.deployTarget,
    deploymentMode: config.deploymentMode,
    surfaces: config.surfaces,
    publicService: config.publicService ?? defaultPublicServiceForSurfaces(config.surfaces),
    gpuPlatforms: config.gpuPlatforms,
    customHfModelId: config.customHfModelId,
    customHfGpuType: config.customHfGpuType,
    ports: {
      server: ports.server,
      client: ports.client,
      nativeHmr: ports.nativeHmr,
    },
    localDev: config.localDev
      ? {
          slug: config.localDev.slug,
          domain:
            config.localDev.domain ?? localDevDomainFromProjectDomain(config.domain) ?? undefined,
        }
      : undefined,
    email: config.email,
  };
}

export function writeManifest(outputDir: string, manifest: ProjectManifest): void {
  const path = join(outputDir, MANIFEST_FILENAME);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/** Old → new surface rename map. Applied in {@link readManifest} so
 *  v1 manifests (and any v2 file that was hand-edited with a v1
 *  literal — happened during the rollout) keep working transparently.
 *
 *  The four named entries are the canonical v1 → v2 rename:
 *
 *    shared      → fullstack
 *    separate    → split
 *    server-only → backend
 *    client-only → static
 *
 *  Plus one historical alias: v1 also let users write `surfaces:
 *  "both"` (the only value that didn't have a 1:1 4-value successor).
 *  Migrate to `fullstack` — the safer choice; users with a split
 *  /server + /client monorepo can hand-flip to `split` after the
 *  upgrade. */
const SURFACE_RENAME: Record<string, ProjectManifest["surfaces"]> = {
  shared: "fullstack",
  separate: "split",
  "server-only": "backend",
  "client-only": "static",
  both: "fullstack",
};

interface ReadManifestResult {
  manifest: ProjectManifest;
  /** True when the in-memory manifest differs from the on-disk file
   *  because the reader applied a migration. Callers that intend to
   *  write the manifest back should observe this so the next write
   *  bumps the file's `version` field. */
  migrated: boolean;
  /** Human-readable notes describing what migrated. Empty when
   *  `migrated` is false. */
  migrationNotes: string[];
}

/** Read + validate a manifest from a scaffolded project directory.
 *  Returns null if the file doesn't exist. Throws on malformed JSON
 *  or an unknown schema version so downstream code doesn't silently
 *  operate on a wrong shape.
 *
 *  Transparently migrates v1 manifests (and the rename-map aliases)
 *  to v2 in memory. The on-disk file isn't touched here — the next
 *  call to {@link writeManifest} re-emits the file at the current
 *  schema version, which is the natural moment to upgrade. */
export function readManifest(projectDir: string): ProjectManifest | null {
  const result = readManifestWithMigrationInfo(projectDir);
  if (!result) return null;
  if (result.migrated) {
    for (const note of result.migrationNotes) {
      console.log(`  ${note}`);
    }
  }
  return result.manifest;
}

/** Internal variant of {@link readManifest} that also returns whether
 *  a migration happened. Exposed for the test suite + any caller that
 *  wants to suppress the console log (tests do). */
export function readManifestWithMigrationInfo(projectDir: string): ReadManifestResult | null {
  const path = join(projectDir, MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Manifest at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Manifest at ${path} is not an object.`);
  }
  const obj = parsed as Record<string, unknown> & { version?: unknown; surfaces?: unknown };
  const fileVersion = typeof obj.version === "number" ? obj.version : undefined;
  if (fileVersion === undefined || !MIGRATABLE_VERSIONS.has(fileVersion)) {
    throw new Error(
      `Manifest at ${path} has unknown version (${String(obj.version)}). Expected ${MANIFEST_VERSION} or older migratable.`,
    );
  }

  const migrationNotes: string[] = [];

  // surfaces rename — applies regardless of file version: a v2 file
  // that was hand-edited with a v1 literal still gets migrated, so
  // the manifest in memory is always canonical 4-value.
  if (typeof obj.surfaces === "string" && obj.surfaces in SURFACE_RENAME) {
    const before = obj.surfaces;
    const after = SURFACE_RENAME[before];
    if (after && before !== after) {
      obj.surfaces = after;
      migrationNotes.push(`Renamed surface mode: ${before} → ${after}`);
    }
  }

  // v2 → v3: `email` intent field appears. Seed a "none" default so the
  // reader's caller doesn't have to nullcheck on every read, and a
  // `hatchkit update` re-prompt isn't triggered unnecessarily by an
  // absent value.
  if (fileVersion !== undefined && fileVersion < 3 && obj.email === undefined) {
    obj.email = { transactional: "none", mailingList: "none" };
    migrationNotes.push('Seeded email intent: { transactional: "none", mailingList: "none" }');
  }

  // Schema-version bump (in memory only — the file is rewritten on
  // the next writeManifest call).
  if (fileVersion !== MANIFEST_VERSION) {
    obj.version = MANIFEST_VERSION;
    migrationNotes.push(`Migrated manifest schema v${fileVersion} → v${MANIFEST_VERSION}`);
  }

  return {
    manifest: obj as unknown as ProjectManifest,
    migrated: migrationNotes.length > 0,
    migrationNotes,
  };
}
