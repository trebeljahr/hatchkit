/*
 * cli/src/features/server-platform/kit.ts — shared plumbing for the
 * opt-in server platform features (`server-migrations`, `scheduler`,
 * `public-api`).
 *
 * These features are ADDITIVE, which is the opposite of how the older
 * feature flags work. `websocket`/`stripe`/`s3` ship inside `starter/`
 * and `scaffoldApp` strips the ones the user didn't pick; a strip has
 * to know every import that referenced the removed file, so re-adding
 * one cleanly is the merge problem `hatchkit update` refuses to solve.
 * The platform features instead ship as templates under
 * `cli/src/templates/features/<id>/` and are written into an already
 * scaffolded project. `create` and `update` therefore run the exact
 * same code path, and a project that skipped one at create time picks
 * it up later with no diffing.
 *
 * Everything here is idempotent: a file whose on-disk contents already
 * match the rendered template counts as `unchanged`, a file the user
 * has edited is left alone and reported as `conflicted`, and every
 * source patch is guarded by a marker that makes a second run a no-op.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** templates/features/ inside the compiled cli/dist tree.
 *  dist layout: dist/features/server-platform/kit.js
 *             + dist/templates/features/<id>/...
 *  (scripts/copy-templates.mjs mirrors src/templates → dist/templates). */
const FEATURE_TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "features");

export type ServerFeatureId = "server-migrations" | "scheduler" | "public-api";

export const SERVER_FEATURE_IDS: readonly ServerFeatureId[] = [
  "server-migrations",
  "scheduler",
  "public-api",
];

/** Human-facing one-liners. Used by the `create`/`update` multiselect
 *  and by `hatchkit help update`, so they stay short enough to read in
 *  a checkbox list. */
export const SERVER_FEATURE_LABELS: Record<ServerFeatureId, string> = {
  "server-migrations": "server-migrations (numbered migrations + index preparation at boot)",
  scheduler: "scheduler (leased recurring jobs, safe across replicas)",
  "public-api": "public-api (token-authenticated REST + OpenAPI + signed webhooks)",
};

export interface ServerFeatureInput {
  /** Repo root of the scaffolded project (where `.hatchkit.json` lives,
   *  or `<repoRoot>/<projectSubdir>` for a subdir deployment — the
   *  caller resolves that before calling). */
  projectDir: string;
  /** Project name, used in generated comments and docs. */
  projectName: string;
  /** Report what would change without touching the filesystem. */
  dryRun?: boolean;
}

export interface ServerFeatureResult {
  id: ServerFeatureId;
  /** Relative paths (POSIX separators) written this run. */
  written: string[];
  /** Relative paths whose contents already matched the template. */
  unchanged: string[];
  /** Existing files that differ from the template and were NOT
   *  overwritten — the user edited them, and clobbering an edit is
   *  worse than leaving a feature half-applied that we then report. */
  conflicted: string[];
  /** Existing project files this run patched in place. */
  patched: string[];
  /** Notes worth printing after the summary (manual follow-ups). */
  notes: string[];
  /** Set when the feature could not be applied at all. */
  skipped?: string;
}

export function emptyResult(id: ServerFeatureId): ServerFeatureResult {
  return {
    id,
    written: [],
    unchanged: [],
    conflicted: [],
    patched: [],
    notes: [],
  };
}

// ── Template rendering ──────────────────────────────────────────────

/** Substitution tokens. `__HATCHKIT_<NAME>__` rather than Handlebars
 *  `{{NAME}}` because every template here is TypeScript, and `{{` shows
 *  up in generated object literals and in JSON fixtures. A token that
 *  can't appear by accident keeps the templates valid TS, which means
 *  an editor typechecks them in place. */
export interface FeatureTokens {
  PROJECT_NAME?: string;
  SERVER_PKG?: string;
  SHARED_PKG?: string;
}

const TOKEN_NAMES: Array<keyof FeatureTokens> = ["PROJECT_NAME", "SERVER_PKG", "SHARED_PKG"];

export function renderFeatureString(source: string, tokens: FeatureTokens): string {
  let out = source;
  for (const name of TOKEN_NAMES) {
    const value = tokens[name];
    if (value === undefined) continue;
    out = out.split(`__HATCHKIT_${name}__`).join(value);
  }
  return out;
}

export function renderFeatureTemplate(
  id: ServerFeatureId,
  relPath: string,
  tokens: FeatureTokens,
): string {
  const full = join(FEATURE_TEMPLATES_DIR, id, relPath);
  if (!existsSync(full)) {
    throw new Error(
      `Feature template not found: ${full}. Your hatchkit install is incomplete — re-run \`pnpm --filter hatchkit run build\` or reinstall.`,
    );
  }
  return renderFeatureString(readFileSync(full, "utf-8"), tokens);
}

/** Templates dir on disk — exposed so tests can enumerate it. */
export function getFeatureTemplatesDir(): string {
  return FEATURE_TEMPLATES_DIR;
}

// ── Filesystem ──────────────────────────────────────────────────────

/** Locate the server package inside a scaffolded project. The starter
 *  puts it at `packages/server`; a `backend` surface flattens it to the
 *  repo root. Returns null when neither looks like a server, which is
 *  how a static-only project declines these features. */
export function resolveServerDir(projectDir: string): string | null {
  const candidates = [join(projectDir, "packages", "server"), projectDir];
  for (const dir of candidates) {
    if (existsSync(join(dir, "src", "index.ts")) && existsSync(join(dir, "package.json"))) {
      return dir;
    }
  }
  return null;
}

export type WriteOutcome = "written" | "unchanged" | "conflicted";

/** Write `content` to `absPath` unless the file exists with different
 *  contents — in which case the user edited it and we report a conflict
 *  instead of overwriting. `force` is for files this feature owns
 *  outright (its own generated artifacts), never for shared files. */
export function writeManaged(
  absPath: string,
  content: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): WriteOutcome {
  if (existsSync(absPath)) {
    const current = readFileSync(absPath, "utf-8");
    if (current === content) return "unchanged";
    if (!opts.force) return "conflicted";
  }
  if (!opts.dryRun) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
  }
  return "written";
}

/** Render every `[templateRel, destRel]` pair and record the outcome on
 *  `result`. `destRel` is relative to `baseDir` and uses POSIX
 *  separators in the report regardless of platform.
 *
 *  `extensionPoints` names destinations that exist in order to be
 *  extended — a model registry, a job registration list. Two things
 *  edit them legitimately: the user, whose whole job is to add entries,
 *  and a sibling feature that registers itself (public-api appends its
 *  models to the registry server-migrations shipped). Diffing those
 *  against the pristine template would report a conflict on every
 *  subsequent `hatchkit update` — telling the user their file was
 *  unexpectedly edited, when in fact it is doing exactly what it is
 *  for. So they are written when absent and left alone when present. */
export function writeFeatureFiles(
  result: ServerFeatureResult,
  input: {
    baseDir: string;
    files: ReadonlyArray<readonly [templateRel: string, destRel: string]>;
    tokens: FeatureTokens;
    dryRun?: boolean;
    force?: boolean;
    extensionPoints?: readonly string[];
  },
): void {
  const extensionPoints = new Set(input.extensionPoints ?? []);
  for (const [templateRel, destRel] of input.files) {
    const dest = join(input.baseDir, destRel);
    if (extensionPoints.has(destRel) && existsSync(dest)) {
      result.unchanged.push(destRel);
      continue;
    }
    const content = renderFeatureTemplate(result.id, templateRel, input.tokens);
    const outcome = writeManaged(dest, content, {
      dryRun: input.dryRun,
      force: input.force,
    });
    if (outcome === "written") result.written.push(destRel);
    else if (outcome === "unchanged") result.unchanged.push(destRel);
    else result.conflicted.push(destRel);
  }
}

// ── Source patching ─────────────────────────────────────────────────

export interface SourcePatch {
  /** Skip the patch entirely when the file already contains this
   *  string. Every patch needs one — that is what makes a second
   *  `hatchkit update` a no-op instead of a double insert. */
  guard: string;
  /** Literal text to find. */
  anchor: string;
  /** Text to place relative to the anchor. */
  insert: string;
  /** Default "after". */
  position?: "before" | "after";
}

export interface PatchOutcome {
  changed: boolean;
  /** Patches whose anchor was missing — the user restructured the file
   *  and the caller must tell them what to wire by hand. */
  missingAnchors: string[];
}

/** Apply literal-anchor patches to one file. Never regex: the target is
 *  the user's own source, and a regex that drifts silently mangles it. A
 *  missing anchor is reported, never guessed at. */
export function patchSourceFile(
  absPath: string,
  patches: readonly SourcePatch[],
  opts: { dryRun?: boolean } = {},
): PatchOutcome {
  const outcome: PatchOutcome = { changed: false, missingAnchors: [] };
  if (!existsSync(absPath)) {
    outcome.missingAnchors.push(`(file missing: ${absPath})`);
    return outcome;
  }
  let content = readFileSync(absPath, "utf-8");
  const before = content;
  for (const patch of patches) {
    if (content.includes(patch.guard)) continue;
    const at = content.indexOf(patch.anchor);
    if (at === -1) {
      outcome.missingAnchors.push(patch.anchor);
      continue;
    }
    const cut = patch.position === "before" ? at : at + patch.anchor.length;
    content = content.slice(0, cut) + patch.insert + content.slice(cut);
  }
  if (content !== before) {
    outcome.changed = true;
    if (!opts.dryRun) writeFileSync(absPath, content, "utf-8");
  }
  return outcome;
}

/** The line in the starter's `shutdown()` that stops the HTTP server —
 *  the anchor every feature hangs its own shutdown step after. Newest
 *  first: the starter awaits `closeHttpServer(server)` (src/shutdown.ts)
 *  today, and projects scaffolded before that still call `server.close()`.
 *  Pinned to the real starter by cli/test-public-api.ts. */
const SHUTDOWN_CLOSE_ANCHORS = ["  await closeHttpServer(server);", "  server.close();"] as const;

/** The shutdown close anchor present in `source`, or the newest one so a
 *  missing-anchor note names what the starter writes today. */
export function shutdownCloseAnchor(source: string): string {
  return SHUTDOWN_CLOSE_ANCHORS.find((a) => source.includes(a)) ?? SHUTDOWN_CLOSE_ANCHORS[0];
}

// ── package.json ────────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Add dependencies that aren't already declared. Never downgrades or
 *  re-pins an existing range — the user's lockfile is theirs. Returns
 *  the names actually added. */
export function addPackageDeps(
  pkgDir: string,
  deps: Record<string, string>,
  opts: { dev?: boolean; dryRun?: boolean } = {},
): string[] {
  const path = join(pkgDir, "package.json");
  const pkg = readJson(path);
  if (!pkg) return [];
  const field = opts.dev ? "devDependencies" : "dependencies";
  const bucket = (pkg[field] ?? {}) as Record<string, string>;
  const other = (pkg[opts.dev ? "dependencies" : "devDependencies"] ?? {}) as Record<
    string,
    string
  >;
  const added: string[] = [];
  for (const [name, range] of Object.entries(deps)) {
    if (bucket[name] || other[name]) continue;
    bucket[name] = range;
    added.push(name);
  }
  if (added.length === 0) return [];
  pkg[field] = sortKeys(bucket);
  if (!opts.dryRun) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  return added;
}

/** Add a script only when the name is free. An existing script with the
 *  same name is the user's, and silently replacing it is how a generated
 *  `test` script eats a hand-written one. */
export function addPackageScript(
  pkgDir: string,
  name: string,
  value: string,
  opts: { dryRun?: boolean } = {},
): boolean {
  const path = join(pkgDir, "package.json");
  const pkg = readJson(path);
  if (!pkg) return false;
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  if (scripts[name] !== undefined) return false;
  scripts[name] = value;
  pkg.scripts = scripts;
  if (!opts.dryRun) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  return true;
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

// ── .env files ──────────────────────────────────────────────────────

/** Append a marker-delimited block to every env file that exists in the
 *  server package. Idempotent on the marker, so a second run neither
 *  duplicates the block nor rewrites a value the user changed inside it. */
export function appendEnvBlock(
  serverDir: string,
  marker: string,
  lines: readonly string[],
  opts: { dryRun?: boolean; files?: readonly string[] } = {},
): string[] {
  const files = opts.files ?? [".env.example", ".env.development"];
  const touched: string[] = [];
  const block = [`# ── ${marker} ${"─".repeat(Math.max(0, 56 - marker.length))}`, ...lines].join(
    "\n",
  );
  for (const file of files) {
    const path = join(serverDir, file);
    if (!existsSync(path)) continue;
    const current = readFileSync(path, "utf-8");
    if (current.includes(`# ── ${marker} `)) continue;
    const sep = current.endsWith("\n") ? "\n" : "\n\n";
    if (!opts.dryRun) writeFileSync(path, `${current}${sep}${block}\n`, "utf-8");
    touched.push(file);
  }
  return touched;
}

/** Add keys to the `env` object literal in `src/config/env.ts`. The
 *  starter builds that object by hand (no zod schema), so the patch is
 *  a literal insert before the trailing `isProduction:` line — which is
 *  the last entry in the object in every scaffold. */
export function patchEnvConfig(
  serverDir: string,
  marker: string,
  lines: readonly string[],
  opts: { dryRun?: boolean } = {},
): PatchOutcome {
  const path = join(serverDir, "src", "config", "env.ts");
  const insert = `\n  // ── ${marker}\n${lines.map((l) => `  ${l}`).join("\n")}\n`;
  return patchSourceFile(
    path,
    [
      {
        guard: `// ── ${marker}`,
        anchor: `  isProduction:`,
        insert,
        position: "before",
      },
    ],
    opts,
  );
}

// ── Agent memory ────────────────────────────────────────────────────

/** Append a section to the project's CLAUDE.md, guarded by its own
 *  heading so a second run adds nothing.
 *
 *  Why here rather than in `starter/CLAUDE.md`'s conditional blocks:
 *  `applyClaudeMd` only runs during `hatchkit create`, and these
 *  features are the ones a project most often picks up later. A project
 *  that ran `hatchkit update` would otherwise carry the files with no
 *  agent memory describing the rules they exist to enforce — and every
 *  one of those rules fails quietly when it is broken, which is exactly
 *  the failure mode agent memory is for. */
export function appendClaudeMdSection(
  projectDir: string,
  heading: string,
  body: string,
  opts: { dryRun?: boolean } = {},
): boolean {
  const path = join(projectDir, "CLAUDE.md");
  if (!existsSync(path)) return false;
  const current = readFileSync(path, "utf-8");
  if (current.includes(heading)) return false;
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  if (!opts.dryRun) writeFileSync(path, `${current}${sep}${heading}\n\n${body.trim()}\n`, "utf-8");
  return true;
}
