/** Read-only AWS IAM simulation. No keychain, provisioning or email calls. */
import type {
  SimulateCustomPolicyCommandInput,
  SimulateCustomPolicyCommandOutput,
} from "@aws-sdk/client-iam";
import { type SesSenderSpec, senderPolicy } from "./ses-project-policy.js";

export interface PolicyProbe {
  name: string;
  expected: "allowed" | "explicitDeny";
  input: SimulateCustomPolicyCommandInput;
}
export function senderPolicyProbes(s: SesSenderSpec): PolicyProbe[] {
  const context: Record<string, string> = {
    "ses:FromAddress": s.from[0],
    "ses:TenantName": s.tenant,
    "ses:ApiVersion": "2",
    "aws:RequestedRegion": s.region,
  };
  const probes: PolicyProbe[] = [];
  const add = (
    name: string,
    expected: PolicyProbe["expected"],
    action: string,
    resource: string,
    values: Record<string, string> = context,
    broadAllow = false,
  ) =>
    probes.push({
      name,
      expected,
      input: {
        PolicyInputList: [
          JSON.stringify(senderPolicy(s)),
          ...(broadAllow
            ? [
                JSON.stringify({
                  Version: "2012-10-17",
                  Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
                }),
              ]
            : []),
        ],
        ActionNames: [action],
        ResourceArns: [resource],
        ContextEntries: Object.entries(values).map(([ContextKeyName, value]) => ({
          ContextKeyName,
          ContextKeyValues: [value],
          ContextKeyType: "string",
        })),
      },
    });
  for (const from of s.from)
    for (const arn of [s.identityArn, s.configurationSetArn])
      add(`allow ${from} on ${arn}`, "allowed", "ses:SendEmail", arn, {
        ...context,
        "ses:FromAddress": from,
      });
  for (const broad of [false, true]) {
    const prefix = broad ? "with overlapping Allow: " : "";
    for (const version of ["1", "2019-09-27"])
      add(
        `${prefix}unsupported API version ${version}`,
        "explicitDeny",
        "ses:SendEmail",
        s.identityArn,
        { ...context, "ses:ApiVersion": version },
        broad,
      );
    for (const key of Object.keys(context)) {
      const missing = { ...context };
      delete missing[key];
      add(
        `${prefix}missing ${key}`,
        "explicitDeny",
        "ses:SendEmail",
        s.identityArn,
        missing,
        broad,
      );
      add(
        `${prefix}foreign ${key}`,
        "explicitDeny",
        "ses:SendEmail",
        s.identityArn,
        { ...context, [key]: "foreign" },
        broad,
      );
    }
    for (const resource of [
      s.identityArn + ".foreign.invalid",
      s.configurationSetArn + "-foreign",
      "*",
    ])
      add(
        `${prefix}foreign resource ${resource}`,
        "explicitDeny",
        "ses:SendEmail",
        resource,
        context,
        broad,
      );
    for (const action of [
      "ses:SendRawEmail",
      "ses:SendBulkEmail",
      "iam:CreateAccessKey",
      "iam:PutUserPolicy",
      "sts:AssumeRole",
      "sns:Publish",
    ])
      add(`${prefix}forbidden ${action}`, "explicitDeny", action, "*", context, broad);
  }
  return probes;
}
export const SIMULATION_PERMISSION = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "iam:SimulateCustomPolicy", Resource: "*" }],
};
export async function verifySenderPolicy(
  s: SesSenderSpec,
  simulate: (input: SimulateCustomPolicyCommandInput) => Promise<SimulateCustomPolicyCommandOutput>,
) {
  const results: Array<{ name: string; decision: string }> = [];
  for (const probe of senderPolicyProbes(s)) {
    const output = await simulate(probe.input);
    // One action/resource per request. Never treat incomplete or unrelated output as proof.
    const result = output.EvaluationResults?.[0];
    if (
      output.IsTruncated ||
      output.EvaluationResults?.length !== 1 ||
      result?.EvalActionName !== probe.input.ActionNames?.[0] ||
      result?.EvalResourceName !== probe.input.ResourceArns?.[0] ||
      result?.EvalDecision !== probe.expected ||
      (probe.expected === "allowed" && result.MissingContextValues?.length)
    ) {
      throw new Error(
        `SES policy verification failed: ${probe.name}. Expected ${probe.expected}; no rollout is verified.`,
      );
    }
    results.push({ name: probe.name, decision: result.EvalDecision });
  }
  return {
    kind: "aws-iam-custom-policy-simulation",
    project: s.project,
    results,
    liveSenderVerified: false,
    mailSent: false,
    limitations:
      "Simulation checks the supplied policy and context only. It does not verify an installed principal, SES resource associations, AWS-generated condition context, MIME parsing, delivery or shared Listmonk isolation. Complete the sender audit and separately approved live tests before rollout.",
  };
}
