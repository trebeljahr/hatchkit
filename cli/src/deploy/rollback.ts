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
import { SECRET_KEYS, deleteSecret, getSecret } from "../utils/secrets.js";
import { ghSecretDelete } from "./gh-actions-secrets.js";

/** Pull the R2 admin token from the OS keychain. Used by rollback
 *  steps that need to talk to the R2 API (bucket/token destroy).
 *  Returns undefined when the user has wiped their keychain or never
 *  configured R2; callers surface that as a "re-add the token" error. */
async function getR2AdminToken(): Promise<string | undefined> {
  return (await getSecret(SECRET_KEYS.r2AdminToken)) ?? undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Poll `getter` until it throws a 404-shaped error, signalling the
 *  resource has actually been removed from Coolify's DB. Coolify's
 *  DELETE endpoints return 200 the moment the deletion is queued, but
 *  the Docker teardown + DB row cleanup completes asynchronously — a
 *  follow-up project delete races against the still-attached child
 *  resource and 422s with "Project has resources". Polling here closes
 *  that race.
 *
 *  10s ceiling at ~500ms cadence covers every cleanup I've observed
 *  on a healthy Coolify install; on a sick one the project-delete
 *  retry below has its own backoff. The `label` is only used for the
 *  diagnostic thrown on timeout. */
async function waitForResourceGone(
  getter: () => Promise<unknown>,
  label: string,
  timeoutMs = 10_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await getter();
    } catch (err) {
      // Coolify's request() throws on any non-2xx; the message contains
      // the status code. 404 == truly gone; everything else (502 mid-
      // restart, transient 500) we ride out and retry.
      if (/\b404\b/.test((err as Error).message)) return;
    }
    await sleep(intervalMs);
  }
  // Soft-fail: warn but don't throw — the project-delete retry below
  // handles the rare case where Coolify never reports a 404 (we've
  // seen this on builds with the "soft delete" flag on; the row stays
  // discoverable for a while but is no longer counted as a project
  // resource). Logging just keeps it observable.
  console.log(
    chalk.dim(`    (waited ${timeoutMs / 1000}s for ${label} delete to settle; moving on)`),
  );
}

interface RollbackOptions {
  /** Skip per-step confirmation prompts on destructive operations. */
  yes?: boolean;
}

/** Thrown by an undo step when the resource can't be auto-deleted because
 *  the underlying API needs the user to do something first (e.g. Coolify
 *  refuses to delete a project that still has apps/databases inside it).
 *  Surfaces as a yellow "skipped" with the hint lines, and the step stays
 *  in the ledger so a follow-up `hatchkit destroy` can pick it up after
 *  the user clears the blocker. */
class RollbackSkip extends Error {
  hints: string[];
  constructor(message: string, hints: string[]) {
    super(message);
    this.name = "RollbackSkip";
    this.hints = hints;
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Failure / cancellation handler — called from the create-flow         */
/*  try/catch and from the SIGINT handler (cancel-handler.ts).            */
/* ─────────────────────────────────────────────────────────────────────── */

/** Re-entrancy guard: the SIGINT path and the catch-block path can both
 *  reach handlePartialRunInterruption in the same tick (inquirer throws
 *  ExitPromptError on Ctrl+C, AND our SIGINT handler fires). The first
 *  caller wins; the second is a no-op so the user only sees one prompt. */
let _interruptionHandled = false;

/** True once an interruption handler has begun. Lets the create/adopt
 *  catch block stand down and let the SIGINT-driven cleanup finish
 *  without a duplicate `process.exit`. */
export function isInterruptionHandled(): boolean {
  return _interruptionHandled;
}

export async function handleCreateFailure(ledger: RunLedger, err: unknown): Promise<void> {
  return handlePartialRunInterruption(ledger, "create", "failed", err);
}

/** Same machinery as handleCreateFailure, just with adopt's verb in
 *  the failure header. Adopt's ledger uses a strict subset of the
 *  step kinds (no `scaffold`, no `terraformApplied`) so the recipe
 *  printer + rollback executor are reusable as-is. */
export async function handleAdoptFailure(ledger: RunLedger, err: unknown): Promise<void> {
  return handlePartialRunInterruption(ledger, "adopt", "failed", err);
}

/** Cancellation entry points — invoked from the SIGINT handler when the
 *  user presses Ctrl+C mid-flow. Identical recipe + rollback machinery
 *  as the failure handlers, but with a "cancelled" header and the prompt
 *  default tilted to `rollback` (the user just asked to stop, so the
 *  conservative-by-default "leave it" doesn't fit). */
export async function handleCreateCancellation(ledger: RunLedger): Promise<void> {
  return handlePartialRunInterruption(ledger, "create", "cancelled");
}

export async function handleAdoptCancellation(ledger: RunLedger): Promise<void> {
  return handlePartialRunInterruption(ledger, "adopt", "cancelled");
}

async function handlePartialRunInterruption(
  ledger: RunLedger,
  verb: "create" | "adopt",
  reason: "failed" | "cancelled",
  err?: unknown,
): Promise<void> {
  if (_interruptionHandled) return;
  _interruptionHandled = true;

  if (reason === "failed") {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.bold.red(`\n  ✗ hatchkit ${verb} failed: ${message}`));
  } else {
    console.log(chalk.bold.yellow(`\n  ⚠ hatchkit ${verb} cancelled (Ctrl+C).`));
  }

  if (ledger.steps.length === 0) {
    const noun = reason === "failed" ? "failure" : "cancellation";
    console.log(chalk.dim(`  No steps completed before ${noun} — nothing to clean up.\n`));
    ledger.delete();
    return;
  }

  const verbed = reason === "failed" ? "before failing" : "so far";
  console.log(
    chalk.dim(
      `  Completed ${ledger.steps.length} step${ledger.steps.length === 1 ? "" : "s"} ${verbed}. ` +
        `Ledger: ${ledger.path}\n`,
    ),
  );
  printRecipe(ledger);

  // Default tilts toward rollback for cancellation (user explicitly
  // asked to stop) and toward leave for failure (something unexpected
  // went wrong; let the user inspect before destroying state).
  const defaultChoice: "rollback" | "leave" = reason === "cancelled" ? "rollback" : "leave";

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
      default: defaultChoice,
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
    case "coolifyProject":
      return chalk.dim(
        `# manual: delete Coolify project ${step.uuid} (only after its apps are gone)`,
      );
    case "coolifyPrivateRegistry":
      return chalk.dim(
        `# manual: delete private-registry credential ${step.uuid} from Coolify (Servers → Private Registries)`,
      );
    case "terraformApplied":
      return `cd ${shellEscape(step.stackDir)} && terraform destroy -var-file=${shellEscape(step.tfvarsPath)}`;
    case "coolifyEnv":
      return `rm ${shellEscape(step.path)}`;
    case "tfvars":
      return `rm ${shellEscape(step.path)}`;
    case "glitchtip":
      return `hatchkit remove ${shellEscape(step.project)} glitchtip --yes`;
    case "openpanel":
      return `hatchkit remove ${shellEscape(step.project)} openpanel --yes`;
    case "plausible":
      return `hatchkit remove ${shellEscape(step.project)} plausible --yes`;
    case "resend":
      return `hatchkit remove ${shellEscape(step.client)} resend --yes`;
    case "resendAudience":
      return chalk.dim(
        `# manual: delete Resend audience ${step.audience} (id ${step.audienceId}) via dashboard or API`,
      );
    case "resendDns": {
      // Manual-command form is informational — actual deletion runs
      // through executeStep below. Lists exact record ids so a user
      // doing the cleanup by hand can verify what hatchkit would have
      // removed.
      const lines = step.records.map(
        (r) => `  · DELETE ${r.type.padEnd(5)} ${r.name} (id ${r.id})`,
      );
      const mergedNote = step.mergedSpf.length
        ? `\n  # ${step.mergedSpf.length} SPF row(s) merged into pre-existing records — leave them alone (un-merge manually if needed): ${step.mergedSpf
            .map((m) => m.name)
            .join(", ")}`
        : "";
      return chalk.dim(
        `# rollback Resend DNS in zone ${step.zoneName} (Resend domain ${step.domainName}):\n${lines.join("\n") || "  · (no auto-deletable records)"}${mergedNote}`,
      );
    }
    case "github":
      return `gh repo delete ${shellEscape(step.repo)} --yes`;
    case "scaffold":
      return `rm -rf ${shellEscape(step.path)}`;
    case "keychain":
      return `security delete-generic-password -s hatchkit -a ${shellEscape(step.account)}`;
    case "manifest":
      return `rm ${shellEscape(step.path)}`;
    case "dotenvxKeysFile":
      return `rm ${shellEscape(step.path)}`;
    case "scaffoldedFile":
      return `rm ${shellEscape(step.path)}`;
    case "gitInit":
      return `rm -rf ${shellEscape(step.path)}`;
    case "ghActionsSecret":
      return `gh secret delete ${shellEscape(step.name)} --repo ${shellEscape(step.repo)}`;
    case "r2Bucket":
      return chalk.dim(
        `# manual: delete R2 bucket ${step.bucketName} (account ${step.accountId}) via dashboard or 'wrangler r2 bucket delete'`,
      );
    case "r2Token":
      return chalk.dim(
        step.audience === "account"
          ? `# manual: revoke account API token ${step.tokenId} at https://dash.cloudflare.com/${step.accountId}/api-tokens`
          : `# manual: revoke user API token ${step.tokenId} at https://dash.cloudflare.com/profile/api-tokens`,
      );
    case "cloudflareDnsRecord":
      return chalk.dim(
        `# manual: delete ${step.type} record ${step.name} (id ${step.recordId}) in Cloudflare zone ${step.zoneId}`,
      );
    case "cloudflareEmailDestination":
      return chalk.dim(
        `# manual: revoke Email Routing destination ${step.email} at https://dash.cloudflare.com/${step.accountId}/email/routing/destinations`,
      );
    case "cloudflareEmailRoutingRule":
      return chalk.dim(
        `# manual: delete Email Routing rule for ${step.address} in zone ${step.zoneId}`,
      );
    case "ghPages":
      return `cd ${shellEscape(step.projectDir)} && hatchkit gh-pages --undo --yes`;
    case "localDevFragment":
      return `rm -f ~/.config/dev/projects/${shellEscape(step.slug)}.caddy`;
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

    // Pre-confirm warning for the GHCR registry: it's shared per-host
    // across every Coolify app that pulls from `ghcr.io`. If other apps
    // still exist on this Coolify install they'll lose pull access. We
    // only print the warning — the standard destructive confirm below
    // is what actually gates the delete.
    if (step.kind === "coolifyPrivateRegistry") {
      const others = await countOtherCoolifyApps(ledger);
      if (others && others.count > 0) {
        const list =
          others.sample.join(", ") +
          (others.count > others.sample.length ? `, …+${others.count - others.sample.length}` : "");
        console.log(
          chalk.yellow(
            `  ⚠ ${others.count} other Coolify app(s) currently exist on this install (${list}).`,
          ),
        );
        console.log(
          chalk.yellow(
            `    This is a shared ghcr.io credential — deleting it removes pull access for all of them.`,
          ),
        );
      }
    }

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
      const result = await undoStep(step, ledger.name);
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
      if (err instanceof RollbackSkip) {
        console.log(chalk.yellow(`needs manual cleanup`));
        console.log(chalk.dim(`    ${err.message}`));
        for (const hint of err.hints) {
          console.log(chalk.dim(`    ${hint}`));
        }
        skipped += 1;
        remaining.push(step);
      } else {
        console.log(chalk.red(`✗ ${(err as Error).message}`));
        failed += 1;
        remaining.push(step);
      }
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
    step.kind === "gitInit" ||
    step.kind === "github" ||
    step.kind === "terraformApplied" ||
    step.kind === "coolifyApp" ||
    step.kind === "coolifyProject" ||
    step.kind === "coolifyDb" ||
    step.kind === "coolifyPrivateRegistry" ||
    step.kind === "cloudflareDnsRecord" ||
    // R2 bucket delete drops every object inside it. Token revocation
    // is reversible (just re-mint), so it stays out of this list.
    step.kind === "r2Bucket"
  );
}

/** Probe Coolify for apps that DON'T belong to this run's ledger. Used
 *  before deleting `coolifyPrivateRegistry`: the GHCR pull-creds entry
 *  is shared per-host across every app on the Coolify install, so if
 *  there are other apps still pulling from `ghcr.io` they'll lose their
 *  pull access when this entry goes away.
 *
 *  Best-effort — a probe failure (Coolify unreachable, token expired)
 *  resolves to `null` and the caller falls through to the standard
 *  destructive confirm without a count. We never block the rollback on
 *  this informational check. */
async function countOtherCoolifyApps(
  ledger: RunLedger,
): Promise<{ count: number; sample: string[] } | null> {
  try {
    const cfg = await getCoolifyConfig();
    if (!cfg) return null;
    const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
    const allApps = await api.listApplications();
    // Apps THIS rollback is going to delete shouldn't count toward the
    // "other apps that depend on this registry" warning.
    const ourAppUuids = new Set(
      ledger.steps.filter((s) => s.kind === "coolifyApp").map((s) => s.uuid),
    );
    const others = allApps.filter((a) => !ourAppUuids.has(a.uuid));
    return {
      count: others.length,
      sample: others.slice(0, 3).map((a) => a.name),
    };
  } catch {
    return null;
  }
}

function describeStep(step: LedgerStep): string {
  switch (step.kind) {
    case "scaffold":
      return `delete local repo ${chalk.cyan(step.path)}`;
    case "github":
      return `delete GitHub repo ${chalk.cyan(step.repo)}`;
    case "glitchtip":
      return `delete GlitchTip project ${chalk.cyan(step.project)}`;
    case "openpanel":
      return `delete OpenPanel project ${chalk.cyan(step.project)}`;
    case "plausible":
      return `delete Plausible site for ${chalk.cyan(step.project)}`;
    case "resend":
      return `delete Resend API key ${chalk.cyan(step.client)}`;
    case "resendAudience":
      return `delete Resend audience ${chalk.cyan(step.audience)}`;
    case "resendDns": {
      const total = step.records.length;
      const merged = step.mergedSpf.length;
      const auto =
        total === 1 ? `1 record` : total === 0 ? `no records` : `${total} records`;
      const mergedNote = merged > 0 ? `, ${merged} merged SPF skipped` : "";
      return `delete ${chalk.cyan(auto)} in Cloudflare zone ${chalk.cyan(step.zoneName)} (Resend ${step.domainName}${mergedNote})`;
    }
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
    case "coolifyProject":
      return `delete Coolify project ${chalk.cyan(step.uuid)}`;
    case "coolifyDb":
      return `delete Coolify db ${chalk.cyan(step.uuid)}`;
    case "coolifyPrivateRegistry":
      return `delete Coolify private-registry creds ${chalk.cyan(step.uuid)}`;
    case "mlService":
      return `${chalk.cyan(step.platform)} ML service ${chalk.cyan(step.name)}`;
    case "manifest":
      return `remove ${chalk.cyan(step.path)}`;
    case "dotenvxKeysFile":
      return `remove ${chalk.cyan(step.path)}`;
    case "scaffoldedFile":
      return `remove ${chalk.cyan(step.path)}`;
    case "gitInit":
      return `remove .git dir at ${chalk.cyan(step.path)}`;
    case "ghActionsSecret":
      return `delete GH Actions secret ${chalk.cyan(step.name)} on ${chalk.cyan(step.repo)}`;
    case "r2Bucket":
      return `delete R2 bucket ${chalk.cyan(step.bucketName)}`;
    case "r2Token":
      return `revoke R2 ${step.audience} token ${chalk.cyan(step.tokenId.slice(0, 8) + "…")}`;
    case "cloudflareDnsRecord":
      return `delete Cloudflare ${step.type} record ${chalk.cyan(step.name)}`;
    case "cloudflareEmailDestination":
      return `revoke Email Routing destination ${chalk.cyan(step.email)}`;
    case "cloudflareEmailRoutingRule":
      return `delete Email Routing rule for ${chalk.cyan(step.address)}`;
    case "ghPages":
      return `tear down GitHub Pages for ${chalk.cyan(step.repo)}`;
    case "localDevFragment":
      return `remove local-dev Caddy fragment ${chalk.cyan(`${step.slug}.caddy`)}`;
  }
}

async function undoStep(
  step: LedgerStep,
  ledgerName: string,
): Promise<"done" | "skipped" | "not-found"> {
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
      if (dns?.apiToken) {
        env.TF_VAR_cloudflare_api_token = dns.apiToken;
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
      if (result === "not-found") return "not-found";
      // Coolify's DELETE returns 200 as soon as the request is queued —
      // the actual `docker compose down` + DB row removal completes
      // asynchronously. If we move on to the project delete too fast,
      // Coolify still sees the app as a child resource and 422s. Wait
      // for the application's GET to 404 so the subsequent project
      // delete has a clean slate.
      await waitForResourceGone(() => api.getApplication(step.uuid), "application");
      return "done";
    }
    case "coolifyDb": {
      const cfg = await getCoolifyConfig();
      if (!cfg) throw new Error("Coolify config no longer present");
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      const result = await api.deleteDatabase(step.uuid);
      if (result === "not-found") return "not-found";
      // Same async-cleanup race as the application path — see above.
      await waitForResourceGone(() => api.getDatabase(step.uuid), "database");
      return "done";
    }
    case "coolifyProject": {
      const cfg = await getCoolifyConfig();
      if (!cfg) throw new Error("Coolify config no longer present");
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      // Retry the project delete a few times: even with the post-delete
      // polling above, Coolify occasionally needs another second before
      // its project-resource link table catches up. Eight attempts at
      // ~750ms each = ~6s ceiling — well below the user's "is it
      // hanging?" threshold and enough to ride out the longest cleanup
      // we've observed on a healthy Coolify install.
      const maxAttempts = 8;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = await api.deleteProject(step.uuid);
          return result === "not-found" ? "not-found" : "done";
        } catch (err) {
          const msg = (err as Error).message;
          const stillBusy = /Project has resources|cannot be deleted/i.test(msg);
          if (!stillBusy) throw err;
          if (attempt === maxAttempts) {
            // Genuinely stuck — fall back to the prior manual-cleanup
            // path so the user gets actionable guidance instead of a
            // raw "still has resources" error.
            const projectUrl = `${cfg.url.replace(/\/$/, "")}/project/${step.uuid}`;
            throw new RollbackSkip(
              "Coolify project still has applications/databases/services inside it after waiting.",
              [
                `Open ${projectUrl} and delete each remaining resource.`,
                `Then re-run \`hatchkit destroy ${ledgerName}\` to remove the empty project.`,
              ],
            );
          }
          await sleep(750);
        }
      }
      // Unreachable — the loop either returns or throws RollbackSkip.
      return "done";
    }
    case "coolifyPrivateRegistry": {
      const cfg = await getCoolifyConfig();
      if (!cfg) throw new Error("Coolify config no longer present");
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      const result = await api.deletePrivateRegistry(step.uuid);
      return result === "not-found" ? "not-found" : "done";
    }
    case "openpanel": {
      const { deleteOpenpanelClient } = await import("../provision/openpanel.js");
      const result = await deleteOpenpanelClient(step.project);
      return result === "not-found" ? "not-found" : "done";
    }
    case "plausible": {
      const { deletePlausibleSite } = await import("../provision/plausible.js");
      const result = await deletePlausibleSite(step.project);
      return result === "not-found" ? "not-found" : "done";
    }
    case "resend": {
      const { deleteResendClient } = await import("../provision/resend.js");
      const result = await deleteResendClient(step.client);
      return result === "not-found" ? "not-found" : "done";
    }
    case "resendAudience": {
      const { deleteResendAudience } = await import("../provision/resend.js");
      const result = await deleteResendAudience(step.audience);
      return result === "not-found" ? "not-found" : "done";
    }
    case "resendDns": {
      // Delete only the records THIS run created — `step.records` was
      // populated from upsertRecord results where `created: true`, so
      // we can't accidentally remove anything that pre-existed. SPF
      // rows that were merged into pre-existing records live in
      // `step.mergedSpf` and stay manual; un-merging without the
      // original snapshot risks yanking the user's other includes.
      if (step.records.length === 0) {
        // Pure-merge step — nothing safely auto-removable.
        return step.mergedSpf.length > 0 ? "skipped" : "not-found";
      }
      const dns = await getDnsConfig();
      if (!dns?.apiToken) {
        throw new Error("Cloudflare credentials no longer in keychain — re-add them, then retry");
      }
      const { CloudflareApi } = await import("../utils/cloudflare-api.js");
      const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
      let removed = 0;
      let missing = 0;
      for (const record of step.records) {
        const res = await cf.deleteRecord(step.zoneId, record.id);
        if (res === "deleted") removed += 1;
        else missing += 1;
      }
      if (removed === 0 && missing > 0) return "not-found";
      return "done";
    }
    case "manifest":
    case "dotenvxKeysFile":
    case "scaffoldedFile": {
      if (!existsSync(step.path)) return "not-found";
      unlinkSync(step.path);
      return "done";
    }
    case "gitInit": {
      // Adopt only records this when `state.isGitRepo === false` at
      // detection — i.e. it ran `git init` on a directory with no
      // `.git/`. Removing it still drops the "Adopt under hatchkit
      // management" commit + any work the user committed on top, so
      // it stays gated behind the destructive-step confirmation in
      // runRollback.
      if (!existsSync(step.path)) return "not-found";
      rmSync(step.path, { recursive: true, force: true });
      return "done";
    }
    case "ghActionsSecret": {
      // Recorded only when adopt's probe confirmed the secret didn't
      // pre-exist (see ghSecretExists in gh-actions-secrets.ts), so
      // we're never deleting a secret the user set themselves.
      return ghSecretDelete(step.repo, step.name);
    }
    case "r2Bucket": {
      // Use the R2 admin token (account-level R2 perms) for the delete;
      // it's the same token provision used to create the bucket. Falls
      // back to the DNS token only if R2 admin isn't around — the DNS
      // token rarely has R2:Edit but the error message will be clear.
      const adminToken = await getR2AdminToken();
      if (!adminToken) {
        throw new Error(
          "R2 admin token not in keychain — re-add via `hatchkit config add s3 r2`, then retry destroy.",
        );
      }
      const { CloudflareApi } = await import("../utils/cloudflare-api.js");
      const cf = new CloudflareApi({ token: adminToken });
      const result = await cf.deleteR2Bucket(step.accountId, step.bucketName);
      if (result === "not-empty") {
        // Don't auto-empty — destroying user objects without explicit
        // confirmation is exactly the safety violation we want to avoid.
        throw new RollbackSkip(`R2 bucket "${step.bucketName}" still contains objects.`, [
          `Empty the bucket first, e.g.: \`wrangler r2 bucket delete ${step.bucketName} --remote\` (after \`wrangler r2 object delete\` for the contents),`,
          `or open https://dash.cloudflare.com/${step.accountId}/r2/default/buckets/${step.bucketName} and delete the objects manually.`,
          `Then re-run \`hatchkit destroy ${ledgerName}\`.`,
        ]);
      }
      return result === "deleted" ? "done" : "not-found";
    }
    case "r2Token": {
      const adminToken = await getR2AdminToken();
      if (!adminToken) {
        throw new Error(
          "R2 admin token not in keychain — re-add via `hatchkit config add s3 r2`, then retry destroy.",
        );
      }
      const { CloudflareApi } = await import("../utils/cloudflare-api.js");
      const cf = new CloudflareApi({ token: adminToken });
      // Account-token deletes go through the account endpoint; legacy
      // user-token entries (recorded for migration safety) go through
      // the user endpoint — see the LedgerStep doc.
      const result =
        step.audience === "account"
          ? await cf.deleteAccountToken(step.accountId, step.tokenId)
          : await cf.deleteApiToken(step.tokenId);
      return result === "not-found" ? "not-found" : "done";
    }
    case "cloudflareDnsRecord": {
      const dns = await getDnsConfig();
      if (!dns || !dns.apiToken) {
        throw new Error("Cloudflare credentials no longer in keychain — re-add them, then retry");
      }
      const { CloudflareApi } = await import("../utils/cloudflare-api.js");
      const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
      const result = await cf.deleteRecord(step.zoneId, step.recordId);
      return result === "not-found" ? "not-found" : "done";
    }
    case "cloudflareEmailDestination": {
      const dns = await getDnsConfig();
      if (!dns || !dns.apiToken) {
        throw new Error("Cloudflare credentials no longer in keychain — re-add them, then retry");
      }
      const { CloudflareApi } = await import("../utils/cloudflare-api.js");
      const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
      const result = await cf.deleteEmailDestination(step.accountId, step.destinationId);
      return result === "not-found" ? "not-found" : "done";
    }
    case "cloudflareEmailRoutingRule": {
      const dns = await getDnsConfig();
      if (!dns || !dns.apiToken) {
        throw new Error("Cloudflare credentials no longer in keychain — re-add them, then retry");
      }
      const { CloudflareApi } = await import("../utils/cloudflare-api.js");
      const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
      const result = await cf.deleteEmailRoutingRule(step.zoneId, step.ruleId);
      return result === "not-found" ? "not-found" : "done";
    }
    case "mlService":
      // Per-platform delete is platform-specific (Modal/RunPod/HF/Replicate).
      // Surface in the recipe but skip auto-undo for now.
      return "skipped";
    case "ghPages": {
      // runPagesUndo no-ops on file-side actions when the project dir
      // has been deleted (scaffold-delete typically runs after this in
      // the reverse-order ledger walk, but the user may have wiped the
      // dir by hand). The remote teardown (Pages API + Cloudflare)
      // still runs regardless.
      const { runPagesUndo } = await import("./pages.js");
      await runPagesUndo(step.projectDir, { yes: true, dryRun: false });
      return "done";
    }
    case "localDevFragment": {
      const { removeProjectFragment } = await import("@hatchkit/dev-shared");
      const removed = removeProjectFragment(step.slug);
      return removed ? "done" : "not-found";
    }
  }
}
