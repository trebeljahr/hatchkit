/*
 * `hatchkit infra plan|apply|output <stack>` — run one of hatchkit's own
 * Terraform stacks (infra/terraform/stacks/<stack>) that is not a project
 * stack, with a Cloudflare token minted for the run.
 *
 * Each stack in INFRA_STACKS lists exactly the permission groups its
 * resources need. `plan` and `apply` each mint an account token with those
 * grants (one hour, read back before use, revoked in a `finally`) and hand
 * it to Terraform as CLOUDFLARE_API_TOKEN, never as a variable: a saved
 * plan stores variable values, and `apply` runs later with a newer token.
 * The operator token never reaches Terraform.
 *
 * `plan` saves `tfplan` in the stack directory and prints what would be
 * created, changed, replaced or destroyed. `apply` applies only that saved
 * plan, so what runs is what was reviewed; Terraform refuses it once the
 * state has moved on. After an apply, the stack's Workers and buckets are
 * accepted in the Cloudflare audit allowlist (and republished to the audit
 * Worker when one is deployed).
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
  type TerraformTokenApi,
  type TerraformTokenGrant,
  accountResource,
  mintTerraformToken,
  zoneResource,
} from "../deploy/terraform-token.js";
import { exec, execStream } from "../utils/exec.js";

export interface InfraStack {
  /** Directory under `infra/terraform/stacks/`. */
  dir: string;
  /** Zone the stack's zone-scoped grants apply to. */
  zone: string;
  /** Account-wide permission groups. */
  accountGroups: readonly string[];
  /** Permission groups on `zone` only. */
  zoneGroups: readonly string[];
  /** Resources the Cloudflare audit should accept once applied. */
  audit: { workers?: readonly string[]; buckets?: readonly string[] };
  summary: string;
}

export const INFRA_STACKS: Readonly<Record<string, InfraStack>> = {
  "ota-updates": {
    dir: "ota-updates",
    zone: "ricoslabs.com",
    // Creating a Worker needs account-wide script access (per-Worker
    // grants only cover Workers that already exist); the bucket needs R2.
    accountGroups: ["Workers Scripts Write", "Workers R2 Storage Write"],
    // The Custom Domain: Workers Routes on the zone, plus the DNS record
    // Cloudflare creates for it. Zone Read for `data "cloudflare_zone"`.
    zoneGroups: ["Zone Read", "Workers Routes Write", "DNS Write"],
    audit: { workers: ["ota-updates"], buckets: ["ota-updates"] },
    summary: "Live-update endpoint ota.ricoslabs.com (Worker + R2) for the Capacitor apps",
  },
};

export const INFRA_USAGE = `Usage: hatchkit infra <plan|apply|output> <stack> [--json]

  plan <stack>      Mint a 1 h Cloudflare token with only the stack's grants,
                    run terraform init + plan, save tfplan and list every
                    create / update / replace / destroy. Writes nothing on
                    the account but that short-lived token.
  apply <stack>     Apply the saved tfplan with a fresh token of the same
                    grants, then accept the stack's Workers and buckets in
                    the Cloudflare audit. Refuses without a saved plan.
  output <stack>    terraform output from the local state (no token).
                    Sensitive outputs: hatchkit infra output <stack> <name>

Stacks:
${Object.entries(INFRA_STACKS)
  .map(([name, s]) => `  ${name.padEnd(16)}${s.summary}`)
  .join("\n")}

The operator token (cloudflare:operator) needs Account API Tokens → Edit to
mint the run token; it is never passed to Terraform.`;

export interface PlannedChange {
  address: string;
  actions: string[];
}

/** Resource changes from `terraform show -json tfplan`, minus no-ops. */
export function summarizePlan(planJson: string): PlannedChange[] {
  const plan = JSON.parse(planJson) as {
    resource_changes?: Array<{ address: string; change?: { actions?: string[] } }>;
  };
  return (plan.resource_changes ?? [])
    .map((rc) => ({ address: rc.address, actions: rc.change?.actions ?? [] }))
    .filter(
      (c) => !(c.actions.length === 1 && (c.actions[0] === "no-op" || c.actions[0] === "read")),
    );
}

const isReplace = (c: PlannedChange) =>
  c.actions.includes("delete") && c.actions.includes("create");
const isDestroy = (c: PlannedChange) => c.actions.length === 1 && c.actions[0] === "delete";

export function renderPlanSummary(changes: PlannedChange[]): string {
  if (!changes.length) return "No changes.";
  const label = (c: PlannedChange) =>
    isReplace(c) ? "MUST BE REPLACED" : isDestroy(c) ? "DESTROY" : c.actions.join("+");
  const lines = changes.map((c) => `  ${label(c).padEnd(16)} ${c.address}`);
  const replaced = changes.filter(isReplace).length;
  const destroyed = changes.filter(isDestroy).length;
  if (replaced || destroyed) {
    lines.push(
      "",
      `  ! ${replaced} replacement(s), ${destroyed} destroy(s): read the plan above before applying.`,
    );
  }
  return lines.join("\n");
}

export interface InfraDeps {
  /** `infra/` of the hatchkit checkout. */
  infraRoot: string;
  /** Operator token + account. Default: the keychain. */
  operator?: () => Promise<{ token: string; source: string; accountId: string }>;
  /** Zone id by name. Default: Cloudflare API with the operator token. */
  zoneId?: (token: string, accountId: string, zone: string) => Promise<string>;
  api?: TerraformTokenApi;
  now?: () => Date;
  /** `terraform` runner. Default: streams to the terminal. */
  terraform?: (
    args: string[],
    opts: { cwd: string; env: Record<string, string>; capture?: boolean },
  ) => Promise<{ exitCode: number; stdout: string }>;
  /** Called after a successful apply. Default: audit allowlist + republish. */
  acceptInAudit?: (stack: InfraStack) => Promise<void>;
  log?: (line: string) => void;
}

async function defaultOperator(): Promise<{ token: string; source: string; accountId: string }> {
  const { getCloudflareToken, SECRET_KEYS } = await import("../utils/secrets.js");
  const { getConfiguredCloudflareAccountId } = await import("../config.js");
  const found = await getCloudflareToken("provisioner");
  if (!found || found.source !== SECRET_KEYS.cloudflareOperatorToken) {
    throw new Error(
      "hatchkit infra needs the Cloudflare operator token (keychain cloudflare:operator) to mint the run token.\n" +
        "  Run `hatchkit config add cloudflare`.",
    );
  }
  const accountId = getConfiguredCloudflareAccountId();
  if (!accountId)
    throw new Error(
      "No Cloudflare account id is configured. Run `hatchkit config add cloudflare`.",
    );
  return { token: found.token, source: found.source, accountId };
}

async function defaultZoneId(token: string, accountId: string, zone: string): Promise<string> {
  const { CloudflareApi } = await import("../utils/cloudflare-api.js");
  const found = await new CloudflareApi({ token, accountId }).getZoneByName(zone);
  if (!found) throw new Error(`Cloudflare zone ${zone} not found on account ${accountId}.`);
  return found.id;
}

async function defaultTerraform(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; capture?: boolean },
): Promise<{ exitCode: number; stdout: string }> {
  if (opts.capture) {
    const result = await exec("terraform", args, { cwd: opts.cwd, env: opts.env, silent: true });
    return { exitCode: result.exitCode, stdout: result.stdout };
  }
  return {
    exitCode: await execStream("terraform", args, { cwd: opts.cwd, env: opts.env }),
    stdout: "",
  };
}

async function defaultAcceptInAudit(stack: InfraStack): Promise<void> {
  const { updateAccepted, getAuditWorker } = await import("../audit/expected.js");
  const entries = [
    ...(stack.audit.workers ?? []).map((w) => `worker:${w}`),
    ...(stack.audit.buckets ?? []).map((b) => `bucket:${b}`),
  ];
  if (!entries.length) return;
  updateAccepted(entries);
  if (getAuditWorker()) {
    const { publishExpectedToWorker } = await import("../audit/deploy.js");
    await publishExpectedToWorker();
  }
}

export function stackGrants(
  stack: InfraStack,
  accountId: string,
  zoneId: string,
): TerraformTokenGrant[] {
  const grants: TerraformTokenGrant[] = [];
  if (stack.accountGroups.length)
    grants.push({ groups: stack.accountGroups, resource: accountResource(accountId) });
  if (stack.zoneGroups.length)
    grants.push({ groups: stack.zoneGroups, resource: zoneResource(zoneId) });
  return grants;
}

export async function runInfraCommand(args: string[], deps: InfraDeps): Promise<void> {
  const [action, name, ...rest] = args;
  const json = rest.includes("--json");
  const log = deps.log ?? ((line: string) => console.log(line));
  if (!action || !["plan", "apply", "output"].includes(action)) throw new Error(INFRA_USAGE);
  const stack = name ? INFRA_STACKS[name] : undefined;
  if (!stack) throw new Error(`Unknown stack "${name ?? ""}".\n\n${INFRA_USAGE}`);
  const stackDir = join(deps.infraRoot, "terraform", "stacks", stack.dir);
  if (!existsSync(join(stackDir, "main.tf"))) throw new Error(`No Terraform stack at ${stackDir}`);
  const terraform = deps.terraform ?? defaultTerraform;
  const planFile = join(stackDir, "tfplan");

  if (action === "output") {
    const outputName = rest.find((a) => !a.startsWith("--"));
    const outArgs = [
      "output",
      ...(json || outputName ? ["-json"] : []),
      ...(outputName ? [outputName] : []),
    ];
    const result = await terraform(outArgs, { cwd: stackDir, env: {}, capture: true });
    if (result.exitCode !== 0) throw new Error("terraform output failed");
    log(result.stdout.trim());
    return;
  }
  if (action === "apply" && !existsSync(planFile)) {
    throw new Error(
      `No saved plan at ${planFile}. Run \`hatchkit infra plan ${name}\` first and read it.`,
    );
  }

  const operator = await (deps.operator ?? defaultOperator)();
  const zoneId = await (deps.zoneId ?? defaultZoneId)(
    operator.token,
    operator.accountId,
    stack.zone,
  );
  const grants = stackGrants(stack, operator.accountId, zoneId);
  const describe = grants.map((g) => `${g.groups.join(" + ")} on ${g.resource}`).join("; ");
  const token = await mintTerraformToken({
    token: operator.token,
    accountId: operator.accountId,
    label: name as string,
    grants,
    fail: (why) =>
      new Error(
        `Could not mint the Terraform token for ${name}: ${why}\n` +
          "  The Cloudflare operator token needs Account → Account API Tokens → Edit.\n" +
          "  hatchkit does not hand its own Cloudflare token to Terraform.",
      ),
    mismatch: `the minted token's policy is not exactly: ${describe}`,
    api: deps.api,
    now: deps.now,
  });
  // Overrides any CLOUDFLARE_API_TOKEN in the shell's environment.
  const env = { CLOUDFLARE_API_TOKEN: token.value };
  try {
    log(chalk.dim(`  Run token: ${describe} (1 h, revoked when this run ends)`));
    const init = await terraform(["init", "-input=false"], { cwd: stackDir, env });
    if (init.exitCode !== 0) throw new Error("terraform init failed");

    if (action === "plan") {
      const plan = await terraform(["plan", "-input=false", `-out=${planFile}`], {
        cwd: stackDir,
        env,
      });
      if (plan.exitCode !== 0) throw new Error("terraform plan failed");
      const shown = await terraform(["show", "-json", planFile], {
        cwd: stackDir,
        env,
        capture: true,
      });
      if (shown.exitCode !== 0) throw new Error("terraform show failed");
      const changes = summarizePlan(shown.stdout);
      if (json) log(JSON.stringify({ stack: name, planFile, changes }, null, 2));
      else {
        log(`\n  Plan for ${name}, saved to ${planFile}:\n`);
        log(renderPlanSummary(changes));
        log(`\n  Apply exactly this plan: hatchkit infra apply ${name}`);
      }
      return;
    }

    const apply = await terraform(["apply", "-input=false", planFile], { cwd: stackDir, env });
    if (apply.exitCode !== 0) throw new Error("terraform apply failed");
    // A plan applies once; the next change starts with a new plan.
    rmSync(planFile, { force: true });
    await (deps.acceptInAudit ?? defaultAcceptInAudit)(stack);
    log(
      chalk.green(
        `  ✓ ${name} applied; its Workers and buckets are accepted in the Cloudflare audit.`,
      ),
    );
  } finally {
    await token.revoke();
  }
}
