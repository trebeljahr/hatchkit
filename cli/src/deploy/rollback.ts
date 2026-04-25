/*
 * Rollback — print a tailored cleanup recipe for a partial `hatchkit
 * create` and (optionally) execute it.
 *
 * Two entry points:
 *   - `handleCreateFailure(ledger, err)` — called from the create-flow
 *     try/catch. Prints the error, the recipe, and a 3-way prompt:
 *     roll back now / show recipe again / leave it. Destructive steps
 *     (rm -rf appDir, github repo delete, terraform destroy) get a
 *     per-step confirmation before they run, so a single 'y' at the
 *     top doesn't unleash a cascade of irreversible operations.
 *   - `runRollback(ledger, opts)` — used by `hatchkit destroy` for the
 *     same execution path, with `--yes` to skip per-step prompts.
 *
 * Steps undo in reverse order. Failures within an undo are logged but
 * don't abort the rest of the rollback — we want to claw back as much
 * state as we can and surface what's left.
 */
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import { getCoolifyConfig, getDnsConfig } from "../config.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { type LedgerStep, RunLedger } from "../utils/run-ledger.js";
import { deleteSecret } from "../utils/secrets.js";

interface RollbackOptions {
  /** Skip per-step confirmation prompts on destructive operations. */
  yes?: boolean;
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Failure handler — called from the create-flow try/catch              */
/* ─────────────────────────────────────────────────────────────────────── */

export async function handleCreateFailure(ledger: RunLedger, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.log(chalk.bold.red(`\n  ✗ hatchkit create failed: ${message}`));

  if (ledger.steps.length === 0) {
    console.log(chalk.dim("  No steps completed before failure — nothing to clean up.\n"));
    ledger.delete();
    return;
  }

  console.log(
    chalk.dim(
      `  Completed ${ledger.steps.length} step${ledger.steps.length === 1 ? "" : "s"} before failing. ` +
        `Ledger: ${ledger.path}\n`,
    ),
  );
  printRecipe(ledger);

  // Loop the prompt so "show recipe" doesn't drop the user back into
  // an unreviewed default.
  for (;;) {
    const choice = await select<"rollback" | "recipe" | "leave">({
      message: "How would you like to handle the partial state?",
      choices: [
        { name: "Roll back now (with confirmation per destructive step)", value: "rollback" },
        { name: "Show the recipe again", value: "recipe" },
        { name: "Leave it — I'll clean up later", value: "leave" },
      ],
      default: "leave",
    });
    if (choice === "recipe") {
      printRecipe(ledger);
      continue;
    }
    if (choice === "leave") {
      console.log(
        chalk.dim(
          `\n  Ledger preserved at ${ledger.path}. Run \`hatchkit destroy ${ledger.name}\` later to undo.\n`,
        ),
      );
      return;
    }
    await runRollback(ledger, { yes: false });
    return;
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Recipe printer — copy-pasteable bash commands                        */
/* ─────────────────────────────────────────────────────────────────────── */

export function printRecipe(ledger: RunLedger): void {
  console.log(chalk.bold("  ── Cleanup recipe ──────────────────────────────────────────\n"));
  console.log(chalk.dim("  Run these in order to manually undo the partial create:\n"));

  // Reverse order: undo the latest step first.
  const lines: string[] = [];
  for (const step of [...ledger.steps].reverse()) {
    const cmd = recipeFor(step);
    if (cmd) lines.push(cmd);
  }
  for (const line of lines) {
    console.log(`    ${line}`);
  }
  console.log();
}

function recipeFor(step: LedgerStep): string | null {
  switch (step.kind) {
    case "mlService":
      return chalk.dim(`# manual: delete ${step.name} from your ${step.platform} dashboard`);
    case "coolifyDb":
      return chalk.dim(`# manual: delete database ${step.uuid} from the Coolify dashboard`);
    case "coolifyApp":
      return chalk.dim(`# manual: delete application ${step.uuid} from the Coolify dashboard`);
    case "terraformApplied":
      return `cd ${shellEscape(step.stackDir)} && terraform destroy -var-file=${shellEscape(step.tfvarsPath)}`;
    case "coolifyEnv":
      return `rm ${shellEscape(step.path)}`;
    case "tfvars":
      return `rm ${shellEscape(step.path)}`;
    case "glitchtip":
      return `hatchkit remove ${shellEscape(step.project)} glitchtip --yes`;
    case "github":
      return `gh repo delete ${shellEscape(step.repo)} --yes`;
    case "scaffold":
      return `rm -rf ${shellEscape(step.path)}`;
    case "keychain":
      return `security delete-generic-password -s hatchkit -a ${shellEscape(step.account)}`;
  }
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Executor — reverse-order undo                                        */
/* ─────────────────────────────────────────────────────────────────────── */

export async function runRollback(ledger: RunLedger, opts: RollbackOptions = {}): Promise<void> {
  console.log(chalk.bold("\n  ── Rolling back ────────────────────────────────────────────\n"));

  let undone = 0;
  let skipped = 0;
  let failed = 0;
  const remaining: LedgerStep[] = [];

  for (const step of [...ledger.steps].reverse()) {
    const label = describeStep(step);

    // Per-step confirmation for the irreversible ones unless --yes.
    if (!opts.yes && isDestructive(step)) {
      const ok = await confirm({
        message: `${chalk.red("Destructive:")} ${label}. Proceed?`,
        default: false,
      });
      if (!ok) {
        console.log(chalk.dim(`    skipped: ${label}`));
        skipped += 1;
        remaining.push(step);
        continue;
      }
    }

    process.stdout.write(`  ${label} … `);
    try {
      const result = await undoStep(step);
      if (result === "skipped") {
        console.log(chalk.dim("skipped"));
        skipped += 1;
        remaining.push(step);
      } else if (result === "not-found") {
        console.log(chalk.dim("already gone"));
        undone += 1;
      } else {
        console.log(chalk.green("✓"));
        undone += 1;
      }
    } catch (err) {
      console.log(chalk.red(`✗ ${(err as Error).message}`));
      failed += 1;
      remaining.push(step);
    }
  }

  console.log(chalk.bold("\n  ── Rollback summary ────────────────────────────────────────\n"));
  console.log(`  Undone:    ${chalk.green(undone)}`);
  console.log(`  Skipped:   ${chalk.dim(skipped)}`);
  console.log(`  Failed:    ${failed > 0 ? chalk.red(failed) : chalk.dim(failed)}`);

  if (remaining.length === 0) {
    ledger.delete();
    console.log(chalk.dim(`\n  Ledger removed.\n`));
  } else {
    // Replace the ledger with what's left so the next `hatchkit destroy`
    // run picks up where we paused.
    rewriteRemaining(ledger, remaining);
    console.log(
      chalk.yellow(
        `\n  ${remaining.length} step(s) still pending. Re-run \`hatchkit destroy ${ledger.name}\` to retry.\n`,
      ),
    );
  }
}

/** Rewrite the on-disk ledger to keep only the steps that weren't
 *  undone (because they failed or the user skipped them). Done by
 *  calling `start` to clobber the file, then re-recording each
 *  remaining step in original (forward) order. */
function rewriteRemaining(ledger: RunLedger, remaining: LedgerStep[]): void {
  // Steps were processed in reverse; remaining is in reverse too.
  // Restore original order so a future rollback walks them correctly.
  const fresh = RunLedger.start(ledger.name);
  for (const step of [...remaining].reverse()) {
    fresh.record(step);
  }
}

function isDestructive(step: LedgerStep): boolean {
  return (
    step.kind === "scaffold" ||
    step.kind === "github" ||
    step.kind === "terraformApplied" ||
    step.kind === "coolifyApp" ||
    step.kind === "coolifyDb"
  );
}

function describeStep(step: LedgerStep): string {
  switch (step.kind) {
    case "scaffold":
      return `delete local repo ${chalk.cyan(step.path)}`;
    case "github":
      return `delete GitHub repo ${chalk.cyan(step.repo)}`;
    case "glitchtip":
      return `delete GlitchTip project ${chalk.cyan(step.project)}`;
    case "tfvars":
      return `remove ${chalk.cyan(step.path)}`;
    case "coolifyEnv":
      return `remove ${chalk.cyan(step.path)}`;
    case "keychain":
      return `delete keychain entry ${chalk.cyan(step.account)}`;
    case "terraformApplied":
      return `terraform destroy in ${chalk.cyan(step.stackDir)}`;
    case "coolifyApp":
      return `delete Coolify app ${chalk.cyan(step.uuid)}`;
    case "coolifyDb":
      return `delete Coolify db ${chalk.cyan(step.uuid)}`;
    case "mlService":
      return `${chalk.cyan(step.platform)} ML service ${chalk.cyan(step.name)}`;
  }
}

async function undoStep(step: LedgerStep): Promise<"done" | "skipped" | "not-found"> {
  switch (step.kind) {
    case "scaffold": {
      if (!existsSync(step.path)) return "not-found";
      rmSync(step.path, { recursive: true, force: true });
      return "done";
    }
    case "github": {
      const res = await exec("gh", ["repo", "delete", step.repo, "--yes"], { silent: true });
      if (res.exitCode !== 0) {
        // Already gone, or the user lacks delete:repo scope.
        if (/not found|404/i.test(res.stderr ?? "")) return "not-found";
        throw new Error(`gh repo delete failed: ${res.stderr || res.stdout}`);
      }
      return "done";
    }
    case "glitchtip": {
      const { deleteGlitchtipClient } = await import("../provision/glitchtip.js");
      const result = await deleteGlitchtipClient(step.project);
      return result === "not-found" ? "not-found" : "done";
    }
    case "tfvars":
    case "coolifyEnv": {
      if (!existsSync(step.path)) return "not-found";
      unlinkSync(step.path);
      return "done";
    }
    case "keychain": {
      const ok = await deleteSecret(step.account);
      return ok ? "done" : "not-found";
    }
    case "terraformApplied": {
      // We need the same env vars `runTerraform` used. Re-derive from
      // the user's saved DNS config; if creds aren't there anymore,
      // the destroy won't work and we say so.
      const dns = await getDnsConfig();
      const env: Record<string, string> = {};
      if (dns?.provider === "cloudflare" && dns.apiToken) {
        env.TF_VAR_cloudflare_api_token = dns.apiToken;
      } else if (dns?.provider === "inwx" && dns.username && dns.password) {
        env.TF_VAR_inwx_username = dns.username;
        env.TF_VAR_inwx_password = dns.password;
      } else {
        throw new Error("DNS credentials no longer in keychain — re-add them, then retry");
      }
      const res = await exec(
        "terraform",
        ["destroy", "-auto-approve", `-var-file=${step.tfvarsPath}`],
        { cwd: step.stackDir, env, silent: true },
      );
      if (res.exitCode !== 0) {
        throw new Error(`terraform destroy failed: ${res.stderr || res.stdout}`);
      }
      return "done";
    }
    case "coolifyApp": {
      const cfg = await getCoolifyConfig();
      if (!cfg) throw new Error("Coolify config no longer present");
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      const result = await api.deleteApplication(step.uuid);
      return result === "not-found" ? "not-found" : "done";
    }
    case "coolifyDb": {
      const cfg = await getCoolifyConfig();
      if (!cfg) throw new Error("Coolify config no longer present");
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      const result = await api.deleteDatabase(step.uuid);
      return result === "not-found" ? "not-found" : "done";
    }
    case "mlService":
      // Per-platform delete is platform-specific (Modal/RunPod/HF/Replicate).
      // Surface in the recipe but skip auto-undo for now.
      return "skipped";
  }
}
