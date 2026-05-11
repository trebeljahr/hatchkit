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
import type { Feature, GpuPlatform, MlService, ProjectConfig, S3Provider } from "../prompts.js";
import type { ProjectPorts } from "../utils/ports.js";

export const MANIFEST_FILENAME = ".hatchkit.json";
export const MANIFEST_VERSION = 1;

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
  /** What kind of project this is — server-only / client-only /
   *  both. Captured by `hatchkit adopt` so subsequent re-runs (and
   *  any future tooling that needs to know whether to look for a
   *  server bundle) don't have to re-infer from disk layout.
   *  Optional for back-compat with manifests written before this
   *  field existed; readers should fall back to detection. */
  surfaces?: "server-only" | "client-only" | "both";
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
    gpuPlatforms: config.gpuPlatforms,
    customHfModelId: config.customHfModelId,
    customHfGpuType: config.customHfGpuType,
    ports: {
      server: ports.server,
      client: ports.client,
      nativeHmr: ports.nativeHmr,
    },
  };
}

export function writeManifest(outputDir: string, manifest: ProjectManifest): void {
  const path = join(outputDir, MANIFEST_FILENAME);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/** Read + validate a manifest from a scaffolded project directory.
 *  Returns null if the file doesn't exist. Throws on malformed JSON
 *  or an unknown schema version so downstream code doesn't silently
 *  operate on a wrong shape. */
export function readManifest(projectDir: string): ProjectManifest | null {
  const path = join(projectDir, MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Manifest at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== MANIFEST_VERSION
  ) {
    throw new Error(`Manifest at ${path} has unknown version. Expected ${MANIFEST_VERSION}.`);
  }
  return parsed as ProjectManifest;
}
