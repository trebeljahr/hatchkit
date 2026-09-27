/*
 * cli/src/features/lockfile.ts — keep `starter/pnpm-lock.yaml` honest after a
 * feature that owns a workspace package has been stripped.
 *
 * The starter ships a committed lockfile because every scaffolded project's CI
 * and both Dockerfiles run `pnpm install --frozen-lockfile`, which is the whole
 * point of committing one: the image builds from the resolution that was
 * tested, not from whatever the registry serves that morning.
 *
 * That makes a strip a lockfile edit. `create` copies the starter and deletes
 * `packages/core`, `packages/raycast` or `packages/mcp`, and the lockfile it
 * copied alongside them still declares an importer for each. pnpm compares
 * importers against the workspace it finds and refuses:
 *
 *     ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"
 *     because pnpm-lock.yaml is not up to date with <project>
 *
 * The user sees that on their first CI run or their first image build, long
 * after the scaffold reported success, and nothing in the scaffold output
 * points at the cause. A local `pnpm install` fixes it and hides it, which is
 * why it survived: it only bites the people who push before they install.
 *
 * Editing YAML with string operations is usually a bad trade. Here it is the
 * right one: the alternative is shelling out to `pnpm install --lockfile-only`
 * during a scaffold, which needs the network, takes seconds, and resolves
 * every dependency afresh — so two projects scaffolded a week apart would ship
 * different lockfiles for the same template. Deleting an importer block is a
 * local, total, reversible edit to a file whose shape pnpm itself defines.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The file, relative to the deployable root. */
export const LOCKFILE_PATH = "pnpm-lock.yaml";

/**
 * Remove the `importers:` entry for each of `packagePaths` (as they appear in
 * the lockfile, e.g. `packages/core`).
 *
 * Returns the paths it actually removed, so a caller can report them. A path
 * with no entry is not an error: a strip runs whether or not the feature was
 * ever installed.
 *
 * Only the importer is removed. The `packages:` section keeps the resolutions
 * that importer was the only user of, which pnpm treats as extra rather than
 * as a mismatch — it prunes them on the next real install. Removing them here
 * would mean reference-counting every transitive dependency against the
 * remaining importers, which is the resolver's job and not a thing to
 * reimplement in a scaffolder.
 */
export function pruneLockfileImporters(
  outputDir: string,
  packagePaths: readonly string[],
): string[] {
  const path = join(outputDir, LOCKFILE_PATH);
  if (!existsSync(path) || packagePaths.length === 0) return [];

  const before = readFileSync(path, "utf-8");
  const lines = before.split("\n");

  const importersAt = lines.findIndex((line) => line === "importers:");
  if (importersAt === -1) return [];

  // The importers section runs until the next top-level key. Anything after it
  // — `packages:`, `snapshots:` — is out of bounds for this edit.
  let sectionEnd = lines.length;
  for (let i = importersAt + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  const removed: string[] = [];
  const keep = new Array<boolean>(lines.length).fill(true);

  for (const pkg of packagePaths) {
    const header = `  ${pkg}:`;
    const start = lines.findIndex(
      (line, i) => i > importersAt && i < sectionEnd && line === header,
    );
    if (start === -1) continue;

    // Through to the next sibling importer (two-space key) or the end of the
    // section. A deeper-indented line belongs to this importer.
    let end = sectionEnd;
    for (let i = start + 1; i < sectionEnd; i++) {
      if (/^ {2}\S/.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    for (let i = start; i < end; i++) keep[i] = false;
    removed.push(pkg);
  }

  if (removed.length === 0) return [];

  const after = lines.filter((_, i) => keep[i]).join("\n");
  if (after !== before) writeFileSync(path, after, "utf-8");
  return removed;
}

/** The importer paths currently declared in `content`, in file order. Used by
 *  the tests, and by anything that wants to assert the lockfile agrees with
 *  the tree on disk. */
export function lockfileImporters(content: string): string[] {
  const lines = content.split("\n");
  const importersAt = lines.findIndex((line) => line === "importers:");
  if (importersAt === -1) return [];
  const out: string[] = [];
  for (let i = importersAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^[^\s#]/.test(line)) break;
    const match = /^ {2}(\S.*):$/.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}

/** The dependency sections an importer block can carry, in lockfile order. */
const DEP_SECTIONS = ["dependencies", "optionalDependencies", "devDependencies"] as const;

/**
 * Drop every dependency entry the lockfile still declares for an importer
 * whose manifest no longer asks for it.
 *
 * The importer prune above handles a package that was deleted whole. This
 * handles the other half, and it predates these features by a long way: the
 * `desktop` and `mobile` strips rewrite the ROOT `package.json`, removing
 * twenty-one dependencies between them, and the lockfile's `.` importer still
 * lists all of them. So a plain `hatchkit create` with no native wrapper has
 * always produced a project whose first `pnpm install --frozen-lockfile` — its
 * CI, its server image, its client image — fails with ERR_PNPM_OUTDATED_LOCKFILE
 * and a list of dependencies that "were removed". Anyone who ran `pnpm install`
 * locally first never saw it, because that rewrites the lockfile and the
 * evidence with it.
 *
 * Only removal is handled, deliberately. A dependency the manifest gained is a
 * resolution this file cannot invent — no version, no integrity hash, no peer
 * resolution — and guessing one produces a lockfile that installs the wrong
 * thing rather than refusing. A scaffold only ever subtracts, so removal is
 * the whole of the problem here; anything else needs a real `pnpm install`.
 */
export function pruneLockfileSpecifiers(
  outputDir: string,
  importerPaths: readonly string[],
): string[] {
  const path = join(outputDir, LOCKFILE_PATH);
  if (!existsSync(path)) return [];

  const before = readFileSync(path, "utf-8");
  let lines = before.split("\n");
  const dropped: string[] = [];

  for (const importer of importerPaths) {
    const manifestRel = importer === "." ? "package.json" : join(importer, "package.json");
    const manifestPath = join(outputDir, manifestRel);
    if (!existsSync(manifestPath)) continue;

    let manifest: Record<string, Record<string, string> | undefined>;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      // A manifest we cannot read is one we must not edit the lockfile for.
      continue;
    }

    const bounds = importerBounds(lines, importer);
    if (!bounds) continue;

    const keep = new Array<boolean>(lines.length).fill(true);
    let section: (typeof DEP_SECTIONS)[number] | null = null;

    for (let i = bounds.start + 1; i < bounds.end; i++) {
      const line = lines[i] ?? "";
      const sectionMatch = /^ {4}(\w+):\s*$/.exec(line);
      if (sectionMatch) {
        const name = sectionMatch[1] as (typeof DEP_SECTIONS)[number];
        section = DEP_SECTIONS.includes(name) ? name : null;
        continue;
      }
      if (section === null) continue;

      const entryMatch = /^ {6}'?([^':]+)'?:\s*$/.exec(line);
      if (!entryMatch) continue;
      const dep = entryMatch[1];
      if (manifest[section]?.[dep] !== undefined) continue;

      // Drop the entry and its indented `specifier:` / `version:` lines.
      let end = i + 1;
      while (end < bounds.end && /^ {8}\S/.test(lines[end] ?? "")) end++;
      for (let j = i; j < end; j++) keep[j] = false;
      dropped.push(`${importer}:${dep}`);
      i = end - 1;
    }

    if (dropped.length > 0) lines = lines.filter((_, i) => keep[i]);
  }

  if (dropped.length === 0) return [];

  // A section whose every entry went is now a header with nothing under it,
  // which pnpm reads as a null value rather than as an empty map.
  lines = dropEmptyDepSections(lines);

  const after = lines.join("\n");
  if (after !== before) writeFileSync(path, after, "utf-8");
  return dropped;
}

function importerBounds(
  lines: readonly string[],
  importer: string,
): { start: number; end: number } | null {
  const importersAt = lines.findIndex((line) => line === "importers:");
  if (importersAt === -1) return null;
  let sectionEnd = lines.length;
  for (let i = importersAt + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }
  const start = lines.findIndex(
    (line, i) => i > importersAt && i < sectionEnd && line === `  ${importer}:`,
  );
  if (start === -1) return null;
  let end = sectionEnd;
  for (let i = start + 1; i < sectionEnd; i++) {
    if (/^ {2}\S/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function dropEmptyDepSections(lines: readonly string[]): string[] {
  const keep = new Array<boolean>(lines.length).fill(true);
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {4}(\w+):\s*$/.exec(lines[i] ?? "");
    if (!match || !DEP_SECTIONS.includes(match[1] as (typeof DEP_SECTIONS)[number])) continue;
    const next = lines[i + 1] ?? "";
    // Followed by anything that is not one of its own entries → it is empty.
    if (!/^ {6}\S/.test(next)) keep[i] = false;
  }
  return lines.filter((_, i) => keep[i]);
}

/**
 * Bring the committed lockfile back into agreement with the tree on disk, as
 * far as removal can.
 *
 * Two things can have gone out of step, and a scaffold does both:
 *
 *  - an importer whose directory no longer exists, because a feature that
 *    owned a workspace package was stripped;
 *  - a dependency an importer's manifest no longer asks for, because a strip
 *    rewrote that manifest.
 *
 * Either one makes `pnpm install --frozen-lockfile` refuse, which is what
 * every scaffolded project's CI and both its Dockerfiles run.
 *
 * This closes the REMOVAL half only, and that is the whole of what a scaffold
 * can close. A scaffold step that ADDS a dependency — the analytics wiring
 * adds `@sentry/browser` to the client — needs a resolution with a version and
 * an integrity hash, and inventing one produces a lockfile that installs the
 * wrong thing rather than one that refuses. So a project whose scaffold added
 * a dependency still needs one real `pnpm install` before its first push,
 * which is what `--install` does and what the scaffold summary says to do.
 * What this removes is the staleness that a plain install would have had to
 * fix silently, and that a feature owning a workspace package creates every
 * time it is not selected.
 *
 * Idempotent and safe to call more than once: it reads the tree each time and
 * removes only what the tree no longer has. A strip calls it so the strip owns
 * its own consequences, and `scaffoldApp` calls it once more at the end for
 * the strips that rewrite the root manifest without owning a package.
 */
export function reconcileLockfile(outputDir: string): string[] {
  const path = join(outputDir, LOCKFILE_PATH);
  if (!existsSync(path)) return [];

  const importers = lockfileImporters(readFileSync(path, "utf-8"));
  const orphaned = importers.filter((importer) => {
    if (importer === ".") return false;
    return !existsSync(join(outputDir, importer, "package.json"));
  });

  const notes: string[] = [];
  const gone = pruneLockfileImporters(outputDir, orphaned);
  if (gone.length > 0) notes.push(`pnpm-lock.yaml: dropped importers for ${gone.join(", ")}`);

  const remaining = lockfileImporters(readFileSync(path, "utf-8"));
  const stale = pruneLockfileSpecifiers(outputDir, remaining);
  if (stale.length > 0) {
    notes.push(`pnpm-lock.yaml: dropped ${stale.length} stale dependency entries`);
  }
  return notes;
}
