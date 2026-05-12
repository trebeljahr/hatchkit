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
 * After `dotenvx rotate`, the .env.keys file's private-key line gets
 * APPENDED to (`old,new,newer…`). dotenvx itself can decrypt against
 * any comma-listed key, but every downstream consumer here forwards a
 * single value, so a piled-up list silently strands deploy targets on
 * a stale key. `rotate` therefore prunes .env.keys back to ONE entry
 * (the freshly-minted current key) and propagates that single key to
 * keychain + Coolify + GitHub Actions in the same transaction.
 *
 *   keys show <project>             Print DOTENV_PRIVATE_KEY_PRODUCTION
 *                                   from the keychain.
 *   keys set <project> [--key=…]    Upsert the key into the keychain.
 *                                   Source priority: --key flag, stdin,
 *                                   `./.env.keys` autoread.
 *   keys rotate <project>           Run `dotenvx rotate -f <prodEnv>`,
 *                                   prune .env.keys to the new key,
 *                                   update keychain, and (by default)
 *                                   push to Coolify + the detected GH
 *                                   repo. `--no-push` disables fan-out.
 *   keys push <project> [--target=] Mirror the keychain copy to one or
 *                                   both deploy targets (coolify/gh).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { PrivateKey } from "eciesjs";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";
import { repoSlugFromRemote } from "./gh-actions-secrets.js";

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

/** Hook signatures exposed for tests. Production code uses the
 *  defaults — internal underscore prefix marks them as not part of the
 *  user-facing CLI contract. */
export type RunDotenvxRotateFn = (params: {
  projectDir: string;
  envProductionPath: string;
}) => Promise<void>;
export type CoolifyPushFn = (projectName: string) => Promise<{ uuid: string }>;
export type GhPushFn = (projectName: string, repoSlug: string) => Promise<void>;
export type DetectRepoSlugFn = () => Promise<string | undefined>;

export interface RotateProjectKeyOptions {
  /** Project directory — defaults to cwd. dotenvx writes the new key
   *  next to `.env.production` (server, then client, then root —
   *  matches adopt's `dotenvxRootFor`). */
  projectDir?: string;
  /** Skip propagation to Coolify + GitHub Actions. Default is to push. */
  noPush?: boolean;
  /** Override the GH repo slug for the Actions secret push. When
   *  omitted, the slug is auto-detected from `git remote origin`. */
  ghRepo?: string;
  /** Print what would change, don't actually rotate. */
  dryRun?: boolean;
  /** Test hook: replace the `npx dotenvx rotate` subprocess. */
  _runDotenvxRotate?: RunDotenvxRotateFn;
  /** Test hook: replace the Coolify push call. */
  _coolifyPush?: CoolifyPushFn;
  /** Test hook: replace the GitHub Actions secret push call. */
  _ghPush?: GhPushFn;
  /** Test hook: replace the git-remote auto-detection. */
  _detectRepoSlug?: DetectRepoSlugFn;
}

export type SkipReason =
  | "no-coolify-config"
  | "coolify-app-not-found"
  | "no-git-remote"
  | "no-push-flag";

export interface RotateProjectKeyResult {
  envProductionPath: string;
  envKeysPath: string;
  rotated: boolean;
  /** Newly-minted public key (mirrors .env.production after rotate). */
  newPublicKey: string;
  /** Number of stale comma-list entries removed from .env.keys (0 on
   *  the happy single-key path). */
  prunedStaleKeys: number;
  set: SetProjectKeyResult;
  pushedCoolify?: { uuid: string };
  pushedGh?: { repo: string };
  skippedCoolify?: SkipReason;
  skippedGh?: SkipReason;
}

/** Rotate the dotenvx keypair end-to-end:
 *    1. `dotenvx rotate -f <env-production>` in the project.
 *    2. Verify the freshly-written private key derives the new public
 *       key embedded in .env.production — catches stale-file / wrong-
 *       cwd cases that previously produced a false "no .env.keys"
 *       error after a successful rotate.
 *    3. Prune .env.keys back to a SINGLE current key (dotenvx appends
 *       on each rotate; if we leave the comma-list alone, downstream
 *       consumers forwarding a single value end up on a stale entry).
 *    4. Mirror the new private key into the OS keychain.
 *    5. Push to Coolify + GitHub Actions by default. `--no-push`
 *       opts out; explicit `ghRepo` overrides remote auto-detect. */
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
      locateEnvKeysFile(projectDir) ?? join(dirname(envProductionPath), ".env.keys");
    return {
      envProductionPath,
      envKeysPath,
      rotated: false,
      newPublicKey: "",
      prunedStaleKeys: 0,
      set: {
        source: "env-keys",
        envKeysPath,
        account: SECRET_KEYS.dotenvxPrivateKey(projectName),
        changed: true,
        written: false,
      },
      skippedCoolify: opts.noPush ? "no-push-flag" : undefined,
      skippedGh: opts.noPush ? "no-push-flag" : undefined,
    };
  }

  await runDotenvxRotate(projectDir, envProductionPath, opts._runDotenvxRotate);

  // dotenvx writes .env.keys next to the env file it was given. Use
  // the env.production parent directly — `locateEnvKeysFile` re-scans
  // the canonical layout list, which can disagree with where dotenvx
  // actually wrote (e.g. a top-level `.env.production` while a
  // `packages/server` dir exists but holds no env files). That
  // disagreement was the root cause of the "no .env.keys produced"
  // false negative.
  const envKeysPath = join(dirname(envProductionPath), ".env.keys");
  if (!existsSync(envKeysPath)) {
    throw new Error(
      `dotenvx rotate completed but ${envKeysPath} was not written. The rotate subprocess may have failed silently — check the .env.production parent directory.`,
    );
  }

  const newPublicKey = readPublicKey(envProductionPath);
  if (!newPublicKey) {
    throw new Error(
      `${envProductionPath} has no DOTENV_PUBLIC_KEY_PRODUCTION line after rotate. The env file may be malformed.`,
    );
  }

  const entries = parseEnvKeysEntries(readFileSync(envKeysPath, "utf-8"));
  if (!entries || entries.length === 0) {
    throw new Error(
      `${envKeysPath} has no DOTENV_PRIVATE_KEY_PRODUCTION entry after rotate. The env.keys file may be malformed.`,
    );
  }

  // dotenvx appends new keys to the end of the comma list, so the
  // *last* entry is the one that pairs with the freshly-written
  // public key. Verify before we trust it.
  const current = entries[entries.length - 1];
  if (!keypairMatches(current, newPublicKey)) {
    // Fall back: maybe a different position matches (some dotenvx
    // versions or partial-failure states could reorder). Probe each.
    const match = entries.find((p) => keypairMatches(p, newPublicKey));
    if (!match) {
      throw new Error(
        `dotenvx rotate completed but no private key in ${envKeysPath} derives the new DOTENV_PUBLIC_KEY_PRODUCTION in ${envProductionPath}. Leaving keychain untouched.`,
      );
    }
    // Pin the matching entry as the kept key.
    entries.length = 0;
    entries.push(match);
  }

  // Bug 1 fix: prune to single-key form. Keeping a grace key is not
  // a hatchkit guarantee — the on-disk file format dotenvx itself
  // reads is still `KEY="..."`, just with one hex string now.
  const kept = entries[entries.length - 1];
  const pruneRes = pruneEnvKeysFile(envKeysPath, kept);

  // Bug 2 fix: keychain must reflect the new key. `setProjectKey`
  // reads .env.keys and writes whatever parsePrivateKeyValue returns
  // — after the prune above that's the single new key.
  const set = await setProjectKey(projectName, { projectDir });

  let pushedCoolify: { uuid: string } | undefined;
  let pushedGh: { repo: string } | undefined;
  let skippedCoolify: SkipReason | undefined;
  let skippedGh: SkipReason | undefined;

  if (opts.noPush) {
    skippedCoolify = "no-push-flag";
    skippedGh = "no-push-flag";
  } else {
    // Bug 3 fix: opportunistically propagate to every deploy target
    // that was previously configured. Skip silently when a target
    // wasn't set up — the default is "push everywhere I can find",
    // not "push to Coolify or error out".
    const coolifyPush = opts._coolifyPush ?? pushProjectKeyToCoolify;
    const coolify = await getCoolifyConfig();
    if (!coolify && !opts._coolifyPush) {
      skippedCoolify = "no-coolify-config";
    } else {
      try {
        pushedCoolify = await coolifyPush(projectName);
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) {
          skippedCoolify = "coolify-app-not-found";
        } else {
          throw err;
        }
      }
    }

    const ghPush = opts._ghPush ?? pushProjectKeyToGh;
    const detect = opts._detectRepoSlug ?? defaultDetectRepoSlug;
    const repo = opts.ghRepo ?? (await detect());
    if (!repo) {
      skippedGh = "no-git-remote";
    } else {
      await ghPush(projectName, repo);
      pushedGh = { repo };
    }
  }

  return {
    envProductionPath,
    envKeysPath,
    rotated: true,
    newPublicKey,
    prunedStaleKeys: pruneRes.pruned,
    set,
    pushedCoolify,
    pushedGh,
    skippedCoolify,
    skippedGh,
  };
}

/** Shell out to `npx --yes @dotenvx/dotenvx rotate -f <relProd>`. The
 *  dotenvx JS API doesn't expose a rotate helper, and we don't want
 *  to import the package's internal `Rotate` class. Overridable for
 *  tests (we can't bring up a working `npx` in the sandbox). */
async function runDotenvxRotate(
  projectDir: string,
  envProductionPath: string,
  override?: RunDotenvxRotateFn,
): Promise<void> {
  if (override) {
    await override({ projectDir, envProductionPath });
    return;
  }
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

async function defaultDetectRepoSlug(): Promise<string | undefined> {
  const res = await exec("git", ["remote", "get-url", "origin"], { silent: true });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
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

export interface MirrorEnvKeysResult {
  /** True iff this call wrote a new value into the keychain. */
  mirrored: boolean;
  /** Why we didn't mirror, when `mirrored` is false. */
  reason?: "already-set" | "no-env-keys" | "invalid-key";
  /** `.env.keys` we read from, when one was found. */
  envKeysPath?: string;
  /** Keychain account name (always populated). */
  account: string;
}

/** Idempotently copy `DOTENV_PRIVATE_KEY_PRODUCTION` from the project's
 *  on-disk `.env.keys` into the OS keychain — but only when the
 *  keychain currently has no entry for this project.
 *
 *  Used by `runProvision`: a provisioner that encrypts values into
 *  `.env.production` (e.g. Plausible on a client-only project) mints
 *  the keypair on disk as a side effect, but never touches the
 *  keychain. Without this mirror, the subsequent `pushProjectKeyToGh`
 *  / Coolify env push fails with "No dotenvx key in keychain" even
 *  though the key sits in `.env.keys`.
 *
 *  Refuses to overwrite an existing keychain entry — the keychain copy
 *  is canonical (see file header) and may be deliberately ahead of a
 *  stale disk file after `dotenvx rotate`. `hatchkit keys set` is the
 *  explicit path for that case. */
export async function mirrorEnvKeysIfAbsent(
  projectName: string,
  projectDir: string,
): Promise<MirrorEnvKeysResult> {
  const account = SECRET_KEYS.dotenvxPrivateKey(projectName);
  const existing = await getSecret(account);
  if (existing) {
    return { mirrored: false, reason: "already-set", account };
  }
  const envKeysPath = locateEnvKeysFile(projectDir);
  if (!envKeysPath) {
    return { mirrored: false, reason: "no-env-keys", account };
  }
  const value = parsePrivateKeyValue(readFileSync(envKeysPath, "utf-8"));
  if (!value || !isPlausiblePrivateKey(value)) {
    return { mirrored: false, reason: "invalid-key", envKeysPath, account };
  }
  await setSecret(account, value);
  return { mirrored: true, envKeysPath, account };
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

/** Pull the CURRENT private key out of a `DOTENV_PRIVATE_KEY_PRODUCTION="…"`
 *  line. Returns undefined when the line is absent.
 *
 *  dotenvx writes the latest-rotated key at the END of any comma list
 *  (see `lib/services/rotate.js` → `append()`). Older versions of
 *  hatchkit captured the whole list and forwarded it verbatim to the
 *  keychain + deploy targets; downstream consumers that split-on-comma
 *  and took the first entry then ended up on a stale key. After the
 *  Bug 1 fix `rotate` prunes .env.keys back to one entry, but this
 *  function still tolerates a comma list — it returns just the last
 *  entry so any stale on-disk state from an older rotate self-heals
 *  the next time someone calls `keys set`. */
export function parsePrivateKeyValue(content: string): string | undefined {
  const entries = parseEnvKeysEntries(content);
  return entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
}

/** Parse the comma-separated entries of the DOTENV_PRIVATE_KEY_PRODUCTION
 *  line. Returns undefined when the line is missing entirely, an
 *  empty array when the value is empty. */
export function parseEnvKeysEntries(content: string): string[] | undefined {
  const m = content.match(
    /^\s*(?:export\s+)?DOTENV_PRIVATE_KEY_PRODUCTION\s*=\s*["']?([^"'\n]*)["']?\s*$/m,
  );
  if (!m) return undefined;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read DOTENV_PUBLIC_KEY_PRODUCTION from a .env.production file. */
export function readPublicKey(envProductionPath: string): string | undefined {
  if (!existsSync(envProductionPath)) return undefined;
  const content = readFileSync(envProductionPath, "utf-8");
  const m = content.match(
    /^\s*(?:export\s+)?DOTENV_PUBLIC_KEY_PRODUCTION\s*=\s*["']?([0-9a-fA-F]+)["']?\s*$/m,
  );
  return m ? m[1] : undefined;
}

/** Derive the compressed-hex secp256k1 public key for a dotenvx
 *  private-key hex string. Matches the format dotenvx itself writes
 *  to `DOTENV_PUBLIC_KEY_PRODUCTION` (see eciesjs `PublicKey.toHex()`,
 *  default `compressed = true`). */
export function derivePublicKey(privateHex: string): string {
  const sk = new PrivateKey(Buffer.from(privateHex, "hex"));
  return sk.publicKey.toHex();
}

/** True when `privateHex` derives the supplied public key. Case-insensitive
 *  hex comparison. */
export function keypairMatches(privateHex: string, publicHex: string): boolean {
  try {
    return derivePublicKey(privateHex).toLowerCase() === publicHex.toLowerCase();
  } catch {
    return false;
  }
}

/** Rewrite `.env.keys` so the DOTENV_PRIVATE_KEY_PRODUCTION line holds
 *  a single hex value. Returns the count of stale entries dropped (0
 *  if the line already had exactly one key). */
export function pruneEnvKeysFile(
  envKeysPath: string,
  keepValue: string,
): { kept: string; pruned: number } {
  const content = readFileSync(envKeysPath, "utf-8");
  const entries = parseEnvKeysEntries(content) ?? [];
  const pruned = Math.max(0, entries.length - 1);
  if (entries.length <= 1 && entries[0] === keepValue) {
    return { kept: keepValue, pruned: 0 };
  }
  const rewritten = content.replace(
    /^(\s*)((?:export\s+)?)DOTENV_PRIVATE_KEY_PRODUCTION\s*=\s*["']?[^"'\n]*["']?\s*$/m,
    `$1$2DOTENV_PRIVATE_KEY_PRODUCTION="${keepValue}"`,
  );
  writeFileSync(envKeysPath, rewritten);
  return { kept: keepValue, pruned };
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
