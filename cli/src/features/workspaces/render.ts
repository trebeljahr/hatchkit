/*
 * cli/src/features/workspaces/render.ts — template renderer for the
 * `workspaces` feature.
 *
 * Reuses cli/src/templates/workspaces/ as the asset root (auto-copied to
 * dist/ by scripts/copy-templates.mjs). Substitution uses
 * `__HATCHKIT_<TOKEN>__` placeholders rather than Handlebars `{{X}}`,
 * because the emitted files are TSX: `style={{ ... }}` and every other
 * double-brace in JSX would be eaten by a Handlebars pass.
 *
 * Templates carry a `.tmpl` suffix so neither `tsc` (which compiles
 * `src/**` for the CLI) nor `biome check src` treats the emitted app
 * source as CLI source.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** dist layout: dist/features/workspaces/render.js + dist/templates/workspaces/... */
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "workspaces");

export type WorkspacesTokens = {
  PROJECT_NAME?: string;
  SHARED_PKG?: string;
  PENDING_INVITE_CAP?: string;
  INVITES_PER_HOUR?: string;
  INVITE_TTL_DAYS?: string;
};

const TOKEN_NAMES: Array<keyof WorkspacesTokens> = [
  "PROJECT_NAME",
  "SHARED_PKG",
  "PENDING_INVITE_CAP",
  "INVITES_PER_HOUR",
  "INVITE_TTL_DAYS",
];

/** The values every render starts from. A caller overrides what it must. */
export function defaultTokens(projectName: string): Required<WorkspacesTokens> {
  return {
    PROJECT_NAME: projectName,
    SHARED_PKG: "@starter/shared",
    PENDING_INVITE_CAP: "50",
    INVITES_PER_HOUR: "20",
    INVITE_TTL_DAYS: "7",
  };
}

/**
 * Substitute `__HATCHKIT_<TOKEN>__` placeholders. A token with no value is
 * left in place so a partial render is detectable downstream by grepping
 * the output for `__HATCHKIT_` — `assertFullyRendered` does exactly that.
 */
export function renderWorkspacesString(source: string, tokens: WorkspacesTokens): string {
  let out = source;
  for (const name of TOKEN_NAMES) {
    const value = tokens[name];
    if (value === undefined) continue;
    out = out.split(`__HATCHKIT_${name}__`).join(value);
  }
  return out;
}

/** Read `cli/src/templates/workspaces/<rel>` and render it. */
export function renderWorkspacesTemplate(relPath: string, tokens: WorkspacesTokens): string {
  const full = join(TEMPLATES_DIR, relPath);
  if (!existsSync(full)) {
    throw new Error(`Workspaces template not found: ${full}`);
  }
  return renderWorkspacesString(readFileSync(full, "utf-8"), tokens);
}

/**
 * Refuse to write a file that still carries a placeholder. An unrendered
 * `__HATCHKIT_PENDING_INVITE_CAP__` compiles to a TS syntax error in the
 * user's project, hundreds of lines from anything they wrote.
 */
export function assertFullyRendered(relPath: string, rendered: string): void {
  const leftover = rendered.match(/__HATCHKIT_[A-Z0-9_]+__/);
  if (leftover) {
    throw new Error(
      `Workspaces template ${relPath} still holds ${leftover[0]} after rendering. ` +
        `Add the token to WorkspacesTokens in features/workspaces/render.ts.`,
    );
  }
}

/** Templates dir on disk — exposed for tests that walk the tree. */
export function getWorkspacesTemplatesDir(): string {
  return TEMPLATES_DIR;
}
