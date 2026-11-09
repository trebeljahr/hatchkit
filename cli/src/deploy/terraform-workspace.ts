import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import chalk from "chalk";
import { exec } from "../utils/exec.js";

/**
 * One Terraform workspace, so one state file, per project in a shared
 * stack directory (terraform.tfstate.d/<project>/terraform.tfstate).
 *
 * The stacks describe ONE project's resources: dns-only-cloudflare runs
 * for_each over that project's subdomains. While every project in a stack
 * shared the default terraform.tfstate, each apply planned the previous
 * project's records for destruction and carried it out: creating one
 * app deleted the DNS records of the app created minutes before it.
 *
 * Commands get the workspace through TF_WORKSPACE, never `workspace
 * select`, so two runs in the same directory cannot switch each other's
 * workspace, and a terraform run without TF_WORKSPACE (an older hatchkit
 * build, or a hand-typed command) stays in the default workspace.
 */

export function workspaceName(tfvarsPath: string): string {
  return basename(tfvarsPath, ".tfvars").replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Keys of the `subdomains = { "app" = "…", … }` map in a tfvars file. */
export function tfvarsSubdomainKeys(tfvars: string): string[] {
  const block = /subdomains\s*=\s*\{([\s\S]*?)\}/m.exec(tfvars)?.[1] ?? "";
  return [...block.matchAll(/^\s*"([^"]+)"\s*=/gm)].map((m) => m[1]);
}

interface StateInstance {
  index_key?: unknown;
}
interface StateResource {
  mode?: string;
  instances?: StateInstance[];
}

/** for_each keys and count of every managed resource instance in a state. */
export function stateManagedInstances(state: string): { count: number; keys: string[] } {
  let parsed: { resources?: StateResource[] };
  try {
    parsed = JSON.parse(state);
  } catch {
    return { count: 0, keys: [] };
  }
  const instances = (parsed.resources ?? [])
    .filter((r) => r.mode === "managed")
    .flatMap((r) => r.instances ?? []);
  return {
    count: instances.length,
    keys: instances.map((i) => i.index_key).filter((k): k is string => typeof k === "string"),
  };
}

/**
 * Who owns the stack's old shared state, as seen from one project.
 *
 *  - empty:   nothing managed in it
 *  - mine:    it holds this project's subdomains (an apply replaced the
 *             whole set every time, so the shared state only ever held the
 *             last project that applied)
 *  - other:   it holds another project's subdomains
 *  - unknown: it holds resources without subdomain keys (a server stack),
 *             so hatchkit cannot tell whose they are
 */
export type LegacyOwner = "empty" | "mine" | "other" | "unknown";

export function legacyStateOwner(state: string, tfvars: string): LegacyOwner {
  const { count, keys } = stateManagedInstances(state);
  if (count === 0) return "empty";
  if (keys.length === 0) return "unknown";
  const held = new Set(keys);
  return tfvarsSubdomainKeys(tfvars).some((k) => held.has(k)) ? "mine" : "other";
}

type Exec = typeof exec;

/**
 * Make sure the project's workspace exists and return the env that runs
 * terraform in it. Call after `terraform init`.
 *
 * First run for a project: when the shared default state holds this
 * project's resources, they move into the new workspace and leave the
 * default state, so a stale build still writing to the default state has
 * nothing of this project's to destroy.
 */
export async function projectWorkspaceEnv(
  stackDir: string,
  tfvarsPath: string,
  env: Record<string, string>,
  run: Exec = exec,
): Promise<Record<string, string>> {
  const ws = workspaceName(tfvarsPath);
  const base = { ...env };
  delete base.TF_WORKSPACE;
  const opts = { cwd: stackDir, env: base, silent: true };

  const list = await run("terraform", ["workspace", "list"], opts);
  if (list.exitCode !== 0)
    throw new Error(`terraform workspace list failed: ${list.stderr || list.stdout}`);
  const existing = list.stdout
    .split("\n")
    .map((l) => l.replace("*", "").trim())
    .filter(Boolean);
  if (existing.includes(ws)) return { ...base, TF_WORKSPACE: ws };

  const legacyPath = join(stackDir, "terraform.tfstate");
  const legacy = existsSync(legacyPath) ? readFileSync(legacyPath, "utf-8") : "";
  const owner = legacyStateOwner(legacy, readFileSync(tfvarsPath, "utf-8"));
  if (owner === "unknown") {
    throw new Error(
      `${legacyPath} holds resources hatchkit cannot attribute to a project. ` +
        `If they are ${ws}'s, move them into its own workspace and retry:\n` +
        `  cd ${stackDir} && terraform workspace new -state=terraform.tfstate ${ws} && terraform workspace select default`,
    );
  }

  const created = await run(
    "terraform",
    ["workspace", "new", ...(owner === "mine" ? [`-state=${legacyPath}`] : []), ws],
    opts,
  );
  if (created.exitCode !== 0)
    throw new Error(`terraform workspace new ${ws} failed: ${created.stderr || created.stdout}`);
  // `workspace new` also selects it. Go back, so plain terraform runs
  // in this directory keep using the default state.
  await run("terraform", ["workspace", "select", "default"], opts);

  if (owner === "mine") {
    const defaultEnv = { ...opts, env: { ...base, TF_WORKSPACE: "default" } };
    const listed = await run("terraform", ["state", "list"], defaultEnv);
    const addresses = listed.stdout
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);
    if (addresses.length) {
      const removed = await run("terraform", ["state", "rm", ...addresses], defaultEnv);
      if (removed.exitCode !== 0) {
        console.log(
          chalk.yellow(
            `  ! Could not clear ${ws}'s resources from the shared state: ${removed.stderr || removed.stdout}`,
          ),
        );
      }
    }
    console.log(
      chalk.dim(`  Moved ${ws}'s resources from the stack's shared state into workspace ${ws}.`),
    );
  } else {
    console.log(chalk.dim(`  Terraform workspace ${ws} created (own state file).`));
  }
  return { ...base, TF_WORKSPACE: ws };
}
