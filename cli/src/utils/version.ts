/*
 * CLI self-version lookup.
 *
 * Reads the `version` field from the CLI's own `package.json`. Works
 * from both the compiled `cli/dist/` entry point and the `tsx` dev
 * path (`cli/src/`). Falls back to "0.0.0" on any failure so callers
 * can safely splat it into logs without worrying about exceptions.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function getCliVersion(): string {
  try {
    const pkgPath = resolve(join(import.meta.dirname, "..", "..", "package.json"));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
