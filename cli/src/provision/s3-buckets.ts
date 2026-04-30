/*
 * S3/R2 bucket provisioning for adopted projects.
 *
 * Closes the gap between `hatchkit config add s3 r2` (which only stores
 * credentials in the global config + keychain) and a project that
 * actually needs working buckets + env wiring at runtime. Splits the
 * provisioning into two clear roles:
 *
 *   · "assets"  — public, hot path. Fronts large pre-built media
 *                 (AVIF/WebP/originals). Public URL goes into a
 *                 NEXT_PUBLIC_ASSETS_BASE_URL-style env var so the
 *                 client can fetch directly.
 *   · "state"   — private, cold. Used for small server-side files
 *                 (cron state, audit logs). Never publicly reachable.
 *
 * Public URL strategy for the assets bucket, in order:
 *   1. Custom domain on a Cloudflare zone the user owns
 *      (`assets.<project-domain>` or a caller-provided override) —
 *      preferred long-term, no `r2.dev` rate limits.
 *   2. Managed `pub-<hash>.r2.dev` domain — fallback when no zone
 *      matches the project's domain.
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
  MANIFEST_FILENAME,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "../scaffold/manifest.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

export type EnvPrefix = "R2" | "S3" | "AWS";

export interface ProvisionS3Opts {
  projectDir: string;
  /** Provider key under config.providers.s3.<provider>. Default "r2". */
  provider?: string;
  /** Override auto-detected env-var prefix. */
  envPrefix?: EnvPrefix;
  /** Override the public hostname for the assets bucket. When unset:
   *  · if the project's domain has a Cloudflare zone, use `assets.<domain>`
   *  · else fall back to the managed `pub-<hash>.r2.dev` URL. */
  publicHostname?: string;
  /** Override bucket names. Defaults to <projectName>-assets / -state. */
  assetsBucketName?: string;
  stateBucketName?: string;
  /** R2 location hint. Default "weur" (Western Europe — closest to
   *  Hetzner Nuremberg, where the typical hatchkit deploy lives). */
  locationHint?: string;
  /** When true, generate a fresh CRON_SECRET and write it alongside
   *  the bucket env vars. Default true. */
  generateCronSecret?: boolean;
}

export interface ProvisionS3Result {
  assets: { name: string; publicUrl: string; created: boolean };
  state: { name: string; created: boolean };
  envWritten: string[];
  /** Existing keys we left alone (already encrypted in the file). */
  envKept: string[];
  /** rclone snippet the user should paste into their rclone.conf. */
  rcloneSnippet: string;
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
function existingEnvKeys(envPath: string): Set<string> {
  if (!existsSync(envPath)) return new Set();
  const text = readFileSync(envPath, "utf-8");
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** Build the rclone config snippet the user can paste into
 *  `~/.config/rclone/rclone.conf`. Keeps this OUT of the file system
 *  (the user's existing rclone config has other remotes — we don't
 *  want to mangle them). */
function buildRcloneSnippet(opts: {
  remoteName: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
}): string {
  return [
    `[${opts.remoteName}]`,
    `type = s3`,
    `provider = Cloudflare`,
    `access_key_id = ${opts.accessKey}`,
    `secret_access_key = ${opts.secretKey}`,
    `endpoint = ${opts.endpoint}`,
    `acl = private`,
    `no_check_bucket = true`,
    "",
  ].join("\n");
}

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
      "R2 admin token not configured. Run `hatchkit provision s3` interactively, " +
        "or pre-set with: hatchkit config add s3 (TODO) — needs Account > Workers R2 Storage > Edit.",
    );
  }

  // For the zone lookup (custom-domain attach) we need the DNS token's
  // Zone:Zone:Read; the admin token may or may not have it. Use whichever
  // we have available, preferring the DNS token because that's the one
  // that's been verified for zone reads in `hatchkit doctor`.
  const zoneToken = dns?.provider === "cloudflare" ? (dns.apiToken ?? adminToken) : adminToken;
  const cf = new CloudflareApi({ token: adminToken });
  const cfZone = new CloudflareApi({ token: zoneToken });

  const projectName = manifest.name;
  const domain = manifest.domain;
  const assetsBucketName = opts.assetsBucketName ?? `${projectName}-assets`;
  const stateBucketName = opts.stateBucketName ?? `${projectName}-state`;
  const locationHint = opts.locationHint ?? "weur";

  // 1. Create the two buckets (idempotent).
  const spinner = ora(`Creating R2 buckets (${assetsBucketName}, ${stateBucketName})`).start();
  let assetsBucket: { existed: boolean };
  let stateBucket: { existed: boolean };
  try {
    assetsBucket = await cf.createR2Bucket(accountId, assetsBucketName, { locationHint });
    stateBucket = await cf.createR2Bucket(accountId, stateBucketName, { locationHint });
    spinner.succeed(
      `R2 buckets ready — ${assetsBucketName} (${assetsBucket.existed ? "exists" : "created"}), ${stateBucketName} (${stateBucket.existed ? "exists" : "created"})`,
    );
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
  let publicUrl: string | undefined;
  let publicUrlSource: "custom-domain" | "managed-r2dev" | undefined;

  // Pick the hostname. Default `assets.<domain>`; allow caller override.
  const customHostname = opts.publicHostname ?? `assets.${domain}`;
  // Find the closest matching zone (the registrable name — last
  // two labels of the host, or the host itself if the user passed a
  // bare apex).
  const zoneName = pickClosestZoneName(customHostname);

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
    }
  } catch (err) {
    // Zone lookup is best-effort. Don't fail the whole flow on it.
    console.log(
      chalk.dim(`  · Zone lookup for ${zoneName} failed: ${(err as Error).message.split("\n")[0]}`),
    );
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

  // 3. Mint a per-project R2 API token scoped to just these two
  //    buckets. Returns the S3-style access/secret pair (access =
  //    token id, secret = sha256(token value)). Re-mint on every
  //    re-run — keychain holds the canonical copy and idempotency
  //    on the CF side is good enough that the worst case is a few
  //    orphaned old tokens (cleaned up by `hatchkit destroy`).
  //
  //    If a token already exists in keychain for this project, REUSE
  //    it instead of re-minting. This keeps `hatchkit provision s3`
  //    idempotent w/r/t the user's CF account (no token churn) and
  //    means rotating credentials is an explicit `--rotate` step
  //    rather than a side effect.
  const existingProjectAccess = await getSecret(
    SECRET_KEYS.s3ProjectAccessKey(provider, projectName),
  );
  const existingProjectSecret = await getSecret(
    SECRET_KEYS.s3ProjectSecretKey(provider, projectName),
  );
  let projectAccessKey: string;
  let projectSecretKey: string;
  let projectTokenId: string | undefined;
  if (existingProjectAccess && existingProjectSecret) {
    projectAccessKey = existingProjectAccess;
    projectSecretKey = existingProjectSecret;
    projectTokenId =
      (await getSecret(SECRET_KEYS.s3ProjectTokenId(provider, projectName))) ?? undefined;
    console.log(
      chalk.dim(
        `  · Reusing existing per-project R2 credentials (keychain ${SECRET_KEYS.s3ProjectAccessKey(provider, projectName)})`,
      ),
    );
  } else {
    const tokenSpinner = ora(
      `Minting per-project R2 API token (scoped to those 2 buckets)`,
    ).start();
    try {
      const minted = await cf.createR2ApiToken({
        accountId,
        name: `hatchkit-${projectName}`,
        bucketNames: [assetsBucketName, stateBucketName],
        permissions: "read-write",
      });
      projectAccessKey = minted.accessKeyId;
      projectSecretKey = minted.secretAccessKey;
      projectTokenId = minted.tokenId;
      await setSecret(SECRET_KEYS.s3ProjectAccessKey(provider, projectName), minted.accessKeyId);
      await setSecret(
        SECRET_KEYS.s3ProjectSecretKey(provider, projectName),
        minted.secretAccessKey,
      );
      await setSecret(SECRET_KEYS.s3ProjectTokenId(provider, projectName), minted.tokenId);
      tokenSpinner.succeed(
        `Minted scoped R2 API token (id ${minted.tokenId.slice(0, 8)}…, stored in keychain)`,
      );
    } catch (err) {
      tokenSpinner.fail("Failed to mint per-project R2 API token");
      const msg = (err as Error).message;
      if (/9109|10000|403|invalid api token/i.test(msg)) {
        throw new Error(
          `${msg}\n\n  → Your admin token (s3:r2:admin-token) needs BOTH:\n    · Account > Workers R2 Storage > Edit\n    · User > API Tokens > Edit  (this is what's missing)\n  → Edit at https://dash.cloudflare.com/profile/api-tokens, save, re-run.`,
        );
      }
      throw err;
    }
  }

  // 4. Seed `.env.production` with the credentials + URLs. Names are
  //    chosen by the prefix the project's runtime actually reads —
  //    detected from `.env.example` etc.
  const envPrefix = opts.envPrefix ?? detectEnvPrefix(opts.projectDir);
  const keys = envKeysForPrefix(envPrefix);
  const envPath = join(opts.projectDir, ".env.production");

  const existingKeys = existingEnvKeys(envPath);

  const toWrite: Array<{ key: string; value: string }> = [];
  const skip = (key: string): boolean => existingKeys.has(key);

  // ENDPOINT, ACCESS_KEY, SECRET_KEY, REGION are credentials that
  // the runtime always needs. Re-write on every run (cheap, and the
  // user might've rotated keys). REGION is "auto" for R2 — the SDK
  // ignores it anyway when an explicit endpoint is given, but
  // setting it suppresses an `AWS_REGION` warning at runtime.
  toWrite.push({ key: keys.endpoint, value: meta.endpoint });
  toWrite.push({ key: keys.accessKey, value: projectAccessKey });
  toWrite.push({ key: keys.secretKey, value: projectSecretKey });
  toWrite.push({ key: keys.region, value: meta.region ?? "auto" });

  // BUCKET name — keys.bucket is "<PREFIX>_STATE_BUCKET" for R2 (the
  // private bucket is the only one a server lib reads through env;
  // assets are URL-driven). For S3/AWS prefixes the canonical key is
  // <PREFIX>_BUCKET_NAME pointing at the assets bucket. Match the
  // semantics of each prefix.
  if (envPrefix === "R2") {
    toWrite.push({ key: keys.bucket, value: stateBucketName });
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

  // 4. Record bucket names + public URL in the manifest so re-runs
  //    don't have to re-derive them and a future `hatchkit destroy`
  //    knows what to clean up.
  const updated: ProjectManifest = {
    ...manifest,
    s3Buckets: {
      assets: { name: assetsBucketName, publicUrl },
      state: { name: stateBucketName, publicUrl: null },
    },
  };
  writeManifest(opts.projectDir, updated);
  console.log(chalk.dim(`  · Recorded bucket names in ${MANIFEST_FILENAME} (${publicUrlSource}).`));

  // 5. rclone snippet (printed by caller, returned here so callers
  //    can capture it programmatically too). Uses the per-project
  //    scoped credentials we just minted — anyone running rclone
  //    against this remote can only touch this project's two buckets.
  //    Don't write the snippet to disk; the user's existing rclone
  //    config has unrelated remotes and we don't want to mangle them.
  const rcloneSnippet = buildRcloneSnippet({
    remoteName: `r2-${projectName}`,
    endpoint: meta.endpoint,
    accessKey: projectAccessKey,
    secretKey: projectSecretKey,
  });

  return {
    assets: { name: assetsBucketName, publicUrl, created: !assetsBucket.existed },
    state: { name: stateBucketName, created: !stateBucket.existed },
    envWritten,
    envKept,
    rcloneSnippet,
  };
}

/** Pick the registrable zone name for a hostname. Cloudflare keeps
 *  zones at the registrable level (example.com), so to attach
 *  `assets.foo.example.com` we look up `example.com`. Two-label
 *  apex stays as-is. This is the same shape the existing DNS code
 *  uses; see `cli/src/deploy/coolify-app.ts` for parallels. */
function pickClosestZoneName(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}
