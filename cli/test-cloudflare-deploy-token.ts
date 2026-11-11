/** Offline safety regressions. No provider, GitHub, keychain, or local user state. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareDeployTokenRecord } from "./src/config.js";
import type { CloudflareDeployDependencies } from "./src/deploy/gh-actions-secrets.js";

const conf = mkdtempSync(join(tmpdir(), "cf-deploy-test-"));
process.env.HATCHKIT_CONF_DIR = conf;
// Fail immediately if a regression escapes the injected dependencies.
const keychainStub = `const deny = async () => { throw new Error("Unexpected OS keychain access in offline test"); };
export default { getPassword: deny, setPassword: deny, deletePassword: deny, findCredentials: deny, findPassword: deny };`;
const moduleGuard = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "keytar")
      return {
        url: `data:text/javascript,${encodeURIComponent(keychainStub)}`,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
globalThis.fetch = async () => {
  throw new Error("Unexpected network access in offline test");
};
const {
  classifyDeployTokenPolicies,
  mintWorkerDeployToken,
  workerDeployTokenPolicy,
  withPropagationRetry,
  WORKER_TOKEN_GROUP,
} = await import("./src/deploy/cloudflare-deploy-token.js");
const { setCloudflareDeploySecrets } = await import("./src/deploy/gh-actions-secrets.js");
const { findCloudflareDeployTokenFindings } = await import("./src/secrets/isolation.js");
const { CloudflareApi } = await import("./src/utils/cloudflare-api.js");
const workerId = "a".repeat(32);
const accountId = "b".repeat(32);
const secretValue = "fixture-value-never-in-results";
// Independent fixture matching Cloudflare dashboard's JSON Payload review.
const dashboardPolicy = [
  {
    effect: "allow",
    permission_groups: [{ id: "editor" }],
    resources: {
      [`com.cloudflare.api.account.${accountId}`]: {
        [`com.cloudflare.edge.worker.script.${workerId}`]: "*",
      },
    },
  },
];
const policy = () =>
  structuredClone(dashboardPolicy).map((p) => ({
    ...p,
    permission_groups: [{ id: "editor", name: WORKER_TOKEN_GROUP }],
  }));
const record = (): CloudflareDeployTokenRecord => ({
  worker: "site",
  workerId,
  accountId,
  tokenId: "old-token-id",
  tokenName: "hatchkit-site-worker",
  scope: "worker",
  repo: "owner/site",
  mintedAt: "before",
  secretUpdatedAt: "before",
  accountSecretUpdatedAt: "before",
});
const input = { projectDir: conf, repoSlug: "owner/site", workerName: "site" };
function fixture() {
  const mutations: string[] = [];
  const saved: CloudflareDeployTokenRecord[] = [];
  let written = false;
  const deps: CloudflareDeployDependencies = {
    provisioner: { token: "fixture-provisioner", accountId, source: "fixture" },
    records: {},
    api: {
      getWorker: async () => ({ id: workerId, name: "site" }),
      createWorker: async () => {
        mutations.push("create-worker");
        return { id: workerId, name: "site" };
      },
      permissionGroupIds: async (_account, names) => {
        assert.deepEqual(names, [WORKER_TOKEN_GROUP]);
        return ["editor"];
      },
      createAccountToken: async (args) => {
        assert.deepEqual(args.policies, dashboardPolicy);
        mutations.push("mint");
        return { id: "new-token-id", value: secretValue };
      },
      getAccountToken: async () => ({
        id: "new-token-id",
        name: "hatchkit-site-worker",
        status: "active",
        policies: policy(),
      }),
      deleteAccountToken: async (_account, id) => {
        mutations.push(`delete:${id}`);
        return "deleted";
      },
    },
    listSecrets: async () =>
      ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].map((name) => ({
        name,
        updatedAt: written ? "after" : "before",
      })),
    setSecret: async (_cwd, _repo, name, value) => {
      assert.equal(value, name === "CLOUDFLARE_API_TOKEN" ? secretValue : accountId);
      assert.notEqual(value, deps.provisioner!.token);
      mutations.push(`set:${name}`);
      written = true;
    },
    saveRecord: (value) => {
      saved.push(value);
      mutations.push("record");
    },
    check: async () => [],
  };
  return { deps, mutations, saved };
}
let count = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  count++;
  console.log(`ok ${name}`);
}
try {
  await test("exact Worker Editor policy only; reject broad, empty, wrong-role and multi-policy grants", () => {
    const target = { accountId, workerId };
    assert.deepEqual(
      workerDeployTokenPolicy({ accountId, workerId, groupId: "editor" }),
      dashboardPolicy,
    );
    assert.equal(classifyDeployTokenPolicies(policy(), target), "worker");
    for (const policies of [
      [],
      [...policy(), ...policy()],
      [{ ...policy()[0], permission_groups: [] }],
      [
        {
          ...policy()[0],
          permission_groups: [{ id: "admin", name: "Individual Workers Admin" }],
        },
      ],
      [
        {
          ...policy()[0],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
      [{ ...policy()[0], resources: {} }],
      [
        {
          ...policy()[0],
          resources: { [`com.cloudflare.edge.worker.script.${workerId}`]: "*" },
        },
      ],
      [
        {
          ...policy()[0],
          resources: {
            [`com.cloudflare.api.account.${"c".repeat(32)}`]:
              dashboardPolicy[0].resources[`com.cloudflare.api.account.${accountId}`],
          },
        },
      ],
      [
        {
          ...policy()[0],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              [`com.cloudflare.edge.worker.script.${workerId}`]: "*",
              [`com.cloudflare.edge.worker.script.${"c".repeat(32)}`]: "*",
            },
          },
        },
      ],
      [
        {
          ...policy()[0],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              "com.cloudflare.edge.worker.script.*": "*",
            },
          },
        },
      ],
      [
        {
          ...policy()[0],
          resources: { [`com.cloudflare.edge.worker.script.${workerId}`]: {} },
        },
      ],
    ]) {
      assert.equal(classifyDeployTokenPolicies(policies, target), "broader");
    }
    assert.throws(() => workerDeployTokenPolicy({ accountId, workerId: "*", groupId: "editor" }));
  });
  await test("mint rejection never requests an account-wide fallback", async () => {
    const f = fixture();
    f.deps.api.createAccountToken = async () => {
      f.mutations.push("mint");
      throw Error("refused");
    };
    await assert.rejects(
      mintWorkerDeployToken(f.deps.api, {
        accountId,
        workerId,
        worker: "site",
        check: async () => [],
      }),
    );
    assert.deepEqual(f.mutations, ["mint"]);
  });
  await test("policy readback mismatch revokes candidate before publication", async () => {
    const f = fixture();
    f.deps.api.getAccountToken = async () => ({
      id: "new",
      name: "site",
      status: "active",
      policies: [],
    });
    const r = await setCloudflareDeploySecrets(input, f.deps);
    assert.equal(r.ok, false);
    assert.deepEqual(f.mutations, ["mint", "delete:new-token-id"]);
  });
  await test("thrown or refused preflight cleans candidate, without leaking values", async () => {
    for (const check of [
      async () => ["denied"],
      async () => {
        throw Error(secretValue);
      },
    ]) {
      const f = fixture();
      f.deps.check = check;
      const r = await setCloudflareDeploySecrets(input, f.deps);
      assert.equal(r.ok, false);
      assert.deepEqual(f.mutations, ["mint", "delete:new-token-id"]);
      assert.ok(!JSON.stringify(r).includes(secretValue));
    }
  });
  await test("cleanup failure is explicit at mint boundary", async () => {
    const f = fixture();
    f.deps.api.deleteAccountToken = async () => {
      throw Error(secretValue);
    };
    await assert.rejects(
      mintWorkerDeployToken(f.deps.api, {
        accountId,
        workerId,
        worker: "site",
        check: async () => ["denied"],
      }),
      /cleanup also failed/,
    );
  });
  await test("dry run creates no Worker, token, secret or record", async () => {
    const f = fixture();
    f.deps.api.getWorker = async () => null;
    const r = await setCloudflareDeploySecrets(
      { ...input, dryRun: true, createWorker: true },
      f.deps,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(f.mutations, []);
    assert.ok(r.plan.some((p) => p.includes("create empty")));
  });
  await test("unreadable metadata and cross-repo/account records fail before mutation", async () => {
    for (const mode of ["metadata", "repo", "account"]) {
      const f = fixture();
      if (mode === "metadata") f.deps.listSecrets = async () => null;
      else
        f.deps.records.site = {
          ...record(),
          [mode === "repo" ? "repo" : "accountId"]: "other",
        };
      assert.equal((await setCloudflareDeploySecrets(input, f.deps)).ok, false);
      assert.deepEqual(f.mutations, []);
    }
  });
  await test("idempotence verifies active policy and both secret timestamps", async () => {
    const f = fixture();
    f.deps.records.site = record();
    assert.equal((await setCloudflareDeploySecrets(input, f.deps)).inSync, true);
    assert.deepEqual(f.mutations, []);
    f.deps.api.getAccountToken = async () => ({
      id: "old-token-id",
      name: "site",
      status: "active",
      policies: [],
    });
    assert.equal(
      (await setCloudflareDeploySecrets({ ...input, dryRun: true }, f.deps)).inSync,
      undefined,
    );
  });
  await test("account secret fails first: candidate revoked, old token preserved", async () => {
    const f = fixture();
    f.deps.records.site = record();
    f.deps.setSecret = async () => {
      throw Error(secretValue);
    };
    const r = await setCloudflareDeploySecrets({ ...input, rotate: true }, f.deps);
    assert.equal(r.ok, false);
    assert.deepEqual(f.mutations, ["mint", "delete:new-token-id"]);
    assert.match(r.error!, /unused candidate revoked/);
  });
  await test("unknown token-secret write outcome retains both tokens", async () => {
    const f = fixture();
    f.deps.records.site = record();
    const write = f.deps.setSecret;
    f.deps.setSecret = async (...args) => {
      if (args[2] === "CLOUDFLARE_API_TOKEN") throw Error(secretValue);
      await write(...args);
    };
    const r = await setCloudflareDeploySecrets({ ...input, rotate: true }, f.deps);
    assert.equal(r.ok, false);
    assert.match(r.error!, /outcome unknown/);
    assert.deepEqual(f.mutations, ["mint", "set:CLOUDFLARE_ACCOUNT_ID"]);
    assert.ok(!JSON.stringify(r).includes(secretValue));
  });
  await test("successful rotation records replacement before revoking only recorded predecessor", async () => {
    const f = fixture();
    f.deps.records.site = record();
    const r = await setCloudflareDeploySecrets({ ...input, rotate: true }, f.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(f.mutations, [
      "mint",
      "set:CLOUDFLARE_ACCOUNT_ID",
      "set:CLOUDFLARE_API_TOKEN",
      "record",
      "delete:old-token-id",
    ]);
    assert.ok(!JSON.stringify(f.saved).includes(secretValue));
  });
  await test("failed readback or config save retains previous token", async () => {
    for (const mode of ["metadata", "save"]) {
      const f = fixture();
      f.deps.records.site = record();
      let reads = 0;
      const list = f.deps.listSecrets;
      if (mode === "metadata")
        f.deps.listSecrets = async (repo) => (++reads > 1 ? null : list(repo));
      else
        f.deps.saveRecord = () => {
          throw Error("disk full");
        };
      const r = await setCloudflareDeploySecrets({ ...input, rotate: true }, f.deps);
      assert.equal(r.ok, false);
      assert.ok(!f.mutations.some((m) => m.startsWith("delete:")));
    }
  });
  await test("failed old-token cleanup does not report success", async () => {
    const f = fixture();
    f.deps.records.site = record();
    f.deps.api.deleteAccountToken = async () => {
      throw Error(secretValue);
    };
    const r = await setCloudflareDeploySecrets({ ...input, rotate: true }, f.deps);
    assert.equal(r.ok, false);
    assert.match(r.error!, /previous token cleanup failed/);
  });
  await test("doctor treats unknown policy as unverified and account-wide as failure", () => {
    const base = {
      repo: "owner/site",
      worker: "site",
      record: record(),
      secrets: [{ name: "CLOUDFLARE_API_TOKEN", updatedAt: "before" }],
    };
    assert.equal(findCloudflareDeployTokenFindings(base)[0].severity, "warn");
    assert.equal(
      findCloudflareDeployTokenFindings({
        ...base,
        token: { status: "active", scope: "account" },
      })[0].severity,
      "fail",
    );
    assert.match(
      findCloudflareDeployTokenFindings({
        ...base,
        token: { status: "active", scope: "worker" },
      })[0].what,
      /bindings.*outside this audit/,
    );
  });
  await test("propagation retries are bounded and cannot skip validation", async () => {
    let calls = 0;
    assert.deepEqual(
      await withPropagationRetry(async () => (++calls === 2 ? [] : ["denied"]), {
        attempts: 2,
        sleep: async () => {},
      })("fixture"),
      [],
    );
    assert.equal(calls, 2);
    calls = 0;
    assert.deepEqual(
      await withPropagationRetry(
        async () => {
          calls++;
          return ["denied"];
        },
        { attempts: 0 },
      )("fixture"),
      ["denied"],
    );
    assert.equal(calls, 1);
  });
  await test("API distinguishes missing Worker from denied reads; names encoded", async () => {
    const original = globalThis.fetch;
    try {
      let status = 403;
      globalThis.fetch = async (url) => {
        assert.ok(String(url).endsWith("/workers/workers/site%2Fname"));
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "refused" }],
          }),
          { status },
        );
      };
      const api = new CloudflareApi({ token: "fixture" });
      await assert.rejects(api.getWorker(accountId, "site/name"));
      status = 404;
      assert.equal(await api.getWorker(accountId, "site/name"), null);
    } finally {
      globalThis.fetch = original;
    }
  });
  await test("several Workers: one policy names exactly that set; subsets and supersets are broader", () => {
    const apiId = "c".repeat(32);
    const both = { accountId, workerId, workerIds: [workerId, apiId] };
    const twoPolicy = [
      {
        effect: "allow",
        permission_groups: [{ id: "editor", name: WORKER_TOKEN_GROUP }],
        resources: {
          [`com.cloudflare.api.account.${accountId}`]: {
            [`com.cloudflare.edge.worker.script.${workerId}`]: "*",
            [`com.cloudflare.edge.worker.script.${apiId}`]: "*",
          },
        },
      },
    ];
    assert.deepEqual(
      workerDeployTokenPolicy({ accountId, workerIds: [workerId, apiId], groupId: "editor" }),
      twoPolicy.map((p) => ({ ...p, permission_groups: [{ id: "editor" }] })),
    );
    assert.equal(classifyDeployTokenPolicies(twoPolicy as never, both), "worker");
    // The same token read against only one of its Workers names too much.
    assert.equal(
      classifyDeployTokenPolicies(twoPolicy as never, { accountId, workerId }),
      "broader",
    );
    // A one-Worker token does not cover the set.
    assert.equal(classifyDeployTokenPolicies(policy(), both), "broader");
    assert.throws(() =>
      workerDeployTokenPolicy({ accountId, workerIds: [workerId, workerId], groupId: "editor" }),
    );
    assert.throws(() => workerDeployTokenPolicy({ accountId, workerIds: [], groupId: "editor" }));
  });
  await test("several Workers: one token, checked against each, recorded under the first", async () => {
    const apiId = "c".repeat(32);
    const f = fixture();
    const checked: string[] = [];
    f.deps.api.getWorker = async (_a, name) =>
      name === "site" ? { id: workerId, name } : { id: apiId, name };
    f.deps.api.createAccountToken = async (args) => {
      assert.deepEqual(
        Object.keys(Object.values(args.policies[0].resources)[0]).sort(),
        [
          `com.cloudflare.edge.worker.script.${workerId}`,
          `com.cloudflare.edge.worker.script.${apiId}`,
        ].sort(),
      );
      assert.equal(args.name, "hatchkit-site+site-api-workers");
      f.mutations.push("mint");
      return { id: "new-token-id", value: secretValue };
    };
    f.deps.api.getAccountToken = async () => ({
      id: "new-token-id",
      name: "hatchkit-site+site-api-workers",
      status: "active",
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "editor", name: WORKER_TOKEN_GROUP }],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              [`com.cloudflare.edge.worker.script.${apiId}`]: "*",
              [`com.cloudflare.edge.worker.script.${workerId}`]: "*",
            },
          },
        },
      ],
    });
    f.deps.check = async (_value, _account, worker) => {
      checked.push(worker);
      return [];
    };
    const r = await setCloudflareDeploySecrets({ ...input, alsoWorkers: ["site-api"] }, f.deps);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(checked, ["site", "site-api"]);
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].worker, "site");
    assert.deepEqual(f.saved[0].workers, ["site", "site-api"]);
    assert.deepEqual(f.saved[0].workerIds, [workerId, apiId]);
    assert.ok(!JSON.stringify(f.saved).includes(secretValue));

    // Read back as in sync with the record it wrote.
    const again = fixture();
    again.deps.api.getWorker = f.deps.api.getWorker;
    again.deps.api.getAccountToken = f.deps.api.getAccountToken;
    again.deps.records.site = { ...f.saved[0], tokenId: "new-token-id" };
    again.deps.listSecrets = async () =>
      ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].map((name) => ({
        name,
        updatedAt: f.saved[0].secretUpdatedAt!,
      }));
    const sync = await setCloudflareDeploySecrets(
      { ...input, alsoWorkers: ["site-api"] },
      again.deps,
    );
    assert.equal(sync.inSync, true);
    // The same record without its second Worker is not in sync.
    const one = await setCloudflareDeploySecrets({ ...input, dryRun: true }, again.deps);
    assert.equal(one.inSync, undefined);
  });
  await test("several Workers: refuse a further Worker with its own record, or one named twice", async () => {
    const f = fixture();
    f.deps.records["site-api"] = { ...record(), worker: "site-api" };
    const r = await setCloudflareDeploySecrets({ ...input, alsoWorkers: ["site-api"] }, f.deps);
    assert.equal(r.ok, false);
    assert.match(r.error!, /own token record/);
    const twice = await setCloudflareDeploySecrets(
      { ...input, alsoWorkers: ["site"] },
      fixture().deps,
    );
    assert.equal(twice.ok, false);
    assert.deepEqual(f.mutations, []);
  });
  await test("several Workers: a missing further Worker stops before anything is created", async () => {
    const f = fixture();
    f.deps.api.getWorker = async (_a, name) => (name === "site" ? { id: workerId, name } : null);
    const r = await setCloudflareDeploySecrets({ ...input, alsoWorkers: ["site-api"] }, f.deps);
    assert.equal(r.ok, false);
    assert.match(r.error!, /site-api does not exist/);
    assert.deepEqual(f.mutations, []);
    const plan = await setCloudflareDeploySecrets(
      { ...input, alsoWorkers: ["site-api"], createWorker: true, dryRun: true },
      f.deps,
    );
    assert.equal(plan.ok, true);
    assert.ok(plan.plan.some((p) => p === "create empty Worker site-api"));
    assert.ok(plan.plan.some((p) => p.includes("exactly the Workers site, site-api")));
    assert.deepEqual(f.mutations, []);
  });
  console.log(`${count} Cloudflare deploy-token regressions passed`);
} finally {
  moduleGuard.deregister();
  rmSync(conf, { recursive: true, force: true });
}
