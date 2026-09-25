/*
 * cli/src/features/auth-account-security/render.ts — template renderer
 * for the account-security app sources.
 *
 * Same approach as the signing feature: assets live under
 * cli/src/templates/auth-account-security/ (copied into dist/ by
 * scripts/copy-templates.mjs) and carry `__HATCHKIT_<TOKEN>__`
 * placeholders rather than Handlebars `{{X}}`.
 *
 * Handlebars is not an option here. These templates are TSX, and
 * `style={{ ... }}`, `useState({{` and every nested object literal in a
 * prop would parse as a Handlebars expression. A placeholder spelled
 * `__HATCHKIT_X__` cannot collide with anything JavaScript or JSX means.
 *
 * Templates are stored with a `.tpl` suffix (`avatar.ts.tpl`) so that
 * `tsc --noEmit` over `src/**` and biome's linter both walk past them —
 * they are project sources for a DIFFERENT project, with imports that
 * only resolve once they are written into a scaffolded app.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** templates/auth-account-security/ inside the compiled cli/dist tree.
 *  dist layout: dist/features/auth-account-security/render.js plus
 *  dist/templates/auth-account-security/... */
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "auth-account-security");

export type AuthSecurityTokens = {
  /** Project name, as typed at `hatchkit create`. Used for the TOTP
   *  issuer, which is the label an authenticator app shows. */
  PROJECT_NAME?: string;
  /** The workspace scope of the generated monorepo (`@starter` in the
   *  stock template), so shared imports resolve. */
  SHARED_SCOPE?: string;
  /** Where a freshly authenticated user lands. */
  POST_AUTH_REDIRECT?: string;
  /** Comma-free, quoted, comma-joined list of allowed `?next=` prefixes,
   *  already formatted as TypeScript array elements. */
  SAFE_NEXT_PREFIXES?: string;
  /** `"…"` list of better-auth server plugin call expressions, rendered
   *  one per line and already in mandatory registration order. */
  SERVER_PLUGINS?: string;
  /** Same for the client. */
  CLIENT_PLUGINS?: string;
  /** Import lines the plugin selection needs, newline-joined. */
  SERVER_PLUGIN_IMPORTS?: string;
  CLIENT_PLUGIN_IMPORTS?: string;
  /** The deletion cascade is rendered from the selection rather than
   *  written once, because a project without profile pictures has no
   *  `Avatar` model — and a cascade that named a collection with no model
   *  behind it would fail at import time, taking the whole server down
   *  rather than the one call that needed it. */
  DELETION_APP_COLLECTIONS?: string;
  DELETION_USER_STEPS?: string;
  DELETION_MODEL_IMPORTS?: string;
  DELETION_MODEL_MAP?: string;
};

const TOKEN_NAMES: Array<keyof AuthSecurityTokens> = [
  "PROJECT_NAME",
  "SHARED_SCOPE",
  "POST_AUTH_REDIRECT",
  "SAFE_NEXT_PREFIXES",
  "SERVER_PLUGINS",
  "CLIENT_PLUGINS",
  "SERVER_PLUGIN_IMPORTS",
  "CLIENT_PLUGIN_IMPORTS",
  "DELETION_APP_COLLECTIONS",
  "DELETION_USER_STEPS",
  "DELETION_MODEL_IMPORTS",
  "DELETION_MODEL_MAP",
];

/** Substitute `__HATCHKIT_<TOKEN>__` placeholders in `source`. A token
 *  the caller did not supply is left in place, so a partial render is
 *  detectable downstream by grepping for `__HATCHKIT_`. */
export function renderAuthSecurityString(source: string, tokens: AuthSecurityTokens): string {
  let out = source;
  for (const name of TOKEN_NAMES) {
    const value = tokens[name];
    if (value === undefined) continue;
    out = out.split(`__HATCHKIT_${name}__`).join(value);
  }
  return out;
}

/** Read `cli/src/templates/auth-account-security/<rel>` and render it.
 *  `rel` uses forward slashes and omits the `.tpl` suffix, which this
 *  adds — callers name the file they are writing (`client/safe-next.ts`),
 *  not the file it is stored as. */
export function renderAuthSecurityTemplate(rel: string, tokens: AuthSecurityTokens): string {
  const full = join(TEMPLATES_DIR, `${rel}.tpl`);
  if (!existsSync(full)) {
    throw new Error(`Account-security template not found: ${full}`);
  }
  return renderAuthSecurityString(readFileSync(full, "utf-8"), tokens);
}

/** Templates dir on disk — exposed so the test suite can enumerate it
 *  and assert every template a plan names actually ships. */
export function getAuthSecurityTemplatesDir(): string {
  return TEMPLATES_DIR;
}

/** Render a list of plugin call expressions into the body of a
 *  `plugins: [ ... ]` array, one per line at `indent` spaces.
 *
 *  Order in, order out — this function must never sort. The caller has
 *  already run the list through `plugin-order.ts`, and a tidy-up here
 *  would silently undo the one rule the feature has. */
export function renderPluginList(calls: readonly string[], indent: number): string {
  if (calls.length === 0) return "";
  const pad = " ".repeat(indent);
  return calls.map((call) => `${pad}${call},`).join("\n");
}
