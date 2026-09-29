/*
 * One Cloudflare token per Worker — what a Worker repo's CI holds.
 *
 * ---------------------------------------------------------------------
 * Why not one token for every repo
 * ---------------------------------------------------------------------
 *
 * Older hatchkit pushed ONE Cloudflare token (`cloudflare:workers:token`)
 * to every Worker repo, and its setup text asked for Workers Scripts on
 * the account plus DNS and Workers Routes on every zone. A leak from any
 * one repo could then redeploy every Worker and rewrite every zone's DNS.
 * CI needs none of that: `wrangler deploy` of a static-assets Worker only
 * uploads that one Worker.
 *
 * ---------------------------------------------------------------------
 * The token
 * ---------------------------------------------------------------------
 *
 * The provisioner (keychain, see `getCloudflareProvisioner`) mints an
 * ACCOUNT-owned token named `hatchkit-<worker>-worker` with one policy:
 * the role "Individual Workers Editor" on the resource
 * `com.cloudflare.edge.worker.script.<worker id>`. The id is the Worker's
 * immutable tag (`GET /accounts/{a}/workers/workers/{name}` → `id`).
 * Editor can upload, deploy and configure that Worker; it cannot create
 * or delete a Worker, touch another one, routes, custom domains or DNS.
 *
 * Per-Worker roles are documented at:
 * https://developers.cloudflare.com/workers/authorization/workers/
 * The API resource key remains a compatibility assumption. Read back
 * each minted policy before publication and fail closed on rejection.
 * Read probes are preflight checks, not proof of a successful deployment.
 * Never downgrade to an account-wide token. CI can also access resources
 * already bound to the Worker through deployed code; audit those bindings.
 *
 * A per-Worker role can only name a Worker that exists. A new project's
 * Worker is therefore created empty by the provisioner first; the first
 * CI deploy uploads the site.
 *
 * Rotation revokes only the token id recorded for this repo and account,
 * after the replacement is published. A matching display name alone is
 * not proof of ownership. Unknown/orphaned tokens need operator review.
 */

import type { CfTokenPolicy } from "../utils/cloudflare-api.js";

/** The per-Worker role, as `/tokens/permission_groups` names it. */
export const WORKER_TOKEN_GROUP = "Individual Workers Editor";
/** Legacy account-wide grant, recognized only to flag unsafe records. */
export const ACCOUNT_FALLBACK_GROUP = "Workers Scripts Write";

export type DeployTokenScope = "worker" | "account";

export const workerDeployTokenName = (worker: string): string => `hatchkit-${worker}-worker`;

/** The token-policy resource key of one Worker. */
export const workerScriptResource = (workerId: string): string =>
  `com.cloudflare.edge.worker.script.${workerId}`;

const accountResource = (accountId: string): string => `com.cloudflare.api.account.${accountId}`;

/** The only policy Hatchkit creates for Worker CI. */
export function workerDeployTokenPolicy(params: {
  workerId: string;
  groupId: string;
}): Array<{
  effect: "allow";
  permission_groups: Array<{ id: string }>;
  resources: Record<string, "*">;
}> {
  if (!/^[0-9a-f]{32}$/i.test(params.workerId) || !params.groupId) {
    throw new Error("A valid immutable Worker id and Editor role are required");
  }
  return [
    {
      effect: "allow",
      permission_groups: [{ id: params.groupId }],
      resources: { [workerScriptResource(params.workerId)]: "*" },
    },
  ];
}

/** What a token's policies (as `GET …/tokens/{id}` returns them) reach:
 *  `worker` — only the named Worker; `account` — Workers Scripts Write on
 *  the account and nothing else; `broader` — anything more. Pure. */
export function classifyDeployTokenPolicies(
  policies: readonly CfTokenPolicy[],
  target: { accountId: string; workerId: string },
): DeployTokenScope | "broader" {
  if (policies.length !== 1) return "broader";
  const [policy] = policies;
  const resources = Object.entries(policy.resources);
  if (
    policy.effect !== "allow" ||
    resources.length !== 1 ||
    resources[0][1] !== "*" ||
    policy.permission_groups.length !== 1
  )
    return "broader";
  const group = policy.permission_groups[0];
  if (
    resources[0][0] === workerScriptResource(target.workerId) &&
    group.name === WORKER_TOKEN_GROUP
  )
    return "worker";
  if (
    resources[0][0] === accountResource(target.accountId) &&
    group.name === ACCOUNT_FALLBACK_GROUP
  )
    return "account";
  return "broader";
}

/** The provisioner calls this module makes — a subset of CloudflareApi,
 *  so tests can pass a fake. */
export class DeployTokenError extends Error {}

export interface DeployTokenApi {
  permissionGroupIds(accountId: string, names: readonly string[]): Promise<string[]>;
  createAccountToken(params: {
    accountId: string;
    name: string;
    policies: ReturnType<typeof workerDeployTokenPolicy>;
  }): Promise<{ id: string; value: string }>;
  getAccountToken(
    accountId: string,
    tokenId: string,
  ): Promise<{
    status: string;
    policies?: CfTokenPolicy[];
  } | null>;
  deleteAccountToken(accountId: string, tokenId: string): Promise<"deleted" | "not-found">;
}

export interface MintedDeployToken {
  tokenId: string;
  /** The token value. Goes straight into the repo's Actions secret; never
   *  printed, never stored. */
  value: string;
  tokenName: string;
  scope: "worker";
}

/** Read preflight failures for a candidate (empty does not prove writes). */
export type DeployTokenCheck = (value: string) => Promise<string[]>;

/** Retry a check while it refuses: a new token takes a few seconds to be
 *  honoured everywhere, and a refusal in that window is not a verdict. */
export function withPropagationRetry(
  check: DeployTokenCheck,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): DeployTokenCheck {
  const attempts = Math.max(1, opts.attempts ?? 6);
  const delayMs = opts.delayMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return async (value) => {
    let refused: string[] = [];
    for (let i = 0; i < attempts; i++) {
      refused = await check(value);
      if (refused.length === 0) return [];
      if (i < attempts - 1) await sleep(delayMs);
    }
    return refused;
  };
}

/** Mint and read back an exact per-Worker Editor policy. Failure never
 *  widens the scope. A failed candidate is revoked; failed cleanup is
 *  reported explicitly using its id, never its value. */
export async function mintWorkerDeployToken(
  api: DeployTokenApi,
  params: {
    accountId: string;
    worker: string;
    workerId: string;
    check: DeployTokenCheck;
  },
): Promise<MintedDeployToken> {
  const tokenName = workerDeployTokenName(params.worker);
  let groupId: string;
  try {
    [groupId] = await api.permissionGroupIds(params.accountId, [WORKER_TOKEN_GROUP]);
  } catch {
    throw new DeployTokenError("Per-Worker Editor role lookup failed; no token created");
  }
  const policies = workerDeployTokenPolicy({
    workerId: params.workerId,
    groupId,
  });
  let created: { id: string; value: string };
  try {
    created = await api.createAccountToken({
      accountId: params.accountId,
      name: tokenName,
      policies,
    });
  } catch {
    throw new DeployTokenError(
      `Per-Worker token creation failed for ${params.worker}; no broader fallback. If the response was lost, review ${tokenName} in the dashboard before retrying`,
    );
  }
  try {
    const saved = await api.getAccountToken(params.accountId, created.id);
    const policy = saved?.policies?.[0];
    if (
      saved?.status !== "active" ||
      saved.policies?.length !== 1 ||
      policy?.effect !== "allow" ||
      policy.permission_groups.length !== 1 ||
      policy.permission_groups[0].id !== groupId ||
      Object.keys(policy.resources).length !== 1 ||
      policy.resources[workerScriptResource(params.workerId)] !== "*"
    ) {
      throw new Error("Cloudflare did not return the requested per-Worker Editor policy");
    }
    const refused = await params.check(created.value);
    if (refused.length) throw new Error(`Worker read preflight failed: ${refused.join("; ")}`);
    return {
      tokenId: created.id,
      value: created.value,
      tokenName,
      scope: "worker",
    };
  } catch {
    try {
      await api.deleteAccountToken(params.accountId, created.id);
    } catch {
      throw new DeployTokenError(
        `Per-Worker token validation failed; cleanup also failed for ${tokenName} (${maskId(created.id)}). Review that token in the dashboard.`,
      );
    }
    throw new DeployTokenError(
      `Per-Worker token validation failed for ${params.worker}; candidate revoked. No account-wide fallback.`,
    );
  }
}

/** The first four characters — enough to match a token id against the
 *  dashboard without printing the whole id. */
export const maskId = (id: string): string => (id.length > 8 ? `${id.slice(0, 4)}…` : "…");
