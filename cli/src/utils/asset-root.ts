import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Source commands use the checkout; compiled commands use the shipped bundle. */
export function resolveAssetRoot(): string {
  const cliRoot = resolve(import.meta.dirname, "..", "..");
  if (basename(dirname(import.meta.dirname)) === "src") return resolve(cliRoot, "..");
  const checkout = resolve(cliRoot, "..");
  try {
    if (
      JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).name ===
        "hatchkit-monorepo" &&
      existsSync(join(checkout, "starter/package.json"))
    )
      return checkout;
  } catch {
    /* An installed package has no repository parent. */
  }
  const bundle = join(cliRoot, "dist", "bundle");
  if (!existsSync(join(bundle, "starter", "package.json"))) {
    throw new Error(
      "Hatchkit's template bundle is missing. Reinstall hatchkit, or rebuild this checkout.",
    );
  }
  return bundle;
}

/** Provider state belongs in the user's config directory, never the npm cache. */
export function prepareInfrastructureRoot(cacheRoot: string): string {
  const source = resolveAssetRoot();
  if (basename(source) !== "bundle") return source;
  const target = join(cacheRoot, "infra");
  if (!existsSync(target)) {
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    const staging = `${target}.${process.pid}.tmp`;
    try {
      cpSync(join(source, "infra"), staging, { recursive: true });
      try {
        renameSync(staging, target);
      } catch (error) {
        if (!existsSync(target)) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return cacheRoot;
}
