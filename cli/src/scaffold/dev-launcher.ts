/*
 * Per-project wiring for `scripts/dev.mjs`.
 *
 * The launcher itself is base infrastructure — it ships in every scaffold
 * and is the same file everywhere. Two things in it are facts about the
 * project rather than about the tool, and this module writes both:
 *
 *   · the pinned ports, which hatchkit allocates per project so two
 *     scaffolds on one machine never fight;
 *   · the native shells' document origins, which depend on the feature
 *     set and which the dev server has to trust or sign-in answers
 *     403 INVALID_ORIGIN before the password is ever checked.
 *
 * Why the ports are pinned at all, and why there are three commands:
 *
 *   dev         pinned ports. Saved logins, password managers, bookmarks
 *               and every client that bakes its API URL in at build time
 *               (a browser extension, a desktop or mobile shell) cannot
 *               follow a port that moves per run.
 *   dev:auto    every port auto-picked, for agents and second instances.
 *   dev:fixed   the pinned ports or a non-zero exit — never a fallback.
 *
 * Inside a git worktree the default behaves like `dev:auto`, so several
 * agents run side by side without stepping on the main checkout. That
 * rule lives in the launcher, not here.
 *
 * Pure string transforms plus one thin `apply` wrapper, so the rewrites
 * are unit-testable without a scaffold on disk.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectPorts } from "../utils/ports.js";
import { nativeClientOrigins } from "./native-origins.js";
import { setPackageJsonScript } from "./pkg-json.js";

/** Local rather than `starter-files.ts`'s `rewriteFile`: that module
 *  imports this one for the port rewrite, and a cycle between the two
 *  would make evaluation order load-bearing. */
function rewriteIfExists(path: string, fn: (content: string) => string): void {
  if (!existsSync(path)) return;
  writeFileSync(path, fn(readFileSync(path, "utf-8")), "utf-8");
}

export const DEV_LAUNCHER_REL_PATH = "scripts/dev.mjs";

/** What `scripts/dev.mjs` needs beside it. Two are imported; the reaper is
 *  spawned by path at run time, which is why a missing one shows up as a
 *  launcher that dies on start rather than as a lint error. Any command that
 *  puts the launcher into a repo has to put these there too. */
export const DEV_LAUNCHER_LIB_FILES: readonly string[] = [
  "scripts/lib/process-group.mjs",
  "scripts/lib/dev-reaper.mjs",
  "scripts/lib/dev-watchers.mjs",
];

/** The scripts the port policy needs on the root package.json. Every one
 *  of them is the same file with a different flag — there is one launcher,
 *  not three. */
export const DEV_LAUNCHER_SCRIPTS: Readonly<Record<string, string>> = {
  dev: `node ${DEV_LAUNCHER_REL_PATH}`,
  "dev:auto": `node ${DEV_LAUNCHER_REL_PATH} --auto`,
  "dev:fixed": `node ${DEV_LAUNCHER_REL_PATH} --fixed`,
};

/** The same three shapes again with the docs site attached. Only written
 *  for a project that still has a `docs-site/` — a scaffold that dropped
 *  it would otherwise advertise a command that starts nothing. */
export const DEV_LAUNCHER_DOCS_SCRIPTS: Readonly<Record<string, string>> = {
  "dev:docs": `node ${DEV_LAUNCHER_REL_PATH} --docs`,
  "dev:docs:fixed": `node ${DEV_LAUNCHER_REL_PATH} --fixed --docs`,
};

/**
 * Point the launcher's pinned-port constants at this project's ports.
 *
 * The launcher declares them as three `const DEV_*_PORT = <n>;` lines
 * precisely so this rewrite is a single anchored regex per port rather
 * than a sweep for a number that also appears in prose. The docs port is
 * left alone: it is only resolved under `--docs`, every project's docs
 * site is the same one, and nothing bakes its URL in.
 *
 * Idempotent, and safe to re-run from `hatchkit update` against a project
 * whose ports have not changed.
 */
export function applyDevLauncherPorts(content: string, ports: ProjectPorts): string {
  return content
    .replace(/^(\s*const DEV_CLIENT_PORT\s*=\s*)\d+(\s*;)/m, `$1${ports.client}$2`)
    .replace(/^(\s*const DEV_API_PORT\s*=\s*)\d+(\s*;)/m, `$1${ports.server}$2`);
}

/**
 * Write the native shells' document origins into the launcher.
 *
 * The list comes from `nativeClientOrigins`, the same function that fills
 * the server's `.env.example` and that `hatchkit sync` merges onto the
 * deployed app — a dev server that trusts a different set than production
 * is how "it works locally" gets shipped.
 *
 * The array is emitted one origin per line so a diff of a feature
 * addition reads as one added line. An empty feature set writes `[]`
 * back, which is both the starter's shape and the correct answer.
 */
export function applyDevLauncherNativeOrigins(
  content: string,
  features: readonly string[],
): string {
  const origins = nativeClientOrigins(features);
  const body = origins.length === 0 ? "[]" : `[\n${origins.map((o) => `  "${o}",`).join("\n")}\n]`;
  return content.replace(/^(\s*const NATIVE_ORIGINS\s*=\s*)\[[\s\S]*?\](\s*;)/m, `$1${body}$2`);
}

/**
 * Apply both rewrites and set the five dev scripts.
 *
 * A missing launcher is a no-op rather than an error: `hatchkit update`
 * runs against repos that predate it and against adopted repos that never
 * had one.
 */
export function applyDevLauncher(
  outputDir: string,
  ports: ProjectPorts,
  features: readonly string[],
): void {
  rewriteIfExists(join(outputDir, DEV_LAUNCHER_REL_PATH), (c) =>
    applyDevLauncherNativeOrigins(applyDevLauncherPorts(c, ports), features),
  );
  const scripts = existsSync(join(outputDir, "docs-site"))
    ? { ...DEV_LAUNCHER_SCRIPTS, ...DEV_LAUNCHER_DOCS_SCRIPTS }
    : DEV_LAUNCHER_SCRIPTS;
  for (const [name, value] of Object.entries(scripts)) {
    setPackageJsonScript(outputDir, name, value);
  }
}
