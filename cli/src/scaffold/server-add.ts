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

  const surfaces = manifest.surfaces ?? "client-only";
  if (surfaces === "both" || surfaces === "server-only") {
    result.skipped.push(`manifest surfaces already ${surfaces}; no client-only retrofit needed`);
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
      surfaces: "both",
      deploymentMode: manifest.deploymentMode === "gh-pages" ? "coolify" : manifest.deploymentMode,
    });
  }

  markUpdated(result, `${MANIFEST_FILENAME} surfaces=both`);
  markUpdated(result, "root package.json scripts");
  markUpdated(result, "server env/dev ports");
  if (manifest.deploymentMode === "gh-pages") {
    result.warnings.push(
      "deploymentMode switched from gh-pages to coolify; Pages cannot host a server",
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

function ensureWorkspacePackages(root: string, result: ServerAddResult): void {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) {
    if (!result.dryRun) writeFileSync(path, 'packages:\n  - "packages/*"\n', "utf-8");
    result.created.push("pnpm-workspace.yaml");
    return;
  }
  const existing = readFileSync(path, "utf-8");
  if (/^\s*-\s*["']?packages\/\*["']?\s*$/m.test(existing)) return;
  if (!result.dryRun) writeFileSync(path, `${existing.trimEnd()}\n  - "packages/*"\n`, "utf-8");
  markUpdated(result, "pnpm-workspace.yaml");
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
    (/^\s{2}client:\s*$/m.test(existing) || /^\s{2}minio:\s*$/m.test(existing));
  if (!looksLikeHatchkitClientCompose) {
    result.warnings.push(
      `${relPath} exists and does not look like Hatchkit client-only compose; left unchanged`,
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
    surfaces: "both",
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
