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
}

export interface ScaffoldBuildPipelineResult {
  /** Files we wrote (relative to projectDir). Useful for printing a
   *  summary + later git-add. */
  written: string[];
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
  const skipped: string[] = [];

  // Dockerfile.
  if (!state.hasDockerfile) {
    const tpl =
      input.surfaces === "client-only"
        ? "build-pipeline/Dockerfile.client.hbs"
        : "build-pipeline/Dockerfile.server.hbs";
    const out = renderTemplate(tpl, {
      name: input.projectName,
      port: input.port,
      entrypoint: input.entrypoint,
    });
    writeProjectFile(input.projectDir, "Dockerfile", out);
    written.push("Dockerfile");
  } else {
    skipped.push("Dockerfile");
  }

  // docker-compose.yml — only scaffold when no compose file (any of
  // the recognised names) is present. Always write to
  // `docker-compose.yml` since that's what Coolify expects by default.
  if (!state.hasCompose) {
    const out = renderTemplate("build-pipeline/docker-compose.yml.hbs", {
      name: input.projectName,
      owner: input.ghOwner,
      port: input.port,
    });
    writeProjectFile(input.projectDir, "docker-compose.yml", out);
    written.push("docker-compose.yml");
  } else {
    skipped.push(state.composePath?.replace(`${input.projectDir}/`, "") ?? "compose file");
  }

  // GitHub Actions deploy workflow.
  if (!state.hasDeployWorkflow) {
    // The deploy template uses GitHub Actions' own `${{ … }}` syntax,
    // which clashes with Handlebars. We render it as a plain text
    // file with `__VAR__` placeholders that get substituted here
    // instead — no Handlebars on this one.
    const raw = readTemplateRaw("build-pipeline/deploy.yml.hbs");
    const filled = raw.replace(/__DEFAULT_BRANCH__/g, input.defaultBranch);
    writeProjectFile(input.projectDir, DEPLOY_WORKFLOW_PATH, filled);
    written.push(DEPLOY_WORKFLOW_PATH);
  } else {
    skipped.push(DEPLOY_WORKFLOW_PATH);
  }

  return { written, skipped };
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
