/*
 * `hatchkit regen-infra` — regenerate Terraform tfvars + Coolify stack
 * .env for a scaffolded project, in place.
 *
 * Why this exists: `scaffoldInfra` runs once during `create` / `adopt`
 * and bakes the project's choices into static files under
 * `infra/terraform/stacks/.../<name>.tfvars` and `infra/stacks/<name>.env`.
 * When the CLI's tfvars-generation logic changes (e.g. dropping the
 * `api.<sub>` subdomain for static surfaces, or flipping
 * `MONGO_ENABLED` based on the surface), existing projects keep their
 * old files until someone re-runs scaffoldInfra. This command does
 * exactly that — re-render from the manifest, preserve the infra-only
 * fields the manifest doesn't carry (target_ipv4/v6 for dns-only,
 * serverType / serverLocation for new-server), diff against what's on
 * disk, and write the new files.
 *
 * Intentionally does NOT run `terraform apply` or touch Coolify. The
 * user runs `terraform apply -var-file=<name>.tfvars` themselves once
 * they've reviewed the plan.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import chalk from "chalk";
import type { ProjectConfig, Surface } from "../prompts.js";
import { generateCoolifyEnv, generateTfvars, resolveStackDir } from "../scaffold/infra.js";
import { type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { parseDomain } from "../utils/validate.js";

interface RegenArgs {
  /** Project directory — defaults to cwd. The manifest must live here. */
  projectDir: string;
  /** Repo root for the hatchkit checkout (where the infra/ tree is). */
  monorepoRoot: string;
  /** Show the diff but don't write. */
  dryRun: boolean;
}

export async function runRegenInfraCli(args: string[], monorepoRoot: string): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const dirFlag = args.findIndex((a) => a === "--dir");
  const projectDir = resolve(dirFlag >= 0 ? (args[dirFlag + 1] ?? ".") : ".");
  await runRegenInfra({ projectDir, monorepoRoot, dryRun });
}

export async function runRegenInfra(opts: RegenArgs): Promise<void> {
  const { projectDir, monorepoRoot, dryRun } = opts;

  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json in ${projectDir}. Run from inside a scaffolded project, or pass --dir <project-dir>.`,
    );
  }

  // Locate the existing tfvars file. We try the same three stack dirs
  // `resolveStackDir` knows about and pick the first hit — matches what
  // `rename-domain.ts` does.
  const candidatePaths = [
    join(monorepoRoot, "infra", "terraform", "stacks", "node-realtime", `${manifest.name}.tfvars`),
    join(
      monorepoRoot,
      "infra",
      "terraform",
      "stacks",
      "dns-only-cloudflare",
      `${manifest.name}.tfvars`,
    ),
  ];
  const existingTfvarsPath = candidatePaths.find((p) => existsSync(p));

  // Reconstruct the bits of ProjectConfig the tfvars/coolify-env
  // generators care about. Manifest carries the safe public-facing
  // fields; everything infra-only (server coords, IPs, S3 creds) we
  // either pull from the existing tfvars (when present) or accept as
  // empty (terraform plan will fail loudly enough if a required value
  // is missing).
  const config = configFromManifestAndTfvars(manifest, existingTfvarsPath);

  const newTfvars = generateTfvars(config);
  const newCoolifyEnv = generateCoolifyEnv(config, {});

  // Existing-content reads — null when the file doesn't yet exist so
  // the diff shows the file as new.
  const oldTfvars = existingTfvarsPath ? readFileSync(existingTfvarsPath, "utf-8") : "";
  const coolifyEnvPath = join(monorepoRoot, "infra", "stacks", `${manifest.name}.env`);
  const oldCoolifyEnv = existsSync(coolifyEnvPath) ? readFileSync(coolifyEnvPath, "utf-8") : "";

  // Decide where the new tfvars should land — same dir as the existing
  // file when we found one, else fall back to `resolveStackDir` so a
  // fresh regen still produces a valid file. resolveStackDir resolves
  // paths relative to the `infra/` root, not the monorepo root, so we
  // join the prefix ourselves.
  let tfvarsTargetPath = existingTfvarsPath;
  if (!tfvarsTargetPath && newTfvars) {
    const stackDir = resolveStackDir(
      join(monorepoRoot, "infra"),
      config.deployTarget,
      "cloudflare",
    );
    if (stackDir) tfvarsTargetPath = join(stackDir, `${manifest.name}.tfvars`);
  }

  console.log(chalk.bold(`\n  ── regen-infra: ${manifest.name} ─────────────────────────`));
  console.log(
    chalk.dim(
      `  domain=${manifest.domain}  surfaces=${manifest.surfaces ?? "fullstack"}  deploy=${manifest.deployTarget}`,
    ),
  );

  let touched = 0;
  touched += renderFileChange("tfvars", tfvarsTargetPath, oldTfvars, newTfvars, dryRun);
  touched += renderFileChange("coolify .env", coolifyEnvPath, oldCoolifyEnv, newCoolifyEnv, dryRun);

  if (touched === 0) {
    console.log(chalk.green("\n  ✓ Already up to date — no changes."));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow(`\n  [dry-run] ${touched} file(s) would be rewritten.`));
    console.log(chalk.dim("  Re-run without --dry-run to apply."));
    return;
  }

  console.log(chalk.green(`\n  ✓ Regenerated ${touched} file(s).`));
  if (tfvarsTargetPath && newTfvars && oldTfvars !== newTfvars) {
    const stackDir = dirname(tfvarsTargetPath);
    console.log(
      chalk.yellow(
        `\n  Next: terraform -chdir=${stackDir} plan -var-file=${basename(tfvarsTargetPath)}`,
      ),
    );
    console.log(
      chalk.dim(
        `        terraform -chdir=${stackDir} apply -var-file=${basename(tfvarsTargetPath)}`,
      ),
    );
  }
}

function renderFileChange(
  label: string,
  path: string | undefined,
  oldContent: string,
  newContent: string,
  dryRun: boolean,
): number {
  if (!path) {
    console.log(chalk.dim(`  ${label}: no target path resolved (manual DNS?) — skipped`));
    return 0;
  }
  if (oldContent === newContent) {
    console.log(chalk.dim(`  ${label}: unchanged (${path})`));
    return 0;
  }
  console.log(chalk.bold(`\n  ${label}: ${chalk.cyan(path)}`));
  printUnifiedDiff(oldContent, newContent);
  if (!dryRun) writeFileSync(path, newContent, "utf-8");
  return 1;
}

/** Print a line-level diff between two strings using an LCS table — so
 *  removing one line in the middle doesn't make every subsequent line
 *  look changed. Files here are small (tens of lines), so the O(n·m)
 *  table is fine and we avoid pulling in a dep. */
function printUnifiedDiff(oldStr: string, newStr: string): void {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  // LCS lengths table.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Walk the table emitting -/+/context lines.
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      console.log(chalk.red(`    - ${a[i]}`));
      i++;
    } else {
      console.log(chalk.green(`    + ${b[j]}`));
      j++;
    }
  }
  while (i < a.length) console.log(chalk.red(`    - ${a[i++]}`));
  while (j < b.length) console.log(chalk.green(`    + ${b[j++]}`));
}

function configFromManifestAndTfvars(
  manifest: ProjectManifest,
  tfvarsPath: string | undefined,
): ProjectConfig {
  const tfvars = tfvarsPath && existsSync(tfvarsPath) ? readFileSync(tfvarsPath, "utf-8") : "";
  const { baseDomain, subdomain } = parseDomain(manifest.domain);
  return {
    name: manifest.name,
    domain: manifest.domain,
    baseDomain,
    subdomain,
    surfaces: (manifest.surfaces ?? "fullstack") as Surface,
    deployTarget: manifest.deployTarget,
    // Infra-only fields — preserved from the existing tfvars so we
    // don't blow away discovered IPs / sizes.
    serverIpv4: extractHcl(tfvars, "target_ipv4") || undefined,
    serverIpv6: extractHcl(tfvars, "target_ipv6") || undefined,
    serverSize: extractHcl(tfvars, "server_type") || undefined,
    serverLocation: extractHcl(tfvars, "server_location") || undefined,
    features: [...manifest.features],
    provisionServices: [],
    s3Provider: manifest.s3Provider,
    mlServices: [...manifest.mlServices],
    forceRedeployMl: [],
    gpuPlatforms: manifest.gpuPlatforms,
    customHfModelId: manifest.customHfModelId,
    customHfGpuType: manifest.customHfGpuType,
    scaffoldRepo: false,
    createGithubRepo: false,
    installDeps: false,
    // Default to coolify when the manifest is from before deploymentMode
    // existed — regen-infra only runs against Coolify projects anyway
    // (gh-pages has no infra to regenerate).
    deploymentMode: manifest.deploymentMode ?? "coolify",
    runDeployment: false,
    dryRun: false,
    envValues: {},
  };
}

/** Pull a top-level `key = "value"` line out of an HCL tfvars body.
 *  Tolerates leading whitespace; ignores values inside blocks. Returns
 *  the unquoted value, or "" when not found. */
function extractHcl(content: string, key: string): string {
  if (!content) return "";
  const m = content.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : "";
}
