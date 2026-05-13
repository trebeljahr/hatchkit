/*
 * `hatchkit assets <subcommand>` — move bytes between the local
 * S3-compatible bucket and the production bucket (or any S3-compatible
 * source, for adoption).
 *
 * Subcommands:
 *   seed     ./seed/assets/  → local S3
 *   push     local S3        → prod bucket
 *   pull     prod bucket     → local S3
 *   migrate  external bucket → prod bucket (--from-endpoint=… --from-bucket=…)
 *   list     dev|prod          List objects in a bucket
 *
 * All transfer commands take `--bucket assets|state` (default assets),
 * `--dir <path>` (default cwd), `--dry-run`, and `--json`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import chalk from "chalk";
import ora from "ora";
import { type AssetsMode, type BucketKind, type ResolvedS3Config, loadS3Config } from "./env.js";
import {
  type MirrorEndpointS3,
  type MirrorResult,
  buildS3Client,
  ensureBucket,
  formatBytes,
  mirror,
} from "./mirror.js";

interface CommonFlags {
  projectDir: string;
  bucket: BucketKind;
  dryRun: boolean;
  json: boolean;
}

export async function handleAssets(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return 0;
  }

  const flags = parseCommon(args.slice(1));
  try {
    switch (sub) {
      case "seed":
        return await handleSeed(args.slice(1), flags);
      case "push":
        return await handlePush(flags);
      case "pull":
        return await handlePull(flags);
      case "migrate":
        return await handleMigrate(args.slice(1), flags);
      case "list":
        return await handleList(args.slice(1), flags);
      default:
        console.error(chalk.red(`Unknown subcommand: assets ${sub}`));
        printHelp();
        return 1;
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(chalk.red(`\n  ✗ ${msg}\n`));
    }
    return 1;
  }
}

// ---------------------------------------------------------------------------
// seed — populate the local S3 bucket from ./seed/assets/
// ---------------------------------------------------------------------------

async function handleSeed(rawArgs: string[], flags: CommonFlags): Promise<number> {
  const fromArg = takeFlag(rawArgs, "--from");
  const fromDir = resolve(flags.projectDir, fromArg ?? "seed/assets");
  if (!existsSync(fromDir)) {
    throw new Error(
      `Seed directory ${fromDir} doesn't exist. Create it (mkdir -p seed/assets) and drop files in, or pass --from <path>.`,
    );
  }

  const dev = loadS3Config({ projectDir: flags.projectDir, mode: "dev" });
  const target = endpoint(dev, flags.bucket, "local");
  await ensureBucket(target);

  return runMirror({
    label: `seed → ${target.label} bucket "${target.bucket}"`,
    flags,
    run: () =>
      mirror({
        source: { kind: "dir", dir: fromDir, label: "seed/assets" },
        target,
        dryRun: flags.dryRun,
        onObject: makeProgress(flags.json),
      }),
    extra: { from: fromDir },
  });
}

// ---------------------------------------------------------------------------
// push — local S3 → prod
// ---------------------------------------------------------------------------

async function handlePush(flags: CommonFlags): Promise<number> {
  const dev = loadS3Config({ projectDir: flags.projectDir, mode: "dev" });
  const prod = loadS3Config({ projectDir: flags.projectDir, mode: "prod" });
  const source = endpoint(dev, flags.bucket, "local");
  const target = endpoint(prod, flags.bucket, "prod");
  if (!flags.dryRun) await ensureBucket(target);

  return runMirror({
    label: `push local → prod bucket "${target.bucket}"`,
    flags,
    run: () =>
      mirror({
        source,
        target,
        dryRun: flags.dryRun,
        onObject: makeProgress(flags.json),
      }),
  });
}

// ---------------------------------------------------------------------------
// pull — prod → local S3 (be careful: realistic data may include PII)
// ---------------------------------------------------------------------------

async function handlePull(flags: CommonFlags): Promise<number> {
  const dev = loadS3Config({ projectDir: flags.projectDir, mode: "dev" });
  const prod = loadS3Config({ projectDir: flags.projectDir, mode: "prod" });
  const source = endpoint(prod, flags.bucket, "prod");
  const target = endpoint(dev, flags.bucket, "local");
  if (!flags.dryRun) await ensureBucket(target);

  return runMirror({
    label: `pull prod → local bucket "${target.bucket}"`,
    flags,
    run: () =>
      mirror({
        source,
        target,
        dryRun: flags.dryRun,
        onObject: makeProgress(flags.json),
      }),
  });
}

// ---------------------------------------------------------------------------
// migrate — external bucket → prod (the adoption escape hatch)
// ---------------------------------------------------------------------------

async function handleMigrate(rawArgs: string[], flags: CommonFlags): Promise<number> {
  const fromEndpoint = takeFlag(rawArgs, "--from-endpoint");
  const fromBucket = takeFlag(rawArgs, "--from-bucket");
  const fromKey = takeFlag(rawArgs, "--from-key") ?? process.env.HATCHKIT_FROM_ACCESS_KEY_ID;
  const fromSecret =
    takeFlag(rawArgs, "--from-secret") ?? process.env.HATCHKIT_FROM_SECRET_ACCESS_KEY;
  const fromRegion = takeFlag(rawArgs, "--from-region") ?? "auto";
  const fromPrefix = takeFlag(rawArgs, "--from-prefix");

  const missing: string[] = [];
  if (!fromBucket) missing.push("--from-bucket");
  if (!fromKey) missing.push("--from-key (or env HATCHKIT_FROM_ACCESS_KEY_ID)");
  if (!fromSecret) missing.push("--from-secret (or env HATCHKIT_FROM_SECRET_ACCESS_KEY)");
  if (missing.length > 0) {
    throw new Error(
      `assets migrate is missing: ${missing.join(", ")}. ` +
        `Run \`hatchkit help assets\` for the full flag list.`,
    );
  }

  const sourceClient = buildS3Client({
    mode: "prod",
    endpoint: fromEndpoint ?? `https://s3.${fromRegion}.amazonaws.com`,
    region: fromRegion,
    accessKeyId: fromKey as string,
    secretAccessKey: fromSecret as string,
    forcePathStyle: !!fromEndpoint && !fromEndpoint.includes("amazonaws.com"),
    buckets: { assets: { name: fromBucket as string, publicUrl: null } },
    source: "migrate flags",
  });

  const prod = loadS3Config({ projectDir: flags.projectDir, mode: "prod" });
  const target = endpoint(prod, flags.bucket, "prod");
  if (!flags.dryRun) await ensureBucket(target);

  return runMirror({
    label: `migrate ${fromBucket} → prod bucket "${target.bucket}"`,
    flags,
    run: () =>
      mirror({
        source: {
          kind: "s3",
          client: sourceClient,
          bucket: fromBucket as string,
          prefix: fromPrefix,
          label: "external",
        },
        target,
        dryRun: flags.dryRun,
        onObject: makeProgress(flags.json),
      }),
    extra: { from: { bucket: fromBucket, endpoint: fromEndpoint, region: fromRegion } },
  });
}

// ---------------------------------------------------------------------------
// list — quick "what's in the bucket" probe
// ---------------------------------------------------------------------------

async function handleList(rawArgs: string[], flags: CommonFlags): Promise<number> {
  const which = (rawArgs.find((a) => a === "dev" || a === "prod") ?? "dev") as AssetsMode;
  const cfg = loadS3Config({ projectDir: flags.projectDir, mode: which });
  const ep = endpoint(cfg, flags.bucket, which === "dev" ? "local" : "prod");

  const out = await ep.client.send(new ListObjectsV2Command({ Bucket: ep.bucket, MaxKeys: 1000 }));
  const entries = (out.Contents ?? []).map((c) => ({
    key: c.Key ?? "",
    size: c.Size ?? 0,
    modified: c.LastModified?.toISOString(),
  }));

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: which,
          bucket: ep.bucket,
          endpoint: cfg.endpoint,
          truncated: !!out.IsTruncated,
          entries,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (entries.length === 0) {
    console.log(chalk.dim(`  (empty) — ${ep.bucket} on ${cfg.endpoint}`));
    return 0;
  }
  for (const e of entries) {
    console.log(`  ${chalk.cyan(e.key.padEnd(60))} ${formatBytes(e.size).padStart(10)}`);
  }
  console.log(
    chalk.dim(
      `\n  ${entries.length} object(s)${out.IsTruncated ? " (more — listing truncated)" : ""}`,
    ),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function endpoint(cfg: ResolvedS3Config, kind: BucketKind, label: string): MirrorEndpointS3 {
  const bucket = kind === "state" ? cfg.buckets.state?.name : cfg.buckets.assets.name;
  if (!bucket) {
    throw new Error(
      `No "${kind}" bucket configured for ${label} (${cfg.source}). ` +
        `Either pick --bucket assets, or run \`hatchkit provision s3 --with-state-bucket\`.`,
    );
  }
  return { kind: "s3", client: buildS3Client(cfg), bucket, label };
}

function makeProgress(json: boolean) {
  if (json) return undefined;
  return (event: import("./mirror.js").ObjectEvent) => {
    if (event.kind === "copied") {
      process.stdout.write(chalk.green("  ✓ ") + chalk.dim(event.key) + "\n");
    } else if (event.kind === "skipped") {
      process.stdout.write(chalk.dim(`  · ${event.key} (${event.reason})\n`));
    } else {
      process.stdout.write(chalk.red(`  ✗ ${event.key}: ${event.error.message}\n`));
    }
  };
}

interface RunMirrorOpts {
  label: string;
  flags: CommonFlags;
  run: () => Promise<MirrorResult>;
  extra?: Record<string, unknown>;
}

async function runMirror(opts: RunMirrorOpts): Promise<number> {
  if (opts.flags.dryRun && !opts.flags.json) {
    console.log(chalk.yellow(`  (dry run — no objects will be copied)`));
  }
  const spinner = opts.flags.json ? null : ora(opts.label).start();
  spinner?.stop();
  if (!opts.flags.json) console.log(chalk.bold(`  ${opts.label}`));

  const result = await opts.run();

  if (opts.flags.json) {
    console.log(JSON.stringify({ ok: result.failed === 0, ...result, ...opts.extra }, null, 2));
  } else {
    const verb = opts.flags.dryRun ? "would copy" : "copied";
    console.log(
      `\n  ${chalk.bold(verb)} ${result.copied} · skipped ${result.skipped} · failed ${result.failed} · ${formatBytes(result.bytes)} · ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  }
  return result.failed === 0 ? 0 : 2;
}

function parseCommon(rest: string[]): CommonFlags {
  const dirArg = takeFlag(rest, "--dir");
  const bucketArg = takeFlag(rest, "--bucket") ?? "assets";
  if (bucketArg !== "assets" && bucketArg !== "state") {
    throw new Error(`--bucket must be "assets" or "state", got "${bucketArg}"`);
  }
  return {
    projectDir: dirArg ? resolve(dirArg) : resolve("."),
    bucket: bucketArg,
    dryRun: rest.includes("--dry-run"),
    json: rest.includes("--json"),
  };
}

/** Pull `--flag value` (or `--flag=value`) out of rest, removing the
 *  matched tokens. Mutates `rest` so subsequent calls see a smaller
 *  argv. Mirrors the pattern used in cli/src/utils/flags.ts. */
function takeFlag(rest: string[], name: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === name) {
      const v = rest[i + 1];
      rest.splice(i, 2);
      return v;
    }
    if (tok.startsWith(`${name}=`)) {
      const v = tok.slice(name.length + 1);
      rest.splice(i, 1);
      return v;
    }
  }
  return undefined;
}

function printHelp(): void {
  console.log(`
${chalk.bold("hatchkit assets")} — move bytes between local S3 and prod buckets.

${chalk.bold("Subcommands")}

  ${chalk.cyan("seed")}     [--from <dir>]                Local dir → local S3 bucket.
                                            Defaults to ./seed/assets.
  ${chalk.cyan("push")}     [--bucket assets|state]       Local S3 → prod bucket.
  ${chalk.cyan("pull")}     [--bucket assets|state]       Prod bucket → local S3.
                                            Caution: prod data may include PII.
  ${chalk.cyan("migrate")}  --from-endpoint=URL           External S3 → prod bucket.
           --from-bucket=NAME                The adoption escape hatch.
           --from-key=AKIA…                  Creds can also come from
           --from-secret=…                   HATCHKIT_FROM_ACCESS_KEY_ID +
           [--from-region=us-east-1]         HATCHKIT_FROM_SECRET_ACCESS_KEY.
           [--from-prefix=path/]
  ${chalk.cyan("list")}     [dev|prod] [--bucket assets|state]
                                            Show what's in a bucket.

${chalk.bold("Common flags")}

  --dir <path>     Project dir (defaults to cwd).
  --bucket KIND    "assets" (default) or "state".
  --dry-run        Plan only — list what would be copied.
  --json           Machine-readable output.

${chalk.bold("Notes")}

  Mirror semantics: copy missing + changed objects. Never deletes from
  the target. ETag mismatches always re-copy (false positives are
  wasted bandwidth, not data loss). Streams Get→Put so cross-provider
  migrations (e.g. AWS → R2) work without server-side copy.

  Reads dev creds from packages/server/.env.development (plaintext) and
  prod creds from packages/server/.env.production (decrypted via
  dotenvx + .env.keys). Bucket names come from .hatchkit.json when
  the env doesn't carry them (R2's URL-driven assets bucket).
`);
}
