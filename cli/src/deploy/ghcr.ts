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
import type { CoolifyApi } from "../utils/coolify-api.js";
import { exec, execOk } from "../utils/exec.js";

export interface GhcrSetupOptions {
  /** Owner/repo slug, e.g. `trebeljahr/extinction-protocol`. */
  repoSlug: string;
  /** Maximum time to wait for the first Actions push to create the
   *  package in GHCR. Default 5 minutes — enough headroom for cold
   *  builds without keeping the user staring at a spinner forever. */
  waitTimeoutMs?: number;
  /** How often to recheck whether the package exists. Default 8s —
   *  matches GHCR's typical sync delay after a push. */
  pollIntervalMs?: number;
}

/** Outcome surface for adopt's caveats list. The caller logs success
 *  inline and only forwards `failed`/`skipped` to the run's caveat
 *  block — that way the user sees the recovery recipe right where
 *  they need it. */
export type GhcrSetupResult =
  | { kind: "public-set"; visibility: "public" }
  | { kind: "private-registered"; registryUuid: string }
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
  const { repoSlug, waitTimeoutMs = 5 * 60_000, pollIntervalMs = 8_000 } = options;
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
 * Path B — register a GHCR PAT with Coolify so it can pull a private
 * package. Reads the PAT (and its owner login) from `getGhcrConfig()`;
 * when missing, surfaces a caveat pointing at `hatchkit config add
 * ghcr` rather than prompting mid-adopt.
 *
 * Username vs repo owner: the registry login docker uses is the *PAT
 * owner's* GitHub username, not necessarily the repo owner. They line
 * up for personal repos but diverge for org-owned repos pulled with a
 * personal PAT. Callers pass the username explicitly.
 *
 * The Coolify private-registries endpoint is system-wide: once a creds
 * entry exists for `ghcr.io`, every app on every server in this Coolify
 * install pulls authenticated from there. So we only register once per
 * Coolify install (idempotent on hostname).
 */
export async function registerGhcrCredsWithCoolify(
  options: GhcrSetupOptions & {
    api: CoolifyApi;
    /** GHCR PAT (scope `read:packages`). Caller owns the keychain
     *  lookup so this module stays IO-free aside from `gh`. */
    pullToken: string | undefined;
    /** GitHub login the PAT belongs to. Sent as the registry username.
     *  When undefined we treat it as "creds incomplete" and surface
     *  the same `config add ghcr` caveat. */
    username: string | undefined;
  },
): Promise<GhcrSetupResult> {
  const { api, pullToken, username } = options;

  if (!pullToken || !username) {
    return {
      kind: "skipped",
      reason: "GHCR pull credentials are not configured.",
      recovery: [
        "Run: hatchkit config add ghcr",
        "  → paste a fine-grained PAT scoped `read:packages`.",
        "  → create one at https://github.com/settings/tokens?type=beta if needed.",
        "Then re-run: hatchkit adopt --resume",
      ],
    };
  }

  const spin = ora("Coolify: registering GHCR pull credentials").start();
  try {
    const existing = await api.findPrivateRegistry({ url: "ghcr.io" });
    if (existing) {
      spin.succeed(`Coolify: GHCR registry already configured (${existing.uuid})`);
      return { kind: "private-registered", registryUuid: existing.uuid };
    }
    const created = await api.addPrivateRegistry({
      name: "GHCR (hatchkit)",
      registryUrl: "ghcr.io",
      username,
      password: pullToken,
    });
    spin.succeed(`Coolify: GHCR registry created (${created.uuid})`);
    return { kind: "private-registered", registryUuid: created.uuid };
  } catch (err) {
    spin.fail("Coolify: couldn't register GHCR creds");
    return {
      kind: "failed",
      reason: (err as Error).message,
      recovery: [
        "Add the registry manually in Coolify:",
        `  Servers → <your server> → Private Registries → Add → ghcr.io / ${username} / <PAT>`,
        "Then click Deploy in the Coolify dashboard.",
      ],
    };
  }
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

/** Read the active gh token's scopes. Returns null if the lookup
 *  fails (e.g. user not logged in) — caller treats null as "unknown,
 *  proceed and let the API call fail clearly". */
async function ghTokenScopes(): Promise<string[] | null> {
  // `gh auth status -t` prints a token; `gh auth status` (no -t) prints
  // the scope list to stderr. Easier path: call `gh api -i /` and parse
  // the `X-Oauth-Scopes` response header.
  const r = await exec("gh", ["api", "-i", "/"], { silent: true });
  if (r.exitCode !== 0) return null;
  const m = r.stdout.match(/^X-Oauth-Scopes:\s*(.*)$/im);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
