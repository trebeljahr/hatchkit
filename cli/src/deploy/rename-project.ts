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
 * Intentionally does NOT touch provider-side state (Coolify, GitHub,
 * R2, GlitchTip, OpenPanel, Plausible, Resend, Tailscale, Keychain).
 * Those are destructive or visible-to-others operations the user should
 * drive themselves. A follow-up checklist is printed at the end.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { getLedgerPath } from "../utils/run-ledger.js";
import { validateProjectName } from "../utils/validate.js";

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
  /** Show the plan, don't write. */
  dryRun?: boolean;
  /** Skip the final confirmation prompt. */
  yes?: boolean;
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

  console.log(chalk.bold("\n  ── hatchkit rename-project ────────────────────────────────\n"));
  console.log(`  Domain:     ${chalk.dim(manifest.domain)}`);
  console.log(`  From → To:  ${chalk.dim(oldName)} → ${chalk.green(newName)}`);

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

  // 4. Plan
  console.log(chalk.bold("\n  ── Planned file changes ───────────────────────────────────\n"));
  for (const op of fileOps) {
    console.log(`  ${chalk.cyan(op.label)}`);
    for (const change of op.changes) {
      console.log(chalk.dim(`    - ${change}`));
    }
  }

  if (opts.dryRun) {
    console.log(chalk.yellow("\n  [dry-run] No files written."));
    printChecklist(manifest, oldName, newName);
    return;
  }

  // 5. Confirm
  if (!opts.yes) {
    const ok = await confirm({
      message: `Rewrite ${fileOps.length} file(s)?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }
  }

  // 6. Apply. For each op: write the new content to its target path,
  //    then if there's a separate `oldPath` (rename), unlink the old.
  //    Order: write new, verify, unlink old — atomic per file.
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

  printChecklist(manifest, oldName, newName);
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

function printChecklist(manifest: ProjectManifest, oldName: string, newName: string): void {
  console.log(chalk.bold("\n  ── Follow-up (hatchkit won't do these for you) ────────────\n"));

  console.log(chalk.bold("  1. GitHub repo"));
  console.log(chalk.dim(`     gh repo rename ${newName}`));
  console.log(
    chalk.dim(
      `     (Renames the remote and updates the local origin URL — non-destructive but visible.)`,
    ),
  );

  console.log(chalk.bold("\n  2. Coolify project + app"));
  console.log(`     In the Coolify dashboard (or via API):`);
  console.log(chalk.dim(`       - Rename project "${oldName}" → "${newName}"`));
  console.log(chalk.dim(`       - Rename application "${oldName}" → "${newName}"`));
  console.log(chalk.dim(`     Then redeploy so the container Name labels refresh.`));

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
  console.log(chalk.dim(`     The keychain account "hatchkit:${oldName}" still holds the key.`));
  console.log(
    chalk.dim(`       hatchkit keys show ${oldName}      ${chalk.dim("# capture old key")}`),
  );
  console.log(chalk.dim(`       hatchkit keys set ${newName} --key <copied-key>`));
  console.log(
    chalk.dim(`       security delete-generic-password -s hatchkit -a hatchkit:${oldName}`),
  );

  console.log(chalk.bold("\n  5. Provider clients (if provisioned via hatchkit add)"));
  console.log(chalk.dim(`     No CLI rename available — rename in each dashboard:`));
  console.log(chalk.dim(`       - GlitchTip project slug (if used)`));
  console.log(chalk.dim(`       - OpenPanel project slug (if used)`));
  console.log(chalk.dim(`       - Plausible site name (rarely matters — keyed by domain)`));
  console.log(
    chalk.dim(
      `       - Resend: revoke ${oldName}-dev/-prod API keys, mint ${newName}-dev/-prod (if used)`,
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

  const projectDir = dirArg ? resolve(dirArg) : resolve(".");
  await runRenameProject({ projectDir, monorepoRoot, newName, dryRun, yes });
}
