/*
 * The Cloudflare token Terraform runs with — never hatchkit's own.
 *
 * hatchkit's operator token (`cloudflare:operator`) can mint tokens, so
 * it is root-equivalent for the account. Terraform and its provider
 * plugin only need `data "cloudflare_zone"` and `cloudflare_record` on
 * one zone (infra/terraform/modules/cloudflare-dns). So each run gets an
 * ACCOUNT-owned token minted for it:
 *
 *   permission groups  Zone Read + DNS Write
 *   resource           com.cloudflare.api.account.zone.<zone id>
 *   expires_on         one hour ahead
 *   name               hatchkit-terraform-<project>-<time>
 *
 * `withTerraformCloudflareToken` revokes it in a `finally` when the run
 * ends; if that fails or the process dies, it expires on its own. The minted policy is read back before use and the run fails
 * closed on anything broader.
 *
 * Stacks that need more than DNS (`hatchkit infra`, cli/src/infra/) get
 * the same treatment through `mintTerraformToken`: exactly the grants the
 * stack lists, read back and compared before Terraform sees the value.
 *
 * A token from the legacy `dns:cloudflare:token` slot is passed through
 * unchanged: it is DNS-scoped already and may not hold the minting
 * grant. When minting fails with any other token, the run stops; the
 * operator token is never handed to Terraform as a fallback.
 */

import chalk from "chalk";
import { type CfTokenPolicy, CloudflareApi, type CloudflareZone } from "../utils/cloudflare-api.js";
import { SECRET_KEYS } from "../utils/secrets.js";

/** Permission groups of the per-run token, as `/tokens/permission_groups` names them. */
export const TERRAFORM_TOKEN_GROUPS = ["Zone Read", "DNS Write"] as const;

/** How long a per-run token lives if nobody revokes it. */
export const TERRAFORM_TOKEN_TTL_MS = 60 * 60 * 1000;

export const zoneResource = (zoneId: string): string => `com.cloudflare.api.account.zone.${zoneId}`;

/** The calls this module makes — a subset of CloudflareApi, so tests can pass a fake. */
export type TerraformTokenApi = Pick<
  CloudflareApi,
  "permissionGroupIds" | "createAccountToken" | "getAccountToken" | "deleteAccountToken"
>;

export interface TerraformCloudflareToken {
  /** What to put in `TF_VAR_cloudflare_api_token`. */
  value: string;
  /** True when `value` was minted for this run. */
  minted: boolean;
  /** Revoke the minted token. No-op for a passed-through legacy token. Never throws. */
  revoke(): Promise<void>;
}

/** Cloudflare wants `expires_on` without milliseconds. */
function cloudflareTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const accountResource = (accountId: string): string =>
  `com.cloudflare.api.account.${accountId}`;

/** One grant of a per-run token: these permission groups on one resource. */
export interface TerraformTokenGrant {
  groups: readonly string[];
  /** `accountResource(id)` or `zoneResource(id)`. */
  resource: string;
}

const sortedNames = (names: readonly string[]): string => JSON.stringify([...names].sort());

/** True when `policies` grant exactly `grants`: one allow policy per
 *  grant, each on its one resource with exactly its groups, and nothing
 *  else. Pure. */
export function policiesMatchGrants(
  policies: readonly CfTokenPolicy[],
  grants: readonly TerraformTokenGrant[],
): boolean {
  if (policies.length !== grants.length) return false;
  const remaining = [...grants];
  for (const policy of policies) {
    if (policy.effect !== "allow") return false;
    const resources = Object.entries(policy.resources);
    if (resources.length !== 1 || resources[0][1] !== "*") return false;
    const names = sortedNames(policy.permission_groups.map((g) => g.name ?? ""));
    const i = remaining.findIndex(
      (grant) => grant.resource === resources[0][0] && sortedNames(grant.groups) === names,
    );
    if (i < 0) return false;
    remaining.splice(i, 1);
  }
  return remaining.length === 0;
}

/** True when the policies grant exactly `TERRAFORM_TOKEN_GROUPS` on the one zone. Pure. */
export function isOneZoneDnsPolicy(policies: readonly CfTokenPolicy[], zoneId: string): boolean {
  return policiesMatchGrants(policies, [
    { groups: TERRAFORM_TOKEN_GROUPS, resource: zoneResource(zoneId) },
  ]);
}

/** Mint an account token with exactly `grants`, read it back, and revoke
 *  it again unless the read-back policy is exactly what was asked for.
 *  `fail` words the error for the caller's case. */
export async function mintTerraformToken(params: {
  token: string;
  accountId: string;
  /** Goes into the name `hatchkit-terraform-<label>-<time>`, which the
   *  Cloudflare audit recognises (audit/cloudflare.ts TERRAFORM_TOKEN_NAME). */
  label: string;
  grants: readonly TerraformTokenGrant[];
  fail: (why: string) => Error;
  /** Error text when the read-back policy differs from `grants`. */
  mismatch: string;
  api?: TerraformTokenApi;
  now?: () => Date;
}): Promise<TerraformCloudflareToken> {
  const { accountId, fail } = params;
  const api = params.api ?? new CloudflareApi({ token: params.token, accountId });
  const now = params.now?.() ?? new Date();

  let created: { id: string; value: string };
  try {
    const policies = [];
    for (const grant of params.grants) {
      const groupIds = await api.permissionGroupIds(accountId, grant.groups);
      policies.push({
        effect: "allow" as const,
        permission_groups: groupIds.map((id) => ({ id })),
        resources: { [grant.resource]: "*" },
      });
    }
    created = await api.createAccountToken({
      accountId,
      name: `hatchkit-terraform-${params.label}-${cloudflareTime(now).replace(/[-:]/g, "")}`,
      policies,
      expiresOn: cloudflareTime(new Date(now.getTime() + TERRAFORM_TOKEN_TTL_MS)),
    });
  } catch (err) {
    throw fail((err as Error).message);
  }

  const revoke = async () => {
    try {
      await api.deleteAccountToken(accountId, created.id);
    } catch (err) {
      console.log(
        chalk.yellow(
          `  ! Could not revoke the Terraform token ${created.id} (${(err as Error).message}); it expires within the hour.`,
        ),
      );
    }
  };

  let policies: CfTokenPolicy[] | undefined;
  try {
    policies = (await api.getAccountToken(accountId, created.id))?.policies;
  } catch (err) {
    await revoke();
    throw fail(`could not read the minted token back (${(err as Error).message})`);
  }
  if (!policies || !policiesMatchGrants(policies, params.grants)) {
    await revoke();
    throw fail(params.mismatch);
  }
  return { value: created.value, minted: true, revoke };
}

/** The token one Terraform run uses for `zone`. See the file header. */
export async function terraformCloudflareToken(params: {
  token: string;
  /** Keychain slot `token` came from (`DnsConfig.apiTokenSource`). */
  source?: string;
  zone: CloudflareZone;
  /** Used when the zone lookup did not report its account. */
  accountId?: string;
  /** Project name for the token's display name; the zone when absent. */
  label?: string;
  api?: TerraformTokenApi;
  now?: () => Date;
}): Promise<TerraformCloudflareToken> {
  if (params.source === SECRET_KEYS.dnsCloudflareToken) {
    return { value: params.token, minted: false, revoke: async () => {} };
  }
  const { zone } = params;
  const accountId = zone.account?.id ?? params.accountId;
  const fail = (why: string) =>
    new Error(
      `Could not mint a DNS-only Terraform token for ${zone.name}: ${why}\n` +
        "  The Cloudflare operator token needs Account → Account API Tokens → Edit.\n" +
        "  hatchkit does not hand its own Cloudflare token to Terraform.",
    );
  if (!accountId) throw fail("the zone's account is unknown");
  return mintTerraformToken({
    token: params.token,
    accountId,
    label: params.label ?? zone.name,
    grants: [{ groups: TERRAFORM_TOKEN_GROUPS, resource: zoneResource(zone.id) }],
    fail,
    mismatch: "the minted token's policy is not Zone Read + DNS Write on this zone alone",
    api: params.api,
    now: params.now,
  });
}

/** Run `fn` with the token from `terraformCloudflareToken` and revoke it
 *  afterwards, whether `fn` returns or throws. `fn` gets the value for
 *  `TF_VAR_cloudflare_api_token`; hatchkit's own token never reaches it
 *  unless it is the legacy DNS-only one. */
export async function withTerraformCloudflareToken<T>(
  params: Parameters<typeof terraformCloudflareToken>[0],
  fn: (tfToken: string) => Promise<T>,
): Promise<T> {
  const token = await terraformCloudflareToken(params);
  try {
    return await fn(token.value);
  } finally {
    await token.revoke();
  }
}
