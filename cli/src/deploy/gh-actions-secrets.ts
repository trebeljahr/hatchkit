/*
 * GitHub Actions secrets helpers shared by `hatchkit adopt`,
 * `hatchkit create`, `hatchkit sync`, `hatchkit cloudflare` and
 * `hatchkit secrets isolate`. The Cloudflare half (per-Worker tokens) is
 * at the bottom; its model is in deploy/cloudflare-deploy-token.ts.
 *
 * Those flows scaffold a GitHub Actions workflow that builds the
 * Docker image, pushes to GHCR, and triggers Coolify to redeploy.
 * Setting the workflow's secrets must happen BEFORE the first git
 * push, otherwise the workflow's first run hits the "secret not
 * set — skipping deploy trigger" branch and silently no-ops.
 *
 * ---------------------------------------------------------------------
 * No Coolify API token in a repo
 * ---------------------------------------------------------------------
 *
 * Every deploy secret pushed here is minted for ONE Coolify application:
 * the HMAC key of its manual webhook, plus the non-secret values the
 * signed payload has to name. Hatchkit's own Coolify token (root, the
 * provisioner) never leaves the keychain — see
 * deploy/coolify-deploy-hook.ts for why a Coolify token cannot be scoped
 * any tighter than "every app on the host".
 *
 * `COOLIFY_API_TOKEN` / `COOLIFY_TOKEN` (the provisioner, as older
 * hatchkit pushed it) and `COOLIFY_WEBHOOK_URL` (an `/api/v1/deploy`
 * URL that only works with that token) are cleared — but only once the
 * repo's workflows no longer read them, so a sync on a project whose
 * workflow has not been converted yet does not stop its deploys.
 * `hatchkit secrets isolate` converts the workflow and clears them in
 * one go.
 *
 * Which per-app secrets get pushed depends on the project's topology,
 * and the two sets are MUTUALLY EXCLUSIVE:
 *
 *   single-app — ONE Coolify app runs the whole deployment:
 *     COOLIFY_RESOURCE_UUID, COOLIFY_DEPLOY_SECRET,
 *     COOLIFY_DEPLOY_REPOSITORY, COOLIFY_DEPLOY_BRANCH.
 *
 *   split — `<name>-client` on the bare domain, `<name>-server` on
 *   api.<domain>: the same four names with CLIENT_ / SERVER_ after
 *   `COOLIFY_`, one set per app.
 *
 * Plus COOLIFY_BASE_URL for both.
 *
 * ---------------------------------------------------------------------
 * Why the paired names are spelled `COOLIFY_<ROLE>_…`
 * ---------------------------------------------------------------------
 *
 * A split project's CI has two apps to redeploy, and deploying them
 * separately is the whole point of the split — the server holds the
 * WebSocket connections, so a client-only change must not restart it.
 * `COOLIFY_<ROLE>_RESOURCE_UUID` (role in the middle) is what real
 * checked-in workflows read. A brief intermediate revision pushed
 * `COOLIFY_RESOURCE_UUID_<ROLE>`; any repo synced during that window has
 * the role-suffixed names, so they are cleared as stale below.
 *
 * Split does NOT also set the unprefixed names: the generated deploy job
 * guards each step on its own secret, so a split project holding both
 * would fire two concurrent deploys of the client app on every push.
 *
 * Idempotent (`gh secret set` upserts, and the stale-secret cleanup
 * treats "not found" as success).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { exec } from "../utils/exec.js";
import type { RunLedger } from "../utils/run-ledger.js";
import {
  type DeployTokenScope,
  DeployTokenError,
  WORKER_TOKEN_GROUP,
  classifyDeployTokenPolicies,
  maskId,
  mintWorkerDeployToken,
  withPropagationRetry,
  workerDeployTokenName,
} from "./cloudflare-deploy-token.js";
import {
  type DeployHook,
  PROVISIONER_DEPLOY_SECRET_NAMES,
  TOKEN_ONLY_DEPLOY_SECRET_NAMES,
  deployHookSecretNames,
  ensureDeployHook,
} from "./coolify-deploy-hook.js";

/** A Coolify application the workflow should redeploy on push. */
export interface CoolifyDeployApp {
  /** Coolify application uuid. */
  uuid: string;
  /** Which half of a `split` deployment this app is. Undefined for a
   *  single-app deployment, which has exactly one deploy trigger. */
  role?: "client" | "server";
}

export interface CoolifyDeploySecretsInput {
  /** Working directory that has `.git` + `gh` access. */
  projectDir: string;
  /** GitHub `<owner>/<repo>` slug. */
  repoSlug: string;
  /** One or more apps to wire deploy hooks for. Pass a single
   *  unlabelled entry for a single-app project; pass two entries
   *  carrying `role` for a `split` one. */
  apps: CoolifyDeployApp[];
  /** Mint fresh per-app deploy secrets even when the current ones are
   *  in sync — the per-project revocation path. */
  rotate?: boolean;
  /** Clear the provisioner-token secrets even though a workflow still
   *  reads them. `secrets isolate` passes this after rewriting the
   *  workflow; everything else leaves it off. */
  clearProvisionerSecrets?: boolean;
}

export interface CoolifyDeploySecretsResult {
  ok: boolean;
  /** Names of the secrets that were upserted. Used by the caller for
   *  the success log line. */
  pushed: string[];
  /** Names of stale secrets removed because they belong to the topology
   *  this project is NOT in, to a superseded spelling, or to the
   *  provisioner token. Empty when there was nothing to clean up. */
  removed: string[];
  /** Provisioner-token secrets left in place because a workflow still
   *  reads them. Non-empty means the repo is not isolated yet. */
  keptProvisioner: string[];
}

/** Secret name carrying a split half's application uuid. */
export function resourceUuidSecretName(role: "client" | "server"): string {
  return deployHookSecretNames(role).uuid;
}

const namesOf = (role?: "client" | "server"): string[] =>
  Object.values(deployHookSecretNames(role));

/** Names set under `split`, cleared under single-app. */
const PAIRED_SECRETS = [...namesOf("client"), ...namesOf("server")];

/** Names from the superseded role-suffixed spelling. Never set any
 *  more; always cleared, so a repo synced during that window converges
 *  instead of carrying both spellings forever. */
const LEGACY_ROLE_SUFFIXED_SECRETS = [
  "COOLIFY_RESOURCE_UUID_CLIENT",
  "COOLIFY_RESOURCE_UUID_SERVER",
  "COOLIFY_WEBHOOK_URL_CLIENT",
  "COOLIFY_WEBHOOK_URL_SERVER",
];

/** Everything that only works with the provisioner token. */
export const PROVISIONER_SECRETS: readonly string[] = [
  ...PROVISIONER_DEPLOY_SECRET_NAMES,
  ...TOKEN_ONLY_DEPLOY_SECRET_NAMES,
];

/** Which secrets a project's topology calls for, and which stale ones
 *  should be cleared. Pure — no network, no config lookup — so the
 *  single-vs-split decision is unit-testable without a `gh` binary or a
 *  Coolify install. {@link setCoolifyDeploySecrets} is the I/O wrapper
 *  around it.
 *
 *  The provisioner-token names are always in `staleToRemove`; the I/O
 *  wrapper decides whether it is safe to remove them yet. */
export function computeCoolifyDeploySecrets(input: {
  hooks: DeployHook[];
  coolifyUrl: string;
}): { secrets: Record<string, string>; staleToRemove: string[] } {
  const secrets: Record<string, string> = {
    COOLIFY_BASE_URL: input.coolifyUrl.replace(/\/$/, ""),
  };

  // A split project contributes one set per half. Sorted so the emitted
  // secret order (and therefore the log line) is stable regardless of
  // the order Coolify happened to list the applications in.
  const roled = input.hooks
    .filter((h): h is DeployHook & { role: "client" | "server" } => h.role !== undefined)
    .sort((a, b) => a.role.localeCompare(b.role));
  const put = (hook: DeployHook, role?: "client" | "server") => {
    const n = deployHookSecretNames(role);
    secrets[n.uuid] = hook.uuid;
    secrets[n.secret] = hook.secret;
    secrets[n.repository] = hook.repository;
    secrets[n.branch] = hook.branch;
  };

  if (roled.length > 0) {
    for (const hook of roled) put(hook, hook.role);
    // Split. No unprefixed names — see the module header: keeping them
    // would double-deploy the client on every push.
    return {
      secrets,
      staleToRemove: [...namesOf(), ...LEGACY_ROLE_SUFFIXED_SECRETS, ...PROVISIONER_SECRETS],
    };
  }

  put(input.hooks[0]);
  // Clear paired secrets left behind by a split that was reverted.
  // Otherwise they keep firing deploys against apps that no longer
  // exist.
  return {
    secrets,
    staleToRemove: [...PAIRED_SECRETS, ...LEGACY_ROLE_SUFFIXED_SECRETS, ...PROVISIONER_SECRETS],
  };
}

/** The secret NAMES a given set of apps would have pushed, without
 *  needing Coolify credentials to compute them.
 *
 *  Exists so adopt's `--resume` gate ("are all of these already on the
 *  repo? then skip the push") can't drift from what the push actually
 *  sets. A hardcoded list that missed one name would make --resume skip
 *  the push on a split project and leave its second app permanently
 *  untriggered — which is the bug this whole area keeps producing. */
export function coolifyDeploySecretNames(apps: CoolifyDeployApp[]): string[] {
  if (apps.length === 0) return [];
  // Values are irrelevant to the key set; placeholders keep this pure.
  return Object.keys(
    computeCoolifyDeploySecrets({
      hooks: apps.map((a) => ({ ...a, secret: "x", repository: "x/x", branch: "x" })),
      coolifyUrl: "https://x",
    }).secrets,
  );
}

/** Workflow files (repo-relative) that still read one of `names`. */
export function workflowsReading(projectDir: string, names: readonly string[]): string[] {
  const dir = join(projectDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    if (names.some((n) => new RegExp(`\\bsecrets\\.${n}\\b`).test(text))) {
      hits.push(`.github/workflows/${file}`);
    }
  }
  return hits;
}

/** Push the per-app deploy secrets the scaffolded GH Actions workflows
 *  need, minting (or adopting) each app's hook on Coolify first.
 *  Best-effort — failures don't roll anything back; the caller gets a
 *  copy-pasteable manual recipe instead. */
export async function setCoolifyDeploySecrets(
  input: CoolifyDeploySecretsInput,
): Promise<CoolifyDeploySecretsResult> {
  const none = { ok: false, pushed: [], removed: [], keptProvisioner: [] };
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    console.log(chalk.dim("  · Coolify not configured — skipping Actions secret push."));
    return none;
  }
  if (input.apps.length === 0) {
    console.log(chalk.dim("  · No Coolify apps to wire deploy hooks for — skipping."));
    return none;
  }

  const { CoolifyApi } = await import("../utils/coolify-api.js");
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const hooks: DeployHook[] = [];
  const hookSpinner = ora("Coolify: per-app deploy hooks").start();
  try {
    for (const app of input.apps) {
      const { hook, changes } = await ensureDeployHook(api, app.uuid, {
        role: app.role,
        rotate: input.rotate,
      });
      hooks.push(hook);
      if (changes.length > 0) {
        hookSpinner.info(`Coolify: ${app.role ?? "app"} ${app.uuid} — ${changes.join(", ")}`);
        hookSpinner.start("Coolify: per-app deploy hooks");
      }
    }
    hookSpinner.succeed(`Coolify: deploy hooks ready for ${hooks.length} app(s)`);
  } catch (err) {
    hookSpinner.fail(`Coolify: deploy hook setup failed — ${(err as Error).message}`);
    return none;
  }

  const { secrets, staleToRemove } = computeCoolifyDeploySecrets({
    hooks,
    coolifyUrl: cfg.url,
  });
  const names = Object.keys(secrets);
  const spinner = ora(
    `GitHub: setting ${names.length} Actions secret${names.length === 1 ? "" : "s"} on ${input.repoSlug}`,
  ).start();
  try {
    for (const [name, value] of Object.entries(secrets)) {
      await ghSecretSet(input.projectDir, input.repoSlug, name, value);
    }
  } catch (err) {
    spinner.fail(`GitHub: setting secrets failed — ${(err as Error).message}`);
    // Print names only. The values include the deploy secrets, and a
    // failed push is not a reason to spill them into the terminal (and
    // from there into scrollback, screen shares and pasted bug reports).
    console.log(
      chalk.dim(
        `  Re-run once \`gh\` can write secrets on ${input.repoSlug}. Names:\n` +
          names.map((n) => `    ${n}`).join("\n"),
      ),
    );
    return none;
  }

  // The provisioner-token names stay while a checked-in workflow still
  // reads them: removing them first would stop the project's deploys
  // until the workflow is converted. They are the whole point of this
  // module, so the caller hears about it.
  const stillRead = input.clearProvisionerSecrets
    ? []
    : workflowsReading(input.projectDir, PROVISIONER_SECRETS);
  const keepProvisioner = stillRead.length > 0;
  const removed: string[] = [];
  const keptProvisioner: string[] = [];
  for (const name of staleToRemove) {
    if (keepProvisioner && PROVISIONER_SECRETS.includes(name)) {
      if (await ghSecretExists(input.projectDir, input.repoSlug, name)) keptProvisioner.push(name);
      continue;
    }
    // Best-effort: a token without the scope to delete secrets still got
    // the push it came for, so a failure here degrades to a note.
    try {
      if ((await ghSecretDelete(input.repoSlug, name)) === "done") removed.push(name);
    } catch (err) {
      console.log(chalk.dim(`  · Couldn't remove stale ${name}: ${(err as Error).message}`));
    }
  }

  spinner.succeed(
    `GitHub: Actions secrets set (${names.join(", ")})` +
      (removed.length ? ` — removed ${removed.join(", ")}` : ""),
  );
  if (keptProvisioner.length > 0) {
    console.log(
      chalk.yellow(
        `  ! ${input.repoSlug} still holds ${keptProvisioner.join(", ")} (hatchkit's Coolify token) because\n` +
          `    ${stillRead.join(", ")} still read${stillRead.length === 1 ? "s" : ""} it. Run \`hatchkit secrets isolate\` to convert the workflow and remove it.`,
      ),
    );
  }
  return { ok: true, pushed: names, removed, keptProvisioner };
}

export interface CloudflareDeploySecretsInput {
  /** Working directory that has `.git` + `gh` access. */
  projectDir: string;
  /** GitHub `<owner>/<repo>` slug. */
  repoSlug: string;
  /** The Worker the repo deploys (`name` in wrangler.jsonc). */
  workerName: string;
  /** Create the Worker (empty) when the account has none by that name.
   *  `hatchkit cloudflare` passes it for a new project; the migration of
   *  an existing repo does not, since its Worker must already exist. */
  createWorker?: boolean;
  /** Mint a new token even when the repo holds the recorded one — the
   *  per-project revocation path. */
  rotate?: boolean;
  /** Read and plan only: no token, no secret, no Worker is created. */
  dryRun?: boolean;
  ledger?: RunLedger;
}

export interface CloudflareDeploySecretsResult {
  ok: boolean;
  /** Secret names set (or that would be, on a dry run). */
  pushed: string[];
  /** The repo already holds the recorded, active per-Worker token. */
  inSync?: boolean;
  worker?: { id: string; created: boolean };
  tokenName?: string;
  /** Masked. */
  tokenId?: string;
  scope?: DeployTokenScope;
  /** Masked ids of hatchkit's earlier tokens for this Worker, revoked
   *  (or that would be) once the repo holds the new one. */
  revoked: string[];
  /** One line per step, for a dry run. */
  plan: string[];
  error?: string;
}

/** The two repo-level secrets `cloudflare/wrangler-action@v4` reads. */
export const CLOUDFLARE_SECRET_NAMES = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

/** Give a Worker repo its own Cloudflare token and push it.
 *
 *  The token is minted by the keychain provisioner for this one Worker
 *  (deploy/cloudflare-deploy-token.ts); the provisioner itself never
 *  leaves the machine. When the repo already holds the token hatchkit
 *  recorded for it (same GitHub `updated_at`, token still active), no
 *  new token is minted unless `rotate`. hatchkit's earlier tokens for
 *  the Worker are revoked only after the new one is in the repo, so a
 *  failed push never leaves the repo without a working token.
 *
 *  Nothing here prints a token value: it goes to `gh secret set` on
 *  stdin, and ids are masked. A token that could not be pushed is
 *  revoked only when it is known not to have reached GitHub. Unknown write
 *  outcomes retain both tokens for recovery. */
export interface CloudflareDeployDependencies {
  provisioner: { token: string; accountId: string; source: string } | null;
  api: Pick<
    import("../utils/cloudflare-api.js").CloudflareApi,
    | "getWorker"
    | "createWorker"
    | "getAccountToken"
    | "permissionGroupIds"
    | "createAccountToken"
    | "deleteAccountToken"
  >;
  records: Record<string, import("../config.js").CloudflareDeployTokenRecord>;
  saveRecord: (record: import("../config.js").CloudflareDeployTokenRecord) => void;
  listSecrets: typeof listRepoSecrets;
  setSecret: typeof ghSecretSet;
  check: (value: string, accountId: string, worker: string) => Promise<string[]>;
}

export async function setCloudflareDeploySecrets(
  input: CloudflareDeploySecretsInput,
  dependencies?: CloudflareDeployDependencies,
): Promise<CloudflareDeploySecretsResult> {
  let deps = dependencies;
  const result: CloudflareDeploySecretsResult = {
    ok: false,
    pushed: [],
    revoked: [],
    plan: [],
  };
  if (!deps) {
    const config = await import("../config.js");
    const provisioner = await config.getCloudflareProvisioner();
    if (!provisioner) {
      result.error =
        "no Cloudflare provisioner in the keychain — run `hatchkit config add cloudflare-workers`";
      return result;
    }
    const { CloudflareApi } = await import("../utils/cloudflare-api.js");
    deps = {
      provisioner,
      api: new CloudflareApi({
        token: provisioner.token,
        accountId: provisioner.accountId,
      }),
      records: config.getCloudflareDeployTokenRecords(),
      saveRecord: config.setCloudflareDeployTokenRecord,
      listSecrets: listRepoSecrets,
      setSecret: ghSecretSet,
      check: (value, accountId, worker) =>
        withPropagationRetry((token) =>
          new CloudflareApi({ token }).workerDeployRefusals(accountId, worker),
        )(value),
    };
  }
  const { provisioner: prov, api } = deps;
  if (!prov) {
    result.error = "No Cloudflare provisioner configured";
    return result;
  }
  const accountId = prov.accountId;
  const tokenName = workerDeployTokenName(input.workerName);
  result.tokenName = tokenName;
  try {
    // A failed metadata read must stop before creating resources or replacing secrets.
    const secrets = await deps.listSecrets(input.repoSlug);
    if (!secrets)
      return { ...result, error: "Cannot read GitHub secret metadata; no changes made" };
    const record = deps.records[input.workerName];
    if (record && (record.repo !== input.repoSlug || record.accountId !== accountId)) {
      return {
        ...result,
        error: "Worker token record belongs to another repo or account; review it before migration",
      };
    }
    let worker = await api.getWorker(accountId, input.workerName);
    if (!worker && !input.createWorker)
      return { ...result, error: `Worker ${input.workerName} does not exist` };
    const created = !worker;
    if (!worker) {
      if (input.dryRun) {
        result.plan.push(`create empty Worker ${input.workerName}`);
        worker = { id: "(new)", name: input.workerName };
      } else {
        worker = await api.createWorker(accountId, input.workerName);
      }
    }
    result.worker = { id: worker.id, created };
    const current = secrets.find((secret) => secret.name === "CLOUDFLARE_API_TOKEN");
    const accountSecret = secrets.find((secret) => secret.name === "CLOUDFLARE_ACCOUNT_ID");
    const previous = record ? await api.getAccountToken(accountId, record.tokenId) : null;
    if (
      !input.rotate &&
      record &&
      record.workerId === worker.id &&
      record.secretUpdatedAt &&
      current?.updatedAt === record.secretUpdatedAt &&
      record.accountSecretUpdatedAt &&
      accountSecret?.updatedAt === record.accountSecretUpdatedAt &&
      previous?.status === "active" &&
      classifyDeployTokenPolicies(previous.policies ?? [], record) === "worker"
    ) {
      return {
        ...result,
        ok: true,
        inSync: true,
        tokenId: maskId(record.tokenId),
        scope: "worker",
      };
    }
    if (input.dryRun) {
      result.plan.push(
        `mint ${tokenName}: ${WORKER_TOKEN_GROUP} on Worker ${input.workerName}; read back policy and check access; stop on failure (no broader fallback)`,
        `set ${CLOUDFLARE_SECRET_NAMES.join(", ")} on ${input.repoSlug}`,
      );
      if (record)
        result.plan.push(
          `revoke recorded previous token ${maskId(record.tokenId)} only after confirmed replacement`,
        );
      return {
        ...result,
        ok: true,
        pushed: [...CLOUDFLARE_SECRET_NAMES],
        revoked: record ? [maskId(record.tokenId)] : [],
      };
    }
    const minted = await mintWorkerDeployToken(api, {
      accountId,
      worker: input.workerName,
      workerId: worker.id,
      check: (value) => deps.check(value, accountId, input.workerName),
    });
    result.tokenId = maskId(minted.tokenId);
    result.scope = "worker";
    // Record ownership immediately. A later failure must remain recoverable.
    input.ledger?.record({
      kind: "cloudflareWorkerToken",
      accountId,
      tokenId: minted.tokenId,
      worker: input.workerName,
    });
    try {
      // Set the non-secret account id first. Failure cannot replace the old token.
      await deps.setSecret(input.projectDir, input.repoSlug, "CLOUDFLARE_ACCOUNT_ID", accountId);
      result.pushed.push("CLOUDFLARE_ACCOUNT_ID");
    } catch {
      try {
        await api.deleteAccountToken(accountId, minted.tokenId);
        result.error =
          "Account-id secret update failed; unused candidate revoked; previous token retained";
      } catch {
        result.error = `Account-id secret update failed; candidate cleanup failed (${result.tokenId}); review the dashboard`;
      }
      return result;
    }
    try {
      await deps.setSecret(input.projectDir, input.repoSlug, "CLOUDFLARE_API_TOKEN", minted.value);
      result.pushed.push("CLOUDFLARE_API_TOKEN");
    } catch {
      // A lost response can mean GitHub DID write it. Never revoke a token
      // that CI may now hold, and never revoke the previous token here.
      result.error = `Token secret update outcome unknown; both tokens retained. Review candidate ${tokenName} (${result.tokenId}) and retry migration`;
      return result;
    }
    const after = await deps.listSecrets(input.repoSlug);
    const secretUpdatedAt = after?.find(
      (secret) => secret.name === "CLOUDFLARE_API_TOKEN",
    )?.updatedAt;
    const accountSecretUpdatedAt = after?.find(
      (secret) => secret.name === "CLOUDFLARE_ACCOUNT_ID",
    )?.updatedAt;
    deps.saveRecord({
      worker: input.workerName,
      workerId: worker.id,
      accountId,
      tokenId: minted.tokenId,
      tokenName,
      scope: "worker",
      repo: input.repoSlug,
      mintedAt: new Date().toISOString(),
      secretUpdatedAt,
      accountSecretUpdatedAt,
    });
    if (!secretUpdatedAt || !accountSecretUpdatedAt) {
      result.error =
        "Secrets written, but metadata verification failed; previous token retained. Retry migration";
      return result;
    }
    // Only an id we recorded for this exact repo/account is owned. A
    // matching token display name never grants permission to revoke it.
    if (record && record.tokenId !== minted.tokenId) {
      try {
        await api.deleteAccountToken(accountId, record.tokenId);
        result.revoked.push(maskId(record.tokenId));
      } catch {
        result.error = `Replacement installed; previous token cleanup failed (${maskId(record.tokenId)}). Revoke it after verifying deployment`;
        return result;
      }
    }
    result.ok = true;
    return result;
  } catch (error) {
    if (error instanceof DeployTokenError) return { ...result, error: error.message };
    // Provider errors may echo submitted credentials. Return context only.
    result.error =
      "Cloudflare token setup failed before completion. Check provisioner permissions and per-Worker policy support; review account tokens for any incomplete candidate";
    return result;
  }
}

/** Actions secret names and their `updated_at`, or null when `gh` can't
 *  list them (it never returns a value). */
export async function listRepoSecrets(
  repo: string,
): Promise<Array<{ name: string; updatedAt: string }> | null> {
  const res = await exec("gh", ["secret", "list", "--repo", repo, "--json", "name,updatedAt"], {
    silent: true,
  });
  if (res.exitCode !== 0) return null;
  try {
    return JSON.parse(res.stdout) as Array<{ name: string; updatedAt: string }>;
  } catch {
    return null;
  }
}

/** Upsert one repo-level Actions secret.
 *
 *  The value goes in on STDIN, not `--body`. Argv is world-readable on
 *  both Linux and macOS (`ps aux`, /proc/<pid>/cmdline), and the values
 *  here include deploy secrets and Cloudflare tokens. `gh secret set`
 *  reads the value from stdin when `--body` is absent, which keeps it
 *  out of the process list.
 *
 *  `silent` so a non-zero exit doesn't let exec() echo a stderr line
 *  that may quote the value back; the throw below carries the message. */
export async function ghSecretSet(
  cwd: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  const res = await exec("gh", ["secret", "set", name, "--repo", repo], {
    cwd,
    input: value,
    silent: true,
  });
  if (res.exitCode !== 0) {
    throw new Error(`gh secret set ${name} exited ${res.exitCode}`);
  }
}

/** Probe whether a repo-level Actions secret with the given name is
 *  already set on the repo. Used by adopt before recording a fresh
 *  secret in the ledger — we MUST NOT record (and thus risk rolling
 *  back) a secret the user set themselves before hatchkit ran.
 *
 *  Returns `true` (i.e., assume present, don't record) on probe
 *  failure too — `gh secret list` requires admin scope on private
 *  repos and the user's PAT may not have it. Erring toward "exists"
 *  is the safe direction: at worst destroy leaves the secret behind;
 *  the wrong direction would delete the user's data.
 */
export async function ghSecretExists(
  cwd: string,
  repoSlug: string,
  name: string,
): Promise<boolean> {
  const res = await exec(
    "gh",
    [
      "secret",
      "list",
      "--repo",
      repoSlug,
      "--json",
      "name",
      "-q",
      `.[] | select(.name=="${name}") | .name`,
    ],
    { cwd, silent: true },
  );
  if (res.exitCode !== 0) return true;
  return res.stdout.trim().length > 0;
}

/** Delete a repo-level Actions secret. Used by rollback. Returns
 *  "not-found" when the secret wasn't there (gh exits non-zero with
 *  "could not find secret" — treat as already-undone). */
export async function ghSecretDelete(
  repoSlug: string,
  name: string,
): Promise<"done" | "not-found"> {
  const res = await exec("gh", ["secret", "delete", name, "--repo", repoSlug], { silent: true });
  if (res.exitCode === 0) return "done";
  const msg = `${res.stderr}\n${res.stdout}`;
  // Older `gh` says "could not find secret"; newer ones pass the API's
  // "HTTP 404" through.
  if (/not found|could not find|HTTP 404/i.test(msg)) return "not-found";
  throw new Error(`gh secret delete ${name} exited ${res.exitCode}: ${res.stderr.trim()}`);
}

/** `owner/repo` from what Coolify stores in `git_repository`: a URL for
 *  public-repo apps, the bare `owner/repo` for GitHub-App ones (see
 *  `normalizeCoolifyGitRepository`). */
export function repoSlugFromCoolifyGitRepository(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return value.replace(/\.git$/, "");
  return repoSlugFromRemote(value);
}

/** Extract `owner/repo` from a git remote URL.
 *    git@github.com:owner/repo.git           → owner/repo
 *    https://github.com/owner/repo[.git]     → owner/repo
 *  Returns undefined for non-GitHub URLs. */
export function repoSlugFromRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return undefined;
}

/** Extract the `owner` segment alone from a GitHub remote URL. */
export function ownerFromRemote(url: string | undefined): string | undefined {
  const slug = repoSlugFromRemote(url);
  return slug?.split("/")[0];
}
