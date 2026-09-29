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
 *     `.env.development`, not by the manifest's email intent: on
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
 * Every write obeys the order rule: a project whose dotenvx key is in
 * git history is skipped, because the new value would be encrypted to a
 * key anyone can read. A plaintext `.env.development` is written only
 * when git ignores it.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { parse as parseDotenv } from "@dotenvx/dotenvx";
import { getCoolifyConfig } from "../../config.js";
import { locateEnvKeysFile, parsePrivateKeyValue } from "../../deploy/keys.js";
import { readEnvKeys, writeDevEnv, writeProdEnv } from "../../provision/write-env.js";
import { readManifestWithMigrationInfo } from "../../scaffold/manifest.js";
import { CoolifyApi } from "../../utils/coolify-api.js";
import { locateEnvFile } from "../../utils/env-files.js";
import { exec } from "../../utils/exec.js";
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
  devPath?: string;
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
    const devPath = locateEnvFile(dir, ".env.development");
    const email = manifest.manifest.email;
    out.push({
      name: manifest.manifest.name,
      dir,
      prodPath,
      devPath,
      prodKeys: prodPath ? readEnvKeys(prodPath) : new Set(),
      devKeys: devPath ? readEnvKeys(devPath) : new Set(),
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

/** True when git would never commit `path`: outside any repo, or
 *  ignored and untracked. */
async function gitIgnores(path: string, dir: string): Promise<boolean> {
  const inRepo = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    silent: true,
  });
  if (inRepo.exitCode !== 0) return true;
  const tracked = await exec("git", ["ls-files", "--error-unmatch", path], {
    cwd: dir,
    silent: true,
  });
  if (tracked.exitCode === 0) return false;
  const ignored = await exec("git", ["check-ignore", "-q", path], { cwd: dir, silent: true });
  return ignored.exitCode === 0;
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
    keys: rotator.consumerKeys.filter((k) => project.prodKeys.has(k) || project.devKeys.has(k)),
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
    let value: string | undefined;
    try {
      value = decryptFile(project.devPath, undefined)[rotator.matchKey];
    } catch {
      value = undefined;
    }
    if (opts.freshMatchValue !== undefined && value === opts.freshMatchValue) {
      alreadyDone++;
    } else if (oldValue === undefined || value !== oldValue) {
      reasons.push(".env.development holds a different value; left alone");
    } else if (!(await gitIgnores(project.devPath, project.dir))) {
      reasons.push(
        ".env.development skipped: git does not ignore it, so a plaintext secret there is published on the next push. It still holds the old credential; remove it from that file and ignore the file",
      );
    } else {
      writeDev = true;
    }
  }

  const files: string[] = [];
  if (writeProd && project.prodPath) files.push(relative(project.dir, project.prodPath));
  if (writeDev && project.devPath) files.push(relative(project.dir, project.devPath));
  if (files.length > 0) entry.files = files;

  if (writeProd || writeDev) {
    entry.status = "planned";
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
    if (plan.writeProd && project.prodPath) {
      const pairs = pairsFor(rotator, fresh, project.prodKeys);
      for (const k of writeProdEnv(project.prodPath, pairs)) written.add(k);
    }
    if (plan.writeDev && project.devPath) {
      const pairs = pairsFor(rotator, fresh, project.devKeys);
      for (const k of writeDevEnv(project.devPath, pairs)) written.add(k);
    }
    entry.keys = [...written].sort();
    entry.status = "updated";

    if (opts.pushGh && plan.writeProd) {
      const pairs = pairsFor(rotator, fresh, project.prodKeys);
      try {
        const res = await pushToGithub(pairs, { cwd: project.dir });
        if (res.pushed.length > 0) entry.targets = ["gh"];
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

function pairsFor(
  rotator: GlobalRotator,
  fresh: NewCred,
  present: Set<string>,
): Array<{ key: string; value: string }> {
  return rotator.consumerKeys
    .filter((k) => present.has(k) && fresh.values[k] !== undefined)
    .map((k) => ({ key: k, value: fresh.values[k] }));
}

// ─── Coolify apps ────────────────────────────────────────────────────

export interface CoolifyConsumer {
  uuid: string;
  name: string;
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

/** Set the new values on one Coolify app, for the keys it already holds. */
export async function applyCoolifyApp(
  app: CoolifyConsumer,
  fresh: NewCred,
): Promise<ConsumerAuditEntry> {
  const entry: ConsumerAuditEntry = {
    kind: "coolify-app",
    name: app.name,
    keys: app.keys,
    status: "updated",
  };
  const cfg = await getCoolifyConfig();
  if (!cfg) return { ...entry, status: "failed", reason: "Coolify is no longer configured" };
  const envs: Record<string, string> = {};
  for (const k of app.keys) {
    if (fresh.values[k] !== undefined) envs[k] = fresh.values[k];
  }
  try {
    await new CoolifyApi({ url: cfg.url, token: cfg.token }).setAppEnv(app.uuid, envs);
  } catch (err) {
    return { ...entry, status: "failed", reason: redactErrorMessage((err as Error).message) };
  }
  return entry;
}
