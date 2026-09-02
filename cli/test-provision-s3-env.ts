/**
 * Tests for `hatchkit provision s3`'s two env-wiring decisions:
 *
 *   · WHICH file it writes. It must be the file the READERS resolve
 *     (`keys.ts` → locateEnvProductionFile, used by `keys rotate`,
 *     `keys push`, and `sync`'s env pass). A run against a starter
 *     project once wrote `<repo>/.env.production` — minting a second
 *     dotenvx keypair and a second `.env.keys` at the root — while
 *     the project's real env, with its real keypair, sat in
 *     `packages/server/.env.production`.
 *
 *   · WHICH env-var prefix it writes under. The starter's server reads
 *     `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`
 *     alongside `S3_ENDPOINT` / `S3_BUCKET_NAME`. Counting `S3_*`
 *     lines picks "S3" for exactly that layout and seeds credentials
 *     under names the server never reads — encrypted, committed, and
 *     silently dead at runtime.
 *
 * Run: `pnpm test`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { locateEnvProductionFile } from "./src/deploy/keys.js";
import { detectEnvPrefix, envKeysForPrefix } from "./src/provision/s3-buckets.js";
import { resolveEnvTarget } from "./src/provision/write-env.js";
import { locateEnvFile, resolveEnvFileTarget } from "./src/utils/env-files.js";

const failures: string[] = [];
function expect(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

/** Build a throwaway project tree. `files` maps repo-relative paths to
 *  contents; parent dirs are created. `dirs` creates empty dirs. */
function project(files: Record<string, string>, dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "hk-s3env-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function withProject(
  files: Record<string, string>,
  fn: (root: string) => void,
  dirs: string[] = [],
): void {
  const root = project(files, dirs);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const MANIFEST = JSON.stringify({ name: "demo", domain: "demo.test" });

/** The starter's server env, abbreviated: four S3_* keys, three AWS_*.
 *  A bulk `S3_*` count reads this as "S3"; the server reads AWS_*. */
const STARTER_EXAMPLE = [
  "S3_ENDPOINT=http://127.0.0.1:9000",
  "S3_BUCKET_NAME=demo-dev",
  "S3_PUBLIC_URL=http://127.0.0.1:9000/demo-dev",
  "S3_FORCE_PATH_STYLE=true",
  "AWS_REGION=us-east-1",
  "AWS_ACCESS_KEY_ID=hatchkit-dev",
  "AWS_SECRET_ACCESS_KEY=hatchkit-dev",
  "",
].join("\n");

console.log("\n  test-provision-s3-env\n");

// ---------------------------------------------------------------
//  1. Write-target resolution
// ---------------------------------------------------------------

expect("targets packages/server/.env.production when it exists", () => {
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "packages/server/.env.production": 'DOTENV_PUBLIC_KEY_PRODUCTION="02abc"\n',
    },
    (root) => {
      assert.equal(
        resolveEnvFileTarget(root, ".env.production"),
        join(root, "packages/server/.env.production"),
      );
    },
  );
});

expect("writer target === reader's locateEnvProductionFile", () => {
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "packages/server/.env.production": 'DOTENV_PUBLIC_KEY_PRODUCTION="02abc"\n',
      "packages/client/.env.production": 'DOTENV_PUBLIC_KEY_PRODUCTION="02def"\n',
      ".env.production": 'DOTENV_PUBLIC_KEY_PRODUCTION="02ghi"\n',
    },
    (root) => {
      // The whole bug in one assertion: provisioner and consumer must
      // name the same file, root copy present or not.
      assert.equal(resolveEnvFileTarget(root, ".env.production"), locateEnvProductionFile(root));
      assert.equal(
        resolveEnvFileTarget(root, ".env.production"),
        join(root, "packages/server/.env.production"),
      );
    },
  );
});

expect("prefers packages/server even when only siblings live there", () => {
  // No .env.production anywhere yet — the first `provision s3` on a
  // fresh project. It must still land next to the keypair that
  // already encrypts the server's env, not fork a second one at root.
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "packages/server/.env.development": "PORT=5159\n",
      "packages/server/.env.keys": 'DOTENV_PRIVATE_KEY_PRODUCTION="abc"\n',
    },
    (root) => {
      assert.equal(
        resolveEnvFileTarget(root, ".env.production"),
        join(root, "packages/server/.env.production"),
      );
    },
  );
});

expect("falls back to the repo root for a single-package project", () => {
  withProject({ ".hatchkit.json": MANIFEST, ".env.example": "PORT=3000\n" }, (root) => {
    assert.equal(resolveEnvFileTarget(root, ".env.production"), join(root, ".env.production"));
  });
});

expect("an apps/server layout resolves like packages/server", () => {
  withProject({ ".hatchkit.json": MANIFEST, "apps/server/.env.production": "X=1\n" }, (root) => {
    assert.equal(
      resolveEnvFileTarget(root, ".env.production"),
      join(root, "apps/server/.env.production"),
    );
  });
});

expect("rebases through the manifest's projectSubdir", () => {
  withProject(
    {
      ".hatchkit.json": JSON.stringify({ name: "demo", projectSubdir: "site" }),
      "site/packages/server/.env.production": "X=1\n",
      ".env.production": "X=2\n",
    },
    (root) => {
      assert.equal(
        resolveEnvFileTarget(root, ".env.production"),
        join(root, "site/packages/server/.env.production"),
      );
    },
  );
});

expect("resolveEnvTarget (write-env) agrees with the shared resolver", () => {
  withProject(
    { ".hatchkit.json": MANIFEST, "packages/server/.env.production": "X=1\n" },
    (root) => {
      const { baseDir, layout } = resolveEnvTarget(root);
      assert.equal(baseDir, join(root, "packages/server"));
      assert.equal(layout, "starter");
    },
  );
});

expect("locateEnvFile returns undefined when nothing exists", () => {
  withProject({ ".hatchkit.json": MANIFEST }, (root) => {
    assert.equal(locateEnvFile(root, ".env.production"), undefined);
    // ...but a writer still gets a concrete target.
    assert.equal(resolveEnvFileTarget(root, ".env.production"), join(root, ".env.production"));
  });
});

// ---------------------------------------------------------------
//  2. Env-prefix detection
// ---------------------------------------------------------------

expect("starter layout (S3_* endpoint + AWS_* creds) detects AWS", () => {
  withProject(
    { ".hatchkit.json": MANIFEST, "packages/server/.env.example": STARTER_EXAMPLE },
    (root) => {
      assert.equal(detectEnvPrefix(root), "AWS");
      const keys = envKeysForPrefix(detectEnvPrefix(root));
      assert.equal(keys.accessKey, "AWS_ACCESS_KEY_ID");
      assert.equal(keys.secretKey, "AWS_SECRET_ACCESS_KEY");
      assert.equal(keys.region, "AWS_REGION");
      assert.equal(keys.endpoint, "S3_ENDPOINT");
      assert.equal(keys.bucket, "S3_BUCKET_NAME");
    },
  );
});

expect("an existing .env.production using AWS_* keeps AWS_*", () => {
  // The re-provision case: whatever the deployment already runs on
  // wins, even when .env.example disagrees. Renaming a live project's
  // credentials mid-flight is worse than any tidier guess.
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "packages/server/.env.example": "S3_ACCESS_KEY_ID=x\nS3_SECRET_ACCESS_KEY=y\n",
      "packages/server/.env.production": [
        'DOTENV_PUBLIC_KEY_PRODUCTION="02abc"',
        'S3_ENDPOINT="encrypted:AAA"',
        'AWS_ACCESS_KEY_ID="encrypted:BBB"',
        'AWS_SECRET_ACCESS_KEY="encrypted:CCC"',
        "",
      ].join("\n"),
    },
    (root) => {
      assert.equal(detectEnvPrefix(root), "AWS");
    },
  );
});

expect("R2_ACCESS_KEY_ID detects R2", () => {
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "packages/server/.env.example": "R2_ENDPOINT=x\nR2_ACCESS_KEY_ID=y\nR2_SECRET_ACCESS_KEY=z\n",
    },
    (root) => assert.equal(detectEnvPrefix(root), "R2"),
  );
});

expect("S3_ACCESS_KEY_ID detects S3", () => {
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "packages/server/.env.example": "S3_ENDPOINT=x\nS3_ACCESS_KEY_ID=y\nS3_SECRET_ACCESS_KEY=z\n",
    },
    (root) => assert.equal(detectEnvPrefix(root), "S3"),
  );
});

expect("compose passthrough decides when no env file names a key", () => {
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "docker-compose.server.yml": [
        "services:",
        "  server:",
        "    environment:",
        "      S3_BUCKET_NAME: ${S3_BUCKET_NAME:-assets}",
        "      AWS_REGION: ${AWS_REGION:-eu-central-1}",
        "      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}",
        "      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}",
        "",
      ].join("\n"),
    },
    (root) => assert.equal(detectEnvPrefix(root), "AWS"),
  );
});

expect("the server's env module decides when compose is silent too", () => {
  withProject(
    {
      ".hatchkit.json": MANIFEST,
      "packages/server/src/config/env.ts": [
        "export const env = {",
        '  AWS_ACCESS_KEY_ID: getOptional("AWS_ACCESS_KEY_ID"),',
        '  AWS_SECRET_ACCESS_KEY: getOptional("AWS_SECRET_ACCESS_KEY"),',
        "};",
        "",
      ].join("\n"),
    },
    (root) => assert.equal(detectEnvPrefix(root), "AWS"),
  );
});

expect("falls back to the bulk count when no access key is named", () => {
  withProject(
    { ".hatchkit.json": MANIFEST, "packages/server/.env.example": "R2_BUCKET=x\nR2_ENDPOINT=y\n" },
    (root) => assert.equal(detectEnvPrefix(root), "R2"),
  );
});

expect("an empty project still defaults to S3", () => {
  withProject({ ".hatchkit.json": MANIFEST }, (root) => {
    assert.equal(detectEnvPrefix(root), "S3");
  });
});

expect("root-level env files are still detected (non-starter layout)", () => {
  withProject({ ".hatchkit.json": MANIFEST, ".env.example": "AWS_ACCESS_KEY_ID=x\n" }, (root) =>
    assert.equal(detectEnvPrefix(root), "AWS"),
  );
});

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
