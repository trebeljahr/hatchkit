/*
 * package.json surgery helpers for scaffoldApp.
 *
 * Every helper here reads the root `package.json` from the scaffolded
 * output directory, mutates one field, and writes back. Kept in one
 * place so the read/parse/write cycle stays consistent and so it's
 * easy to swap for a more atomic approach later (e.g. one read, batched
 * edits, one write).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function stripPackageJsonScripts(outputDir: string, names: string[]): void {
  const path = join(outputDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  if (!pkg.scripts) return;
  for (const name of names) delete pkg.scripts[name];
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

export function stripPackageJsonDeps(outputDir: string, names: string[]): void {
  const path = join(outputDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  for (const name of names) {
    if (pkg.dependencies) delete pkg.dependencies[name];
    if (pkg.devDependencies) delete pkg.devDependencies[name];
    if (pkg.optionalDependencies) delete pkg.optionalDependencies[name];
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

export function stripPackageJsonBuildBlock(outputDir: string): void {
  const path = join(outputDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  delete pkg.build;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

/** Drop the `pnpm typecheck:electron` segment from the root `typecheck`
 *  script regardless of where it sits in the `&&` chain. Handles:
 *    "A && pnpm typecheck:electron"   → "A"
 *    "pnpm typecheck:electron && A"   → "A"
 *    "pnpm typecheck:electron"        → <script deleted entirely>
 */
export function unchainTypecheckScript(outputDir: string): void {
  const path = join(outputDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  if (!pkg.scripts?.typecheck) return;
  const ELECTRON_SEG = /\s*pnpm\s+typecheck:electron\s*/;
  let script: string = pkg.scripts.typecheck;
  script = script
    .replace(new RegExp(`&&${ELECTRON_SEG.source}`), "")
    .replace(new RegExp(`${ELECTRON_SEG.source}&&`), "")
    .replace(ELECTRON_SEG, "")
    .trim();
  if (script) {
    pkg.scripts.typecheck = script;
  } else {
    delete pkg.scripts.typecheck;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

/** Set (or clear) the `description` field on the root `package.json`.
 *  Passing an empty string deletes the field so we don't ship an empty
 *  description through to npm metadata. */
export function setPackageJsonDescription(outputDir: string, description: string): void {
  const path = join(outputDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  const trimmed = description.trim();
  if (trimmed) {
    pkg.description = trimmed;
  } else {
    delete pkg.description;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

/** Set a specific script entry in the root `package.json`. Creates
 *  `scripts` if missing. */
export function setPackageJsonScript(outputDir: string, name: string, value: string): void {
  const path = join(outputDir, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  pkg.scripts = pkg.scripts ?? {};
  pkg.scripts[name] = value;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

/** Read the `name` field from a workspace package's package.json. */
export function readPackageName(pkgDir: string): string | undefined {
  const path = join(pkgDir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8"));
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** Return every workspace package's `name` field from its package.json.
 *  Used to populate Next's `transpilePackages` dynamically instead of
 *  hardcoding `@starter/*` names. */
export function readWorkspacePackageNames(outputDir: string): string[] {
  const packagesDir = join(outputDir, "packages");
  if (!existsSync(packagesDir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(packagesDir)) {
    const name = readPackageName(join(packagesDir, entry));
    if (name) names.push(name);
  }
  return names;
}
