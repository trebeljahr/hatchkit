/*
 * S3 / R2 token provisioning for the `hatchkit add` flow.
 *
 * Sister flow to `hatchkit provision s3` (s3-buckets.ts), which creates
 * the bucket pair and mints a single shared token. THIS flow is the
 * "buckets already exist; just give me scoped credentials" path. It's
 * what runs when the project's `.hatchkit.json` declares `s3Buckets`
 * (e.g. `s3Provider: "existing"`) and the user runs:
 *
 *   hatchkit add <project> s3
 *
 * For each bucket entry in the manifest, we mint a Cloudflare R2 API
 * token scoped to that bucket only (Read + Write). One token per
 * bucket — narrower blast radius than a single multi-bucket token, and
 * matches the `R2_<NAME>_*` env-var naming the runtime expects.
 *
 * Idempotency: if a per-bucket token already lives in the OS keychain
 * for this project+bucket, we reuse it (skip the mint, write the same
 * env values). Re-runs after a partial failure will still write missing
 * vars without churning CF tokens.
 *
 * Inverse: `unprovisionR2BucketTokens` — deletes each token via
 * DELETE /user/tokens/<id> and clears the keychain entries. Called by
 * `hatchkit remove <project> s3`.
 */

import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import {
  SECRET_KEYS,
  deleteSecret,
  getSecret,
  listSecretAccounts,
  setSecret,
} from "../utils/secrets.js";
import { accountIdFromR2Endpoint } from "./s3-buckets.js";

/** One bucket entry from `.hatchkit.json` paired with its minted creds. */
export interface R2BucketToken {
  /** Manifest key, e.g. "assets". Drives the env-var name prefix. */
  bucketKey: string;
  /** Actual R2 bucket name, e.g. "collection-of-beauty-assets". */
  bucketName: string;
  /** S3 Access Key ID (= the CF API token id). */
  accessKeyId: string;
  /** S3 Secret Access Key (= sha256 of the CF token value). */
  secretAccessKey: string;
  /** CF API token id, kept so destroy can DELETE it. */
  tokenId: string;
  /** True if the token was minted on this run; false if reused from
   *  the keychain. */
  minted: boolean;
}

export interface ProvisionR2TokensResult {
  /** Account-wide R2 S3 endpoint (`https://<id>.r2.cloudflarestorage.com`). */
  endpoint: string;
  /** Per-bucket minted (or reused) creds. Order follows the manifest's
   *  alphabetical bucket-key order so re-runs produce stable diffs. */
  bucketTokens: R2BucketToken[];
}

export interface ProvisionR2TokensOpts {
  /** Project name. Used to scope keychain entries + token names. */
  projectName: string;
  /** Project directory. Manifest is read from `<projectDir>/.hatchkit.json`. */
  projectDir: string;
}

/** Mint (or reuse) a per-bucket scoped R2 API token for every bucket
 *  declared in `.hatchkit.json` → `s3Buckets`. Returns the endpoint +
 *  per-bucket S3-style credential pairs ready for the env writer. */
export async function provisionR2BucketTokens(
  opts: ProvisionR2TokensOpts,
): Promise<ProvisionR2TokensResult> {
  const provider = "r2";
  const manifest = readManifest(opts.projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json in ${opts.projectDir}. Run \`hatchkit adopt\` (or move into the project directory) first.`,
    );
  }

  // Manifest's S3 provider must be R2-compatible. `existing` is the
  // primary user-facing case (buckets pre-created elsewhere); `r2`
  // means hatchkit created them itself. Both go through the same
  // token-minting code path.
  if (manifest.s3Provider !== "existing" && manifest.s3Provider !== "r2") {
    if (manifest.s3Provider === "hetzner" || manifest.s3Provider === "aws") {
      throw new Error(
        `s3Provider "${manifest.s3Provider}" is not yet supported by \`hatchkit add s3\`. Only Cloudflare R2 (provider "r2" or "existing") can mint scoped tokens today.`,
      );
    }
    throw new Error(
      `s3Provider "${manifest.s3Provider}" — nothing to provision. Add s3Buckets to .hatchkit.json or run \`hatchkit provision s3\`.`,
    );
  }

  const buckets = enumerateBuckets(manifest);
  if (buckets.length === 0) {
    throw new Error(
      `No s3Buckets declared in ${join(opts.projectDir, ".hatchkit.json")}. Add at least one bucket entry (e.g. "assets": { "name": "<bucket>", "publicUrl": "..." }) and re-run.`,
    );
  }

  // Pull provider metadata (endpoint) from the global config store.
  // We don't require the legacy account-wide access/secret pair —
  // every credential here is per-project per-bucket and minted fresh.
  const { getStore } = await import("../config.js");
  const meta = getStore().get(`providers.s3.${provider}`) as
    | { status?: string; endpoint?: string }
    | undefined;
  if (!meta || meta.status !== "configured" || !meta.endpoint) {
    throw new Error(
      `R2 provider is not configured globally. Run \`hatchkit config add s3 r2\` to paste the admin token + endpoint, then re-run.`,
    );
  }
  const accountId = accountIdFromR2Endpoint(meta.endpoint);

  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    throw new Error(
      "R2 admin token missing from the keychain. Run `hatchkit config add s3 r2` to paste + verify it, then re-run.",
    );
  }
  const cf = new CloudflareApi({ token: adminToken });

  const bucketTokens: R2BucketToken[] = [];
  for (const bucket of buckets) {
    const akKey = SECRET_KEYS.s3ProjectBucketAccessKey(provider, opts.projectName, bucket.key);
    const skKey = SECRET_KEYS.s3ProjectBucketSecretKey(provider, opts.projectName, bucket.key);
    const idKey = SECRET_KEYS.s3ProjectBucketTokenId(provider, opts.projectName, bucket.key);

    const existingAccess = await getSecret(akKey);
    const existingSecret = await getSecret(skKey);
    const existingTokenId = await getSecret(idKey);

    if (existingAccess && existingSecret) {
      bucketTokens.push({
        bucketKey: bucket.key,
        bucketName: bucket.name,
        accessKeyId: existingAccess,
        secretAccessKey: existingSecret,
        tokenId: existingTokenId ?? "",
        minted: false,
      });
      continue;
    }

    const spinner = ora(
      `R2: minting scoped token for bucket ${chalk.cyan(bucket.name)} (${bucket.key})`,
    ).start();
    try {
      const minted = await cf.createR2ApiToken({
        accountId,
        name: `hatchkit-${opts.projectName}-${bucket.key}`,
        bucketNames: [bucket.name],
        permissions: "read-write",
      });
      await setSecret(akKey, minted.accessKeyId);
      await setSecret(skKey, minted.secretAccessKey);
      await setSecret(idKey, minted.tokenId);
      bucketTokens.push({
        bucketKey: bucket.key,
        bucketName: bucket.name,
        accessKeyId: minted.accessKeyId,
        secretAccessKey: minted.secretAccessKey,
        tokenId: minted.tokenId,
        minted: true,
      });
      spinner.succeed(
        `R2: minted scoped token for ${bucket.name} (id ${minted.tokenId.slice(0, 8)}…)`,
      );
    } catch (err) {
      spinner.fail(`R2: minting token for ${bucket.name} failed`);
      const msg = (err as Error).message;
      if (/9109|10000|403|invalid api token/i.test(msg)) {
        throw new Error(
          `${msg}\n\n  → The admin token (s3:r2:admin-token) needs BOTH:\n    · Account > Workers R2 Storage > Edit\n    · User > API Tokens > Edit  (commonly the missing one)\n  → Edit at https://dash.cloudflare.com/profile/api-tokens, save, re-run.`,
        );
      }
      throw err;
    }
  }

  return { endpoint: meta.endpoint, bucketTokens };
}

/** Convert a `provisionR2BucketTokens` result into the KEY=VALUE lines
 *  the orchestrator writes to `.env.production`. Names follow the
 *  R2_ prefix convention; for projects with a single bucket we ALSO
 *  emit unprefixed `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` aliases
 *  so existing single-bucket runtimes (which expect the unprefixed
 *  form) keep working without code changes. */
export function renderR2BucketTokensEnv(result: ProvisionR2TokensResult): string[] {
  const lines: string[] = [];
  lines.push(`R2_ENDPOINT=${result.endpoint}`);

  for (const bt of result.bucketTokens) {
    const name = bt.bucketKey.toUpperCase();
    lines.push(`R2_${name}_BUCKET=${bt.bucketName}`);
    lines.push(`R2_${name}_ACCESS_KEY_ID=${bt.accessKeyId}`);
    lines.push(`R2_${name}_SECRET_ACCESS_KEY=${bt.secretAccessKey}`);
  }

  // Single-bucket alias. Most single-bucket consumers (Next.js apps,
  // standalone sync scripts) read R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
  // directly without the bucket-name segment. Skip when there's
  // ambiguity (multi-bucket).
  if (result.bucketTokens.length === 1) {
    const sole = result.bucketTokens[0];
    lines.push(`R2_ACCESS_KEY_ID=${sole.accessKeyId}`);
    lines.push(`R2_SECRET_ACCESS_KEY=${sole.secretAccessKey}`);
  }

  return lines;
}

export type DeleteResult = "deleted" | "not-found";

export interface UnprovisionR2TokensResult {
  /** Per-bucket teardown outcome (one entry per declared bucket key). */
  buckets: Array<{ bucketKey: string; outcome: DeleteResult }>;
}

/** Delete every per-bucket scoped R2 token minted for this project,
 *  both upstream (CF API) and locally (keychain). Idempotent — missing
 *  upstream tokens count as `not-found`.
 *
 *  Discovery order: manifest first (precise; we know which buckets the
 *  project declared), then a keychain sweep (catches strays — e.g. a
 *  bucket entry was removed from the manifest before unprovision ran,
 *  but the token still exists upstream). The union ensures we never
 *  leave orphaned tokens in the user's CF account. */
export async function unprovisionR2BucketTokens(opts: {
  projectName: string;
  /** Optional — when known, the manifest at `<projectDir>/.hatchkit.json`
   *  is consulted first to enumerate buckets. Pass `null` to skip
   *  the manifest read entirely (e.g. project dir already deleted). */
  projectDir?: string | null;
}): Promise<UnprovisionR2TokensResult> {
  const provider = "r2";

  const manifestKeys = new Set<string>();
  if (opts.projectDir) {
    try {
      const manifest = readManifest(opts.projectDir);
      if (manifest) {
        for (const b of enumerateBuckets(manifest)) manifestKeys.add(b.key);
      }
    } catch {
      // Manifest exists but is malformed — fall back to keychain sweep
      // alone rather than throwing here; teardown should be best-effort.
    }
  }

  const keychainKeys = await listProjectBucketKeys(provider, opts.projectName);
  const allKeys = new Set<string>([...manifestKeys, ...keychainKeys]);

  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  const cf = adminToken ? new CloudflareApi({ token: adminToken }) : null;

  const out: UnprovisionR2TokensResult = { buckets: [] };
  for (const key of [...allKeys].sort()) {
    const tokenId = await getSecret(
      SECRET_KEYS.s3ProjectBucketTokenId(provider, opts.projectName, key),
    );
    let outcome: DeleteResult = "not-found";
    if (tokenId && cf) {
      try {
        outcome = await cf.deleteApiToken(tokenId);
      } catch (err) {
        throw new Error(`Could not delete R2 token for bucket ${key}: ${(err as Error).message}`);
      }
    }
    await deleteSecret(SECRET_KEYS.s3ProjectBucketAccessKey(provider, opts.projectName, key));
    await deleteSecret(SECRET_KEYS.s3ProjectBucketSecretKey(provider, opts.projectName, key));
    await deleteSecret(SECRET_KEYS.s3ProjectBucketTokenId(provider, opts.projectName, key));
    out.buckets.push({ bucketKey: key, outcome });
  }
  return out;
}

/** Enumerate bucket keys this project has tokens for in the keychain.
 *  Match the well-known account naming `s3:<provider>:<project>:<bucket>:token-id`
 *  so we don't need a separate registry of "what buckets did we touch". */
async function listProjectBucketKeys(provider: string, projectName: string): Promise<string[]> {
  const accounts = await listSecretAccounts();
  const prefix = `s3:${provider}:${projectName}:`;
  const suffix = ":token-id";
  const keys = new Set<string>();
  for (const acc of accounts) {
    if (!acc.startsWith(prefix) || !acc.endsWith(suffix)) continue;
    const middle = acc.slice(prefix.length, acc.length - suffix.length);
    // Skip the legacy single-token-per-project shape `<project>:token-id`
    // (no bucket segment). That one belongs to `provision s3` cleanup,
    // not `add s3` cleanup — different surface.
    if (middle === "" || middle.includes(":")) continue;
    keys.add(middle);
  }
  return [...keys];
}

interface BucketEntry {
  key: string;
  name: string;
  publicUrl: string | null;
}

/** Read the manifest's `s3Buckets` map into a stable, sorted list.
 *  Sort by key so multi-bucket runs always produce the same env-var
 *  order on disk. */
function enumerateBuckets(manifest: ProjectManifest): BucketEntry[] {
  const map = manifest.s3Buckets;
  if (!map) return [];
  const entries: BucketEntry[] = [];
  for (const key of Object.keys(map).sort()) {
    const value = (map as Record<string, { name: string; publicUrl: string | null } | undefined>)[
      key
    ];
    if (!value || typeof value.name !== "string" || value.name === "") continue;
    entries.push({ key, name: value.name, publicUrl: value.publicUrl ?? null });
  }
  return entries;
}
