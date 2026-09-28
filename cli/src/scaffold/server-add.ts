/*
 * `hatchkit server add` — retrofit the Hatchkit server surface into a
 * client-only project.
 *
 * This command is deliberately local-only: it writes scaffold files and updates
 * the manifest. Deploy wiring stays in `hatchkit adopt --resume`, where the
 * existing rollback ledger and provider guard rails already live.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import type { ProjectConfig } from "../prompts.js";
import { DEV_LAUNCHER_LIB_FILES } from "./dev-launcher.js";
import {
  MANIFEST_FILENAME,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "./manifest.js";
import { readPackageName, setPackageJsonScript } from "./pkg-json.js";
import { applyPorts, applyProjectName, updateEnvExample } from "./starter-files.js";

const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

export interface ServerAddOptions {
  yes?: boolean;
  dryRun?: boolean;
  serverDir?: string;
  sharedDir?: string;
  presets?: {
    confirmAdd?: boolean;
  };
}

export interface ServerAddResult {
  changed: boolean;
  dryRun: boolean;
  created: string[];
  reused: string[];
  updated: string[];
  skipped: string[];
  warnings: string[];
  nextSteps: string[];
}

export async function runServerAdd(
  projectDir: string,
  options: ServerAddOptions = {},
): Promise<ServerAddResult> {
  const root = resolve(projectDir);
  const manifest = readManifest(root);
  if (!manifest) {
    throw new Error(
      `No ${MANIFEST_FILENAME} found in ${root}. Run this from a Hatchkit project root.`,
    );
  }

  if (!existsSync(STARTER_ROOT)) {
    throw new Error(
      `Starter template not found at ${STARTER_ROOT}. Your hatchkit checkout looks incomplete.`,
    );
  }

  const serverDir = resolveMaybe(root, options.serverDir ?? "packages/server");
  const sharedDir = resolveMaybe(root, options.sharedDir ?? "packages/shared");
  const result: ServerAddResult = {
    changed: false,
    dryRun: !!options.dryRun,
    created: [],
    reused: [],
    updated: [],
    skipped: [],
    warnings: [],
    nextSteps: [
      "pnpm install",
      "pnpm run typecheck",
      "hatchkit adopt --resume --regenerate-pipeline",
    ],
  };

  const surfaces = manifest.surfaces ?? "static";
  if (surfaces === "fullstack" || surfaces === "split" || surfaces === "backend") {
    result.skipped.push(`manifest surfaces already ${surfaces}; no server retrofit needed`);
    result.nextSteps = ["hatchkit adopt --resume --regenerate-pipeline"];
    return result;
  }

  const serverExists = existsSync(serverDir);
  const sharedExists = existsSync(sharedDir);
  const shouldPrompt = !options.yes && options.presets?.confirmAdd === undefined;
  if (shouldPrompt && !process.stdin.isTTY) {
    throw new Error("Refusing to prompt on non-interactive stdin. Re-run with --yes.");
  }

  const ok =
    options.presets?.confirmAdd ??
    options.yes ??
    (await confirm({
      message: `Add Hatchkit server surface to ${manifest.name}?`,
      default: true,
    }));
  if (!ok) {
    result.skipped.push("cancelled");
    result.nextSteps = [];
    return result;
  }

  copyDirIfMissing({
    from: join(STARTER_ROOT, "packages/server"),
    to: serverDir,
    label: rel(root, serverDir),
    result,
  });

  if (sharedExists) {
    result.reused.push(rel(root, sharedDir));
    restoreSharedMlTypes(root, sharedDir, result);
  } else {
    copyDirIfMissing({
      from: join(STARTER_ROOT, "packages/shared"),
      to: sharedDir,
      label: rel(root, sharedDir),
      result,
    });
  }

  copyFileIfMissing({
    from: join(STARTER_ROOT, "tsconfig.base.json"),
    to: join(root, "tsconfig.base.json"),
    label: "tsconfig.base.json",
    result,
  });
  copyFileIfMissing({
    from: join(STARTER_ROOT, "scripts/dev.mjs"),
    to: join(root, "scripts/dev.mjs"),
    label: "scripts/dev.mjs",
    result,
  });
  copyFileIfMissing({
    from: join(STARTER_ROOT, "scripts/wait-for-port.mjs"),
    to: join(root, "scripts/wait-for-port.mjs"),
    label: "scripts/wait-for-port.mjs",
    result,
  });
  // dev.mjs imports three of these and spawns the fourth by path, so a repo
  // that got the launcher without them dies on `pnpm dev` with
  // ERR_MODULE_NOT_FOUND. They carry the process-group teardown and the
  // watcher diagnostics — the launcher is not usable without them.
  for (const libRel of DEV_LAUNCHER_LIB_FILES) {
    copyFileIfMissing({
      from: join(STARTER_ROOT, libRel),
      to: join(root, libRel),
      label: libRel,
      result,
    });
  }
  ensureWorkspacePackages(root, result);
  restoreComposeIfClearlyClientOnly(root, "docker-compose.yml", result);
  restoreComposeIfClearlyClientOnly(root, "docker-compose.dev.yml", result);

  if (!options.dryRun) {
    const projectConfig = manifestAsProjectConfig(manifest);
    applyProjectName(root, manifest.name);
    updateEnvExample(root, rel(root, join(serverDir, ".env.example")), projectConfig);
    applyPorts(root, manifest.ports, { wantsDesktop: false, wantsMobile: false });
    rewriteRootScripts(root, { serverDir, sharedDir });
    writeManifest(root, {
      ...manifest,
      surfaces: "fullstack",
      deploymentMode:
        manifest.deploymentMode === "gh-pages" || manifest.deploymentMode === "cloudflare"
          ? "coolify"
          : manifest.deploymentMode,
    });
  }

  markUpdated(result, `${MANIFEST_FILENAME} surfaces=fullstack`);
  markUpdated(result, "root package.json scripts");
  markUpdated(result, "server env/dev ports");
  if (manifest.deploymentMode === "gh-pages" || manifest.deploymentMode === "cloudflare") {
    result.warnings.push(
      `deploymentMode switched from ${manifest.deploymentMode} to coolify; a static host cannot run a server`,
    );
  }
  if (serverExists) {
    result.warnings.push(
      `${rel(root, serverDir)} already existed; Hatchkit left its files untouched`,
    );
  }

  result.changed =
    result.created.length > 0 || result.updated.length > 0 || result.warnings.length > 0;
  return result;
}

function resolveMaybe(root: string, value: string): string {
  return resolve(root, value);
}

function rel(root: string, path: string): string {
  const r = relative(root, path);
  return r === "" ? "." : r;
}

function copyDirIfMissing(args: {
  from: string;
  to: string;
  label: string;
  result: ServerAddResult;
}): void {
  if (existsSync(args.to)) {
    args.result.reused.push(args.label);
    return;
  }
  if (!args.result.dryRun) {
    mkdirSync(dirname(args.to), { recursive: true });
    cpSync(args.from, args.to, { recursive: true, errorOnExist: true });
  }
  args.result.created.push(args.label);
}

function copyFileIfMissing(args: {
  from: string;
  to: string;
  label: string;
  result: ServerAddResult;
}): void {
  if (existsSync(args.to)) {
    args.result.reused.push(args.label);
    return;
  }
  if (!args.result.dryRun) {
    mkdirSync(dirname(args.to), { recursive: true });
    cpSync(args.from, args.to, { errorOnExist: true });
  }
  args.result.created.push(args.label);
}

function restoreSharedMlTypes(root: string, sharedDir: string, result: ServerAddResult): void {
  copyFileIfMissing({
    from: join(STARTER_ROOT, "packages/shared/src/ml-types.ts"),
    to: join(sharedDir, "src/ml-types.ts"),
    label: rel(root, join(sharedDir, "src/ml-types.ts")),
    result,
  });
  const indexPath = join(sharedDir, "src/index.ts");
  if (!existsSync(indexPath)) return;
  const existing = readFileSync(indexPath, "utf-8");
  if (existing.includes("./ml-types.js")) return;
  if (!result.dryRun) {
    writeFileSync(indexPath, `${existing.trimEnd()}\nexport * from "./ml-types.js";\n`, "utf-8");
  }
  markUpdated(result, rel(root, indexPath));
}

/*
 * Canonical `allowBuilds:` allowlist for a Hatchkit workspace — kept in sync
 * with `starter/pnpm-workspace.yaml`.
 *
 * pnpm 11 turns ERR_PNPM_IGNORED_BUILDS into a hard error, and it runs the
 * dep-status check *before* every `pnpm run <script>` — so a workspace file
 * that omits a package with a postinstall build script breaks `pnpm install`
 * AND every single script, with an error naming a transitive dependency the
 * user never picked (`unrs-resolver` arrives via
 * eslint-config-next -> eslint-import-resolver-typescript). Any code path that
 * regenerates the workspace file must emit this block, or the regenerated
 * project inherits the exact bug the starter was fixed to avoid.
 */
export const WORKSPACE_ALLOW_BUILDS: readonly string[] = [
  // biome ships its binary through an optional platform package that its own
  // install script resolves, and every lint-gated package depends on it — so
  // leaving it out fails `pnpm install` outright on pnpm 11.
  "@biomejs/biome",
  "@sentry/cli",
  "core-js",
  "core-js-pure",
  "electron-winstaller",
  "esbuild",
  "sharp",
  "unrs-resolver",
];

/*
 * Canonical `overrides:` block — kept in sync with `starter/pnpm-workspace.yaml`,
 * where the long-form rationale lives.
 *
 * Short version: packages/server runs express 5 and casts the result of
 * `createExpressMiddleware()` to express's `RequestHandler`. @trpc/server takes
 * express as an *optional peer*, so its shipped `.d.ts` resolves express through
 * pnpm's virtual-store hoist dir (`node_modules/.pnpm/node_modules/`) rather
 * than its own. docs-site drags @types/express@4 in transitively
 * (@docusaurus/core -> webpack-dev-server), and whichever major wins that single
 * hoist slot decides whether the cast compiles — a resolution detail no manifest
 * declares. Pinning to v5 leaves nothing to choose between.
 */
export const WORKSPACE_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["@types/express", "^5.0.0"],
  ["@types/express-serve-static-core", "^5.1.1"],
];

/** Quote a dependency name the way the starter's workspace file does — YAML
 *  plain keys may not start with `@`, so scoped names need single quotes. */
function yamlKey(name: string): string {
  return name.startsWith("@") ? `'${name}'` : name;
}

/** Top-level key of the build allowlist. Held in a constant so the renderer,
 *  the backfill and the parser cannot drift on spelling. */
const ALLOW_BUILDS_KEY = "allowBuilds";

/** Top-level key of the dependency override map. */
const OVERRIDES_KEY = "overrides";

/** The build allowlist as name/value pairs, so it renders and compares through
 *  the same helpers as the override map. */
function allowBuildsEntries(): ReadonlyArray<readonly [string, string]> {
  return WORKSPACE_ALLOW_BUILDS.map((name) => [name, "true"] as const);
}

/** Render one top-level mapping block: `key:` followed by two-space indented
 *  entries. Single source of the block layout — the full-file renderer and the
 *  backfill both go through it, so a regenerated file and a backfilled one are
 *  byte-identical in the parts Hatchkit owns. */
function renderWorkspaceBlock(
  key: string,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  return `${key}:\n${entries.map(([name, value]) => `  ${yamlKey(name)}: ${value}\n`).join("")}`;
}

/** Render a complete `pnpm-workspace.yaml` — the given package globs plus the
 *  canonical override and build-allowlist blocks. */
export function renderWorkspaceYaml(packageGlobs: readonly string[]): string {
  const packages = packageGlobs.map((glob) => `  - "${glob}"\n`).join("");
  // `overrides:` before the build allowlist — the starter file orders them the
  // same way, and cli/test-scaffold.ts pins that by slicing both files from the
  // allowlist key to EOF and comparing byte-for-byte.
  return [
    `packages:\n${packages}`,
    renderWorkspaceBlock(OVERRIDES_KEY, WORKSPACE_OVERRIDES),
    renderWorkspaceBlock(ALLOW_BUILDS_KEY, allowBuildsEntries()),
  ].join("");
}

/**
 * Parse one flat top-level mapping out of a pnpm-workspace.yaml — a `key:` line
 * followed by two-space indented `name: value` entries. Returns `null` when the
 * block is absent, which is the distinction the backfill turns on: "this project
 * has no opinion" (write the canonical block) versus "this project declares its
 * own" (never touch it).
 *
 * Deliberately a hand-rolled reader rather than a YAML dependency: every block
 * Hatchkit reads or writes here is a flat mapping of string to scalar. It is
 * exported so the drift guard in cli/test-scaffold.ts can compare the constants
 * above against `starter/pnpm-workspace.yaml` by PARSED content — comments,
 * quoting style and key order then cannot make two equivalent files disagree,
 * which is exactly what a text slice gets wrong.
 */
export function parseWorkspaceMapping(source: string, key: string): Record<string, string> | null {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  if (start === -1) return null;
  const entries: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    // Blank lines and comments sit inside a block without ending it.
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^ {2}(?:'([^']+)'|"([^"]+)"|([^:#\s][^:#]*?))\s*:\s*(.*)$/.exec(line);
    // The first line that is not an indented entry is the next top-level key.
    if (!match) break;
    const name = match[1] ?? match[2] ?? match[3] ?? "";
    const value = match[4]
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    entries[name] = value;
  }
  return entries;
}

function ensureWorkspacePackages(root: string, result: ServerAddResult): void {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) {
    // Write the full file, not just `packages:` — see WORKSPACE_ALLOW_BUILDS.
    if (!result.dryRun) writeFileSync(path, renderWorkspaceYaml(["packages/*"]), "utf-8");
    result.created.push("pnpm-workspace.yaml");
    return;
  }
  const existing = readFileSync(path, "utf-8");
  let next = existing;
  if (!/^\s*-\s*["']?packages\/\*["']?\s*$/m.test(next)) {
    // Append inside the `packages:` block, not at EOF — the starter keeps
    // sibling top-level keys (`allowBuilds:`) after it, and a bare list
    // item tacked onto the end would land under the wrong mapping.
    next = /^packages:\s*$/m.test(next)
      ? next.replace(/^packages:[^\n]*\n/m, (m) => `${m}  - "packages/*"\n`)
      : `${next.trimEnd()}\npackages:\n  - "packages/*"\n`;
  }
  next = backfillWorkspaceBlocks(next, result);
  if (next === existing) return;
  if (!result.dryRun) writeFileSync(path, next, "utf-8");
  markUpdated(result, "pnpm-workspace.yaml");
}

/*
 * Backfill the canonical top-level blocks into a workspace file that ALREADY
 * EXISTS.
 *
 * `hatchkit server add` retrofits foreign repos, so "the project already has a
 * pnpm-workspace.yaml, and it carries `packages:` and nothing else" is the
 * common case, not the exotic one. Without the build allowlist, pnpm 11 fails
 * `install` *and* every `pnpm run <script>` with ERR_PNPM_IGNORED_BUILDS; without
 * the override map, the @types/express hoist collision comes back. Regenerating
 * from scratch closed both bugs only for projects that had no workspace file at
 * all — this closes them for the rest.
 *
 * PRESERVE EXISTING USER SETUPS: only an ENTIRELY ABSENT block is written. A
 * block the project declares itself is left byte-for-byte alone — no merge, no
 * reorder, no added entries. When such a block is missing something Hatchkit
 * needs, that surfaces as a warning and the user decides; silently editing a
 * hand-maintained pin is exactly the clobbering this command must not do.
 */
function backfillWorkspaceBlocks(source: string, result: ServerAddResult): string {
  const withOverrides = ensureWorkspaceBlock(source, result, {
    key: OVERRIDES_KEY,
    entries: WORKSPACE_OVERRIDES,
    // Keep the starter's ordering: overrides above the build allowlist.
    insertBefore: ALLOW_BUILDS_KEY,
    describeGaps: (gaps) =>
      `pnpm-workspace.yaml declares its own ${OVERRIDES_KEY}: block; Hatchkit left it untouched, but it does not pin ${gaps.join(", ")} — packages/server can fail to typecheck against @trpc/server (see starter/pnpm-workspace.yaml for why)`,
  });
  return ensureWorkspaceBlock(withOverrides, result, {
    key: ALLOW_BUILDS_KEY,
    entries: allowBuildsEntries(),
    describeGaps: (gaps) =>
      `pnpm-workspace.yaml declares its own build allowlist; Hatchkit left it untouched, but it does not allow ${gaps.join(", ")} — pnpm 11 fails install and every pnpm run <script> with ERR_PNPM_IGNORED_BUILDS for a package it does not list`,
  });
}

/** Append `spec.key`'s canonical block when the file has no such block at all,
 *  otherwise report the gaps through `result.warnings` and return the source
 *  unchanged. `insertBefore` names a top-level key the new block must precede
 *  (the file is written in the starter's key order when both exist). */
function ensureWorkspaceBlock(
  source: string,
  result: ServerAddResult,
  spec: {
    key: string;
    entries: ReadonlyArray<readonly [string, string]>;
    insertBefore?: string;
    describeGaps: (gaps: string[]) => string;
  },
): string {
  const declared = parseWorkspaceMapping(source, spec.key);
  if (declared) {
    const gaps = spec.entries
      .filter(([name, value]) => declared[name] !== value)
      .map(([name, value]) =>
        name in declared ? `${name} (declared ${declared[name]}, Hatchkit uses ${value})` : name,
      );
    if (gaps.length > 0) result.warnings.push(spec.describeGaps(gaps));
    return source;
  }
  const block = renderWorkspaceBlock(spec.key, spec.entries);
  const anchor = spec.insertBefore ? source.search(new RegExp(`^${spec.insertBefore}:`, "m")) : -1;
  // No anchor (or no such key in this file): the block becomes the last
  // top-level key, separated by a blank line so a hand-edited file stays
  // readable. A second `server add` then parses it and changes nothing.
  if (anchor === -1) return `${source.replace(/\n*$/, "\n")}\n${block}`;
  return `${source.slice(0, anchor)}${block}\n${source.slice(anchor)}`;
}

function restoreComposeIfClearlyClientOnly(
  root: string,
  relPath: "docker-compose.yml" | "docker-compose.dev.yml",
  result: ServerAddResult,
): void {
  const path = join(root, relPath);
  if (!existsSync(path)) {
    copyFileIfMissing({ from: join(STARTER_ROOT, relPath), to: path, label: relPath, result });
    return;
  }

  const existing = readFileSync(path, "utf-8");
  const hasServerBits = /^\s{2}server:\s*$/m.test(existing) || /^\s{2}mongo:\s*$/m.test(existing);
  if (hasServerBits) {
    result.reused.push(relPath);
    return;
  }

  const looksLikeHatchkitClientCompose =
    /^\s*services:\s*$/m.test(existing) &&
    (/^\s{2}client:\s*$/m.test(existing) ||
      /^\s{2}minio:\s*$/m.test(existing) ||
      /^\s{2}seaweedfs:\s*$/m.test(existing));
  if (!looksLikeHatchkitClientCompose) {
    result.warnings.push(
      `${relPath} exists and does not look like Hatchkit static-only compose; left unchanged`,
    );
    return;
  }

  if (!result.dryRun) cpSync(join(STARTER_ROOT, relPath), path);
  markUpdated(result, `${relPath} restored server/mongo/redis services`);
}

function rewriteRootScripts(root: string, paths: { serverDir: string; sharedDir: string }): void {
  const serverName = readPackageName(paths.serverDir) ?? "@starter/server";
  const sharedName = readPackageName(paths.sharedDir) ?? "@starter/shared";
  const clientName = findClientPackageName(root);

  setPackageJsonScript(root, "dev", "node scripts/dev.mjs");
  setPackageJsonScript(root, "dev:fixed", "node scripts/dev.mjs --fixed");
  setPackageJsonScript(
    root,
    "build:server",
    `pnpm --filter ${sharedName} run build && pnpm --filter ${serverName} run build`,
  );
  if (clientName) {
    setPackageJsonScript(
      root,
      "build",
      `pnpm --filter ${sharedName} run build && pnpm --filter ${serverName} run build && pnpm --filter ${clientName} run build`,
    );
    setPackageJsonScript(root, "test", "pnpm run test:unit && pnpm run test:client");
  } else {
    setPackageJsonScript(
      root,
      "build",
      `pnpm --filter ${sharedName} run build && pnpm --filter ${serverName} run build`,
    );
    setPackageJsonScript(root, "test", "pnpm run test:unit");
  }
  setPackageJsonScript(root, "test:unit", `pnpm --filter ${serverName} run test`);
  setPackageJsonScript(root, "typecheck", "pnpm -r run typecheck");
}

function findClientPackageName(root: string): string | undefined {
  for (const dir of ["packages/client", "apps/client", "apps/web", "client"]) {
    const name = readPackageName(join(root, dir));
    if (name) return name;
  }
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir) || !statSync(packagesDir).isDirectory()) return undefined;
  for (const entry of readdirSync(packagesDir)) {
    if (entry === "server" || entry === "shared") continue;
    const name = readPackageName(join(packagesDir, entry));
    if (name) return name;
  }
  return undefined;
}

function manifestAsProjectConfig(manifest: ProjectManifest): ProjectConfig {
  return {
    name: manifest.name,
    domain: manifest.domain,
    baseDomain: "",
    subdomain: "",
    surfaces: "fullstack",
    deployTarget: "existing",
    features: manifest.features,
    s3Provider: manifest.s3Provider,
    mlServices: manifest.mlServices,
    forceRedeployMl: [],
    scaffoldRepo: false,
    createGithubRepo: false,
    installDeps: false,
    deploymentMode: "coolify",
    runDeployment: false,
    dryRun: false,
  } as unknown as ProjectConfig;
}

function markUpdated(result: ServerAddResult, label: string): void {
  if (!result.updated.includes(label)) result.updated.push(label);
}
