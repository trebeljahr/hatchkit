/*
 * cli/src/features/templates.ts — read and render a feature's template
 * assets.
 *
 * ============================================================
 * WHY `__HATCHKIT_X__` AND NOT `{{X}}`
 * ============================================================
 *
 * Feature templates are mostly GitHub Actions workflows, Apple plists
 * and Docker/compose fragments. Those formats already use braces for
 * their own substitution: a workflow is full of `${{ secrets.FOO }}`,
 * which a Handlebars pass would either mangle or force every template
 * to escape. Apple's tooling has the same problem in the other
 * direction — an `ExportOptions.plist` carries `__APPLE_TEAM_ID__`
 * placeholders that a CI step substitutes with `sed` at BUILD time,
 * long after hatchkit has finished.
 *
 * So feature templates use `__HATCHKIT_<TOKEN>__`, a shape that appears
 * in none of those languages, and an unknown token is left verbatim
 * rather than replaced with an empty string. A partially-rendered file
 * is then detectable — grep it for `__HATCHKIT_` — instead of shipping
 * as a plausible-looking file with a hole in it.
 *
 * (The starter tree uses `{{name}}` instead. Different problem: the
 * starter is copied wholesale and patched, its files are ordinary
 * TypeScript and JSON, and `{{…}}` collides with nothing there. See
 * `cli/src/scaffold/identifiers.ts` for that token set.)
 *
 * ============================================================
 * WHERE TEMPLATES LIVE AT RUNTIME
 * ============================================================
 *
 * Source: `cli/src/templates/<feature>/…`
 * Shipped: `cli/dist/templates/<feature>/…`
 *
 * `cli/scripts/copy-templates.mjs` copies the whole `src/templates`
 * tree into `dist/` as part of `pnpm build`, because `tsc` emits only
 * TypeScript output and would otherwise leave a published CLI with no
 * templates at all. The copy is recursive and unconditional, so a new
 * directory under `src/templates/` is picked up with no registration —
 * but it must be under `src/templates/`. A template file parked next to
 * its feature's `.ts` source is silently missing from the published
 * package, and the failure appears only on a user's machine.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectIdentifiers } from "../scaffold/identifiers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `dist/features/templates.js` → `dist/templates`. The same two hops
 *  work from `src/features/templates.ts` → `src/templates` under tsx,
 *  so `pnpm dev` and the built CLI resolve to the same tree. */
const TEMPLATES_ROOT = join(HERE, "..", "templates");

export type TemplateTokens = Record<string, string | undefined>;

/** Absolute path of the shared templates root. Exposed for tests that
 *  enumerate templates rather than render them. */
export function getTemplatesRoot(): string {
  return TEMPLATES_ROOT;
}

/** Absolute path of one feature's template directory. */
export function getFeatureTemplateDir(featureDir: string): string {
  return join(TEMPLATES_ROOT, featureDir);
}

/**
 * Substitute `__HATCHKIT_<TOKEN>__` placeholders.
 *
 * Tokens whose value is `undefined` are left in place on purpose — see
 * the note above. Substitution is literal (`split`/`join`), never a
 * regex, so a value containing `$&` or a backslash cannot corrupt the
 * output.
 */
export function renderTemplateString(source: string, tokens: TemplateTokens): string {
  let out = source;
  for (const [name, value] of Object.entries(tokens)) {
    if (value === undefined) continue;
    out = out.split(`__HATCHKIT_${name}__`).join(value);
  }
  return out;
}

/** Read `cli/src/templates/<featureDir>/<relPath>` and render it.
 *  `relPath` uses forward slashes regardless of platform. */
export function renderFeatureTemplate(
  featureDir: string,
  relPath: string,
  tokens: TemplateTokens,
): string {
  const full = join(getFeatureTemplateDir(featureDir), ...relPath.split("/"));
  if (!existsSync(full)) {
    throw new Error(
      `Template not found: ${full}. Feature templates must live under cli/src/templates/ — anything elsewhere is not copied into dist/ by scripts/copy-templates.mjs and is missing from the published CLI.`,
    );
  }
  return renderTemplateString(readFileSync(full, "utf-8"), tokens);
}

/** Every template file under a feature's directory, as forward-slash
 *  relative paths. Used by tests that assert every shipped template
 *  renders with no leftover tokens. */
export function listFeatureTemplates(featureDir: string): string[] {
  const root = getFeatureTemplateDir(featureDir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** Placeholders still present after a render. A non-empty result means
 *  the template uses a token the caller did not supply — which would
 *  otherwise ship a literal `__HATCHKIT_FOO__` into a user's repo. */
export function findUnrenderedTokens(rendered: string): string[] {
  return [...new Set(rendered.match(/__HATCHKIT_[A-Z0-9_]+__/g) ?? [])].sort();
}

/**
 * The token set every feature template can rely on, derived from the
 * project's frozen identifiers.
 *
 * A feature adds its own tokens on top; it does not invent an
 * alternative spelling of one of these. If two features each rendered
 * their own idea of the bundle id, the agreement check in
 * `cli/src/scaffold/identifier-agreement.ts` would be the thing that
 * caught it — after the files were written.
 */
export function identifierTemplateTokens(ids: ProjectIdentifiers): TemplateTokens {
  return {
    PROJECT_SLUG: ids.slug,
    IDENTIFIER_TOKEN: ids.token,
    PRODUCT_NAME: ids.productName,
    SHORT_NAME: ids.shortName,
    BUNDLE_ID: ids.bundleId,
    ORG_DOMAIN: ids.orgDomain,
    STORAGE_PREFIX: ids.storagePrefix,
    KEYCHAIN_SERVICE: ids.keychainService,
    CLIENT_HEADER: ids.clientHeader,
    WEBHOOK_HEADER_PREFIX: ids.webhookHeaderPrefix,
    DATABASE_NAME: ids.databaseName,
    EXPORT_FILE_PREFIX: ids.exportFilePrefix,
    ENV_PREFIX: ids.envPrefix,
    NPM_SCOPE: ids.npmScope,
    DESKTOP_SCHEME: ids.desktopOrigin.scheme,
    DESKTOP_HOST: ids.desktopOrigin.host,
    DESKTOP_ORIGIN: `${ids.desktopOrigin.scheme}://${ids.desktopOrigin.host}`,
    // The pre-identifier signing templates spell the slug `APP_SLUG`
    // and the launcher label `APP_NAME`. Kept as aliases so those
    // templates keep rendering; new templates use the names above.
    APP_SLUG: ids.slug,
    APP_NAME: ids.shortName,
  };
}
