/** One administrator bootstrap per account/region; no project names or credentials. */
import { senderSpec } from "./ses-project-policy.js";

export interface PolicyStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string;
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}
export interface PolicyDocument {
  Version: string;
  Statement: PolicyStatement[];
}
export function operatorScope(account: string, region: string) {
  // Reuse the sender's commercial-partition/account/region validation.
  senderSpec("scope", "example.com", account, region);
  const boundaryName = `hatchkit-ses-sender-boundary-${region}-v1`;
  const operatorName = `hatchkit-ses-operator-${region}-v1`;
  return {
    account,
    region,
    boundaryName,
    operatorName,
    boundaryArn: `arn:aws:iam::${account}:policy/hatchkit/${boundaryName}`,
    operatorArn: `arn:aws:iam::${account}:policy/hatchkit/${operatorName}`,
    users: `arn:aws:iam::${account}:user/hatchkit/ses/hk-*`,
    identity: `arn:aws:ses:${region}:${account}:identity/mail.*`,
    configurationSet: `arn:aws:ses:${region}:${account}:configuration-set/hk-*`,
    tenant: `arn:aws:ses:${region}:${account}:tenant/hk-*/*`,
  };
}

/** Ceiling, not the project grant. The exact sender policy remains mandatory.
 * Explicit denies also cover direct resource-policy grants to an IAM user ARN.
 */
export function senderBoundaryPolicy(account: string, region: string): PolicyDocument {
  const s = operatorScope(account, region);
  const resources = [s.identity, s.configurationSet];
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
        Sid: "OnlyHatchkitResources",
        Effect: "Deny",
        Action: "ses:SendEmail",
        NotResource: resources,
      },
      ...Object.entries({
        "ses:TenantName": "hk-*",
        "ses:FromAddress": "*@mail.*",
      }).map(
        ([key, value], index): PolicyStatement => ({
          Sid: `RequireScope${index}`,
          Effect: "Deny",
          Action: "ses:SendEmail",
          Resource: "*",
          Condition: { StringNotLike: { [key]: value } },
        }),
      ),
      ...Object.entries({
        "ses:ApiVersion": "2019-09-27",
        "aws:RequestedRegion": region,
      }).map(
        ([key, value], index): PolicyStatement => ({
          Sid: `RequireVersionRegion${index}`,
          Effect: "Deny",
          Action: "ses:SendEmail",
          Resource: "*",
          Condition: { StringNotEquals: { [key]: value } },
        }),
      ),
      {
        Sid: "BoundedEmailSending",
        Effect: "Allow",
        Action: "ses:SendEmail",
        Resource: resources,
        Condition: {
          StringEquals: {
            "ses:ApiVersion": "2019-09-27",
            "aws:RequestedRegion": region,
          },
          StringLike: {
            "ses:TenantName": "hk-*",
            "ses:FromAddress": "*@mail.*",
          },
        },
      },
    ],
  };
}

/** Trusted local control plane for all projects, not credentials for an app.
 * The /hatchkit/ses/ namespace must contain only bounded Hatchkit senders.
 * Bootstrap must inspect pre-existing users before granting lifecycle access.
 */
export function senderOperatorPolicy(account: string, region: string): PolicyDocument {
  const s = operatorScope(account, region);
  const regional = { StringEquals: { "aws:RequestedRegion": region } };
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CallerAndSimulation",
        Effect: "Allow",
        Action: ["sts:GetCallerIdentity", "iam:SimulateCustomPolicy"],
        Resource: "*",
      },
      {
        Sid: "ReadBoundary",
        Effect: "Allow",
        Action: ["iam:GetPolicy", "iam:GetPolicyVersion"],
        Resource: s.boundaryArn,
      },
      {
        Sid: "CreateAndGrantOnlyBoundedUsers",
        Effect: "Allow",
        Action: ["iam:CreateUser", "iam:PutUserPolicy"],
        Resource: s.users,
        Condition: { ArnEquals: { "iam:PermissionsBoundary": s.boundaryArn } },
      },
      {
        Sid: "RefuseUnboundedUsers",
        Effect: "Deny",
        Action: ["iam:CreateUser", "iam:PutUserPolicy"],
        Resource: s.users,
        Condition: {
          ArnNotEquals: { "iam:PermissionsBoundary": s.boundaryArn },
        },
      },
      {
        // GetUser takes a name, not a path. A pre-creation lookup can be
        // authorized against the root-path ARN before the user exists.
        // This grants only the lookup; all lifecycle writes stay path-scoped.
        Sid: "ReadSenderNameBeforeCreation",
        Effect: "Allow",
        Action: "iam:GetUser",
        Resource: `arn:aws:iam::${account}:user/hk-*`,
      },
      {
        Sid: "SenderLifecycle",
        Effect: "Allow",
        Resource: s.users,
        Action: [
          "iam:GetUser",
          "iam:GetLoginProfile",
          "iam:ListUserPolicies",
          "iam:GetUserPolicy",
          "iam:ListAttachedUserPolicies",
          "iam:ListGroupsForUser",
          "iam:ListAccessKeys",
          "iam:ListUserTags",
          "iam:TagUser",
          "iam:DeleteUser",
          "iam:DeleteUserPolicy",
          "iam:CreateAccessKey",
          "iam:DeleteAccessKey",
        ],
      },
      {
        Sid: "PreserveSenderCeiling",
        Effect: "Deny",
        Resource: s.users,
        Action: [
          "iam:PutUserPermissionsBoundary",
          "iam:DeleteUserPermissionsBoundary",
          "iam:AttachUserPolicy",
          "iam:CreateLoginProfile",
          "iam:UpdateLoginProfile",
          "iam:UpdateUser",
        ],
      },
      {
        Sid: "NoGroupMembership",
        Effect: "Deny",
        Action: "iam:AddUserToGroup",
        Resource: "*",
      },
      {
        Sid: "PreserveBootstrapPolicies",
        Effect: "Deny",
        Resource: [s.boundaryArn, s.operatorArn],
        Action: [
          "iam:CreatePolicyVersion",
          "iam:SetDefaultPolicyVersion",
          "iam:DeletePolicyVersion",
          "iam:DeletePolicy",
        ],
      },
      {
        Sid: "AccountHealth",
        Effect: "Allow",
        Action: "ses:GetAccount",
        Resource: "*",
        Condition: regional,
      },
      {
        Sid: "ReadVerifiedIdentities",
        Effect: "Allow",
        Action: ["ses:GetEmailIdentity", "ses:ListResourceTenants"],
        Resource: s.identity,
        Condition: regional,
      },
      {
        Sid: "ConfigurationSets",
        Effect: "Allow",
        Resource: s.configurationSet,
        Condition: regional,
        Action: [
          "ses:GetConfigurationSet",
          "ses:CreateConfigurationSet",
          "ses:DeleteConfigurationSet",
          "ses:TagResource",
          "ses:ListResourceTenants",
        ],
      },
      {
        Sid: "Tenants",
        Effect: "Allow",
        Resource: s.tenant,
        Condition: regional,
        Action: [
          "ses:GetTenant",
          "ses:CreateTenant",
          "ses:DeleteTenant",
          "ses:TagResource",
          "ses:ListTenantResources",
        ],
      },
      {
        Sid: "TenantAssociations",
        Effect: "Allow",
        Resource: [s.identity, s.configurationSet, s.tenant],
        Condition: regional,
        Action: ["ses:CreateTenantResourceAssociation", "ses:DeleteTenantResourceAssociation"],
      },
    ],
  };
}

export function sesOperatorPlan(account: string, region: string, operatorUser: string) {
  if (!/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(operatorUser) || operatorUser.startsWith("hk-"))
    throw new Error("Pass the existing local operator's IAM username, not a project sender.");
  const scope = operatorScope(account, region);
  const boundaryPolicy = senderBoundaryPolicy(account, region);
  const operatorPolicy = senderOperatorPolicy(account, region);
  for (const policy of [boundaryPolicy, operatorPolicy])
    if (JSON.stringify(policy).length > 6144)
      throw new Error("Managed policy size limit exceeded.");
  return {
    kind: "ses-reusable-operator-bootstrap",
    scope,
    operatorUser,
    boundaryPolicy,
    operatorPolicy,
    writes: false,
    credentialsRead: false,
    preconditions: [
      "An administrator must verify the target account and inspect every existing /hatchkit/ses/ user. This reserved namespace must contain only bounded Hatchkit senders, never administrative users.",
      "Use a trusted local operator outside /hatchkit/ses/. Review its existing grants; this additive policy does not remove unrelated permissions.",
      "The administrator installs the two managed policies once. Project creation does not update them. A new account, region or changed ceiling requires a new administrator review.",
    ],
    limitations: [
      "The operator can administer all Hatchkit senders and their SES tenant associations. It is not project-isolated and must never be placed in apps.",
      "The boundary is an SES-only ceiling; exact cross-project restrictions come from each sender's inline policy and ownership audit.",
      "This extends the existing SES provider setup for isolated senders. Identity verification, DNS and shared feedback provisioning keep their existing provider permissions/workflows.",
      "Existing boundaryless senders are refused, not silently migrated. IAM simulation does not prove live SES enforcement.",
    ],
    cloudFormation: {
      AWSTemplateFormatVersion: "2010-09-09",
      Description: "Reusable Hatchkit SES sender operator and immutable sender ceiling",
      Resources: {
        SenderBoundary: {
          Type: "AWS::IAM::ManagedPolicy",
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
          Properties: {
            ManagedPolicyName: scope.boundaryName,
            Path: "/hatchkit/",
            PolicyDocument: boundaryPolicy,
          },
        },
        SenderOperator: {
          Type: "AWS::IAM::ManagedPolicy",
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
          DependsOn: "SenderBoundary",
          Properties: {
            ManagedPolicyName: scope.operatorName,
            Path: "/hatchkit/",
            PolicyDocument: operatorPolicy,
            Users: [operatorUser],
          },
        },
      },
    },
    rollback:
      "Administrator detaches the operator policy to stop new provisioning. Retain the sender boundary while any sender exists; never remove it from live users. Stack deletion intentionally retains both policies. Delete retained policies only after reviewing attachments and cleaning up owned senders.",
  };
}
