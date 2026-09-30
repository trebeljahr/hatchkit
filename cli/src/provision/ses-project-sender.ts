/** Project sender lifecycle. No mail is sent, and no provisioner secret is
 * returned. The durable ownership/key journal lives ONLY in the keychain.
 * Failed provisioning compensates only resources created by that invocation.
 * Rotation keeps the previous key until an explicit retirement after deployment.
 */
import { randomUUID } from "node:crypto";
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  GetLoginProfileCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetUserCommand,
  GetUserPolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListUserPoliciesCommand,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateConfigurationSetCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  DeleteConfigurationSetCommand,
  DeleteTenantCommand,
  DeleteTenantResourceAssociationCommand,
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  GetTenantCommand,
  ListResourceTenantsCommand,
  ListTenantResourcesCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { operatorScope, senderBoundaryPolicy } from "./ses-operator-policy.js";
import {
  SENDER_POLICY_NAME,
  type SesSenderSpec,
  canonical,
  senderPolicy,
  senderSpec,
} from "./ses-project-policy.js";
import type { SesAuth } from "./ses.js";

export interface SenderKey {
  id: string;
  secret: string;
}
export interface SenderRecord {
  version: 1;
  owner: string;
  spec: SesSenderSpec;
  phase: "preparing" | "ready";
  pendingOperation?: string;
  userId?: string;
  tenantArn?: string;
  configurationCreated?: boolean;
  associations: string[];
  policyCreated?: boolean;
  current?: SenderKey;
  previous?: SenderKey;
}
export interface SenderStore {
  read(): Promise<SenderRecord | null>;
  write(record: SenderRecord | null): Promise<void>;
}
export interface SenderDeps {
  iam: Pick<IAMClient, "send">;
  ses: Pick<SESv2Client, "send">;
  sts: Pick<STSClient, "send">;
  store: SenderStore;
}
export function senderClients(auth: SesAuth) {
  const options = {
    region: auth.region,
    credentials: {
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
    },
  };
  return {
    iam: new IAMClient(options),
    ses: new SESv2Client(options),
    sts: new STSClient(options),
  };
}
export function senderSetupInstructions(): string {
  return "Install the reusable operator and sender boundary once with an administrator-reviewed `hatchkit ses operator-plan --account <account> --region <region> --operator-user <existing-operator> --output <new-directory>`. Keep operator credentials local; projects receive only restricted sender keys. Existing boundaryless senders need a reviewed migration. Verify mail.<project-domain> in SES first.";
}
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
async function absent<T>(read: () => Promise<T>, missing: string): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (errorName(err) === missing) return null;
    throw err;
  }
}
function requireState(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function ownership(tags: { Key?: string; Value?: string }[] | undefined, r: SenderRecord): boolean {
  return (
    !!tags?.some((t) => t.Key === "hatchkit-owner" && t.Value === r.owner) &&
    !!tags.some((t) => t.Key === "hatchkit-project" && t.Value === r.spec.project)
  );
}
function tags(r: SenderRecord) {
  return [
    { Key: "hatchkit-owner", Value: r.owner },
    { Key: "hatchkit-project", Value: r.spec.project },
  ];
}

async function identityCheck(d: SenderDeps, s: SesSenderSpec) {
  const identity = await d.ses.send(new GetEmailIdentityCommand({ EmailIdentity: s.identity }));
  requireState(
    identity.VerifiedForSendingStatus === true,
    `SES identity ${s.identityArn} is missing or not verified. Verify it in this region before provisioning a sender.`,
  );
  requireState(
    Object.keys(identity.Policies ?? {}).length === 0,
    "SES identity has sending-authorization policies. Review/remove overlapping delegation before isolation; Hatchkit will not adopt or overwrite them.",
  );
}
async function resourceTenants(d: SenderDeps, arn: string): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await d.ses.send(new ListResourceTenantsCommand({ ResourceArn: arn, NextToken }));
    for (const t of page.ResourceTenants ?? []) {
      requireState(t.TenantName, "SES returned an unnamed resource tenant.");
      out.push(t.TenantName);
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}
async function tenantResources(d: SenderDeps, name: string): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await d.ses.send(new ListTenantResourcesCommand({ TenantName: name, NextToken }));
    for (const r of page.TenantResources ?? []) {
      requireState(r.ResourceArn, "SES returned an unnamed tenant resource.");
      out.push(r.ResourceArn);
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}
async function ownedUser(d: SenderDeps, r: SenderRecord) {
  const res = await d.iam.send(new GetUserCommand({ UserName: r.spec.user }));
  requireState(
    r.userId &&
      res.User?.UserId === r.userId &&
      res.User.Path === "/hatchkit/ses/" &&
      res.User.Arn === `arn:aws:iam::${r.spec.account}:user/hatchkit/ses/${r.spec.user}` &&
      ownership(res.User.Tags, r),
    "IAM sender ownership mismatch; refusing adoption or deletion.",
  );
  return res.User;
}

/** Refuse missing/changed bootstrap before provisioning and after creating a key. */
async function auditBoundary(d: SenderDeps, s: SesSenderSpec): Promise<void> {
  const arn = operatorScope(s.account, s.region).boundaryArn;
  const policy = (await d.iam.send(new GetPolicyCommand({ PolicyArn: arn }))).Policy;
  requireState(
    policy?.Arn === arn && policy.DefaultVersionId,
    "Reusable sender boundary is missing. " + senderSetupInstructions(),
  );
  const version = (
    await d.iam.send(
      new GetPolicyVersionCommand({
        PolicyArn: arn,
        VersionId: policy.DefaultVersionId,
      }),
    )
  ).PolicyVersion;
  requireState(
    version?.Document &&
      canonical(JSON.parse(decodeURIComponent(version.Document))) ===
        canonical(senderBoundaryPolicy(s.account, s.region)),
    "Reusable sender boundary drift; administrator review required. No policy was changed.",
  );
}

/** Read-only AWS audit. Exact policy comparison plus explicit denies avoids
 * relying on a friendly user name or ignoring managed/group grants. */
export async function auditSender(d: SenderDeps, r: SenderRecord): Promise<void> {
  requireState(
    r.version === 1 && r.phase === "ready" && r.current,
    "Sender is incomplete; review its rollback recipe before retrying.",
  );
  const s = r.spec;
  requireState(
    canonical(senderSpec(s.project, s.domain, s.account, s.region, s.from)) === canonical(s),
    "Stored sender scope is invalid.",
  );
  const caller = await d.sts.send(new GetCallerIdentityCommand({}));
  requireState(
    caller.Account === s.account,
    "Provisioner AWS account changed; refusing to use another account's sender.",
  );
  await auditBoundary(d, s);
  await identityCheck(d, s);
  const user = await ownedUser(d, r);
  requireState(
    user.PermissionsBoundary?.PermissionsBoundaryArn ===
      operatorScope(s.account, s.region).boundaryArn,
    "Missing or unexpected sender boundary; administrator-reviewed migration required before reuse.",
  );
  const inline = await d.iam.send(new ListUserPoliciesCommand({ UserName: s.user }));
  const attached = await d.iam.send(new ListAttachedUserPoliciesCommand({ UserName: s.user }));
  const groups = await d.iam.send(new ListGroupsForUserCommand({ UserName: s.user }));
  requireState(
    !inline.IsTruncated &&
      canonical(inline.PolicyNames) === canonical([SENDER_POLICY_NAME]) &&
      !attached.IsTruncated &&
      !attached.AttachedPolicies?.length &&
      !groups.IsTruncated &&
      !groups.Groups?.length,
    "Sender has unexpected inline, managed or group permissions. Isolation cannot be established; remove the extra grants manually.",
  );
  const login = await absent(
    () => d.iam.send(new GetLoginProfileCommand({ UserName: s.user })),
    "NoSuchEntityException",
  );
  requireState(!login, "Sender has a console login; remove it before reuse.");
  const policy = await d.iam.send(
    new GetUserPolicyCommand({
      UserName: s.user,
      PolicyName: SENDER_POLICY_NAME,
    }),
  );
  requireState(
    policy.PolicyDocument &&
      canonical(JSON.parse(decodeURIComponent(policy.PolicyDocument))) ===
        canonical(senderPolicy(s)),
    "Sender policy drift: refusing to widen or silently repair it.",
  );
  const keys = await d.iam.send(new ListAccessKeysCommand({ UserName: s.user }));
  const expected = [r.current, r.previous].filter((k): k is SenderKey => !!k);
  requireState(
    !keys.IsTruncated &&
      keys.AccessKeyMetadata?.length === expected.length &&
      keys.AccessKeyMetadata.every(
        (k) => k.Status === "Active" && expected.some((e) => e.id === k.AccessKeyId),
      ),
    "Unknown, missing or inactive sender access key; reconcile ownership before reuse.",
  );
  const tenant = await d.ses.send(new GetTenantCommand({ TenantName: s.tenant }));
  requireState(
    tenant.Tenant && tenant.Tenant.TenantArn === r.tenantArn && ownership(tenant.Tenant.Tags, r),
    "Tenant ownership mismatch.",
  );
  requireState(
    ["ENABLED", "REINSTATED"].includes(tenant.Tenant.SendingStatus ?? ""),
    "SES tenant is paused; investigate reputation before enabling sends.",
  );
  const config = await d.ses.send(
    new GetConfigurationSetCommand({
      ConfigurationSetName: s.configurationSet,
    }),
  );
  requireState(ownership(config.Tags, r), "Configuration set ownership mismatch.");
  for (const arn of [s.identityArn, s.configurationSetArn]) {
    requireState(
      canonical(await resourceTenants(d, arn)) === canonical([s.tenant]),
      "SES resource is missing its exclusive tenant association.",
    );
  }
  requireState(
    canonical((await tenantResources(d, s.tenant)).sort()) ===
      canonical([s.identityArn, s.configurationSetArn].sort()),
    "Tenant contains foreign or missing resources.",
  );
}

export interface EnsureSenderOptions {
  project: string;
  domain: string;
  region: string;
  from?: string[];
  dryRun?: boolean;
  rotate?: boolean;
}
export async function ensureSender(
  d: SenderDeps,
  opts: EnsureSenderOptions,
): Promise<{
  spec: SesSenderSpec;
  policy: ReturnType<typeof senderPolicy>;
  changes: string[];
  record?: SenderRecord;
}> {
  // All reads/preconditions precede writes. Dry-run never saves keys, creates
  // resources, repairs IAM policies, or writes app env.
  const account = (await d.sts.send(new GetCallerIdentityCommand({}))).Account ?? "";
  const old = await d.store.read();
  const s = senderSpec(
    opts.project,
    opts.domain,
    account,
    opts.region,
    opts.from ?? (old?.spec.domain === opts.domain ? old.spec.from : undefined),
  );
  await auditBoundary(d, s);
  const changes: string[] = [];
  if (old) {
    requireState(
      canonical(old.spec) === canonical(s),
      "Sender scope changed. Use a reviewed migration; do not reuse credentials across domains, accounts, regions or From addresses.",
    );
    await auditSender(d, old);
    if (!opts.rotate)
      return {
        spec: s,
        policy: senderPolicy(s),
        changes,
        record: opts.dryRun ? undefined : old,
      };
    requireState(
      !old.previous,
      "A previous key is still active. Deploy/verify the current key, then explicitly retire the previous key before rotating again.",
    );
    changes.push(
      "create a new restricted sender key; retain the previous key until explicit retirement",
    );
  } else {
    await identityCheck(d, s);
    const user = await absent(
      () => d.iam.send(new GetUserCommand({ UserName: s.user })),
      "NoSuchEntityException",
    );
    const tenant = await absent(
      () => d.ses.send(new GetTenantCommand({ TenantName: s.tenant })),
      "NotFoundException",
    );
    const config = await absent(
      () =>
        d.ses.send(
          new GetConfigurationSetCommand({
            ConfigurationSetName: s.configurationSet,
          }),
        ),
      "NotFoundException",
    );
    requireState(
      !user && !tenant && !config,
      "Sender name collision without a matching ownership journal. Refusing to adopt existing IAM/SES resources.",
    );
    requireState(
      !(await resourceTenants(d, s.identityArn)).length,
      "Identity already belongs to a tenant; refusing shared identity adoption.",
    );
    changes.push(
      `create tenant ${s.tenant} and dedicated configuration set`,
      `associate verified identity ${s.identityArn} with that tenant`,
      `create IAM user /hatchkit/ses/${s.user} with the displayed policy`,
      "store project key and ownership journal in Hatchkit's keychain",
    );
  }
  if (opts.dryRun) return { spec: s, policy: senderPolicy(s), changes };
  const r: SenderRecord = old
    ? structuredClone(old)
    : {
        version: 1,
        owner: randomUUID(),
        spec: s,
        phase: "preparing",
        associations: [],
      };
  const undo: (() => Promise<unknown>)[] = [];
  let inFlight: string | undefined;
  async function mutation<T>(operation: string, run: () => Promise<T>): Promise<T> {
    // Persist intent BEFORE every remote mutation, including rotation. A crash
    // after AWS accepts CreateAccessKey must not erase the ownership evidence.
    await d.store.write({
      ...r,
      phase: "preparing",
      pendingOperation: operation,
    });
    inFlight = operation;
    const result = await run();
    inFlight = undefined;
    return result;
  }
  try {
    if (!old) {
      await d.store.write(r);
      const tenant = await mutation("CreateTenant", () =>
        d.ses.send(new CreateTenantCommand({ TenantName: s.tenant, Tags: tags(r) })),
      );
      undo.push(() => d.ses.send(new DeleteTenantCommand({ TenantName: s.tenant })));
      r.tenantArn = tenant.TenantArn;
      requireState(r.tenantArn, "SES did not return a tenant ARN.");
      await d.store.write(r);
      await mutation("CreateConfigurationSet", () =>
        d.ses.send(
          new CreateConfigurationSetCommand({
            ConfigurationSetName: s.configurationSet,
            Tags: tags(r),
          }),
        ),
      );
      undo.push(() =>
        d.ses.send(
          new DeleteConfigurationSetCommand({
            ConfigurationSetName: s.configurationSet,
          }),
        ),
      );
      r.configurationCreated = true;
      await d.store.write(r);
      for (const arn of [s.identityArn, s.configurationSetArn]) {
        await mutation("CreateTenantResourceAssociation", () =>
          d.ses.send(
            new CreateTenantResourceAssociationCommand({
              TenantName: s.tenant,
              ResourceArn: arn,
            }),
          ),
        );
        undo.push(() =>
          d.ses.send(
            new DeleteTenantResourceAssociationCommand({
              TenantName: s.tenant,
              ResourceArn: arn,
            }),
          ),
        );
        r.associations.push(arn);
        await d.store.write(r);
      }
      const created = await mutation("CreateUser", () =>
        d.iam.send(
          new CreateUserCommand({
            UserName: s.user,
            Path: "/hatchkit/ses/",
            PermissionsBoundary: operatorScope(s.account, s.region).boundaryArn,
            Tags: tags(r),
          }),
        ),
      );
      undo.push(() => d.iam.send(new DeleteUserCommand({ UserName: s.user })));
      r.userId = created.User?.UserId;
      requireState(r.userId, "IAM did not return the sender UserId.");
      await d.store.write(r);
      await mutation("PutUserPolicy", () =>
        d.iam.send(
          new PutUserPolicyCommand({
            UserName: s.user,
            PolicyName: SENDER_POLICY_NAME,
            PolicyDocument: JSON.stringify(senderPolicy(s)),
          }),
        ),
      );
      undo.push(() =>
        d.iam.send(
          new DeleteUserPolicyCommand({
            UserName: s.user,
            PolicyName: SENDER_POLICY_NAME,
          }),
        ),
      );
      r.policyCreated = true;
      await d.store.write(r);
    }
    const key = (
      await mutation("CreateAccessKey", () =>
        d.iam.send(new CreateAccessKeyCommand({ UserName: s.user })),
      )
    ).AccessKey;
    if (key?.AccessKeyId)
      undo.push(() =>
        d.iam.send(
          new DeleteAccessKeyCommand({
            UserName: s.user,
            AccessKeyId: key.AccessKeyId,
          }),
        ),
      );
    requireState(
      key?.AccessKeyId && key.SecretAccessKey,
      "IAM did not return a complete sender key.",
    );
    r.previous = old?.current;
    r.current = { id: key.AccessKeyId, secret: key.SecretAccessKey };
    r.phase = "ready";
    // A policy/association change or unknown grant during provisioning fails
    // closed. Eventual consistency may require a retry; never broaden access.
    await auditSender(d, r);
    await d.store.write(r);
    return { spec: s, policy: senderPolicy(s), changes, record: r };
  } catch (err) {
    const uncertain =
      !!inFlight &&
      ![
        "AccessDenied",
        "AccessDeniedException",
        "EntityAlreadyExistsException",
        "AlreadyExistsException",
        "LimitExceededException",
        "BadRequestException",
      ].includes(errorName(err));
    let cleanupFailed = uncertain;
    for (const action of undo.reverse()) {
      try {
        await action();
      } catch {
        cleanupFailed = true;
      }
    }
    if (!cleanupFailed) {
      try {
        await d.store.write(old);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      r.phase = "preparing";
      r.pendingOperation = inFlight ?? "cleanup";
      try {
        await d.store.write(r);
      } catch {
        /* Keep the last durable intent. */
      }
    }
    // No raw provider exception text: it can contain request/secret fields.
    throw new Error(
      `SES sender provision failed (${errorName(err)}). ${err instanceof Error && err.name === "Error" ? err.message : "Check the provisioner's permissions and AWS state."} ${cleanupFailed ? "Cleanup incomplete or AWS outcome unknown: retain the keychain ownership journal and review the rollback recipe; do not adopt colliding resources." : "Only this attempt's new resources/key were removed; the previous sender key is unchanged."}\n${senderSetupInstructions()}`,
    );
  }
}

/** Retire only the recorded previous key, after the operator verifies rollout.
 * On a local save failure, retry is safe (the missing key is already retired).
 */
export async function retirePreviousSenderKey(d: SenderDeps, dryRun = false): Promise<string> {
  const r = await d.store.read();
  requireState(r?.phase === "ready" && r.current, "No ready sender journal.");
  if (!r.previous) return "No previous sender key to retire.";
  await ownedUser(d, r);
  const account = (await d.sts.send(new GetCallerIdentityCommand({}))).Account;
  requireState(account === r.spec.account, "Wrong AWS account.");
  const res = await d.iam.send(new ListAccessKeysCommand({ UserName: r.spec.user }));
  requireState(
    !res.IsTruncated &&
      res.AccessKeyMetadata &&
      res.AccessKeyMetadata.some((k) => k.AccessKeyId === r.current?.id && k.Status === "Active"),
    "Current key is not active; refusing retirement.",
  );
  requireState(
    res.AccessKeyMetadata.every((k) => [r.current?.id, r.previous?.id].includes(k.AccessKeyId)),
    "Unowned sender key exists.",
  );
  if (dryRun)
    return "Would retire the recorded previous key. Deploy and verify current credentials first.";
  if (res.AccessKeyMetadata.some((k) => k.AccessKeyId === r.previous?.id))
    await d.iam.send(
      new DeleteAccessKeyCommand({
        UserName: r.spec.user,
        AccessKeyId: r.previous.id,
      }),
    );
  r.previous = undefined;
  await d.store.write(r);
  return "Previous sender key retired.";
}

/** Reviewable, ownership-scoped undo. No identity deletion, DNS, feedback,
 * Listmonk or provisioner changes. Values here are resource identifiers only.
 */
export function senderRollbackRecipe(r: SenderRecord): string[] {
  const s = r.spec;
  const cli = `--region ${s.region}`;
  const out = [
    "Restore the app's previous transport/env and verify delivery before revoking a deployed key. Use the provisioner locally; do not export its keys into the app.",
    "Re-read IAM UserId and hatchkit-owner tags before executing; abort if they differ from the stored journal.",
  ];
  if (r.pendingOperation)
    out.push(
      `Incomplete operation: ${r.pendingOperation}. Read AWS state before cleanup; the last request may have succeeded.`,
      `aws iam get-user --user-name ${s.user}`,
      `aws iam list-access-keys --user-name ${s.user}`,
      `aws sesv2 get-tenant ${cli} --tenant-name ${s.tenant}`,
      `aws sesv2 get-configuration-set ${cli} --configuration-set-name ${s.configurationSet}`,
      "Match hatchkit-owner and project tags to the journal. An unrecorded key created by an interrupted request must be identified and revoked manually; never guess ownership from a name alone.",
    );
  for (const k of [r.current, r.previous])
    if (k) out.push(`aws iam delete-access-key --user-name ${s.user} --access-key-id ${k.id}`);
  if (r.policyCreated)
    out.push(
      `aws iam delete-user-policy --user-name ${s.user} --policy-name ${SENDER_POLICY_NAME}`,
    );
  if (r.userId) out.push(`aws iam delete-user --user-name ${s.user}`);
  for (const arn of r.associations)
    out.push(
      `aws sesv2 delete-tenant-resource-association ${cli} --tenant-name ${s.tenant} --resource-arn ${arn}`,
    );
  if (r.configurationCreated)
    out.push(
      `aws sesv2 delete-configuration-set ${cli} --configuration-set-name ${s.configurationSet}`,
    );
  if (r.tenantArn) out.push(`aws sesv2 delete-tenant ${cli} --tenant-name ${s.tenant}`);
  out.push(
    "After AWS confirms cleanup, remove only this project's ses:project:<project>:sender-v1 keychain item. Preserve the existing verified identity and its DNS/feedback settings.",
  );
  return out;
}
