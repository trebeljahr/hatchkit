/*
 * The `desktop` feature (Electron), in one place.
 *
 * Three call sites used to each carry their own copy of "which files, which
 * scripts, which dependencies": the scaffold's strip branch (app.ts), the
 * scaffold's substitute branch, and `hatchkit update`'s add path
 * (scaffold/update.ts). Three lists drift silently — a file added to the
 * starter reached a fresh `hatchkit create` and never reached a project that
 * ran `hatchkit update`, and the difference only showed up as a build that
 * failed on someone else's machine.
 *
 * So: one list, three readers. {@link DESKTOP_FILES} is the whole feature, and
 * a test asserts every entry exists in `starter/`.
 *
 * The project's NAMES are not here. Bundle id, product name, env-var prefix,
 * profile slug and the desktop origin are resolved once at scaffold time and
 * frozen in the manifest (scaffold/identifiers.ts); this module only applies
 * them to the files it owns.
 *
 * Pure data and pure functions over a project directory. No prompts, no
 * network, no chalk — safe to import from the scaffolder, the updater and the
 * tests alike.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  type ProjectIdentifiers,
  findUnsubstitutedIdentifierTokens,
  substituteIdentifierTokens,
} from "./identifiers.js";

/**
 * Every path the desktop feature owns, relative to the project root.
 *
 * Copied in by `hatchkit update`, removed by a scaffold that did not pick the
 * feature. Directories are listed as directories; the copy and the removal
 * are both recursive.
 *
 * `build/` is deliberately absent: `build/icon.png` is the shared icon source
 * that the Tauri wrapper reads too, so its lifetime is decided by the caller,
 * not by this list.
 */
export const DESKTOP_FILES: readonly string[] = [
  // The main process, the preload and their unit tests.
  "electron",
  // The contract the preload and the renderer share, so the object the
  // preload exposes and the object the renderer calls cannot drift.
  "packages/shared/src/desktop-bridge.ts",
  "packages/shared/src/desktop-shortcuts.ts",
  "packages/client/src/types/electron.d.ts",
  // The build: one script that refuses rather than shipping a broken app.
  "electron-builder.config.mjs",
  "scripts/build-desktop.mjs",
  "scripts/ensure-electron.mjs",
  "scripts/icons-desktop.mjs",
  // Release and staged rollout.
  "scripts/desktop-signing-mode.mjs",
  "scripts/desktop-release-draft.mjs",
  "scripts/desktop-rollout.mjs",
  "scripts/lib/desktop-release.mjs",
  "scripts/lib/desktop-release.test.mjs",
  "scripts/lib/desktop-rollout.mjs",
  "scripts/lib/desktop-rollout.test.mjs",
  ".github/workflows/desktop-release.yml",
  // Proof it runs: a container that renders the app on Linux, and an
  // end-to-end harness that proves auth from the server side.
  "scripts/desktop-linux-smoke.mjs",
  // Windows cannot be proven the same way — there is no Windows container
  // that runs a GUI app on a Mac — so the most this can do is stage a correct
  // build one double-click away from a person in a VM.
  "scripts/desktop-vm-drop.mjs",
  "scripts/crossplat",
  "e2e/desktop",
];

/**
 * File extensions the substitution reads. Everything the feature ships is
 * text except the icons, and running a string replace over a PNG would rewrite
 * it byte for byte on the off chance the bytes spell a placeholder.
 */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".json",
  ".yml",
  ".yaml",
  ".md",
  ".sh",
  ".html",
  ".css",
]);

/** Dockerfile and friends: extensionless, still text. */
const TEXT_BASENAMES = new Set(["Dockerfile", ".dockerignore", ".npmrc", ".nvmrc"]);

function isTextFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  if (TEXT_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(base.slice(dot));
}

/** Every text file the desktop feature owns, as absolute paths. Walks the
 *  directories in {@link DESKTOP_FILES} rather than naming files, so a file
 *  added to the starter is substituted without anyone remembering to list it —
 *  the hand-maintained list this replaced went stale the first time the shell
 *  grew a module. */
function desktopTextFiles(projectDir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (isTextFile(abs)) out.push(abs);
  };
  for (const rel of DESKTOP_FILES) visit(join(projectDir, rel));
  return out;
}

/** Root-package.json scripts the feature owns. Copied from the starter's own
 *  package.json by name, so the command strings live in one place. */
export const DESKTOP_SCRIPTS: readonly string[] = [
  "dev:desktop",
  "build:desktop",
  "electron:compile",
  "electron:build",
  "electron:preview",
  "electron:ensure",
  "typecheck:electron",
  "test:electron",
  "test:e2e:desktop",
  "test:desktop:linux",
  "test:desktop:release",
  "prod:win",
  "icons:desktop",
  "desktop:rollout",
];

/** Root-package.json devDependencies the feature owns.
 *
 *  `electron-updater` is here as a DEV dependency on purpose: esbuild bundles
 *  it into `electron/dist/main.js`, and the packaged file list excludes
 *  `node_modules` entirely. A runtime dependency would be packed into the
 *  asar by electron-builder — which adds production dependencies whatever the
 *  `files` list says — and then loaded twice. */
export const DESKTOP_DEV_DEPS: readonly string[] = [
  "electron",
  "electron-builder",
  "electron-updater",
  "@electron/asar",
  "esbuild",
  "icon-gen",
  // icons-desktop.mjs renders the PNG variants through it.
  "sharp",
  "wait-on",
  "concurrently",
];

/** Scripts a project that drops the desktop feature must not keep. A superset
 *  of {@link DESKTOP_SCRIPTS}: it also carries names earlier starters used,
 *  so re-running a strip over an older project still leaves nothing dangling. */
export const DESKTOP_SCRIPTS_TO_STRIP: readonly string[] = [
  ...DESKTOP_SCRIPTS,
  "dev:electron",
  "prod:desktop",
  "itch:push:mac",
  "itch:push:win",
  "itch:push:linux",
];

/** Apply the project's frozen identifiers to every text file the feature owns.
 *  Idempotent: a second run finds no tokens and writes nothing. */
export function substituteDesktopFiles(projectDir: string, ids: ProjectIdentifiers): void {
  for (const path of desktopTextFiles(projectDir)) {
    const content = readFileSync(path, "utf-8");
    const next = substituteIdentifierTokens(content, ids);
    if (next !== content) writeFileSync(path, next, "utf-8");
  }
}

/**
 * Identifier tokens left unfilled in a generated project, as `<path>: {{name}}`.
 *
 * A surviving `{{envPrefix}}` is not a cosmetic defect: it becomes an
 * environment variable name no shell can set, so the headless contract never
 * engages and a test run opens windows on the person's screen. A surviving
 * `{{projectSlug}}` makes every install share one profile directory. The
 * scaffold test asserts this is empty.
 */
export function unresolvedDesktopTokens(projectDir: string): string[] {
  const found: string[] = [];
  for (const path of desktopTextFiles(projectDir)) {
    const tokens = findUnsubstitutedIdentifierTokens(readFileSync(path, "utf-8"));
    const rel = path.slice(projectDir.length + 1);
    for (const t of tokens) found.push(`${rel}: ${t}`);
  }
  return [...new Set(found)];
}
