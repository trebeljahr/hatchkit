/*
 * Build pipeline scaffolder for `hatchkit adopt`.
 *
 * Wires a project up to the canonical hatchkit pipeline:
 *
 *   GitHub Actions builds the Docker image → pushes to GHCR →
 *   triggers Coolify's per-app deploy webhook → Coolify pulls + runs
 *
 * Detection-aware:
 *   · `docker-compose.yml` present  → leave it alone, Coolify uses
 *      the user's. Same for any of the alternate filenames Compose
 *      itself recognises (compose.yml, .yaml variants).
 *   · `Dockerfile` present           → leave it alone, scaffold a
 *     compose around it.
 *   · `.github/workflows/deploy.yml` present → leave it alone.
 *
 * Anything missing gets scaffolded from templates under
 * cli/src/templates/build-pipeline/.
 *
 * Mobile / desktop pipelines (Capacitor + Electron Builder) are
 * scaffolded out of this module too, gated on `features.includes()`,
 * but those templates land in a follow-up commit.
 */

import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureDockerignoreAllowsEnvProduction } from "../utils/dockerignore.js";
import { renderTemplate } from "../utils/template.js";

/** Default Node major used when the project doesn't pin one via
 *  `engines.node`. Bumped to 24 (LTS since Oct 2025) to match what
 *  GitHub Actions defaults to and what most modern dependencies
 *  require — staying on 22 was producing `ERR_PNPM_UNSUPPORTED_ENGINE`
 *  for projects that had quietly added `>=24` to engines.node. */
const DEFAULT_NODE_MAJOR = "24";

/** Web frameworks the scaffold knows how to specialise for. `generic`
 *  is the historical default — picks the nginx-vs-Node Dockerfile by
 *  surfaces alone. `nextjs` overrides that path because Next.js
 *  fundamentally needs a Node runtime (`next start`) regardless of
 *  whether the app exposes a backend API: Server Actions, route
 *  handlers, and non-`NEXT_PUBLIC_*` env vars all require the runtime
 *  even when the surfaces look "client-only". */
export type DetectedFramework = "nextjs" | "generic";

const NEXT_CONFIG_NAMES = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
] as const;

/** Detect whether the project is a Next.js app. We accept either a
 *  `next.config.*` file at the project root OR a `next` entry in
 *  package.json's dependencies/devDependencies. The two-check approach
 *  catches both the conventional layout (config file at root) AND
 *  monorepo packages that pull Next in transitively without owning
 *  a config file. When neither root signal hits, we walk pnpm /
 *  yarn / npm workspace globs and check sub-packages — a Next app at
 *  `apps/web` or `showcase/` should still produce a Node-runtime
 *  Dockerfile, not the nginx-static fallback. Anything else falls back
 *  to `"generic"`, which keeps the surfaces-driven nginx-vs-Node split
 *  working for Vite/Astro/etc. */
export function detectFramework(projectDir: string): DetectedFramework {
  if (NEXT_CONFIG_NAMES.some((name) => existsSync(join(projectDir, name)))) {
    return "nextjs";
  }
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.dependencies?.next || pkg.devDependencies?.next) return "nextjs";
    } catch {
      // Fall through to generic — a malformed package.json isn't our
      // problem to solve here.
    }
  }
  if (detectNextjsMonorepoPackage(projectDir)) return "nextjs";
  return "generic";
}

export interface MonorepoNextjsPackage {
  /** Workspace package directory, relative to `projectDir` (e.g. `"showcase"`,
   *  `"apps/web"`). Used as `WORKDIR` and as the COPY source prefix in the
   *  monorepo Dockerfile template. */
  packageDir: string;
  /** The `name` field from the sub-package's `package.json` (e.g.
   *  `"3d-assets-showcase"`). Passed to `pnpm --filter <name> build`,
   *  which keys off the package name and not its directory. */
  packageName: string;
}

/** Locate a workspace sub-package that looks like a Next.js app. Scans
 *  `pnpm-workspace.yaml`'s `packages:` globs and root `package.json`'s
 *  `workspaces` field (array or `{packages: []}` shape), expands each
 *  glob against the filesystem, and returns the first match that has
 *  either a `next.config.*` file or `next` in its deps/devDeps.
 *  Returns `undefined` for non-monorepo projects or when no sub-package
 *  uses Next. Order matters: pnpm-workspace.yaml entries are checked
 *  first because that's the dominant flavour in the projects hatchkit
 *  targets. */
export function detectNextjsMonorepoPackage(projectDir: string): MonorepoNextjsPackage | undefined {
  const globs: string[] = [];

  const wsPath = join(projectDir, "pnpm-workspace.yaml");
  if (existsSync(wsPath)) {
    try {
      globs.push(...parsePnpmWorkspacePackages(readFileSync(wsPath, "utf-8")));
    } catch {
      // Malformed YAML — ignore and fall through to package.json workspaces.
    }
  }

  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      if (Array.isArray(pkg.workspaces)) {
        globs.push(...pkg.workspaces);
      } else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
        globs.push(...pkg.workspaces.packages);
      }
    } catch {
      // Same policy as detectFramework: malformed JSON isn't our problem.
    }
  }

  if (globs.length === 0) return undefined;

  for (const glob of globs) {
    for (const dir of expandWorkspaceGlob(projectDir, glob)) {
      const subPkgPath = join(projectDir, dir, "package.json");
      if (!existsSync(subPkgPath)) continue;
      let sub: {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      try {
        sub = JSON.parse(readFileSync(subPkgPath, "utf-8"));
      } catch {
        continue;
      }
      const hasNextDep = Boolean(sub.dependencies?.next || sub.devDependencies?.next);
      const hasNextConfig = NEXT_CONFIG_NAMES.some((n) => existsSync(join(projectDir, dir, n)));
      if (hasNextDep || hasNextConfig) {
        return { packageDir: dir, packageName: sub.name ?? dir };
      }
    }
  }
  return undefined;
}

/** Minimal pnpm-workspace.yaml parser — pulls the `packages:` list
 *  without adding a YAML dependency. The format we care about is
 *  uniformly a top-level `packages:` key followed by a `- "glob"` list,
 *  so a regex-driven scan is enough and avoids the 200kB+ install cost
 *  of a real YAML parser for one config file. */
function parsePnpmWorkspacePackages(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    // Empty / comment-only lines don't end the block.
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = line.match(/^\s*-\s*["']?([^"'#\s][^"'#]*?)["']?\s*(#.*)?$/);
    if (item) {
      out.push(item[1].trim());
      continue;
    }
    // Any other non-list line ends the packages block.
    break;
  }
  return out;
}

/** Expand a workspace glob (e.g. `"apps/*"`, `"packages/**"`, or a
 *  literal directory like `"showcase"`) against `projectDir`. We
 *  support the two segment kinds workspaces actually use — `*` and
 *  `**` — and treat both as "one level of subdirectories"; deeper
 *  matching isn't needed for any real-world workspace layout we've
 *  seen and would just slow scans on big repos. */
function expandWorkspaceGlob(projectDir: string, glob: string): string[] {
  const parts = glob.split("/").filter(Boolean);
  let candidates: string[] = [""];
  for (const part of parts) {
    const next: string[] = [];
    if (part === "*" || part === "**") {
      for (const c of candidates) {
        const base = c ? join(projectDir, c) : projectDir;
        if (!existsSync(base)) continue;
        let entries: Dirent[];
        try {
          entries = readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          next.push(c ? `${c}/${e.name}` : e.name);
        }
      }
    } else {
      for (const c of candidates) {
        const sub = c ? `${c}/${part}` : part;
        if (existsSync(join(projectDir, sub))) next.push(sub);
      }
    }
    candidates = next;
    if (candidates.length === 0) break;
  }
  return candidates;
}

/** Pull the minimum major Node version out of `package.json#engines.node`.
 *  Handles the common range syntaxes — `>=24`, `^24.0.0`, `24.x`, `22 || 24`,
 *  `>=20.0.0 <24.0.0` — by grabbing the first integer that appears.
 *  That's the lower bound of the range, which is what we want for the
 *  Docker base image (running on the floor of the supported range avoids
 *  surprising "this works on my machine but not in CI" version drift).
 *  Falls back to DEFAULT_NODE_MAJOR when the field is missing or yields
 *  a sub-18 number (probably a parse glitch — Node 18 is the oldest
 *  realistic floor as of 2026). */
export function detectNodeMajorVersion(projectDir: string): string {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return DEFAULT_NODE_MAJOR;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      engines?: { node?: string };
    };
    const range = pkg.engines?.node;
    if (!range) return DEFAULT_NODE_MAJOR;
    const m = range.match(/(\d+)/);
    if (!m) return DEFAULT_NODE_MAJOR;
    const major = Number(m[1]);
    if (!Number.isFinite(major) || major < 18) return DEFAULT_NODE_MAJOR;
    return String(major);
  } catch {
    return DEFAULT_NODE_MAJOR;
  }
}

export interface BuildPipelineState {
  /** True when ANY of the recognized compose filenames is present. */
  hasCompose: boolean;
  /** Path to the detected compose file, if any. */
  composePath?: string;
  hasDockerfile: boolean;
  hasDeployWorkflow: boolean;
}

/** Compose file lookups mirror what Docker Compose itself supports —
 *  https://docs.docker.com/compose/compose-application-model/#the-compose-file
 *  We respect any of these instead of forcing one shape. */
const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";

export function detectBuildPipeline(projectDir: string): BuildPipelineState {
  let composePath: string | undefined;
  for (const name of COMPOSE_FILENAMES) {
    const p = join(projectDir, name);
    if (existsSync(p)) {
      composePath = p;
      break;
    }
  }
  return {
    hasCompose: !!composePath,
    composePath,
    hasDockerfile: existsSync(join(projectDir, "Dockerfile")),
    hasDeployWorkflow: existsSync(join(projectDir, DEPLOY_WORKFLOW_PATH)),
  };
}

export interface ScaffoldBuildPipelineInput {
  projectDir: string;
  projectName: string;
  /** GitHub `<owner>/<repo>` slug — owner is what GHCR images get
   *  scoped under (`ghcr.io/<owner>/<name>`). Inferred from the
   *  `git@github.com:owner/repo.git` or `https://github.com/owner/repo`
   *  remote URL by the caller. */
  ghOwner: string;
  /** Project-relative entrypoint script for the runtime CMD. Server /
   *  both layouts default to `dist/index.js`; client-only is
   *  irrelevant (nginx serves static files). */
  entrypoint: string;
  /** Container port the server listens on. Compose maps
   *  `<port>:<port>`. Ignored for client-only (nginx fixed at 80). */
  port: number;
  /** Surface from the AdoptPlan — picks the right Dockerfile flavour
   *  (server-only/both → Node runner; client-only → nginx). */
  surfaces: "server-only" | "client-only" | "both";
  /** Default branch used by the Actions workflow's `on: push: branches:`
   *  trigger. Detected from `git symbolic-ref refs/remotes/origin/HEAD`
   *  by the caller, with a `main` fallback. */
  defaultBranch: string;
  /** Major Node version to bake into the Dockerfile's `node:<v>-alpine`
   *  base image. Detected from the project's `package.json#engines.node`
   *  by `detectNodeMajorVersion`; falls back to the current LTS default
   *  ("24" — see DEFAULT_NODE_MAJOR) when the field is missing or
   *  unparseable. Overrideable for tests. */
  nodeMajor?: string;
  /** When true, overwrite Dockerfile + docker-compose.yml + the GH
   *  Actions workflow even if they already exist. Default: false (the
   *  existing idempotent-skip behaviour, so adopt-by-default never
   *  clobbers user-authored files). Used by `hatchkit adopt
   *  --regenerate-pipeline` for adopted projects that need to pick up
   *  template fixes (e.g. the Node 22 → 24 base-image bump). */
  force?: boolean;
}

export interface ScaffoldBuildPipelineResult {
  /** Files we wrote (relative to projectDir). Useful for printing a
   *  summary + later git-add. Union of `created` and `overwritten`. */
  written: string[];
  /** Files we wrote that DIDN'T exist before this call. Adopt records
   *  these in its run ledger so a later rollback / destroy can delete
   *  files hatchkit itself authored. */
  created: string[];
  /** Files we wrote that DID exist before this call (only possible
   *  when `force: true`). Adopt deliberately does NOT record these
   *  in the ledger — the file was the user's before regeneration,
   *  and a later destroy must never delete pre-existing content. */
  overwritten: string[];
  /** Files we skipped because they already existed. */
  skipped: string[];
  /** Project-relative path of the `.dockerignore` we appended a
   *  `!.env.production` line to (if any). `undefined` when nothing was
   *  changed — either there's no `.dockerignore`, or the negation was
   *  already present. Adopt prints this in its summary so the user can
   *  see why their `.dockerignore` grew a line. */
  dockerignorePatched?: string;
}

/** Idempotent: only writes files that don't exist. Returns what
 *  changed so the caller can print a clear "wrote X / kept Y" summary
 *  and add the new files to git. */
export function scaffoldBuildPipeline(
  input: ScaffoldBuildPipelineInput,
): ScaffoldBuildPipelineResult {
  const state = detectBuildPipeline(input.projectDir);
  const written: string[] = [];
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];

  // Helper: write a file and bucket it as created/overwritten based on
  // whether it existed before this call. Adopt's ledger only records
  // `created` entries — see ScaffoldBuildPipelineResult docs.
  const write = (relPath: string, content: string, existedBefore: boolean): void => {
    writeProjectFile(input.projectDir, relPath, content);
    written.push(relPath);
    if (existedBefore) overwritten.push(relPath);
    else created.push(relPath);
  };

  // Dockerfile.
  // Node version: caller can override (e.g. tests); otherwise we
  // sniff `engines.node` from the project's package.json so the
  // image matches what the user's dependencies actually require.
  const nodeMajor = input.nodeMajor ?? detectNodeMajorVersion(input.projectDir);
  // Framework detection: Next.js gets its own Dockerfile regardless of
  // surfaces — `next start` is the only sane production runtime even
  // for apps that look "client-only" on the surface, because Server
  // Actions / route handlers / non-NEXT_PUBLIC_* env vars all need it.
  // Everything else falls back to the surfaces-driven nginx-vs-Node
  // split that's been the default since this scaffolder was born.
  const framework = detectFramework(input.projectDir);
  // Monorepo lookup is gated on the Next.js branch — the generic
  // nginx/Node templates don't carry a sub-package WORKDIR concept,
  // so there's nothing to do there. When this returns a hit, the
  // monorepo Dockerfile variant takes over and runs the build at the
  // workspace root with `pnpm --filter <packageName>`.
  const monorepoNextjs =
    framework === "nextjs" ? detectNextjsMonorepoPackage(input.projectDir) : undefined;
  if (input.force || !state.hasDockerfile) {
    const tpl =
      framework === "nextjs"
        ? monorepoNextjs
          ? "build-pipeline/Dockerfile.nextjs-monorepo.hbs"
          : "build-pipeline/Dockerfile.nextjs.hbs"
        : input.surfaces === "client-only"
          ? "build-pipeline/Dockerfile.client.hbs"
          : "build-pipeline/Dockerfile.server.hbs";
    const out = renderTemplate(tpl, {
      name: input.projectName,
      port: input.port,
      entrypoint: input.entrypoint,
      nodeMajor,
      monorepoPackage: monorepoNextjs?.packageDir,
      packageName: monorepoNextjs?.packageName,
    });
    write("Dockerfile", out, state.hasDockerfile);
  } else {
    skipped.push("Dockerfile");
  }

  // docker-compose.yml — only scaffold when no compose file (any of
  // the recognised names) is present. Always write to
  // `docker-compose.yml` since that's what Coolify expects by default.
  //
  // Port resolution: the nginx-static template fixes itself at 80;
  // Node-runtime templates (server.hbs, nextjs.hbs) bind to whatever
  // {{port}} we plug in. Next.js is Node-runtime even when surfaces
  // looks "client-only", so it follows the same input.port path as
  // the server template — otherwise compose would map :80 to a
  // container that's actually listening on :3000.
  if (input.force || !state.hasCompose) {
    const servicePort =
      framework === "nextjs" ? input.port : input.surfaces === "client-only" ? 80 : input.port;
    const out = renderTemplate("build-pipeline/docker-compose.yml.hbs", {
      name: input.projectName,
      owner: input.ghOwner,
      port: servicePort,
      isNextjs: framework === "nextjs",
    });
    write("docker-compose.yml", out, state.hasCompose);
  } else {
    skipped.push(state.composePath?.replace(`${input.projectDir}/`, "") ?? "compose file");
  }

  // GitHub Actions deploy workflow.
  if (input.force || !state.hasDeployWorkflow) {
    // The deploy template uses GitHub Actions' own `${{ … }}` syntax,
    // which clashes with Handlebars. We render it as a plain text
    // file with `__VAR__` placeholders that get substituted here
    // instead — no Handlebars on this one.
    const raw = readTemplateRaw("build-pipeline/deploy.yml.hbs");
    const filled = raw.replace(/__DEFAULT_BRANCH__/g, input.defaultBranch);
    write(DEPLOY_WORKFLOW_PATH, filled, state.hasDeployWorkflow);
  } else {
    skipped.push(DEPLOY_WORKFLOW_PATH);
  }

  // .dockerignore patch — runs unconditionally, idempotently. The
  // scaffolded Dockerfiles all end with `COPY . .`, so the encrypted
  // .env.production has to be inside the build context for the build
  // step's `dotenvx run` to find it. Repos adopted before this fix
  // existed will already have a `.dockerignore` with `.env*`-style
  // wildcards excluding it; this re-includes the encrypted file
  // without disturbing the user's other rules.
  const dockerignoreResult = ensureDockerignoreAllowsEnvProduction(input.projectDir);
  const dockerignorePatched = dockerignoreResult.modified ? ".dockerignore" : undefined;

  return { written, created, overwritten, skipped, dockerignorePatched };
}

function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  const full = join(projectDir, relPath);
  const parent = dirname(full);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/** Read a template file as raw text, bypassing Handlebars. Used for
 *  the GitHub Actions workflow whose `${{ }}` syntax conflicts with
 *  the Handlebars expression syntax. */
function readTemplateRaw(relPath: string): string {
  // Mirror the lookup logic in utils/template.ts: TEMPLATES_DIR is
  // resolved relative to that module, which is two parents away from
  // this file (../utils → ../).
  const here = dirname(new URL(import.meta.url).pathname);
  const templatesDir = join(here, "..", "templates");
  const full = join(templatesDir, relPath);
  if (!existsSync(full)) {
    throw new Error(`Template not found: ${full}`);
  }
  return readFileSync(full, "utf-8");
}
