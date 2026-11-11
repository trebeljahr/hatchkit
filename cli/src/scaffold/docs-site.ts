/*
 * The starter's documentation site, and `hatchkit create --no-docs`.
 *
 * The starter ships a Docusaurus site in `docs-site/`. On a Coolify-deployed
 * project the docs-in-client operational module builds it into the web
 * client's image and publishes it at `https://<domain>/docs/`: a copy step in
 * `packages/client/Dockerfile`, the "Verify the docs build" step in the deploy
 * workflow, the docs sitemap in the robots route. Every one of those is
 * written only when `docs-site/package.json` exists (see
 * `features/docs-in-client/index.ts`), so removing the package before that
 * module runs is what keeps them out — there is nothing to take back later.
 *
 * What this removes is the rest: the package itself, its workspace entry, the
 * `dev:docs` scripts, the launch configuration that starts it, and its
 * ignore rules. The lockfile importer goes with the final lockfile reconcile in
 * `scaffold/app.ts`, which drops importers for directories that are gone.
 *
 * Must run before `applyDevLauncher`, which writes the `dev:docs` scripts back
 * whenever `docs-site/` is still on disk.
 */

import { join } from "node:path";
import { stripPackageJsonScripts } from "./pkg-json.js";
import { removeIfExists, rewriteFile } from "./starter-files.js";
import { dropWorkspaceEntry } from "./surfaces.js";

export const DOCS_SITE_DIR = "docs-site";

/** Root scripts that start the docs site next to the app. */
export const DOCS_SITE_SCRIPTS = ["dev:docs", "dev:docs:fixed"] as const;

/** Whether this project gets the documentation site: on unless the person
 *  said no. Surfaces with no client (`backend`) and the static hosts drop it
 *  in their own prune, whatever this says. */
export function wantsDocsSite(config: { docsSite?: boolean }): boolean {
  return config.docsSite !== false;
}

/** Remove the documentation site from a freshly copied starter. Returns the
 *  modification lines for the scaffold summary. Idempotent. */
export function stripDocsSite(outputDir: string): string[] {
  removeIfExists(join(outputDir, DOCS_SITE_DIR));
  dropWorkspaceEntry(outputDir, DOCS_SITE_DIR);
  stripPackageJsonScripts(outputDir, [...DOCS_SITE_SCRIPTS]);
  rewriteFile(join(outputDir, ".gitignore"), stripDocsSiteGitignore);
  rewriteFile(join(outputDir, ".claude/launch.json"), stripDocsSiteLaunchConfig);
  return ["removed: docs-site/ (Docusaurus), its workspace entry and the dev:docs scripts"];
}

/** Drop the `# Docusaurus` block of the starter's .gitignore. */
export function stripDocsSiteGitignore(content: string): string {
  return content.replace(/^# Docusaurus\n(?:docs-site\/[^\n]*\n)+\n?/m, "");
}

/** Drop the `docs` entry of the starter's preview launch configuration.
 *  Text-level, so the file keeps its layout; anything that would not parse
 *  afterwards is returned unchanged. */
export function stripDocsSiteLaunchConfig(content: string): string {
  const next = content.replace(
    /\n[ \t]*\{\n[ \t]*"name": "docs",\n[\s\S]*?\n[ \t]*\},?(?=\n)/,
    (block) => (block.includes('"docs-site"') ? "" : block),
  );
  try {
    JSON.parse(next);
    return next;
  } catch {
    return content;
  }
}
