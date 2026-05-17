/**
 * Manifest migration: v1 → v2 surface rename.
 *
 * v1 stored the `surfaces` field as one of:
 *   shared / separate / server-only / client-only / both
 *
 * v2 renames the four canonical values to:
 *   shared      → fullstack
 *   separate    → split
 *   server-only → backend
 *   client-only → static
 *
 * Plus one historical alias: v1 also allowed `surfaces: "both"`, which
 * doesn't have a 1:1 4-value successor — readers migrate to `fullstack`
 * (users with a split monorepo can hand-flip to `split` afterwards).
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  readManifestWithMigrationInfo,
  writeManifest,
} from "./src/scaffold/manifest.js";

type ManifestSurfaces = NonNullable<
  ReturnType<typeof readManifestWithMigrationInfo>
>["manifest"]["surfaces"];

interface V1Case {
  label: string;
  oldValue: string;
  expected: ManifestSurfaces;
}

const CASES: V1Case[] = [
  { label: "shared → fullstack", oldValue: "shared", expected: "fullstack" },
  { label: "separate → split", oldValue: "separate", expected: "split" },
  { label: "server-only → backend", oldValue: "server-only", expected: "backend" },
  { label: "client-only → static", oldValue: "client-only", expected: "static" },
];

function makeV1Manifest(surfaces: string): Record<string, unknown> {
  return {
    version: 1,
    cliVersion: "test",
    scaffoldedAt: "2025-01-01T00:00:00.000Z",
    name: "test-app",
    domain: "test.example.com",
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "existing",
    surfaces,
    ports: { server: 3000, client: 5173 },
  };
}

const failures: string[] = [];

for (const c of CASES) {
  const dir = mkdtempSync(join(tmpdir(), `hatchkit-manifest-${c.oldValue}-`));
  try {
    const path = join(dir, MANIFEST_FILENAME);
    writeFileSync(path, JSON.stringify(makeV1Manifest(c.oldValue), null, 2), "utf-8");

    const result = readManifestWithMigrationInfo(dir);
    assert.ok(result, `[${c.label}] readManifestWithMigrationInfo returned null`);
    assert.equal(
      result.manifest.surfaces,
      c.expected,
      `[${c.label}] expected surfaces=${c.expected}, got ${result.manifest.surfaces}`,
    );
    assert.equal(
      result.manifest.version,
      MANIFEST_VERSION,
      `[${c.label}] expected version=${MANIFEST_VERSION} after migration, got ${result.manifest.version}`,
    );
    assert.equal(result.migrated, true, `[${c.label}] expected migrated=true`);
    assert.ok(
      result.migrationNotes.some((note) =>
        note.startsWith(`Renamed surface mode: ${c.oldValue} →`),
      ),
      `[${c.label}] missing rename note. got: ${JSON.stringify(result.migrationNotes)}`,
    );

    // On-disk file is NOT touched by the reader — the migration only
    // applies on the next write.
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as { version: number; surfaces: string };
    assert.equal(onDisk.version, 1, `[${c.label}] reader should leave the on-disk file alone`);
    assert.equal(onDisk.surfaces, c.oldValue, `[${c.label}] on-disk surfaces should be untouched`);

    // After writeManifest, the on-disk file is at the current schema
    // version and the canonical 4-value name.
    writeManifest(dir, result.manifest);
    const afterWrite = JSON.parse(readFileSync(path, "utf-8")) as {
      version: number;
      surfaces: string;
    };
    assert.equal(
      afterWrite.version,
      MANIFEST_VERSION,
      `[${c.label}] writeManifest should bump the on-disk version`,
    );
    assert.equal(
      afterWrite.surfaces,
      c.expected,
      `[${c.label}] writeManifest should persist the canonical surface name`,
    );

    console.log(`  ✓ ${c.label}`);
  } catch (err) {
    failures.push(`  ✗ ${c.label}: ${(err as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// v2 → v3: a v2 manifest without an `email` field gets seeded with
// { transactional: "none", mailingList: "none" } on read, and the
// migration note explicitly mentions the seed so re-runs can surface
// it. Existing fields stay intact.
{
  const dir = mkdtempSync(join(tmpdir(), `hatchkit-manifest-v2-email-`));
  try {
    const path = join(dir, MANIFEST_FILENAME);
    const v2 = {
      version: 2,
      cliVersion: "test",
      scaffoldedAt: "2025-01-01T00:00:00.000Z",
      name: "test-app",
      domain: "test.example.com",
      features: ["websocket"],
      mlServices: [],
      s3Provider: "none",
      deployTarget: "existing",
      surfaces: "fullstack",
      ports: { server: 3000, client: 5173 },
    };
    writeFileSync(path, JSON.stringify(v2, null, 2), "utf-8");

    const result = readManifestWithMigrationInfo(dir);
    assert.ok(result, "v2 → v3 read returned null");
    assert.equal(result.manifest.version, MANIFEST_VERSION, "v2 → v3 bumps version");
    assert.deepEqual(
      result.manifest.email,
      { transactional: "none", mailingList: "none" },
      "v2 → v3 seeds email intent to none/none",
    );
    assert.ok(
      result.migrationNotes.some((n) => n.includes("Seeded email intent")),
      `missing email-seed note. got: ${JSON.stringify(result.migrationNotes)}`,
    );
    // Existing fields untouched
    assert.equal(result.manifest.name, "test-app");
    assert.deepEqual(result.manifest.features, ["websocket"]);

    console.log("  ✓ v2 → v3: seeds email = { none, none } and preserves other fields");
  } catch (err) {
    failures.push(`  ✗ v2 → v3 email seed: ${(err as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// v3 read: existing `email` field is left alone (not overwritten with
// the default). This catches a regression where the seed could clobber
// an explicit user choice.
{
  const dir = mkdtempSync(join(tmpdir(), `hatchkit-manifest-v3-email-keep-`));
  try {
    const path = join(dir, MANIFEST_FILENAME);
    const v3 = {
      version: 3,
      cliVersion: "test",
      scaffoldedAt: "2025-01-01T00:00:00.000Z",
      name: "test-app",
      domain: "test.example.com",
      features: [],
      mlServices: [],
      s3Provider: "none",
      deployTarget: "existing",
      surfaces: "fullstack",
      ports: { server: 3000, client: 5173 },
      email: { transactional: "resend", mailingList: "listmonk-ses" },
    };
    writeFileSync(path, JSON.stringify(v3, null, 2), "utf-8");

    const result = readManifestWithMigrationInfo(dir);
    assert.ok(result, "v3 read returned null");
    assert.deepEqual(
      result.manifest.email,
      { transactional: "resend", mailingList: "listmonk-ses" },
      "v3 read preserves explicit email intent",
    );
    assert.equal(
      result.migrated,
      false,
      `expected migrated=false for current-version manifest. notes: ${JSON.stringify(result.migrationNotes)}`,
    );

    console.log("  ✓ v3 read: preserves explicit email intent, no migration triggered");
  } catch (err) {
    failures.push(`  ✗ v3 email preservation: ${(err as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.log("\nManifest migration test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll manifest migration cases passed.");
