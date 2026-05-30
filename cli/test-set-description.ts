/**
 * Unit tests for `hatchkit set-description`.
 *
 * Covers the local-file half of the command (manifest + package.json
 * rewrites). The Coolify + GitHub PATCH paths are not exercised — they
 * hit external APIs and are best-effort by design, so the production
 * code already isolates a failed call from the rest of the run.
 *
 * Run: tsx test-set-description.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-set-desc-${process.pid}`;
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "set-desc-conf-"));

const { runSetDescription, _internals } = await import("./src/deploy/set-description.js");
const { readManifest, MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");

interface Manifest {
  version: number;
  cliVersion: string;
  scaffoldedAt: string;
  name: string;
  domain: string;
  description?: string;
  features: string[];
  mlServices: string[];
  s3Provider: string;
  deployTarget: string;
  ports: { server: number; client: number };
}

function makeProject(description?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "set-desc-"));
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    cliVersion: "0.0.0-test",
    scaffoldedAt: new Date().toISOString(),
    name: "test-app",
    domain: "test-app.example.com",
    features: [],
    mlServices: [],
    s3Provider: "none",
    deployTarget: "new",
    ports: { server: 3001, client: 3000 },
  };
  if (description !== undefined) manifest.description = description;
  writeFileSync(join(dir, ".hatchkit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "test-app",
        version: "0.0.1",
        ...(description !== undefined ? { description } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

const results: { name: string; ok: boolean; err?: string }[] = [];

async function t(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: (err as Error).message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log("\nset-description tests\n");

const cleanup: string[] = [];

await t("rewrites manifest description (set when previously unset)", async () => {
  const dir = makeProject();
  cleanup.push(dir);
  await runSetDescription({
    projectDir: dir,
    newDescription: "First description",
    yes: true,
    noCoolify: true,
    noGithub: true,
  });
  const m = readManifest(dir);
  assertEq(m?.description, "First description", "manifest.description");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
  assertEq(pkg.description, "First description", "package.json description");
});

await t("overwrites existing description", async () => {
  const dir = makeProject("Old blurb");
  cleanup.push(dir);
  await runSetDescription({
    projectDir: dir,
    newDescription: "New blurb",
    yes: true,
    noCoolify: true,
    noGithub: true,
  });
  const m = readManifest(dir);
  assertEq(m?.description, "New blurb", "manifest.description");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
  assertEq(pkg.description, "New blurb", "package.json description");
});

await t("--clear removes description from manifest + package.json", async () => {
  const dir = makeProject("Existing");
  cleanup.push(dir);
  await runSetDescription({
    projectDir: dir,
    clear: true,
    yes: true,
    noCoolify: true,
    noGithub: true,
  });
  const m = readManifest(dir);
  assertEq(m?.description, undefined, "manifest.description should be unset");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
  assertEq(pkg.description, undefined, "package.json description should be unset");
});

await t("no-op when new === old (returns without throwing)", async () => {
  const dir = makeProject("Same");
  cleanup.push(dir);
  // Should print "nothing to do" and return cleanly.
  await runSetDescription({
    projectDir: dir,
    newDescription: "Same",
    yes: true,
    noCoolify: true,
    noGithub: true,
  });
  const m = readManifest(dir);
  assertEq(m?.description, "Same", "description unchanged");
});

await t("--clear + --to throws", async () => {
  const dir = makeProject();
  cleanup.push(dir);
  let threw = false;
  try {
    await runSetDescription({
      projectDir: dir,
      newDescription: "Something",
      clear: true,
      yes: true,
      noCoolify: true,
      noGithub: true,
    });
  } catch {
    threw = true;
  }
  assertEq(threw, true, "should throw when --clear and --to combined");
});

await t("missing manifest throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "set-desc-nomf-"));
  cleanup.push(dir);
  let threw = false;
  try {
    await runSetDescription({
      projectDir: dir,
      newDescription: "x",
      yes: true,
      noCoolify: true,
      noGithub: true,
    });
  } catch {
    threw = true;
  }
  assertEq(threw, true, "should throw when manifest missing");
});

await t("dry-run does not write", async () => {
  const dir = makeProject("Before");
  cleanup.push(dir);
  await runSetDescription({
    projectDir: dir,
    newDescription: "After",
    yes: true,
    dryRun: true,
    noCoolify: true,
    noGithub: true,
  });
  const m = readManifest(dir);
  assertEq(m?.description, "Before", "manifest should not have changed in dry-run");
});

await t("_internals.rewriteManifestDescription deletes field on empty input", async () => {
  const dir = makeProject("Will be cleared");
  cleanup.push(dir);
  const m = readManifest(dir)!;
  _internals.rewriteManifestDescription(dir, m, "");
  const after = readManifest(dir);
  assertEq(after?.description, undefined, "empty input should delete the field");
});

for (const dir of cleanup) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

const failures = results.filter((r) => !r.ok);
console.log();
if (failures.length === 0) {
  console.log(`  ${results.length} passed`);
  process.exit(0);
} else {
  console.log(`  ${failures.length} of ${results.length} failed`);
  process.exit(1);
}
