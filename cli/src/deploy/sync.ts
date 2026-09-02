/*
 * sync — push the .hatchkit.json manifest's view of the project onto
 * the Coolify resource(s) hatchkit created (or adopted) for it.
 *
 * Why this exists: Coolify's auto-generated Traefik labels are derived
 * from the application's Domain field (`docker_compose_domains` for
 * dockercompose build packs, `fqdn` / `domains` otherwise). When a
 * scaffold or adopt run created the app without that field populated —
 * or populated it with a shape Coolify silently drops — the container
 * ends up with zero traefik labels and Traefik drops the route.
 * `hatchkit sync` reads the manifest, finds the matching Coolify
 * app(s), and PATCHes them so Coolify regenerates the labels on the
 * next deploy.
 *
 * ---------------------------------------------------------------------
 * What sync used to get wrong
 * ---------------------------------------------------------------------
 *
 * It hardcoded `domains: [{ name: "app", … }]` — a compose service name
 * that appears in NO hatchkit-generated compose file (the starter's
 * services are `server` / `client` / `mongo` / `redis`). Coolify accepts
 * a PATCH naming a service that isn't in the compose with a 200 OK and
 * then emits no Traefik labels for it at all, so running sync on a
 * working project would have replaced its correct routing with a
 * phantom and taken the site down. It also never called the compose
 * validator that documents exactly this hazard.
 *
 * Now: the desired state comes from deploy/routing.ts (the same module
 * `create` and `adopt` use, so the three cannot disagree), every service
 * name is checked against the project's actual compose file BEFORE any
 * PATCH, and a mismatch refuses loudly instead of pushing.
 *
 * ---------------------------------------------------------------------
 * Reconciler, not patcher
 * ---------------------------------------------------------------------
 *
 * Sync used to only PATCH applications that already existed, which left
 * a hole nothing could fill. `create` scaffolds AND wires, but only for
 * a new project. `adopt` imports AND wires, but refuses once
 * `.hatchkit.json` exists. So a project that was scaffolded and never
 * fully deployed — Coolify app present, no domain, no DNS, no route to
 * the API — fell through all three commands with no way forward.
 *
 * Sync now drives the whole desired state, in five passes, each
 * idempotent and each skippable with a `--no-*` flag:
 *
 *   1. locate      find each app the topology requires, by hatchkit's
 *                  name or an accepted alias
 *   2. create      provision the ones Coolify doesn't have, through the
 *                  same `provisionRoutedApp` that `create` uses
 *   3. routing     PATCH domain / ports_exposes / stripprefix
 *   4. env         push the resolved production env (see below)
 *   5. dns         upsert an A record per hostname the topology needs
 *   6. secrets     push the paired GitHub Actions deploy secrets
 *
 * Fields pushed in the routing pass, and their caveats:
 *   · domain (`docker_compose_domains` for compose apps; `domains` for
 *     nixpacks / dockerfile / static)
 *   · ports_exposes — only on non-compose build packs; Coolify
 *     re-derives it from the compose file otherwise and discards ours,
 *     so diffing it there makes every app look permanently out of sync
 *   · is_stripprefix_enabled — must be false whenever routing uses a
 *     path (`https://<domain>/api`), or Coolify's Traefik middleware
 *     strips `/api` and Express 404s every API call. Write-only in this
 *     Coolify build (the app-settings relation isn't serialized on GET),
 *     so it never drives `changed` — it is pushed with every update.
 *
 * Env deserves a note. Coolify's environment is the RUNTIME source of
 * truth and the dotenvx-encrypted `.env.production` is the at-rest store
 * sync reads it from; the encrypted file is not shipped into the image.
 * Under `split` that is load-bearing rather than merely tidy: the two
 * applications sit on separate Docker networks with no in-stack mongo,
 * so MONGODB_URI reaches the server through Coolify env or not at all.
 *
 * Still out of scope (other commands own these):
 *   · ML services / GPU     → `hatchkit add gpu`
 *   · S3 buckets / tokens   → `hatchkit provision s3`
 *
 * Idempotent by design: reads current state first, only PATCHes when the
 * desired state differs from what Coolify reports. `--dry-run` shows
 * exactly what would be created vs reused, and touches nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { manifestHostnames, readManifestWithMigrationInfo } from "../scaffold/manifest.js";
import { listComposeServices, readComposeFile } from "../utils/compose.js";
import { CoolifyApi, type CoolifyApplication } from "../utils/coolify-api.js";
import { discoverPublicIps } from "../utils/coolify-server-ips.js";
import { exec } from "../utils/exec.js";
import { normalizeCoolifyGitRepository, wireDns } from "./coolify-app.js";
import { provisionRoutedApp } from "./coolify.js";
import { resolveProductionEnv } from "./env-resolve.js";
import {
  type CoolifyDeployApp,
  repoSlugFromRemote,
  setCoolifyDeploySecrets,
} from "./gh-actions-secrets.js";
import {
  type RoutedApp,
  type Topology,
  collapseComposeDomains,
  computeRoutingPlan,
  inferTopology,
} from "./routing.js";

export interface SyncOptions {
  /** Project root containing `.hatchkit.json`. */
  projectDir: string;
  /** Print the desired changes without PATCHing Coolify. */
  dryRun?: boolean;
  /** Emit `{ ok, apps: [...] }` JSON to stdout. Suppresses the human
   *  rendering for scripts. */
  json?: boolean;
  /** Push routing even when Coolify reports the domain as claimed by
   *  another resource. Only correct when the conflicting resource is a
   *  stale app for this same project. */
  force?: boolean;
  /** Trigger a Coolify redeploy of every app sync changed.
   *
   *  Needed to actually finish a repair: Coolify regenerates a
   *  container's Traefik labels when it (re)deploys, not when the
   *  application record is PATCHed. Without a redeploy the new routing
   *  sits in the database and the live containers keep serving — or
   *  503ing — under the old labels. Opt-in because it restarts
   *  containers. */
  deploy?: boolean;
  /** Create Coolify applications the topology requires but that don't
   *  exist yet. Default ON — this is what makes sync a reconciler
   *  rather than a patcher, and it is the only path that can finish a
   *  project which was scaffolded but never fully deployed.
   *  `--no-create` reduces sync to its previous patch-only behaviour. */
  create?: boolean;
  /** Push the resolved production env onto each application. Default
   *  ON. Under `split` this is not optional in practice: the two apps
   *  sit on separate Docker networks with no in-stack mongo, so
   *  MONGODB_URI reaches the server through Coolify env or not at all. */
  env?: boolean;
  /** Upsert the DNS records the topology needs (the bare domain, plus
   *  `api.<domain>` under `split`). Default ON. */
  dns?: boolean;
  /** Push the GitHub Actions deploy secrets. Default ON. */
  secrets?: boolean;
}

/** What sync intends to do for one Coolify application — surfaces both
 *  the desired payload and a diff against what Coolify currently reports.
 *  Renderable in either human-readable or JSON form. */
export interface AppSyncPlan {
  /** Coolify uuid. */
  uuid: string;
  /** Coolify app name (used to locate the resource). */
  name: string;
  /** Which half of the deployment this app is. */
  role: RoutedApp["role"];
  /** Build pack reported by Coolify — drives which API field carries
   *  the domain payload. */
  buildPack?: CoolifyApplication["buildPack"];
  /** Per-service domains for dockercompose apps, in the one-entry-per-
   *  service shape Coolify actually stores. Always populated when the
   *  build pack is dockercompose; undefined otherwise. */
  desiredDockerComposeDomains?: Array<{ name: string; domain: string }>;
  /** FQDN list for non-dockercompose apps. Always populated when the
   *  build pack is nixpacks / dockerfile / static; undefined for
   *  dockercompose. */
  desiredDomains?: string[];
  /** ports_exposes the manifest expects on this app. */
  desiredPortsExposes: string;
  /** Desired `is_stripprefix_enabled`. False whenever any routed domain
   *  carries a path. */
  desiredStripPrefix: boolean;
  /** Snapshot of the same fields as Coolify currently reports them. */
  current: {
    fqdn: string | null;
    dockerComposeDomains?: Array<{ name: string; domain: string }>;
    portsExposes?: string;
    stripPrefix?: boolean;
  };
  /** Whether a PATCH is needed to converge — false means everything
   *  already matches, sync skips the API call. */
  changed: boolean;
  /** Set when the routing this app needs names a compose service the
   *  project doesn't declare. sync REFUSES to PATCH in that case: the
   *  call would return 200 and then produce no Traefik labels, which
   *  reads as a successful sync followed by a fully-503 site. */
  blocked?: {
    reason: string;
    missingServices: string[];
    declaredServices: string[];
    composeFile: string;
    fix: string[];
  };
}

export interface SyncResult {
  ok: boolean;
  /** Set when sync couldn't run at all (e.g. no manifest, no Coolify
   *  config, no matching apps). Either `apps` or `error` will be
   *  meaningful — never both. */
  error?: string;
  /** Topology sync planned against, and where that value came from. */
  topology: Topology;
  topologySource: "manifest" | "compose" | "default";
  topologyReason: string;
  /** Compose services read off disk, or null when there's no readable
   *  compose file (sync then can't validate names and says so). */
  composeServices: string[] | null;
  apps: AppSyncPlan[];
  /** Names of the apps a `--deploy` run asked Coolify to redeploy. */
  deployed: string[];
  /** Coolify applications this run created (empty when everything the
   *  topology needs already existed). */
  created: string[];
  /** Per-app count of env vars pushed, keyed by app name. */
  envPushed: Record<string, number>;
  /** Hostnames whose DNS records were upserted. */
  dnsUpserted: string[];
  /** GitHub Actions secret names pushed, and stale ones removed. */
  secretsPushed: string[];
  secretsRemoved: string[];
  /** Set when a pre-split app still claims the bare domain, which would
   *  make Coolify reject the new client half's domain. */
  legacyDomainHolder?: string;
  /** When dryRun, no PATCH was made even if `changed` was true. */
  dryRun: boolean;
}

/** Top-level entrypoint. Reads the project manifest, finds the Coolify
 *  app(s) hatchkit knows about by name, and pushes the desired domain
 *  + ports + stripprefix payload — or just prints what it would push
 *  when `dryRun`. */
export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  // Read WITHOUT the console-logging wrapper: `readManifest` prints its
  // migration notes to stdout, which corrupts `--json` output for any
  // caller trying to parse it.
  const read = readManifestWithMigrationInfo(opts.projectDir);
  const manifest = read?.manifest;
  if (read?.migrated && !opts.json) {
    for (const note of read.migrationNotes) console.log(`  ${note}`);
  }
  if (!manifest) {
    const err = `No .hatchkit.json found in ${opts.projectDir}.`;
    if (!opts.json) {
      console.log(chalk.red(`  ${err}`));
      console.log(
        chalk.dim(
          "  Run `hatchkit sync` from a hatchkit-scaffolded project root, or `hatchkit adopt` to onboard an existing project first.",
        ),
      );
    }
    return { ...emptyResult(opts), error: err };
  }
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    const err = "Coolify is not configured. Run `hatchkit config add coolify` first.";
    if (!opts.json) console.log(chalk.red(`  ${err}`));
    return { ...emptyResult(opts), error: err };
  }
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  const compose = readComposeFile(opts.projectDir);
  const inference = inferTopology({
    topology: manifest.topology,
    composeServices: compose?.services,
  });
  const routing = computeRoutingPlan({
    name: manifest.name,
    domain: manifest.domain,
    // Normalized extra hostnames (manifest `aliases[]`) — primary is
    // hostnames[0], so everything after it rides the public entry.
    hostnameAliases: manifestHostnames(manifest).slice(1),
    topology: inference.topology,
    surfaces: manifest.surfaces,
    ports: manifest.ports,
    publicService: manifest.publicService,
    composeServices: compose?.services,
  });

  if (!opts.json) {
    console.log(chalk.bold(`\n  ${manifest.name}`) + chalk.dim(` → ${manifest.domain}`));
    console.log(chalk.dim(`    topology: ${inference.topology} (${inference.reason})`));
    console.log(
      chalk.dim(
        compose
          ? `    compose:  ${compose.fileName} — services: ${compose.services.join(", ")}`
          : "    compose:  none readable — service names cannot be validated",
      ),
    );
    if (routing.extraDnsHostnames.length > 0) {
      console.log(
        chalk.dim(`    extra DNS this topology needs: ${routing.extraDnsHostnames.join(", ")}`),
      );
    }
  }

  const apps: AppSyncPlan[] = [];
  const patched: AppSyncPlan[] = [];
  const errors: string[] = [];
  const notFound: string[] = [];
  const created: string[] = [];
  const wouldCreate: string[] = [];
  const envPushed: Record<string, number> = {};
  const dnsUpserted: string[] = [];
  let secretsPushed: string[] = [];
  let secretsRemoved: string[] = [];

  // ── Pass 1: locate, then CREATE whatever the topology requires and
  //    Coolify doesn't have.
  //
  // This is the difference between a reconciler and a patcher, and the
  // gap this command existed inside: `create` wires a brand-new project
  // and `adopt` refuses once `.hatchkit.json` exists, so a project that
  // was scaffolded but never fully deployed had nothing that would
  // finish the job. Now sync will.
  let legacyDomainHolder: string | undefined;
  const locations = new Map<string, { uuid: string; name: string }>();
  for (const routed of routing.apps) {
    const found = await locateApp(api, routed, opts);
    if (found) locations.set(routed.appName, found);
  }
  const missing = routing.apps.filter((r) => !locations.has(r.appName));

  // Under `split`, an app named after the project itself is the
  // pre-split single-origin deployment. It still holds the bare domain,
  // and Coolify won't attach one FQDN to two resources — so creating the
  // client half would 409. Say so before the attempt, not after it fails.
  if (inference.topology === "split") {
    const legacy = await api.findApplicationByName(manifest.name);
    if (legacy && ![...locations.values()].some((l) => l.uuid === legacy.uuid)) {
      legacyDomainHolder =
        `A single-origin app named "${manifest.name}" (${legacy.uuid}) still exists and claims ` +
        `https://${manifest.domain}. Coolify won't attach that domain to a second resource.`;
      if (!opts.json) {
        console.log(chalk.yellow(`\n  ${legacyDomainHolder}`));
        console.log(
          chalk.dim(
            "    Either remove its domain in the Coolify dashboard (Configuration -> Domains)\n" +
              "    and stop or delete the app, or re-run with `--force` to take the domain over.\n" +
              "    `--force` is only correct once you've confirmed that app is the stale one.",
          ),
        );
      }
    }
  }
  if (missing.length > 0 && opts.create !== false) {
    if (opts.dryRun) {
      wouldCreate.push(...missing.map((m) => m.appName));
      if (!opts.json) {
        console.log(chalk.bold("\n  Would create:"));
        for (const routed of missing) {
          console.log(
            `    + ${routed.appName} ${chalk.dim(`(${routed.role})`)}\n` +
              chalk.dim(
                `        compose: ${routed.composeLocation}\n` +
                  `        domains: ${routed.composeDomains.map((d) => `${d.name}=${d.domain}`).join(", ")}`,
              ),
          );
        }
      }
    } else {
      try {
        const madeApps = await createMissingApps({
          api,
          missing,
          projectName: manifest.name,
          description: manifest.description,
          projectDir: opts.projectDir,
          json: opts.json,
        });
        for (const made of madeApps) {
          locations.set(made.appName, { uuid: made.uuid, name: made.name });
          if (made.created) created.push(made.name);
        }
      } catch (err) {
        errors.push(`create: ${(err as Error).message}`);
      }
    }
  } else if (missing.length > 0 && !opts.json) {
    console.log(
      chalk.yellow(
        `\n  ${missing.length} app(s) missing and --no-create given — routing for them can't be reconciled.`,
      ),
    );
  }

  // ── Pass 2: reconcile routing on every app that now exists.
  for (const routed of routing.apps) {
    const found = locations.get(routed.appName);
    if (!found) {
      notFound.push([routed.appName, ...routed.aliases].join(" / "));
      continue;
    }

    let current: CoolifyApplication;
    try {
      current = await api.getApplication(found.uuid);
    } catch (err) {
      errors.push(
        `Failed to read Coolify app "${found.name}" (${found.uuid}): ${(err as Error).message}`,
      );
      continue;
    }

    const plan = buildPlan(routed, current, composeForApp(opts.projectDir, routed, compose));
    apps.push(plan);
    if (!opts.json) renderPlan(plan);

    if (plan.blocked) {
      errors.push(`${plan.name}: ${plan.blocked.reason}`);
      continue;
    }
    if (!plan.changed) continue;
    if (opts.dryRun) continue;

    const patch = ora(`Coolify: updating "${plan.name}"`).start();
    try {
      await api.updateApplication(plan.uuid, {
        // Skipped for compose apps — Coolify re-derives it from the
        // compose file and our value would be discarded anyway.
        ...(plan.buildPack === "dockercompose" ? {} : { portsExposes: plan.desiredPortsExposes }),
        isStripprefixEnabled: plan.desiredStripPrefix,
        ...(plan.desiredDockerComposeDomains
          ? { dockerComposeDomains: plan.desiredDockerComposeDomains }
          : {}),
        ...(plan.desiredDomains ? { domains: plan.desiredDomains } : {}),
        ...(opts.force ? { forceDomainOverride: true } : {}),
      });
      patch.succeed(`Coolify: updated "${plan.name}"`);
      patched.push(plan);
    } catch (err) {
      const message = (err as Error).message;
      patch.fail(`Coolify: PATCH failed: ${message}`);
      if (/409|conflict|already/i.test(message)) {
        console.log(
          chalk.dim(
            "    Coolify reports this domain as claimed by another resource. Re-run with `--force`\n" +
              "    once you've confirmed the other resource is a stale app for this same project.",
          ),
        );
      }
      errors.push(`PATCH ${plan.name}: ${message}`);
    }
  }

  // ── Pass 3: env. Coolify's environment is the RUNTIME source of
  //    truth; the dotenvx-encrypted .env.production is the at-rest
  //    store we read it from. See deploy/env-resolve.ts.
  const resolvedEnv = opts.env === false ? null : await resolveProductionEnv(opts.projectDir);
  if (resolvedEnv) {
    if (resolvedEnv.undecrypted.length > 0) {
      // Pushing `encrypted:...` as though it were a value would put
      // ciphertext into the container and fail at a much more confusing
      // point, so refuse the whole push rather than half of it.
      const err =
        `${resolvedEnv.relPath}: ${resolvedEnv.undecrypted.length} value(s) still encrypted ` +
        `(${resolvedEnv.undecrypted.join(", ")}) — DOTENV_PRIVATE_KEY_PRODUCTION is missing or wrong. ` +
        `Run \`hatchkit keys show ${manifest.name}\` to check, then re-run.`;
      errors.push(err);
      if (!opts.json) console.log(chalk.yellow(`\n  ${err}`));
    } else {
      // Baseline first so file values win: the at-rest store is the
      // source of truth, and these only fill gaps it doesn't cover.
      const baseline: Record<string, string> = { NODE_ENV: "production" };
      if (manifest.surfaces !== "static") {
        baseline.FRONTEND_URL = `https://${manifest.domain}`;
      }
      for (const routed of routing.apps) {
        const found = locations.get(routed.appName);
        if (!found) continue;
        const values: Record<string, string> = { ...baseline, ...resolvedEnv.values };
        // Each half binds its own port. Without this the client app
        // inherits the server's PORT and Traefik reaches nothing.
        if (routed.role !== "compose") values.PORT = routed.portsExposes;
        if (opts.dryRun) {
          if (!opts.json) {
            console.log(
              chalk.dim(
                `    · env → ${found.name}: would push ${Object.keys(values).length} var(s) from ${resolvedEnv.relPath}`,
              ),
            );
          }
          envPushed[found.name] = Object.keys(values).length;
          continue;
        }
        const spinner = opts.json ? null : ora(`Coolify: env → "${found.name}"`).start();
        try {
          await api.setAppEnv(found.uuid, values);
          envPushed[found.name] = Object.keys(values).length;
          // Names only. These are production secrets.
          spinner?.succeed(
            `Coolify: pushed ${Object.keys(values).length} env var(s) to "${found.name}"`,
          );
        } catch (err) {
          spinner?.fail(`Coolify: env push failed: ${(err as Error).message}`);
          errors.push(`env ${found.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  // ── Pass 4: DNS. `split` needs a second record for api.<domain>;
  //    without it the API host simply doesn't resolve, which is the
  //    state tracktime was left in.
  const dnsHostnames = [manifest.domain, ...routing.extraDnsHostnames];
  if (opts.dns !== false && locations.size > 0) {
    if (opts.dryRun) {
      if (!opts.json) {
        console.log(
          chalk.dim(`    · dns: would upsert A record(s) for ${dnsHostnames.join(", ")}`),
        );
      }
      dnsUpserted.push(...dnsHostnames);
    } else {
      try {
        const servers = await api.listServers();
        if (servers.length === 0) throw new Error("Coolify reports no servers.");
        const server = servers[0];
        const resolved = await api.findServer({ ip: server.ip });
        const ips = await discoverPublicIps(api, resolved?.uuid ?? "", server.ip);
        for (const host of dnsHostnames) {
          const res = await wireDns(host, ips);
          if (res.managed) dnsUpserted.push(host);
          else if (res.caveat) errors.push(`dns ${host}: ${res.caveat.reason}`);
        }
      } catch (err) {
        errors.push(`dns: ${(err as Error).message}`);
      }
    }
  }

  // ── Pass 5: GitHub Actions deploy secrets, paired under `split` so
  //    CI can trigger BOTH apps. See deploy/gh-actions-secrets.ts.
  if (opts.secrets !== false && locations.size > 0) {
    const deployApps: CoolifyDeployApp[] = routing.apps
      .map((routed) => {
        const found = locations.get(routed.appName);
        if (!found) return null;
        return {
          uuid: found.uuid,
          ...(routed.role === "compose" ? {} : { role: routed.role }),
        } as CoolifyDeployApp;
      })
      .filter((a): a is CoolifyDeployApp => a !== null);
    const slug = await detectRepoSlug(opts.projectDir);
    if (!slug) {
      if (!opts.json) {
        console.log(
          chalk.dim("    · secrets: no GitHub remote resolved — skipping Actions secret push."),
        );
      }
    } else if (opts.dryRun) {
      if (!opts.json) {
        console.log(
          chalk.dim(
            `    · secrets: would push deploy secrets for ${deployApps.length} app(s) to ${slug}`,
          ),
        );
      }
    } else if (deployApps.length > 0) {
      const res = await setCoolifyDeploySecrets({
        projectDir: opts.projectDir,
        repoSlug: slug,
        apps: deployApps,
      });
      secretsPushed = res.pushed;
      secretsRemoved = res.removed;
      if (!res.ok) errors.push(`secrets: push to ${slug} failed`);
    }
  }

  // Redeploy AFTER every PATCH has landed. Coolify only regenerates
  // Traefik labels on deploy, so a routing change that isn't followed
  // by one is invisible to the running containers.
  const deployed: string[] = [];
  if (opts.deploy && !opts.dryRun) {
    // Freshly created apps have never deployed at all, so they need a
    // trigger even though they were never "patched".
    const toDeploy = [
      ...patched,
      ...apps.filter((a) => created.includes(a.name) && !patched.includes(a)),
    ];
    for (const plan of toDeploy) {
      const spinner = opts.json ? null : ora(`Coolify: redeploying "${plan.name}"`).start();
      try {
        await api.deployApplication(plan.uuid);
        spinner?.succeed(`Coolify: redeploy triggered for "${plan.name}"`);
        deployed.push(plan.name);
      } catch (err) {
        spinner?.fail(`Coolify: redeploy failed: ${(err as Error).message}`);
        errors.push(`deploy ${plan.name}: ${(err as Error).message}`);
      }
    }
  } else if (patched.length > 0 && !opts.json) {
    console.log(
      chalk.yellow(
        "\n  Routing pushed, but the running containers still carry their old Traefik labels.\n" +
          "  Coolify only regenerates them on deploy — re-run with `--deploy`, or hit Redeploy in the dashboard.",
      ),
    );
  }

  const base = {
    topology: inference.topology,
    deployed,
    created,
    envPushed,
    dnsUpserted,
    secretsPushed,
    secretsRemoved,
    ...(legacyDomainHolder ? { legacyDomainHolder } : {}),
    topologySource: inference.source,
    topologyReason: inference.reason,
    composeServices: compose?.services ?? null,
    apps,
    dryRun: !!opts.dryRun,
  };

  if (apps.length === 0 && errors.length === 0 && wouldCreate.length > 0) {
    // A dry-run that planned creations isn't a failure — it is the plan
    // the user asked to see.
    if (!opts.json) {
      console.log(
        chalk.dim(
          `\n  --dry-run: no changes pushed. ${wouldCreate.length} app(s) would be created.`,
        ),
      );
    }
    return { ok: true, ...base };
  }

  if (apps.length === 0 && errors.length === 0) {
    const err = `No Coolify apps matched manifest project "${manifest.name}".`;
    if (!opts.json) {
      console.log(chalk.yellow(`\n  ${err}`));
      console.log(
        chalk.dim(
          `  Looked for: ${notFound.join(", ")}.\n` +
            "  Run `hatchkit adopt` to create them, or rename the existing app(s) to match.",
        ),
      );
    }
    return { ok: false, error: err, ...base };
  }

  if (!opts.json) {
    const blocked = apps.filter((a) => a.blocked);
    if (opts.dryRun) {
      console.log(chalk.dim("\n  --dry-run: no changes pushed."));
    } else if (blocked.length === 0) {
      const changed = apps.filter((a) => a.changed);
      if (changed.length === 0) {
        console.log(chalk.green("\n  ✓ Coolify already in sync with manifest."));
      } else {
        console.log(
          chalk.green(`\n  ✓ Synced ${changed.length} app(s) to manifest state.`) +
            chalk.dim(
              "\n  Trigger a redeploy in Coolify (or push a commit) for Traefik to pick up the new labels.",
            ),
        );
      }
    }
    if (errors.length > 0) {
      console.log(chalk.yellow("\n  Errors:"));
      for (const e of errors) console.log(chalk.yellow(`    · ${e}`));
    }
  }

  return {
    ok: errors.length === 0,
    ...base,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

function emptyResult(opts: SyncOptions): SyncResult {
  return {
    ok: false,
    topology: "single-origin",
    topologySource: "default",
    topologyReason: "sync aborted before topology resolution",
    composeServices: null,
    apps: [],
    deployed: [],
    created: [],
    envPushed: {},
    dnsUpserted: [],
    secretsPushed: [],
    secretsRemoved: [],
    dryRun: !!opts.dryRun,
  };
}

/** Resolve `<owner>/<repo>` from the project's `origin` remote. */
async function detectRepoSlug(projectDir: string): Promise<string | undefined> {
  const res = await exec("git", ["remote", "get-url", "origin"], {
    cwd: projectDir,
    silent: true,
  });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
}

/** Create the Coolify applications a routing plan needs but Coolify
 *  doesn't have.
 *
 *  Deliberately reuses `provisionRoutedApp` — the same helper `create`
 *  drives — rather than open-coding a fourth idea of how an application
 *  should be shaped. That helper is already find-or-create, so a race
 *  with a concurrent run (or an alias match sync's own lookup missed)
 *  resolves to the existing app instead of a duplicate.
 *
 *  The Coolify project and the server are resolved the same way
 *  `wireProjectIntoCoolify` resolves them: reuse a project of the same
 *  name, and take the first server unless the user has several. */
async function createMissingApps(args: {
  api: CoolifyApi;
  missing: RoutedApp[];
  projectName: string;
  description?: string;
  projectDir: string;
  json?: boolean;
}): Promise<Array<{ appName: string; uuid: string; name: string; created: boolean }>> {
  const { api, missing, projectName, projectDir } = args;

  const remote = await exec("git", ["remote", "get-url", "origin"], {
    cwd: projectDir,
    silent: true,
  });
  if (remote.exitCode !== 0) {
    throw new Error(
      "No `origin` git remote — Coolify needs a repo URL to create an application from. " +
        "Add a remote (or run `hatchkit adopt`) and re-run.",
    );
  }
  const repoUrl = remote.stdout.trim();
  const slug = repoSlugFromRemote(repoUrl);

  // Visibility decides which Coolify create endpoint applies: a private
  // repo needs the GitHub App source, a public one takes a plain HTTPS
  // URL. `gh` knows; assume public when it can't say, which fails loudly
  // at create time rather than silently wiring the wrong source.
  let isPrivate = false;
  if (slug) {
    const vis = await exec(
      "gh",
      ["repo", "view", slug, "--json", "isPrivate", "-q", ".isPrivate"],
      {
        cwd: projectDir,
        silent: true,
      },
    );
    if (vis.exitCode === 0) isPrivate = vis.stdout.trim() === "true";
  }

  const existingProject = await api.findProjectByName(projectName);
  const projectUuid =
    existingProject?.uuid ??
    (await api.createProject(projectName, args.description?.trim() || "Created by hatchkit sync"))
      .uuid;

  const servers = await api.listServers();
  if (servers.length === 0) {
    throw new Error("No Coolify servers configured. Add one in the Coolify dashboard first.");
  }
  const server = servers[0];
  if (servers.length > 1 && !args.json) {
    console.log(
      chalk.yellow(
        `  Multiple Coolify servers found — defaulting to "${server.name}" (${server.ip}).`,
      ),
    );
  }
  const resolvedServer = await api.findServer({ ip: server.ip });
  if (!resolvedServer) {
    throw new Error(`Couldn't resolve uuid for Coolify server "${server.name}" (${server.ip}).`);
  }

  let githubAppUuid: string | undefined;
  let githubAppHtmlUrl: string | undefined;
  if (isPrivate) {
    const sources = await api.listGithubSources();
    if (sources.length === 0) {
      throw new Error(
        "Repo is private but no Coolify GitHub source is configured. Install a GitHub App in " +
          "Coolify (Sources), then re-run `hatchkit sync`.",
      );
    }
    githubAppUuid = sources[0].uuid;
    githubAppHtmlUrl = sources[0].html_url;
  }

  const repoRef = normalizeCoolifyGitRepository(repoUrl, isPrivate);

  const out: Array<{ appName: string; uuid: string; name: string; created: boolean }> = [];
  for (const routed of missing) {
    const made = await provisionRoutedApp({
      api,
      routed,
      projectUuid,
      serverUuid: resolvedServer.uuid,
      description: args.description?.trim() || undefined,
      repoRef,
      isPrivateRepo: isPrivate,
      githubAppUuid,
      githubAppHtmlUrl,
    });
    out.push({ appName: routed.appName, uuid: made.uuid, name: made.name, created: made.created });
  }
  return out;
}

/** Find the Coolify app for one routing-plan entry. Tries hatchkit's
 *  canonical name first, then the accepted aliases — a hand-rolled
 *  `<name>-backend` / `<name>-frontend` pair (tiao's shape) is a real
 *  deployment sync should reconcile, not skip. */
async function locateApp(
  api: CoolifyApi,
  routed: RoutedApp,
  opts: SyncOptions,
): Promise<{ uuid: string; name: string } | null> {
  const candidates = [routed.appName, ...routed.aliases];
  const spinner = opts.json ? null : ora(`Coolify: locating "${routed.appName}"`).start();
  for (const name of candidates) {
    const found = await api.findApplicationByName(name);
    if (!found) continue;
    spinner?.succeed(
      name === routed.appName
        ? `Coolify: found "${name}" (${found.uuid})`
        : `Coolify: found "${name}" (${found.uuid}) — alias for "${routed.appName}"`,
    );
    return { uuid: found.uuid, name: found.name || name };
  }
  spinner?.warn(`Coolify: no app named ${candidates.map((c) => `"${c}"`).join(" or ")} — skipping`);
  return null;
}

// ---------------------------------------------------------------------------
// Plan computation
// ---------------------------------------------------------------------------

/** Read the compose file a routed app actually builds from.
 *
 *  Under `split` the two apps build from `/docker-compose.client.yml`
 *  and `/docker-compose.server.yml`, not the root file — pointing both
 *  at the root would run the whole stack twice. Validating service
 *  names against the root compose would therefore check the wrong file
 *  and could pass a name the app's own compose doesn't declare, which
 *  is the 200-OK-then-no-Traefik-labels outage this validation exists
 *  to prevent. Falls back to the root compose when the per-app file
 *  can't be read, since an unreadable compose is not evidence of a
 *  phantom service. */
function composeForApp(
  projectDir: string,
  routed: RoutedApp,
  rootCompose: ReturnType<typeof readComposeFile>,
): ReturnType<typeof readComposeFile> {
  const loc = routed.composeLocation?.replace(/^\//, "");
  if (!loc) return rootCompose;
  const path = join(projectDir, loc);
  if (!existsSync(path)) return rootCompose;
  try {
    const services = listComposeServices(readFileSync(path, "utf-8"));
    if (services.length === 0) return rootCompose;
    return { fileName: loc, path, services };
  } catch {
    return rootCompose;
  }
}

function buildPlan(
  routed: RoutedApp,
  current: CoolifyApplication,
  compose: ReturnType<typeof readComposeFile>,
): AppSyncPlan {
  const isCompose = current.buildPack === "dockercompose";
  // dockercompose apps use docker_compose_domains; everything else uses
  // the flat `domains` field. Coolify rejects a domain payload that
  // doesn't match the build pack with a 422.
  //
  // Collapse first: Coolify stores one entry per service, so comparing
  // an uncollapsed desired list against what Coolify reports would
  // always look "changed".
  const desiredDockerComposeDomains = isCompose
    ? collapseComposeDomains(routed.composeDomains)
    : undefined;
  const desiredDomains = isCompose ? undefined : routed.flatDomains;

  // Validate BEFORE anything else. A service name that isn't in the
  // compose is the one failure mode Coolify won't report: 200 OK, no
  // labels, total outage. Only meaningful for compose apps — a
  // dockerfile/static app has no services to name.
  let blocked: AppSyncPlan["blocked"];
  if (isCompose && compose) {
    const missing = routed.requiredComposeServices.filter((n) => !compose.services.includes(n));
    if (missing.length > 0) {
      blocked = {
        reason:
          `routing names compose service(s) ${missing.map((m) => `"${m}"`).join(", ")} ` +
          `that ${compose.fileName} does not declare`,
        missingServices: missing,
        declaredServices: compose.services,
        composeFile: compose.fileName,
        fix: [
          `Set "publicService" in .hatchkit.json to one of: ${compose.services.join(", ")}.`,
          `Or add the missing service(s) to ${compose.fileName} and redeploy.`,
          "Coolify would answer this PATCH with 200 OK and then emit no Traefik labels — every request would 503.",
        ],
      };
    }
  }

  const currentCollapsed = current.dockerComposeDomains
    ? collapseComposeDomains(current.dockerComposeDomains)
    : undefined;

  // `ports_exposes` is owned by Coolify on compose apps: it re-derives
  // the value from the compose file's exposed ports (the starter
  // declares none, so Coolify parks it at 80) and ignores whatever we
  // push. Diffing it there would make every project permanently
  // "out of sync" and every run a no-op PATCH, so only compare it on
  // build packs where the field is actually ours.
  const portsChanged =
    !isCompose &&
    current.portsExposes !== undefined &&
    current.portsExposes !== routed.portsExposes;
  const domainsChanged = isCompose
    ? !sameDockerComposeDomains(currentCollapsed, desiredDockerComposeDomains ?? [])
    : !sameStringList(splitFqdn(current.fqdn), desiredDomains ?? []);
  // `is_stripprefix_enabled` is write-only on Coolify 4.0.0-beta.469:
  // the application-settings relation isn't serialized on GET, so we
  // can never read back what it currently is. It therefore must NOT
  // drive `changed` — that would make every app look permanently out of
  // sync. It IS included in every PATCH we do make, so it converges
  // alongside any real routing change.
  const stripChanged =
    current.isStripprefixEnabled !== undefined &&
    current.isStripprefixEnabled !== routed.stripPrefix;

  return {
    uuid: current.uuid,
    name: current.name || routed.appName,
    role: routed.role,
    buildPack: current.buildPack,
    ...(desiredDockerComposeDomains ? { desiredDockerComposeDomains } : {}),
    ...(desiredDomains ? { desiredDomains } : {}),
    desiredPortsExposes: routed.portsExposes,
    desiredStripPrefix: routed.stripPrefix,
    current: {
      fqdn: current.fqdn,
      ...(currentCollapsed ? { dockerComposeDomains: currentCollapsed } : {}),
      ...(current.portsExposes !== undefined ? { portsExposes: current.portsExposes } : {}),
      ...(current.isStripprefixEnabled !== undefined
        ? { stripPrefix: current.isStripprefixEnabled }
        : {}),
    },
    changed: portsChanged || domainsChanged || stripChanged,
    ...(blocked ? { blocked } : {}),
  };
}

// ---------------------------------------------------------------------------
// Plan rendering
// ---------------------------------------------------------------------------

function renderPlan(plan: AppSyncPlan): void {
  console.log(
    chalk.bold(`\n  ${plan.name}`) + chalk.dim(` (${plan.uuid.slice(0, 8)}… · ${plan.role})`),
  );
  if (plan.buildPack) {
    console.log(chalk.dim(`    build pack: ${plan.buildPack}`));
  }

  if (plan.blocked) {
    console.log(chalk.red(`    ✗ REFUSING to sync — ${plan.blocked.reason}.`));
    console.log(
      chalk.dim(`        declared in ${plan.blocked.composeFile}: `) +
        chalk.dim(plan.blocked.declaredServices.join(", ")),
    );
    for (const line of plan.blocked.fix) console.log(chalk.yellow(`        ${line}`));
    return;
  }

  if (plan.desiredDockerComposeDomains) {
    const before = plan.current.dockerComposeDomains ?? [];
    const after = plan.desiredDockerComposeDomains;
    if (sameDockerComposeDomains(before, after)) {
      console.log(chalk.green("    ✓ docker_compose_domains: in sync"));
      console.log(chalk.dim(`        ${formatDockerComposeDomains(after)}`));
    } else {
      console.log(chalk.yellow("    · docker_compose_domains:"));
      console.log(chalk.dim(`        before: ${formatDockerComposeDomains(before)}`));
      console.log(chalk.dim(`        after:  ${formatDockerComposeDomains(after)}`));
    }
  } else if (plan.desiredDomains) {
    const before = splitFqdn(plan.current.fqdn);
    const after = plan.desiredDomains;
    if (sameStringList(before, after)) {
      console.log(chalk.green(`    ✓ domains: in sync (${after.join(", ")})`));
    } else {
      console.log(chalk.yellow("    · domains:"));
      console.log(chalk.dim(`        before: ${before.join(", ") || "(empty)"}`));
      console.log(chalk.dim(`        after:  ${after.join(", ")}`));
    }
  }

  if (plan.buildPack === "dockercompose") {
    console.log(
      chalk.dim(
        `    · ports_exposes: ${plan.current.portsExposes ?? "?"} (Coolify-owned on compose apps — not pushed)`,
      ),
    );
  } else if (plan.current.portsExposes === plan.desiredPortsExposes) {
    console.log(chalk.green(`    ✓ ports_exposes: ${plan.desiredPortsExposes}`));
  } else {
    console.log(chalk.yellow("    · ports_exposes:"));
    console.log(chalk.dim(`        before: ${plan.current.portsExposes ?? "(unset)"}`));
    console.log(chalk.dim(`        after:  ${plan.desiredPortsExposes}`));
  }

  if (plan.current.stripPrefix === undefined) {
    console.log(
      chalk.dim(
        `    · strip_prefix → ${plan.desiredStripPrefix} (write-only in Coolify's API; pushed with any update)`,
      ),
    );
    if (!plan.desiredStripPrefix) {
      console.log(
        chalk.dim(
          "        routing uses a path — with stripping ON Coolify delivers /api/health to Express as /health",
        ),
      );
    }
  } else if (plan.current.stripPrefix === plan.desiredStripPrefix) {
    console.log(chalk.green(`    ✓ strip_prefix: ${plan.desiredStripPrefix}`));
  } else {
    console.log(chalk.yellow("    · strip_prefix:"));
    console.log(chalk.dim(`        before: ${plan.current.stripPrefix}`));
    console.log(chalk.dim(`        after:  ${plan.desiredStripPrefix}`));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitFqdn(fqdn: string | null): string[] {
  if (!fqdn) return [];
  return fqdn
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function sameDockerComposeDomains(
  a: Array<{ name: string; domain: string }> | undefined,
  b: Array<{ name: string; domain: string }>,
): boolean {
  // Order-insensitive comparison, per service — Coolify doesn't promise
  // to round-trip the entry array in the order it was sent, and an
  // entry's domain may be a comma-joined list (primary + aliases) whose
  // internal order Coolify may also normalize. Both sides are collapsed
  // before this runs (one entry per service), so compare the
  // per-service URL sets.
  const left = a ?? [];
  if (left.length !== b.length) return false;
  const urlSet = (domain: string) => new Set(splitFqdn(domain));
  const setsByService = new Map(left.map((e) => [e.name, urlSet(e.domain)]));
  return b.every((e) => {
    const have = setsByService.get(e.name);
    if (!have) return false;
    const want = urlSet(e.domain);
    return have.size === want.size && [...want].every((d) => have.has(d));
  });
}

function formatDockerComposeDomains(entries: Array<{ name: string; domain: string }>): string {
  if (entries.length === 0) return "(empty)";
  return entries.map((e) => `${e.name}=${e.domain}`).join(", ");
}

// ---------------------------------------------------------------------------
// CLI glue — thin wrapper the dispatcher calls.
// ---------------------------------------------------------------------------

export async function runSyncCli(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const force = args.includes("--force");
  const deploy = args.includes("--deploy");
  // Every reconcile step is on by default — that is what makes this a
  // reconciler. The `--no-*` switches exist to narrow a run when only
  // one thing needs fixing, not because the defaults are risky.
  const create = !args.includes("--no-create");
  const env = !args.includes("--no-env");
  const dns = !args.includes("--no-dns");
  const secrets = !args.includes("--no-secrets");
  const dirArg = ((): string | undefined => {
    const i = args.findIndex((a) => a === "--dir");
    if (i >= 0 && args[i + 1]) return args[i + 1];
    return undefined;
  })();

  const projectDir = dirArg ? dirArg : process.cwd();
  const result = await runSync({
    projectDir,
    dryRun,
    json,
    force,
    deploy,
    create,
    env,
    dns,
    secrets,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) process.exit(1);
}
