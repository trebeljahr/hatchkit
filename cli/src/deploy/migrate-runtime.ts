/*
 * `hatchkit migrate-runtime` — move a deployed project from a Coolify
 * Docker Compose app (stop-then-start on every deploy) to Docker Image
 * apps (rolling deploys). Why that is the fix: deploy/image-runtime.ts.
 * What gets reproduced and what blocks a move: migrate-runtime-plan.ts.
 *
 * ---------------------------------------------------------------------
 * The cutover, and why it has no gap
 * ---------------------------------------------------------------------
 *
 * Side by side, never in place:
 *
 *   1. Rename the compose app `<name>` → `<name>-legacy-compose`, so the
 *      replacement can take the name hatchkit looks apps up by.
 *   2. Create the image app(s) with the SAME hostnames
 *      (`force_domain_override`) plus a private verification host, copy
 *      the env, deploy. While the new container is starting Traefik
 *      skips it (not healthy yet); the old one keeps serving.
 *   3. Verify: the deployment finished (Coolify's own health check
 *      passed inside the container), the verification host answers
 *      through Traefik, and Coolify reports the app running.
 *      Any failure here stops the run with the old app untouched and
 *      renamed back. Nobody saw the new container.
 *   4. Cut over: turn off the old app's git auto-deploy, stop it. Until
 *      it stops, both containers carry routers for the same hosts and
 *      either may answer — both serve the same build. After, only the
 *      new one does.
 *   5. Point the repo's deploy secrets at the new app and leave it on
 *      its steady tag (see the plan module for why).
 *
 * The old app is stopped, not deleted: `--rollback` starts it again and
 * removes the replacement; `--cleanup` deletes it once you're satisfied
 * (volumes kept — Coolify's DELETE would otherwise remove them).
 *
 * Every step is recorded in a ledger under the hatchkit config dir, so
 * rollback and cleanup never have to guess what this run created.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig, getStore } from "../config.js";
import { readManifest } from "../scaffold/manifest.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { discoverPublicIps } from "../utils/coolify-server-ips.js";
import {
  ghSecretExists,
  ghSecretSet,
  repoSlugFromCoolifyGitRepository,
} from "./gh-actions-secrets.js";
import { formatImageRef } from "./image-runtime.js";
import {
  type PlannedImageApp,
  type RuntimeMigrationPlan,
  deploySecretNameFor,
  planRuntimeMigration,
} from "./migrate-runtime-plan.js";
import { computeRoutingPlan } from "./routing.js";

export interface MigrateRuntimeOptions {
  /** Coolify app names or uuids. Empty → the compose apps of the
   *  project whose `.hatchkit.json` is in `projectDir`. */
  targets: string[];
  projectDir: string;
  action: "migrate" | "rollback" | "cleanup";
  dryRun: boolean;
  yes: boolean;
  /** Per-compose-service health-check path overrides. */
  healthPaths: Record<string, string>;
  /** Skip the GitHub Actions secret swap. */
  noSecrets: boolean;
  /** Leave the new app on the sha it was created with instead of the
   *  steady branch tag. Right once the repo's deploy workflow pins
   *  `docker_registry_image_tag` itself — an immutable tag is also what
   *  verified-deploy needs as a rollback target. */
  keepLiveTag: boolean;
}

interface MigrationLedger {
  version: 1;
  source: {
    uuid: string;
    name: string;
    legacyName: string;
    autoDeployWasEnabled?: boolean;
    gitRepository?: string;
  };
  apps: Array<{ uuid: string; name: string; service: string; steadyTag: string }>;
  /** Secrets this run repointed, and the uuid they held before. */
  secrets: Array<{ repo: string; name: string; previousUuid: string }>;
  phase: "prepared" | "cut-over" | "rolled-back" | "cleaned";
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function runMigrateRuntimeCli(args: string[]): Promise<void> {
  const flagValues = (name: string): string[] =>
    args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
  const flagValue = (name: string): string | undefined => flagValues(name)[0];
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])),
  );
  const healthPaths: Record<string, string> = {};
  for (const spec of flagValues("health-path")) {
    const eq = spec.indexOf("=");
    if (eq <= 0 || !spec.slice(eq + 1).startsWith("/")) {
      throw new Error(`--health-path takes <service>=/path (got "${spec}").`);
    }
    healthPaths[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  const action = args.includes("--rollback")
    ? "rollback"
    : args.includes("--cleanup")
      ? "cleanup"
      : "migrate";
  const dirArg = flagValue("dir");
  const ok = await runMigrateRuntime({
    targets: positional,
    projectDir: dirArg ? resolve(dirArg) : resolve("."),
    action,
    dryRun: args.includes("--dry-run"),
    yes: args.includes("--yes") || args.includes("-y"),
    healthPaths,
    noSecrets: args.includes("--no-secrets"),
    keepLiveTag: args.includes("--keep-live-tag"),
  });
  if (!ok) process.exitCode = 1;
}

const VALUE_FLAGS = new Set(["--dir", "--health-path"]);

export async function runMigrateRuntime(opts: MigrateRuntimeOptions): Promise<boolean> {
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    console.log(chalk.red("  Coolify is not configured. Run `hatchkit config add coolify` first."));
    return false;
  }
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  if (opts.action !== "migrate") {
    const ledgers = findLedgers(opts.targets, opts.projectDir);
    if (ledgers.length === 0) {
      console.log(
        chalk.red("  No migration record found for that app. Pass the app name you migrated."),
      );
      return false;
    }
    let allOk = true;
    for (const ledger of ledgers) {
      const done =
        opts.action === "rollback"
          ? await rollback(api, ledger, opts)
          : await cleanup(api, ledger, opts);
      allOk &&= done;
    }
    return allOk;
  }

  const sources = await resolveSources(api, opts);
  if (sources.length === 0) {
    console.log(
      chalk.red(
        "  Nothing to migrate: name a Coolify app (`hatchkit migrate-runtime <app>`) or run this in a project with .hatchkit.json.",
      ),
    );
    return false;
  }

  let allOk = true;
  for (const source of sources) {
    const plan = await loadPlan(api, source.uuid, opts);
    renderPlan(plan);
    if (plan.blockers.length > 0) {
      allOk = false;
      continue;
    }
    if (opts.dryRun) continue;
    if (!opts.yes) {
      const go = await confirm({
        message:
          `Create ${plan.apps.length} Docker Image app(s), cut ${plan.source.name}'s traffic over to them, ` +
          "and stop the compose app (kept for --rollback)?",
        default: false,
      });
      if (!go) {
        console.log(chalk.dim("  Skipped."));
        continue;
      }
    }
    allOk = (await migrate(api, cfg.url, plan, opts)) && allOk;
  }
  if (opts.dryRun) console.log(chalk.dim("\n  Dry run — nothing was changed."));
  if (!opts.dryRun) await updateManifestIfComplete(opts.projectDir, api);
  return allOk;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

async function resolveSources(
  api: CoolifyApi,
  opts: MigrateRuntimeOptions,
): Promise<Array<{ uuid: string; name: string }>> {
  const apps = await api.listApplications();
  if (opts.targets.length > 0) {
    const out: Array<{ uuid: string; name: string }> = [];
    for (const t of opts.targets) {
      const hit = apps.find((a) => a.uuid === t || a.name === t);
      if (!hit) throw new Error(`No Coolify application named or with uuid "${t}".`);
      out.push({ uuid: hit.uuid, name: hit.name });
    }
    return out;
  }
  const manifest = readManifest(opts.projectDir);
  if (!manifest) return [];
  const names = new Set<string>();
  for (const topology of ["single-origin", "split"] as const) {
    for (const routed of computeRoutingPlan({
      name: manifest.name,
      domain: manifest.domain,
      topology,
      surfaces: manifest.surfaces,
    }).apps) {
      names.add(routed.appName);
      for (const alias of routed.aliases) names.add(alias);
    }
  }
  const out: Array<{ uuid: string; name: string }> = [];
  for (const a of apps) {
    if (!names.has(a.name)) continue;
    const live = await api.getApplication(a.uuid);
    if (live.buildPack === "dockercompose") out.push({ uuid: a.uuid, name: a.name });
  }
  return out;
}

async function loadPlan(
  api: CoolifyApi,
  uuid: string,
  opts: MigrateRuntimeOptions,
): Promise<RuntimeMigrationPlan> {
  const live = await api.getApplication(uuid);
  const composeRaw = await api.getApplicationComposeRaw(uuid);
  const envRows = await api.listAppEnvRowsDetailed(uuid);
  return planRuntimeMigration(
    {
      uuid,
      name: live.name,
      buildPack: live.buildPack,
      composeRaw,
      composeDomains: live.dockerComposeDomains,
    },
    envRows,
    { healthPaths: opts.healthPaths },
  );
}

function renderPlan(plan: RuntimeMigrationPlan): void {
  console.log(chalk.bold(`\n  ${plan.source.name}`) + chalk.dim(` (${plan.source.uuid})`));
  if (plan.blockers.length > 0) {
    console.log(chalk.red("    ✗ Can't migrate:"));
    for (const b of plan.blockers) console.log(chalk.red(`      · ${b}`));
    return;
  }
  console.log(chalk.dim(`    compose app → renamed ${plan.legacyName}, stopped after cutover`));
  for (const app of plan.apps) {
    console.log(
      `    + ${chalk.cyan(app.appName)} ${chalk.dim(`(Docker Image, from service "${app.service}")`)}`,
    );
    console.log(
      chalk.dim(
        `        image   ${formatImageRef(app.image)}` +
          (app.steadyTag !== app.image.tag ? `  (then :${app.steadyTag})` : ""),
      ),
    );
    console.log(chalk.dim(`        port    ${app.port}  (from ${app.portSource})`));
    for (const d of app.domains) console.log(chalk.dim(`        route   ${d}`));
    console.log(
      chalk.dim(
        `        health  GET ${app.healthCheck.path} — up to ${app.healthCheck.startPeriodSeconds + app.healthCheck.retries * app.healthCheck.intervalSeconds}s to pass`,
      ),
    );
    console.log(
      chalk.dim(
        `        env     ${app.env.length} var(s): ${app.env.map((e) => e.key).join(", ")}`,
      ),
    );
  }
  for (const w of plan.warnings) console.log(chalk.yellow(`    ! ${w}`));
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

async function migrate(
  api: CoolifyApi,
  coolifyUrl: string,
  plan: RuntimeMigrationPlan,
  opts: MigrateRuntimeOptions,
): Promise<boolean> {
  const source = await api.getApplication(plan.source.uuid);
  const placement = await resolvePlacement(api, source.environmentId);
  if (!placement || !source.serverUuid) {
    console.log(chalk.red("  Couldn't resolve the Coolify project/server this app lives in."));
    return false;
  }
  const ledger: MigrationLedger = {
    version: 1,
    source: {
      uuid: plan.source.uuid,
      name: plan.source.name,
      legacyName: plan.legacyName,
      ...(source.isAutoDeployEnabled !== undefined
        ? { autoDeployWasEnabled: source.isAutoDeployEnabled }
        : {}),
      ...(source.gitRepository ? { gitRepository: source.gitRepository } : {}),
    },
    apps: [],
    secrets: [],
    phase: "prepared",
    updatedAt: new Date().toISOString(),
  };
  saveLedger(ledger);

  const serverIp = (await api.listServers()).find((s) => s.uuid === source.serverUuid)?.ip ?? "";
  const ips = await discoverPublicIps(api, source.serverUuid, serverIp).catch(
    () => ({}) as { v4?: string },
  );

  // Baseline: what the public routes answer right now, so the cutover
  // check compares like with like (a server that 404s at `/` today is
  // not broken by answering 404 tomorrow).
  const baseline = new Map<string, number | null>();
  for (const app of plan.apps) {
    for (const url of publicProbeUrls(app)) baseline.set(url, await probeStatus(url));
  }

  // ── 1. Rename the compose app out of the way.
  await api.updateApplication(plan.source.uuid, { name: plan.legacyName });
  console.log(chalk.dim(`  Renamed ${plan.source.name} → ${plan.legacyName}`));

  const abort = async (why: string): Promise<boolean> => {
    console.log(chalk.red(`\n  ✗ ${why}`));
    await api.updateApplication(plan.source.uuid, { name: plan.source.name }).catch(() => {});
    console.log(
      chalk.dim(
        `  ${plan.source.name} was never touched beyond a rename (undone) and is still serving.\n` +
          `  The new app(s) are kept for inspection: Coolify → ${ledger.apps.map((a) => a.name).join(", ") || "(none)"} → Deployments.\n` +
          `  Remove them: hatchkit migrate-runtime ${plan.source.name} --rollback`,
      ),
    );
    return false;
  };

  // ── 2. Create, fill, deploy.
  for (const app of plan.apps) {
    const verifyHost = ips.v4 ? `${app.appName}-verify.${ips.v4}.sslip.io` : undefined;
    const create = ora(
      `Creating ${app.appName} (Docker Image, ${formatImageRef(app.image)})`,
    ).start();
    let uuid: string;
    try {
      const created = await api.createDockerImageApplication({
        projectUuid: placement.projectUuid,
        serverUuid: source.serverUuid,
        environmentUuid: placement.environmentUuid,
        environmentName: placement.environmentName,
        name: app.appName,
        description: `Replaces ${plan.legacyName} — Docker Image, rolling deploys (hatchkit migrate-runtime)`,
        image: app.image,
        portsExposes: String(app.port),
        domains: [...app.domains, ...(verifyHost ? [`http://${verifyHost}`] : [])],
        healthCheck: app.healthCheck,
        // The old app holds these hostnames until the cutover; sharing
        // them for that window is the point.
        forceDomainOverride: true,
        instantDeploy: false,
      });
      uuid = created.uuid;
      create.succeed(`Created ${app.appName} (${uuid})`);
    } catch (err) {
      create.fail();
      return abort(`Creating ${app.appName} failed: ${(err as Error).message}`);
    }
    ledger.apps.push({ uuid, name: app.appName, service: app.service, steadyTag: app.steadyTag });
    saveLedger(ledger);

    await api.setAppEnvRows(uuid, app.env);
    console.log(chalk.dim(`  Copied ${app.env.length} env var(s) (values not shown)`));

    const deploy = ora(`Deploying ${app.appName} — the old app keeps serving meanwhile`).start();
    const outcome = await deployAndWait(api, uuid);
    if (outcome !== "finished") {
      deploy.fail(`Deploy ${outcome}`);
      return abort(
        `${app.appName} did not become healthy (${outcome}). Coolify kept its container out of rotation. ` +
          `Check that the image has curl or wget and answers GET ${app.healthCheck.path} on port ${app.port} ` +
          "(override with --health-path <service>=/path).",
      );
    }
    deploy.succeed(`${app.appName} deployed and healthy`);

    const running = await waitFor(
      async () => (await api.getApplication(uuid)).status ?? "",
      (s) => s.startsWith("running"),
    );
    if (!running)
      return abort(`${app.appName} finished deploying but Coolify doesn't report it running.`);

    if (verifyHost && ips.v4) {
      const status = await waitFor(
        () => probeViaHost(ips.v4 as string, verifyHost, app.healthCheck.path),
        (s) => s !== null && s < 500,
        60_000,
      );
      if (!status) {
        return abort(
          `${app.appName} is healthy inside its container but Traefik doesn't route to it (http://${verifyHost}${app.healthCheck.path}). Wrong port?`,
        );
      }
      console.log(
        chalk.dim(`  Traefik routes to ${app.appName}: GET ${app.healthCheck.path} → ${status}`),
      );
    }
  }

  // ── 3. Cut over.
  if (source.isAutoDeployEnabled) {
    await api.updateApplication(plan.source.uuid, { isAutoDeployEnabled: false }).catch(() => {});
  }
  const stop = ora(`Stopping ${plan.legacyName} — traffic moves to the new app(s)`).start();
  await api.stopApplication(plan.source.uuid);
  const stopped = await waitFor(
    async () => (await api.getApplication(plan.source.uuid)).status ?? "",
    (s) => s.startsWith("exited") || s === "stopped",
    180_000,
  );
  if (!stopped)
    stop.warn(`${plan.legacyName} hasn't reported stopped yet — Coolify may still be draining it`);
  else stop.succeed(`${plan.legacyName} stopped`);
  ledger.phase = "cut-over";
  saveLedger(ledger);

  let publicOk = true;
  for (const [url, before] of baseline) {
    const after = await waitFor(
      () => probeStatus(url),
      (s) => s !== null && (s < 500 || s === before),
      60_000,
    );
    const shown = after ?? "no answer";
    if (after === null || (after >= 500 && after !== before)) {
      publicOk = false;
      console.log(chalk.red(`  ✗ ${url} → ${shown} (was ${before ?? "no answer"})`));
    } else {
      console.log(
        chalk.green(`  ✓ ${url} → ${shown}`) + chalk.dim(` (was ${before ?? "no answer"})`),
      );
    }
  }
  if (!publicOk) {
    console.log(
      chalk.red(
        `\n  The public routes aren't answering after the cutover. Restore the old app now:\n` +
          `    hatchkit migrate-runtime ${plan.source.name} --rollback`,
      ),
    );
    return false;
  }

  // ── 4. Settle the new apps: drop the verification host, move to the
  //    steady tag. Both take effect on the next deploy.
  //    Two requests, so a refused domain update can't take the tag
  //    change down with it — and the domains need the override: the
  //    stopped compose app still has them on record.
  for (const [i, app] of plan.apps.entries()) {
    const uuid = ledger.apps[i].uuid;
    if (!opts.keepLiveTag && app.steadyTag !== app.image.tag) {
      await api
        .updateApplication(uuid, { dockerRegistryImageTag: app.steadyTag })
        .catch((err) =>
          console.log(
            chalk.yellow(
              `  Couldn't move ${app.appName} to :${app.steadyTag}: ${(err as Error).message}\n` +
                "  Its next deploy re-runs the migrated build unless the workflow pins the tag.",
            ),
          ),
        );
    }
    await api
      .updateApplication(uuid, { domains: app.domains, forceDomainOverride: true })
      .catch((err) =>
        console.log(
          chalk.yellow(
            `  Couldn't drop the verification host from ${app.appName}: ${(err as Error).message}`,
          ),
        ),
      );
  }

  // ── 5. Point CI at the new app(s).
  if (!opts.noSecrets) await repointSecrets(coolifyUrl, plan, ledger, opts.projectDir);
  saveLedger(ledger);

  console.log(
    chalk.green(
      `\n  ✓ ${plan.source.name} now runs as ${plan.apps.map((a) => a.appName).join(" + ")} — deploys are rolling updates.`,
    ),
  );
  console.log(
    chalk.dim(
      `    Undo:     hatchkit migrate-runtime ${plan.source.name} --rollback\n` +
        `    Finalise: hatchkit migrate-runtime ${plan.source.name} --cleanup   (deletes ${plan.legacyName}, keeps volumes)`,
    ),
  );
  return true;
}

async function repointSecrets(
  coolifyUrl: string,
  plan: RuntimeMigrationPlan,
  ledger: MigrationLedger,
  cwd: string,
): Promise<void> {
  const repo = repoSlugFromCoolifyGitRepository(ledger.source.gitRepository);
  if (!repo) {
    console.log(
      chalk.yellow(
        "  No GitHub repo on the Coolify app — point your deploy workflow at the new uuid(s) yourself:\n" +
          ledger.apps.map((a) => `    ${a.name}: ${a.uuid}`).join("\n"),
      ),
    );
    return;
  }
  // Whichever deploy secrets this repo's workflow reads. Older
  // build-pipeline workflows call a full COOLIFY_WEBHOOK_URL; newer ones
  // compose the URL from COOLIFY_*_RESOURCE_UUID. Only secrets that
  // already exist are rewritten — creating one the workflow never reads
  // would only make the repo harder to read.
  const candidates: Array<{ name: string; value: string; uuid: string }> =
    plan.apps.length === 1
      ? [
          {
            name: deploySecretNameFor(plan.source.name),
            value: ledger.apps[0].uuid,
            uuid: ledger.apps[0].uuid,
          },
          {
            name: "COOLIFY_WEBHOOK_URL",
            value: `${coolifyUrl}/api/v1/deploy?uuid=${ledger.apps[0].uuid}`,
            uuid: ledger.apps[0].uuid,
          },
        ]
      : plan.apps.map((a, i) => ({
          name:
            a.role === "server" ? "COOLIFY_SERVER_RESOURCE_UUID" : "COOLIFY_CLIENT_RESOURCE_UUID",
          value: ledger.apps[i].uuid,
          uuid: ledger.apps[i].uuid,
        }));
  let updated = 0;
  for (const c of candidates) {
    if (!(await ghSecretExists(cwd, repo, c.name))) continue;
    await ghSecretSet(cwd, repo, c.name, c.value);
    ledger.secrets.push({ repo, name: c.name, previousUuid: plan.source.uuid });
    updated++;
    console.log(chalk.dim(`  GitHub: ${repo} ${c.name} → ${c.uuid}`));
  }
  if (updated === 0) {
    console.log(
      chalk.yellow(
        `  ${repo} has none of ${candidates.map((c) => c.name).join(", ")} — point its deploy workflow at:\n` +
          ledger.apps.map((a) => `    ${a.name}: ${a.uuid}`).join("\n"),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Rollback / cleanup
// ---------------------------------------------------------------------------

async function rollback(
  api: CoolifyApi,
  ledger: MigrationLedger,
  opts: MigrateRuntimeOptions,
): Promise<boolean> {
  console.log(chalk.bold(`\n  Rolling back ${ledger.source.name}`));
  if (ledger.phase === "cleaned") {
    console.log(
      chalk.red(
        `  ${ledger.source.legacyName} was already deleted by --cleanup; nothing to go back to.`,
      ),
    );
    return false;
  }
  if (opts.dryRun) {
    console.log(
      chalk.dim(
        `    would start ${ledger.source.legacyName}, stop + delete ${ledger.apps.map((a) => a.name).join(", ")}, ` +
          `rename it back to ${ledger.source.name}, and restore ${ledger.secrets.map((s) => s.name).join(", ") || "no secrets"}.`,
      ),
    );
    return true;
  }
  if (ledger.phase === "cut-over") {
    const start = ora(`Starting ${ledger.source.legacyName} again (a compose deploy)`).start();
    await api.queueDeploy(ledger.source.uuid);
    const outcome = await deployAndWait(api, ledger.source.uuid);
    if (outcome !== "finished") {
      start.fail(`${ledger.source.legacyName} deploy ${outcome} — leaving the new app(s) running.`);
      return false;
    }
    start.succeed(`${ledger.source.legacyName} is serving again`);
  }
  for (const app of ledger.apps) {
    await api.stopApplication(app.uuid).catch(() => {});
    await api.deleteApplicationKeepingVolumes(app.uuid).catch(() => {});
    console.log(chalk.dim(`  Removed ${app.name}`));
  }
  await api.updateApplication(ledger.source.uuid, {
    name: ledger.source.name,
    ...(ledger.source.autoDeployWasEnabled ? { isAutoDeployEnabled: true } : {}),
  });
  for (const s of ledger.secrets) {
    const value =
      s.name === "COOLIFY_WEBHOOK_URL"
        ? `${(await getCoolifyConfig())?.url}/api/v1/deploy?uuid=${s.previousUuid}`
        : s.previousUuid;
    await ghSecretSet(opts.projectDir, s.repo, s.name, value).catch((err) =>
      console.log(chalk.yellow(`  Couldn't restore ${s.name}: ${(err as Error).message}`)),
    );
  }
  ledger.phase = "rolled-back";
  saveLedger(ledger);
  console.log(chalk.green(`  ✓ ${ledger.source.name} is back on its Docker Compose app.`));
  return true;
}

async function cleanup(
  api: CoolifyApi,
  ledger: MigrationLedger,
  opts: MigrateRuntimeOptions,
): Promise<boolean> {
  console.log(chalk.bold(`\n  Cleaning up after ${ledger.source.name}`));
  if (ledger.phase !== "cut-over") {
    console.log(
      chalk.red(`  Migration is in phase "${ledger.phase}", not cut over — nothing to clean up.`),
    );
    return false;
  }
  const legacy = await api.getApplication(ledger.source.uuid).catch(() => null);
  if (legacy?.status?.startsWith("running")) {
    console.log(
      chalk.red(`  ${ledger.source.legacyName} is running again — refusing to delete a live app.`),
    );
    return false;
  }
  if (opts.dryRun) {
    console.log(
      chalk.dim(
        `    would delete ${ledger.source.legacyName} (${ledger.source.uuid}), keeping its volumes.`,
      ),
    );
    return true;
  }
  if (!opts.yes) {
    const go = await confirm({
      message: `Delete ${ledger.source.legacyName} from Coolify? (volumes are kept; this ends --rollback)`,
      default: false,
    });
    if (!go) return false;
  }
  await api.deleteApplicationKeepingVolumes(ledger.source.uuid);
  ledger.phase = "cleaned";
  saveLedger(ledger);
  console.log(chalk.green(`  ✓ Deleted ${ledger.source.legacyName}.`));
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the deployment Coolify queues for `uuid` to end. */
async function deployAndWait(api: CoolifyApi, uuid: string): Promise<string> {
  const { deploymentUuid } = await api.queueDeploy(uuid);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const deployments = await api.listApplicationDeployments(uuid, 5).catch(() => []);
    const d = deploymentUuid
      ? deployments.find((x) => x.deploymentUuid === deploymentUuid)
      : deployments[0];
    const status = d?.status ?? "";
    if (status === "finished") return "finished";
    if (status === "failed" || status.startsWith("cancelled")) return status;
  }
  return "timed out";
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 120_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await read().catch(() => null);
    if (v !== null && done(v)) return v;
    await sleep(3_000);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Public URLs to compare before and after the cutover: each routed
 *  host (routes with their own path are skipped — `/ws` answers an
 *  upgrade, not a GET) at the app's health path. */
function publicProbeUrls(app: PlannedImageApp): string[] {
  return app.domains
    .filter((d) => new URL(d).pathname === "/")
    .map((d) => `${new URL(d).origin}${app.healthCheck.path}`);
}

async function probeStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}hatchkit_cb=${Date.now()}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return null;
  }
}

/** GET http://<ip><path> with an explicit Host header — Traefik routes by
 *  it, and fetch() refuses to set Host, hence node:http. */
function probeViaHost(ip: string, host: string, path: string): Promise<number | null> {
  return new Promise((resolveProbe) => {
    const req = httpRequest(
      { host: ip, port: 80, path, method: "GET", headers: { Host: host }, timeout: 10_000 },
      (res) => {
        res.resume();
        resolveProbe(res.statusCode ?? null);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolveProbe(null));
    req.end();
  });
}

async function resolvePlacement(
  api: CoolifyApi,
  environmentId: number | undefined,
): Promise<{ projectUuid: string; environmentUuid?: string; environmentName: string } | null> {
  if (environmentId === undefined) return null;
  for (const p of await api.listProjectsWithEnvironments()) {
    const env = p.environments.find((e) => e.id === environmentId);
    if (env) return { projectUuid: p.uuid, environmentUuid: env.uuid, environmentName: env.name };
  }
  return null;
}

function ledgerDir(): string {
  return join(dirname(getStore().path), "runtime-migrations");
}

function saveLedger(ledger: MigrationLedger): void {
  ledger.updatedAt = new Date().toISOString();
  mkdirSync(ledgerDir(), { recursive: true });
  writeFileSync(
    join(ledgerDir(), `${ledger.source.uuid}.json`),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

function findLedgers(targets: string[], projectDir: string): MigrationLedger[] {
  let files: string[];
  try {
    files = readdirSync(ledgerDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const all = files.map(
    (f) => JSON.parse(readFileSync(join(ledgerDir(), f), "utf-8")) as MigrationLedger,
  );
  const wanted = new Set(targets);
  if (wanted.size === 0) {
    const manifest = readManifest(projectDir);
    if (!manifest) return [];
    return all.filter(
      (l) => l.source.name === manifest.name || l.source.name.startsWith(`${manifest.name}-`),
    );
  }
  return all.filter(
    (l) =>
      wanted.has(l.source.name) ||
      wanted.has(l.source.uuid) ||
      wanted.has(l.source.legacyName) ||
      l.apps.some((a) => wanted.has(a.name) || wanted.has(a.uuid)),
  );
}

/** Record the move in `.hatchkit.json`, once every app of the project is
 *  an image app — a half-migrated split project is still read as
 *  compose, which is the shape that can still describe it. */
async function updateManifestIfComplete(projectDir: string, api: CoolifyApi): Promise<void> {
  const manifest = readManifest(projectDir);
  if (!manifest || manifest.coolifyRuntime === "image") return;
  const byName = new Map((await api.listApplications()).map((a) => [a.name, a.uuid]));
  const plan = computeRoutingPlan({
    name: manifest.name,
    domain: manifest.domain,
    topology: manifest.topology ?? "single-origin",
    surfaces: manifest.surfaces,
    runtime: "image",
  });
  const ports: NonNullable<typeof manifest.containerPorts> = {};
  for (const routed of plan.apps) {
    const uuid = [routed.appName, ...routed.aliases].map((n) => byName.get(n)).find(Boolean);
    if (!uuid) return;
    const live = await api.getApplication(uuid);
    if (live.buildPack !== "dockerimage") return;
    const port = Number(live.portsExposes?.split(",")[0]);
    if (Number.isFinite(port) && port !== 3000 && routed.role !== "compose")
      ports[routed.role] = port;
  }
  if (
    addManifestFields(projectDir, {
      coolifyRuntime: "image",
      ...(Object.keys(ports).length > 0 ? { containerPorts: ports } : {}),
    })
  ) {
    console.log(chalk.dim(`  .hatchkit.json: coolifyRuntime → "image"`));
  }
}

/** Add top-level fields to `.hatchkit.json` without rewriting the rest.
 *
 *  `writeManifest` would also apply every pending schema migration to a
 *  file this command has no other business in (a v4 manifest gains a
 *  seeded `identifiers` block, arrays get re-wrapped). The fields are
 *  spliced in before the closing brace instead, so the diff is exactly
 *  what this move changed. Returns false when the file isn't a JSON
 *  object or already has one of the keys. */
export function addManifestFields(projectDir: string, fields: Record<string, unknown>): boolean {
  const path = join(projectDir, ".hatchkit.json");
  let text: string;
  let parsed: unknown;
  try {
    text = readFileSync(path, "utf-8");
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (Object.keys(fields).some((k) => k in (parsed as Record<string, unknown>))) return false;
  const close = text.lastIndexOf("}");
  const body = text.slice(0, close).replace(/\s*$/, "");
  const entries = Object.entries(fields).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")}`,
  );
  const sep = body.trimEnd().endsWith("{") ? "\n" : ",\n";
  writeFileSync(path, `${body}${sep}${entries.join(",\n")}\n}${text.slice(close + 1)}`);
  return true;
}
