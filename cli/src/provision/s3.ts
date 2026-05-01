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
 * For each bucket entry in the manifest, we mint a Cloudflare R2
 * **Account** API token (`POST /accounts/{id}/tokens`) scoped to that
 * bucket only — Object Read + Write permissions. One token per bucket
 * is the deliberate choice: narrower blast radius than a single
 * multi-bucket token, and it matches the `R2_<NAME>_*` env-var naming
 * the runtime expects (each bucket has its own credential pair).
 *
 * Source of truth for which tokens exist: the manifest. Each minted
 * token's id is pinned under `s3Buckets[bucketKey].tokenId` in
 * `.hatchkit.json` (committed) so re-runs reuse it instead of
 * minting a duplicate, and `hatchkit remove <project> s3` knows
 * which tokens to revoke. Credentials never go in the manifest —
 * they live encrypted in `.env.production` only.
 *
 * Coexists with `hatchkit provision s3`'s shared-token model: that
 * flow records ONE token id at `s3Buckets.tokenId` covering both
 * built-in buckets (`assets` + `state`). Per-bucket tokens minted
 * here use `s3Buckets[bucketKey].tokenId` instead — distinct field,
 * distinct semantics.
 *
 * Inverse: `unprovisionR2BucketTokens` — revokes each token via
 * DELETE /accounts/{id}/tokens/{id}. Called by `hatchkit remove`.
 */

import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { type ProjectManifest, readManifest, writeManifest } from "../scaffold/manifest.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";
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
  /** Cloudflare account that owns the token + bucket — pinned in the
   *  manifest so destroy can address the right account-tokens endpoint. */
  accountId: string;
  /** True if the token was minted on this run; false if the manifest
   *  already had a verified-alive token id we reused. */
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
  /** Project name. Used for the token's CF display name. */
  projectName: string;
  /** Project directory. Manifest is read from `<projectDir>/.hatchkit.json`. */
  projectDir: string;
}

/** Mint (or reuse) a per-bucket scoped R2 Account API token for every
 *  bucket declared in `.hatchkit.json` → `s3Buckets`. Returns the
 *  endpoint + per-bucket S3-style credential pairs ready for the env
 *  writer. The token id of every minted token is persisted into the
 *  manifest so re-runs are idempotent and destroy can clean up. */
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

  // Read the .env.production keys to know whether existing manifest
  // tokens still have usable credentials in the file. CF doesn't
  // expose the secret-access-key after creation, so a manifest token
  // without matching env entries is effectively dead — re-mint.
  const envPath = join(opts.projectDir, ".env.production");
  const existingEnv = await readEnvKeysSet(envPath);

  const bucketTokens: R2BucketToken[] = [];
  const updatedBucketEntries: Record<
    string,
    { name: string; publicUrl: string | null; tokenId?: string }
  > = {};

  for (const bucket of buckets) {
    const existingTokenId = bucket.tokenId;
    const reusable = existingTokenId && hasBucketEnvCreds(existingEnv, bucket.key);
    let probe: { id: string; status: string; name: string } | null = null;
    if (reusable) {
      try {
        probe = await cf.getAccountToken(accountId, existingTokenId);
      } catch (err) {
        // Probe failure (network/permissions) — fall through to mint
        // fresh. Better to lose one token to orphans than to keep
        // running with credentials we can't verify.
        console.log(
          chalk.dim(
            `  · Couldn't verify R2 token ${existingTokenId.slice(0, 8)}… for ${bucket.key} (${(err as Error).message.split("\n")[0]}). Minting a fresh one.`,
          ),
        );
      }
    }

    if (reusable && probe?.status === "active") {
      // Reuse: env already has the credentials, just record the entry.
      bucketTokens.push({
        bucketKey: bucket.key,
        bucketName: bucket.name,
        accessKeyId: existingTokenId,
        secretAccessKey: "", // unknown to us; .env.production has the live one
        tokenId: existingTokenId,
        accountId,
        minted: false,
      });
      updatedBucketEntries[bucket.key] = {
        name: bucket.name,
        publicUrl: bucket.publicUrl,
        tokenId: existingTokenId,
      };
      console.log(
        chalk.dim(
          `  · Reusing R2 account token ${existingTokenId.slice(0, 8)}… for bucket ${bucket.key} (alive in CF; creds in .env.production)`,
        ),
      );
      continue;
    }

    // Revoke a stale manifest token (status disabled/expired/404)
    // before minting the replacement so we don't pile up orphans.
    if (existingTokenId) {
      try {
        await cf.deleteAccountToken(accountId, existingTokenId);
      } catch {
        /* best-effort */
      }
    }

    const spinner = ora(
      `R2: minting scoped account token for bucket ${chalk.cyan(bucket.name)} (${bucket.key})`,
    ).start();
    try {
      const minted = await cf.createR2AccountToken({
        accountId,
        name: `hatchkit-${opts.projectName}-${bucket.key}`,
        bucketNames: [bucket.name],
        permissions: "read-write",
      });
      bucketTokens.push({
        bucketKey: bucket.key,
        bucketName: bucket.name,
        accessKeyId: minted.accessKeyId,
        secretAccessKey: minted.secretAccessKey,
        tokenId: minted.tokenId,
        accountId,
        minted: true,
      });
      updatedBucketEntries[bucket.key] = {
        name: bucket.name,
        publicUrl: bucket.publicUrl,
        tokenId: minted.tokenId,
      };
      spinner.succeed(
        `R2: minted account token for ${bucket.name} (id ${minted.tokenId.slice(0, 8)}…, visible in R2 → Manage R2 API Tokens)`,
      );
    } catch (err) {
      spinner.fail(`R2: minting account token for ${bucket.name} failed`);
      const msg = (err as Error).message;
      if (/9109|10000|10001|403|invalid api token/i.test(msg)) {
        throw new Error(
          `${msg}\n\n  → The admin token (s3:r2:admin-token) needs:\n    · Account > Workers R2 Storage > Edit  (list/access buckets)\n    · Account Settings > Edit               (mint per-project account tokens — commonly the missing one)\n  → Edit at https://dash.cloudflare.com/profile/api-tokens, save, re-run.`,
        );
      }
      throw err;
    }
  }

  // Persist the per-bucket tokenIds back into the manifest. Preserve
  // any other s3Buckets fields (like `tokenId` + `accountId` from a
  // prior `provision s3` shared-token run, or built-in `state` entry
  // we didn't touch on this run).
  if (bucketTokens.some((bt) => bt.minted)) {
    const merged: NonNullable<ProjectManifest["s3Buckets"]> = {
      ...(manifest.s3Buckets ?? {}),
      ...updatedBucketEntries,
    };
    const updated: ProjectManifest = { ...manifest, s3Buckets: merged };
    writeManifest(opts.projectDir, updated);
  }

  return { endpoint: meta.endpoint, bucketTokens };
}

/** Convert a `provisionR2BucketTokens` result into the KEY=VALUE lines
 *  the orchestrator writes to `.env.production`. Names follow the
 *  R2_ prefix convention; for projects with a single bucket we ALSO
 *  emit unprefixed `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` aliases
 *  so existing single-bucket runtimes (which expect the unprefixed
 *  form) keep working without code changes.
 *
 *  Reused tokens (where we don't know the secret-access-key; CF
 *  doesn't expose it after creation) emit only the bucket-name +
 *  endpoint lines — the existing encrypted .env.production is the
 *  source of truth for the credentials, and we don't want to overwrite
 *  it with a placeholder. */
export function renderR2BucketTokensEnv(result: ProvisionR2TokensResult): string[] {
  const lines: string[] = [];
  lines.push(`R2_ENDPOINT=${result.endpoint}`);

  for (const bt of result.bucketTokens) {
    const name = bt.bucketKey.toUpperCase();
    lines.push(`R2_${name}_BUCKET=${bt.bucketName}`);
    if (bt.minted) {
      lines.push(`R2_${name}_ACCESS_KEY_ID=${bt.accessKeyId}`);
      lines.push(`R2_${name}_SECRET_ACCESS_KEY=${bt.secretAccessKey}`);
    }
  }

  // Single-bucket alias. Most single-bucket consumers (Next.js apps,
  // standalone sync scripts) read R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
  // directly without the bucket-name segment. Skip when there's
  // ambiguity (multi-bucket).
  if (result.bucketTokens.length === 1 && result.bucketTokens[0].minted) {
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

/** Delete every per-bucket scoped R2 account token minted for this
 *  project, both upstream (CF API) and locally (manifest). Idempotent
 *  — missing upstream tokens count as `not-found`.
 *
 *  Source of truth: the manifest's `s3Buckets[bucketKey].tokenId`
 *  fields. When the manifest is missing or unreadable, returns an
 *  empty result — the user must manually revoke tokens via the CF
 *  dashboard. (No keychain fallback exists for the per-bucket model;
 *  unlike the legacy single-token-per-project flow, tokens are never
 *  written to the OS keychain in the new design.) */
export async function unprovisionR2BucketTokens(opts: {
  projectName: string;
  /** Optional — when known, the manifest at `<projectDir>/.hatchkit.json`
   *  is consulted to enumerate buckets. Pass `null` to skip the
   *  manifest read entirely (e.g. project dir already deleted). */
  projectDir?: string | null;
}): Promise<UnprovisionR2TokensResult> {
  const out: UnprovisionR2TokensResult = { buckets: [] };
  if (!opts.projectDir) return out;

  let manifest: ProjectManifest | null = null;
  try {
    manifest = readManifest(opts.projectDir);
  } catch {
    return out;
  }
  if (!manifest) return out;

  const buckets = enumerateBuckets(manifest);
  if (buckets.length === 0) return out;

  const accountId = manifest.s3Buckets?.accountId ?? deriveAccountId();
  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    throw new Error(
      "R2 admin token not in keychain — re-add via `hatchkit config add s3 r2`, then retry remove.",
    );
  }
  const cf = new CloudflareApi({ token: adminToken });
  const resolvedAccountId = accountId ?? (await fallbackAccountId());

  for (const bucket of buckets) {
    const tokenId = bucket.tokenId;
    if (!tokenId) {
      out.buckets.push({ bucketKey: bucket.key, outcome: "not-found" });
      continue;
    }
    if (!resolvedAccountId) {
      throw new Error(
        "Couldn't resolve the Cloudflare account id for this project — manifest has no `s3Buckets.accountId` and the global R2 endpoint is not set. Run `hatchkit config add s3 r2` to fix.",
      );
    }
    let outcome: DeleteResult = "not-found";
    try {
      outcome = await cf.deleteAccountToken(resolvedAccountId, tokenId);
    } catch (err) {
      throw new Error(
        `Could not delete R2 account token for bucket ${bucket.key}: ${(err as Error).message}`,
      );
    }
    out.buckets.push({ bucketKey: bucket.key, outcome });
  }

  // Wipe per-bucket tokenIds from the manifest (keep names + URLs —
  // the buckets still exist; only the tokens are gone).
  if (manifest.s3Buckets) {
    const updated: NonNullable<ProjectManifest["s3Buckets"]> = { ...manifest.s3Buckets };
    for (const bucket of buckets) {
      const entry = updated[bucket.key];
      if (entry && typeof entry === "object") {
        updated[bucket.key] = {
          name: entry.name,
          publicUrl: entry.publicUrl,
        };
      }
    }
    writeManifest(opts.projectDir, { ...manifest, s3Buckets: updated });
  }

  return out;
}

interface BucketEntry {
  key: string;
  name: string;
  publicUrl: string | null;
  tokenId?: string;
}

/** Read the manifest's `s3Buckets` map into a stable, sorted list.
 *  Sort by key so multi-bucket runs always produce the same env-var
 *  order on disk. Skips the scalar `tokenId` / `accountId` fields
 *  that share the s3Buckets namespace — those belong to the legacy
 *  single-token flow, not to this per-bucket flow. */
function enumerateBuckets(manifest: ProjectManifest): BucketEntry[] {
  const map = manifest.s3Buckets;
  if (!map) return [];
  const entries: BucketEntry[] = [];
  for (const key of Object.keys(map).sort()) {
    if (key === "tokenId" || key === "accountId") continue;
    const value = map[key];
    if (!value || typeof value !== "object" || typeof value.name !== "string" || value.name === "")
      continue;
    entries.push({
      key,
      name: value.name,
      publicUrl: value.publicUrl ?? null,
      tokenId: value.tokenId,
    });
  }
  return entries;
}

/** Read every `KEY=` line out of a `.env.production` file (encrypted or
 *  not — we only care about the keys present). Returns an empty set
 *  when the file doesn't exist. */
async function readEnvKeysSet(envPath: string): Promise<Set<string>> {
  const { existsSync, readFileSync } = await import("node:fs");
  if (!existsSync(envPath)) return new Set();
  const text = readFileSync(envPath, "utf-8");
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Returns true if the `.env.production` already has access-key + secret
 *  entries for the bucket, so reusing an existing manifest tokenId is
 *  safe (we won't be left with credentials we can't recover). Checks
 *  the prefixed `R2_<NAME>_*` form first; falls back to the unprefixed
 *  alias used for single-bucket projects. */
function hasBucketEnvCreds(envKeys: Set<string>, bucketKey: string): boolean {
  const upper = bucketKey.toUpperCase();
  const prefixed =
    envKeys.has(`R2_${upper}_ACCESS_KEY_ID`) && envKeys.has(`R2_${upper}_SECRET_ACCESS_KEY`);
  const aliased = envKeys.has("R2_ACCESS_KEY_ID") && envKeys.has("R2_SECRET_ACCESS_KEY");
  return prefixed || aliased;
}

function deriveAccountId(): string | undefined {
  return undefined;
}

async function fallbackAccountId(): Promise<string | undefined> {
  const { getStore } = await import("../config.js");
  const meta = getStore().get("providers.s3.r2") as { endpoint?: string } | undefined;
  if (!meta?.endpoint) return undefined;
  try {
    return accountIdFromR2Endpoint(meta.endpoint);
  } catch {
    return undefined;
  }
}
