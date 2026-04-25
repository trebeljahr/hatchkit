/*
 * rename-domain — move a scaffolded project from one domain to another.
 *
 * Rewrites every file hatchkit owns that hard-codes the old domain:
 *
 *   <project>/.hatchkit.json                — manifest `domain` field
 *   <infra>/terraform/stacks/<stack>/<name>.tfvars
 *                                           — `domain` + remapped
 *                                             `subdomains` keys
 *   <infra>/stacks/<name>.env (Coolify env) — APP_DOMAIN + any other
 *                                             line containing the old
 *                                             full-domain string
 *
 * Intentionally does NOT run `terraform apply` or touch Coolify's live
 * app state. Those are destructive, out-of-band operations the user
 * should review the planned diff for first. A detailed follow-up
 * checklist is printed at the end covering:
 *   - terraform apply (destroys old records, creates new in new zone)
 *   - the Coolify app's FQDN + env (update in dashboard or via API)
 *   - gh-pages CNAME (if applicable)
 *   - OAuth redirect URIs at Google / GitHub / Stripe / Resend
 *   - any hardcoded URLs in the app's own code
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { parseDomain, validateDomain } from "../utils/validate.js";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface RenameDomainOptions {
  /** Directory of the scaffolded project. Manifest must exist here. */
  projectDir: string;
  /** Monorepo root — `infra/` + `stacks/` live under this. */
  monorepoRoot: string;
  /** Target domain. If omitted, the user is prompted. */
  newDomain?: string;
  /** Show the plan, don't write. */
  dryRun?: boolean;
  /** Skip the final confirmation prompt. */
  yes?: boolean;
}

export async function runRenameDomain(opts: RenameDomainOptions): Promise<void> {
  const { projectDir, monorepoRoot } = opts;

  // 1. Manifest
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json found in ${projectDir}. Run rename-domain from the project root (or pass --dir).`,
    );
  }
  const oldDomain = manifest.domain;

  // 2. Target domain
  const newDomain =
    opts.newDomain ??
    (await input({
      message: `New domain for ${chalk.cyan(manifest.name)} (was ${chalk.dim(oldDomain)}):`,
      validate: validateDomain,
    }));
  const newValid = validateDomain(newDomain);
  if (newValid !== true) throw new Error(`--to invalid: ${newValid}`);
  if (newDomain === oldDomain) {
    console.log(chalk.yellow(`  ${oldDomain} is already the current domain — nothing to do.`));
    return;
  }

  const { baseDomain: oldBase, subdomain: oldSub } = parseDomain(oldDomain);
  const { baseDomain: newBase, subdomain: newSub } = parseDomain(newDomain);

  console.log(chalk.bold("\n  ── hatchkit rename-domain ─────────────────────────────────\n"));
  console.log(`  Project:    ${chalk.cyan(manifest.name)}`);
  console.log(`  From → To:  ${chalk.dim(oldDomain)} → ${chalk.green(newDomain)}`);
  if (!newSub) {
    console.log(
      chalk.yellow(
        `  Note: ${newDomain} has no subdomain prefix. Apex DNS records are required — verify your terraform module supports them before applying.`,
      ),
    );
  }

  // 3. Collect edit plan
  const edits: FileEdit[] = [];

  // 3a. Manifest — just swap the `domain` field.
  const manifestPath = join(projectDir, ".hatchkit.json");
  edits.push(rewriteManifest(manifestPath, manifest, newDomain));

  // 3b. Terraform tfvars — same dispatch logic as deploy/terraform.ts.
  //     For existing-server deploys the dns-only stack is split per
  //     provider (dns-only-cloudflare / dns-only-inwx); we don't have
  //     the user's current DNS provider in the manifest, so try both
  //     known locations and rewrite whichever exists. Manual DNS leaves
  //     no tfvars to rewrite.
  const candidatePaths =
    manifest.deployTarget === "existing"
      ? [
          join(
            monorepoRoot,
            "infra",
            "terraform",
            "stacks",
            "dns-only-cloudflare",
            `${manifest.name}.tfvars`,
          ),
          join(
            monorepoRoot,
            "infra",
            "terraform",
            "stacks",
            "dns-only-inwx",
            `${manifest.name}.tfvars`,
          ),
        ]
      : [
          join(
            monorepoRoot,
            "infra",
            "terraform",
            "stacks",
            "node-realtime",
            `${manifest.name}.tfvars`,
          ),
        ];
  const tfvarsPath = candidatePaths.find((p) => existsSync(p));
  if (tfvarsPath) {
    edits.push(rewriteTfvars(tfvarsPath, oldDomain, newDomain, oldSub, newSub, newBase, oldBase));
  } else {
    console.log(
      chalk.yellow(
        `  ! No tfvars found under ${candidatePaths
          .map((p) => p.slice(monorepoRoot.length + 1))
          .join(" or ")} — skipping terraform bit.`,
      ),
    );
  }

  // 3c. Coolify stack env — at `<infra>/stacks/<name>.env` or
  //     `<monorepo>/stacks/<name>.env`. Match infra.ts's write path.
  const stacksPath = findStacksEnv(monorepoRoot, manifest.name);
  if (stacksPath) {
    edits.push(rewriteStacksEnv(stacksPath, oldDomain, newDomain, oldBase, newBase));
  } else {
    console.log(
      chalk.yellow(
        `  ! No stacks/${manifest.name}.env found — skipping Coolify env bit. (You may need to set APP_DOMAIN manually in the Coolify dashboard.)`,
      ),
    );
  }

  // 4. Plan
  console.log(chalk.bold("\n  ── Planned file changes ───────────────────────────────────\n"));
  for (const edit of edits) {
    console.log(`  ${chalk.cyan(edit.label)}`);
    for (const change of edit.changes) {
      console.log(chalk.dim(`    - ${change}`));
    }
  }

  // Derive the stack-dir slug for the follow-up checklist from whichever
  // tfvars we matched. Falls back to a sensible default if none matched.
  const stackDirName = tfvarsPath
    ? basename(tfvarsPath.slice(0, -`/${manifest.name}.tfvars`.length))
    : manifest.deployTarget === "existing"
      ? "dns-only-cloudflare"
      : "node-realtime";

  if (opts.dryRun) {
    console.log(chalk.yellow("\n  [dry-run] No files written."));
    printChecklist(manifest, oldDomain, newDomain, stackDirName);
    return;
  }

  // 5. Confirm
  if (!opts.yes) {
    const ok = await confirm({
      message: `Rewrite ${edits.length} file(s)?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }
  }

  // 6. Apply
  for (const edit of edits) {
    writeFileSync(edit.path, edit.after);
    console.log(chalk.green(`  ✓ wrote ${edit.label}`));
  }

  printChecklist(manifest, oldDomain, newDomain, stackDirName);
}

// ---------------------------------------------------------------------------
// File editors
// ---------------------------------------------------------------------------

interface FileEdit {
  label: string;
  path: string;
  after: string;
  changes: string[];
}

function rewriteManifest(path: string, m: ProjectManifest, newDomain: string): FileEdit {
  const next = { ...m, domain: newDomain };
  return {
    label: basename(path),
    path,
    after: `${JSON.stringify(next, null, 2)}\n`,
    changes: [`domain: "${m.domain}" → "${newDomain}"`],
  };
}

/**
 * Edit the tfvars file. Two surgical changes + a remap of subdomain keys.
 *
 * The tfvars file was generated from a template, so the format is
 * predictable. Matching `domain = "..."` and the opening of the
 * `subdomains = { ... }` block with regex is safer than a full parser
 * for this narrow use.
 */
function rewriteTfvars(
  path: string,
  oldDomain: string,
  newDomain: string,
  oldSub: string,
  newSub: string,
  newBase: string,
  oldBase: string,
): FileEdit {
  const before = readFileSync(path, "utf8");
  let after = before;
  const changes: string[] = [];

  // domain = "OLD"  →  domain = "NEWBASE"
  const domainRe = /(\bdomain\s*=\s*")([^"]+)(")/;
  if (domainRe.test(after)) {
    after = after.replace(domainRe, (_m, pre, _val, post) => `${pre}${newBase}${post}`);
    changes.push(`domain: "${oldBase}" → "${newBase}"`);
  }

  // subdomains map remapping. Old key "OLDSUB" or "api.OLDSUB" maps to
  // the new subdomain prefix. Keys that don't involve the old subdomain
  // (e.g. "admin") pass through untouched.
  const keyRemap: Record<string, string> = {
    [oldSub]: newSub || "@",
    [`api.${oldSub}`]: newSub ? `api.${newSub}` : "api",
  };

  // Match `"KEY" = "VALUE"` lines inside the subdomains block.
  const entryRe = /"([^"]+)"\s*=\s*"([^"]+)"/g;
  after = after.replace(entryRe, (full, key, val) => {
    // Only remap keys we know about — leave anything else alone.
    if (keyRemap[key] !== undefined) {
      const newKey = keyRemap[key];
      if (newKey !== key) {
        changes.push(`subdomains key "${key}" → "${newKey}"`);
        return `"${newKey}" = "${val}"`;
      }
    }
    return full;
  });

  // Belt and braces: any lingering mention of the old full domain in a
  // comment line gets swapped for clarity. Safe because tfvars doesn't
  // use the old domain as a string value anywhere else.
  if (after.includes(oldDomain)) {
    const count = after.split(oldDomain).length - 1;
    after = after.split(oldDomain).join(newDomain);
    changes.push(`${count} stray "${oldDomain}" → "${newDomain}"`);
  }

  return {
    label: path.split("/").slice(-4).join("/"),
    path,
    after,
    changes: changes.length > 0 ? changes : ["(no changes detected)"],
  };
}

/**
 * Edit the Coolify stack env file. This is a plain KEY="VALUE" block,
 * not a strict format — do line-by-line substitution so we don't clobber
 * unrelated lines and keep the diff obvious.
 *
 * Swaps:
 *   - APP_DOMAIN="OLD" → "NEW"
 *   - Any other line whose value contains the old full domain gets the
 *     old-full-domain → new-full-domain swap (catches FRONTEND_URL,
 *     BETTER_AUTH_URL, TRUSTED_ORIGINS, etc).
 *   - Lines with the old base domain (but not the old full domain) are
 *     left alone — those usually refer to someone else's URL.
 *
 * COOLIFY_URL is explicitly skipped — that's the Coolify dashboard URL,
 * not the project's public domain.
 */
function rewriteStacksEnv(
  path: string,
  oldDomain: string,
  newDomain: string,
  _oldBase: string,
  _newBase: string,
): FileEdit {
  const before = readFileSync(path, "utf8");
  const lines = before.split("\n");
  const changes: string[] = [];

  const next = lines.map((line) => {
    // Skip comments, blanks, and Coolify's own dashboard URL.
    if (line.trim().startsWith("#") || line.trim() === "") return line;
    if (line.startsWith("COOLIFY_URL")) return line;

    if (line.includes(oldDomain)) {
      const replaced = line.split(oldDomain).join(newDomain);
      const key = line.split("=")[0];
      changes.push(`${key}: swapped "${oldDomain}" → "${newDomain}"`);
      return replaced;
    }
    return line;
  });

  return {
    label: path.split("/").slice(-2).join("/"),
    path,
    after: next.join("\n"),
    changes: changes.length > 0 ? changes : ["(no changes detected)"],
  };
}

/**
 * Locate the stacks/<name>.env file. During scaffold it's written
 * under `infra/stacks/` (the infra submodule). Some layouts put it
 * under `<monorepo>/stacks/` instead — check both.
 */
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

function printChecklist(
  manifest: ProjectManifest,
  oldDomain: string,
  newDomain: string,
  stackDirName: string,
): void {
  const { baseDomain: newBase } = parseDomain(newDomain);
  console.log(chalk.bold("\n  ── Follow-up (hatchkit won't do these for you) ────────────\n"));

  console.log(chalk.bold("  1. DNS prerequisites"));
  console.log(`     Ensure the new zone ${chalk.cyan(newBase)} exists at your DNS provider.`);
  console.log(
    chalk.dim("     For Cloudflare: add the zone in the CF dashboard (or via API), then"),
  );
  console.log(chalk.dim("     `hatchkit dns link-to-cloudflare` to flip INWX NS if relevant."));

  console.log(chalk.bold("\n  2. Terraform"));
  console.log(chalk.dim(`     cd infra/terraform/stacks/${stackDirName}`));
  console.log(chalk.dim(`     terraform plan -var-file=${manifest.name}.tfvars`));
  console.log(chalk.dim(`     terraform apply -var-file=${manifest.name}.tfvars`));
  console.log(
    chalk.dim(`     (Destroys old records at ${oldDomain}, creates new ones at ${newDomain}.)`),
  );

  console.log(chalk.bold("\n  3. Coolify app"));
  console.log(
    `     Update the FQDN on the ${chalk.cyan(manifest.name)} app (Coolify dashboard → General),`,
  );
  console.log(
    `     and confirm env vars like ${chalk.dim("FRONTEND_URL / BETTER_AUTH_URL / TRUSTED_ORIGINS")}`,
  );
  console.log(`     moved across. Redeploy after updating — new TLS cert takes 1-3 min.`);

  if (manifest.features.includes("stripe")) {
    console.log(chalk.bold("\n  4. External integrations"));
    console.log(`     Update webhook URLs:`);
    console.log(chalk.dim(`       - Stripe dashboard → Developers → Webhooks (new URL)`));
    console.log(chalk.dim(`       - Any OAuth redirect URIs (Google, GitHub, Discord…)`));
  } else {
    console.log(chalk.bold("\n  4. External integrations"));
    console.log(chalk.dim(`     Any OAuth redirect URIs (Google, GitHub, Discord…)`));
  }

  console.log(chalk.bold("\n  5. App code"));
  console.log(
    chalk.dim(
      `     grep -r "${oldDomain}" . and update any hardcoded references (README, OG tags, sitemap).`,
    ),
  );

  console.log();
}

// Re-export for testability.
export const _internals = {
  rewriteTfvars,
  rewriteStacksEnv,
  rewriteManifest,
};

// ---------------------------------------------------------------------------
// CLI glue — thin wrapper the dispatcher calls.
// ---------------------------------------------------------------------------

export async function runRenameDomainCli(args: string[], monorepoRoot: string): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flagValue = (name: string): string | undefined => {
    const i = args.findIndex((a) => a === `--${name}`);
    if (i >= 0 && args[i + 1]) return args[i + 1];
    return undefined;
  };

  const newDomain = flagValue("to") ?? positional[0];
  const dirArg = flagValue("dir");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");

  const projectDir = dirArg ? resolve(dirArg) : resolve(".");
  await runRenameDomain({ projectDir, monorepoRoot, newDomain, dryRun, yes });
}
