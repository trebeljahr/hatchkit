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

/** True when the policies grant exactly `TERRAFORM_TOKEN_GROUPS` on the one zone. Pure. */
export function isOneZoneDnsPolicy(policies: readonly CfTokenPolicy[], zoneId: string): boolean {
  if (policies.length !== 1) return false;
  const [policy] = policies;
  if (policy.effect !== "allow") return false;
  const resources = Object.entries(policy.resources);
  if (resources.length !== 1 || resources[0][0] !== zoneResource(zoneId) || resources[0][1] !== "*")
    return false;
  const names = policy.permission_groups.map((g) => g.name).sort();
  return JSON.stringify(names) === JSON.stringify([...TERRAFORM_TOKEN_GROUPS].sort());
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
  const api = params.api ?? new CloudflareApi({ token: params.token, accountId });
  const now = params.now?.() ?? new Date();

  let created: { id: string; value: string };
  try {
    const groupIds = await api.permissionGroupIds(accountId, TERRAFORM_TOKEN_GROUPS);
    created = await api.createAccountToken({
      accountId,
      name: `hatchkit-terraform-${params.label ?? zone.name}-${cloudflareTime(now).replace(/[-:]/g, "")}`,
      policies: [
        {
          effect: "allow",
          permission_groups: groupIds.map((id) => ({ id })),
          resources: { [zoneResource(zone.id)]: "*" },
        },
      ],
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
  if (!policies || !isOneZoneDnsPolicy(policies, zone.id)) {
    await revoke();
    throw fail("the minted token's policy is not Zone Read + DNS Write on this zone alone");
  }
  return { value: created.value, minted: true, revoke };
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
