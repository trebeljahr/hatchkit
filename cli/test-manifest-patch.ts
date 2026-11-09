/**
 * Recording a value in `.hatchkit.json` must not write readManifest's
 * in-memory schema migration.
 *
 * 2026-11-10: `hatchkit email forward` in a public repo with a v1
 * manifest read the manifest (migrated to v5 in memory: seeded
 * `com.example.<name>` identifiers, email intent "none", topology, …) and
 * wrote all of it back next to the one forwarding record. Committed, the
 * placeholders would have read as real. The migration is `hatchkit
 * update`'s to write; every other command records its own keys with
 * `patchManifest`. Locked down:
 *
 *   1. `patchManifest` writes only the keys it is given onto the file as
 *      it is on disk: same version, other keys kept in value and order;
 *      `undefined` removes a key; `version` cannot be patched.
 *   2. rename-domain / rename-project / set-description keep the file's
 *      version too.
 *   3. Only the commands that own the whole file call `writeManifest`.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const { patchManifest, patchedManifestText, readManifestWithMigrationInfo } = await import(
  "./src/scaffold/manifest.js"
);
const renameDomain = (await import("./src/deploy/rename-domain.js"))._internals;
const renameProject = (await import("./src/deploy/rename-project.js"))._internals;
const setDescription = (await import("./src/deploy/set-description.js"))._internals;
type ProjectManifest = import("./src/scaffold/manifest.js").ProjectManifest;

const failures: string[] = [];
async function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const V1 = {
  version: 1,
  cliVersion: "0.1.0",
  scaffoldedAt: "2026-01-01T00:00:00.000Z",
  name: "studio-site",
  domain: "example.com",
  description: "Before",
  features: [],
  mlServices: [],
  s3Provider: "none",
  deployTarget: "existing",
  surfaces: "client-only",
  ports: { server: 3001, client: 3000 },
};

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "manifest-patch-"));
  writeFileSync(join(dir, ".hatchkit.json"), `${JSON.stringify(V1, null, 2)}\n`);
  return dir;
}
const onDisk = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8")) as Record<string, unknown>;

console.log("\npatchManifest:");

await expect("the fixture really migrates in memory (else this file tests nothing)", () => {
  const dir = project();
  try {
    const read = readManifestWithMigrationInfo(dir);
    assert.equal(read?.migrated, true);
    assert.equal(read?.manifest.version, 5);
    assert.ok(read?.manifest.identifiers, "v4 → v5 seeds identifiers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("writes only the given keys onto the file as it is on disk", () => {
  const dir = project();
  try {
    const localDev = { slug: "studio-site", domain: "studio-site.localhost" };
    assert.equal(patchManifest(dir, { localDev }), true);
    assert.deepEqual(onDisk(dir), { ...V1, localDev });
    assert.deepEqual(Object.keys(onDisk(dir)), [...Object.keys(V1), "localDev"]);

    patchManifest(dir, { localDev: undefined, description: "After" });
    assert.deepEqual(onDisk(dir), { ...V1, description: "After" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("never moves the schema version", () => {
  const dir = project();
  try {
    patchManifest(dir, { version: 5 } as never);
    assert.equal(onDisk(dir).version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("no manifest → nothing written; an unknown version still throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-patch-none-"));
  try {
    assert.equal(patchManifest(dir, { description: "x" }), false);
    assert.deepEqual(readdirSync(dir), []);
    writeFileSync(join(dir, ".hatchkit.json"), JSON.stringify({ version: 99 }));
    assert.throws(() => patchManifest(dir, { description: "x" }), /unknown version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\nother single-field writers:");

await expect("rename-domain, rename-project and set-description keep version 1", () => {
  const dir = project();
  try {
    const path = join(dir, ".hatchkit.json");
    const migrated = readManifestWithMigrationInfo(dir)!.manifest as ProjectManifest;

    const domainEdit = renameDomain.rewriteManifest(path, migrated, "example.org");
    assert.deepEqual(JSON.parse(domainEdit.after), { ...V1, domain: "example.org" });
    assert.equal(domainEdit.after, patchedManifestText(path, { domain: "example.org" }));

    const nameOp = renameProject.rewriteManifest(path, migrated, "new-name");
    assert.deepEqual(JSON.parse(nameOp.after), { ...V1, name: "new-name" });

    setDescription.rewriteManifestDescription(dir, migrated, "");
    const { description: _, ...withoutDescription } = V1;
    assert.deepEqual(onDisk(dir), withoutDescription);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\nwho writes the whole manifest:");

await expect("only create, adopt, update and a new file call writeManifest", () => {
  // Every other command records its keys with patchManifest. A new
  // caller here is a command that would persist the in-memory schema
  // migration as a side effect — use patchManifest, or, if the command
  // really owns the whole file, add it with a reason.
  const allowed: Record<string, number> = {
    "scaffold/app.ts": 1, // create
    "scaffold/update.ts": 1, // the migration command
    "adopt.ts": 1, // builds the manifest from the adopt plan
    "provision/index.ts": 1, // a minimal manifest where none exists
  };
  const src = fileURLToPath(new URL("./src/", import.meta.url));
  const found: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "templates") walk(path);
        continue;
      }
      if (!entry.endsWith(".ts") || entry === "manifest.ts") continue;
      const calls = readFileSync(path, "utf-8").match(/\bwriteManifest\(/g)?.length ?? 0;
      if (calls > 0) found[relative(src, path)] = calls;
    }
  };
  walk(src);
  assert.deepEqual(found, allowed);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nall manifest-patch checks passed");
