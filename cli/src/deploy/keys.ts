/*
 * `hatchkit keys` subcommands — manage the per-project dotenvx private
 * key stored in the OS keychain. The same key lives in three places:
 *
 *   · OS keychain   (canonical — read by `hatchkit keys show <p>`)
 *   · `.env.keys`   (on disk in the project, gitignored — read by
 *                    `dotenvx run` for local prod-like execution)
 *   · Deploy target (Coolify env var or GH Actions secret —
 *                    DOTENV_PRIVATE_KEY_PRODUCTION at runtime)
 *
 * After `dotenvx rotate`, only `.env.keys` updates. The keychain copy
 * and the deploy target keep the OLD key. `keys set` and `keys rotate`
 * fix that asymmetry.
 *
 *   keys show <project>             Print DOTENV_PRIVATE_KEY_PRODUCTION
 *                                   from the keychain.
 *   keys set <project> [--key=…]    Upsert the key into the keychain.
 *                                   Source priority: --key flag, stdin,
 *                                   `./.env.keys` autoread.
 *   keys rotate <project>           Run `dotenvx rotate -f <prodEnv>`
 *                                   in the project, then `keys set`,
 *                                   then optionally fan out.
 *   keys push <project> [--target=] Mirror the keychain copy to one or
 *                                   both deploy targets (coolify/gh).
 *
 * The fan-out flags (--push-coolify, --push-gh, --target) are uniform
 * across the subcommands so muscle memory transfers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

export type KeysTarget = "coolify" | "gh" | "both";

/** Print the private key for a project to stdout. `--json` emits a
 *  structured `{ project, key, found }` object so agents can parse
 *  without scraping. */
export async function showProjectKey(
  projectName: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const key = await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName));
  if (!key) {
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          project: projectName,
          found: false,
          error:
            "No dotenvx key in keychain. Project may have been scaffolded before dotenvx integration, or `config reset` cleared the keychain.",
        })}\n`,
      );
      process.exit(1);
    }
    console.error(
      chalk.red(`  No dotenvx key found for project "${projectName}" in the keychain.`),
    );
    console.error(
      chalk.dim(
        "  This usually means the project was scaffolded before dotenvx integration, or `config reset` cleared the keychain.",
      ),
    );
    process.exit(1);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ project: projectName, found: true, key })}\n`);
    return;
  }
  // Print plainly so it's easy to pipe into pbcopy etc. No chalk
  // around the value — chalk adds ANSI codes that corrupt the key
  // when redirected.
  process.stdout.write(`${key}\n`);
}

export interface SetProjectKeyOptions {
  /** Direct key value (highest priority — supplied via `--key=…`). */
  key?: string;
  /** Read from stdin when --key is absent and stdin is piped (not a TTY). */
  fromStdin?: boolean;
  /** Project root to look in for `.env.keys`. Defaults to cwd. */
  projectDir?: string;
  /** Don't write to the keychain; just report what would happen. */
  dryRun?: boolean;
}

export interface SetProjectKeyResult {
  source: "flag" | "stdin" | "env-keys";
  /** Where the env-keys file was found, if that's the source. */
  envKeysPath?: string;
  /** Keychain account that was (or would have been) written. */
  account: string;
  /** True when the new value differs from what was already in the
   *  keychain. False when the key was already current. */
  changed: boolean;
  /** True when an actual write happened (false in dry-run). */
  written: boolean;
}

/** Upsert the dotenvx private key into the OS keychain. Idempotent —
 *  noop when the keychain already holds the same value, but always
 *  reports the resolved source so callers can log meaningfully. */
export async function setProjectKey(
  projectName: string,
  opts: SetProjectKeyOptions = {},
): Promise<SetProjectKeyResult> {
  const account = SECRET_KEYS.dotenvxPrivateKey(projectName);
  const projectDir = opts.projectDir ?? process.cwd();

  let value: string | undefined;
  let source: SetProjectKeyResult["source"];
  let envKeysPath: string | undefined;

  if (opts.key !== undefined && opts.key !== "") {
    value = opts.key.trim();
    source = "flag";
  } else if (opts.fromStdin) {
    const raw = await readStdin();
    if (raw.trim() === "") {
      throw new Error(
        "Stdin was empty — pipe the private key, e.g. `cat key.txt | hatchkit keys set …`.",
      );
    }
    // Allow a `DOTENV_PRIVATE_KEY_PRODUCTION="abc…"` line on stdin too
    // — handy when the user just copies a chunk of `.env.keys`.
    value = parsePrivateKeyValue(raw) ?? raw.trim();
    source = "stdin";
  } else {
    envKeysPath = locateEnvKeysFile(projectDir);
    if (!envKeysPath) {
      throw new Error(
        `Couldn't find .env.keys under ${projectDir}. Pass --key=… or pipe the value on stdin.`,
      );
    }
    const parsed = parsePrivateKeyValue(readFileSync(envKeysPath, "utf-8"));
    if (!parsed) {
      throw new Error(`${envKeysPath} doesn't contain a DOTENV_PRIVATE_KEY_PRODUCTION line.`);
    }
    value = parsed;
    source = "env-keys";
  }

  if (!isPlausiblePrivateKey(value)) {
    throw new Error(
      "Resolved key doesn't look like a dotenvx private key (expected hex string ≥ 32 chars).",
    );
  }

  const existing = await getSecret(account);
  const changed = existing !== value;

  if (opts.dryRun) {
    return { source, envKeysPath, account, changed, written: false };
  }

  if (changed) {
    await setSecret(account, value);
  }
  return { source, envKeysPath, account, changed, written: changed };
}

export interface RotateProjectKeyOptions {
  /** Project directory — defaults to cwd. dotenvx writes the new key
   *  into `<projectDir>/<env>/.env.keys`, where <env> follows the same
   *  detection adopt uses (root → packages/server → apps/server). */
  projectDir?: string;
  /** Mirror the new key onto Coolify's app env. */
  pushCoolify?: boolean;
  /** Mirror the new key into the named GH repo's Actions secret. */
  pushGh?: string;
  /** Print what would change, don't actually rotate. */
  dryRun?: boolean;
}

export interface RotateProjectKeyResult {
  envProductionPath: string;
  envKeysPath: string;
  rotated: boolean;
  set: SetProjectKeyResult;
  pushedCoolify?: { uuid: string };
  pushedGh?: { repo: string };
}

/** Rotate the dotenvx keypair end-to-end:
 *    1. `dotenvx rotate -f <env-production>` in the project.
 *    2. Mirror the new private key into the OS keychain.
 *    3. Optionally push to Coolify and/or a GH Actions secret. */
export async function rotateProjectKey(
  projectName: string,
  opts: RotateProjectKeyOptions = {},
): Promise<RotateProjectKeyResult> {
  const projectDir = opts.projectDir ?? process.cwd();
  const envProductionPath = locateEnvProductionFile(projectDir);
  if (!envProductionPath) {
    throw new Error(
      `Couldn't find .env.production under ${projectDir}. Is this a hatchkit-managed project root?`,
    );
  }

  if (opts.dryRun) {
    const envKeysPath =
      locateEnvKeysFile(projectDir) ?? envProductionPath.replace(/production$/, "keys");
    return {
      envProductionPath,
      envKeysPath,
      rotated: false,
      set: {
        source: "env-keys",
        envKeysPath,
        account: SECRET_KEYS.dotenvxPrivateKey(projectName),
        changed: true,
        written: false,
      },
      pushedCoolify: opts.pushCoolify ? { uuid: "<would-resolve>" } : undefined,
      pushedGh: opts.pushGh ? { repo: opts.pushGh } : undefined,
    };
  }

  // Run dotenvx rotate inline. The `dotenvx` JS API doesn't expose a
  // rotate helper today; shell out to the CLI we already depend on.
  // We use `npx --yes @dotenvx/dotenvx rotate -f <path>` so the user's
  // PATH doesn't have to be set up — the package is already in the
  // monorepo's node_modules at dev time, and `npx --yes` covers the
  // installed-globally case too.
  const relProd = envProductionPath.startsWith(projectDir)
    ? envProductionPath.slice(projectDir.length + 1)
    : envProductionPath;
  const spinner = ora(`Rotating dotenvx keypair (${relProd})`).start();
  try {
    const res = await exec("npx", ["--yes", "@dotenvx/dotenvx", "rotate", "-f", relProd], {
      cwd: projectDir,
      silent: true,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `dotenvx rotate exited ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    spinner.succeed(`Rotated keypair for ${relProd}`);
  } catch (err) {
    if (spinner.isSpinning) spinner.fail();
    throw err;
  }

  const envKeysPath = locateEnvKeysFile(projectDir);
  if (!envKeysPath) {
    throw new Error(`dotenvx rotate completed but no .env.keys was produced under ${projectDir}.`);
  }

  const set = await setProjectKey(projectName, { projectDir });

  let pushedCoolify: { uuid: string } | undefined;
  if (opts.pushCoolify) {
    pushedCoolify = await pushProjectKeyToCoolify(projectName);
  }

  let pushedGh: { repo: string } | undefined;
  if (opts.pushGh) {
    await pushProjectKeyToGh(projectName, opts.pushGh);
    pushedGh = { repo: opts.pushGh };
  }

  return { envProductionPath, envKeysPath, rotated: true, set, pushedCoolify, pushedGh };
}

/** Push DOTENV_PRIVATE_KEY_PRODUCTION onto a Coolify application.
 *  Resolves the application by name. When `appName` is omitted, walks
 *  the same candidate list `findCoolifyAppsForProject` understands so
 *  the key push works across every layout hatchkit can produce —
 *  the bare project name `<project>` (current convention from both
 *  `create` and `adopt`), the legacy `<project>-web` suffix, and the
 *  `<project>-server`/`-client` shape from the (currently unused)
 *  starter-split layout. */
export async function pushProjectKeyToCoolify(
  projectName: string,
  options: { appName?: string } = {},
): Promise<{ uuid: string }> {
  const key = await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName));
  if (!key) {
    throw new Error(
      `No dotenvx key in keychain for project "${projectName}". Was it scaffolded with dotenvx integration?`,
    );
  }

  const coolify = await getCoolifyConfig();
  if (!coolify) {
    throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  }

  const api = new CoolifyApi({ url: coolify.url, token: coolify.token });
  // Candidates in priority order: caller-supplied appName wins; then
  // the bare project name (current `create`/`adopt` output); then the
  // legacy `-web` suffix; then the starter-split shape for projects
  // that landed in that layout. The dotenvx key only lives on the
  // server-side app, so `-server` outranks `-client`.
  const candidates = options.appName
    ? [options.appName]
    : [projectName, `${projectName}-web`, `${projectName}-server`, `${projectName}-client`];

  const spinner = ora(`Resolving Coolify app for "${projectName}"`).start();
  let appName: string;
  let uuid: string;
  try {
    const apps = await api.listApplications();
    const match = candidates
      .map((name) => {
        const app = apps.find((a) => a.name === name);
        return app ? { name, uuid: app.uuid } : undefined;
      })
      .find((m): m is { name: string; uuid: string } => m !== undefined);
    if (!match) {
      const tried = candidates.join(", ");
      spinner.fail(
        `No Coolify application found for project "${projectName}" (tried: ${tried}). Run \`hatchkit create\` with runDeployment first.`,
      );
      throw new Error(`Coolify app not found for project: ${projectName}`);
    }
    appName = match.name;
    uuid = match.uuid;
    spinner.succeed(`Found app ${appName} (${uuid})`);
  } catch (err) {
    if (spinner.isSpinning) spinner.fail();
    throw err;
  }

  const pushSpinner = ora("Upserting DOTENV_PRIVATE_KEY_PRODUCTION on Coolify").start();
  try {
    await api.setAppEnv(uuid, { DOTENV_PRIVATE_KEY_PRODUCTION: key });
    pushSpinner.succeed("Key pushed to Coolify");
  } catch (err) {
    pushSpinner.fail("Coolify env update failed");
    throw err;
  }
  return { uuid };
}

/** Push DOTENV_PRIVATE_KEY_PRODUCTION as a GitHub Actions secret on
 *  the named repo. Uses `gh secret set --body` (idempotent — gh upserts).
 *  Requires `gh` to be installed and authenticated for that repo. */
export async function pushProjectKeyToGh(projectName: string, repoSlug: string): Promise<void> {
  const key = await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName));
  if (!key) {
    throw new Error(
      `No dotenvx key in keychain for project "${projectName}". Was it scaffolded with dotenvx integration?`,
    );
  }
  const spinner = ora(`GitHub: setting DOTENV_PRIVATE_KEY_PRODUCTION on ${repoSlug}`).start();
  try {
    const res = await exec(
      "gh",
      ["secret", "set", "DOTENV_PRIVATE_KEY_PRODUCTION", "--repo", repoSlug, "--body", key],
      { silent: true },
    );
    if (res.exitCode !== 0) {
      throw new Error(`gh secret set exited ${res.exitCode}: ${res.stderr.trim()}`);
    }
    spinner.succeed(`GitHub secret set on ${repoSlug}`);
  } catch (err) {
    if (spinner.isSpinning) spinner.fail();
    throw err;
  }
}

/** Locate `.env.keys` for a hatchkit project. Mirrors the precedence
 *  adopt's `dotenvxRootFor` uses (server, then client, then root) so
 *  `keys set` / `keys rotate` see the same file the next deploy will. */
export function locateEnvKeysFile(projectDir: string): string | undefined {
  return locateDotenvxFile(projectDir, ".env.keys");
}

export function locateEnvProductionFile(projectDir: string): string | undefined {
  return locateDotenvxFile(projectDir, ".env.production");
}

function locateDotenvxFile(projectDir: string, name: string): string | undefined {
  const candidates = [
    join(projectDir, "packages/server", name),
    join(projectDir, "apps/server", name),
    join(projectDir, "packages/client", name),
    join(projectDir, "apps/client", name),
    join(projectDir, name),
  ];
  return candidates.find((p) => existsSync(p));
}

/** Pull the value out of a `DOTENV_PRIVATE_KEY_PRODUCTION="…"` line
 *  (or unquoted variant). Returns undefined if not present.
 *
 *  After `dotenvx rotate`, the value is a comma-joined list of hex
 *  keys (`old,new`) so the runtime can decrypt both pre- and
 *  post-rotation ciphertext during the cutover. The full list is
 *  what we want to mirror to the deploy target, so we capture all
 *  hex+comma characters until the closing quote / EOL. */
export function parsePrivateKeyValue(content: string): string | undefined {
  const m = content.match(/^DOTENV_PRIVATE_KEY_PRODUCTION\s*=\s*"?([0-9a-fA-F,]+)"?\s*$/m);
  return m ? m[1] : undefined;
}

/** Cheap sanity check — dotenvx ECIES private keys are 64-char hex
 *  (or a comma-joined list of them after `rotate`). Anything that
 *  isn't at least one ≥32-char hex run is almost certainly a mis-paste. */
function isPlausiblePrivateKey(v: string): boolean {
  return v.split(",").every((part) => /^[0-9a-fA-F]{32,}$/.test(part));
}

/** Read all of stdin as a UTF-8 string. */
async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");
  }
  return raw;
}
