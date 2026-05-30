/**
 * Pure-function tests for the rename-project edit planners. Each helper
 * returns a FileOp describing what would change; we drive them with
 * synthetic inputs and assert the rewritten content + change log.
 *
 * No filesystem state, no manifest, no run-ledger — those are covered
 * by the integration shape and would require a real scaffold.
 *
 * Run: pnpm test (added to cli/package.json `test`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _internals } from "./src/deploy/rename-project.js";
import type { ProjectManifest } from "./src/scaffold/manifest.js";

const tmp = mkdtempSync(join(tmpdir(), "rename-project-"));

function write(rel: string, content: string): string {
  const path = join(tmp, rel);
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// rewriteManifest
// ---------------------------------------------------------------------------
{
  const manifest: ProjectManifest = {
    version: 1,
    cliVersion: "0.0.0-test",
    scaffoldedAt: "2026-01-01T00:00:00Z",
    name: "old",
    domain: "old.example.com",
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    ports: { server: 3001, client: 3000 },
  };
  const path = write("manifest-1.json", JSON.stringify(manifest));
  const op = _internals.rewriteManifest(path, manifest, "new");
  const parsed = JSON.parse(op.after) as ProjectManifest;
  assert.equal(parsed.name, "new");
  assert.equal(parsed.domain, "old.example.com", "domain must be left alone");
  assert.deepEqual(op.changes, [`name: "old" → "new"`]);
}

// ---------------------------------------------------------------------------
// rewritePackageJson — top-level name + suffix swaps
// ---------------------------------------------------------------------------
{
  const path = write(
    "package-1.json",
    JSON.stringify(
      {
        name: "old",
        scripts: {
          "db:dev": "echo old-dev",
          "db:prod": "echo old-prod",
          "test:e2e": "playwright test --project=old-e2e",
          "assets:push": "rclone copy ./assets r2:old-assets",
        },
      },
      null,
      2,
    ),
  );
  const op = _internals.rewritePackageJson(path, "old", "new");
  const parsed = JSON.parse(op.after) as { name: string; scripts: Record<string, string> };
  assert.equal(parsed.name, "new");
  assert.equal(parsed.scripts["db:dev"], "echo new-dev");
  assert.equal(parsed.scripts["db:prod"], "echo new-prod");
  assert.equal(parsed.scripts["test:e2e"], "playwright test --project=new-e2e");
  assert.equal(parsed.scripts["assets:push"], "rclone copy ./assets r2:new-assets");
  assert.ok(
    op.changes.some((c) => c.includes(`name: "old" → "new"`)),
    "should record name change",
  );
  assert.ok(
    op.changes.some((c) => c.includes("old-dev")),
    "should record -dev swap",
  );
}

// rewritePackageJson — top-level name doesn't match (e.g. user already renamed it)
{
  const path = write(
    "package-2.json",
    JSON.stringify({ name: "totally-unrelated", scripts: { x: "old-dev" } }, null, 2),
  );
  const op = _internals.rewritePackageJson(path, "old", "new");
  const parsed = JSON.parse(op.after) as { name: string };
  assert.equal(parsed.name, "totally-unrelated", "untouched when not matching");
  assert.ok(op.changes.some((c) => c.includes("left alone")));
  assert.ok(
    op.changes.some((c) => c.includes("old-dev")),
    "suffix swaps still happen",
  );
}

// ---------------------------------------------------------------------------
// rewriteStarterNamedFile — suffix swaps
// ---------------------------------------------------------------------------
{
  const path = write(
    "docker-compose.dev.yml",
    `services:
  mongo:
    environment:
      MONGO_INITDB_DATABASE: old-dev
  e2e:
    image: ${"" /* placate templating */}old-e2e
  s3:
    environment:
      MINIO_DEFAULT_BUCKETS: old-assets
`,
  );
  const op = _internals.rewriteStarterNamedFile(path, "old", "new");
  assert.ok(op, "should return a FileOp when suffixes appear");
  assert.ok(op!.after.includes("new-dev"));
  assert.ok(op!.after.includes("new-e2e"));
  assert.ok(op!.after.includes("new-assets"));
  assert.ok(!op!.after.includes("old-dev"));
}

// rewriteStarterNamedFile — no match returns null
{
  const path = write("unrelated.yml", "services:\n  foo: bar\n");
  const op = _internals.rewriteStarterNamedFile(path, "old", "new");
  assert.equal(op, null);
}

// ---------------------------------------------------------------------------
// rewriteReadme
// ---------------------------------------------------------------------------
{
  const path = write(
    "README.md",
    "# old\n\n[![build](https://github.com/me/old/actions/workflows/ci.yml/badge.svg)](…)\n",
  );
  const op = _internals.rewriteReadme(path, "old", "new");
  assert.ok(op, "should return a FileOp when old name appears");
  assert.ok(op!.after.startsWith("# new\n"));
  assert.ok(op!.after.includes("/me/new/actions"));
}
{
  const path = write("README-clean.md", "# Something else entirely\n");
  const op = _internals.rewriteReadme(path, "old", "new");
  assert.equal(op, null);
}

// ---------------------------------------------------------------------------
// planTfvarsRename
// ---------------------------------------------------------------------------
{
  const oldPath = write(
    "old.tfvars",
    `server_name     = "old-prod"
server_type     = "cax21"
domain = "old.example.com"
subdomains = {
  "old" = "@"
}
s3_enabled     = true
s3_bucket_name = "old-assets"
`,
  );
  const newPath = oldPath.replace(/old\.tfvars$/, "new.tfvars");
  const op = _internals.planTfvarsRename(oldPath, newPath, "old", "new");
  assert.ok(op.after.includes(`server_name     = "new-prod"`));
  assert.ok(op.after.includes(`s3_bucket_name = "new-assets"`));
  // The literal `"old" = "@"` line under `subdomains` is a domain
  // sub-key — for the project rename we treat any lingering `<old>` as
  // a sweep target. Confirm the sweep ran.
  assert.ok(op.after.includes(`"new" = "@"`), "stray <old> tokens should be swept");
  assert.equal(op.oldPath, oldPath);
  assert.equal(op.newPath, newPath);
  assert.ok(op.changes.some((c) => c.startsWith("server_name:")));
  assert.ok(op.changes.some((c) => c.startsWith("s3_bucket_name:")));
  assert.ok(op.changes.some((c) => c.startsWith("rename:")));
}

// ---------------------------------------------------------------------------
// planStacksEnvRename — PROJECT_NAME / APP_NAME / S3_BUCKET
// ---------------------------------------------------------------------------
{
  const oldPath = write(
    "old.env",
    `COOLIFY_URL="https://coolify.example.com"

PROJECT_NAME="old"
ENVIRONMENT_NAME="production"

APP_NAME="old"
GITHUB_REPO_URL="https://github.com/me/old"
APP_PORT="3000"
S3_BUCKET="old-assets"
SOMETHING_ELSE="old-not-this"
`,
  );
  const newPath = oldPath.replace(/old\.env$/, "new.env");
  const op = _internals.planStacksEnvRename(oldPath, newPath, "old", "new");
  assert.ok(op.after.includes(`PROJECT_NAME="new"`));
  assert.ok(op.after.includes(`APP_NAME="new"`));
  assert.ok(op.after.includes(`S3_BUCKET="new-assets"`));
  // COOLIFY_URL is skipped
  assert.ok(op.after.includes(`COOLIFY_URL="https://coolify.example.com"`));
  // GITHUB_REPO_URL is intentionally left alone (gh repo rename is a
  // follow-up).
  assert.ok(op.after.includes(`https://github.com/me/old`));
  // Unrelated keys are not touched
  assert.ok(op.after.includes(`SOMETHING_ELSE="old-not-this"`));
}

// ---------------------------------------------------------------------------
// planLedgerRename — name field rewrite, steps untouched
// ---------------------------------------------------------------------------
{
  const oldPath = write(
    "ledger-old.json",
    JSON.stringify(
      {
        name: "old",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:05:00Z",
        steps: [
          { kind: "github", repo: "me/old" },
          { kind: "r2Bucket", bucketName: "old-assets", accountId: "acc-1" },
          { kind: "coolifyProject", uuid: "uuid-1" },
        ],
      },
      null,
      2,
    ),
  );
  const newPath = oldPath.replace(/ledger-old\.json$/, "ledger-new.json");
  const op = _internals.planLedgerRename(oldPath, newPath, "old", "new");
  const parsed = JSON.parse(op.after) as {
    name: string;
    steps: Array<{ kind: string; repo?: string; bucketName?: string; uuid?: string }>;
  };
  assert.equal(parsed.name, "new", "name field rewritten");
  // Steps left alone — they reference live provider resources.
  assert.equal(parsed.steps[0].repo, "me/old");
  assert.equal(parsed.steps[1].bucketName, "old-assets");
  assert.equal(parsed.steps[2].uuid, "uuid-1");
}

// ---------------------------------------------------------------------------
// Sanity: file on disk wasn't touched by the planners (they're pure)
// ---------------------------------------------------------------------------
{
  // Re-read the manifest fixture; original `name: "old"` should still be there.
  const original = readFileSync(join(tmp, "manifest-1.json"), "utf-8");
  assert.ok(original.includes(`"name":"old"`) || original.includes(`"name": "old"`));
}

console.log("rename-project planners ok");
