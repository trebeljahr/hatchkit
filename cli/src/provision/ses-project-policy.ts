/** AWS-enforced SES v2 sender boundary. SMTP/v1 are intentionally denied.
 * https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html
 */
import { createHash } from "node:crypto";

export interface SesSenderSpec {
  project: string;
  domain: string;
  account: string;
  region: string;
  from: string[];
  identity: string;
  identityArn: string;
  configurationSet: string;
  configurationSetArn: string;
  tenant: string;
  user: string;
}

export function senderSpec(
  project: string,
  domain: string,
  account: string,
  region: string,
  from?: string[],
): SesSenderSpec {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(project))
    throw new Error(
      "Project must be 1–63 lowercase letters, digits, dots, underscores or hyphens.",
    );
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
    throw new Error("A lowercase DNS project domain is required.");
  if (!/^\d{12}$/.test(account)) throw new Error("Invalid AWS account id.");
  // Commercial partitions only until their endpoints and tenant support are tested.
  if (
    !/^(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:east|west|south|north|central|northeast|southeast)-\d$/.test(
      region,
    )
  )
    throw new Error("Unsupported SES region; commercial AWS regions only.");
  const identity = `mail.${domain}`;
  const addresses = [...new Set(from ?? [`noreply@${identity}`])].sort();
  if (
    !addresses.length ||
    addresses.length > 10 ||
    addresses.some(
      (a) =>
        !/^[a-z0-9][a-z0-9._+-]*@/.test(a) ||
        a.split("@").length !== 2 ||
        a.split("@")[1] !== identity ||
        a.length > 254,
    )
  ) {
    throw new Error(
      `From addresses must be exact lowercase mailboxes at ${identity}; wildcards and display names are forbidden.`,
    );
  }
  const suffix = createHash("sha256")
    .update(`${project}:${domain}:${region}`)
    .digest("hex")
    .slice(0, 16);
  const name = `hk-${project.slice(0, 32).replace(/[._]/g, "-")}-${suffix}`;
  const arn = `arn:aws:ses:${region}:${account}`;
  return {
    project,
    domain,
    account,
    region,
    from: addresses,
    identity,
    identityArn: `${arn}:identity/${identity}`,
    configurationSet: name,
    configurationSetArn: `${arn}:configuration-set/${name}`,
    tenant: name,
    user: name,
  };
}

export const SENDER_POLICY_NAME = "hatchkit-ses-sender-v1";

export function senderPolicy(s: SesSenderSpec) {
  const resources = [s.identityArn, s.configurationSetArn];
  // Explicit denies win even over an accidentally attached managed/group policy
  // or an identity resource policy granting this principal broader send rights.
  const conditions: Record<string, string | string[]> = {
    "ses:FromAddress": s.from,
    "ses:TenantName": s.tenant,
    "ses:ApiVersion": "2019-09-27",
    "aws:RequestedRegion": s.region,
  };
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OnlySendEmail",
        Effect: "Deny",
        NotAction: "ses:SendEmail",
        Resource: "*",
      },
      {
        Sid: "OnlyProjectResources",
        Effect: "Deny",
        Action: "ses:SendEmail",
        NotResource: resources,
      },
      ...Object.entries(conditions).map(([key, value], i) => ({
        Sid: `RequireScope${i}`,
        Effect: "Deny",
        Action: "ses:SendEmail",
        Resource: "*",
        // Negated conditions also deny when the key is absent. Separate
        // statements are OR, unlike a single condition block's AND.
        Condition: { StringNotEquals: { [key]: value } },
      })),
      {
        Sid: "SendForProject",
        Effect: "Allow",
        Action: "ses:SendEmail",
        Resource: resources,
        Condition: { StringEquals: conditions },
      },
    ],
  };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Provisioner policy fragment for operator review. It belongs exclusively on
 * the local administrative principal, never on the project's sender. */
export function senderProvisionerPolicy(s: SesSenderSpec) {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      {
        Effect: "Allow",
        Action: [
          "iam:GetUser",
          "iam:GetLoginProfile",
          "iam:ListUserPolicies",
          "iam:GetUserPolicy",
          "iam:ListAttachedUserPolicies",
          "iam:ListGroupsForUser",
          "iam:ListAccessKeys",
          "iam:CreateUser",
          "iam:TagUser",
          "iam:DeleteUser",
          "iam:PutUserPolicy",
          "iam:DeleteUserPolicy",
          "iam:CreateAccessKey",
          "iam:DeleteAccessKey",
        ],
        Resource: `arn:aws:iam::${s.account}:user/hatchkit/ses/${s.user}`,
      },
      {
        Effect: "Allow",
        Action: [
          "ses:GetEmailIdentity",
          "ses:GetConfigurationSet",
          "ses:GetTenant",
          "ses:ListResourceTenants",
          "ses:ListTenantResources",
          "ses:TagResource",
          "ses:CreateConfigurationSet",
          "ses:DeleteConfigurationSet",
          "ses:CreateTenant",
          "ses:DeleteTenant",
          "ses:CreateTenantResourceAssociation",
          "ses:DeleteTenantResourceAssociation",
        ],
        Resource: [
          s.identityArn,
          s.configurationSetArn,
          `arn:aws:ses:${s.region}:${s.account}:tenant/${s.tenant}/*`,
        ],
        Condition: { StringEquals: { "aws:RequestedRegion": s.region } },
      },
    ],
  };
}
