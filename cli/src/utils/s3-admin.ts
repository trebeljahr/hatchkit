/*
 * AWS-SDK-backed read helpers for the "other" S3-compatible providers
 * (Hetzner Object Storage, AWS S3) that hatchkit configures via
 * `hatchkit config add s3 <provider>`.
 *
 * R2 isn't routed through here — it's listed via Cloudflare's REST API
 * (CloudflareApi.listR2Buckets) which uses the account-scoped admin
 * token rather than per-bucket access/secret pairs.
 *
 * Kept tiny: account-wide `ListBuckets` is the only call inventory +
 * overview need. Per-bucket object listing already lives in
 * `assets/mirror.ts`.
 */

import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3ProviderConfig } from "../config.js";

export interface S3BucketSummary {
  name: string;
  creationDate?: Date;
}

/** Build an admin S3Client from a stored provider config. Same shape as
 *  `assets/mirror.ts:buildS3Client`, kept separate so the inventory /
 *  overview paths don't pull in the streaming-assets module. */
function buildAdminClient(cfg: S3ProviderConfig): S3Client {
  return new S3Client({
    region: cfg.region ?? "us-east-1",
    endpoint: cfg.endpoint,
    // Hetzner + most non-AWS S3s only respond on path-style; AWS itself
    // also accepts it for ListBuckets so a single setting works for both.
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
  });
}

/** List every bucket visible to the credentials in `cfg`. Throws on
 *  auth / network failure — callers should wrap and surface a skip. */
export async function listS3Buckets(cfg: S3ProviderConfig): Promise<S3BucketSummary[]> {
  const client = buildAdminClient(cfg);
  try {
    const res = await client.send(new ListBucketsCommand({}));
    return (res.Buckets ?? []).map((b) => ({
      name: b.Name ?? "",
      creationDate: b.CreationDate,
    }));
  } finally {
    client.destroy();
  }
}
