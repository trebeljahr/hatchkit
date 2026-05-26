/*
 * rename-project — change a scaffolded project's slug.
 *
 * Sister command to `rename-domain` — same plan/dry-run/confirm/apply
 * structure, but rewrites every local file hatchkit owns that hard-codes
 * the old project name:
 *
 *   <project>/.hatchkit.json                — manifest `name` field
 *   <project>/package.json                  — top-level `name` and any
 *                                             `<old>-dev`/`-prod`/`-e2e`/
 *                                             `-assets` references in
 *                                             scripts/strings
 *   <project>/README.md                     — any literal occurrence
 *                                             (heading, badge URL, …)
 *   <project>/docker-compose.dev.yml,
 *   <project>/playwright.config.ts,
 *   <project>/packages/server/.env.*,
 *   <project>/packages/server/src/config/env.ts
 *                                           — `<old>-dev`/`-e2e`/
 *                                             `-assets` substring swap
 *   <infra>/terraform/stacks/<stack>/<old>.tfvars
 *                                           — file rename + content
 *                                             rewrite (server_name,
 *                                             s3_bucket_name)
 *   <infra>/stacks/<old>.env                — file rename + content
 *                                             rewrite (PROJECT_NAME,
 *                                             APP_NAME, S3_BUCKET if it
 *                                             mentions the old name)
 *   <configDir>/runs/<old>.json             — ledger file rename + `name`
 *                                             field rewrite (step
 *                                             contents are left alone —
 *                                             those reference live
 *                                             provider resources that
 *                                             haven't been renamed yet)
 *
 * By default this is local-only: it does NOT touch provider-side state
 * (Coolify, GitHub, R2, GlitchTip, OpenPanel, Plausible, Listmonk + SES,
 * Tailscale, Keychain). Those are destructive or visible-to-others
 * operations the user should authorize. A follow-up checklist is
 * printed at the end.
 *
 * Opt-in automation flags execute selected remote ops AFTER the local
 * file rewrites succeed:
 *
 *   --gh        gh repo rename + git remote set-url. On success, rewrites
 *               github / ghActionsSecret / ghPages step.repo entries in
 *               the (already-renamed) run ledger.
 *   --coolify   PATCH /projects/{uuid} {name}. Apps (uuid-keyed) survive
 *               unchanged; their displayed names stay <old>-server etc.
 *               unless you destroy + adopt --resume.
 *   --keys      Re-key every per-project keychain entry (dotenvx,
 *               per-project s3, openpanel, plausible, stripe-per-project)
 *               from oldName to newName. Set-before-delete; refuses to
 *               clobber an existing target with a different value.
 *   --ci        After the above, dispatch the build-and-deploy.yml
 *               GitHub Actions workflow so the new GHCR images get
 *               published before the next deploy.
 *   --all       Shorthand for --gh --coolify --keys --ci.
 *
 * Also: when --gh is requested (or when the origin remote already
 * points at a GitHub repo), docker-compose.yml is rewritten to swap
 * `ghcr.io/<owner>/<old>` → `<owner>/<new>` image refs as part of the
 * local edits. The starter workflow file uses
 * `${{ github.repository }}` which GitHub resolves to the new slug
 * post-rename, so no workflow edit is needed.
 *
 * R2 buckets / GlitchTip / OpenPanel / Plausible / Listmonk + SES projects
 * still belong to the checklist — those providers have no rename API
 * and recreating drops history. Scope is same-owner-only for the
 * GitHub rename.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { getConfigPath, getCoolifyConfig } from "../config.js";
import { type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import {
  getLedgerPath,
  rewriteLedgerStepPathBasenames,
  rewriteLedgerStepSlugs,
} from "../utils/run-ledger.js";
import { migrateProjectSecrets } from "../utils/secrets.js";
import { validateProjectName } from "../utils/validate.js";
import { ownerFromRemote, repoSlugFromRemote } from "./gh-actions-secrets.js";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface RenameProjectOptions {
  /** Directory of the scaffolded project. Manifest must exist here. */
  projectDir: string;
  /** Monorepo root — `infra/` + `stacks/` live under this. */
  monorepoRoot: string;
  /** Target name. If omitted, the user is prompted. */
  newName?: string;
  /** Show the plan, don't write, don't call APIs. */
  dryRun?: boolean;
  /** Skip the final confirmation prompt. */
  yes?: boolean;
  /** Execute `gh repo rename` + `git remote set-url`, then rewrite
   *  github/ghActionsSecret/ghPages step.repo entries in the ledger. */
  gh?: boolean;
  /** Execute the Coolify project PATCH to rename the project entity.
   *  Coolify apps are not renamed (the API has no endpoint for it). */
  coolify?: boolean;
  /** Migrate per-project keychain entries to the new name. */
  keys?: boolean;
  /** Dispatch build-and-deploy.yml so new GHCR images publish. */
  ci?: boolean;
}

export async function runRenameProject(opts: RenameProjectOptions): Promise<void> {
  const { projectDir, monorepoRoot } = opts;

  // 1. Manifest
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json found in ${projectDir}. Run rename-project from the project root (or pass --dir).`,
    );
  }
  const oldName = manifest.name;

  // 2. Target name
  const newName =
    opts.newName ??
    (await input({
      message: `New project name (was ${chalk.dim(oldName)}):`,
      validate: validateProjectName,
    }));
  const valid = validateProjectName(newName);
  if (valid !== true) throw new Error(`--to invalid: ${valid}`);
  if (newName === oldName) {
    console.log(chalk.yellow(`  ${oldName} is already the current name — nothing to do.`));
    return;
  }

  // 2b. Resolve GitHub slug from `origin` remote (best-effort — used by
  //     docker-compose ghcr image rewrites and the optional --gh rename).
  const remoteUrl = await readGitRemote(projectDir);
  const oldSlug = repoSlugFromRemote(remoteUrl ?? undefined);
  const owner = oldSlug ? ownerFromRemote(remoteUrl ?? undefined) : undefined;
  const newSlug = owner ? `${owner}/${newName}` : undefined;
  const newRemote = remoteUrl && oldSlug && newSlug ? rewriteRemoteUrl(remoteUrl, newSlug) : null;

  console.log(chalk.bold("\n  ── hatchkit rename-project ────────────────────────────────\n"));
  console.log(`  Domain:     ${chalk.dim(manifest.domain)}`);
  console.log(`  From → To:  ${chalk.dim(oldName)} → ${chalk.green(newName)}`);
  if (oldSlug && newSlug) {
    console.log(`  GitHub:     ${chalk.dim(oldSlug)} → ${chalk.green(newSlug)}`);
  }

  // 3. Collect edit plan
  const fileOps: FileOp[] = [];

  // 3a. Manifest — rewrite the `name` field.
  fileOps.push(rewriteManifest(join(projectDir, ".hatchkit.json"), manifest, newName));

  // 3b. Root package.json — `name` field and any `<old>-{dev,prod,e2e,assets}`
  //     references in scripts / workspace strings.
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    fileOps.push(rewritePackageJson(pkgPath, oldName, newName));
  }

  // 3c. Other starter files that bake the old project name in via
  //     `applyProjectName()` at scaffold time. Mirror that list so a
  //     rename is symmetric. Each is a simple `<old>-{dev,e2e,assets}`
  //     literal swap.
  const STARTER_NAMED_FILES = [
    "docker-compose.dev.yml",
    "playwright.config.ts",
    "packages/server/.env.development",
    "packages/server/.env.example",
    "packages/server/src/config/env.ts",
  ];
  for (const rel of STARTER_NAMED_FILES) {
    const p = join(projectDir, rel);
    if (!existsSync(p)) continue;
    const edit = rewriteStarterNamedFile(p, oldName, newName);
    if (edit) fileOps.push(edit);
  }

  // 3c.bis docker-compose.yml — `ghcr.io/<owner>/<old>-{server,client}:<tag>`
  //         image refs. Only meaningful when we know the slug; otherwise
  //         the user has hand-rolled images and we don't touch them.
  if (oldSlug && newSlug) {
    const compose = join(projectDir, "docker-compose.yml");
    if (existsSync(compose)) {
      const edit = rewriteDockerCompose(compose, oldSlug, newSlug);
      if (edit) fileOps.push(edit);
    }
  }

  // 3d. README.md — best-effort literal swap.
  const readmePath = join(projectDir, "README.md");
  if (existsSync(readmePath)) {
    const edit = rewriteReadme(readmePath, oldName, newName);
    if (edit) fileOps.push(edit);
  }

  // 3e. Terraform tfvars — same stack dispatch as rename-domain.
  const tfvarsOldPath = findTfvars(monorepoRoot, manifest, oldName);
  if (tfvarsOldPath) {
    const tfvarsNewPath = join(
      tfvarsOldPath.slice(0, -`${oldName}.tfvars`.length),
      `${newName}.tfvars`,
    );
    if (existsSync(tfvarsNewPath)) {
      throw new Error(
        `Refusing to rename: ${tfvarsNewPath} already exists. Another project may already use the name "${newName}".`,
      );
    }
    fileOps.push(planTfvarsRename(tfvarsOldPath, tfvarsNewPath, oldName, newName));
  } else {
    console.log(
      chalk.yellow(
        `  ! No tfvars found for ${oldName} under infra/terraform/stacks — skipping terraform bit.`,
      ),
    );
  }

  // 3f. Coolify stacks env.
  const stacksOldPath = findStacksEnv(monorepoRoot, oldName);
  if (stacksOldPath) {
    const dir = stacksOldPath.slice(0, -`${oldName}.env`.length);
    const stacksNewPath = join(dir, `${newName}.env`);
    if (existsSync(stacksNewPath)) {
      throw new Error(
        `Refusing to rename: ${stacksNewPath} already exists. Another project may already use the name "${newName}".`,
      );
    }
    fileOps.push(planStacksEnvRename(stacksOldPath, stacksNewPath, oldName, newName));
  } else {
    console.log(
      chalk.yellow(
        `  ! No stacks/${oldName}.env found — skipping Coolify env bit. (You may need to set PROJECT_NAME/APP_NAME manually in the Coolify dashboard.)`,
      ),
    );
  }

  // 3g. Run ledger — rename the on-disk file + rewrite the `name` field.
  //     Step contents (bucket names, Coolify uuids, GitHub repo) are
  //     deliberately left alone: they point at live provider resources
  //     that haven't been renamed yet, and rewriting them here would
  //     break `hatchkit destroy` until the user finishes the manual
  //     provider-side migration (R2 bucket recreate, gh repo rename,
  //     Coolify rename). The checklist below covers those.
  const ledgerOldPath = getLedgerPath(oldName);
  if (existsSync(ledgerOldPath)) {
    const ledgerNewPath = getLedgerPath(newName);
    if (existsSync(ledgerNewPath)) {
      throw new Error(
        `Refusing to rename: ledger ${ledgerNewPath} already exists for "${newName}".`,
      );
    }
    fileOps.push(planLedgerRename(ledgerOldPath, ledgerNewPath, oldName, newName));
  }

  // 3h. Provisioned env block files at <config-dir>/provisioned/<old>.*.env.
  //     These cache the per-project env lines emitted by `hatchkit add`
  //     so re-runs can rebuild .env files without re-prompting. Keyed by
  //     project name, so they need renaming alongside the manifest.
  const provisionedRenames = planProvisionedEnvRenames(oldName, newName);

  // 4. Plan
  console.log(chalk.bold("\n  ── Planned file changes ───────────────────────────────────\n"));
  for (const op of fileOps) {
    console.log(`  ${chalk.cyan(op.label)}`);
    for (const change of op.changes) {
      console.log(chalk.dim(`    - ${change}`));
    }
  }
  for (const r of provisionedRenames) {
    console.log(`  ${chalk.cyan(r.label)}`);
    console.log(chalk.dim(`    - rename: ${r.from.split("/").pop()} → ${r.to.split("/").pop()}`));
  }

  // Opt-in remote ops — print what will run.
  const remoteOpsRequested =
    opts.gh === true || opts.coolify === true || opts.keys === true || opts.ci === true;
  if (remoteOpsRequested) {
    console.log(chalk.bold("\n  ── Planned remote / keychain ops (opt-in) ─────────────────\n"));
    if (opts.gh) {
      if (oldSlug && newSlug) {
        console.log(`  ${chalk.cyan("[gh]      ")} repo rename ${oldSlug} → ${newSlug}`);
        if (newRemote && newRemote !== remoteUrl) {
          console.log(
            `  ${chalk.cyan("[git]     ")} origin set-url ${chalk.dim(remoteUrl)} → ${newRemote}`,
          );
        }
        console.log(
          `  ${chalk.cyan("[ledger]  ")} rewrite github/ghActionsSecret/ghPages step.repo entries`,
        );
      } else {
        console.log(
          chalk.yellow(`  ! --gh requested but no GitHub remote on origin — skipping GitHub bits.`),
        );
      }
    }
    if (opts.coolify) {
      console.log(
        `  ${chalk.cyan("[coolify] ")} PATCH /projects/{uuid} name=${newName} (apps NOT renamed)`,
      );
    }
    if (opts.keys) {
      console.log(
        `  ${chalk.cyan("[keychain]")} re-key dotenvx / s3 / openpanel / plausible / stripe entries`,
      );
    }
    if (opts.ci) {
      console.log(
        `  ${chalk.cyan("[ci]      ")} dispatch build-and-deploy.yml so new GHCR images publish`,
      );
    }
  }

  if (opts.dryRun) {
    console.log(chalk.yellow("\n  [dry-run] No files written, no APIs called."));
    printChecklist(manifest, oldName, newName, {
      oldSlug,
      newSlug,
      executedGh: false,
      executedCoolify: false,
      executedKeys: false,
    });
    return;
  }

  // 5. Confirm
  if (!opts.yes) {
    const totalOps = fileOps.length + provisionedRenames.length;
    const ok = await confirm({
      message: `Apply ${totalOps} local change(s)${remoteOpsRequested ? " + remote ops" : ""}?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }
  }

  // 6. Apply local file ops. For each: write the new content to its
  //    target path, then if there's a separate `oldPath` (rename),
  //    unlink the old. Order: write new, verify, unlink old — atomic
  //    per file.
  for (const op of fileOps) {
    writeFileSync(op.newPath, op.after);
    if (op.oldPath && op.oldPath !== op.newPath) {
      // Belt-and-braces: only unlink the old path after the new one
      // exists on disk. `writeFileSync` is synchronous so if we got
      // here the write succeeded.
      if (existsSync(op.newPath)) {
        unlinkSync(op.oldPath);
      } else {
        throw new Error(`Failed to write ${op.newPath} — leaving ${op.oldPath} in place.`);
      }
    }
    console.log(chalk.green(`  ✓ ${op.verb} ${op.label}`));
  }

  // 6b. Apply provisioned env block renames.
  for (const r of provisionedRenames) {
    const data = readFileSync(r.from);
    writeFileSync(r.to, data, { mode: 0o600 });
    if (existsSync(r.to)) unlinkSync(r.from);
    console.log(chalk.green(`  ✓ renamed ${r.label}`));
  }

  // 6c. Update local-file step.path entries in the (just-renamed)
  //     ledger so `hatchkit destroy <newName>` finds the tfvars/coolify-env
  //     files at their new paths. Safe regardless of provider rename
  //     status — these are local files we definitely moved.
  if (existsSync(getLedgerPath(newName))) {
    const n = rewriteLedgerStepPathBasenames(newName, oldName, newName);
    if (n > 0) {
      console.log(chalk.green(`  ✓ ledger: rewrote ${n} local-file step path(s)`));
    }
  }

  // 7. Optional remote / keychain ops. Each is best-effort: a failure
  //    prints a checklist hint but doesn't abort the run. The local
  //    rename is already committed at this point — the user can re-run
  //    individual --gh / --coolify / --keys / --ci flags as needed.
  let executedGh = false;
  let executedCoolify = false;
  let executedKeys = false;

  if (opts.gh && oldSlug && newSlug) {
    executedGh = await renameGithubRepo(projectDir, oldSlug, newName);
    if (executedGh) {
      if (newRemote && newRemote !== remoteUrl) {
        await setGitRemote(projectDir, newRemote);
        console.log(chalk.green(`  ✓ set origin → ${newRemote}`));
      }
      const n = rewriteLedgerStepSlugs(newName, oldSlug, newSlug);
      if (n > 0) {
        console.log(chalk.green(`  ✓ ledger: rewrote ${n} repo-slug step(s)`));
      }
    }
  }

  if (opts.coolify) {
    executedCoolify = await renameCoolifyProject(oldName, newName);
  }

  if (opts.keys) {
    const result = await migrateProjectSecrets(oldName, newName);
    executedKeys = result.unmoved.length === 0;
    if (result.moved.length > 0) {
      console.log(
        chalk.green(`  ✓ keychain: migrated ${result.moved.length} entry(ies) to ${newName}`),
      );
    } else {
      console.log(chalk.dim("  · keychain: no matching entries — nothing to migrate"));
    }
    for (const u of result.unmoved) {
      console.log(chalk.yellow(`  ! keychain: ${u.account} — ${u.reason}`));
    }
  }

  if (opts.ci) {
    if (executedGh || (!opts.gh && oldSlug && newSlug)) {
      await triggerCiWorkflow(projectDir);
    } else {
      console.log(chalk.dim("  · --ci skipped (no GitHub remote known)"));
    }
  }

  printChecklist(manifest, oldName, newName, {
    oldSlug,
    newSlug,
    executedGh,
    executedCoolify,
    executedKeys,
  });
}

// ---------------------------------------------------------------------------
// File editors — each returns a fully-resolved FileOp ready to apply.
// ---------------------------------------------------------------------------

interface FileOp {
  /** Human label for the plan output. */
  label: string;
  /** Verb used in the apply confirmation line ("wrote" / "renamed"). */
  verb: string;
  /** Destination path the new content goes to. */
  newPath: string;
  /** Source path to remove after the write, if this op is a rename. */
  oldPath?: string;
  /** New file content. */
  after: string;
  /** Plan-output bullets. */
  changes: string[];
}

function rewriteManifest(path: string, m: ProjectManifest, newName: string): FileOp {
  const next = { ...m, name: newName };
  return {
    label: basename(path),
    verb: "wrote",
    newPath: path,
    after: `${JSON.stringify(next, null, 2)}\n`,
    changes: [`name: "${m.name}" → "${newName}"`],
  };
}

/**
 * Rewrite the top-level `name` field on package.json and any literal
 * `<old>-{dev,prod,e2e,assets}` substring elsewhere in the JSON. We
 * deliberately don't touch `@starter/*` workspace package names — those
 * aren't tied to the project slug.
 */
function rewritePackageJson(path: string, oldName: string, newName: string): FileOp {
  const before = readFileSync(path, "utf8");
  const pkg = JSON.parse(before);
  const changes: string[] = [];

  if (pkg.name === oldName) {
    pkg.name = newName;
    changes.push(`name: "${oldName}" → "${newName}"`);
  } else if (typeof pkg.name === "string") {
    changes.push(`name: "${pkg.name}" (left alone — doesn't match old project name)`);
  }

  // Now serialize and run the literal-substring swap on the suffixed
  // names. Doing this on the serialized JSON catches references anywhere
  // (scripts, env vars, dependencies, top-level metadata) without
  // needing to enumerate every nested key.
  let serialized = `${JSON.stringify(pkg, null, 2)}\n`;
  for (const suffix of ["-dev", "-prod", "-e2e", "-assets"]) {
    const from = `${oldName}${suffix}`;
    const to = `${newName}${suffix}`;
    if (serialized.includes(from)) {
      const count = serialized.split(from).length - 1;
      serialized = serialized.split(from).join(to);
      changes.push(`${count}× "${from}" → "${to}"`);
    }
  }

  return {
    label: "package.json",
    verb: "wrote",
    newPath: path,
    after: serialized,
    changes: changes.length > 0 ? changes : ["(no changes detected)"],
  };
}

/**
 * Swap `<old>-{dev,e2e,assets}` substrings in starter files seeded by
 * scaffold/starter-files.ts `applyProjectName`. Skips files where the
 * old name doesn't appear, so we don't emit a no-op entry into the
 * plan.
 */
function rewriteStarterNamedFile(path: string, oldName: string, newName: string): FileOp | null {
  const before = readFileSync(path, "utf8");
  let after = before;
  const changes: string[] = [];
  for (const suffix of ["-dev", "-e2e", "-assets"]) {
    const from = `${oldName}${suffix}`;
    const to = `${newName}${suffix}`;
    if (after.includes(from)) {
      const count = after.split(from).length - 1;
      after = after.split(from).join(to);
      changes.push(`${count}× "${from}" → "${to}"`);
    }
  }
  if (after === before) return null;
  return {
    label: path.split("/").slice(-3).join("/"),
    verb: "wrote",
    newPath: path,
    after,
    changes,
  };
}

/**
 * Best-effort README rewrite — literal occurrences of the old name only.
 * Sub-words (e.g. `oldname-server`) get caught too, but README content
 * is user-edited prose and the only safe move is "show the diff in the
 * plan and let the user confirm". Skips the file when no occurrence is
 * found.
 */
function rewriteReadme(path: string, oldName: string, newName: string): FileOp | null {
  const before = readFileSync(path, "utf8");
  if (!before.includes(oldName)) return null;
  const count = before.split(oldName).length - 1;
  const after = before.split(oldName).join(newName);
  return {
    label: basename(path),
    verb: "wrote",
    newPath: path,
    after,
    changes: [`${count}× "${oldName}" → "${newName}"`],
  };
}

/**
 * Rewrite tfvars content (`server_name = "<old>-prod"`,
 * `s3_bucket_name = "<old>-assets"`, any stray `<old>` token), then move
 * the file from `<old>.tfvars` → `<new>.tfvars`.
 */
function planTfvarsRename(
  oldPath: string,
  newPath: string,
  oldName: string,
  newName: string,
): FileOp {
  const before = readFileSync(oldPath, "utf8");
  let after = before;
  const changes: string[] = [];

  // server_name = "<old>-prod"  →  "<new>-prod"
  const serverNameRe = /(\bserver_name\s*=\s*")([^"]+)(")/;
  const m = after.match(serverNameRe);
  if (m && m[2] === `${oldName}-prod`) {
    after = after.replace(serverNameRe, `$1${newName}-prod$3`);
    changes.push(`server_name: "${oldName}-prod" → "${newName}-prod"`);
  }

  // s3_bucket_name = "<old>-assets"  →  "<new>-assets"
  const bucketRe = /(\bs3_bucket_name\s*=\s*")([^"]+)(")/;
  const bm = after.match(bucketRe);
  if (bm && bm[2] === `${oldName}-assets`) {
    after = after.replace(bucketRe, `$1${newName}-assets$3`);
    changes.push(`s3_bucket_name: "${oldName}-assets" → "${newName}-assets"`);
  }

  // Any remaining literal `<old>` occurrences (comments, custom keys).
  if (after.includes(oldName)) {
    const count = after.split(oldName).length - 1;
    after = after.split(oldName).join(newName);
    changes.push(`${count} stray "${oldName}" → "${newName}"`);
  }

  changes.push(`rename: ${basename(oldPath)} → ${basename(newPath)}`);

  return {
    label: oldPath.split("/").slice(-4).join("/"),
    verb: "renamed",
    newPath,
    oldPath,
    after,
    changes,
  };
}

/**
 * Rewrite the Coolify stack env. Targets:
 *   - PROJECT_NAME="<old>"   →  "<new>"
 *   - APP_NAME="<old>"       →  "<new>"
 *   - S3_BUCKET="<old>-…"    →  "<new>-…"     (only when the value starts
 *                                              with `<oldName>-`)
 * COOLIFY_URL is skipped (dashboard URL, not project-tied).
 */
function planStacksEnvRename(
  oldPath: string,
  newPath: string,
  oldName: string,
  newName: string,
): FileOp {
  const before = readFileSync(oldPath, "utf8");
  const lines = before.split("\n");
  const changes: string[] = [];

  const KEY_EXACT = new Set(["PROJECT_NAME", "APP_NAME"]);

  const next = lines.map((line) => {
    if (line.trim().startsWith("#") || line.trim() === "") return line;
    if (line.startsWith("COOLIFY_URL")) return line;
    const eq = line.indexOf("=");
    if (eq < 0) return line;
    const key = line.slice(0, eq);
    const rest = line.slice(eq + 1);

    if (KEY_EXACT.has(key)) {
      const re = /^("?)([^"]*)("?)$/;
      const m = rest.match(re);
      if (m && m[2] === oldName) {
        changes.push(`${key}: "${oldName}" → "${newName}"`);
        return `${key}=${m[1]}${newName}${m[3]}`;
      }
      return line;
    }

    // S3_BUCKET / S3_BUCKET_NAME — value like "<old>-assets". Swap the
    // prefix only.
    if (key === "S3_BUCKET" || key === "S3_BUCKET_NAME") {
      const prefix = `${oldName}-`;
      const re = /^("?)([^"]*)("?)$/;
      const m = rest.match(re);
      if (m?.[2].startsWith(prefix)) {
        const newVal = `${newName}-${m[2].slice(prefix.length)}`;
        changes.push(`${key}: "${m[2]}" → "${newVal}"`);
        return `${key}=${m[1]}${newVal}${m[3]}`;
      }
      return line;
    }

    return line;
  });

  changes.push(`rename: ${basename(oldPath)} → ${basename(newPath)}`);

  return {
    label: oldPath.split("/").slice(-2).join("/"),
    verb: "renamed",
    newPath,
    oldPath,
    after: next.join("\n"),
    changes,
  };
}

/**
 * Rewrite the run-ledger `name` field and move the file. Step contents
 * are kept verbatim — they reference live provider resources that
 * haven't been renamed yet.
 */
function planLedgerRename(
  oldPath: string,
  newPath: string,
  oldName: string,
  newName: string,
): FileOp {
  const before = readFileSync(oldPath, "utf8");
  const parsed = JSON.parse(before) as { name: string };
  const next = { ...parsed, name: newName };
  return {
    label: `runs/${basename(oldPath)}`,
    verb: "renamed",
    newPath,
    oldPath,
    after: `${JSON.stringify(next, null, 2)}`,
    changes: [
      `name: "${oldName}" → "${newName}"`,
      `rename: ${basename(oldPath)} → ${basename(newPath)}`,
      `(step contents untouched — they point at live provider resources)`,
    ],
  };
}

/**
 * Rewrite GHCR image refs in docker-compose.yml. The starter writes
 * refs in the form `ghcr.io/<owner>/<name>-{server,client}:<tag>` and
 * occasionally a bare `ghcr.io/<owner>/<name>:<tag>` — both shapes get a
 * substring swap of the `<owner>/<name>` slug. The companion CI
 * workflow uses `${{ github.repository }}` which GitHub resolves to the
 * new slug post-rename, so we don't need to edit that file.
 */
function rewriteDockerCompose(path: string, oldSlug: string, newSlug: string): FileOp | null {
  const before = readFileSync(path, "utf8");
  if (!before.includes(`ghcr.io/${oldSlug}`)) return null;
  const count = before.split(`ghcr.io/${oldSlug}`).length - 1;
  const after = before.split(`ghcr.io/${oldSlug}`).join(`ghcr.io/${newSlug}`);
  return {
    label: basename(path),
    verb: "wrote",
    newPath: path,
    after,
    changes: [`${count}× ghcr.io image ref(s): ${oldSlug} → ${newSlug}`],
  };
}

// ---------------------------------------------------------------------------
// Remote operations — best-effort, used only when --gh / --coolify / --keys
// / --ci flags are set.
// ---------------------------------------------------------------------------

async function readGitRemote(cwd: string): Promise<string | null> {
  const res = await exec("git", ["remote", "get-url", "origin"], { cwd, silent: true });
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}

function rewriteRemoteUrl(url: string, newSlug: string): string {
  const ssh = url.match(/^(git@github\.com:)([^/]+)\/([^/]+?)(\.git)?$/);
  if (ssh) {
    const suffix = ssh[4] ?? "";
    return `${ssh[1]}${newSlug}${suffix}`;
  }
  const https = url.match(/^(https?:\/\/github\.com\/)([^/]+)\/([^/]+?)(\.git)?(?:\/.*)?$/);
  if (https) {
    const suffix = https[4] ?? "";
    return `${https[1]}${newSlug}${suffix}`;
  }
  return url;
}

async function setGitRemote(cwd: string, url: string): Promise<void> {
  const res = await exec("git", ["remote", "set-url", "origin", url], { cwd, silent: true });
  if (res.exitCode !== 0) {
    console.log(chalk.yellow(`  ! git remote set-url failed: ${res.stderr.trim()}`));
  }
}

/** Rename the GitHub repo via `gh repo rename`. Returns true on success.
 *  Non-fatal on failure — the local edits already landed and the user
 *  can re-run the gh command from the checklist. */
async function renameGithubRepo(cwd: string, oldSlug: string, newName: string): Promise<boolean> {
  console.log(chalk.dim(`  · gh repo rename ${newName} --repo ${oldSlug} --yes`));
  const res = await exec("gh", ["repo", "rename", newName, "--repo", oldSlug, "--yes"], {
    cwd,
    silent: true,
  });
  if (res.exitCode === 0) {
    console.log(chalk.green(`  ✓ renamed GitHub repo to ${newName}`));
    return true;
  }
  const msg = `${res.stderr}\n${res.stdout}`.trim();
  if (/already exists/i.test(msg)) {
    console.log(chalk.yellow(`  ! GitHub repo already named ${newName} — treating as done`));
    return true;
  }
  console.log(chalk.yellow(`  ! gh repo rename failed: ${msg.split("\n")[0]}`));
  console.log(chalk.dim(`    Run manually: gh repo rename ${newName} --repo ${oldSlug} --yes`));
  return false;
}

/** PATCH the Coolify project's name. Coolify apps are NOT renamed —
 *  the API has no endpoint for `applications/{uuid}.name`. App lookups
 *  are uuid-keyed so deploys keep working; only the dashboard display
 *  is stale. */
async function renameCoolifyProject(oldName: string, newName: string): Promise<boolean> {
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    console.log(chalk.dim("  · Coolify not configured — skipping project rename"));
    return false;
  }
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  let project: { uuid: string; name: string } | null = null;
  try {
    project = await api.findProjectByName(oldName);
  } catch (err) {
    console.log(chalk.yellow(`  ! Coolify lookup failed: ${(err as Error).message}`));
    return false;
  }
  if (!project) {
    console.log(chalk.dim(`  · no Coolify project named ${oldName} — skipping`));
    return false;
  }
  try {
    await api.updateProject(project.uuid, { name: newName });
    console.log(chalk.green(`  ✓ renamed Coolify project ${oldName} → ${newName}`));
    return true;
  } catch (err) {
    console.log(chalk.yellow(`  ! Coolify rename failed: ${(err as Error).message}`));
    console.log(chalk.dim(`    Rename via the dashboard: ${cfg.url}/project/${project.uuid}`));
    return false;
  }
}

async function triggerCiWorkflow(cwd: string): Promise<void> {
  const res = await exec("gh", ["workflow", "run", "build-and-deploy.yml"], { cwd, silent: true });
  if (res.exitCode === 0) {
    console.log(chalk.green("  ✓ dispatched build-and-deploy.yml"));
    console.log(chalk.dim("    Track: gh run watch"));
  } else {
    console.log(chalk.yellow(`  ! workflow dispatch failed: ${res.stderr.trim().split("\n")[0]}`));
    console.log(chalk.dim("    Run manually: gh workflow run build-and-deploy.yml"));
  }
}

/** Locate provisioned env block files under `<config-dir>/provisioned/`
 *  whose basename starts with `<oldName>.` so they can be renamed in
 *  the same operation as the manifest. Caller does the actual move. */
function planProvisionedEnvRenames(
  oldName: string,
  newName: string,
): Array<{ from: string; to: string; label: string }> {
  const dir = join(dirname(getConfigPath()), "provisioned");
  if (!existsSync(dir)) return [];
  const out: Array<{ from: string; to: string; label: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(`${oldName}.`)) continue;
    const rest = entry.slice(oldName.length);
    out.push({
      from: join(dir, entry),
      to: join(dir, `${newName}${rest}`),
      label: `provisioned/${entry}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path lookup helpers (mirrors rename-domain.ts)
// ---------------------------------------------------------------------------

function findTfvars(monorepoRoot: string, manifest: ProjectManifest, name: string): string | null {
  const candidates =
    manifest.deployTarget === "existing"
      ? [
          join(
            monorepoRoot,
            "infra",
            "terraform",
            "stacks",
            "dns-only-cloudflare",
            `${name}.tfvars`,
          ),
          join(monorepoRoot, "infra", "terraform", "stacks", "dns-only-inwx", `${name}.tfvars`),
        ]
      : [join(monorepoRoot, "infra", "terraform", "stacks", "node-realtime", `${name}.tfvars`)];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function findStacksEnv(monorepoRoot: string, name: string): string | null {
  const candidates = [
    join(monorepoRoot, "infra", "stacks", `${name}.env`),
    join(monorepoRoot, "stacks", `${name}.env`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Follow-up checklist
// ---------------------------------------------------------------------------

interface ChecklistContext {
  oldSlug?: string;
  newSlug?: string;
  executedGh: boolean;
  executedCoolify: boolean;
  executedKeys: boolean;
}

function printChecklist(
  manifest: ProjectManifest,
  oldName: string,
  newName: string,
  ctx: ChecklistContext,
): void {
  console.log(chalk.bold("\n  ── Follow-up (hatchkit won't do these for you) ────────────\n"));

  console.log(chalk.bold("  1. GitHub repo"));
  if (ctx.executedGh) {
    console.log(chalk.dim(`     ✓ repo renamed to ${ctx.newSlug ?? newName} via --gh.`));
    if (ctx.oldSlug) {
      console.log(
        chalk.dim(
          `     Old GHCR images at ghcr.io/${ctx.oldSlug}-* stay in the registry (intentional, easy rollback).`,
        ),
      );
      const oldRepoName = ctx.oldSlug.split("/")[1];
      console.log(
        chalk.dim(
          `     To delete them: gh api -X DELETE /user/packages/container/${oldRepoName}-server`,
        ),
      );
      console.log(
        chalk.dim(
          `                     gh api -X DELETE /user/packages/container/${oldRepoName}-client`,
        ),
      );
    }
  } else {
    console.log(
      chalk.dim(`     gh repo rename ${newName}     ${chalk.dim("# or re-run with --gh")}`),
    );
    console.log(
      chalk.dim(
        `     (Renames the remote and updates the local origin URL — non-destructive but visible.)`,
      ),
    );
  }

  console.log(chalk.bold("\n  2. Coolify project + app"));
  if (ctx.executedCoolify) {
    console.log(chalk.dim(`     ✓ Coolify project renamed via --coolify.`));
    console.log(
      chalk.dim(
        `     Applications still named ${oldName}-server, ${oldName}-client etc. — the Coolify API has`,
      ),
    );
    console.log(
      chalk.dim(`     no rename endpoint for applications. Cosmetic only; deploys still work.`),
    );
    console.log(
      chalk.dim(`     To recreate apps under the new name (downtime): destroy + adopt --resume.`),
    );
  } else {
    console.log(`     In the Coolify dashboard (or via API):`);
    console.log(chalk.dim(`       - Rename project "${oldName}" → "${newName}"`));
    console.log(chalk.dim(`       - Rename application "${oldName}" → "${newName}"`));
    console.log(chalk.dim(`     Then redeploy so the container Name labels refresh.`));
    console.log(chalk.dim(`     Or re-run with --coolify to PATCH the project automatically.`));
  }

  if (manifest.s3Buckets?.assets?.name) {
    console.log(chalk.bold("\n  3. Cloudflare R2 buckets"));
    console.log(
      chalk.yellow(
        `     R2 has no rename. To move ${chalk.cyan(`${oldName}-assets`)} → ${chalk.cyan(`${newName}-assets`)}:`,
      ),
    );
    console.log(chalk.dim(`       a. Create new bucket: ${newName}-assets (same settings as old)`));
    console.log(
      chalk.dim(
        `       b. Copy objects: rclone copy r2-old:${oldName}-assets r2-new:${newName}-assets`,
      ),
    );
    console.log(
      chalk.dim(`       c. Update .hatchkit.json s3Buckets.assets.name to the new bucket`),
    );
    console.log(chalk.dim(`       d. Re-run hatchkit provision s3 to remint CORS / token scope`));
    console.log(chalk.dim(`       e. Delete the old bucket once traffic confirms`));
    if (manifest.s3Buckets?.state?.name) {
      console.log(
        chalk.dim(`     Same drill for the state bucket (${oldName}-state → ${newName}-state).`),
      );
    }
  } else {
    console.log(chalk.bold("\n  3. Cloudflare R2 buckets"));
    console.log(chalk.dim(`     (none provisioned — skip)`));
  }

  console.log(chalk.bold("\n  4. dotenvx Keychain entry"));
  if (ctx.executedKeys) {
    console.log(
      chalk.dim(
        `     ✓ per-project keychain entries re-keyed to ${newName} via --keys (dotenvx / s3 / openpanel / plausible / stripe).`,
      ),
    );
  } else {
    console.log(chalk.dim(`     The keychain account "hatchkit:${oldName}" still holds the key.`));
    console.log(
      chalk.dim(`       hatchkit keys show ${oldName}      ${chalk.dim("# capture old key")}`),
    );
    console.log(chalk.dim(`       hatchkit keys set ${newName} --key <copied-key>`));
    console.log(
      chalk.dim(`       security delete-generic-password -s hatchkit -a hatchkit:${oldName}`),
    );
    console.log(chalk.dim(`     Or re-run with --keys to migrate every per-project entry.`));
  }

  console.log(chalk.bold("\n  5. Provider clients (if provisioned via hatchkit add)"));
  console.log(chalk.dim(`     No CLI rename available — rename in each dashboard:`));
  console.log(chalk.dim(`       - GlitchTip project slug (if used)`));
  console.log(chalk.dim(`       - OpenPanel project slug (if used)`));
  console.log(chalk.dim(`       - Plausible site name (rarely matters — keyed by domain)`));
  console.log(
    chalk.dim(
      `       - Listmonk: rename per-project lists ${oldName} / ${oldName}-test to ${newName} / ${newName}-test (if used)`,
    ),
  );

  if (manifest.localDev?.slug) {
    console.log(chalk.bold("\n  6. Local-dev (Tailscale + Caddy)"));
    console.log(
      chalk.dim(`     Caddy fragment: ~/.config/dev/projects/${manifest.localDev.slug}.caddy`),
    );
    console.log(
      chalk.dim(
        `       hatchkit dev-setup disable       ${chalk.dim("# (in project dir, old name)")}`,
      ),
    );
    console.log(
      chalk.dim(
        `       hatchkit dev-setup enable        ${chalk.dim("# (after rename, picks up new slug)")}`,
      ),
    );
  }

  console.log(chalk.bold("\n  7. App code"));
  console.log(
    chalk.dim(
      `     grep -rni "${oldName}" . — there may be README badges, CI workflows, or docs links left over.`,
    ),
  );

  console.log(chalk.bold("\n  8. Local dir"));
  console.log(
    chalk.dim(
      `     hatchkit didn't move the project directory itself — rename it if you want the path to match:\n         mv ../${oldName} ../${newName}`,
    ),
  );

  console.log();
}

// Re-export internals for tests.
export const _internals = {
  rewriteManifest,
  rewritePackageJson,
  rewriteStarterNamedFile,
  rewriteReadme,
  planTfvarsRename,
  planStacksEnvRename,
  planLedgerRename,
};

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

export async function runRenameProjectCli(args: string[], monorepoRoot: string): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flagValue = (name: string): string | undefined => {
    const i = args.findIndex((a) => a === `--${name}`);
    if (i >= 0 && args[i + 1]) return args[i + 1];
    return undefined;
  };

  const newName = flagValue("to") ?? positional[0];
  const dirArg = flagValue("dir");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const all = args.includes("--all");
  const gh = all || args.includes("--gh");
  const coolify = all || args.includes("--coolify");
  const keys = all || args.includes("--keys");
  const ci = all || args.includes("--ci");

  const projectDir = dirArg ? resolve(dirArg) : resolve(".");
  await runRenameProject({
    projectDir,
    monorepoRoot,
    newName,
    dryRun,
    yes,
    gh,
    coolify,
    keys,
    ci,
  });
}
