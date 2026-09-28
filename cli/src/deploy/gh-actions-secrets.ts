/*
 * GitHub Actions secrets helpers shared by `hatchkit adopt`,
 * `hatchkit create` and `hatchkit sync`.
 *
 * Those flows scaffold a GitHub Actions workflow that builds the
 * Docker image, pushes to GHCR, and triggers Coolify to redeploy.
 * Setting the workflow's secrets must happen BEFORE the first git
 * push, otherwise the workflow's first run hits the "secret not
 * set — skipping deploy trigger" branch and silently no-ops.
 *
 * Which uuid secrets get pushed depends on the project's topology, and
 * the two sets are MUTUALLY EXCLUSIVE:
 *
 *   single-origin — ONE Coolify app runs the whole compose:
 *     COOLIFY_BASE_URL + COOLIFY_API_TOKEN + COOLIFY_RESOURCE_UUID +
 *     COOLIFY_WEBHOOK_URL (legacy fallback path).
 *
 *   split — TWO Coolify apps, `<name>-client` on the bare domain and
 *   `<name>-server` on api.<domain>:
 *     COOLIFY_BASE_URL + COOLIFY_API_TOKEN +
 *     COOLIFY_CLIENT_RESOURCE_UUID + COOLIFY_SERVER_RESOURCE_UUID.
 *
 * ---------------------------------------------------------------------
 * Why the paired names are back, and why they are spelled this way
 * ---------------------------------------------------------------------
 *
 * The paired names were once pushed, then removed on the grounds that
 * they "never matched a real project layout in production". That
 * conclusion was wrong: a split project's CI has two apps to redeploy
 * and one uuid can only ever trigger one of them. Deploying them
 * separately is the whole point of the split — the server holds the
 * WebSocket connections, so a client-only change must not restart it
 * and drop every connected device's socket.
 *
 * The spelling is `COOLIFY_<ROLE>_RESOURCE_UUID` (role in the middle),
 * because that is what real checked-in workflows read. A brief
 * intermediate revision pushed `COOLIFY_RESOURCE_UUID_<ROLE>` (role at
 * the end) and renamed the starter workflow to match. That inverted the
 * bug: the observation was that hatchkit never SET the names workflows
 * were reading, and the fix for that is to set them, not to rename the
 * workflows. Any repo synced during that window has the role-suffixed
 * names, so they are cleared as stale below.
 *
 * ---------------------------------------------------------------------
 * Why split does NOT also set COOLIFY_RESOURCE_UUID
 * ---------------------------------------------------------------------
 *
 * Setting it "additively for back-compat" looks free and is not. The
 * generated deploy job guards each step on its own secret, so a split
 * project with COOLIFY_RESOURCE_UUID (pointing at the bare-domain app,
 * i.e. the client) AND COOLIFY_CLIENT_RESOURCE_UUID fires two
 * concurrent `force=true` deploys of that same client app on every
 * push — a self-race, every time.
 *
 * So split pushes only the paired names and CLEARS a stale
 * COOLIFY_RESOURCE_UUID. The cost is that a split repo whose workflow
 * only knows COOLIFY_RESOURCE_UUID now deploys nothing rather than
 * silently deploying half of itself. That is the honest failure, and
 * `hatchkit doctor` reports it rather than papering over it.
 *
 * Idempotent (`gh secret set` upserts, and the stale-secret cleanup
 * treats "not found" as success).
 */

import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { exec } from "../utils/exec.js";

/** A Coolify application the workflow should redeploy on push. */
export interface CoolifyDeployApp {
  /** Coolify application uuid. */
  uuid: string;
  /** Which half of a `split` deployment this app is. Undefined for a
   *  `single-origin` project, which has exactly one app and therefore
   *  exactly one deploy trigger. */
  role?: "client" | "server";
}

export interface CoolifyDeploySecretsInput {
  /** Working directory that has `.git` + `gh` access. */
  projectDir: string;
  /** GitHub `<owner>/<repo>` slug. */
  repoSlug: string;
  /** One or more apps to wire deploy hooks for. Pass a single
   *  unlabelled entry for a `single-origin` project; pass two entries
   *  carrying `role` for a `split` one. The first entry is always the
   *  app that owns the bare domain. */
  apps: CoolifyDeployApp[];
}

export interface CoolifyDeploySecretsResult {
  ok: boolean;
  /** Names of the secrets that were upserted. Used by the caller for
   *  the success log line. */
  pushed: string[];
  /** Names of stale secrets removed because they belong to the topology
   *  this project is NOT in (or to the superseded role-suffixed
   *  spelling). Empty when there was nothing to clean up. */
  removed: string[];
}

/** Secret name carrying a split half's application uuid. */
export function resourceUuidSecretName(role: "client" | "server"): string {
  return `COOLIFY_${role.toUpperCase()}_RESOURCE_UUID`;
}

/** Canonical paired names — set under `split`, cleared under
 *  `single-origin`. */
const PAIRED_UUID_SECRETS = [resourceUuidSecretName("client"), resourceUuidSecretName("server")];

/** Names from the superseded role-suffixed spelling. Never set any
 *  more; always cleared, so a repo synced during that window converges
 *  instead of carrying both spellings forever. */
const LEGACY_ROLE_SUFFIXED_SECRETS = [
  "COOLIFY_RESOURCE_UUID_CLIENT",
  "COOLIFY_RESOURCE_UUID_SERVER",
  "COOLIFY_WEBHOOK_URL_CLIENT",
  "COOLIFY_WEBHOOK_URL_SERVER",
];

/** Which secrets a project's topology calls for, and which stale ones
 *  should be cleared. Pure — no network, no config lookup — so the
 *  single-vs-split decision is unit-testable without a `gh` binary or a
 *  Coolify install. {@link setCoolifyDeploySecrets} is the I/O wrapper
 *  around it. */
export function computeCoolifyDeploySecrets(input: {
  apps: CoolifyDeployApp[];
  coolifyUrl: string;
  coolifyToken: string;
}): { secrets: Record<string, string>; staleToRemove: string[] } {
  // The API-style triple lets the workflow call Coolify directly with a
  // per-resource uuid + bearer token.
  const baseUrl = input.coolifyUrl.replace(/\/$/, "");
  const secrets: Record<string, string> = {
    COOLIFY_BASE_URL: baseUrl,
    COOLIFY_API_TOKEN: input.coolifyToken,
    // Alias kept for adopt's simpler `deploy.yml` template.
    COOLIFY_TOKEN: input.coolifyToken,
  };

  // A split project contributes one paired secret per half. An app with
  // no role is single-origin. Sorted so the emitted secret order (and
  // therefore the log line) is stable regardless of the order Coolify
  // happened to list the applications in.
  const roled = input.apps
    .filter((a): a is CoolifyDeployApp & { role: "client" | "server" } => a.role !== undefined)
    .sort((a, b) => a.role.localeCompare(b.role));
  for (const app of roled) {
    secrets[resourceUuidSecretName(app.role)] = app.uuid;
  }

  if (roled.length > 0) {
    // Split. No COOLIFY_RESOURCE_UUID / COOLIFY_WEBHOOK_URL — see the
    // module header: keeping them would double-deploy the client on
    // every push.
    return {
      secrets,
      staleToRemove: [
        "COOLIFY_RESOURCE_UUID",
        "COOLIFY_WEBHOOK_URL",
        ...LEGACY_ROLE_SUFFIXED_SECRETS,
      ],
    };
  }

  // Single-origin. One uuid, plus the webhook as the fallback path for
  // workflows predating the bearer-token step.
  const primary = input.apps[0];
  secrets.COOLIFY_WEBHOOK_URL = `${baseUrl}/api/v1/deploy?uuid=${primary.uuid}`;
  secrets.COOLIFY_RESOURCE_UUID = primary.uuid;
  // Clear paired secrets left behind by a split that was reverted.
  // Otherwise they keep firing deploys against apps that no longer
  // exist.
  return {
    secrets,
    staleToRemove: [...PAIRED_UUID_SECRETS, ...LEGACY_ROLE_SUFFIXED_SECRETS],
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
    computeCoolifyDeploySecrets({ apps, coolifyUrl: "https://x", coolifyToken: "x" }).secrets,
  );
}

/** Push the secrets that the scaffolded GH Actions workflows need
 *  to talk to Coolify. Best-effort — failures don't roll anything
 *  back; the caller gets a copy-pasteable manual recipe instead. */
export async function setCoolifyDeploySecrets(
  input: CoolifyDeploySecretsInput,
): Promise<CoolifyDeploySecretsResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    console.log(chalk.dim("  · Coolify not configured — skipping Actions secret push."));
    return { ok: false, pushed: [], removed: [] };
  }
  if (input.apps.length === 0) {
    console.log(chalk.dim("  · No Coolify apps to wire deploy hooks for — skipping."));
    return { ok: false, pushed: [], removed: [] };
  }

  const { secrets, staleToRemove } = computeCoolifyDeploySecrets({
    apps: input.apps,
    coolifyUrl: cfg.url,
    coolifyToken: cfg.token,
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
    // Print names only. The values include COOLIFY_API_TOKEN, and a
    // failed push is not a reason to spill it into the terminal (and
    // from there into scrollback, screen shares and pasted bug
    // reports).
    console.log(
      chalk.dim(
        `  Set them manually — \`gh secret set <NAME> --repo ${input.repoSlug}\` reads the value from stdin:\n` +
          names.map((n) => `    ${n}`).join("\n"),
      ),
    );
    return { ok: false, pushed: [], removed: [] };
  }

  // Clear secrets belonging to the other topology. Best-effort: a token
  // without the scope to delete secrets still got the push it came for,
  // so a failure here degrades to a note rather than failing the call.
  const removed: string[] = [];
  for (const name of staleToRemove) {
    try {
      if ((await ghSecretDelete(input.repoSlug, name)) === "done") removed.push(name);
    } catch (err) {
      console.log(chalk.dim(`  · Couldn't remove stale ${name}: ${(err as Error).message}`));
    }
  }

  spinner.succeed(
    `GitHub: Actions secrets set (${names.join(", ")})` +
      (removed.length ? ` — removed stale ${removed.join(", ")}` : ""),
  );
  return { ok: true, pushed: names, removed };
}

export interface CloudflareDeploySecretsInput {
  /** Working directory that has `.git` + `gh` access. */
  projectDir: string;
  /** GitHub `<owner>/<repo>` slug. */
  repoSlug: string;
}

export interface CloudflareDeploySecretsResult {
  ok: boolean;
  pushed: string[];
}

/** The two repo-level secrets `cloudflare/wrangler-action@v4` reads. */
export const CLOUDFLARE_SECRET_NAMES = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

/** Push the secrets the scaffolded Cloudflare deploy workflow needs.
 *
 *  Repo-level, not org-level, on purpose: a personal GitHub account has
 *  no org to hang shared secrets off, so every repo gets its own copy.
 *  That is also why the token is stored under its own keychain entry —
 *  it is the one Cloudflare credential that leaves the machine, so it
 *  has to be revocable on its own.
 *
 *  Nothing here prints a token value. `gh secret set --body` passes it
 *  as an argv element, so it never reaches stdout, and the manual
 *  fallback recipe prints the *command shape* with a placeholder rather
 *  than the secret. Best-effort: a failure leaves the repo without
 *  secrets and hands the user the recipe, it doesn't roll anything back.
 */
export async function setCloudflareDeploySecrets(
  input: CloudflareDeploySecretsInput,
): Promise<CloudflareDeploySecretsResult> {
  const { getCloudflareWorkersConfig } = await import("../config.js");
  const cfg = await getCloudflareWorkersConfig();
  if (!cfg?.apiToken) {
    console.log(
      chalk.dim(
        "  · Cloudflare Workers not configured — skipping Actions secret push.\n" +
          "    Run `hatchkit config add cloudflare-workers`, then `hatchkit cloudflare`.",
      ),
    );
    return { ok: false, pushed: [] };
  }

  const secrets: Record<string, string> = {
    CLOUDFLARE_API_TOKEN: cfg.apiToken,
    CLOUDFLARE_ACCOUNT_ID: cfg.accountId,
  };
  const names = Object.keys(secrets);

  const spinner = ora(
    `GitHub: setting ${names.length} Actions secrets on ${input.repoSlug}`,
  ).start();
  try {
    for (const [name, value] of Object.entries(secrets)) {
      await ghSecretSet(input.projectDir, input.repoSlug, name, value);
    }
    spinner.succeed(`GitHub: Actions secrets set (${names.join(", ")})`);
    return { ok: true, pushed: names };
  } catch (err) {
    spinner.fail(`GitHub: setting secrets failed — ${(err as Error).message}`);
    // Deliberately a placeholder, not the value. Everything else in
    // this file prints real values because they're service URLs and
    // uuids; an API token is not something to leave in scrollback.
    console.log(
      chalk.dim(
        "  Set them manually with (both read the value from stdin, so neither\n" +
          "  lands in your shell history or the process list):\n" +
          `    gh secret set CLOUDFLARE_API_TOKEN --repo ${input.repoSlug}\n` +
          `    gh secret set CLOUDFLARE_ACCOUNT_ID --repo ${input.repoSlug}   # ${cfg.accountId}`,
      ),
    );
    return { ok: false, pushed: [] };
  }
}

/** Upsert one repo-level Actions secret.
 *
 *  The value goes in on STDIN, not `--body`. Argv is world-readable on
 *  both Linux and macOS (`ps aux`, /proc/<pid>/cmdline), and one of the
 *  values here is COOLIFY_API_TOKEN — a token with full control of the
 *  user's Coolify install. `gh secret set` reads the value from stdin
 *  when `--body` is absent, which keeps it out of the process list.
 *
 *  `silent` so a non-zero exit doesn't let exec() echo a stderr line
 *  that may quote the value back; the throw below carries the message. */
async function ghSecretSet(cwd: string, repo: string, name: string, value: string): Promise<void> {
  const res = await exec("gh", ["secret", "set", name, "--repo", repo], {
    cwd,
    input: value,
    silent: true,
  });
  if (res.exitCode !== 0) {
    throw new Error(`gh secret set ${name} exited ${res.exitCode}: ${res.stderr.trim()}`);
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
  if (/not found|could not find/i.test(msg)) return "not-found";
  throw new Error(`gh secret delete ${name} exited ${res.exitCode}: ${res.stderr.trim()}`);
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
