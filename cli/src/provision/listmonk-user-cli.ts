/*
 * `hatchkit listmonk user [<project>]` — give an existing project its own
 * Listmonk API user and rewrite its env files.
 *
 * Projects provisioned before per-project users hold hatchkit's own API
 * user and token in `.env.production` (and in Coolify, after a sync).
 * This command creates the project's user role, list role and API user
 * (`listmonk-project-user.ts`), writes LISTMONK_API_USER +
 * LISTMONK_API_TOKEN into the project's env files, and drops the
 * SES_SMTP_* lines nothing in the project reads. It is also the re-run
 * path: with the token in the keychain or the env, a second run changes
 * nothing.
 *
 * It never pushes to Coolify. `hatchkit sync` does that afterwards, and
 * sync only adds and updates variables — removed ones stay in Coolify
 * until deleted there by hand.
 *
 * The provision step (`hatchkit add <project> listmonk-ses`) shares the
 * token lookup and the regenerate decision below.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import chalk from "chalk";
import {
  assertNotReserved,
  inspectListmonkProjectUser,
  regenerateRefusal,
} from "./listmonk-project-user.js";
import type { ListmonkAuth } from "./listmonk.js";

/** The SES SMTP login hatchkit used to write into project env. */
export const SES_SMTP_KEYS = [
  "SES_SMTP_HOST",
  "SES_SMTP_PORT",
  "SES_SMTP_USERNAME",
  "SES_SMTP_PASSWORD",
] as const;

type Env = Record<string, string>;

function positiveInt(v: string | undefined): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The project's Listmonk list ids as its env names them. Production
 *  names the live list LISTMONK_LIVE_LIST_ID, or LISTMONK_LIST_ID in env
 *  files older hatchkit wrote; there the dev file's LISTMONK_LIST_ID
 *  was the test list. */
export function listmonkListIdsFromEnv(prod: Env, dev: Env): { live?: number; test?: number } {
  return {
    live: positiveInt(prod.LISTMONK_LIVE_LIST_ID) ?? positiveInt(prod.LISTMONK_LIST_ID),
    test:
      positiveInt(prod.LISTMONK_TEST_LIST_ID) ??
      positiveInt(dev.LISTMONK_TEST_LIST_ID) ??
      positiveInt(dev.LISTMONK_LIST_ID),
  };
}

/** A token the env already holds for `name`'s own user, if any. */
export function projectTokenFromEnv(name: string, ...envs: Env[]): string | undefined {
  for (const env of envs) {
    if (env.LISTMONK_API_USER === name && env.LISTMONK_API_TOKEN) return env.LISTMONK_API_TOKEN;
  }
  return undefined;
}

export interface ProjectEnvSnapshot {
  /** The `.env.production` sync pushes, or null when there is none. */
  prodPath: string | null;
  /** Decrypted production values. */
  prod: Env;
  /** Production names still holding ciphertext (no private key). */
  undecrypted: string[];
  /** Directory holding the dev files, next to `.env.production`. */
  devDir: string;
  /** `.env.development` with `.env.development.local` over it. */
  dev: Env;
}

/** Read a project's env the way sync and the running server see it. */
export async function readProjectEnvSnapshot(envRoot: string): Promise<ProjectEnvSnapshot> {
  const { parseDotenv, resolveProductionEnv } = await import("../deploy/env-resolve.js");
  const { resolveEnvTarget } = await import("./write-env.js");
  const resolved = await resolveProductionEnv(envRoot);
  const devDir = resolved ? dirname(resolved.path) : resolveEnvTarget(envRoot).baseDir;
  const dev: Env = {};
  for (const file of [".env.development", ".env.development.local"]) {
    const p = join(devDir, file);
    if (existsSync(p)) Object.assign(dev, parseDotenv(readFileSync(p, "utf-8")));
  }
  return {
    prodPath: resolved?.path ?? null,
    prod: resolved?.values ?? {},
    undecrypted: resolved?.undecrypted ?? [],
    devDir,
    dev,
  };
}

/** Tokens an earlier run left for `name`'s own user, best first: the
 *  project env (what is deployed), then the keychain. Unchecked. */
export async function cachedProjectListmonkTokens(
  name: string,
  envRoot: string | undefined,
  snapshot?: ProjectEnvSnapshot,
): Promise<string[]> {
  const out: string[] = [];
  if (envRoot || snapshot) {
    try {
      const snap = snapshot ?? (await readProjectEnvSnapshot(envRoot as string));
      const fromEnv = projectTokenFromEnv(name, snap.prod, snap.dev);
      if (fromEnv) out.push(fromEnv);
    } catch {
      // No readable env yet: a first provision.
    }
  }
  const { SECRET_KEYS, getSecret } = await import("../utils/secrets.js");
  const stored = (await getSecret(SECRET_KEYS.listmonkProjectApiToken(name)))?.trim();
  if (stored) out.push(stored);
  return out;
}

/** Settle, before any spinner starts, whether an existing project user
 *  with no working token may be deleted and created again. True: yes.
 *  False: nothing needs it. Throws the refusal when not allowed. */
export async function decideListmonkRegenerate(opts: {
  admin: ListmonkAuth;
  name: string;
  cachedTokens: string[];
  /** `--regenerate-token`: yes without asking. */
  allow: boolean;
  transactionalOnly?: boolean;
  interactive: boolean;
  /** hatchkit's own users; refused before anything is asked. */
  reservedNames?: string[];
}): Promise<boolean> {
  assertNotReserved(opts.name, opts.reservedNames);
  const found = await inspectListmonkProjectUser(
    opts.admin,
    opts.name,
    opts.cachedTokens,
    opts.transactionalOnly,
  );
  if (!found?.reason) return false;
  if (opts.allow) return true;
  if (opts.interactive) {
    console.log(
      chalk.yellow(
        `\n  Listmonk API user ${opts.name} (id ${found.userId}) exists, but ${found.reason}.`,
      ),
    );
    console.log(
      chalk.dim(
        "  Listmonk cannot show or regenerate an existing token. Recreating the user breaks every\n" +
          "  deployed copy of the old token until the app redeploys with the new one.",
      ),
    );
    const { confirm } = await import("@inquirer/prompts");
    const yes = await confirm({
      message: `Delete and recreate Listmonk API user ${opts.name}?`,
      default: false,
    });
    if (yes) return true;
  }
  throw new Error(regenerateRefusal(opts.name, found.userId, found.reason));
}

/** Files in the project's git tree, env files aside, that mention
 *  SES_SMTP_. Null when git cannot answer (not a repo). */
async function filesReadingSesSmtp(projectDir: string): Promise<string[] | null> {
  const { exec } = await import("../utils/exec.js");
  const res = await exec(
    "git",
    ["grep", "-l", "-I", "-e", "SES_SMTP_", "--", ".", ":(exclude,glob)**/.env*"],
    { cwd: projectDir, silent: true },
  );
  if (res.exitCode === 1 && !res.stderr.trim()) return [];
  if (res.exitCode !== 0) return null;
  return res.stdout.split("\n").filter(Boolean);
}

interface CliFlags {
  positional: string[];
  projectDir?: string;
  serverDir?: string;
  envFile?: string;
  transactionalOnly?: boolean;
  name?: string;
  dryRun: boolean;
  regenerateToken: boolean;
  keepSesSmtp: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const valueFlags = new Set(["--project-dir", "--server-dir", "--name", "--env-file"]);
  const out: CliFlags = {
    positional: [],
    dryRun: false,
    regenerateToken: false,
    keepSesSmtp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      if (a === "--project-dir") out.projectDir = v;
      if (a === "--server-dir") out.serverDir = v;
      if (a === "--env-file") out.envFile = v;
      if (a === "--name") out.name = v;
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--regenerate-token") out.regenerateToken = true;
    else if (a === "--transactional-only") out.transactionalOnly = true;
    else if (a === "--keep-ses-smtp") out.keepSesSmtp = true;
    else if (a.startsWith("-")) throw new Error(`Unknown flag ${a}`);
    else out.positional.push(a);
  }
  return out;
}

/** `hatchkit listmonk user …` (usage: `printListmonkUsage` in
 *  index.ts). Throws on anything that stops the run. */
export async function runListmonkUserCli(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dry = flags.dryRun;
  if (flags.envFile && flags.serverDir)
    throw new Error("Use --env-file or --server-dir, not both.");
  const { findManifestDirUpward, readManifest } = await import("../scaffold/manifest.js");

  // ── project ──
  const arg = flags.positional[0];
  const argIsDir = !!arg && existsSync(resolve(arg));
  const projectDir = flags.projectDir
    ? resolve(flags.projectDir)
    : argIsDir
      ? resolve(arg)
      : findManifestDirUpward(process.cwd());
  if (!projectDir || !existsSync(projectDir)) {
    throw new Error(
      "Run this inside the project, or pass its directory: `hatchkit listmonk user --project-dir <path>`.",
    );
  }
  const manifest = readManifest(projectDir);
  const argName = arg && !argIsDir ? arg : undefined;
  if (argName && manifest?.name && argName !== manifest.name && !flags.name) {
    throw new Error(
      `${projectDir} holds project ${manifest.name}, not ${argName}. Pass --project-dir for ${argName}, or --name to override.`,
    );
  }
  const name = flags.name ?? manifest?.name ?? argName ?? basename(projectDir);
  const envRoot = flags.serverDir ? resolve(projectDir, flags.serverDir) : projectDir;

  const { getListmonkAdminAuth, getListmonkConfig, LISTMONK_ADMIN_API_USER } = await import(
    "../config.js"
  );
  const {
    checkListmonkAdmin,
    ensureListmonkProjectUser,
    listmonkAdminSetupSteps,
    validListmonkUsername,
  } = await import("./listmonk-project-user.js");
  const { listListmonkLists, normalizeListmonkUrl } = await import("./listmonk.js");
  if (!validListmonkUsername(name)) {
    throw new Error(`"${name}" cannot be a Listmonk username. Pass --name <3+ characters>.`);
  }

  const explicitEnv = flags.envFile ? resolve(projectDir, flags.envFile) : undefined;
  const snap = explicitEnv
    ? await readLocalListmonkEnv(explicitEnv)
    : await readProjectEnvSnapshot(envRoot);
  if (!snap.prodPath) {
    throw new Error(
      `No .env.production under ${envRoot}. For a project without Listmonk env yet, run \`hatchkit add ${name} listmonk-ses\`; if the server env lives elsewhere, pass --server-dir.`,
    );
  }
  const prodRel = relative(projectDir, snap.prodPath) || ".env.production";
  const blocked = snap.undecrypted.filter((k) => k.startsWith("LISTMONK_"));
  if (blocked.length > 0) {
    throw new Error(
      `Cannot decrypt ${blocked.join(", ")} in ${prodRel}: no dotenvx private key next to it. Restore .env.keys (\`hatchkit keys show ${name}\`), then run again.`,
    );
  }

  // ── Listmonk ──
  const listmonkCfg = await getListmonkConfig();
  if (!listmonkCfg)
    throw new Error("Listmonk is not configured. Run `hatchkit config add listmonk`.");
  const admin = await getListmonkAdminAuth();
  if (!admin) {
    throw new Error(
      [
        "This needs the hatchkit-admin Listmonk credential, and the keychain has none:",
        ...listmonkAdminSetupSteps().map((s) => `  ${s}`),
      ].join("\n"),
    );
  }
  const projectUrl = snap.prod.LISTMONK_URL ?? snap.dev.LISTMONK_URL;
  if (projectUrl && normalizeListmonkUrl(projectUrl) !== normalizeListmonkUrl(admin.url)) {
    throw new Error(
      `${name}'s LISTMONK_URL is ${projectUrl}, but hatchkit's Listmonk is ${admin.url}. This command only manages hatchkit's Listmonk.`,
    );
  }
  const adminProfile = await checkListmonkAdmin(admin);

  // ── lists ──
  const lists = flags.transactionalOnly ? [] : await listListmonkLists(admin);
  const fromEnv = flags.transactionalOnly ? {} : listmonkListIdsFromEnv(snap.prod, snap.dev);
  const live = fromEnv.live ?? lists.find((l) => l.name === name)?.id;
  const test = fromEnv.test ?? lists.find((l) => l.name === `${name}-test`)?.id;
  const listIds = [live, test].filter((id): id is number => id !== undefined);
  const unknown = listIds.filter((id) => !lists.some((l) => l.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `${name}'s env names Listmonk list id(s) ${unknown.join(", ")}, which do not exist.`,
    );
  }
  if (listIds.length === 0 && !flags.transactionalOnly) {
    throw new Error(
      `Found no Listmonk list for ${name}: no LISTMONK_LIVE_LIST_ID / LISTMONK_LIST_ID / LISTMONK_TEST_LIST_ID in its env, and no list named ${name} or ${name}-test.`,
    );
  }
  const listLabel = (id: number) => `${lists.find((l) => l.id === id)?.name ?? "?"} (id ${id})`;

  console.log(
    chalk.bold(`\n  Listmonk user for ${name}${dry ? chalk.yellow(" [dry-run]") : ""}\n`),
  );
  console.log(chalk.dim(`  Listmonk:   ${admin.url} (as ${adminProfile.username})`));
  console.log(chalk.dim(`  Env:        ${prodRel}`));
  console.log(
    chalk.dim(
      `  Lists:      ${live ? `live ${listLabel(live)}` : "live: none"}, ${test ? `test ${listLabel(test)}` : "test: none"}`,
    ),
  );
  const previousUser = snap.prod.LISTMONK_API_USER;
  if (previousUser) console.log(chalk.dim(`  Env user:   ${previousUser}`));

  // ── roles + user ──
  const reservedNames = [listmonkCfg.apiUser, LISTMONK_ADMIN_API_USER];
  const cachedTokens = await cachedProjectListmonkTokens(name, envRoot, snap);
  const regenerate = dry
    ? false
    : await decideListmonkRegenerate({
        admin,
        name,
        cachedTokens,
        allow: flags.regenerateToken,
        transactionalOnly: flags.transactionalOnly,
        interactive: !!process.stdin.isTTY,
        reservedNames,
      });

  const { RunLedger } = await import("../utils/run-ledger.js");
  const { SECRET_KEYS, getSecret, setSecret } = await import("../utils/secrets.js");
  const ledger = dry ? null : RunLedger.resumeOrStart(name);
  const tokenAccount = SECRET_KEYS.listmonkProjectApiToken(name);

  const result = await ensureListmonkProjectUser(
    {
      admin,
      name,
      listIds,
      transactionalOnly: flags.transactionalOnly,
      cachedTokens,
      confirmRegenerate: async () => regenerate,
      reservedNames,
      dryRun: dry,
    },
    {
      onRole: (e) => {
        if (e.createdThisRun && ledger) {
          ledger.record({
            kind: "listmonkRole",
            listmonkUrl: admin.url,
            roleType: e.roleType,
            name: e.name,
            roleId: e.roleId,
          });
        }
      },
      onUser: (e) => {
        if (e.createdThisRun && ledger) {
          ledger.record({
            kind: "listmonkApiUser",
            listmonkUrl: admin.url,
            username: e.username,
            userId: e.userId,
          });
        }
      },
      onToken: async (e) => {
        await setSecret(tokenAccount, e.token);
        ledger?.record({ kind: "keychain", account: tokenAccount });
      },
    },
  );

  if (result.changes.length === 0) {
    console.log(chalk.green(`  ✓ Listmonk roles and API user ${name} already in place.`));
  } else {
    for (const line of result.changes) {
      console.log(dry ? chalk.cyan(`  would ${line}`) : chalk.green(`  ✓ ${line}`));
    }
  }

  if (explicitEnv) {
    const current =
      snap.prod.LISTMONK_API_USER === name &&
      snap.prod.LISTMONK_API_TOKEN === result.token &&
      snap.prod.LISTMONK_URL === admin.url;
    if (dry) {
      console.log(
        chalk.cyan(
          `  would set LISTMONK_URL, LISTMONK_API_USER and LISTMONK_API_TOKEN in ${prodRel} (local plaintext)`,
        ),
      );
    } else {
      if (!result.token) throw new Error(`No token for Listmonk API user ${name}.`);
      const { writeLocalEnv } = await import("./write-env.js");
      if (!current)
        writeLocalEnv(explicitEnv, [
          { key: "LISTMONK_URL", value: admin.url },
          { key: "LISTMONK_API_USER", value: name },
          { key: "LISTMONK_API_TOKEN", value: result.token },
        ]);
      if ((await getSecret(tokenAccount)) !== result.token)
        await setSecret(tokenAccount, result.token);
      console.log(
        chalk.green(`  ✓ ${prodRel}: local Listmonk settings ready. Restart the app to load them.`),
      );
    }
    ledger?.complete();
    return;
  }

  // ── env files ──
  const { devLocalEnvPath, removeEnvKeys, writeDevEnv, writeProdEnv } = await import(
    "./write-env.js"
  );
  const devUsesListmonk = !!(snap.dev.LISTMONK_API_USER || snap.dev.LISTMONK_API_TOKEN);
  const devLocal = devLocalEnvPath(snap.devDir);
  const devLocalRel = relative(projectDir, devLocal);
  const prodCurrent =
    snap.prod.LISTMONK_API_USER === name &&
    !!result.token &&
    snap.prod.LISTMONK_API_TOKEN === result.token;
  const devCurrent =
    !devUsesListmonk ||
    (snap.dev.LISTMONK_API_USER === name &&
      !!result.token &&
      snap.dev.LISTMONK_API_TOKEN === result.token);

  if (dry) {
    if (!prodCurrent || result.changes.length > 0) {
      console.log(
        chalk.cyan(`  would set LISTMONK_API_USER=${name} + LISTMONK_API_TOKEN in ${prodRel}`),
      );
    }
    if (devUsesListmonk && (!devCurrent || result.changes.length > 0)) {
      console.log(
        chalk.cyan(`  would set LISTMONK_API_USER=${name} + LISTMONK_API_TOKEN in ${devLocalRel}`),
      );
    }
  } else {
    if (!result.token) throw new Error(`No token for Listmonk API user ${name}.`);
    const pairs = [
      { key: "LISTMONK_API_USER", value: name },
      { key: "LISTMONK_API_TOKEN", value: result.token },
    ];
    if (!prodCurrent) {
      writeProdEnv(snap.prodPath, pairs);
      console.log(chalk.green(`  ✓ ${prodRel}: LISTMONK_API_USER=${name} + its token (encrypted)`));
    }
    if (!devCurrent) {
      writeDevEnv(devLocal, pairs);
      console.log(chalk.green(`  ✓ ${devLocalRel}: LISTMONK_API_USER=${name} + its token`));
    }
    if (prodCurrent && devCurrent)
      console.log(chalk.dim("  · env files already name the project user."));
    // Keep the working token in the keychain too, so the next run finds
    // it even if the env file changes.
    if ((await getSecret(tokenAccount)) !== result.token)
      await setSecret(tokenAccount, result.token);
  }

  // ── SES_SMTP_* ──
  const smtpFiles = [snap.prodPath, join(snap.devDir, ".env.development"), devLocal].filter(
    (p) =>
      existsSync(p) &&
      SES_SMTP_KEYS.some((k) => new RegExp(`^\\s*${k}=`, "m").test(readFileSync(p, "utf-8"))),
  );
  let smtpRemoved = false;
  if (smtpFiles.length > 0) {
    const readers = flags.keepSesSmtp ? [] : await filesReadingSesSmtp(projectDir);
    if (flags.keepSesSmtp) {
      console.log(chalk.dim("  · --keep-ses-smtp: SES_SMTP_* left in place."));
    } else if (readers === null) {
      console.log(
        chalk.yellow(
          "  · SES_SMTP_* kept: not a git repo, so hatchkit cannot check what reads them.",
        ),
      );
    } else if (readers.length > 0) {
      console.log(chalk.dim(`  · SES_SMTP_* kept: read by ${readers.slice(0, 5).join(", ")}.`));
    } else {
      for (const file of smtpFiles) {
        const rel = relative(projectDir, file);
        if (dry) {
          console.log(
            chalk.cyan(`  would remove SES_SMTP_* from ${rel} (nothing in the project reads them)`),
          );
        } else {
          const removed = removeEnvKeys(file, SES_SMTP_KEYS);
          if (removed.length > 0) {
            smtpRemoved = true;
            console.log(
              chalk.green(`  ✓ ${rel}: removed ${removed.join(", ")} (nothing reads them)`),
            );
          }
        }
      }
    }
  }

  ledger?.complete();

  // ── follow-up ──
  if (dry) return;
  const envChanged = !prodCurrent || !devCurrent || smtpRemoved;
  if (!envChanged && result.changes.length === 0) {
    console.log(
      chalk.dim(
        `\n  Nothing changed. If Coolify does not have this pair yet: \`hatchkit sync\` in ${projectDir}.\n`,
      ),
    );
    return;
  }
  const lines: string[] = [];
  if (!snap.prod.LISTMONK_URL) {
    lines.push(
      `${prodRel} has no LISTMONK_URL: the rest of ${name}'s Listmonk settings live elsewhere (Coolify?). Sync pushes the new pair next to them.`,
    );
  }
  lines.push(
    result.regenerated
      ? `The deployed copy of ${name}'s old token stopped working just now: \`hatchkit sync\` in ${projectDir} and redeploy right away.`
      : `Push and redeploy: \`hatchkit sync\` in ${projectDir}. Until then the app keeps ${previousUser ? `${previousUser}'s` : "its old"} token.`,
  );
  if (smtpRemoved) {
    lines.push(
      "Sync only adds and updates variables: delete SES_SMTP_HOST / _PORT / _USERNAME / _PASSWORD from the Coolify app's environment by hand.",
    );
  }
  if (previousUser && previousUser === listmonkCfg.apiUser) {
    lines.push(
      `Once no project holds ${previousUser}'s token any more, retire it: \`hatchkit secrets rotate --global listmonk\`.`,
    );
  }
  console.log(chalk.bold("\n  Next:"));
  for (const line of lines) console.log(`    · ${line}`);
  console.log("");
}

/** An explicit destination is a local plaintext file; never infer sibling envs. */
export async function readLocalListmonkEnv(path: string): Promise<ProjectEnvSnapshot> {
  const { parseDotenv } = await import("../deploy/env-resolve.js");
  const { gitFileState } = await import("../utils/gitignore.js");
  if ([".env.production", ".env.development"].includes(basename(path))) {
    throw new Error("--env-file requires a local plaintext env file, such as server/.env.");
  }
  if (gitFileState(path).kind === "tracked")
    throw new Error(`Refusing to write plaintext credentials to tracked file ${path}.`);
  const prod = existsSync(path) ? parseDotenv(readFileSync(path, "utf-8")) : {};
  if (
    Object.entries(prod).some(
      ([k, v]) => k.startsWith("DOTENV_PUBLIC_KEY") || v.startsWith("encrypted:"),
    )
  ) {
    throw new Error(`--env-file cannot rewrite encrypted env file ${path}.`);
  }
  return { prodPath: path, prod, undecrypted: [], devDir: dirname(path), dev: {} };
}
