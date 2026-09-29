/*
 * cli/src/secrets/global/consumers.ts — find and update every copy of a
 * global credential.
 *
 * Three kinds of consumer:
 *
 *   · Local projects. Found by scanning project roots (default
 *     `~/projects` and `~/work`, `$HATCHKIT_PROJECTS_ROOTS`, or
 *     `--projects-root`) for a direct child with `.hatchkit.json`.
 *     Detection is by env KEY NAME in `.env.production` /
 *     `.env.development(.local)`, not by the manifest's email intent: on
 *     2026-09-29 collection-of-beauty's manifest said `email: none`
 *     while its `.env.production` held the SES and ListMonk values.
 *     A project is rewritten only when its current value equals the old
 *     credential (decrypted in memory), so a project wired to another
 *     account is left alone.
 *   · Coolify apps whose env var NAMES include a consumer key. Coolify's
 *     `GET /envs` inlines values; `listAppEnvKeys` drops them inside the
 *     client, so nothing here ever holds a Coolify value.
 *   · Services (ListMonk's SMTP settings) — owned by the rotator.
 *
 * A consumer gets every consumer key, also one it did not hold: the
 * values work only as a set. On 2026-09-29 Coolify app tracktime-server
 * held LISTMONK_API_TOKEN alone; a new token next to an old user name
 * fails.
 *
 * Every write obeys the order rule: a project whose dotenvx key is in
 * git history is skipped, because the new value would be encrypted to a
 * key anyone can read. The plaintext dev copy is always written to the
 * gitignored `.env.development.local` (`writeDevEnv` checks), never to
 * the committed `.env.development`; a copy found there is moved out.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { parse as parseDotenv } from "@dotenvx/dotenvx";
import { getCoolifyConfig } from "../../config.js";
import { locateEnvKeysFile, parsePrivateKeyValue } from "../../deploy/keys.js";
import {
  devLocalEnvPath,
  readEnvKeys,
  writeDevEnv,
  writeProdEnv,
} from "../../provision/write-env.js";
import { readManifestWithMigrationInfo } from "../../scaffold/manifest.js";
import { CoolifyApi } from "../../utils/coolify-api.js";
import {
  DEV_ENV_FILE,
  DEV_LOCAL_ENV_FILE,
  findDevEnvSecrets,
} from "../../utils/dev-env-secrets.js";
import { locateEnvFile } from "../../utils/env-files.js";
import { execOk } from "../../utils/exec.js";
import { SECRET_KEYS, getSecret } from "../../utils/secrets.js";
import { redactErrorMessage } from "../audit.js";
import { inspectEnvKeysHistory } from "../key-history.js";
import { pushToGithub } from "../push.js";
import type { NewCred, OldCred } from "../types.js";
import type { ConsumerAuditEntry, GlobalRotator } from "./types.js";

// ─── Project discovery ──────────────────────────────────────────────

export interface LocalProject {
  name: string;
  dir: string;
  prodPath?: string;
  /** The gitignored `.env.development.local` a dev copy is written to,
   *  when the project has a dev env at all. */
  devPath?: string;
  /** Dev env files to read, local first: `.env.development.local`, then
   *  a legacy `.env.development` from before provisioned values moved. */
  devReadPaths: string[];
  prodKeys: Set<string>;
  devKeys: Set<string>;
  /** Manifest email intent names listmonk-ses. */
  listmonkSes: boolean;
}

/** Roots to scan when the operator names none: `$HATCHKIT_PROJECTS_ROOTS`
 *  (path-delimiter separated), else `~/projects` and `~/work`. */
export function defaultProjectRoots(): string[] {
  const fromEnv = process.env.HATCHKIT_PROJECTS_ROOTS;
  if (fromEnv) return fromEnv.split(delimiter).filter(Boolean);
  return [join(homedir(), "projects"), join(homedir(), "work")];
}

/** Hatchkit projects in `roots`: each root itself and its direct
 *  children that hold a `.hatchkit.json`. Depth 1 on purpose — deeper
 *  trees hold worktrees and fixtures that carry copies of a manifest. */
export function discoverProjects(roots: string[]): LocalProject[] {
  const dirs: string[] = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    dirs.push(root);
    for (const child of readdirSync(root)) {
      if (child.startsWith(".") || child === "node_modules") continue;
      const dir = join(root, child);
      if (isDir(dir)) dirs.push(dir);
    }
  }

  const seen = new Set<string>();
  const out: LocalProject[] = [];
  for (const dir of dirs) {
    if (!existsSync(join(dir, ".hatchkit.json"))) continue;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let manifest: ReturnType<typeof readManifestWithMigrationInfo>;
    try {
      manifest = readManifestWithMigrationInfo(dir);
    } catch {
      continue; // malformed manifest: not a project we can reason about
    }
    if (!manifest) continue;
    const prodPath = locateEnvFile(dir, ".env.production");
    const devReadPaths = [DEV_LOCAL_ENV_FILE, DEV_ENV_FILE]
      .map((f) => locateEnvFile(dir, f))
      .filter((p): p is string => p !== undefined);
    const devPath = devReadPaths[0] ? devLocalEnvPath(dirname(devReadPaths[0])) : undefined;
    const email = manifest.manifest.email;
    out.push({
      name: manifest.manifest.name,
      dir,
      prodPath,
      devPath,
      devReadPaths,
      prodKeys: prodPath ? readEnvKeys(prodPath) : new Set(),
      devKeys: new Set(devReadPaths.flatMap((p) => [...readEnvKeys(p)])),
      listmonkSes: email?.transactional === "listmonk-ses" || email?.mailingList === "listmonk-ses",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ─── Reading a project's current values (in memory only) ─────────────

async function projectPrivateKey(project: LocalProject): Promise<string | undefined> {
  const keysPath = locateEnvKeysFile(project.dir);
  if (keysPath) {
    const value = parsePrivateKeyValue(readFileSync(keysPath, "utf-8"));
    if (value) return value;
  }
  return (await getSecret(SECRET_KEYS.dotenvxPrivateKey(project.name))) ?? undefined;
}

function decryptFile(path: string, privateKey: string | undefined): Record<string, string> {
  const parsed = parseDotenv(readFileSync(path, "utf-8"), {
    privateKey,
    processEnv: {},
  }) as Record<string, string>;
  return parsed;
}

// ─── Planning ────────────────────────────────────────────────────────

export interface ProjectPlan {
  project: LocalProject;
  entry: ConsumerAuditEntry;
  writeProd: boolean;
  writeDev: boolean;
  /** `.env.production` holds (or may hold) the OLD credential but is
   *  skipped — its dotenvx key is in git history, or it can't be
   *  decrypted. Revoking now would break that project in production, so
   *  the orchestrator holds the revoke until `--resume` updates it. */
  prodPending: boolean;
}

export interface PlanProjectOptions {
  keysRotated?: boolean;
  /** Resume: a file already holding this value counts as done. */
  freshMatchValue?: string;
}

/** Decide what to do with one project. Read-only: decrypts in memory to
 *  compare the current value with the old credential. Returns undefined
 *  for a project that neither holds the keys nor is set to use them. */
export async function planProject(
  project: LocalProject,
  rotator: GlobalRotator,
  old: OldCred,
  opts: PlanProjectOptions = {},
): Promise<ProjectPlan | undefined> {
  const holdsProd = project.prodKeys.has(rotator.matchKey);
  const holdsDev = project.devKeys.has(rotator.matchKey);
  const entry: ConsumerAuditEntry = {
    kind: "project",
    name: project.name,
    location: project.dir,
    keys: [...rotator.consumerKeys],
    status: "planned",
  };
  if (!holdsProd && !holdsDev) {
    if (!project.listmonkSes) return undefined;
    return {
      project,
      entry: { ...entry, status: "unchanged", reason: "set to listmonk-ses but holds no copy" },
      writeProd: false,
      writeDev: false,
      prodPending: false,
    };
  }

  const oldValue = old.values[rotator.matchKey];
  const reasons: string[] = [];
  let writeProd = false;
  let writeDev = false;
  let prodPending = false;
  let alreadyDone = 0;

  if (holdsProd && project.prodPath) {
    const history = await inspectEnvKeysHistory(project.dir);
    if (history.status === "leaked" || (history.status === "unknown" && !opts.keysRotated)) {
      const why =
        history.status === "leaked"
          ? `its dotenvx key is in git history (${history.commits.join(", ")})`
          : `.env.keys is in git history (${history.commits.join(", ")}) and hatchkit cannot tell whether that key is current`;
      reasons.push(
        `.env.production skipped: ${why}; run \`hatchkit keys rotate ${project.name}\` first${history.status === "unknown" ? " or pass --keys-rotated" : ""}`,
      );
      prodPending = true;
    } else {
      const key = await projectPrivateKey(project);
      let value: string | undefined;
      try {
        value = decryptFile(project.prodPath, key)[rotator.matchKey];
      } catch {
        value = undefined;
      }
      if (value === undefined || value.startsWith("encrypted:")) {
        reasons.push(
          `.env.production skipped: cannot decrypt it (no .env.keys and no keychain key for ${project.name})`,
        );
        prodPending = true;
      } else if (opts.freshMatchValue !== undefined && value === opts.freshMatchValue) {
        alreadyDone++;
      } else if (oldValue !== undefined && value === oldValue) {
        writeProd = true;
      } else {
        reasons.push(".env.production holds a different credential; left alone");
      }
    }
  }

  if (holdsDev && project.devPath) {
    // The value the server loads: the local file wins over the legacy one.
    let value: string | undefined;
    for (const path of project.devReadPaths) {
      try {
        value = decryptFile(path, undefined)[rotator.matchKey];
      } catch {
        value = undefined;
      }
      if (value !== undefined) break;
    }
    if (opts.freshMatchValue !== undefined && value === opts.freshMatchValue) {
      alreadyDone++;
    } else if (oldValue === undefined || value !== oldValue) {
      reasons.push("the dev env holds a different value; left alone");
    } else {
      // Always safe: writeDevEnv writes the gitignored
      // .env.development.local and moves the old copy out of a
      // committed .env.development on the way.
      writeDev = true;
    }
  }

  const files: string[] = [];
  if (writeProd && project.prodPath) files.push(relative(project.dir, project.prodPath));
  if (writeDev && project.devPath) {
    files.push(relative(project.dir, project.devPath));
    // writeDevEnv moves every provisioned secret out of a legacy
    // .env.development. When git tracks that file the edit has to be
    // committed too, or the old plaintext credential stays in the tree.
    for (const legacy of project.devReadPaths.filter((p) => p !== project.devPath)) {
      if (findDevEnvSecrets(readFileSync(legacy, "utf-8")).length === 0) continue;
      const rel = relative(project.dir, legacy);
      if (await execOk("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: project.dir })) {
        files.push(rel);
      }
    }
  }
  if (files.length > 0) entry.files = files;

  if (writeProd || writeDev) {
    entry.status = "planned";
    const held = [
      ...(writeProd ? [project.prodKeys] : []),
      ...(writeDev ? [project.devKeys] : []),
    ];
    const added = missingKeys(rotator, held);
    if (added) reasons.push(added);
  } else if (alreadyDone > 0 && reasons.length === 0) {
    entry.status = "unchanged";
    entry.reason = "already holds the new credential";
  } else {
    entry.status = "skipped";
  }
  if (reasons.length > 0) entry.reason = reasons.join("; ");
  return { project, entry, writeProd, writeDev, prodPending };
}

// ─── Applying ────────────────────────────────────────────────────────

/** Write the new values into the project's env files and update the
 *  Actions secrets its repo already holds under those names. */
export async function applyProject(
  plan: ProjectPlan,
  rotator: GlobalRotator,
  fresh: NewCred,
  opts: { pushGh: boolean },
): Promise<ConsumerAuditEntry> {
  const entry: ConsumerAuditEntry = { ...plan.entry };
  const { project } = plan;
  try {
    const written = new Set<string>();
    const pairs = pairsFor(rotator, fresh);
    if (plan.writeProd && project.prodPath) {
      for (const k of writeProdEnv(project.prodPath, pairs)) written.add(k);
    }
    if (plan.writeDev && project.devPath) {
      for (const k of writeDevEnv(project.devPath, pairs)) written.add(k);
    }
    entry.keys = [...written].sort();
    entry.status = "updated";

    if (opts.pushGh && plan.writeProd) {
      try {
        const res = await pushToGithub(pairs, { cwd: project.dir });
        if (res.pushed.length > 0) {
          entry.targets = ["gh"];
          // pushToGithub only updates secrets the repo already holds.
          const unset = pairs.map((p) => p.key).filter((k) => !res.pushed.includes(k));
          if (unset.length > 0) {
            entry.reason = `GitHub Actions holds ${res.pushed.join(", ")} but not ${unset.join(", ")}; the values work only together. Set ${unset.map((k) => `\`gh secret set ${k}\``).join(" and ")} in ${project.name}'s repo.`;
          }
        }
      } catch (err) {
        entry.reason = `env written, but updating its GitHub Actions secrets failed: ${redactErrorMessage((err as Error).message)}`;
        entry.status = "failed";
      }
    }
  } catch (err) {
    entry.status = "failed";
    entry.reason = redactErrorMessage((err as Error).message);
  }
  return entry;
}

/** Every consumer key: the values work only as a set. */
function pairsFor(rotator: GlobalRotator, fresh: NewCred): Array<{ key: string; value: string }> {
  return rotator.consumerKeys
    .filter((k) => fresh.values[k] !== undefined)
    .map((k) => ({ key: k, value: fresh.values[k] }));
}

/** "adds X" for consumer keys some written place does not hold yet. */
export function missingKeys(rotator: GlobalRotator, held: ReadonlyArray<ReadonlySet<string>>): string | undefined {
  const missing = rotator.consumerKeys.filter((k) => held.some((h) => !h.has(k)));
  if (missing.length === 0) return undefined;
  return `adds ${missing.join(", ")}: the new values work only together`;
}

// ─── Coolify apps ────────────────────────────────────────────────────

export interface CoolifyConsumer {
  uuid: string;
  name: string;
  /** Consumer keys the app holds now. It gets all of them. */
  keys: string[];
}

export interface CoolifyDiscovery {
  configured: boolean;
  apps: CoolifyConsumer[];
  error?: string;
}

/** Coolify apps whose production env var names include one of `keys`.
 *  Key names only — values are dropped inside `listAppEnvKeys`. */
export async function discoverCoolifyApps(keys: readonly string[]): Promise<CoolifyDiscovery> {
  const cfg = await getCoolifyConfig();
  if (!cfg) return { configured: false, apps: [] };
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  try {
    const apps = await api.listApplications();
    const out: CoolifyConsumer[] = [];
    for (const app of apps) {
      const names = await api.listAppEnvKeys(app.uuid);
      const hit = keys.filter((k) => names.includes(k));
      if (hit.length > 0) out.push({ uuid: app.uuid, name: app.name, keys: hit });
    }
    return { configured: true, apps: out.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (err) {
    return { configured: true, apps: [], error: redactErrorMessage((err as Error).message) };
  }
}

/** The plan entry for one Coolify app. */
export function planCoolifyApp(app: CoolifyConsumer, rotator: GlobalRotator): ConsumerAuditEntry {
  const added = missingKeys(rotator, [new Set(app.keys)]);
  return {
    kind: "coolify-app",
    name: app.name,
    keys: [...rotator.consumerKeys],
    status: "planned",
    ...(added ? { reason: added } : {}),
  };
}

/** Set every consumer key's new value on one Coolify app. */
export async function applyCoolifyApp(
  app: CoolifyConsumer,
  rotator: GlobalRotator,
  fresh: NewCred,
): Promise<ConsumerAuditEntry> {
  const entry: ConsumerAuditEntry = { ...planCoolifyApp(app, rotator), status: "updated" };
  const cfg = await getCoolifyConfig();
  if (!cfg) return { ...entry, status: "failed", reason: "Coolify is no longer configured" };
  const envs: Record<string, string> = {};
  for (const { key, value } of pairsFor(rotator, fresh)) envs[key] = value;
  try {
    await new CoolifyApi({ url: cfg.url, token: cfg.token }).setAppEnv(app.uuid, envs);
  } catch (err) {
    return { ...entry, status: "failed", reason: redactErrorMessage((err as Error).message) };
  }
  return entry;
}
