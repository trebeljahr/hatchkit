/*
 * cli/src/secrets/adapters/r2.ts — Cloudflare R2 account-token rotation.
 *
 * `hatchkit provision s3` (s3-buckets.ts) and `hatchkit add s3` (s3.ts)
 * mint R2 **account** tokens with `createR2AccountToken`. Per
 * Cloudflare's R2 docs the S3 pair derives from the token: the Access
 * Key ID IS the token id, the Secret Access Key is sha256(token value).
 * So rotating the pair means minting a new token and deleting the old.
 *
 * Which env names hold a pair: `<R2|S3|AWS>_ACCESS_KEY_ID` (the prefix
 * `detectEnvPrefix` picks) and the per-bucket `R2_<KEY>_ACCESS_KEY_ID`
 * that `hatchkit add s3` writes, each with its `_SECRET_ACCESS_KEY`
 * twin. captureOld decrypts `.env.production` and groups those names by
 * value, so a single-bucket project's `R2_ASSETS_*` and its unprefixed
 * `R2_*` alias (one token, two names) rotate as one token.
 *
 * Scope of the replacement: read from the OLD token's own policy
 * (`GET /accounts/{id}/tokens/{id}` returns buckets + permission groups,
 * never the value). When that read fails, fall back to the manifest's
 * buckets — the same scope provision would mint.
 *
 * Verify: ListObjectsV2 (MaxKeys 1) against the project's own endpoint
 * with the NEW pair, retried while the token propagates. Revoke:
 * `deleteAccountToken` for the old id. recordNew points the manifest's
 * `tokenId` at the new token, so provision's reuse check (manifest id
 * alive + env creds present → reuse) keeps holding after a rotation.
 */

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getStore } from "../../config.js";
import { accountIdFromR2Endpoint } from "../../provision/s3-buckets.js";
import {
  type ProjectManifest,
  readManifestWithMigrationInfo,
  writeManifest,
} from "../../scaffold/manifest.js";
import { CloudflareApi, type CfTokenPolicy } from "../../utils/cloudflare-api.js";
import { SECRET_KEYS, getSecret } from "../../utils/secrets.js";
import { readEncryptedProd } from "../env-writer.js";
import { register } from "../registry.js";
import type {
  EnvKeySpec,
  NewCred,
  OldCred,
  ProviderRotator,
  RotationContext,
  VerifyOutcome,
} from "../types.js";

const ADAPTER = "r2";

/** `R2_ACCESS_KEY_ID`, `S3_ACCESS_KEY_ID`, `AWS_ACCESS_KEY_ID`, and the
 *  per-bucket `R2_<KEY>_ACCESS_KEY_ID`. Group 2 is the bucket key. */
const ACCESS_NAME_RE = /^(?:R2|S3|AWS)(?:_([A-Z0-9]+))?_ACCESS_KEY_ID$/;
/** Cloudflare token ids are 32 hex chars. An AWS key (AKIA…) under the
 *  same env name is not ours to rotate. */
const CF_TOKEN_ID_RE = /^[0-9a-f]{32}$/i;
const R2_BUCKET_RESOURCE = "com.cloudflare.edge.r2.bucket.";

type Jurisdiction = "default" | "eu" | "fedramp";

interface TokenGroup {
  /** Old token id (= old access key id). */
  tokenId: string;
  accessNames: string[];
  secretNames: string[];
  /** Manifest bucket key named by a per-bucket env name, if any. */
  bucketKey?: string;
}

interface MintedGroup {
  tokenId: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: string[];
  jurisdiction: Jurisdiction;
}

interface Scratch {
  accountId?: string;
  endpoint?: string;
  groups?: TokenGroup[];
  minted?: MintedGroup[];
}

function scratch(ctx: RotationContext): Scratch {
  ctx.scratch[ADAPTER] ??= {};
  return ctx.scratch[ADAPTER] as Scratch;
}

/** Verify retry budget. A freshly minted token can answer
 *  InvalidAccessKeyId for a few seconds while it propagates. */
let verifyTiming = { attempts: 8, delayMs: 2500 };

/** Test-only: shrink the retry budget. */
export function __setR2VerifyTimingForTesting(
  timing: { attempts: number; delayMs: number } | undefined,
): void {
  verifyTiming = timing ?? { attempts: 8, delayMs: 2500 };
}

function secretNameFor(accessName: string): string {
  return accessName.replace(/_ACCESS_KEY_ID$/, "_SECRET_ACCESS_KEY");
}

/** Access-key names whose secret twin also exists in `.env.production`. */
function presentAccessNames(ctx: RotationContext): string[] {
  return [...ctx.prodEnvPresence]
    .filter((n) => ACCESS_NAME_RE.test(n) && ctx.prodEnvPresence.has(secretNameFor(n)))
    .sort();
}

/** R2 is the provider behind these keys when the manifest says so. An
 *  `aws` / `hetzner` project's `AWS_ACCESS_KEY_ID` is left alone. */
function manifestIsR2(manifest: ProjectManifest): boolean {
  return (
    manifest.s3Provider === "r2" ||
    manifest.s3Provider === "existing" ||
    typeof manifest.s3Buckets?.accountId === "string"
  );
}

function configuredEndpoint(): string | undefined {
  const meta = getStore().get("providers.s3.r2") as { endpoint?: string } | undefined;
  return meta?.endpoint;
}

function resolveAccountId(ctx: RotationContext, env: Record<string, string>): string | undefined {
  const fromManifest = ctx.manifest.s3Buckets?.accountId;
  if (typeof fromManifest === "string" && fromManifest) return fromManifest;
  for (const endpoint of [configuredEndpoint(), env.R2_ENDPOINT, env.S3_ENDPOINT]) {
    if (!endpoint) continue;
    try {
      return accountIdFromR2Endpoint(endpoint);
    } catch {
      // not an R2 endpoint — try the next
    }
  }
  return undefined;
}

/** The project's own S3 endpoint (what the runtime talks to), else the
 *  account endpoint for the token's jurisdiction. */
function endpointFor(accountId: string, jurisdiction: Jurisdiction, projectEndpoint?: string): string {
  if (projectEndpoint) return projectEndpoint;
  const sub = jurisdiction === "default" ? "" : `.${jurisdiction}`;
  return `https://${accountId}${sub}.r2.cloudflarestorage.com`;
}

/** Buckets, jurisdiction and permission level of an existing token,
 *  read from its policy. Undefined when the policy names no R2 bucket. */
function scopeFromPolicies(
  policies: CfTokenPolicy[] | undefined,
  accountId: string,
): { buckets: string[]; jurisdiction: Jurisdiction; permissions: "read" | "read-write" } | undefined {
  if (!policies || policies.length === 0) return undefined;
  const buckets: string[] = [];
  let jurisdiction: Jurisdiction = "default";
  let write = false;
  for (const policy of policies) {
    if (policy.effect !== "allow") continue;
    for (const group of policy.permission_groups ?? []) {
      if (/write/i.test(group.name ?? "")) write = true;
    }
    for (const key of Object.keys(policy.resources ?? {})) {
      if (!key.startsWith(`${R2_BUCKET_RESOURCE}${accountId}_`)) continue;
      const rest = key.slice(`${R2_BUCKET_RESOURCE}${accountId}_`.length);
      const sep = rest.indexOf("_");
      if (sep < 0) continue;
      const j = rest.slice(0, sep);
      if (j === "eu" || j === "fedramp" || j === "default") jurisdiction = j;
      buckets.push(rest.slice(sep + 1));
    }
  }
  if (buckets.length === 0) return undefined;
  return { buckets: [...new Set(buckets)].sort(), jurisdiction, permissions: write ? "read-write" : "read" };
}

/** Manifest-derived scope: the per-bucket entry a `R2_<KEY>_*` name
 *  points at, else the built-in assets (+ state) pair provision mints. */
function scopeFromManifest(manifest: ProjectManifest, group: TokenGroup): string[] {
  const buckets = manifest.s3Buckets;
  if (!buckets) return [];
  if (group.bucketKey) {
    const entry = buckets[group.bucketKey.toLowerCase()];
    if (entry && typeof entry === "object" && entry.name) return [entry.name];
  }
  const out: string[] = [];
  if (buckets.assets?.name) out.push(buckets.assets.name);
  if (buckets.state?.name) out.push(buckets.state.name);
  return out;
}

async function adminApi(): Promise<CloudflareApi> {
  const token = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!token) {
    throw new Error(
      "R2 admin token not in the keychain. Run `hatchkit config add s3 r2` to store it, then retry.",
    );
  }
  return new CloudflareApi({ token });
}

function mintHint(message: string): string {
  if (/9109|10000|10001|403|invalid api token/i.test(message)) {
    return `${message}\n  → The R2 admin token (s3:r2:admin-token) needs Account Settings > Edit to mint and delete account tokens, and Workers R2 Storage > Edit.`;
  }
  return message;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const r2Rotator: ProviderRotator = {
  name: ADAPTER,
  label: "Cloudflare R2 S3 key pair",

  detect(ctx: RotationContext): boolean {
    return manifestIsR2(ctx.manifest) && presentAccessNames(ctx).length > 0;
  },

  envKeys(ctx: RotationContext): ReadonlyArray<EnvKeySpec> {
    const specs: EnvKeySpec[] = [];
    for (const access of presentAccessNames(ctx)) {
      specs.push({ name: access, scope: "production", secret: true });
      specs.push({ name: secretNameFor(access), scope: "production", secret: true });
    }
    return specs;
  },

  async captureOld(ctx: RotationContext): Promise<OldCred> {
    const values: Record<string, string> = {};
    const handle: Record<string, string> = {};
    let env: Record<string, string>;
    try {
      env = readEncryptedProd(ctx.projectDir);
    } catch {
      return { values, handle };
    }

    const byToken = new Map<string, TokenGroup>();
    for (const access of presentAccessNames(ctx)) {
      const id = env[access];
      const secret = env[secretNameFor(access)];
      if (!id || !secret || !CF_TOKEN_ID_RE.test(id)) continue;
      const group = byToken.get(id) ?? { tokenId: id, accessNames: [], secretNames: [] };
      group.accessNames.push(access);
      group.secretNames.push(secretNameFor(access));
      const bucketKey = ACCESS_NAME_RE.exec(access)?.[1];
      if (bucketKey && access.startsWith("R2_")) group.bucketKey ??= bucketKey;
      byToken.set(id, group);
      values[access] = id;
      values[secretNameFor(access)] = secret;
    }

    const s = scratch(ctx);
    s.groups = [...byToken.values()];
    s.accountId = resolveAccountId(ctx, env);
    s.endpoint = env.R2_ENDPOINT || env.S3_ENDPOINT || undefined;
    if (s.accountId) handle.accountId = s.accountId;
    s.groups.forEach((g, i) => {
      handle[`tokenId:${i}`] = g.tokenId;
      handle[`names:${i}`] = g.accessNames.join(",");
    });
    return { values, handle };
  },

  async createNew(ctx: RotationContext): Promise<NewCred> {
    const s = scratch(ctx);
    const groups = s.groups ?? [];
    if (groups.length === 0) {
      throw new Error(
        "No Cloudflare R2 token found in .env.production (the access key ids are not 32-hex token ids).",
      );
    }
    if (!s.accountId) {
      throw new Error(
        "Cannot resolve the Cloudflare account id: no s3Buckets.accountId in .hatchkit.json and no R2 endpoint configured.",
      );
    }
    const accountId = s.accountId;
    const cf = await adminApi();

    const values: Record<string, string> = {};
    const handle: Record<string, string> = { accountId };
    const minted: MintedGroup[] = [];
    try {
      for (const [i, group] of groups.entries()) {
        let old: Awaited<ReturnType<CloudflareApi["getAccountToken"]>> = null;
        try {
          old = await cf.getAccountToken(accountId, group.tokenId);
        } catch {
          // Unreadable policy: fall back to the manifest scope below.
        }
        const fromPolicy = scopeFromPolicies(old?.policies, accountId);
        const buckets = fromPolicy?.buckets ?? scopeFromManifest(ctx.manifest, group);
        if (buckets.length === 0) {
          throw new Error(
            `Cannot tell which buckets token ${group.tokenId.slice(0, 4)}… covers: its policy is unreadable and .hatchkit.json names no bucket.`,
          );
        }
        const jurisdiction = fromPolicy?.jurisdiction ?? "default";
        const name =
          old?.name ??
          (group.bucketKey
            ? `hatchkit-${ctx.projectName}-${group.bucketKey.toLowerCase()}`
            : `hatchkit-${ctx.projectName}`);
        const fresh = await cf.createR2AccountToken({
          accountId,
          name,
          bucketNames: buckets,
          jurisdiction,
          permissions: fromPolicy?.permissions ?? "read-write",
        });
        minted.push({
          tokenId: fresh.tokenId,
          accessKeyId: fresh.accessKeyId,
          secretAccessKey: fresh.secretAccessKey,
          buckets,
          jurisdiction,
        });
        for (const access of group.accessNames) values[access] = fresh.accessKeyId;
        for (const secret of group.secretNames) values[secret] = fresh.secretAccessKey;
        handle[`tokenId:${i}`] = fresh.tokenId;
        handle[`names:${i}`] = group.accessNames.join(",");
      }
    } catch (err) {
      // Don't orphan the tokens this call already minted.
      for (const m of minted) {
        await cf.deleteAccountToken(accountId, m.tokenId).catch(() => undefined);
      }
      throw new Error(mintHint((err as Error).message));
    }
    s.minted = minted;
    return { values, handle };
  },

  async verify(ctx: RotationContext, _fresh: NewCred): Promise<VerifyOutcome> {
    const s = scratch(ctx);
    const minted = s.minted ?? [];
    if (minted.length === 0 || !s.accountId) return "skipped";
    for (const m of minted) {
      const client = new S3Client({
        region: "auto",
        endpoint: endpointFor(s.accountId, m.jurisdiction, s.endpoint),
        forcePathStyle: true,
        credentials: { accessKeyId: m.accessKeyId, secretAccessKey: m.secretAccessKey },
      });
      let ok = false;
      try {
        for (let attempt = 1; attempt <= verifyTiming.attempts && !ok; attempt++) {
          try {
            await client.send(new ListObjectsV2Command({ Bucket: m.buckets[0], MaxKeys: 1 }));
            ok = true;
          } catch {
            if (attempt < verifyTiming.attempts) await sleep(verifyTiming.delayMs);
          }
        }
      } finally {
        client.destroy();
      }
      if (!ok) return "failed";
    }
    return "ok";
  },

  async revoke(_ctx: RotationContext, old: OldCred): Promise<void> {
    const accountId = old.handle.accountId;
    const ids = Object.entries(old.handle)
      .filter(([k]) => k.startsWith("tokenId:"))
      .map(([, v]) => v);
    if (!accountId || ids.length === 0) return;
    const cf = await adminApi();
    for (const id of ids) {
      await cf.deleteAccountToken(accountId, id);
    }
  },

  async recordNew(ctx: RotationContext, fresh: NewCred, old: OldCred): Promise<void> {
    const swap = new Map<string, string>();
    for (const [k, v] of Object.entries(old.handle)) {
      if (!k.startsWith("tokenId:")) continue;
      const next = fresh.handle[k];
      if (next && next !== v) swap.set(v, next);
    }
    if (swap.size === 0) return;
    const read = readManifestWithMigrationInfo(ctx.projectDir);
    if (!read?.manifest.s3Buckets) return;
    const buckets = { ...read.manifest.s3Buckets };
    let changed = false;
    // Only ids the manifest already records move; an untracked pair
    // stays untracked (provision's "reuse external creds" case).
    if (typeof buckets.tokenId === "string" && swap.has(buckets.tokenId)) {
      buckets.tokenId = swap.get(buckets.tokenId);
      changed = true;
    }
    for (const [key, entry] of Object.entries(buckets)) {
      if (!entry || typeof entry !== "object" || !entry.tokenId) continue;
      const next = swap.get(entry.tokenId);
      if (next) {
        buckets[key] = { ...entry, tokenId: next };
        changed = true;
      }
    }
    if (changed) writeManifest(ctx.projectDir, { ...read.manifest, s3Buckets: buckets });
  },
};

register(r2Rotator);
