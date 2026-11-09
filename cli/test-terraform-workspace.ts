/**
 * Every project in a shared Terraform stack directory gets its own
 * workspace (state file).
 *
 * The regression this guards: all projects in dns-only-cloudflare shared
 * one terraform.tfstate. The stack describes one project's records
 * (for_each over its subdomains), so each create planned the previous
 * project's records for destruction and applied it. Creating one app
 * deleted the DNS of the app created before it.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacyStateOwner,
  projectWorkspaceEnv,
  tfvarsSubdomainKeys,
  workspaceName,
} from "./src/deploy/terraform-workspace.js";
import type { ExecResult } from "./src/utils/exec.js";

const tfvars = (keys: string[]) =>
  `domain = "example.com"\nsubdomains = {\n${keys.map((k) => `  "${k}" = "Web app"`).join("\n")}\n}\ntarget_ipv4 = "203.0.113.10"\n`;

const state = (keys: Array<string | null>) =>
  JSON.stringify({
    version: 4,
    resources: [
      { mode: "data", type: "cloudflare_zone", name: "this", instances: [{}] },
      ...keys.map((k) => ({
        mode: "managed",
        type: "cloudflare_record",
        name: "a",
        instances: [k === null ? {} : { index_key: k }],
      })),
    ],
  });

// --- pure helpers --------------------------------------------------------

assert.equal(workspaceName("/x/stacks/dns-only-cloudflare/my-app.tfvars"), "my-app");
assert.equal(workspaceName("/x/weird name!.tfvars"), "weird-name-");
assert.deepEqual(tfvarsSubdomainKeys(tfvars(["app", "api.app"])), ["app", "api.app"]);
assert.deepEqual(tfvarsSubdomainKeys('domain = "example.com"\n'), []);

assert.equal(legacyStateOwner("", tfvars(["app"])), "empty");
assert.equal(
  legacyStateOwner(state([]), tfvars(["app"])),
  "empty",
  "a data source alone is not ownership",
);
assert.equal(legacyStateOwner(state(["app", "api.app"]), tfvars(["app"])), "mine");
assert.equal(legacyStateOwner(state(["other"]), tfvars(["app"])), "other");
assert.equal(
  legacyStateOwner(state([null]), tfvars(["app"])),
  "unknown",
  "a server without keys is nobody's to claim",
);
assert.equal(legacyStateOwner("not json", tfvars(["app"])), "empty");

// --- workspace flow with a fake terraform --------------------------------

function fakeTerraform(workspaces: string[], defaultAddresses: string[] = []) {
  const calls: Array<{ args: string[]; ws?: string }> = [];
  const run = async (
    _cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ): Promise<ExecResult> => {
    calls.push({ args, ws: opts?.env?.TF_WORKSPACE });
    const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "workspace" && args[1] === "list") {
      return ok(workspaces.map((w) => (w === "default" ? `* ${w}` : `  ${w}`)).join("\n"));
    }
    if (args[0] === "workspace" && args[1] === "new") {
      workspaces.push(args[args.length - 1]);
      return ok();
    }
    if (args[0] === "state" && args[1] === "list") return ok(defaultAddresses.join("\n"));
    return ok();
  };
  return { run, calls };
}

const dir = mkdtempSync(join(tmpdir(), "hk-tfws-"));
try {
  const appVars = join(dir, "app.tfvars");
  writeFileSync(appVars, tfvars(["app"]));

  // 1. Existing workspace: just select it through the env.
  {
    const tf = fakeTerraform(["default", "app"]);
    const env = await projectWorkspaceEnv(dir, appVars, { TF_WORKSPACE: "stale", X: "1" }, tf.run);
    assert.equal(env.TF_WORKSPACE, "app");
    assert.equal(env.X, "1");
    assert.equal(tf.calls.length, 1, "only `workspace list`");
    assert.equal(
      tf.calls[0].ws,
      undefined,
      "workspace commands never run under a TF_WORKSPACE override",
    );
  }

  // 2. Shared state belongs to another project: new empty workspace, the
  //    other project's state is left alone.
  {
    writeFileSync(join(dir, "terraform.tfstate"), state(["other"]));
    const tf = fakeTerraform(["default"]);
    const env = await projectWorkspaceEnv(dir, appVars, {}, tf.run);
    assert.equal(env.TF_WORKSPACE, "app");
    const created = tf.calls.find((c) => c.args[1] === "new");
    assert.deepEqual(
      created?.args,
      ["workspace", "new", "app"],
      "no -state copy of someone else's records",
    );
    assert.ok(
      !tf.calls.some((c) => c.args[0] === "state"),
      "never touches the other project's state",
    );
    assert.ok(
      tf.calls.some((c) => c.args.join(" ") === "workspace select default"),
      "plain terraform runs stay on the default workspace",
    );
  }

  // 3. Shared state holds this project's records: they move into the new
  //    workspace and leave the default state.
  {
    writeFileSync(join(dir, "terraform.tfstate"), state(["app"]));
    const tf = fakeTerraform(
      ["default"],
      ['module.dns.cloudflare_record.a["app"]', "module.dns.data.cloudflare_zone.this"],
    );
    await projectWorkspaceEnv(dir, appVars, {}, tf.run);
    const created = tf.calls.find((c) => c.args[1] === "new");
    assert.deepEqual(created?.args, [
      "workspace",
      "new",
      `-state=${join(dir, "terraform.tfstate")}`,
      "app",
    ]);
    const removed = tf.calls.find((c) => c.args[0] === "state" && c.args[1] === "rm");
    assert.equal(removed?.ws, "default", "clears the DEFAULT workspace, not the new one");
    assert.deepEqual(removed?.args.slice(2), [
      'module.dns.cloudflare_record.a["app"]',
      "module.dns.data.cloudflare_zone.this",
    ]);
  }

  // 4. Resources hatchkit cannot attribute: refuse with the manual command.
  {
    writeFileSync(join(dir, "terraform.tfstate"), state([null]));
    const tf = fakeTerraform(["default"]);
    await assert.rejects(
      projectWorkspaceEnv(dir, appVars, {}, tf.run),
      /workspace new -state=terraform.tfstate app/,
    );
    assert.ok(!tf.calls.some((c) => c.args[1] === "new"), "creates nothing when it cannot tell");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("✓ terraform workspace per project");
