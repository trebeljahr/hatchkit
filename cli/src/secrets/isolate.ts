/*
 * `hatchkit secrets isolate <project> | --all` — move a project's CI off
 * hatchkit's Coolify token.
 *
 * Per project, in this order:
 *
 *   1. Workflows. Every token-driven deploy step becomes "promote in
 *      GHCR + signed per-app webhook" (scaffold/signed-deploy.ts). The
 *      files are written; committing and pushing them is the operator's.
 *   2. `:live`. When the converted workflow promotes `:live`, each app is
 *      pointed at it — image apps by their tag, compose apps by their
 *      `*_IMAGE` variables — after `:live` is seeded from what the app
 *      pulls today, so the switch alone changes nothing that runs.
 *   3. Coolify + GitHub. Each app gets its own deploy hook (a random
 *      webhook secret, auto-deploy on, the sentinel watch path), the
 *      repo gets the per-app secrets, and COOLIFY_API_TOKEN /
 *      COOLIFY_TOKEN / COOLIFY_WEBHOOK_URL are deleted — once no
 *      workflow on disk reads them.
 *
 * From step 3 on, the checked-in (old) workflow can no longer deploy:
 * deploys pause until the converted workflow is pushed. That is the
 * price of taking the root token out of the repo at once, and the
 * summary says so.
 *
 * `--dry-run` reads everything and writes nothing. `--rotate` mints new
 * per-app deploy secrets even when the current ones are in sync — the
 * per-project revocation path.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getCoolifyConfig } from "../config.js";
import {
  LIVE_TAG,
  deployHookSecretNames,
  ensureDeployHook,
  withLiveTag,
} from "../deploy/coolify-deploy-hook.js";
import {
  type CoolifyDeployApp,
  PROVISIONER_SECRETS,
  repoSlugFromRemote,
  setCoolifyDeploySecrets,
} from "../deploy/gh-actions-secrets.js";
import { PROMOTE_STEP_NAME, upgradeWorkflowToSignedDeploy } from "../scaffold/signed-deploy.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { parseImageName, promoteTag, readManifest, registryToken } from "../utils/oci-registry.js";

export interface IsolateOptions {
  dryRun: boolean;
  rotate: boolean;
  /** Apps to use instead of looking them up by the manifest's name — for
   *  a repo hatchkit did not scaffold (no manifest) or apps named
   *  differently. */
  apps?: CoolifyDeployApp[];
}

/** A manifest without `deploymentMode` predates the field and was
 *  deployed to Coolify, which is how the rest of hatchkit reads it. */
export function deploysToCoolify(mode: string | undefined): boolean {
  return mode === undefined || mode === "coolify";
}

export interface IsolateResult {
  name: string;
  dir: string;
  repo?: string;
  apps: Array<{ uuid: string; role?: string; buildPack?: string; changes: string[] }>;
  /** Workflows rewritten (or that would be). */
  workflowsConverted: string[];
  /** Workflows that still read the token after conversion — hand-rolled
   *  steps the retrofit does not recognise. The token stays until a
   *  person converts them. */
  workflowsManual: string[];
  /** `:live` switches, as `<app>: <image> (from :<tag>)`. */
  live: string[];
  secretsPushed: string[];
  secretsRemoved: string[];
  keptProvisioner: string[];
  errors: string[];
}

/** Workflow files and their content after conversion. Pure apart from
 *  reading the directory. */
export function planWorkflowConversion(projectDir: string): Array<{
  file: string;
  before: string;
  after: string;
}> {
  const dir = join(projectDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => {
      const before = readFileSync(join(dir, f), "utf8");
      return { file: `.github/workflows/${f}`, before, after: upgradeWorkflowToSignedDeploy(before) };
    });
}

const readsToken = (text: string): boolean =>
  PROVISIONER_SECRETS.some((n) => new RegExp(`\\bsecrets\\.${n}\\b`).test(text));

/** The operator's own GitHub credential, for seeding `:live` in GHCR. */
async function ghRegistryAuth(): Promise<{ username: string; password: string } | null> {
  const token = await exec("gh", ["auth", "token"], { silent: true });
  const user = await exec("gh", ["api", "user", "-q", ".login"], { silent: true });
  if (token.exitCode !== 0 || user.exitCode !== 0) return null;
  return { username: user.stdout.trim(), password: token.stdout.trim() };
}

/** Seed `<image>:live` from `<image>:<fromTag>` unless it already exists,
 *  so pointing an app at `:live` changes nothing that runs. */
async function seedLive(
  image: string,
  fromTag: string,
  auth: { username: string; password: string },
): Promise<"exists" | "seeded"> {
  const name = parseImageName(image);
  const token = await registryToken(fetch, name, auth, true);
  if (await readManifest(fetch, name, LIVE_TAG, token)) return "exists";
  await promoteTag(fetch, { image, from: fromTag, to: LIVE_TAG, auth });
  return "seeded";
}

const tagOf = (ref: string): string => {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(colon + 1) : "latest";
};

/** The `*_IMAGE` variables of a compose app to point at `:live`, as
 *  key → the image reference it holds now.
 *
 *  Only PRODUCTION rows count. GET /envs returns production and preview
 *  rows in one list, and the same key can hold a different image in
 *  each — a preview copy left over from an old image name, say. Read
 *  together, whichever row came last would decide both the tag seeded
 *  and the value written to the production variable (setAppEnv writes
 *  production rows), pointing the app at another package's `:live`. A
 *  row whose value Coolify withheld is skipped too: unknown is not a
 *  reference to seed from. */
export function composeImageVarsToSwitch(
  rows: ReadonlyArray<{ key: string; value: string | undefined; isPreview: boolean }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.isPreview || r.value === undefined || !/_IMAGE$/.test(r.key)) continue;
    if (!/^[\w.-]+(:\d+)?\/[\w./-]+(:[\w.-]+)?$/.test(r.value)) continue;
    if (tagOf(r.value) === LIVE_TAG) continue;
    out[r.key] = r.value;
  }
  return out;
}

export async function isolateProject(
  projectDir: string,
  opts: IsolateOptions,
): Promise<IsolateResult> {
  const { readManifest: readProjectManifest } = await import("../scaffold/manifest.js");
  const manifest = readProjectManifest(projectDir);
  const name = manifest?.name ?? projectDir.split("/").filter(Boolean).pop() ?? projectDir;
  const result: IsolateResult = {
    name,
    dir: projectDir,
    apps: [],
    workflowsConverted: [],
    workflowsManual: [],
    live: [],
    secretsPushed: [],
    secretsRemoved: [],
    keptProvisioner: [],
    errors: [],
  };
  if (!manifest && !opts.apps?.length) {
    result.errors.push("no .hatchkit.json — name the apps with --app <uuid>[:client|:server]");
    return result;
  }
  if (manifest && !deploysToCoolify(manifest.deploymentMode)) {
    result.errors.push(`deploymentMode is ${manifest.deploymentMode}, not coolify`);
    return result;
  }
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    result.errors.push("Coolify is not configured on this machine");
    return result;
  }
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  const remote = await exec("git", ["-C", projectDir, "remote", "get-url", "origin"], {
    silent: true,
  });
  result.repo = remote.exitCode === 0 ? repoSlugFromRemote(remote.stdout.trim()) : undefined;
  if (!result.repo) {
    result.errors.push("no GitHub remote");
    return result;
  }

  const { findCoolifyAppsForProject } = await import("../deploy/coolify-app.js");
  const apps: CoolifyDeployApp[] =
    opts.apps && opts.apps.length > 0
      ? opts.apps
      : await findCoolifyAppsForProject(name, manifest?.topology);
  if (apps.length === 0) {
    result.errors.push(`no Coolify app named after ${name} was found`);
    return result;
  }

  // ── 1. Workflows ──
  const workflows = planWorkflowConversion(projectDir);
  for (const w of workflows) {
    if (w.after !== w.before) result.workflowsConverted.push(w.file);
    if (readsToken(w.after)) result.workflowsManual.push(w.file);
  }
  const promotesLive = workflows.some(
    (w) => w.after.includes(`- name: ${PROMOTE_STEP_NAME}`) || w.after.includes("hatchkit-deploy.mjs"),
  );
  if (!opts.dryRun) {
    for (const w of workflows) {
      if (w.after !== w.before) writeFileSync(join(projectDir, w.file), w.after, "utf8");
    }
  }

  // ── 2. `:live` ──
  if (promotesLive) {
    const auth = opts.dryRun ? null : await ghRegistryAuth();
    if (!opts.dryRun && !auth) {
      result.errors.push("`gh auth token` failed — can't seed :live in GHCR; apps were left alone");
    } else {
      for (const app of apps) {
        const label = app.role ?? "app";
        try {
          const detail = await api.getApplication(app.uuid);
          if (detail.buildPack === "dockerimage" && detail.dockerRegistryImageName) {
            const image = detail.dockerRegistryImageName;
            const from = detail.dockerRegistryImageTag || "latest";
            if (from === LIVE_TAG) continue;
            if (!opts.dryRun && auth) {
              await seedLive(image, from, auth);
              await api.updateApplication(app.uuid, { dockerRegistryImageTag: LIVE_TAG });
            }
            result.live.push(`${label}: ${image}:${LIVE_TAG} (from :${from})`);
          } else {
            const current = composeImageVarsToSwitch(await api.listAppEnvRows(app.uuid));
            const updates: Record<string, string> = {};
            for (const [key, value] of Object.entries(current)) {
              if (!opts.dryRun && auth) await seedLive(value, tagOf(value), auth);
              updates[key] = withLiveTag(value);
              result.live.push(`${label}: ${key}=${withLiveTag(value)} (from :${tagOf(value)})`);
            }
            if (!opts.dryRun && Object.keys(updates).length > 0) await api.setAppEnv(app.uuid, updates);
          }
        } catch (err) {
          result.errors.push(`${label}: :live switch failed — ${(err as Error).message}`);
        }
      }
    }
  }

  // ── 3. Coolify hooks + GitHub secrets ──
  if (opts.dryRun) {
    for (const app of apps) {
      try {
        const { changes } = await ensureDeployHook(api, app.uuid, {
          role: app.role,
          rotate: opts.rotate,
          dryRun: true,
        });
        const state = await api.getDeployHookState(app.uuid);
        result.apps.push({ uuid: app.uuid, role: app.role, buildPack: state.buildPack, changes });
      } catch (err) {
        result.errors.push(`${app.role ?? "app"}: ${(err as Error).message}`);
      }
    }
    result.secretsPushed = [
      "COOLIFY_BASE_URL",
      ...(apps.length > 1
        ? apps.flatMap((a) => Object.values(deployHookSecretNames(a.role)))
        : Object.values(deployHookSecretNames())),
    ];
    result.keptProvisioner = result.workflowsManual.length > 0 ? [...PROVISIONER_SECRETS] : [];
    result.secretsRemoved = result.workflowsManual.length > 0 ? [] : [...PROVISIONER_SECRETS];
    return result;
  }

  for (const app of apps) {
    const state = await api.getDeployHookState(app.uuid).catch(() => null);
    result.apps.push({ uuid: app.uuid, role: app.role, buildPack: state?.buildPack, changes: [] });
  }
  const pushed = await setCoolifyDeploySecrets({
    projectDir,
    repoSlug: result.repo,
    apps,
    rotate: opts.rotate,
  });
  if (!pushed.ok) result.errors.push("deploy hook / GitHub secret push failed (see above)");
  result.secretsPushed = pushed.pushed;
  result.secretsRemoved = pushed.removed;
  result.keptProvisioner = pushed.keptProvisioner;
  return result;
}

function printResult(r: IsolateResult, dryRun: boolean): void {
  const would = dryRun ? "would " : "";
  console.log(chalk.bold(`\n  ${r.name}`) + chalk.dim(`  ${r.repo ?? r.dir}`));
  for (const e of r.errors) console.log(chalk.red(`    ✗ ${e}`));
  for (const a of r.apps) {
    const kind = a.buildPack === "dockercompose" ? " (compose)" : a.buildPack ? ` (${a.buildPack})` : "";
    console.log(
      `    · ${a.role ?? "app"} ${a.uuid}${kind}` +
        (a.changes.length ? ` — ${would}${a.changes.join(", ")}` : ""),
    );
  }
  if (r.workflowsConverted.length) {
    console.log(`    · ${would}rewrite ${r.workflowsConverted.join(", ")}`);
  }
  for (const l of r.live) console.log(`    · ${would}point ${l}`);
  if (r.secretsPushed.length) {
    console.log(chalk.dim(`    · ${would}set ${r.secretsPushed.join(", ")}`));
  }
  if (r.secretsRemoved.length) {
    console.log(chalk.green(`    · ${would}delete ${r.secretsRemoved.join(", ")}`));
  }
  if (r.workflowsManual.length) {
    console.log(
      chalk.yellow(
        `    ! ${r.workflowsManual.join(", ")} still read the Coolify token after conversion —\n` +
          "      hand-rolled steps. Convert them by hand; the token stays until then.",
      ),
    );
  }
  const compose = r.apps.filter((a) => a.buildPack === "dockercompose");
  if (compose.length) {
    console.log(
      chalk.yellow(
        `    ! compose app(s) ${compose.map((a) => a.role ?? "app").join(", ")}: turn "Shallow Clone" OFF in\n` +
          "      Coolify (app → Advanced) — see `hatchkit doctor`.",
      ),
    );
  }
  if (!dryRun && r.workflowsConverted.length) {
    console.log(
      chalk.cyan(
        "    → Commit and push the rewritten workflow(s). Until then the old workflow\n" +
          "      cannot deploy: the token it reads is gone.",
      ),
    );
  }
}

/** `hatchkit secrets isolate <project-dir|name> | --all [--dry-run] [--rotate] [--json]`. */
export async function runSecretsIsolate(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const rotate = args.includes("--rotate");
  const json = args.includes("--json");
  const all = args.includes("--all");
  // --app <uuid>[:client|:server], repeatable.
  const apps: CoolifyDeployApp[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--app") continue;
    const [uuid, role] = (args[i + 1] ?? "").split(":");
    if (!uuid || (role && role !== "client" && role !== "server")) {
      console.log("--app takes <uuid> or <uuid>:client|server");
      return 1;
    }
    apps.push(role === "client" || role === "server" ? { uuid, role } : { uuid });
  }
  const target = args.find(
    (a, i) => i > 0 && !a.startsWith("--") && args[i - 1] !== "--app",
  );

  const { defaultProjectRoots, discoverProjects } = await import("./global/consumers.js");
  let dirs: string[];
  if (all) {
    const { readManifest } = await import("../scaffold/manifest.js");
    dirs = discoverProjects(defaultProjectRoots())
      .map((p) => p.dir)
      .filter((d) => deploysToCoolify(readManifest(d)?.deploymentMode));
  } else if (target) {
    if (existsSync(join(target, ".hatchkit.json")) || (apps.length > 0 && existsSync(target))) {
      dirs = [target];
    }
    else {
      const match = discoverProjects(defaultProjectRoots()).find(
        (p) => p.name === target || p.dir.endsWith(`/${target}`),
      );
      if (!match) {
        console.log(`No hatchkit project named or at "${target}".`);
        return 1;
      }
      dirs = [match.dir];
    }
  } else if (existsSync(join(process.cwd(), ".hatchkit.json"))) {
    dirs = [process.cwd()];
  } else {
    console.log(
      "Usage: hatchkit secrets isolate <project> | --all [--app <uuid>[:client|:server]] [--dry-run] [--rotate] [--json]",
    );
    return 1;
  }

  const results: IsolateResult[] = [];
  for (const dir of dirs) {
    try {
      results.push(await isolateProject(dir, { dryRun, rotate, apps: all ? undefined : apps }));
    } catch (err) {
      results.push({
        name: dir,
        dir,
        apps: [],
        workflowsConverted: [],
        workflowsManual: [],
        live: [],
        secretsPushed: [],
        secretsRemoved: [],
        keptProvisioner: [],
        errors: [(err as Error).message],
      });
    }
  }
  if (json) {
    console.log(JSON.stringify({ dryRun, results }, null, 2));
  } else {
    if (dryRun) console.log(chalk.dim("\n  Dry run — nothing was changed."));
    for (const r of results) printResult(r, dryRun);
    console.log("");
  }
  return results.some((r) => r.errors.length > 0) ? 1 : 0;
}
