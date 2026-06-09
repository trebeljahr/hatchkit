/*
 * cli/src/features/signing/project-config.ts — Per-project signing
 * config persistence (Tier 2 — the resources Hatchkit creates per
 * project). Lives inside the project manifest at `manifest.signing`.
 *
 * NEVER stores plaintext secrets. Only:
 *   · Bundle ID + app name
 *   · Apple Bundle ID resource id, App record id, Provisioning Profile
 *     id + name (returned by ASC POST)
 *   · Path to the local Android keystore + `github://<secret>` ref
 *   · Whether the user opted in / which platforms
 *
 * Subsequent re-runs use these to GET-before-POST against ASC and to
 * refuse Android keystore regeneration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILENAME, type ProjectManifest } from "../../scaffold/manifest.js";
import type { SigningProjectConfig } from "./types.js";

/** Manifest extension: `manifest.signing`. Persisted as part of
 *  `.hatchkit.json`. */
export type ManifestWithSigning = ProjectManifest & { signing?: SigningProjectConfig };

/** Read the signing block from a project's manifest, raw — no
 *  migration. Returns undefined when the manifest doesn't yet have
 *  one. */
export function readSigningProjectConfig(projectDir: string): SigningProjectConfig | undefined {
  const path = join(projectDir, MANIFEST_FILENAME);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as ManifestWithSigning;
    return raw.signing;
  } catch {
    return undefined;
  }
}

/** Merge-write the signing block into the project's manifest. Skips
 *  the write when the manifest file doesn't exist (a scaffolded project
 *  should always have one; an adopt-time path shouldn't write signing
 *  before adopt's manifest creation step has run). */
export function writeSigningProjectConfig(
  projectDir: string,
  patch: Partial<SigningProjectConfig>,
): SigningProjectConfig | undefined {
  const path = join(projectDir, MANIFEST_FILENAME);
  if (!existsSync(path)) return undefined;
  let raw: ManifestWithSigning;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as ManifestWithSigning;
  } catch (err) {
    throw new Error(`Project manifest at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const current = raw.signing ?? {
    enabled: false,
    bundleId: "",
    appName: "",
    appSlug: "",
    platforms: [],
  };
  const next: SigningProjectConfig = { ...current, ...patch };
  raw.signing = next;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  return next;
}

/** Validate a bundle ID:
 *    · all lowercase
 *    · 2+ dot-separated segments
 *    · each segment matches `[a-z][a-z0-9]*` (no hyphens, no leading digits)
 *  Returns the matched normalized form or throws a helpful error. */
export function validateBundleId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Bundle ID is required.");
  if (trimmed !== trimmed.toLowerCase()) {
    throw new Error(`Bundle ID must be lowercase: ${trimmed}`);
  }
  const segments = trimmed.split(".");
  if (segments.length < 2) {
    throw new Error(`Bundle ID needs at least 2 dot-separated segments (got "${trimmed}").`);
  }
  for (const seg of segments) {
    if (!/^[a-z][a-z0-9]*$/.test(seg)) {
      throw new Error(
        `Bundle ID segment "${seg}" is invalid — must start with a letter, lowercase letters and digits only, no hyphens.`,
      );
    }
  }
  return trimmed;
}

/** Slugify a project name into kebab-case for use as an Apple SKU and
 *  Android keystore filename. */
export function projectKebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+)|(-+$)/g, "");
}

/** Suggest a Bundle ID from an org's package prefix + the project slug,
 *  e.g. ("com.mesozoicprotocol", "tiao") → "com.mesozoicprotocol.tiao".
 *  Falls back to "com.example.<slug>" when no prefix is configured. */
export function suggestBundleId(packagePrefix: string | undefined, projectName: string): string {
  const slug = projectKebab(projectName).replace(/-/g, "");
  const prefix = packagePrefix?.trim() || "com.example";
  return `${prefix}.${slug}`;
}
