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
 * The endpoint finds candidate apps by `git_repository` and `git_branch`
 * first. A Docker Image app has no git source, and Coolify stores the
 * placeholder {@link COOLIFY_PLACEHOLDER_REPOSITORY} there, which no
 * signed payload matches; hatchkit writes the signing repo's `owner/repo`
 * in its place, once the watch path is in place.
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
   *  this is the project repo, written there by {@link ensureDeployHook}
   *  in place of Coolify's placeholder. */
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
 *  with status `success` counts. A `skipped` entry does not prove this
 *  app queued a deployment: duplicate-queue replies may omit its uuid,
 *  and other skip reasons do not queue anything. Anything else —
 *  "Deployments disabled.", a watch
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

/** What Coolify stores in `git_repository` of an app made without a git
 *  source — every Docker Image app (`createDockerImageApplication` sends
 *  no git field). A payload naming it matches no deploy. */
export const COOLIFY_PLACEHOLDER_REPOSITORY = "coollabsio/coolify";

/**
 * The `owner/repo` an app's signed webhook matches on, and the value
 * hatchkit has to write into `git_repository` first, if any. Pure.
 *
 * Only a Docker Image app is written to: its `git_repository` is no
 * clone source, only the key the webhook matches on, so the repo whose
 * CI signs (`repoSlug`, from its `origin`) replaces Coolify's
 * placeholder. A real repository already there is kept — it was set on
 * purpose, and the payload can name it. A git-based app's
 * `git_repository` is what Coolify builds, and is never touched.
 */
export function planHookRepository(input: {
  uuid: string;
  gitRepository?: string;
  buildPack?: string;
  repoSlug?: string;
}): { repository: string; write?: string } {
  const stored = hookRepositoryOf(input.gitRepository);
  const placeholder = !stored || stored.toLowerCase() === COOLIFY_PLACEHOLDER_REPOSITORY;
  if (input.buildPack !== "dockerimage" || !placeholder) {
    if (stored) return { repository: stored };
    throw new Error(
      `Coolify app ${input.uuid} has no git_repository hatchkit can read (${JSON.stringify(input.gitRepository ?? null)}); the signed webhook matches on it.`,
    );
  }
  if (input.repoSlug) return { repository: input.repoSlug, write: input.repoSlug };
  throw new Error(
    `Coolify app ${input.uuid} is a Docker Image app whose git_repository is ${JSON.stringify(input.gitRepository ?? null)}, which no signed webhook matches. ` +
      `Run \`hatchkit secrets isolate <repo-dir> --app ${input.uuid}[:client|:server]\` from the repo whose CI deploys it (hatchkit writes that repo's origin there), ` +
      `or set it by hand: PATCH /api/v1/applications/${input.uuid} {"git_repository":"<owner>/<repo>"} after watch_paths is ${DEPLOY_HOOK_WATCH_PATH}.`,
  );
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
 *
 * A Docker Image app still holding Coolify's placeholder repository gets
 * `repository` (the signing repo's `owner/repo`) written into
 * `git_repository` — in a PATCH of its own, after the watch path is read
 * back, so no ordinary push of that repo can deploy it. Without
 * `repository` such an app is refused with the fix
 * ({@link planHookRepository}).
 */
export async function ensureDeployHook(
  api: Pick<CoolifyApi, "getDeployHookState" | "updateDeployHook">,
  uuid: string,
  opts: {
    role?: DeployRole;
    rotate?: boolean;
    dryRun?: boolean;
    /** `owner/repo` of the repo whose CI signs this app's webhook — its
     *  `origin`. */
    repository?: string;
    /** Where the per-app secret is kept. The keychain unless a test
     *  passes a map. */
    store?: SecretStore;
  } = {},
): Promise<EnsureDeployHookResult> {
  const store = opts.store ?? keychainStore;
  const state = await api.getDeployHookState(uuid);
  const { repository, write: writeRepository } = planHookRepository({
    uuid,
    gitRepository: state.gitRepository,
    buildPack: state.buildPack,
    repoSlug: opts.repository,
  });
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
  if (writeRepository) changes.push(`git_repository=${writeRepository}`);

  if (!opts.dryRun) {
    // Keychain FIRST: a PATCH that lands with the new value while the
    // keychain write fails would leave nobody holding the secret.
    if (patch.webhookSecrets?.github) await store.set(deployHookKeychainKey(uuid), secret);
    await api.updateDeployHook(uuid, patch);
    if (patch.webhookSecrets?.github || writeRepository) {
      const after = await api.getDeployHookState(uuid);
      if (patch.webhookSecrets?.github && after.githubSecret !== secret) {
        throw new Error(`Coolify app ${uuid} did not keep the new deploy secret.`);
      }
      if (writeRepository) {
        // Auto-deploy is on from here. A real repository with any other
        // watch path would let an ordinary push deploy before CI built.
        if (after.watchPaths?.trim() !== DEPLOY_HOOK_WATCH_PATH) {
          throw new Error(
            `Coolify app ${uuid} did not keep watch_paths=${DEPLOY_HOOK_WATCH_PATH}; git_repository was left alone.`,
          );
        }
        await api.updateDeployHook(uuid, { gitRepository: writeRepository });
        const written = await api.getDeployHookState(uuid);
        if (hookRepositoryOf(written.gitRepository) !== writeRepository) {
          throw new Error(`Coolify app ${uuid} did not keep git_repository=${writeRepository}.`);
        }
      }
    }
  }
  return { hook: { uuid, role: opts.role, secret, repository, branch }, changes };
}
