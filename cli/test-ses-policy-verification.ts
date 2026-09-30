import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSesPolicyVerification } from "./src/provision/ses-policy-verification-cli.js";
import { senderPolicyProbes, verifySenderPolicy } from "./src/provision/ses-policy-verification.js";
import { senderSpec } from "./src/provision/ses-project-policy.js";
const spec = senderSpec("sample", "sample.example.com", "123456789012", "eu-west-1");
const probes = senderPolicyProbes(spec);
assert.equal(probes.length, 40);
for (const probe of probes.filter((p) => p.expected === "allowed"))
  assert.deepEqual(
    probe.input.ContextEntries?.find((entry) => entry.ContextKeyName === "ses:ApiVersion")
      ?.ContextKeyValues,
    ["2"],
    "AWS IAM context must use the documented API version, not the SDK model date",
  );
for (const version of ["1", "2019-09-27"])
  assert.equal(
    probes.filter(
      (p) => p.expected === "explicitDeny" && p.name.includes(`unsupported API version ${version}`),
    ).length,
    2,
  );
const response = (index: number) => ({
  $metadata: {},
  EvaluationResults: [
    {
      EvalActionName: probes[index].input.ActionNames![0],
      EvalResourceName: probes[index].input.ResourceArns![0],
      EvalDecision: probes[index].expected,
    },
  ],
});
let count = 0;
const report = await verifySenderPolicy(spec, async () => response(count++));
assert.equal(count, probes.length);
assert.equal(report.liveSenderVerified, false);
assert.equal(report.mailSent, false);
for (const bad of [
  { $metadata: {}, EvaluationResults: [] },
  { ...response(0), IsTruncated: true },
  {
    $metadata: {},
    EvaluationResults: [{ ...response(0).EvaluationResults[0], EvalDecision: "explicitDeny" }],
  },
  {
    $metadata: {},
    EvaluationResults: [{ ...response(0).EvaluationResults[0], EvalResourceName: "*" }],
  },
  {
    $metadata: {},
    EvaluationResults: [
      {
        ...response(0).EvaluationResults[0],
        MissingContextValues: ["ses:TenantName"],
      },
    ],
  },
])
  await assert.rejects(
    verifySenderPolicy(spec, async () => bad),
    /verification failed/,
  );
let sent = 0;
await assert.rejects(
  verifySenderPolicy(spec, async () => {
    sent++;
    throw new Error("AccessDenied");
  }),
  /AccessDenied/,
);
assert.equal(sent, 1, "No retry after provider refusal");
const dir = mkdtempSync(join(tmpdir(), "ses-policy-plan-"));
const output: string[] = [];
const log = console.log;
try {
  writeFileSync(
    join(dir, ".hatchkit.json"),
    JSON.stringify({
      version: 5,
      name: spec.project,
      domain: spec.domain,
    }),
  );
  const before = readFileSync(join(dir, ".hatchkit.json"), "utf8");
  console.log = (line: string) => output.push(line);
  await runSesPolicyVerification([
    dir,
    "--account",
    spec.account,
    "--region",
    spec.region,
    "--dry-run",
    "--json",
  ]);
  assert.equal(JSON.parse(output.at(-1)!).requests.length, probes.length);
  assert.equal(readFileSync(join(dir, ".hatchkit.json"), "utf8"), before);
  await assert.rejects(
    runSesPolicyVerification([dir, "--account", spec.account, "--region", spec.region]),
    /approved AWS CLI --profile/,
  );
} finally {
  console.log = log;
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  "SES policy verification: complete responses required; dry-run offline; live mode requires explicit profile",
);
