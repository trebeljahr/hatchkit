/*
 * set-description — update a scaffolded project's human-readable
 * description across every surface hatchkit owns:
 *
 *   <project>/.hatchkit.json   — manifest `description`
 *   <project>/package.json     — package.json `description`
 *   Coolify project            — PATCH /projects/{uuid}        (description)
 *   Coolify application        — PATCH /applications/{uuid}    (description)
 *   GitHub repo                — gh repo edit <slug> --description "..."
 *
 * Each provider step is best-effort and independently skippable:
 *   --no-coolify   skip the two Coolify PATCHes (still rewrites local files)
 *   --no-github    skip `gh repo edit`
 *   --clear        write an empty description everywhere
 *
 * A failed provider call logs a warning but doesn't abort the run — the
 * remaining surfaces still get updated. The local-file rewrites are
 * atomic in spirit: each file is rewritten only after the plan is
 * confirmed, and we don't half-update the manifest if the user cancels.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { getCoolifyConfig } from "../config.js";
import { MANIFEST_FILENAME, type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { setPackageJsonDescription } from "../scaffold/pkg-json.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { repoSlugFromRemote } from "./gh-actions-secrets.js";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface SetDescriptionOptions {
  /** Directory of the scaffolded project. Manifest must exist here. */
  projectDir: string;
  /** Target description. Empty string clears the field. Prompted when
   *  omitted (unless `clear` is set). */
  newDescription?: string;
  /** Write an empty description across every surface. Mutually
   *  exclusive with `newDescription`. */
  clear?: boolean;
  /** Show the plan; don't write. */
  dryRun?: boolean;
  /** Skip the final confirmation prompt. */
  yes?: boolean;
  /** Skip Coolify project + application PATCHes. */
  noCoolify?: boolean;
  /** Skip `gh repo edit`. */
  noGithub?: boolean;
}

export async function runSetDescription(opts: SetDescriptionOptions): Promise<void> {
  const { projectDir } = opts;

  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json found in ${projectDir}. Run set-description from the project root (or pass --dir).`,
    );
  }
  const oldDescription = manifest.description ?? "";

  let newDescription: string;
  if (opts.clear) {
    if (opts.newDescription !== undefined && opts.newDescription !== "") {
      throw new Error("--clear and --to are mutually exclusive.");
    }
    newDescription = "";
  } else if (opts.newDescription !== undefined) {
    newDescription = opts.newDescription.trim();
  } else {
    newDescription = (
      await input({
        message: `New description for ${chalk.cyan(manifest.name)}:`,
        default: oldDescription || undefined,
      })
    ).trim();
  }

  if (newDescription === oldDescription) {
    console.log(
      chalk.yellow(
        `  Description is already ${newDescription ? `"${newDescription}"` : "(empty)"} — nothing to do.`,
      ),
    );
    return;
  }

  console.log(chalk.bold("\n  ── hatchkit set-description ───────────────────────────────\n"));
  console.log(`  Project:  ${chalk.cyan(manifest.name)}`);
  console.log(
    `  From:     ${oldDescription ? chalk.dim(`"${oldDescription}"`) : chalk.dim("(unset)")}`,
  );
  console.log(
    `  To:       ${newDescription ? chalk.green(`"${newDescription}"`) : chalk.green("(empty)")}`,
  );

  const repoSlug = opts.noGithub ? null : await detectRepoSlug(projectDir);
  const coolifyCfg = opts.noCoolify ? null : await getCoolifyConfig();

  console.log(chalk.bold("\n  ── Planned changes ────────────────────────────────────────\n"));
  console.log(`  ${chalk.cyan(MANIFEST_FILENAME)}                  manifest.description`);
  console.log(`  ${chalk.cyan("package.json")}                    description field`);
  if (coolifyCfg) {
    console.log(
      `  ${chalk.cyan("Coolify")}                         project + application description`,
    );
  } else if (!opts.noCoolify) {
    console.log(chalk.dim("  Coolify                         (not configured — skipping)"));
  } else {
    console.log(chalk.dim("  Coolify                         (skipped via --no-coolify)"));
  }
  if (repoSlug) {
    console.log(
      `  ${chalk.cyan("GitHub")}                          gh repo edit ${repoSlug} --description …`,
    );
  } else if (!opts.noGithub) {
    console.log(chalk.dim("  GitHub                          (no GitHub remote — skipping)"));
  } else {
    console.log(chalk.dim("  GitHub                          (skipped via --no-github)"));
  }

  if (opts.dryRun) {
    console.log(chalk.yellow("\n  [dry-run] No files written, no API calls made."));
    return;
  }

  if (!opts.yes) {
    const ok = await confirm({ message: "Apply?", default: true });
    if (!ok) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }
  }

  console.log();

  rewriteManifestDescription(projectDir, manifest, newDescription);
  console.log(chalk.green(`  ✓ wrote ${MANIFEST_FILENAME}`));

  if (existsSync(join(projectDir, "package.json"))) {
    setPackageJsonDescription(projectDir, newDescription);
    console.log(chalk.green("  ✓ wrote package.json"));
  } else {
    console.log(chalk.dim("  · package.json not found at project root — skipped"));
  }

  if (coolifyCfg) {
    await updateCoolifyDescription(coolifyCfg, manifest.name, newDescription);
  }

  if (repoSlug) {
    await updateGithubDescription(projectDir, repoSlug, newDescription);
  }

  console.log(chalk.green("\n  Done.\n"));
}

// ---------------------------------------------------------------------------
// File editor
// ---------------------------------------------------------------------------

function rewriteManifestDescription(
  projectDir: string,
  manifest: ProjectManifest,
  description: string,
): void {
  const next: ProjectManifest = { ...manifest };
  if (description) {
    next.description = description;
  } else {
    delete next.description;
  }
  const path = join(projectDir, MANIFEST_FILENAME);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Provider sync
// ---------------------------------------------------------------------------

async function updateCoolifyDescription(
  cfg: { url: string; token: string },
  projectName: string,
  description: string,
): Promise<void> {
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  try {
    const project = await api.findProjectByName(projectName);
    if (project) {
      await api.updateProject(project.uuid, { description });
      console.log(
        chalk.green(`  ✓ Coolify project ${chalk.cyan(projectName)} description updated`),
      );
    } else {
      console.log(
        chalk.dim(`  · Coolify project "${projectName}" not found — skipping project PATCH`),
      );
    }
  } catch (err) {
    console.log(
      chalk.yellow(`  ! Coolify project PATCH failed: ${(err as Error).message.split("\n")[0]}`),
    );
  }

  try {
    const app = await api.findApplicationByName(projectName);
    if (app) {
      await api.updateApplication(app.uuid, { description });
      console.log(
        chalk.green(`  ✓ Coolify application ${chalk.cyan(projectName)} description updated`),
      );
    } else {
      console.log(
        chalk.dim(
          `  · Coolify application "${projectName}" not found — skipping application PATCH`,
        ),
      );
    }
  } catch (err) {
    console.log(
      chalk.yellow(
        `  ! Coolify application PATCH failed: ${(err as Error).message.split("\n")[0]}`,
      ),
    );
  }
}

async function updateGithubDescription(
  projectDir: string,
  repoSlug: string,
  description: string,
): Promise<void> {
  const result = await exec("gh", ["repo", "edit", repoSlug, "--description", description], {
    cwd: projectDir,
    silent: true,
  });
  if (result.exitCode === 0) {
    console.log(chalk.green(`  ✓ GitHub repo ${chalk.cyan(repoSlug)} description updated`));
  } else {
    console.log(
      chalk.yellow(
        `  ! gh repo edit failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).split("\n")[0]}`,
      ),
    );
  }
}

async function detectRepoSlug(projectDir: string): Promise<string | null> {
  const res = await exec("git", ["remote", "get-url", "origin"], {
    cwd: projectDir,
    silent: true,
  });
  if (res.exitCode !== 0) return null;
  return repoSlugFromRemote(res.stdout.trim()) ?? null;
}

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

export async function runSetDescriptionCli(args: string[]): Promise<void> {
  const flagValue = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = args.findIndex((a) => a === `--${name}`);
    if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      return args[i + 1];
    }
    return undefined;
  };

  const positionalIdx = args.findIndex((a) => !a.startsWith("--"));
  // Positional only counts if the previous flag wasn't a value flag that
  // consumed it. Conservative: only the first positional is treated as
  // the description when --to wasn't passed.
  const positional = positionalIdx >= 0 ? args[positionalIdx] : undefined;
  // Skip positional values that look like they're the value of a known
  // value-taking flag (--to / --dir).
  const takenByFlag = (() => {
    if (positionalIdx <= 0) return false;
    const prev = args[positionalIdx - 1];
    return prev === "--to" || prev === "--dir";
  })();
  const positionalDescription = takenByFlag ? undefined : positional;

  const newDescription = flagValue("to") ?? positionalDescription;
  const dirArg = flagValue("dir");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const clear = args.includes("--clear");
  const noCoolify = args.includes("--no-coolify");
  const noGithub = args.includes("--no-github");

  const projectDir = dirArg ? resolve(dirArg) : resolve(".");
  await runSetDescription({
    projectDir,
    newDescription,
    clear,
    dryRun,
    yes,
    noCoolify,
    noGithub,
  });
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const _internals = {
  rewriteManifestDescription,
};
