/*
 * S3/R2 bucket provisioning for adopted projects.
 *
 * Closes the gap between `hatchkit config add s3 r2` (which only stores
 * credentials in the global config + keychain) and a project that
 * actually needs working buckets + env wiring at runtime.
 *
 * Two bucket roles, but only "assets" is created by default:
 *
 *   · "assets"  — public, hot path. Fronts large pre-built media
 *                 (AVIF/WebP/originals). Public URL goes into a
 *                 NEXT_PUBLIC_ASSETS_BASE_URL-style env var so the
 *                 client can fetch directly. Always created.
 *   · "state"   — private, cold. Used for small server-side files
 *                 (cron state, audit logs). Opt-in via
 *                 `includeStateBucket: true` (CLI: `--with-state-bucket`)
 *                 since most projects (esp. Next-only frontends) don't
 *                 need it. Never publicly reachable.
 *
 * Public URL strategy for the assets bucket, in order:
 *   1. Custom domain on a Cloudflare zone the user owns
 *      (`assets.<project-domain>` or a caller-provided override) —
 *      preferred long-term, no `r2.dev` rate limits.
 *   2. Managed `pub-<hash>.r2.dev` domain — fallback when no zone
 *      matches the project's domain, or when the caller explicitly
 *      asks to skip the custom-domain attempt (`publicHostname: null`).
 *
 * Env var names are project-specific. Some projects standardised on
 * R2_*; others on the generic S3_* / AWS_* set the starter ships. We
 * sniff the project's `.env.example` for whichever prefix the runtime
 * already reads, so the seeded values match. Without this the env
 * lands under names the app's `process.env.X` calls won't pick up.
 *
 * Idempotent on every step: existing buckets are reused (409 →
 * success), existing managed/custom domains are re-fetched, and env
 * vars overwrite in place (so re-runs after a failure don't duplicate
 * lines or leave the file half-written).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { set as dotenvxSet } from "@dotenvx/dotenvx";
import chalk from "chalk";
import ora from "ora";
import { getDnsConfig } from "../config.js";
import {
  type BucketCors,
  MANIFEST_FILENAME,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "../scaffold/manifest.js";
import { CloudflareApi, type R2CorsRule } from "../utils/cloudflare-api.js";
import { SECRET_KEYS, deleteSecret, getSecret } from "../utils/secrets.js";
import { readEnvKeys } from "./write-env.js";

export type EnvPrefix = "R2" | "S3" | "AWS";

export interface ProvisionS3Opts {
  projectDir: string;
  /** Provider key under config.providers.s3.<provider>. Default "r2". */
  provider?: string;
  /** Override auto-detected env-var prefix. */
  envPrefix?: EnvPrefix;
  /** Override the public hostname for the assets bucket. Semantics:
   *  · undefined          → derive default from manifest.domain
   *                         (`assets.<domain>`); fall back to managed
   *                         r2.dev if no Cloudflare zone matches.
   *  · `null` or `""`     → skip the custom-domain attempt entirely
   *                         and use the managed r2.dev URL.
   *  · `"<host>"`         → attach that exact hostname (still falls
   *                         back to managed r2.dev if it can't be
   *                         attached, e.g. zone not on Cloudflare). */
  publicHostname?: string | null;
  /** Override bucket names. Defaults to <projectName>-assets / -state. */
  assetsBucketName?: string;
  stateBucketName?: string;
  /** Create the private "state" bucket alongside the public assets
   *  bucket. Default false — most projects (especially Next-only
   *  frontends) don't need a server-side state bucket and creating
   *  one just adds clutter, env vars, and CF account noise. Opt in
   *  when you actually have a server that writes cron state, audit
   *  logs, or other private files. CLI: `--with-state-bucket`. */
  includeStateBucket?: boolean;
  /** R2 location hint. Default "weur" (Western Europe — closest to
   *  Hetzner Nuremberg, where the typical hatchkit deploy lives). */
  locationHint?: string;
  /** When true, generate a fresh CRON_SECRET and write it alongside
   *  the bucket env vars. Default true. */
  generateCronSecret?: boolean;
  /** Extra origins to add to the assets-bucket CORS rule on top of the
   *  computed defaults (production domain + dev localhost ports). */
  corsExtraOrigins?: string[];
  /** Replace the resolved origin list with `["*"]`. Mutually exclusive
   *  with `corsExtraOrigins` — caller should reject the combo at the
   *  CLI layer. Disables hotlinking-by-default; emits a warning. */
  corsAllowAll?: boolean;
  /** Skip the CORS reconcile step entirely. Records `cors.skipped: true`
   *  in the manifest so re-runs respect the user's choice. */
  skipCors?: boolean;
}

export interface ProvisionS3Result {
  assets: { name: string; publicUrl: string; created: boolean; cors?: BucketCors };
  /** Null when `includeStateBucket` was false (the default). */
  state: { name: string; created: boolean } | null;
  envWritten: string[];
  /** Existing keys we left alone (already encrypted in the file). */
  envKept: string[];
  /** Cloudflare account that owns the buckets + token. Surfaced so the
   *  caller can record ledger entries for cleanup-on-destroy. */
  accountId: string;
  /** Token information about THIS run's mint, when one happened.
   *  Used by the caller (e.g. adopt) to write a `r2Token` ledger
   *  entry for destroy. `null` when we reused an existing token from
   *  the manifest. `audience` is always "account" for fresh mints —
   *  the legacy "user" audience is internal-only (migration cleanup). */
  tokenCreated: { tokenId: string; audience: "account" } | null;
  /** True iff this run revoked a legacy user-scoped token from the OS
   *  keychain (migration from the pre-account-tokens era). Diagnostic
   *  only — the revoke happens before any new mint. */
  legacyUserTokenMigrated: boolean;
}

/** Account ID = the subdomain in the S3 endpoint
 *  `https://<accountId>.r2.cloudflarestorage.com`. */
export function accountIdFromR2Endpoint(endpoint: string): string {
  const m = endpoint.match(/https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i);
  if (!m) throw new Error(`Endpoint ${endpoint} doesn't look like an R2 S3 endpoint.`);
  return m[1];
}

/** Sniff the project's `.env.example` (and falling back to source files)
 *  to pick the env-var prefix the runtime already reads. Some projects
 *  use R2_*, others S3_*, others AWS_*. Picking the wrong prefix here
 *  is the difference between "deploys" and "deploys but every request
 *  throws Missing required env var". */
export function detectEnvPrefix(projectDir: string): EnvPrefix {
  const candidates = [
    join(projectDir, ".env.example"),
    join(projectDir, ".env.development"),
    join(projectDir, ".env.production"),
  ];
  let r2 = 0;
  let s3 = 0;
  let aws = 0;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf-8");
    r2 += (text.match(/(^|\s)R2_[A-Z_]+\s*=/gm) ?? []).length;
    s3 += (text.match(/(^|\s)S3_[A-Z_]+\s*=/gm) ?? []).length;
    aws += (text.match(/(^|\s)AWS_(REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*=/gm) ?? []).length;
  }
  // Highest wins; ties prefer R2 (most explicit) > S3 > AWS.
  const pairs: Array<[EnvPrefix, number]> = [
    ["R2", r2],
    ["S3", s3],
    ["AWS", aws],
  ];
  pairs.sort((a, b) => b[1] - a[1]);
  if (pairs[0][1] === 0) return "S3"; // nothing detected — match starter default
  return pairs[0][0];
}

/** Map the detected prefix to the full set of env var names. R2 and S3
 *  use distinct endpoint/bucket names but share the access-key shape;
 *  AWS uses the AWS_* triple instead of S3_*. */
export function envKeysForPrefix(prefix: EnvPrefix): {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  publicUrl: string;
} {
  if (prefix === "R2") {
    return {
      endpoint: "R2_ENDPOINT",
      accessKey: "R2_ACCESS_KEY_ID",
      secretKey: "R2_SECRET_ACCESS_KEY",
      region: "R2_REGION",
      bucket: "R2_STATE_BUCKET",
      publicUrl: "NEXT_PUBLIC_ASSETS_BASE_URL",
    };
  }
  if (prefix === "AWS") {
    return {
      endpoint: "S3_ENDPOINT",
      accessKey: "AWS_ACCESS_KEY_ID",
      secretKey: "AWS_SECRET_ACCESS_KEY",
      region: "AWS_REGION",
      bucket: "S3_BUCKET_NAME",
      publicUrl: "S3_PUBLIC_URL",
    };
  }
  return {
    endpoint: "S3_ENDPOINT",
    accessKey: "S3_ACCESS_KEY_ID",
    secretKey: "S3_SECRET_ACCESS_KEY",
    region: "S3_REGION",
    bucket: "S3_BUCKET_NAME",
    publicUrl: "S3_PUBLIC_URL",
  };
}

/** Read existing keys in `.env.production` so re-runs don't clobber a
 *  value the user has since edited. Returns the set of plain or
 *  encrypted KEYs present (we don't try to decrypt — encrypted values
 *  always have a `KEY="encrypted:..."` shape). */
const existingEnvKeys = readEnvKeys;

/** Provision the public+private bucket pair for an adopted project,
 *  wire the resulting credentials/URLs into its `.env.production`, and
 *  record the bucket names in `.hatchkit.json`. Idempotent on re-run. */
export async function provisionS3ForProject(opts: ProvisionS3Opts): Promise<ProvisionS3Result> {
  const provider = opts.provider ?? "r2";
  const manifest = readManifest(opts.projectDir);
  if (!manifest) {
    throw new Error(`No ${MANIFEST_FILENAME} in ${opts.projectDir}. Run \`hatchkit adopt\` first.`);
  }

  // Provider metadata (endpoint + region). Read from the Conf JSON
  // store directly so we don't require the legacy account-wide
  // access/secret pair to exist — the new model issues per-project
  // creds at provision-time, the global pair is no longer the source
  // of truth for runtime S3 ops.
  if (provider !== "r2") {
    throw new Error(
      `Bucket auto-provisioning is only implemented for R2 today (got ${provider}). PRs welcome.`,
    );
  }
  const { getStore } = await import("../config.js");
  const meta = getStore().get(`providers.s3.${provider}`) as
    | { status?: string; endpoint?: string; region?: string }
    | undefined;
  if (!meta || meta.status !== "configured" || !meta.endpoint) {
    throw new Error(
      `S3 provider "${provider}" is not configured. Run \`hatchkit config add s3\` and pick ${provider}.`,
    );
  }

  const accountId = accountIdFromR2Endpoint(meta.endpoint);

  // DNS config — needed only when we're about to attempt a custom
  // domain. Absence is fine; we fall back to the managed r2.dev URL.
  const dns = await getDnsConfig();

  // R2 admin token. Kept separate from the DNS token because the DNS
  // token is typically scoped narrowly (Zone:DNS:Edit + Zone:Zone:Read)
  // and the R2 admin endpoints need account-level perms. Caller
  // (handleProvisionS3) is responsible for prompting + storing this
  // when missing — this function fails fast so non-interactive callers
  // (adopt's auto-step) get a clear hint instead of an opaque 10000.
  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    throw new Error(
      "R2 admin token not configured. Run `hatchkit config add s3 r2` to paste + verify it globally, " +
        "then re-run `hatchkit provision s3` to create this project's buckets.",
    );
  }

  // For the zone lookup (custom-domain attach) we need the DNS token's
  // Zone:Zone:Read; the admin token may or may not have it. Use whichever
  // we have available, preferring the DNS token because that's the one
  // that's been verified for zone reads in `hatchkit doctor`.
  const zoneToken = dns?.apiToken ?? adminToken;
  const cf = new CloudflareApi({ token: adminToken });
  const cfZone = new CloudflareApi({ token: zoneToken });

  const projectName = manifest.name;
  const domain = manifest.domain;
  const assetsBucketName = opts.assetsBucketName ?? `${projectName}-assets`;
  const stateBucketName = opts.stateBucketName ?? `${projectName}-state`;
  const locationHint = opts.locationHint ?? "weur";

  // State bucket is opt-in. Default off so a "simple" Next-only deploy
  // doesn't end up with a private bucket it never reads from. Caller
  // sets includeStateBucket=true (CLI: --with-state-bucket) when there's
  // a server that genuinely needs cron state / audit log storage.
  const includeStateBucket = opts.includeStateBucket === true;

  // 1. Create the bucket(s) (idempotent).
  const spinner = ora(
    includeStateBucket
      ? `Creating R2 buckets (${assetsBucketName}, ${stateBucketName})`
      : `Creating R2 bucket (${assetsBucketName})`,
  ).start();
  let assetsBucket: { existed: boolean };
  let stateBucket: { existed: boolean } | null = null;
  try {
    assetsBucket = await cf.createR2Bucket(accountId, assetsBucketName, { locationHint });
    if (includeStateBucket) {
      stateBucket = await cf.createR2Bucket(accountId, stateBucketName, { locationHint });
      spinner.succeed(
        `R2 buckets ready — ${assetsBucketName} (${assetsBucket.existed ? "exists" : "created"}), ${stateBucketName} (${stateBucket.existed ? "exists" : "created"})`,
      );
    } else {
      spinner.succeed(
        `R2 bucket ready — ${assetsBucketName} (${assetsBucket.existed ? "exists" : "created"})`,
      );
    }
  } catch (err) {
    spinner.fail("R2 bucket creation failed");
    const msg = (err as Error).message;
    if (/403|10001|permission/i.test(msg)) {
      throw new Error(
        `${msg}\n\n  → Cloudflare token is missing the "Workers R2 Storage: Edit" permission.\n  → Edit it at https://dash.cloudflare.com/profile/api-tokens, then re-run.`,
      );
    }
    throw err;
  }

  // 2. Public URL for the assets bucket. Prefer a custom domain on a
  //    Cloudflare zone we own; fall back to the managed r2.dev URL.
  //    A caller passing `publicHostname: null` (or "") explicitly opts
  //    out of the custom-domain step — used by `--no-custom-domain`
  //    and by the prompt when the user clears the input.
  let publicUrl: string | undefined;
  let publicUrlSource: "custom-domain" | "managed-r2dev" | undefined;

  const skipCustomDomain = opts.publicHostname === null || opts.publicHostname === "";
  // Pick the hostname. Default `assets.<domain>`; allow caller override.
  const customHostname = opts.publicHostname || defaultBucketHostname(domain);
  // Find the closest matching zone (the registrable name — last
  // two labels of the host, or the host itself if the user passed a
  // bare apex).
  const zoneName = pickClosestZoneName(customHostname);

  if (!skipCustomDomain) {
    try {
      const zone = await cfZone.getZoneByName(zoneName);
      if (zone) {
        const customSpinner = ora(`Attaching custom domain ${customHostname}`).start();
        try {
          const cd = await cf.addR2CustomDomain(accountId, assetsBucketName, {
            domain: customHostname,
            zoneId: zone.id,
            minTLS: "1.2",
          });
          publicUrl = `https://${cd.domain}`;
          publicUrlSource = "custom-domain";
          customSpinner.succeed(
            `Custom domain ${cd.existed ? "already attached" : "attached"} — ${publicUrl}`,
          );
        } catch (err) {
          customSpinner.warn(
            `Custom domain failed (${(err as Error).message.split("\n")[0]}) — falling back to r2.dev managed URL`,
          );
        }
      } else {
        console.log(
          chalk.dim(`  · No Cloudflare zone for ${zoneName} — using managed r2.dev URL instead.`),
        );
      }
    } catch (err) {
      // Zone lookup is best-effort. Don't fail the whole flow on it.
      console.log(
        chalk.dim(
          `  · Zone lookup for ${zoneName} failed: ${(err as Error).message.split("\n")[0]}`,
        ),
      );
    }
  }

  if (!publicUrl) {
    const managedSpinner = ora(`Enabling managed r2.dev URL on ${assetsBucketName}`).start();
    try {
      const md = await cf.enableR2ManagedDomain(accountId, assetsBucketName, true);
      publicUrl = `https://${md.domain}`;
      publicUrlSource = "managed-r2dev";
      managedSpinner.succeed(`Managed r2.dev URL enabled — ${publicUrl}`);
    } catch (err) {
      managedSpinner.fail("Could not enable a public URL on the assets bucket");
      throw err;
    }
  }

  // 3. Reconcile bucket CORS so browser fetch()/crossOrigin paths can
  //    read assets cross-origin without the user fiddling in the
  //    dashboard. Sits before token minting because CORS doesn't depend
  //    on the token; putting it early keeps the spinner sequence
  //    readable. Idempotent: GET first, only PUT when the desired set
  //    differs from what's live.
  //
  //    Skip flag (`--no-cors`) and a previously-recorded `skipped: true`
  //    in the manifest both opt out — caller stays in control if they're
  //    managing CORS out-of-band (Worker rewrite, hand-curated dashboard
  //    policy).
  const corsSkipFromManifest = manifest.s3Buckets?.assets?.cors?.skipped === true;
  const skipCors = opts.skipCors === true || (corsSkipFromManifest && opts.skipCors === undefined);
  let appliedCors: BucketCors | undefined;
  if (skipCors) {
    appliedCors = { skipped: true };
    console.log(
      chalk.dim(
        `  · Skipped CORS reconcile (manifest records cors.skipped). Re-run with --cors-origin or --cors-allow-all to opt back in.`,
      ),
    );
  } else {
    if (opts.corsAllowAll && opts.corsExtraOrigins && opts.corsExtraOrigins.length > 0) {
      throw new Error(
        "--cors-allow-all and --cors-origin are mutually exclusive (allow-all already covers every origin).",
      );
    }
    const previousExtras = manifest.s3Buckets?.assets?.cors?.extraOrigins ?? [];
    const extras = opts.corsExtraOrigins ?? previousExtras;
    const desired = buildDesiredCors({
      manifest,
      extras,
      allowAll: opts.corsAllowAll === true,
    });
    if (opts.corsAllowAll) {
      console.log(
        chalk.yellow(
          `  · --cors-allow-all set: bucket CORS will allow * (any origin). Hotlinking is now possible — narrow the list with --cors-origin when convenient.`,
        ),
      );
    }
    appliedCors = await reconcileBucketCors(cf, accountId, assetsBucketName, desired, extras);
  }

  // 4. Mint a per-project R2 **Account** API token scoped to the
  //    buckets above. Lives in `R2 → Manage R2 API Tokens` in the
  //    Cloudflare dashboard (account scope, not user) and the manifest
  //    records its id so `hatchkit destroy` can revoke it alongside
  //    the buckets.
  //
  //    Idempotency / re-run policy:
  //      a. Manifest already has an `s3Buckets.tokenId` AND that token
  //         is alive in CF AND `.env.production` already has the
  //         encrypted access/secret values → REUSE (skip mint).
  //         Keeps re-runs of `hatchkit provision s3` no-op when
  //         nothing's actually changed.
  //      b. `.env.production` already has access/secret values but the
  //         manifest has NO tokenId (first adopt over a project that
  //         already had S3 wired up, or a manifest written before
  //         account-token tracking) → REUSE the env creds as-is. We
  //         don't know the CF token id behind them so destroy can't
  //         auto-revoke, but silently re-minting and overwriting a
  //         working pair is worse: the live token keeps orphaning and
  //         the runtime now points at fresh creds the user didn't ask
  //         for. Warn loudly + record what we couldn't track.
  //      c. Otherwise → mint a fresh account-token. Revoke the stale
  //         manifest token first if any (so we don't leave orphans).
  //      d. Migration: if the OS keychain still has a legacy
  //         user-token from the pre-account-tokens era, revoke it and
  //         wipe the keychain entries — manifest is now the source of
  //         truth, not the keychain. Skipped when (b) applies, since
  //         the keychain creds might be the same pair the env is
  //         currently using and revoking them would break runtime.
  const existingTokenId = manifest.s3Buckets?.tokenId;
  const existingAccountId = manifest.s3Buckets?.accountId;
  const envPathForCheck = join(opts.projectDir, ".env.production");
  const existingEnvKeysSet = existingEnvKeys(envPathForCheck);
  const envPrefixForCheck = opts.envPrefix ?? detectEnvPrefix(opts.projectDir);
  const keysForCheck = envKeysForPrefix(envPrefixForCheck);
  const envHasCreds =
    existingEnvKeysSet.has(keysForCheck.accessKey) &&
    existingEnvKeysSet.has(keysForCheck.secretKey);

  let canReuseExisting = false;
  if (existingTokenId && existingAccountId && envHasCreds) {
    try {
      const tok = await cf.getAccountToken(existingAccountId, existingTokenId);
      if (tok && tok.status === "active") {
        canReuseExisting = true;
        console.log(
          chalk.dim(
            `  · Reusing R2 account token ${existingTokenId.slice(0, 8)}… (alive in CF; creds in .env.production)`,
          ),
        );
      } else if (tok) {
        console.log(
          chalk.yellow(
            `  · Existing R2 token ${existingTokenId.slice(0, 8)}… is ${tok.status}. Minting a fresh one.`,
          ),
        );
      } else {
        console.log(
          chalk.yellow(
            `  · Existing R2 token ${existingTokenId.slice(0, 8)}… is gone from Cloudflare. Minting a fresh one.`,
          ),
        );
      }
    } catch (err) {
      // Probe failure (network / permissions) — fail open + mint
      // fresh. The orphan (if any) is recoverable manually; better
      // than continuing with stale creds.
      console.log(
        chalk.dim(
          `  · Couldn't verify R2 token ${existingTokenId.slice(0, 8)}… (${(err as Error).message.split("\n")[0]}). Minting a fresh one.`,
        ),
      );
    }
  }

  // Case (b) from the policy above: env has creds, manifest doesn't
  // know which CF token they belong to. Reuse them in place.
  const reusingExternalCreds = !canReuseExisting && envHasCreds && !existingTokenId;
  if (reusingExternalCreds) {
    console.log(
      chalk.yellow(
        `  · Existing ${keysForCheck.accessKey} / ${keysForCheck.secretKey} found in .env.production — reusing as-is (no re-mint).`,
      ),
    );
    console.log(
      chalk.dim(
        `    Manifest has no recorded R2 token id for these creds, so \`hatchkit destroy\` won't auto-revoke the token.\n` +
          `    To rotate or re-mint a tracked token: remove both keys from .env.production and re-run \`hatchkit provision s3\`.`,
      ),
    );
  }

  // Migration: revoke + wipe legacy user-token entries from the
  // keychain. Best-effort — a CF revoke failure logs and continues.
  // Skipped when reusing external creds: the keychain entries may be
  // the same pair currently wired into .env.production, and revoking
  // them would break runtime.
  let legacyUserTokenMigrated = false;
  const legacyAccessKey = reusingExternalCreds
    ? null
    : await getSecret(SECRET_KEYS.s3ProjectAccessKey(provider, projectName));
  const legacySecretKey = reusingExternalCreds
    ? null
    : await getSecret(SECRET_KEYS.s3ProjectSecretKey(provider, projectName));
  const legacyTokenId = reusingExternalCreds
    ? null
    : await getSecret(SECRET_KEYS.s3ProjectTokenId(provider, projectName));
  if (legacyAccessKey || legacySecretKey || legacyTokenId) {
    legacyUserTokenMigrated = true;
    if (legacyTokenId) {
      try {
        const result = await cf.deleteApiToken(legacyTokenId);
        if (result === "deleted") {
          console.log(
            chalk.dim(`  · Revoked legacy user-token ${legacyTokenId.slice(0, 8)}… (migration)`),
          );
        }
      } catch (err) {
        console.log(
          chalk.yellow(
            `  · Couldn't revoke legacy user-token ${legacyTokenId.slice(0, 8)}…: ${(err as Error).message.split("\n")[0]}`,
          ),
        );
        console.log(
          chalk.dim(
            `    Revoke manually at https://dash.cloudflare.com/profile/api-tokens (search for "hatchkit-${projectName}").`,
          ),
        );
      }
    }
    await deleteSecret(SECRET_KEYS.s3ProjectAccessKey(provider, projectName));
    await deleteSecret(SECRET_KEYS.s3ProjectSecretKey(provider, projectName));
    await deleteSecret(SECRET_KEYS.s3ProjectTokenId(provider, projectName));
  }

  let projectAccessKey: string | undefined;
  let projectSecretKey: string | undefined;
  let projectTokenId: string | undefined = canReuseExisting ? existingTokenId : undefined;
  let tokenCreated: { tokenId: string; audience: "account" } | null = null;

  if (!canReuseExisting && !reusingExternalCreds) {
    // Revoke a stale manifest token (status disabled/expired/404)
    // before minting its replacement so we don't pile up orphans.
    if (existingTokenId && existingAccountId) {
      try {
        await cf.deleteAccountToken(existingAccountId, existingTokenId);
      } catch {
        /* best-effort */
      }
    }

    const tokenSpinner = ora(
      `Minting R2 account API token (scoped to ${includeStateBucket ? `${assetsBucketName} + ${stateBucketName}` : assetsBucketName})`,
    ).start();
    try {
      const minted = await cf.createR2AccountToken({
        accountId,
        name: `hatchkit-${projectName}`,
        bucketNames: includeStateBucket ? [assetsBucketName, stateBucketName] : [assetsBucketName],
        permissions: "read-write",
      });
      projectAccessKey = minted.accessKeyId;
      projectSecretKey = minted.secretAccessKey;
      projectTokenId = minted.tokenId;
      tokenCreated = { tokenId: minted.tokenId, audience: "account" };
      tokenSpinner.succeed(
        `Minted R2 account token (id ${minted.tokenId.slice(0, 8)}…, visible in R2 → Manage R2 API Tokens)`,
      );
    } catch (err) {
      tokenSpinner.fail("Failed to mint R2 account API token");
      const msg = (err as Error).message;
      if (/9109|10000|10001|403|invalid api token/i.test(msg)) {
        throw new Error(
          `${msg}\n\n  → Your admin token (s3:r2:admin-token) needs:\n    · Account > Workers R2 Storage > Edit  (create buckets / list them)\n    · Account Settings > Edit               (mint per-project account tokens — was missing)\n  → Edit at https://dash.cloudflare.com/profile/api-tokens, save, re-run.`,
        );
      }
      throw err;
    }
  }

  // 5. Seed `.env.production` with the credentials + URLs. Names are
  //    chosen by the prefix the project's runtime actually reads —
  //    detected from `.env.example` etc.
  const envPrefix = opts.envPrefix ?? detectEnvPrefix(opts.projectDir);
  const keys = envKeysForPrefix(envPrefix);
  const envPath = join(opts.projectDir, ".env.production");

  const existingKeys = existingEnvKeys(envPath);

  const toWrite: Array<{ key: string; value: string }> = [];
  const skip = (key: string): boolean => existingKeys.has(key);

  // ENDPOINT and REGION re-write on every run (cheap; values are
  // stable). REGION is "auto" for R2 — the SDK ignores it anyway when
  // an explicit endpoint is given, but setting it suppresses an
  // `AWS_REGION` warning at runtime.
  //
  // ACCESS_KEY + SECRET_KEY are the freshly-minted token's S3 derivation
  // — only present when we actually minted (i.e. !canReuseExisting).
  // On reuse, we leave the existing encrypted values in .env.production
  // alone (Cloudflare doesn't expose the secret-access-key after
  // creation, so the file IS the source of truth for these two).
  toWrite.push({ key: keys.endpoint, value: meta.endpoint });
  if (projectAccessKey && projectSecretKey) {
    toWrite.push({ key: keys.accessKey, value: projectAccessKey });
    toWrite.push({ key: keys.secretKey, value: projectSecretKey });
  }
  toWrite.push({ key: keys.region, value: meta.region ?? "auto" });

  // BUCKET name — keys.bucket is "<PREFIX>_STATE_BUCKET" for R2 (the
  // private bucket is the only one a server lib reads through env;
  // assets are URL-driven). For S3/AWS prefixes the canonical key is
  // <PREFIX>_BUCKET_NAME pointing at the assets bucket. Match the
  // semantics of each prefix.
  //
  // R2 + no state bucket: skip the R2_STATE_BUCKET write entirely —
  // there is no private bucket to point at, and seeding an empty/dummy
  // value would just be a footgun later.
  if (envPrefix === "R2") {
    if (includeStateBucket) {
      toWrite.push({ key: keys.bucket, value: stateBucketName });
    }
  } else {
    toWrite.push({ key: keys.bucket, value: assetsBucketName });
  }

  // Public URL — only seed if the project's runtime reads the
  // matching key. Detected via `.env.example` keys for both the
  // primary (`NEXT_PUBLIC_ASSETS_BASE_URL`) and the prefixed fallback.
  // Always write it under NEXT_PUBLIC_ASSETS_BASE_URL when present in
  // .env.example since that's the next.js convention; under
  // <PREFIX>_PUBLIC_URL for non-Next projects.
  const examplePath = join(opts.projectDir, ".env.example");
  const exampleText = existsSync(examplePath) ? readFileSync(examplePath, "utf-8") : "";
  const usesNextPublicAssets = /NEXT_PUBLIC_ASSETS_BASE_URL/.test(exampleText);
  if (usesNextPublicAssets) {
    toWrite.push({ key: "NEXT_PUBLIC_ASSETS_BASE_URL", value: publicUrl });
  } else if (envPrefix === "S3" || envPrefix === "AWS") {
    toWrite.push({ key: keys.publicUrl, value: publicUrl });
  }

  // CRON_SECRET — the project's .env.example documents one if it has
  // a cron route. Generate fresh, encrypt. Skip if already set.
  if (
    opts.generateCronSecret !== false &&
    /CRON_SECRET/.test(exampleText) &&
    !skip("CRON_SECRET")
  ) {
    const { randomBytes } = await import("node:crypto");
    toWrite.push({ key: "CRON_SECRET", value: randomBytes(32).toString("hex") });
  }

  const envWritten: string[] = [];
  const envKept: string[] = [];
  const envSpinner = ora(`Writing ${toWrite.length} entries to .env.production`).start();
  try {
    for (const { key, value } of toWrite) {
      // Idempotency: re-write everything except CRON_SECRET (treated
      // above) on every run. dotenvx.set overwrites in place, so
      // values stay singletons in the file.
      if (key === "CRON_SECRET" && skip(key)) {
        envKept.push(key);
        continue;
      }
      dotenvxSet(key, value, { path: envPath, encrypt: true });
      envWritten.push(key);
    }
    envSpinner.succeed(`Wrote ${envWritten.length} encrypted entries to .env.production`);
  } catch (err) {
    envSpinner.fail("Could not write .env.production");
    throw err;
  }

  // 6. Record bucket names + public URL + token id in the manifest so
  //    re-runs don't have to re-derive them and a future
  //    `hatchkit destroy` knows what to clean up. Preserve a
  //    previously-recorded `state` entry when the current run didn't
  //    create one — the bucket may still exist from an earlier
  //    `--with-state-bucket` provision. Always pin the token id +
  //    accountId so destroy can revoke even after credentials get
  //    rotated.
  if (!projectTokenId && !reusingExternalCreds) {
    // Defensive: every code path above either reuses a known token
    // (`canReuseExisting === true`, sets projectTokenId), mints (also
    // sets projectTokenId), or reuses untracked env creds
    // (reusingExternalCreds → no tokenId is acceptable). If we got
    // here without one, we'd write a manifest with no token id and
    // no clean way to recover.
    throw new Error(
      "Internal: provisionS3ForProject ended without a token id. This is a bug — please file an issue.",
    );
  }
  const updated: ProjectManifest = {
    ...manifest,
    s3Buckets: {
      assets: {
        name: assetsBucketName,
        publicUrl,
        ...(appliedCors ? { cors: appliedCors } : {}),
      },
      ...(includeStateBucket
        ? { state: { name: stateBucketName, publicUrl: null as null } }
        : manifest.s3Buckets?.state
          ? { state: manifest.s3Buckets.state }
          : {}),
      ...(projectTokenId ? { tokenId: projectTokenId } : {}),
      accountId,
    },
  };
  writeManifest(opts.projectDir, updated);
  console.log(chalk.dim(`  · Recorded bucket names in ${MANIFEST_FILENAME} (${publicUrlSource}).`));

  return {
    assets: {
      name: assetsBucketName,
      publicUrl,
      created: !assetsBucket.existed,
      cors: appliedCors,
    },
    state:
      includeStateBucket && stateBucket
        ? { name: stateBucketName, created: !stateBucket.existed }
        : null,
    envWritten,
    envKept,
    accountId,
    tokenCreated,
    legacyUserTokenMigrated,
  };
}

/** Pick the registrable zone name for a hostname. Cloudflare keeps
 *  zones at the registrable level (example.com), so to attach
 *  `s3.foo.example.com` we look up `example.com`. Two-label
 *  apex stays as-is. This is the same shape the existing DNS code
 *  uses; see `cli/src/deploy/coolify-app.ts` for parallels. */
function pickClosestZoneName(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

/** The default custom-domain hostname for the assets bucket. Sits at
 *  `assets.<project-domain>` so e.g. a project on `shop.example.com`
 *  gets `assets.shop.example.com`. Matches the canonical purpose
 *  of the bucket (NEXT_PUBLIC_ASSETS_BASE_URL) and the existing
 *  `assets` key in the manifest's `s3Buckets`. Exposed for callers
 *  that want to show this as the default in an interactive prompt.
 *
 *  Existing scaffolds that landed on `s3.<domain>` keep working —
 *  `existingCustomHostname` reads the recorded `publicUrl` from the
 *  manifest and re-runs of `hatchkit provision s3` reuse it instead
 *  of switching the bucket's domain mid-flight. */
export function defaultBucketHostname(domain: string): string {
  return `assets.${domain}`;
}

// ---------------------------------------------------------------------------
// Bucket CORS — desired-state computation + reconcile
// ---------------------------------------------------------------------------
//
// The single rule that lands on the bucket is the union of:
//   1. https://<manifest.domain>            — production site
//   2. http://localhost:<server>/<client>   — `pnpm dev` against prod assets
//   3. extras passed in via --cors-origin   — staging/preview domains, etc.
//
// A `www.<domain>` entry is intentionally NOT added by default — hatchkit
// doesn't ship a www-redirect by default, so most projects don't have a
// `www.` host that ever issues fetch() against the bucket. Users who do
// run a www variant should pass `--cors-origin https://www.<domain>`.
//
// Methods default to GET + HEAD because the assets bucket is read-only
// from the browser's perspective (uploads, when added, would happen via
// signed POSTs through the server, not direct browser PUT). ExposeHeaders
// covers progress UIs (Content-Length / Content-Type) and ETag-based
// service-worker / HTTP-cache flows. maxAgeSeconds=86400 means the
// browser only re-OPTIONS the bucket once a day per origin — without
// it, every fetched asset triggers a preflight.

/** Build the desired CORS rule for the assets bucket from the manifest
 *  state + caller-supplied extras. Pure function — no API calls. */
export function buildDesiredCors(args: {
  manifest: ProjectManifest;
  extras?: string[];
  allowAll?: boolean;
}): { rule: R2CorsRule; origins: string[]; methods: string[]; maxAgeSeconds: number } {
  const methods = ["GET", "HEAD"];
  const maxAgeSeconds = 86400;
  if (args.allowAll) {
    return {
      rule: {
        allowed: { origins: ["*"], methods, headers: ["*"] },
        exposeHeaders: ["Content-Length", "Content-Type", "ETag"],
        maxAgeSeconds,
      },
      origins: ["*"],
      methods,
      maxAgeSeconds,
    };
  }

  const origins = new Set<string>();
  origins.add(`https://${args.manifest.domain}`);

  // Localhost dev origins — only one of {server,client} is added when
  // they're equal (e.g. a Next.js project that proxies /api/* through
  // the same port). Avoids a redundant duplicate in the resolved list.
  const ports = args.manifest.ports;
  if (ports?.client) {
    origins.add(`http://localhost:${ports.client}`);
  }
  if (ports?.server && ports.server !== ports.client) {
    origins.add(`http://localhost:${ports.server}`);
  }

  for (const e of args.extras ?? []) {
    const trimmed = e.trim();
    if (trimmed) origins.add(trimmed);
  }

  const sorted = [...origins].sort();
  return {
    rule: {
      allowed: { origins: sorted, methods, headers: ["*"] },
      exposeHeaders: ["Content-Length", "Content-Type", "ETag"],
      maxAgeSeconds,
    },
    origins: sorted,
    methods,
    maxAgeSeconds,
  };
}

/** GET → diff → PUT. Returns the BucketCors entry to record in the
 *  manifest. Surfaces progress via ora — the caller has a spinner
 *  context (provisionS3ForProject) where one extra line slots in
 *  cleanly between bucket-create and token-mint. */
export async function reconcileBucketCors(
  cf: CloudflareApi,
  accountId: string,
  bucketName: string,
  desired: { rule: R2CorsRule; origins: string[]; methods: string[]; maxAgeSeconds: number },
  extras: string[],
): Promise<BucketCors> {
  const spinner = ora(
    `Reconciling CORS on ${bucketName} (${desired.origins.length} origin(s))`,
  ).start();
  try {
    const live = await cf.getR2BucketCors(accountId, bucketName);
    if (live && corsRuleMatches(live, desired.rule)) {
      spinner.succeed(`CORS up to date on ${bucketName} (${desired.origins.length} origin(s))`);
    } else {
      await cf.putR2BucketCors(accountId, bucketName, [desired.rule]);
      spinner.succeed(
        live
          ? `CORS updated on ${bucketName} (${desired.origins.length} origin(s))`
          : `CORS applied to ${bucketName} (${desired.origins.length} origin(s))`,
      );
    }
  } catch (err) {
    spinner.fail("CORS reconcile failed");
    const msg = (err as Error).message;
    if (/403|10001|permission|invalid/i.test(msg)) {
      throw new Error(
        `${msg}\n\n  → Cloudflare token is missing the "Workers R2 Storage: Edit" permission for CORS.\n  → Edit it at https://dash.cloudflare.com/profile/api-tokens, then re-run.`,
      );
    }
    throw err;
  }

  return {
    origins: desired.origins,
    methods: desired.methods,
    maxAgeSeconds: desired.maxAgeSeconds,
    ...(extras.length > 0 ? { extraOrigins: [...extras].sort() } : {}),
  };
}

/** Stable comparison between the live rule list and a single desired
 *  rule. Cloudflare echoes back exactly what was PUT, but order +
 *  optional fields can drift, so we normalise both sides. */
function corsRuleMatches(live: R2CorsRule[], desired: R2CorsRule): boolean {
  if (live.length !== 1) return false;
  const a = normalizeCorsRule(live[0]);
  const b = normalizeCorsRule(desired);
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeCorsRule(r: R2CorsRule): R2CorsRule {
  return {
    allowed: {
      origins: [...(r.allowed.origins ?? [])].sort(),
      methods: [...(r.allowed.methods ?? [])].sort(),
      headers: [...(r.allowed.headers ?? [])].sort(),
    },
    exposeHeaders: [...(r.exposeHeaders ?? [])].sort(),
    maxAgeSeconds: r.maxAgeSeconds ?? 0,
  };
}

/** Reconcile bucket CORS using the state already in the manifest +
 *  global config, without minting tokens or touching .env. Used by
 *  `hatchkit rename-domain` after the manifest's `domain` has been
 *  rewritten — the new `https://<domain>` belongs in the bucket's
 *  origin list before the user redeploys.
 *
 *  Best-effort: returns null + logs a hint instead of throwing on
 *  missing config / missing manifest fields. The rename-domain caller
 *  only runs as a follow-up bonus to its file rewrites; failing the
 *  whole rename because the keychain is empty would be over-eager. */
export async function reconcileAssetsCorsFromManifest(
  projectDir: string,
): Promise<BucketCors | null> {
  const manifest = readManifest(projectDir);
  if (!manifest?.s3Buckets?.assets?.name) return null;
  if (manifest.s3Buckets.assets.cors?.skipped === true) return null;

  const accountId =
    manifest.s3Buckets.accountId ??
    (await (async () => {
      const { getStore } = await import("../config.js");
      const meta = getStore().get("providers.s3.r2") as { endpoint?: string } | undefined;
      if (!meta?.endpoint) return undefined;
      try {
        return accountIdFromR2Endpoint(meta.endpoint);
      } catch {
        return undefined;
      }
    })());
  if (!accountId) return null;

  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) return null;

  const cf = new CloudflareApi({ token: adminToken });
  const extras = manifest.s3Buckets.assets.cors?.extraOrigins ?? [];
  const desired = buildDesiredCors({ manifest, extras });
  const applied = await reconcileBucketCors(
    cf,
    accountId,
    manifest.s3Buckets.assets.name,
    desired,
    extras,
  );

  // Persist the new resolved origin list into the manifest so a
  // subsequent `hatchkit doctor` doesn't immediately flag drift.
  const next: ProjectManifest = {
    ...manifest,
    s3Buckets: {
      ...manifest.s3Buckets,
      assets: {
        ...manifest.s3Buckets.assets,
        cors: applied,
      },
    },
  };
  writeManifest(projectDir, next);
  return applied;
}

/** If a previous run already attached a custom domain to the assets
 *  bucket, surface that hostname so re-runs can default the prompt
 *  to it (instead of the freshly-computed `assets.<domain>`). Returns
 *  null when the manifest only records a managed r2.dev URL. */
export function existingCustomHostname(manifest: ProjectManifest): string | null {
  const url = manifest.s3Buckets?.assets?.publicUrl;
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (host.endsWith(".r2.dev")) return null;
  return host;
}
