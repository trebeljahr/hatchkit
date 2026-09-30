/** Offline adversarial checks; the fixture runner blocks the real Keychain. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSesOperatorPlan } from "./src/provision/ses-operator-cli.js";
import {
  type PolicyDocument,
  operatorScope,
  senderBoundaryPolicy,
  senderOperatorPolicy,
  sesOperatorPlan,
} from "./src/provision/ses-operator-policy.js";
const account = "123456789012";
const region = "eu-west-1";
const scope = operatorScope(account, region);
const operator = senderOperatorPolicy(account, region);
const boundary = senderBoundaryPolicy(account, region);
// Independent subset evaluator; no claim that this replaces AWS IAM evaluation.
const glob = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
  ).test(value);
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
function allowed(
  policy: PolicyDocument,
  action: string,
  resource: string,
  context: Record<string, string> = {},
  overlappingAllow = false,
) {
  let permit = overlappingAllow;
  for (const st of policy.Statement) {
    if (st.Action && !list(st.Action).some((v) => glob(v, action))) continue;
    if (st.NotAction && glob(st.NotAction, action)) continue;
    if (st.Resource && !list(st.Resource).some((v) => glob(v, resource))) continue;
    if (st.NotResource && list(st.NotResource).some((v) => glob(v, resource))) continue;
    const match = Object.entries(st.Condition ?? {}).every(([op, entries]) =>
      Object.entries(entries).every(([key, values]) => {
        const exists = Object.hasOwn(context, key);
        const equal =
          exists &&
          list(values).some((v) =>
            op.includes("Like") ? glob(v, context[key]) : v === context[key],
          );
        return op.includes("Not") ? !equal : equal;
      }),
    );
    if (!match) continue;
    if (st.Effect === "Deny") return false;
    permit = true;
  }
  return permit;
}
const user = `arn:aws:iam::${account}:user/hatchkit/ses/hk-future-project`;
const correct = { "iam:PermissionsBoundary": scope.boundaryArn };
for (const action of ["iam:CreateUser", "iam:PutUserPolicy"]) {
  assert(allowed(operator, action, user, correct));
  for (const context of [
    {},
    {
      "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/AdministratorAccess",
    },
  ])
    for (const broad of [false, true]) assert(!allowed(operator, action, user, context, broad));
  assert(!allowed(operator, action, `arn:aws:iam::${account}:user/admin`, correct));
}
for (const action of [
  "iam:DeleteUserPermissionsBoundary",
  "iam:PutUserPermissionsBoundary",
  "iam:AttachUserPolicy",
  "iam:AddUserToGroup",
  "iam:UpdateUser",
  "iam:CreateLoginProfile",
])
  assert(!allowed(operator, action, user, correct, true));
for (const resource of [scope.boundaryArn, scope.operatorArn])
  for (const action of [
    "iam:CreatePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "iam:DeletePolicy",
    "iam:DeletePolicyVersion",
  ])
    assert(!allowed(operator, action, resource, {}, true));
for (const action of ["iam:CreateAccessKey", "iam:DeleteUser", "iam:TagUser"])
  assert(!allowed(operator, action, `arn:aws:iam::${account}:user/admin`));
assert(
  !allowed(
    operator,
    "ses:DeleteEmailIdentity",
    `arn:aws:ses:${region}:${account}:identity/mail.future.example.com`,
    { "aws:RequestedRegion": region },
  ),
);
const identity = `arn:aws:ses:${region}:${account}:identity/mail.future.example.com`;
const sendContext = {
  "ses:FromAddress": "noreply@mail.future.example.com",
  "ses:TenantName": "hk-future",
  "ses:ApiVersion": "2019-09-27",
  "aws:RequestedRegion": region,
};
assert(allowed(boundary, "ses:SendEmail", identity, sendContext));
for (const action of [
  "iam:CreateUser",
  "iam:CreateAccessKey",
  "sts:AssumeRole",
  "s3:GetObject",
  "ses:SendRawEmail",
  "ses:SendBulkEmail",
])
  assert(!allowed(boundary, action, identity, sendContext, true));
for (const key of Object.keys(sendContext)) {
  const missing: Record<string, string> = { ...sendContext };
  delete missing[key];
  assert(!allowed(boundary, "ses:SendEmail", identity, missing, true));
  assert(!allowed(boundary, "ses:SendEmail", identity, { ...sendContext, [key]: "foreign" }, true));
}
assert(
  !allowed(boundary, "ses:SendEmail", identity.replace(account, "999999999999"), sendContext, true),
);
assert(
  !allowed(boundary, "ses:SendEmail", identity.replace(region, "us-east-1"), sendContext, true),
);
assert(!allowed(boundary, "ses:SendEmail", "*", sendContext, true));
const plan = sesOperatorPlan(account, region, "hatchkit-ses");
assert(plan.cloudFormation.Resources.SenderOperator.Properties.Users.includes("hatchkit-ses"));
assert.equal(plan.cloudFormation.Resources.SenderBoundary.DeletionPolicy, "Retain");
for (const policy of [operator, boundary]) assert(JSON.stringify(policy).length <= 6144);
assert.throws(() => sesOperatorPlan(account, region, "hk-project-sender"));
assert.throws(() => sesOperatorPlan("invalid", region, "operator"));
assert.throws(() => sesOperatorPlan(account, "us-gov-west-1", "operator"));
const dir = mkdtempSync(join(tmpdir(), "hatchkit-operator-"));
const output: string[] = [];
const log = console.log;
try {
  console.log = (v: string) => output.push(v);
  const args = [
    "--account",
    account,
    "--region",
    region,
    "--operator-user",
    "hatchkit-ses",
    "--json",
  ];
  await runSesOperatorPlan(args);
  assert.equal(JSON.parse(output[0]).credentialsRead, false);
  assert.deepEqual(readdirSync(dir), []);
  const target = join(dir, "review");
  await runSesOperatorPlan([...args, "--output", target]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(target, "bootstrap.cloudformation.json"), "utf8")),
    plan.cloudFormation,
  );
  await assert.rejects(runSesOperatorPlan([...args, "--output", target]), /exists/);
  await assert.rejects(runSesOperatorPlan([...args, "--execute"]), /Unknown/);
} finally {
  console.log = log;
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  "Reusable SES operator: bounded creation, immutable ceiling, future-project namespace, fail-closed bootstrap and offline plan checks pass",
);

assert(!allowed(operator, "iam:AddUserToGroup", `arn:aws:iam::${account}:group/admins`, {}, true));
