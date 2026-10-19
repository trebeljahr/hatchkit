/**
 * `hatchkit infra plan|apply <stack>` — hatchkit's own Terraform stacks
 * (today: ota-updates) run with a token minted for the run.
 *
 * Locked down:
 *
 *   1. The run token carries exactly the stack's grants, on the account
 *      and on the one zone; a broader read-back stops the run.
 *   2. Terraform gets it as CLOUDFLARE_API_TOKEN, never the operator
 *      token, and it is revoked after the run, also when Terraform fails.
 *   3. `apply` applies only the saved plan, and refuses without one.
 *   4. Replacements and destroys are flagged in the plan summary.
 *   5. After an apply the stack's Worker and bucket are accepted in the
 *      Cloudflare audit allowlist.
 *
 * Fixture keychain and config only (scripts/test.mjs). No network and no
 * real terraform: both are fakes.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { INFRA_STACKS, renderPlanSummary, runInfraCommand, stackGrants, summarizePlan } =
  await import("./src/infra/command.js");
const { accountResource, policiesMatchGrants, zoneResource } = await import(
  "./src/deploy/terraform-token.js"
);
const { getAuditConfig } = await import("./src/audit/expected.js");

const ACCOUNT = "a".repeat(32);
const ZONE_ID = "z".repeat(32);
const OPERATOR = "operator-token-value";

const failures: string[] = [];
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).stack ?? err}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

/** An infra root with an ota-updates stack directory, nothing else. */
function infraRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hatchkit-infra-"));
  const dir = join(root, "terraform", "stacks", "ota-updates");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tf"), "# fake\n");
  return root;
}

const PLAN_JSON = JSON.stringify({
  resource_changes: [
    { address: "data.cloudflare_zone.this", change: { actions: ["read"] } },
    { address: "cloudflare_r2_bucket.bundles", change: { actions: ["create"] } },
    { address: "cloudflare_workers_script.ota", change: { actions: ["update"] } },
    { address: "cloudflare_workers_custom_domain.ota", change: { actions: ["delete", "create"] } },
    { address: "random_password.url_signing_key", change: { actions: ["no-op"] } },
  ],
});

function fakes(opts: { readback?: unknown; terraformFails?: string } = {}) {
  const calls = {
    created: [] as Array<Record<string, unknown>>,
    deleted: [] as string[],
    terraform: [] as Array<{ args: string[]; env: Record<string, string> }>,
    accepted: 0,
    log: [] as string[],
  };
  const grantsOf = (
    policies: Array<{
      permission_groups: Array<{ id: string }>;
      resources: Record<string, string>;
    }>,
  ) =>
    policies.map((p) => ({
      effect: "allow",
      permission_groups: p.permission_groups.map((g) => ({
        id: g.id,
        name: g.id.replace(/^id:/, ""),
      })),
      resources: p.resources,
    }));
  let lastPolicies: unknown;
  const api = {
    permissionGroupIds: async (_a: string, names: readonly string[]) => names.map((n) => `id:${n}`),
    createAccountToken: async (params: Record<string, unknown>) => {
      calls.created.push(params);
      lastPolicies = grantsOf(params.policies as never);
      return { id: `tok${calls.created.length}`, value: `minted-${calls.created.length}` };
    },
    getAccountToken: async (_a: string, id: string) => ({
      id,
      status: "active",
      name: "x",
      policies: (opts.readback ?? lastPolicies) as never,
    }),
    deleteAccountToken: async (_a: string, id: string) => {
      calls.deleted.push(id);
      return "deleted" as const;
    },
  };
  const deps = {
    operator: async () => ({ token: OPERATOR, source: "cloudflare:operator", accountId: ACCOUNT }),
    zoneId: async () => ZONE_ID,
    api: api as never,
    now: () => new Date("2026-10-19T10:00:00.000Z"),
    log: (line: string) => calls.log.push(line),
    acceptInAudit: async () => {
      calls.accepted++;
    },
    terraform: async (
      args: string[],
      o: { cwd: string; env: Record<string, string>; capture?: boolean },
    ) => {
      calls.terraform.push({ args, env: o.env });
      if (opts.terraformFails && args[0] === opts.terraformFails)
        return { exitCode: 1, stdout: "" };
      if (args[0] === "plan") writeFileSync(join(o.cwd, "tfplan"), "plan-bytes");
      if (args[0] === "show") return { exitCode: 0, stdout: PLAN_JSON };
      return { exitCode: 0, stdout: "" };
    },
  };
  return { calls, deps };
}

await test("plan mints exactly the stack's grants and never shows Terraform the operator token", async () => {
  const root = infraRoot();
  const { calls, deps } = fakes();
  await runInfraCommand(["plan", "ota-updates"], { ...deps, infraRoot: root });

  assert.equal(calls.created.length, 1);
  const created = calls.created[0];
  assert.equal(created.name, "hatchkit-terraform-ota-updates-20261019T100000Z");
  assert.equal(created.expiresOn, "2026-10-19T11:00:00Z");
  assert.deepEqual(created.policies, [
    {
      effect: "allow",
      permission_groups: [
        { id: "id:Workers Scripts Write" },
        { id: "id:Workers R2 Storage Write" },
      ],
      resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
    },
    {
      effect: "allow",
      permission_groups: [
        { id: "id:Zone Read" },
        { id: "id:Workers Routes Write" },
        { id: "id:DNS Write" },
      ],
      resources: { [`com.cloudflare.api.account.zone.${ZONE_ID}`]: "*" },
    },
  ]);
  assert.deepEqual(
    calls.terraform.map((c) => c.args[0]),
    ["init", "plan", "show"],
  );
  for (const call of calls.terraform) {
    assert.deepEqual(call.env, { CLOUDFLARE_API_TOKEN: "minted-1" });
    assert.ok(!JSON.stringify(call).includes(OPERATOR));
  }
  assert.ok(calls.terraform[1].args.some((a) => a.startsWith("-out=") && a.endsWith("tfplan")));
  assert.deepEqual(calls.deleted, ["tok1"]);
  assert.equal(calls.accepted, 0, "a plan accepts nothing in the audit");
  assert.match(calls.log.join("\n"), /MUST BE REPLACED\s+cloudflare_workers_custom_domain\.ota/);
});

await test("the run token name is one the Cloudflare audit recognises", async () => {
  const { TERRAFORM_TOKEN_NAME } = await import("./src/audit/cloudflare.js");
  const { calls, deps } = fakes();
  await runInfraCommand(["plan", "ota-updates"], { ...deps, infraRoot: infraRoot() });
  assert.match(String(calls.created[0].name), TERRAFORM_TOKEN_NAME);
});

await test("apply refuses without a saved plan and mints nothing", async () => {
  const { calls, deps } = fakes();
  await assert.rejects(
    runInfraCommand(["apply", "ota-updates"], { ...deps, infraRoot: infraRoot() }),
    /No saved plan[\s\S]*hatchkit infra plan ota-updates/,
  );
  assert.equal(calls.created.length, 0);
});

await test("apply applies the saved plan with a fresh token, then accepts the stack in the audit", async () => {
  const root = infraRoot();
  const { calls, deps } = fakes();
  await runInfraCommand(["plan", "ota-updates"], { ...deps, infraRoot: root });
  await runInfraCommand(["apply", "ota-updates"], { ...deps, infraRoot: root });
  const apply = calls.terraform.find((c) => c.args[0] === "apply");
  assert.ok(apply);
  assert.equal(apply.args.at(-1), join(root, "terraform", "stacks", "ota-updates", "tfplan"));
  assert.deepEqual(apply.env, { CLOUDFLARE_API_TOKEN: "minted-2" });
  assert.deepEqual(calls.deleted, ["tok1", "tok2"]);
  assert.equal(calls.accepted, 1);
  assert.equal(existsSync(join(root, "terraform", "stacks", "ota-updates", "tfplan")), false);
});

await test("a failed terraform run still revokes the token and accepts nothing", async () => {
  const root = infraRoot();
  const { calls, deps } = fakes({ terraformFails: "apply" });
  writeFileSync(join(root, "terraform", "stacks", "ota-updates", "tfplan"), "x");
  await assert.rejects(
    runInfraCommand(["apply", "ota-updates"], { ...deps, infraRoot: root }),
    /apply failed/,
  );
  assert.deepEqual(calls.deleted, ["tok1"]);
  assert.equal(calls.accepted, 0);
});

await test("a read-back broader than the stack's grants is revoked before Terraform runs", async () => {
  const { calls, deps } = fakes({
    readback: [
      {
        effect: "allow",
        permission_groups: [
          { id: "x", name: "Workers Scripts Write" },
          { id: "y", name: "Workers R2 Storage Write" },
        ],
        resources: { "com.cloudflare.api.account.*": "*" },
      },
      {
        effect: "allow",
        permission_groups: [
          { id: "z", name: "Zone Read" },
          { id: "r", name: "Workers Routes Write" },
          { id: "d", name: "DNS Write" },
        ],
        resources: { [`com.cloudflare.api.account.zone.${ZONE_ID}`]: "*" },
      },
    ],
  });
  await assert.rejects(
    runInfraCommand(["plan", "ota-updates"], { ...deps, infraRoot: infraRoot() }),
    /policy is not exactly[\s\S]*does not hand its own Cloudflare token to Terraform/,
  );
  assert.deepEqual(calls.deleted, ["tok1"]);
  assert.equal(calls.terraform.length, 0);
});

await test("an unknown stack or action prints the usage", async () => {
  const { deps } = fakes();
  await assert.rejects(
    runInfraCommand(["plan", "nope"], { ...deps, infraRoot: infraRoot() }),
    /Unknown stack[\s\S]*ota-updates/,
  );
  await assert.rejects(
    runInfraCommand(["destroy", "ota-updates"], { ...deps, infraRoot: infraRoot() }),
    /Usage: hatchkit infra/,
  );
});

await test("output reads local state without minting a token", async () => {
  const { calls, deps } = fakes();
  await runInfraCommand(["output", "ota-updates", "publish_tokens"], {
    ...deps,
    infraRoot: infraRoot(),
  });
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.terraform[0].args, ["output", "-json", "publish_tokens"]);
  assert.deepEqual(calls.terraform[0].env, {});
});

await test("the default audit step accepts the stack's Worker and bucket", async () => {
  const root = infraRoot();
  const { deps } = fakes();
  writeFileSync(join(root, "terraform", "stacks", "ota-updates", "tfplan"), "x");
  const { acceptInAudit: _drop, ...withoutAccept } = deps;
  await runInfraCommand(["apply", "ota-updates"], { ...withoutAccept, infraRoot: root });
  const accepted = getAuditConfig().accepted;
  assert.ok(accepted?.workers?.includes("ota-updates"));
  assert.ok(accepted?.buckets?.includes("ota-updates"));
});

await test("policiesMatchGrants ignores order but nothing else", async () => {
  const grants = stackGrants(INFRA_STACKS["ota-updates"], ACCOUNT, ZONE_ID);
  const policy = (names: string[], resource: string) => ({
    effect: "allow",
    permission_groups: names.map((name) => ({ id: name, name })),
    resources: { [resource]: "*" },
  });
  const zone = policy(["DNS Write", "Zone Read", "Workers Routes Write"], zoneResource(ZONE_ID));
  const account = policy(
    ["Workers R2 Storage Write", "Workers Scripts Write"],
    accountResource(ACCOUNT),
  );
  assert.equal(policiesMatchGrants([zone, account], grants), true);
  assert.equal(policiesMatchGrants([account], grants), false);
  assert.equal(policiesMatchGrants([zone, account, account], grants), false);
  assert.equal(
    policiesMatchGrants(
      [zone, policy(["Workers Scripts Write"], accountResource(ACCOUNT))],
      grants,
    ),
    false,
  );
  assert.equal(policiesMatchGrants([zone, { ...account, effect: "deny" }], grants), false);
});

await test("the plan summary flags replacements and destroys", async () => {
  const changes = summarizePlan(PLAN_JSON);
  assert.deepEqual(
    changes.map((c) => c.address),
    [
      "cloudflare_r2_bucket.bundles",
      "cloudflare_workers_script.ota",
      "cloudflare_workers_custom_domain.ota",
    ],
  );
  const text = renderPlanSummary([...changes, { address: "x.y", actions: ["delete"] }]);
  assert.match(text, /MUST BE REPLACED\s+cloudflare_workers_custom_domain\.ota/);
  assert.match(text, /DESTROY\s+x\.y/);
  assert.match(text, /1 replacement\(s\), 1 destroy\(s\)/);
  assert.equal(renderPlanSummary([]), "No changes.");
});

await test("every registered stack exists in this checkout", async () => {
  const realInfra = join(dirname(fileURLToPath(import.meta.url)), "..", "infra");
  for (const [name, stack] of Object.entries(INFRA_STACKS)) {
    assert.ok(
      existsSync(join(realInfra, "terraform", "stacks", stack.dir, "main.tf")),
      `${name}: infra/terraform/stacks/${stack.dir}/main.tf is missing`,
    );
  }
});

if (failures.length) {
  console.error(`\n${failures.length} failing:\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\ninfra stacks: all passed");
