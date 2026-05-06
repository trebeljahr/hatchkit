/*
 * Copy objects from one S3-compatible bucket (or a local directory)
 * into a target S3-compatible bucket. Used by `hatchkit assets push /
 * pull / migrate / seed`.
 *
 * Design:
 *   · Cross-provider safe — always streams Get→Put rather than using
 *     the server-side CopyObject API (which only works inside one S3
 *     service). The AWS SDK Body of GetObject is a Node Readable; we
 *     pass it straight to PutObject so memory stays bounded for large
 *     objects.
 *   · Skip-if-unchanged via ETag + size. ETag is per-provider and
 *     differs for multipart uploads, so we only skip on exact match;
 *     a mismatch always re-copies (false positives are wasted work,
 *     not data loss).
 *   · Bounded concurrency. Default 8 — chosen to saturate residential
 *     uplinks without overwhelming MinIO running on the same box.
 *   · `--delete` is intentionally not exposed here. Mirror semantics
 *     are "copy missing + changed"; pruning the target is a separate
 *     destructive operation we don't want behind a casual flag.
 */

import { createReadStream, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import type { Readable as NodeReadable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type { ResolvedS3Config } from "./env.js";

/** Build an SDK client from our normalised config. */
export function buildS3Client(cfg: ResolvedS3Config): S3Client {
  const opts: S3ClientConfig = {
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  };
  return new S3Client(opts);
}

export interface MirrorEndpointS3 {
  kind: "s3";
  client: S3Client;
  bucket: string;
  /** Optional prefix to scope the source to a sub-tree. */
  prefix?: string;
  /** Human-readable label for log output (e.g. "prod", "local"). */
  label: string;
}

export interface MirrorEndpointDir {
  kind: "dir";
  /** Local directory; entries are walked recursively. */
  dir: string;
  /** Optional prefix to prepend to all uploaded keys. */
  prefix?: string;
  label: string;
}

export type MirrorSource = MirrorEndpointS3 | MirrorEndpointDir;

export interface MirrorOptions {
  source: MirrorSource;
  target: MirrorEndpointS3;
  /** When true, list what would be copied but don't transfer. */
  dryRun?: boolean;
  /** Max concurrent uploads. Defaults to 8. */
  concurrency?: number;
  /** Optional progress callback fired per object. */
  onObject?: (event: ObjectEvent) => void;
}

export type ObjectEvent =
  | { kind: "skipped"; key: string; reason: "etag-match" | "size-match" }
  | { kind: "copied"; key: string; bytes: number }
  | { kind: "copy-failed"; key: string; error: Error };

export interface MirrorResult {
  scanned: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  durationMs: number;
}

interface ObjectRef {
  key: string;
  size: number;
  etag?: string;
}

export async function mirror(opts: MirrorOptions): Promise<MirrorResult> {
  const start = Date.now();
  const list = await listSource(opts.source);
  const targetKeys = await listTargetEtags(opts.target);

  const result: MirrorResult = {
    scanned: list.length,
    copied: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    durationMs: 0,
  };

  const concurrency = Math.max(1, opts.concurrency ?? 8);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < list.length) {
      const ref = list[cursor++];
      const targetKey = applyPrefix(opts.target.prefix, stripPrefix(opts.source, ref.key));
      const targetMeta = targetKeys.get(targetKey);
      if (targetMeta && shouldSkip(ref, targetMeta)) {
        result.skipped++;
        opts.onObject?.({
          kind: "skipped",
          key: targetKey,
          reason: ref.etag && ref.etag === targetMeta.etag ? "etag-match" : "size-match",
        });
        continue;
      }
      if (opts.dryRun) {
        result.copied++;
        result.bytes += ref.size;
        opts.onObject?.({ kind: "copied", key: targetKey, bytes: ref.size });
        continue;
      }
      try {
        await copyOne(opts.source, ref, opts.target, targetKey);
        result.copied++;
        result.bytes += ref.size;
        opts.onObject?.({ kind: "copied", key: targetKey, bytes: ref.size });
      } catch (err) {
        result.failed++;
        opts.onObject?.({
          kind: "copy-failed",
          key: targetKey,
          error: err as Error,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  result.durationMs = Date.now() - start;
  return result;
}

/** Decide whether the existing target object can be left alone. */
function shouldSkip(src: ObjectRef, dst: ObjectRef): boolean {
  if (src.etag && dst.etag && normEtag(src.etag) === normEtag(dst.etag)) return true;
  // ETag may be unreliable across providers for multipart objects.
  // Fall back to exact size match — good enough for static asset
  // workflows where re-uploads change content (and therefore size or
  // ETag); avoids a wasteful re-copy for byte-identical objects.
  if (src.size === dst.size && src.etag === undefined && dst.etag === undefined) return true;
  return false;
}

function normEtag(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

async function listSource(source: MirrorSource): Promise<ObjectRef[]> {
  if (source.kind === "s3") {
    return listBucket(source.client, source.bucket, source.prefix);
  }
  return listDir(source.dir);
}

async function listBucket(client: S3Client, bucket: string, prefix?: string): Promise<ObjectRef[]> {
  const refs: ObjectRef[] = [];
  let token: string | undefined;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const c of out.Contents ?? []) {
      if (!c.Key) continue;
      refs.push({ key: c.Key, size: c.Size ?? 0, etag: c.ETag });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return refs;
}

async function listDir(root: string): Promise<ObjectRef[]> {
  const out: ObjectRef[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(root: string, dir: string, acc: ObjectRef[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, full, acc);
      continue;
    }
    if (!e.isFile()) continue;
    const stat = statSync(full);
    const key = relative(root, full).split(sep).join("/");
    acc.push({ key, size: stat.size });
  }
}

async function listTargetEtags(target: MirrorEndpointS3): Promise<Map<string, ObjectRef>> {
  const refs = await listBucket(target.client, target.bucket, target.prefix);
  const map = new Map<string, ObjectRef>();
  for (const r of refs) map.set(r.key, r);
  return map;
}

function stripPrefix(source: MirrorSource, key: string): string {
  const prefix = source.kind === "s3" ? source.prefix : undefined;
  if (!prefix) return key;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function applyPrefix(prefix: string | undefined, key: string): string {
  if (!prefix) return key;
  const normalised = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${normalised}${key.replace(/^\//, "")}`;
}

async function copyOne(
  source: MirrorSource,
  ref: ObjectRef,
  target: MirrorEndpointS3,
  targetKey: string,
): Promise<void> {
  if (source.kind === "dir") {
    const fullPath = join(source.dir, ref.key);
    await target.client.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: targetKey,
        Body: createReadStream(fullPath),
        ContentLength: ref.size,
        ContentType: contentTypeFor(ref.key),
      }),
    );
    return;
  }

  // S3 → S3 — stream Get into Put so we never buffer the whole object
  // and so this works across providers (server-side copy doesn't).
  const got = await source.client.send(
    new GetObjectCommand({ Bucket: source.bucket, Key: ref.key }),
  );
  const body = got.Body;
  if (!body) {
    throw new Error(`Empty body for ${source.bucket}/${ref.key}`);
  }
  const stream = body as NodeReadable;
  await target.client.send(
    new PutObjectCommand({
      Bucket: target.bucket,
      Key: targetKey,
      Body: stream as unknown as Readable,
      ContentLength: got.ContentLength,
      ContentType: got.ContentType,
    }),
  );
}

/** Verify the target bucket actually exists + is reachable. Surfaces
 *  a friendlier error than the SDK's stack-traced NoSuchBucket. */
export async function ensureBucket(endpoint: MirrorEndpointS3): Promise<void> {
  try {
    await endpoint.client.send(
      new HeadObjectCommand({ Bucket: endpoint.bucket, Key: "__hatchkit_probe__" }),
    );
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    // 404 on a probe key is fine — that just means the key doesn't
    // exist, but the bucket does. NoSuchBucket / 403 / network errors
    // bubble up so the caller can render a real message.
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return;
    throw err;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[key.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
