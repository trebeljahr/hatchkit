/*
 * Resolve the S3 connection a scaffolded project actually uses, in
 * either `dev` or `prod` mode. The bucket the *runtime* talks to is
 * the source of truth — we read the same .env files the runtime
 * reads, not the global hatchkit config or keychain.
 *
 * Naming convention quirks (see provision/s3-buckets.ts):
 *
 *   · For S3/AWS-style projects, the assets bucket name lives in the
 *     env (`S3_BUCKET_NAME` or `S3_BUCKET_NAME` again). The `_*_*`
 *     credential keys are `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
 *     (AWS-prefixed) or `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
 *     (generic).
 *   · For R2 the assets bucket name is NOT in env (the runtime never
 *     calls it directly — it's URL-driven). The bucket name lives in
 *     `.hatchkit.json` under `s3Buckets.assets.name`. R2 uses the
 *     `R2_*` prefix for its credentials.
 *
 * We normalise both shapes here so callers don't have to care.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "@dotenvx/dotenvx";
import { readManifest } from "../scaffold/manifest.js";

export type AssetsMode = "dev" | "prod";
export type BucketKind = "assets" | "state";

export interface ResolvedS3Config {
  /** The mode this config was loaded for. */
  mode: AssetsMode;
  /** S3 endpoint URL. Always set — for AWS prod we synthesise the
   *  default region URL, for R2/MinIO it's explicit in env. */
  endpoint: string;
  /** Region. Falls back to "auto" for R2, "us-east-1" elsewhere. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing — needed for MinIO + most non-AWS S3s. */
  forcePathStyle: boolean;
  /** Resolved bucket names. `state` is undefined when the project
   *  didn't provision one (the default for client-only projects). */
  buckets: {
    assets: { name: string; publicUrl: string | null };
    state?: { name: string };
  };
  /** Where this config came from, for error messages. */
  source: string;
}

interface LoadOpts {
  projectDir: string;
  mode: AssetsMode;
  /** packages/server relative to projectDir. Auto-detected if absent. */
  serverDir?: string;
}

/** Load + decrypt the env vars that the runtime will see in `mode`. */
export function loadProjectEnv(opts: LoadOpts): Record<string, string> {
  const serverDir = opts.serverDir ?? detectServerDir(opts.projectDir);
  const filename = opts.mode === "prod" ? ".env.production" : ".env.development";
  const envPath = join(serverDir, filename);
  if (!existsSync(envPath)) {
    throw new Error(
      `Expected ${envPath} (mode=${opts.mode}). Is this a hatchkit project? ` +
        `Run from the project root, or pass --dir.`,
    );
  }
  const src = readFileSync(envPath, "utf-8");

  let privateKey: string | undefined;
  if (opts.mode === "prod") {
    privateKey = process.env.DOTENV_PRIVATE_KEY_PRODUCTION ?? readPrivateKey(opts.projectDir);
    if (!privateKey) {
      throw new Error(
        `Can't decrypt ${envPath}. No DOTENV_PRIVATE_KEY_PRODUCTION in env, ` +
          `and no .env.keys at ${join(opts.projectDir, ".env.keys")} or ${join(serverDir, ".env.keys")}. ` +
          `Run \`hatchkit keys show <project>\` and export the value, or restore .env.keys.`,
      );
    }
  }

  const parsed = parseDotenv(src, { privateKey, processEnv: {} });
  return parsed as Record<string, string>;
}

/** Resolve the unified S3 config used by mirror operations. */
export function loadS3Config(opts: LoadOpts): ResolvedS3Config {
  const env = loadProjectEnv(opts);
  const serverDir = opts.serverDir ?? detectServerDir(opts.projectDir);
  const manifest = readManifest(opts.projectDir);

  const prefix = detectPrefix(env);
  const accessKeyId =
    env[`${prefix}_ACCESS_KEY_ID`] ?? env.AWS_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID ?? "";
  const secretAccessKey =
    env[`${prefix}_SECRET_ACCESS_KEY`] ??
    env.AWS_SECRET_ACCESS_KEY ??
    env.S3_SECRET_ACCESS_KEY ??
    "";
  const endpoint = env[`${prefix}_ENDPOINT`] ?? env.S3_ENDPOINT ?? defaultEndpointFor(prefix, env);
  const region =
    env[`${prefix}_REGION`] ??
    env.AWS_REGION ??
    env.S3_REGION ??
    (prefix === "R2" ? "auto" : "us-east-1");
  const forcePathStyle = parseBool(env.S3_FORCE_PATH_STYLE) ?? prefix !== "AWS";

  // Assets bucket — for R2, not in env, so fall back to the manifest.
  // For S3/AWS the bucket env (`S3_BUCKET_NAME`) holds the assets name
  // unless a state bucket was provisioned (in which case it holds the
  // state name — see provision/s3-buckets.ts:459-465). Reconcile by
  // preferring the manifest when it's present.
  const assetsFromManifest = manifest?.s3Buckets?.assets;
  const stateFromManifest = manifest?.s3Buckets?.state;
  const bucketEnv = env[`${prefix}_BUCKET_NAME`] ?? env.S3_BUCKET_NAME ?? env.R2_STATE_BUCKET;

  const assetsName = assetsFromManifest?.name ?? bucketEnv;
  if (!assetsName) {
    throw new Error(
      `Can't resolve the assets bucket name for mode=${opts.mode}. ` +
        `No s3Buckets.assets in .hatchkit.json and no S3_BUCKET_NAME / R2_BUCKET_NAME in env. ` +
        `If this is a fresh project, run \`hatchkit provision s3\` first.`,
    );
  }
  const assetsPublicUrl =
    assetsFromManifest?.publicUrl ?? env.NEXT_PUBLIC_ASSETS_BASE_URL ?? env.S3_PUBLIC_URL ?? null;
  const stateName = stateFromManifest?.name ?? env[`${prefix}_STATE_BUCKET`];

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `Missing S3 credentials in ${join(serverDir, opts.mode === "prod" ? ".env.production" : ".env.development")}. ` +
        `Looked for ${prefix}_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID and the matching secret.`,
    );
  }

  return {
    mode: opts.mode,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    buckets: {
      assets: { name: assetsName, publicUrl: assetsPublicUrl },
      ...(stateName ? { state: { name: stateName } } : {}),
    },
    source: opts.mode === "prod" ? `${serverDir}/.env.production` : `${serverDir}/.env.development`,
  };
}

/** Detect the env-name prefix the project uses. Order matters — R2
 *  wins over AWS wins over S3 because the more specific prefixes
 *  signal an explicit choice while S3 is the generic fallback. */
function detectPrefix(env: Record<string, string>): "R2" | "AWS" | "S3" {
  if (env.R2_ENDPOINT || env.R2_ACCESS_KEY_ID) return "R2";
  if (env.AWS_ACCESS_KEY_ID && (env.S3_BUCKET_NAME || env.S3_ENDPOINT)) return "AWS";
  return "S3";
}

function defaultEndpointFor(prefix: string, env: Record<string, string>): string {
  if (prefix === "AWS") {
    const region = env.AWS_REGION ?? "us-east-1";
    return `https://s3.${region}.amazonaws.com`;
  }
  // R2 / generic S3 require an explicit endpoint — surfacing the
  // missing var here is more useful than a misleading default.
  throw new Error(
    `No ${prefix}_ENDPOINT or S3_ENDPOINT set. For R2 set R2_ENDPOINT to https://<account-id>.r2.cloudflarestorage.com.`,
  );
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

function detectServerDir(projectDir: string): string {
  // Conventions, in order: pnpm/npm workspace at packages/server, or
  // a flat single-package project where the env file sits at root.
  const candidate = join(projectDir, "packages", "server");
  if (
    existsSync(join(candidate, ".env.example")) ||
    existsSync(join(candidate, ".env.development"))
  ) {
    return candidate;
  }
  return projectDir;
}

/** Find the dotenvx private key for `production`. Searches the
 *  project root and packages/server for `.env.keys` (where dotenvx
 *  writes it locally). Caller falls back to the OS keychain. */
function readPrivateKey(projectDir: string): string | undefined {
  const candidates = [
    join(projectDir, ".env.keys"),
    join(projectDir, "packages", "server", ".env.keys"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    const m = text.match(/^DOTENV_PRIVATE_KEY_PRODUCTION="?([0-9a-fA-F]+)"?/m);
    if (m) return m[1];
  }
  return undefined;
}
