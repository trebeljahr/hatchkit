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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderTemplate } from "../utils/template.js";

/** Default Node major used when the project doesn't pin one via
 *  `engines.node`. Bumped to 24 (LTS since Oct 2025) to match what
 *  GitHub Actions defaults to and what most modern dependencies
 *  require — staying on 22 was producing `ERR_PNPM_UNSUPPORTED_ENGINE`
 *  for projects that had quietly added `>=24` to engines.node. */
const DEFAULT_NODE_MAJOR = "24";

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
  if (input.force || !state.hasDockerfile) {
    const tpl =
      input.surfaces === "client-only"
        ? "build-pipeline/Dockerfile.client.hbs"
        : "build-pipeline/Dockerfile.server.hbs";
    const out = renderTemplate(tpl, {
      name: input.projectName,
      port: input.port,
      entrypoint: input.entrypoint,
      nodeMajor,
    });
    write("Dockerfile", out, state.hasDockerfile);
  } else {
    skipped.push("Dockerfile");
  }

  // docker-compose.yml — only scaffold when no compose file (any of
  // the recognised names) is present. Always write to
  // `docker-compose.yml` since that's what Coolify expects by default.
  if (input.force || !state.hasCompose) {
    const out = renderTemplate("build-pipeline/docker-compose.yml.hbs", {
      name: input.projectName,
      owner: input.ghOwner,
      port: input.port,
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

  return { written, created, overwritten, skipped };
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
