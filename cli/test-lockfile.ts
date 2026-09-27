/**
 * Lockfile reconciliation — `cli/src/features/lockfile.ts`.
 *
 * The starter commits a `pnpm-lock.yaml` because every scaffolded project's
 * CI and both its Dockerfiles run `pnpm install --frozen-lockfile`: the image
 * builds from the resolution that was tested, not from whatever the registry
 * serves that morning. That makes a strip a lockfile edit, and two different
 * strips invalidate it in two different ways:
 *
 *   · a feature that owns a workspace package is stripped, and the lockfile
 *     still declares an importer for a directory that is gone;
 *   · the desktop and mobile strips rewrite the ROOT package.json, and the
 *     lockfile still lists the twenty-one dependencies they removed.
 *
 * Either one is ERR_PNPM_OUTDATED_LOCKFILE on the project's first CI run —
 * and invisible to anyone who ran `pnpm install` locally first, because that
 * rewrites the lockfile and the evidence with it.
 *
 * Run: pnpm --filter hatchkit test:lockfile
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const {
  lockfileImporters,
  pruneLockfileImporters,
  pruneLockfileSpecifiers,
  reconcileLockfile,
} = await import("./src/features/lockfile.js");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${msg}`);
}

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@capacitor/core':
        specifier: ^8.3.4
        version: 8.3.4
      express:
        specifier: ^5.0.0
        version: 5.0.0
    devDependencies:
      electron:
        specifier: ^42.1.0
        version: 42.1.0
      typescript:
        specifier: ^6.0.3
        version: 6.0.3

  packages/core:
    dependencies:
      '@starter/shared':
        specifier: workspace:*
        version: link:../shared

  packages/mcp:
    dependencies:
      '@starter/core':
        specifier: workspace:*
        version: link:../core

  packages/shared:
    dependencies:
      zod:
        specifier: ^4.4.3
        version: 4.4.3

packages:

  zod@4.4.3:
    resolution: {integrity: sha512-deadbeef}

snapshots:

  zod@4.4.3: {}
`;

function project(manifests: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-"));
  writeFileSync(join(dir, "pnpm-lock.yaml"), LOCK, "utf-8");
  for (const [rel, manifest] of Object.entries(manifests)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  }
  return dir;
}

const dirs: string[] = [];
function scratch(manifests: Record<string, unknown>): string {
  const d = project(manifests);
  dirs.push(d);
  return d;
}

try {
  // ── reading ──────────────────────────────────────────────────────────
  assert(
    JSON.stringify(lockfileImporters(LOCK)) ===
      JSON.stringify([".", "packages/core", "packages/mcp", "packages/shared"]),
    `importers are read in file order (got ${lockfileImporters(LOCK).join(", ")})`,
  );

  // ── dropping an importer ─────────────────────────────────────────────
  {
    const d = scratch({});
    const gone = pruneLockfileImporters(d, ["packages/core", "packages/mcp"]);
    const after = readFileSync(join(d, "pnpm-lock.yaml"), "utf-8");
    assert(gone.length === 2, `both importers reported (${gone.join(", ")})`);
    assert(
      JSON.stringify(lockfileImporters(after)) === JSON.stringify([".", "packages/shared"]),
      `only the named importers go (left: ${lockfileImporters(after).join(", ")})`,
    );
    assert(!after.includes("link:../core"), "the dropped importer's body goes with it");
    assert(after.includes("packages:\n"), "the packages section survives");
    assert(after.includes("zod@4.4.3:"), "resolutions are left to pnpm to prune");
    // Idempotent.
    assert(
      pruneLockfileImporters(d, ["packages/core"]).length === 0,
      "removing an importer that is already gone reports nothing",
    );
  }

  // ── dropping a stale specifier ───────────────────────────────────────
  {
    // The root manifest no longer wants capacitor or electron — exactly what
    // the mobile and desktop strips do to it.
    const d = scratch({
      "package.json": { dependencies: { express: "^5.0.0" }, devDependencies: { typescript: "^6.0.3" } },
    });
    const dropped = pruneLockfileSpecifiers(d, ["."]);
    const after = readFileSync(join(d, "pnpm-lock.yaml"), "utf-8");
    assert(dropped.length === 2, `both stale entries reported (${dropped.join(", ")})`);
    assert(!after.includes("'@capacitor/core':"), "a quoted scoped entry is removed");
    assert(!after.includes("electron:"), "an unquoted entry is removed");
    assert(after.includes("express:"), "an entry the manifest still wants survives");
    assert(after.includes("typescript:"), "so does one in another section");
    assert(after.includes("      version: 5.0.0"), "the survivor keeps its resolution");
    assert(
      pruneLockfileSpecifiers(d, ["."]).length === 0,
      "a second pass over the same tree reports nothing",
    );
  }

  // ── an emptied section is removed, not left dangling ────────────────
  {
    const d = scratch({ "package.json": { dependencies: { express: "^5.0.0" } } });
    pruneLockfileSpecifiers(d, ["."]);
    const after = readFileSync(join(d, "pnpm-lock.yaml"), "utf-8");
    assert(
      !/devDependencies:\s*\n\s*\n/.test(after) && !after.includes("    devDependencies:\n\n"),
      "a section whose every entry went is removed rather than left with no value",
    );
    assert(after.includes("express:"), "the section that still has an entry stays");
  }

  // ── an unreadable manifest is left alone ─────────────────────────────
  {
    const d = scratch({});
    writeFileSync(join(d, "package.json"), "{ not json", "utf-8");
    const before = readFileSync(join(d, "pnpm-lock.yaml"), "utf-8");
    pruneLockfileSpecifiers(d, ["."]);
    assert(
      readFileSync(join(d, "pnpm-lock.yaml"), "utf-8") === before,
      "a manifest that cannot be parsed is not a licence to edit the lockfile",
    );
  }

  // ── reconcile: both halves, driven by the tree ───────────────────────
  {
    // `packages/core` and `packages/mcp` were stripped (no manifest on disk),
    // and the root manifest lost its native dependencies.
    const d = scratch({
      "package.json": { dependencies: { express: "^5.0.0" }, devDependencies: { typescript: "^6.0.3" } },
      "packages/shared/package.json": { dependencies: { zod: "^4.4.3" } },
    });
    const notes = reconcileLockfile(d);
    const after = readFileSync(join(d, "pnpm-lock.yaml"), "utf-8");
    assert(notes.length === 2, `both halves reported (${notes.join(" | ")})`);
    assert(
      JSON.stringify(lockfileImporters(after)) === JSON.stringify([".", "packages/shared"]),
      `orphaned importers go by directory, not by name (left: ${lockfileImporters(after).join(", ")})`,
    );
    assert(!after.includes("'@capacitor/core':"), "stale root dependencies go too");
    assert(after.includes("zod:"), "a package still on disk keeps its importer");
    assert(reconcileLockfile(d).length === 0, "reconcile is idempotent");
  }

  // ── the root importer is never dropped ───────────────────────────────
  {
    // No root package.json on disk at all. `.` must still survive: a lockfile
    // with no root importer is not a lockfile pnpm will accept, and a missing
    // root manifest means something is wrong that this file cannot fix.
    const d = scratch({ "packages/shared/package.json": { dependencies: { zod: "^4.4.3" } } });
    reconcileLockfile(d);
    const after = lockfileImporters(readFileSync(join(d, "pnpm-lock.yaml"), "utf-8"));
    assert(after.includes("."), `the root importer survives (left: ${after.join(", ")})`);
  }

  // ── no lockfile is not an error ──────────────────────────────────────
  {
    const d = mkdtempSync(join(tmpdir(), "lockfile-none-"));
    dirs.push(d);
    assert(reconcileLockfile(d).length === 0, "a project with no lockfile reports nothing");
    assert(pruneLockfileImporters(d, ["packages/core"]).length === 0, "…and neither does a prune");
  }

  if (failed === 0) {
    console.log("test-lockfile: ok");
  } else {
    console.error(`test-lockfile: ${failed} assertion(s) failed`);
    process.exit(1);
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
