/*
 * Per-app deploy hooks — how CI deploys a Coolify app without holding a
 * Coolify API token.
 *
 * ---------------------------------------------------------------------
 * Why CI has no Coolify token any more
 * ---------------------------------------------------------------------
 *
 * Coolify's API tokens cannot be scoped to a resource. Its abilities are
 * `root`, `read`, `read:sensitive`, `write` and `deploy`, and every one
 * of them covers the whole team the token was created in (the running
 * build binds `team_id` at creation and filters every query by it). On a
 * Coolify install with one team and one server — which is every
 * self-hosted setup hatchkit targets — that means:
 *
 *   · `write` is root on the host: it can create an application whose
 *     compose mounts /var/run/docker.sock, or PATCH `git_repository` of
 *     any app to a repo that does.
 *   · `read:sensitive` reads every env of every app and service.
 *   · `deploy` can stop every other project's app.
 *
 * Hatchkit used to push its own ROOT token into every repo as
 * COOLIFY_API_TOKEN. One compromised repo — a malicious dependency in
 * CI, a leaked log, a workflow bug — exposed every project on the host.
 *
 * ---------------------------------------------------------------------
 * What CI holds instead
 * ---------------------------------------------------------------------
 *
 * One secret PER APPLICATION: the HMAC key of Coolify's manual GitHub
 * webhook (`manual_webhook_secret_github`). A push payload signed with it
 * queues a deploy of that one application and nothing else — the
 * endpoint checks each candidate application against its OWN secret.
 * It reads nothing, writes nothing, and cannot reach another app.
 *
 * Three settings make the endpoint usable for this and nothing more:
 *
 *   · The secret itself, random and unique per app. A NULL secret is
 *     worse than none: Coolify HMACs with the empty key, so anyone can
 *     sign. The GitLab/Gitea/Bitbucket slots get their own random
 *     values for the same reason and are never stored.
 *   · `is_auto_deploy_enabled = true`. The manual endpoint refuses to
 *     queue anything without it ("Deployments disabled.").
 *   · `watch_paths` = {@link DEPLOY_HOOK_WATCH_PATH}, a path no commit
 *     ever touches. Auto-deploy is ON, so without this every push that
 *     reaches Coolify through its GitHub App would deploy immediately —
 *     before CI has built the image. With it, only a payload that names
 *     that path (i.e. the one CI signs) deploys.
 *
 * The image to deploy is chosen in the REGISTRY, not in Coolify: apps
 * pull the moving tag {@link LIVE_TAG}, and CI promotes `:live` to the
 * commit it just built (with the job's own GITHUB_TOKEN, which can write
 * only this repo's packages) before it signs the webhook. See
 * utils/oci-registry.ts.
 *
 * Everything in this module that needs the Coolify token runs on the
 * operator's machine, with the provisioner credential from the keychain.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { CoolifyApi } from "../utils/coolify-api.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

/** The path CI's signed payload claims to have modified. No commit may
 *  ever create it: a real push touching it would deploy through the
 *  GitHub App before the image exists. */
export const DEPLOY_HOOK_WATCH_PATH = ".hatchkit/deploy-webhook";

/** The moving tag every app pulls. Only the deploy job moves it. */
export const LIVE_TAG = "live";

/** `ghcr.io/o/r:main` → `ghcr.io/o/r:live`. A colon only separates a
 *  tag after the last `/`, so a registry port survives. */
export function withLiveTag(ref: string): string {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return `${colon > slash ? ref.slice(0, colon) : ref}:${LIVE_TAG}`;
}

/** Re-point image references at `:live` — for a project whose workflow
 *  promotes `:live`, which is then the only tag its apps may pull. */
export function liveImageRefs<T extends Record<string, string | undefined>>(refs: T): T {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(refs)) out[k] = v === undefined ? v : withLiveTag(v);
  return out as T;
}

/** Coolify's manual GitHub webhook endpoint, relative to the base URL. */
export const COOLIFY_MANUAL_WEBHOOK_PATH = "/webhooks/source/github/events/manual";

/** Which half of a split deployment an app is; undefined for the one
 *  app of a single-app deployment. */
export type DeployRole = "client" | "server";

/** Everything CI needs to deploy one application. */
export interface DeployHook {
  uuid: string;
  role?: DeployRole;
  /** HMAC key — the only secret value in here. */
  secret: string;
  /** `owner/repo` exactly as the endpoint will match it against the
   *  app's `git_repository` (a `LIKE %…%` match). For a Docker Image app
   *  this is whatever placeholder Coolify stored, not the project repo. */
  repository: string;
  /** The app's `git_branch`: the payload's `ref` must name it. */
  branch: string;
}

/** The GitHub Actions secret names one app's hook is stored under.
 *  Single-app deployments use the unprefixed names. */
export function deployHookSecretNames(role?: DeployRole): {
  uuid: string;
  secret: string;
  repository: string;
  branch: string;
} {
  const p = role ? `COOLIFY_${role.toUpperCase()}_` : "COOLIFY_";
  return {
    uuid: `${p}RESOURCE_UUID`,
    secret: `${p}DEPLOY_SECRET`,
    repository: `${p}DEPLOY_REPOSITORY`,
    branch: `${p}DEPLOY_BRANCH`,
  };
}

/** Secrets that carried the provisioner token (or only work with it).
 *  A repo holding any of these is not isolated. */
export const PROVISIONER_DEPLOY_SECRET_NAMES = ["COOLIFY_API_TOKEN", "COOLIFY_TOKEN"] as const;

/** Secrets that only ever worked together with the provisioner token:
 *  `COOLIFY_WEBHOOK_URL` is `/api/v1/deploy?uuid=…`, which answers 401
 *  without a bearer token. Cleared together with the token. */
export const TOKEN_ONLY_DEPLOY_SECRET_NAMES = ["COOLIFY_WEBHOOK_URL"] as const;

/** The exact JSON body CI signs. A `push` for the app's branch, naming
 *  {@link DEPLOY_HOOK_WATCH_PATH} as modified so the app's watch paths
 *  match, and carrying the commit so Coolify's deployment list shows
 *  which build it was. */
export function renderDeployWebhookBody(input: {
  repository: string;
  branch: string;
  sha: string;
}): string {
  return JSON.stringify({
    ref: `refs/heads/${input.branch}`,
    after: input.sha,
    repository: { full_name: input.repository },
    commits: [{ id: input.sha, added: [], removed: [], modified: [DEPLOY_HOOK_WATCH_PATH] }],
  });
}

/** `X-Hub-Signature-256` value (without the `sha256=` prefix). */
export function signDeployWebhook(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Whether Coolify's answer to a signed webhook says THIS app's deploy
 *  was queued.
 *
 *  The endpoint answers 200 with one entry per application whose
 *  `git_repository` matched — including every OTHER app on the same
 *  repo, each marked "Invalid signature.". Only an entry for this uuid
 *  with status `success`, or a `skipped` entry (the same commit is
 *  already queued or running; only an app whose signature matched gets
 *  that far), counts. Anything else — "Deployments disabled.", a watch
 *  path mismatch, every entry invalid, or the plain-text "Nothing to
 *  do." — is a failure, and the detail says which.
 *
 *  The detail never names other applications: in a public repo it lands
 *  in a public log. */
export function deployWebhookQueued(
  responseText: string,
  uuid: string,
): { ok: boolean; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return { ok: false, detail: responseText.slice(0, 200).trim() || "(empty answer)" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, detail: JSON.stringify(parsed).slice(0, 200) };
  }
  const entries = parsed.filter(
    (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
  );
  if (entries.some((e) => e.application_uuid === uuid && e.status === "success")) {
    return { ok: true, detail: "deployment queued" };
  }
  if (entries.some((e) => e.status === "skipped")) {
    return { ok: true, detail: "this commit is already queued" };
  }
  const own = entries.filter((e) => e.message !== "Invalid signature.");
  if (own.length === 0) {
    return {
      ok: false,
      detail:
        entries.length === 0
          ? "no application matched the repository and branch"
          : "the signature matched no application — the deploy secret is stale or belongs to another application",
    };
  }
  return {
    ok: false,
    detail: own.map((e) => `${String(e.status)}: ${String(e.message)}`).join("; "),
  };
}

/** Keychain account holding one app's deploy-hook secret. */
export function deployHookKeychainKey(uuid: string): string {
  return SECRET_KEYS.coolifyDeployHook(uuid);
}

const randomSecret = (): string => randomBytes(32).toString("hex");

/** Where per-app deploy secrets live on the operator's machine. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const keychainStore: SecretStore = { get: getSecret, set: setSecret };

/** `owner/repo` from Coolify's `git_repository`, which is a URL for
 *  public-repo apps and a bare `owner/repo` for GitHub-App ones. The
 *  match is a substring match, so any exact `owner/repo` contained in the
 *  stored value works. */
export function hookRepositoryOf(gitRepository: string | undefined): string | undefined {
  if (!gitRepository) return undefined;
  const trimmed = gitRepository.trim().replace(/\.git$/, "");
  const bare = trimmed.match(/^([\w.-]+\/[\w.-]+)$/);
  if (bare) return bare[1];
  const ssh = trimmed.match(/^git@[^:]+:([\w.-]+\/[\w.-]+)$/);
  if (ssh) return ssh[1];
  const url = trimmed.match(/^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)(?:\/.*)?$/);
  if (url) return url[1];
  return undefined;
}

export interface EnsureDeployHookResult {
  hook: DeployHook;
  /** What changed on the app, for the caller's log line. Empty when the
   *  app was already configured. */
  changes: string[];
}

/**
 * Make one Coolify app deployable by a signed webhook, and return what
 * CI needs to sign it. Idempotent.
 *
 * The secret already in the keychain is reused when Coolify holds the
 * same value, so re-running sync does not invalidate the repo's copy.
 * A mismatch (the dashboard regenerated it, or the keychain was reset)
 * mints a new one: the keychain is the source of truth for what CI was
 * given, and a secret CI cannot match is useless.
 *
 * `rotate: true` always mints new values — the per-project revocation
 * path. The caller pushes the result to the repo afterwards.
 */
export async function ensureDeployHook(
  api: Pick<CoolifyApi, "getDeployHookState" | "updateDeployHook">,
  uuid: string,
  opts: {
    role?: DeployRole;
    rotate?: boolean;
    dryRun?: boolean;
    /** Where the per-app secret is kept. The keychain unless a test
     *  passes a map. */
    store?: SecretStore;
  } = {},
): Promise<EnsureDeployHookResult> {
  const store = opts.store ?? keychainStore;
  const state = await api.getDeployHookState(uuid);
  const repository = hookRepositoryOf(state.gitRepository);
  if (!repository) {
    throw new Error(
      `Coolify app ${uuid} has no git_repository hatchkit can read (${JSON.stringify(state.gitRepository ?? null)}); the signed webhook matches on it.`,
    );
  }
  const branch = state.gitBranch?.trim() || "main";
  const changes: string[] = [];

  const stored = await store.get(deployHookKeychainKey(uuid));
  let secret = stored ?? "";
  const inSync = stored !== null && stored !== "" && state.githubSecret === stored;
  const patch: Parameters<CoolifyApi["updateDeployHook"]>[1] = {};
  if (opts.rotate || !inSync) {
    secret = randomSecret();
    patch.webhookSecrets = {
      github: secret,
      gitlab: randomSecret(),
      bitbucket: randomSecret(),
      gitea: randomSecret(),
    };
    changes.push(opts.rotate ? "rotated deploy secret" : "set deploy secret");
  } else if (!state.otherSlotsLocked) {
    // The GitHub slot is fine but another provider's endpoint still
    // accepts an empty-key signature.
    patch.webhookSecrets = {
      gitlab: randomSecret(),
      bitbucket: randomSecret(),
      gitea: randomSecret(),
    };
    changes.push("locked the other webhook slots");
  }
  if (state.watchPaths?.trim() !== DEPLOY_HOOK_WATCH_PATH) {
    patch.watchPaths = DEPLOY_HOOK_WATCH_PATH;
    changes.push(`watch_paths=${DEPLOY_HOOK_WATCH_PATH}`);
  }
  // Not readable back on this API (the settings relation serialises as
  // null), so always asserted. Harmless when already true.
  patch.autoDeploy = true;

  if (!opts.dryRun) {
    // Keychain FIRST: a PATCH that lands with the new value while the
    // keychain write fails would leave nobody holding the secret.
    if (patch.webhookSecrets?.github) await store.set(deployHookKeychainKey(uuid), secret);
    await api.updateDeployHook(uuid, patch);
    if (patch.webhookSecrets?.github) {
      const after = await api.getDeployHookState(uuid);
      if (after.githubSecret !== secret) {
        throw new Error(`Coolify app ${uuid} did not keep the new deploy secret.`);
      }
    }
  }
  return { hook: { uuid, role: opts.role, secret, repository, branch }, changes };
}
