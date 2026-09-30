/** Offline adversarial tests. No keytar/config module, credentials, network,
 * test mail, AWS policy simulation or real keychain calls. */
import assert from "node:assert/strict";
import { operatorScope, senderBoundaryPolicy } from "./src/provision/ses-operator-policy.js";
import { senderPolicy, senderSpec } from "./src/provision/ses-project-policy.js";
import {
  type SenderDeps,
  type SenderRecord,
  auditSender,
  ensureSender,
  retirePreviousSenderKey,
  senderRollbackRecipe,
} from "./src/provision/ses-project-sender.js";

const spec = senderSpec("project-a", "a.example.com", "123456789012", "eu-west-1");
const opts = {
  project: spec.project,
  domain: spec.domain,
  region: spec.region,
};
const other = senderSpec("project-b", "b.example.com", spec.account, spec.region);

type Statement = {
  Effect: string;
  Action?: string;
  NotAction?: string;
  Resource?: string | string[];
  NotResource?: string[];
  Condition?: Record<string, Record<string, string | string[]>>;
};
/** Independent IAM subset evaluator. This is simulated policy evidence, not
 * a claim that AWS accepted a request or parsed raw MIME this way. */
function allowed(
  action: string,
  resources: string[],
  context: Record<string, string>,
  extraAllow = false,
): boolean {
  let permit = true;
  for (const resource of resources) {
    let allow = extraAllow;
    for (const st of senderPolicy(spec).Statement as Statement[]) {
      if ((st.Action && st.Action !== action) || st.NotAction === action) continue;
      const match = (v: string | string[]) =>
        v === "*" || (Array.isArray(v) ? v : [v]).includes(resource);
      if ((st.Resource && !match(st.Resource)) || (st.NotResource && match(st.NotResource)))
        continue;
      const meets = Object.entries(st.Condition ?? {}).every(([op, entries]) =>
        Object.entries(entries).every(([k, v]) => {
          const equal = (Array.isArray(v) ? v : [v]).includes(context[k]);
          return op === "StringEquals" ? equal : !equal;
        }),
      );
      if (!meets) continue;
      if (st.Effect === "Deny") return false;
      if (st.Effect === "Allow") allow = true;
    }
    permit &&= allow;
  }
  return permit && resources.length > 0;
}
const context = {
  "ses:FromAddress": spec.from[0],
  "ses:TenantName": spec.tenant,
  "ses:ApiVersion": "2019-09-27",
  "aws:RequestedRegion": spec.region,
};
assert(allowed("ses:SendEmail", [spec.identityArn, spec.configurationSetArn], context));
for (const extraAllow of [false, true]) {
  for (const action of [
    "ses:SendRawEmail",
    "ses:SendBulkEmail",
    "iam:CreateAccessKey",
    "iam:PutUserPolicy",
    "sns:Publish",
    "s3:GetObject",
    "sts:AssumeRole",
  ])
    assert(!allowed(action, [spec.identityArn], context, extraAllow), action);
  for (const arn of [
    other.identityArn,
    other.configurationSetArn,
    "*",
    spec.identityArn.replace("eu-west-1", "us-east-1"),
    `arn:aws:ses:${spec.region}:999999999999:identity/${spec.identity}`,
  ])
    assert(!allowed("ses:SendEmail", [arn], context, extraAllow), arn);
  for (const key of Object.keys(context)) {
    const missing = { ...context };
    delete missing[key as keyof typeof context];
    assert(!allowed("ses:SendEmail", [spec.identityArn], missing, extraAllow), `missing ${key}`);
    assert(
      !allowed("ses:SendEmail", [spec.identityArn], { ...context, [key]: "foreign" }, extraAllow),
      `foreign ${key}`,
    );
  }
  // Forged From header, foreign explicit source ARN, SMTP (raw v1), and
  // legacy SendEmail cannot turn a leaked project key into a second sender.
  assert(
    !allowed(
      "ses:SendEmail",
      [spec.identityArn],
      { ...context, "ses:FromAddress": other.from[0] },
      extraAllow,
    ),
  );
  assert(!allowed("ses:SendEmail", [spec.identityArn, other.identityArn], context, extraAllow));
  assert(
    !allowed(
      "ses:SendEmail",
      [spec.identityArn],
      { ...context, "ses:ApiVersion": "2010-12-01" },
      extraAllow,
    ),
  );
}
for (const from of [
  ["*@mail.a.example.com"],
  ["x@b.example.com"],
  ["name <x@mail.a.example.com>"],
  [],
  ["x\r\n@mail.a.example.com"],
])
  assert.throws(() => senderSpec(spec.project, spec.domain, spec.account, spec.region, from));
assert.throws(() => senderSpec(spec.project, spec.domain, spec.account, "us-gov-west-1"));
console.log(
  "✓ policy denies cross-project sender/ARN/region, omitted or foreign tenant, SMTP/v1 and every non-send action, even with overlapping allow",
);

function fake() {
  let record: SenderRecord | null = null;
  const state = {
    user: null as null | Record<string, unknown>,
    tenant: null as null | Record<string, unknown>,
    config: null as null | Record<string, unknown>,
    policy: "",
    associations: new Set<string>(),
    keys: [] as { AccessKeyId: string; Status: string }[],
    seq: 0,
    verified: true,
    boundaryDrift: false,
    identityPolicies: {},
    attached: false,
    groups: false,
    extraInline: false,
    login: false,
    extraTenant: false,
    foreignResource: false,
    account: spec.account,
    fail: "",
    saveFail: false,
    failWhenReady: false,
    uncertainKey: false,
    calls: [] as string[],
    writes: [] as string[],
  };
  const notFound = (name: string): never => {
    const error = new Error(name);
    error.name = name;
    throw error;
  };
  const send = async (command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }) => {
    const op = command.constructor.name.replace(/Command$/, "");
    const input = command.input;
    state.calls.push(op);
    if (/^(Create|Put|Delete)/.test(op)) state.writes.push(op);
    if (state.fail === op) {
      state.fail = "";
      return notFound("AccessDeniedException");
    }
    switch (op) {
      case "GetPolicy":
        return {
          Policy: {
            Arn: operatorScope(spec.account, spec.region).boundaryArn,
            DefaultVersionId: "v1",
          },
        };
      case "GetPolicyVersion":
        return {
          PolicyVersion: {
            Document: encodeURIComponent(
              JSON.stringify(
                state.boundaryDrift
                  ? { Version: "2012-10-17", Statement: [] }
                  : senderBoundaryPolicy(spec.account, spec.region),
              ),
            ),
          },
        };
      case "GetCallerIdentity":
        return { Account: state.account };
      case "GetEmailIdentity":
        return {
          VerifiedForSendingStatus: state.verified,
          Policies: state.identityPolicies,
        };
      case "GetUser":
        return state.user ? { User: state.user } : notFound("NoSuchEntityException");
      case "GetTenant":
        return state.tenant ? { Tenant: state.tenant } : notFound("NotFoundException");
      case "GetConfigurationSet":
        return state.config ?? notFound("NotFoundException");
      case "ListResourceTenants":
        return {
          ResourceTenants: [
            ...(state.associations.has(input.ResourceArn as string)
              ? [{ TenantName: spec.tenant }]
              : []),
            ...(state.extraTenant ? [{ TenantName: other.tenant }] : []),
          ],
        };
      case "ListTenantResources":
        return {
          TenantResources: [
            ...state.associations,
            ...(state.foreignResource ? [other.identityArn] : []),
          ].map((ResourceArn) => ({ ResourceArn })),
        };
      case "CreateTenant":
        state.tenant = {
          TenantName: input.TenantName,
          TenantArn: `arn:aws:ses:${spec.region}:${spec.account}:tenant/${spec.tenant}/id`,
          Tags: input.Tags,
          SendingStatus: "ENABLED",
        };
        return { TenantArn: state.tenant.TenantArn };
      case "CreateConfigurationSet":
        state.config = { Tags: input.Tags };
        return {};
      case "CreateTenantResourceAssociation":
        state.associations.add(input.ResourceArn as string);
        return {};
      case "CreateUser":
        state.user = {
          UserId: "OWNED-ID",
          UserName: spec.user,
          Path: input.Path,
          PermissionsBoundary: {
            PermissionsBoundaryArn: input.PermissionsBoundary,
          },
          Tags: input.Tags,
          Arn: `arn:aws:iam::${spec.account}:user/hatchkit/ses/${spec.user}`,
        };
        return { User: state.user };
      case "PutUserPolicy":
        state.policy = input.PolicyDocument as string;
        return {};
      case "CreateAccessKey": {
        const id = `MOCKKEY${++state.seq}`;
        state.keys.push({ AccessKeyId: id, Status: "Active" });
        if (state.uncertainKey) {
          state.uncertainKey = false;
          return notFound("TimeoutError");
        }
        return {
          AccessKey: {
            AccessKeyId: id,
            SecretAccessKey: `mock-secret-${state.seq}`,
          },
        };
      }
      case "ListUserPolicies":
        return {
          PolicyNames: ["hatchkit-ses-sender-v1", ...(state.extraInline ? ["evil"] : [])],
        };
      case "ListAttachedUserPolicies":
        return {
          AttachedPolicies: state.attached ? [{ PolicyArn: "admin" }] : [],
        };
      case "ListGroupsForUser":
        return { Groups: state.groups ? [{ GroupName: "admin" }] : [] };
      case "GetLoginProfile":
        return state.login ? { LoginProfile: {} } : notFound("NoSuchEntityException");
      case "GetUserPolicy":
        return { PolicyDocument: encodeURIComponent(state.policy) };
      case "ListAccessKeys":
        return { AccessKeyMetadata: state.keys };
      case "DeleteAccessKey":
        state.keys = state.keys.filter((k) => k.AccessKeyId !== input.AccessKeyId);
        return {};
      case "DeleteUserPolicy":
        state.policy = "";
        return {};
      case "DeleteUser":
        state.user = null;
        return {};
      case "DeleteTenantResourceAssociation":
        state.associations.delete(input.ResourceArn as string);
        return {};
      case "DeleteConfigurationSet":
        state.config = null;
        return {};
      case "DeleteTenant":
        state.tenant = null;
        return {};
      default:
        throw new Error(`Unmocked AWS operation ${op}`);
    }
  };
  const deps = {
    iam: { send },
    ses: { send },
    sts: { send },
    store: {
      async read() {
        return structuredClone(record);
      },
      async write(value: SenderRecord | null) {
        state.writes.push("store");
        if (state.saveFail || (state.failWhenReady && value?.phase === "ready")) {
          state.failWhenReady = false;
          state.saveFail = false;
          throw new Error("mock store failed");
        }
        record = structuredClone(value);
      },
    },
  } as unknown as SenderDeps;
  return { deps, state, read: () => structuredClone(record) };
}
{
  const f = fake();
  const dry = await ensureSender(f.deps, { ...opts, dryRun: true });
  assert.equal(dry.record, undefined);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.read(), null);
  const result = await ensureSender(f.deps, opts);
  assert(result.record?.current);
  assert.equal(result.record.spec.identityArn, spec.identityArn);
  assert.deepEqual(f.state.user?.PermissionsBoundary, {
    PermissionsBoundaryArn: operatorScope(spec.account, spec.region).boundaryArn,
  });
  const writes = f.state.writes.length;
  assert.deepEqual((await ensureSender(f.deps, opts)).changes, []);
  assert.equal(f.state.writes.length, writes);
  await ensureSender(f.deps, { ...opts, dryRun: true, rotate: true });
  assert.equal(f.state.writes.length, writes);
  await assert.rejects(ensureSender(f.deps, { ...opts, domain: other.domain }), /scope changed/);
  await ensureSender(f.deps, { ...opts, rotate: true });
  assert.equal(f.state.keys.length, 2);
  assert.equal(f.read()?.previous?.id, result.record.current.id);
  await assert.rejects(
    ensureSender(f.deps, { ...opts, rotate: true }),
    /previous key is still active/,
  );
  const before = f.state.writes.length;
  await retirePreviousSenderKey(f.deps, true);
  assert.equal(f.state.writes.length, before);
  await retirePreviousSenderKey(f.deps);
  assert.equal(f.state.keys.length, 1);
  const key = f.read()?.current?.id;
  f.state.fail = "CreateAccessKey";
  await assert.rejects(
    ensureSender(f.deps, { ...opts, rotate: true }),
    /previous sender key is unchanged/,
  );
  assert.equal(f.read()?.current?.id, key);
  assert.equal(f.state.keys.length, 1);
  const saved = f.read();
  assert(saved);
  const recipe = senderRollbackRecipe(saved);
  assert(recipe.some((s) => s.includes("delete-user")));
  assert(!recipe.some((s) => s.includes("delete-email-identity")));
  assert(!recipe.join("\n").includes("mock-secret"));
}
console.log(
  "✓ provision/rotation idempotence, truthful dry-run, previous key retention, safe failed rotation and owned rollback recipe",
);
for (const dryRun of [true, false]) {
  const f = fake();
  const send = f.deps.iam.send.bind(f.deps.iam);
  f.deps.iam.send = async (command) => {
    if (command.constructor.name === "GetUserCommand")
      throw Object.assign(new Error("lookup denied"), { name: "AccessDenied" });
    return send(command);
  };
  await assert.rejects(ensureSender(f.deps, { ...opts, dryRun }), { name: "AccessDenied" });
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.read(), null);
}
for (const failure of [
  "CreateTenant",
  "CreateConfigurationSet",
  "CreateTenantResourceAssociation",
  "CreateUser",
  "PutUserPolicy",
  "CreateAccessKey",
]) {
  const f = fake();
  f.state.fail = failure;
  await assert.rejects(ensureSender(f.deps, opts), /provision failed/);
  assert.equal(f.state.user, null, failure);
  assert.equal(f.state.tenant, null, failure);
  assert.equal(f.state.config, null, failure);
  assert.equal(f.state.keys.length, 0, failure);
  assert.equal(f.state.associations.size, 0);
  assert.equal(f.read(), null);
}
for (const mutate of [
  (f: ReturnType<typeof fake>) => {
    f.state.boundaryDrift = true;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.verified = false;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.identityPolicies = { broad: "*" };
  },
  (f: ReturnType<typeof fake>) => {
    f.state.user = { UserName: spec.user };
  },
  (f: ReturnType<typeof fake>) => {
    f.state.extraTenant = true;
  },
]) {
  const f = fake();
  mutate(f);
  await assert.rejects(ensureSender(f.deps, opts));
  assert.equal(f.state.writes.length, 0);
}
for (const mutate of [
  (f: ReturnType<typeof fake>) => {
    f.state.boundaryDrift = true;
  },
  (f: ReturnType<typeof fake>) => {
    assert(f.state.user);
    delete f.state.user.PermissionsBoundary;
  },
  (f: ReturnType<typeof fake>) => {
    assert(f.state.user);
    f.state.user.PermissionsBoundary = { PermissionsBoundaryArn: "wrong" };
  },
  (f: ReturnType<typeof fake>) => {
    f.state.attached = true;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.groups = true;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.extraInline = true;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.login = true;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.extraTenant = true;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.foreignResource = true;
  },
  (f: ReturnType<typeof fake>) => {
    f.state.policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
    });
  },
  (f: ReturnType<typeof fake>) => {
    assert(f.state.user);
    f.state.user.UserId = "FOREIGN-ID";
  },
  (f: ReturnType<typeof fake>) => {
    f.state.account = "999999999999";
  },
  (f: ReturnType<typeof fake>) => {
    f.state.keys.push({ AccessKeyId: "FOREIGN", Status: "Active" });
  },
]) {
  const f = fake();
  const r = (await ensureSender(f.deps, opts)).record;
  assert(r);
  mutate(f);
  const writes = f.state.writes.length;
  await assert.rejects(auditSender(f.deps, r));
  await assert.rejects(ensureSender(f.deps, opts));
  assert.equal(f.state.writes.length, writes);
}
console.log(
  "✓ fails closed on unverified identity, identity delegation, foreign ownership, policy/group/login/key/tenant/account drift; failed creation compensates only its own resources",
);

{
  const f = fake();
  await ensureSender(f.deps, opts);
  const previous = f.read()?.current?.id;
  f.state.failWhenReady = true;
  await assert.rejects(
    ensureSender(f.deps, { ...opts, rotate: true }),
    /previous sender key is unchanged/,
  );
  assert.equal(f.state.keys.length, 1);
  assert.equal(f.read()?.current?.id, previous);
  f.state.uncertainKey = true;
  await assert.rejects(ensureSender(f.deps, { ...opts, rotate: true }), /AWS outcome unknown/);
  assert.equal(f.read()?.phase, "preparing");
  assert.equal(f.read()?.pendingOperation, "CreateAccessKey");
  assert.equal(
    f.state.keys.length,
    2,
    "Unknown request may have succeeded; do not pretend its key was removed",
  );
  assert.equal(
    f.read()?.current?.id,
    previous,
    "Never replace the old working secret with an unknown key",
  );
  const writes = f.state.writes.length;
  await assert.rejects(ensureSender(f.deps, opts), /incomplete/);
  assert.equal(
    f.state.writes.length,
    writes,
    "Recovery must be reviewed, not an automatic second rotation",
  );
}
console.log(
  "✓ failed keychain save rolls back the new key; unknown AWS outcome retains recovery journal and refuses automatic retry",
);

// Drive the CLI through the mandatory fixture backend. Native keytar imports
// and shell keychain commands are blocked by the test runner, in descendants too.
{
  assert.equal(
    (globalThis as Record<symbol, unknown>)[Symbol.for("hatchkit.test-keychain-loaded")],
    true,
    "Use node scripts/test.mjs test-ses-project-sender.ts",
  );
  const { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { IAMClient } = await import("@aws-sdk/client-iam");
  const { SESv2Client } = await import("@aws-sdk/client-sesv2");
  const { STSClient } = await import("@aws-sdk/client-sts");
  const { getStore } = await import("./src/config.js");
  const { SECRET_KEYS, setSecret } = await import("./src/utils/secrets.js");
  const { runSesSenderCli, keychainSenderStore } = await import(
    "./src/provision/ses-sender-cli.js"
  );
  const { readProjectEnvSnapshot } = await import("./src/provision/listmonk-user-cli.js");
  const { writeProdEnv } = await import("./src/provision/write-env.js");
  const dir = mkdtempSync(join(tmpdir(), "ses-cli-"));
  const senders = [
    IAMClient.prototype.send,
    SESv2Client.prototype.send,
    STSClient.prototype.send,
  ] as const;
  const f = fake();
  IAMClient.prototype.send = f.deps.iam.send;
  SESv2Client.prototype.send = f.deps.ses.send;
  STSClient.prototype.send = f.deps.sts.send;
  getStore().set("providers.ses", {
    status: "configured",
    region: spec.region,
  });
  await setSecret(SECRET_KEYS.sesAccessKeyId, "mock-provisioner-id-never-copy");
  await setSecret(SECRET_KEYS.sesSecretAccessKey, "mock-provisioner-secret-never-copy");
  const output: string[] = [];
  const log = console.log;
  console.log = (...args) => {
    output.push(args.map(String).join(" "));
  };
  try {
    writeFileSync(
      join(dir, ".hatchkit.json"),
      JSON.stringify({
        version: 5,
        name: spec.project,
        domain: spec.domain,
        surfaces: "backend",
        features: [],
        deploymentMode: "scaffold-only",
      }),
    );
    writeFileSync(join(dir, ".gitignore"), ".env.keys\n.env.*.local\n");
    writeFileSync(join(dir, ".env.production"), "SES_FROM_EMAIL=legacy@example.com\n");
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "fixture"],
      { cwd: dir },
    );
    const before = readFileSync(join(dir, ".env.production"), "utf8");
    const files = readdirSync(dir);
    await runSesSenderCli([dir, "--dry-run"]);
    assert.deepEqual(readdirSync(dir), files);
    assert.equal(readFileSync(join(dir, ".env.production"), "utf8"), before);
    assert.equal(await keychainSenderStore(spec.project).read(), null);
    assert.equal(f.state.writes.length, 0);
    await runSesSenderCli([dir]);
    const snap = await readProjectEnvSnapshot(dir);
    assert.equal(snap.prod.SES_PROJECT_ACCESS_KEY_ID, "MOCKKEY1");
    assert.equal(snap.prod.SES_PROJECT_SECRET_ACCESS_KEY, "mock-secret-1");
    assert.equal(
      snap.prod.SES_FROM_EMAIL,
      "legacy@example.com",
      "Preparation must not change any legacy sender field",
    );
    assert.equal(snap.prod.EMAIL_TRANSPORT, undefined);
    const encrypted = readFileSync(join(dir, ".env.production"), "utf8");
    assert(encrypted.includes("encrypted:"));
    assert(!encrypted.includes("mock-secret-1"));
    assert.equal(snap.dev.SES_PROJECT_SECRET_ACCESS_KEY, "mock-secret-1");
    const mutations = f.state.writes.length;
    await runSesSenderCli([dir]);
    assert.equal(f.state.writes.length, mutations);
    assert.equal(
      readFileSync(join(dir, ".env.production"), "utf8"),
      encrypted,
      "Idempotent rerun must not re-encrypt unchanged values",
    );
    await assert.rejects(runSesSenderCli([dir, "--activate"]), /Port\/review/);
    mkdirSync(join(dir, "src/services"), { recursive: true });
    writeFileSync(join(dir, "src/services/email.ts"), "// unrelated legacy transport\n");
    mkdirSync(join(dir, "src/lib/server"), { recursive: true });
    writeFileSync(join(dir, "src/lib/server/ses-email.ts"), "// unreviewed transport\n");
    await assert.rejects(runSesSenderCli([dir, "--activate"]), /Port\/review/);
    writeFileSync(join(dir, "src/lib/server/ses-email.ts"), "// hatchkit-ses-project-v1 fixture\n");
    writeProdEnv(join(dir, ".env.production"), [
      { key: "LISTMONK_API_TOKEN", value: "mock-newsletter-token" },
    ]);
    await assert.rejects(runSesSenderCli([dir, "--activate"]), /acknowledge-listmonk-gap/);
    await runSesSenderCli([dir, "--activate", "--acknowledge-listmonk-gap"]);
    assert.equal((await readProjectEnvSnapshot(dir)).prod.EMAIL_TRANSPORT, "ses");
    assert.equal(
      (await readProjectEnvSnapshot(dir)).prod.LISTMONK_API_TOKEN,
      "mock-newsletter-token",
      "Active newsletter access must be preserved",
    );
    assert(!output.join("\n").includes("mock-provisioner"));
    assert(!output.join("\n").includes("mock-secret-1"));
    assert(!output.join("\n").includes("mock-newsletter-token"));
  } finally {
    console.log = log;
    [IAMClient.prototype.send, SESv2Client.prototype.send, STSClient.prototype.send] = senders;
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(
  "✓ fixture CLI backfill: dry-run zero writes, encrypted prod/ignored dev, no secret output, idempotent env, explicit activation and retained newsletter access",
);
