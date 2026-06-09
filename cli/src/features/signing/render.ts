/*
 * cli/src/features/signing/render.ts — Tiny template renderer for
 * signing assets.
 *
 * Reuses cli/src/templates/signing/ as the asset root (auto-copied to
 * dist/ by scripts/copy-templates.mjs). Substitution uses
 * `__HATCHKIT_<TOKEN>__` placeholders rather than Handlebars `{{X}}`
 * so YAML's `${{ secrets.X }}` and Apple's `__APPLE_TEAM_ID__` (sed-
 * substituted at CI time) survive unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** templates/signing/ inside the compiled cli/dist tree.
 *  dist layout: dist/features/signing/render.js + dist/templates/signing/... */
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "signing");

export type RenderTokens = {
  BUNDLE_ID?: string;
  APP_NAME?: string;
  APP_SLUG?: string;
  PNPM_VERSION?: string;
  NODE_VERSION?: string;
};

const TOKEN_NAMES: Array<keyof RenderTokens> = [
  "BUNDLE_ID",
  "APP_NAME",
  "APP_SLUG",
  "PNPM_VERSION",
  "NODE_VERSION",
];

/** Substitute `__HATCHKIT_<TOKEN>__` placeholders in `source`. Missing
 *  tokens are left as-is so a partial render is detectable in the
 *  output by a downstream consumer that greps for `__HATCHKIT_`. */
export function renderSigningString(source: string, tokens: RenderTokens): string {
  let out = source;
  for (const name of TOKEN_NAMES) {
    const value = tokens[name];
    if (value === undefined) continue;
    const needle = `__HATCHKIT_${name}__`;
    out = out.split(needle).join(value);
  }
  return out;
}

/** Read a template file from cli/src/templates/signing/<rel> and
 *  render it. Path separators are forward-slash. */
export function renderSigningTemplate(relPath: string, tokens: RenderTokens): string {
  const full = join(TEMPLATES_DIR, relPath);
  if (!existsSync(full)) {
    throw new Error(`Signing template not found: ${full}`);
  }
  const source = readFileSync(full, "utf-8");
  return renderSigningString(source, tokens);
}

/** Templates dir on disk — exposed for tests that snapshot-compare. */
export function getSigningTemplatesDir(): string {
  return TEMPLATES_DIR;
}

/** Resolve a `~`-prefixed or relative path to an absolute path against
 *  the user's home directory + the current working directory. Used by
 *  org-config to dereference paths the user typed into hatchkit. */
export function resolveUserPath(input: string): string {
  if (!input) return input;
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  if (input === "~") return homedir();
  return input;
}
