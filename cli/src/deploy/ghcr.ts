/*
 * GHCR visibility + auth setup for hatchkit-deployed images.
 *
 * Why this exists: GHCR doesn't auto-inherit a repo's visibility. The
 * first `docker push` always creates a *private* package — even from a
 * public repo. Coolify's anonymous pull then fails with `unauthorized`,
 * leaving the user with a working build but a broken deploy.
 *
 * Two paths, keyed off the `isPrivate` flag adopt already collects:
 *
 *   · Path A — `isPrivate: false` (public-everything):
 *       1. Wait for the first GH Actions push to land in GHCR (poll
 *          the registry's auth endpoint, which 200s only after the
 *          package row exists).
 *       2. PATCH the package to `visibility=public` via `gh api`. From
 *          then on Coolify pulls anonymously — no creds anywhere.
 *
 *   · Path B — `isPrivate: true` (private-everything):
 *       1. Take a GHCR PAT from the keychain (or surface a clear caveat
 *          so the user can drop one in via `hatchkit config`).
 *       2. Register it with Coolify as a private-registry credential.
 *       3. The image stays private; Coolify pulls authenticated.
 *
 * Both paths fail soft — the worst case is a clear caveat with a
 * copy-pasteable manual recipe. We never throw out of adopt.
 *
 * Note on `gh` scopes: changing user-package visibility requires
 * `write:packages`. The default `gh auth login` scope set doesn't
 * include it, so we sniff the active token's scopes upfront and ask
 * the user to refresh if needed (cheaper than a 3-minute wait + a
 * 403 at the finish line).
 */

import ora from "ora";
import type { CoolifyApi, CoolifyServer } from "../utils/coolify-api.js";
import {
  type CoolifyServerSshTarget,
  dockerLoginAlreadyOk,
  dockerLoginViaSsh,
  resolveSshTarget,
  sshProbe,
} from "../utils/coolify-ssh.js";
import { exec, execOk } from "../utils/exec.js";
import { ghTokenScopes } from "../utils/gh-token.js";

export interface GhcrSetupOptions {
  /** Owner/repo slug, e.g. `acme/extinction-protocol`. */
  repoSlug: string;
  /** Maximum time to wait for the first Actions push to create the
   *  package in GHCR. Default 10 minutes — the starter's verify + e2e
   *  + build-server/client pipeline routinely takes 5–8 min on a cold
   *  GHA runner, so 5 was right at the boundary and timed out
   *  intermittently. */
  waitTimeoutMs?: number;
  /** How often to recheck whether the package exists. Default 8s —
   *  matches GHCR's typical sync delay after a push. */
  pollIntervalMs?: number;
}

/** Outcome surface for adopt's caveats list. The caller logs success
 *  inline and only forwards `failed`/`skipped` to the run's caveat
 *  block — that way the user sees the recovery recipe right where
 *  they need it.
 *
 *  The `private-registered` discriminator is retained from the pre-SSH
 *  era for caller compatibility, but its payload changed: instead of a
 *  Coolify-registry uuid (the broken `/api/v1/private-registries`
 *  surface), it now carries one entry per host where hatchkit ran
 *  `docker login`. Callers iterate `hosts[]` to record one ledger
 *  entry per host. */
export type GhcrSetupResult =
  | { kind: "public-set"; visibility: "public" }
  | {
      kind: "private-registered";
      hosts: Array<{
        serverUuid: string;
        host: string;
        user: string;
        port: number;
        /** True when THIS run wrote a new entry into the remote's
         *  `~/.docker/config.json`; false when the entry was already
         *  there (idempotent re-run). Drives the ledger record: only
         *  newly-written entries are recorded so destroy doesn't run
         *  `docker logout` on a credential the user added by hand. */
        newlyLoggedIn: boolean;
      }>;
    }
  | { kind: "skipped"; reason: string; recovery: string[] }
  | { kind: "failed"; reason: string; recovery: string[] };

/**
 * Path A — make the GHCR package public.
 *
 * Runs after `pushInitialBranch` so we know Actions has been triggered.
 * The poll loop waits for the registry to surface the package (anonymous
 * token endpoint returns 200 once the package row exists, regardless of
 * visibility), then PATCHes visibility. Bounded by `waitTimeoutMs` so
 * the user isn't stuck if Actions failed for an unrelated reason.
 */
export async function makeGhcrPackagePublic(options: GhcrSetupOptions): Promise<GhcrSetupResult> {
  const { repoSlug, waitTimeoutMs = 10 * 60_000, pollIntervalMs = 8_000 } = options;
  const [owner, name] = splitSlug(repoSlug);

  // Cheap upfront check — bail before the wait if `gh` can't possibly
  // succeed at the PATCH step. Saves 5 minutes of false hope.
  const scopes = await ghTokenScopes();
  if (scopes !== null && !scopes.includes("write:packages")) {
    return {
      kind: "skipped",
      reason: "gh token is missing the `write:packages` scope.",
      recovery: [
        "Refresh the scope: gh auth refresh -h github.com -s write:packages",
        `Then make the package public: gh api --method PATCH /user/packages/container/${name}/visibility -f visibility=public`,
        "Click Deploy in the Coolify dashboard once the package is public.",
      ],
    };
  }

  const wait = ora("GHCR: waiting for first Actions push to publish the package").start();
  const ownerType = await waitForGhcrPackage({
    owner,
    name,
    timeoutMs: waitTimeoutMs,
    pollIntervalMs,
  });
  if (ownerType === "timeout") {
    wait.fail("GHCR: package didn't appear in time");
    return {
      kind: "failed",
      reason: `Package ghcr.io/${repoSlug} never showed up — check the GitHub Actions run.`,
      recovery: [
        `Confirm the workflow ran: open https://github.com/${repoSlug}/actions`,
        `Once the image is published, set it public: gh api --method PATCH /user/packages/container/${name}/visibility -f visibility=public`,
        "Then click Deploy in the Coolify dashboard.",
      ],
    };
  }
  wait.succeed(
    `GHCR: package ghcr.io/${repoSlug} published${ownerType === "org" ? " (org-owned)" : ""}`,
  );

  const flip = ora("GHCR: setting package visibility to public").start();
  const apiPath =
    ownerType === "org"
      ? `/orgs/${owner}/packages/container/${name}/visibility`
      : `/user/packages/container/${name}/visibility`;
  const r = await exec("gh", ["api", "--method", "PATCH", apiPath, "-f", "visibility=public"], {
    silent: true,
  });
  if (r.exitCode === 0) {
    flip.succeed(`GHCR: ${repoSlug} → public`);
    return { kind: "public-set", visibility: "public" };
  }
  flip.fail("GHCR: visibility PATCH failed");
  return {
    kind: "failed",
    reason: r.stderr.trim() || `gh api PATCH ${apiPath} exited ${r.exitCode}`,
    recovery: [
      "Set the package public in the GitHub UI:",
      `  https://github.com/${ownerType === "org" ? "orgs/" : "users/"}${owner}/packages/container/${name}/settings`,
      "  → Danger Zone → Change visibility → Public.",
      "Then click Deploy in the Coolify dashboard.",
    ],
  };
}

/**
 * Path B — wire GHCR pull credentials on every Coolify-managed host
 * that pulls or builds images, by SSHing in and running `docker login`.
 *
 * Why SSH and not the Coolify API: Coolify v4 doesn't expose a
 * private-registries surface. `POST /api/v1/private-registries`
 * returns 404 on every live install; openapi.yaml v4.x has no
 * registry-management endpoints. The canonical workflow per the
 * Coolify "Custom Docker Registry" docs is to SSH into each host and
 * run `docker login`. Coolify's daemon reads `~/.docker/config.json`
 * on every subsequent pull.
 *
 * Target selection: every server returned by `listServers()` that is
 * reachable AND usable AND (is the Coolify host OR is a build server).
 *   · Coolify-host: pulls runtime images for deploys
 *   · build server: pushes built images (and may pull base images)
 *   · others: no need to log them in
 *
 * Idempotency: before running `docker login`, we grep
 * `~/.docker/config.json` for a matching registry entry. If present,
 * we treat that host as already configured and don't re-write
 * credentials (so a successful re-run is a no-op). The `newlyLoggedIn`
 * flag on each result entry tells the caller whether to record a
 * ledger entry — only newly-written logins are recorded so destroy
 * never `docker logout`s a credential the user installed by hand.
 *
 * Security: the token is piped via stdin into `docker login
 * --password-stdin`. It never appears in argv (visible via `ps`) or in
 * an environment variable (visible via `/proc/<pid>/environ`).
 *
 * Username vs repo owner: the registry login docker uses is the *PAT
 * owner's* GitHub username, not necessarily the repo owner. They line
 * up for personal repos but diverge for org-owned repos pulled with a
 * personal PAT. Callers pass the username explicitly.
 *
 * Opt-out (`manual: true`): emit a caveat with a copy-pasteable
 * `docker login` one-liner per target host and don't SSH. Power users
 * running a dedicated machine PAT separate from their personal gh
 * session opted into this via `hatchkit config add ghcr --manual`.
 */
export async function registerGhcrCredsWithCoolify(
  options: GhcrSetupOptions & {
    api: CoolifyApi;
    /** GHCR PAT (scope `read:packages`). Caller owns the keychain
     *  lookup so this module stays IO-free aside from `gh` and ssh. */
    pullToken: string | undefined;
    /** GitHub login the PAT belongs to. Used as the docker-login
     *  username. When undefined we treat it as "creds incomplete" and
     *  surface the same `config add ghcr` caveat. */
    username: string | undefined;
    /** Coolify panel URL — used to resolve the SSHable hostname for
     *  the box Coolify itself runs on (where `listServers` reports
     *  `ip: host.docker.internal`). */
    coolifyUrl: string;
    /** When true, skip the automatic SSH+login flow and emit a manual
     *  one-liner per target host. Mapped from `GhcrMeta.manual`. */
    manual?: boolean;
  },
): Promise<GhcrSetupResult> {
  const { api, pullToken, username, coolifyUrl, manual } = options;

  if (!pullToken || !username) {
    return {
      kind: "skipped",
      reason: "GHCR pull credentials are not configured.",
      recovery: [
        "Run: hatchkit config add ghcr",
        "  → paste a fine-grained PAT scoped `read:packages`,",
        "  → or let hatchkit derive one from your `gh auth` session.",
        "  → create one at https://github.com/settings/tokens?type=beta if needed.",
        "Then re-run: hatchkit adopt --resume",
      ],
    };
  }

  // Resolve target Coolify hosts.
  let servers: CoolifyServer[];
  try {
    servers = await api.listServers();
  } catch (err) {
    return {
      kind: "failed",
      reason: `Couldn't list Coolify servers: ${(err as Error).message}`,
      recovery: [
        "Verify Coolify is reachable + the API token is valid:",
        "  hatchkit doctor",
        "Then re-run: hatchkit adopt --resume",
      ],
    };
  }

  const targets = pickGhcrTargets(servers, coolifyUrl);
  if (targets.length === 0) {
    return {
      kind: "skipped",
      reason: "No reachable Coolify host/build server to install GHCR credentials on.",
      recovery: [
        "Check `hatchkit doctor` + the Servers page in the Coolify dashboard.",
        "Once at least one server is reachable + usable, re-run: hatchkit adopt --resume",
      ],
    };
  }

  // Manual opt-out: emit the recipe and stop. No SSH attempt.
  if (manual) {
    return {
      kind: "skipped",
      reason: "GHCR was configured with --manual; skipping automatic SSH + docker login.",
      recovery: [
        "Run this once on each Coolify host (token is piped over stdin — never paste it on the command line):",
        ...targets.map(
          (t) =>
            `  gh auth token | ssh -p ${t.port} ${t.user}@${t.host} 'docker login ghcr.io -u ${username} --password-stdin'`,
        ),
        "Then click Deploy in the Coolify dashboard.",
      ],
    };
  }

  const hosts: Array<{
    serverUuid: string;
    host: string;
    user: string;
    port: number;
    newlyLoggedIn: boolean;
  }> = [];
  const failures: Array<{ target: CoolifyServerSshTarget; reason: string }> = [];

  for (const target of targets) {
    const spin = ora(`Coolify ${target.host}: installing GHCR pull credentials via SSH`).start();

    // Probe reachability before sending the token over the wire.
    const probe = await sshProbe(target);
    if (!probe.ok) {
      const reason = probe.stderr.split("\n")[0] || "ssh probe failed";
      spin.fail(`Coolify ${target.host}: SSH unreachable (${reason})`);
      failures.push({ target, reason: `SSH unreachable: ${reason}` });
      continue;
    }

    // Idempotent skip when an entry for ghcr.io is already on disk.
    if (await dockerLoginAlreadyOk(target, "ghcr.io")) {
      spin.succeed(`Coolify ${target.host}: GHCR creds already present`);
      hosts.push({
        serverUuid: target.uuid,
        host: target.host,
        user: target.user,
        port: target.port,
        newlyLoggedIn: false,
      });
      continue;
    }

    const login = await dockerLoginViaSsh({
      target,
      registry: "ghcr.io",
      username,
      password: pullToken,
    });
    if (login.exitCode !== 0) {
      const detail = login.stderr || `docker login exited ${login.exitCode}`;
      spin.fail(`Coolify ${target.host}: docker login failed`);
      failures.push({ target, reason: detail });
      continue;
    }

    spin.succeed(`Coolify ${target.host}: GHCR creds installed via SSH`);
    hosts.push({
      serverUuid: target.uuid,
      host: target.host,
      user: target.user,
      port: target.port,
      newlyLoggedIn: true,
    });
  }

  if (hosts.length === 0) {
    return {
      kind: "failed",
      reason:
        failures.length === 1
          ? failures[0].reason
          : `Failed to install GHCR credentials on ${failures.length} host(s).`,
      recovery: buildManualRecipe(failures, username),
    };
  }

  if (failures.length > 0) {
    // Partial success — surface manual recipe for the failing hosts
    // but still record the ones that did succeed.
    return {
      kind: "failed",
      reason: `GHCR creds installed on ${hosts.length}/${
        hosts.length + failures.length
      } host(s); ${failures.length} failed.`,
      recovery: buildManualRecipe(failures, username),
    };
  }

  return { kind: "private-registered", hosts };
}

/** Filter `listServers()` output down to the boxes a GHCR pull
 *  credential needs to land on: the Coolify host (pulls runtime
 *  images) + every build server (pushes/pulls during build). Skip
 *  unreachable or non-usable servers — Coolify already knows they're
 *  not in service. Skip anything we can't resolve to an SSHable
 *  address (e.g. `host.docker.internal` with an unparseable panel
 *  URL). */
function pickGhcrTargets(servers: CoolifyServer[], coolifyUrl: string): CoolifyServerSshTarget[] {
  const targets: CoolifyServerSshTarget[] = [];
  const seen = new Set<string>();
  for (const s of servers) {
    if (s.isReachable === false) continue;
    if (s.isUsable === false) continue;
    const relevant = s.isCoolifyHost || s.isBuildServer;
    // Conservative default: when Coolify didn't tell us the role,
    // treat it as a runtime host (older builds don't populate the
    // role flags). Build-only servers in those setups still get
    // covered because they're tagged via description in practice.
    const fallback = s.isCoolifyHost === undefined && s.isBuildServer === undefined;
    if (!relevant && !fallback) continue;

    const target = resolveSshTarget(s, coolifyUrl);
    if (!target) continue;
    const key = `${target.user}@${target.host}:${target.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

/** Build the per-host manual recipe surfaced when SSH+login fails (or
 *  partially fails). Mirrors the acceptance criterion: every failed
 *  host gets an exact `gh auth token | ssh ... docker login` line. */
function buildManualRecipe(
  failures: Array<{ target: CoolifyServerSshTarget; reason: string }>,
  username: string,
): string[] {
  const lines: string[] = [];
  for (const { target, reason } of failures) {
    lines.push(
      `${target.host}: ${reason}`,
      `  gh auth token | ssh -p ${target.port} ${target.user}@${target.host} 'docker login ghcr.io -u ${username} --password-stdin'`,
    );
  }
  lines.push(
    "If the SSH probe failed, add your public key to the host's ~/.ssh/authorized_keys (e.g. via `ssh-copy-id`).",
    "If `docker login` failed with `denied: bad credentials`, refresh the scope:",
    "  gh auth refresh -s read:packages",
    "  hatchkit config add ghcr",
  );
  return lines;
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

/** Best-effort owner-vs-org sniff. Falls back to `user` when ambiguous —
 *  the PATCH endpoint family will 404 on the wrong type, surfaced as a
 *  clear caveat by the caller. */
async function detectOwnerType(owner: string): Promise<"user" | "org"> {
  // Cheap: GET /users/<owner> 200s for both users and orgs, but the
  // payload's `type` field is "User" or "Organization". gh handles auth
  // for us.
  const res = await exec("gh", ["api", `/users/${owner}`, "--jq", ".type"], { silent: true });
  if (res.exitCode === 0 && res.stdout.trim() === "Organization") return "org";
  return "user";
}

/** Poll GHCR until the package exists. Returns the resolved owner type
 *  so the caller can route the visibility PATCH to the right endpoint
 *  family without re-querying. The probe walks the user-then-org pair
 *  in parallel — first one to 200 wins.
 *
 *  Why this works: GitHub's `/<scope>/packages/container/<name>` API
 *  returns 200 the moment the package row is created (i.e. the first
 *  successful push), independent of visibility. Cheaper than poking the
 *  Docker registry's manifest endpoint and we already have the gh auth.
 */
async function waitForGhcrPackage(opts: {
  owner: string;
  name: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<"user" | "org" | "timeout"> {
  const { owner, name, timeoutMs, pollIntervalMs } = opts;
  const deadline = Date.now() + timeoutMs;
  const ownerType = await detectOwnerType(owner);
  const path =
    ownerType === "org"
      ? `/orgs/${owner}/packages/container/${name}`
      : `/user/packages/container/${name}`;
  while (Date.now() < deadline) {
    if (await execOk("gh", ["api", path, "--silent"], {})) return ownerType;
    await sleep(pollIntervalMs);
  }
  return "timeout";
}

function splitSlug(slug: string): [string, string] {
  const [owner, name, ...rest] = slug.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Expected owner/repo slug, got "${slug}".`);
  }
  return [owner, name];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
