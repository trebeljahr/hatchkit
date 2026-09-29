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
 *   5. origins     merge the native clients' origins into TRUSTED_ORIGINS
 *                  on the server app (deploy/trusted-origins.ts)
 *   6. dns         upsert an A record per hostname the topology needs
 *   7. secrets     push the paired GitHub Actions deploy secrets
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
 *   · connect_to_docker_network — must be true on a `dockercompose` app
 *     whose env names a Coolify-MANAGED database. The app is deployed
 *     onto a network called after its own uuid; the database sits on
 *     the shared `coolify` network; without the join the app cannot
 *     resolve the hostname Coolify itself wrote into the connection
 *     string, and crash-loops with ENOTFOUND while Coolify keeps
 *     reporting `running:healthy`. Also write-only, so it cannot drive
 *     `changed` by diffing either. It rides along on any PATCH sync is
 *     already making, and forces one of its own ONLY when the app shows
 *     crash restarts — the single piece of evidence the API does give
 *     us. deploy/coolify-db-network.ts has the failure in full.
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
import { hasNativeClient } from "../scaffold/native-origins.js";
import { listComposeServices, readComposeFile } from "../utils/compose.js";
import {
  CoolifyApi,
  type CoolifyApplication,
  describeCoolifyPatchLimit,
  parseRejectedFields,
} from "../utils/coolify-api.js";
import { discoverPublicIps } from "../utils/coolify-server-ips.js";
import { exec } from "../utils/exec.js";
import { normalizeCoolifyGitRepository, wireDns } from "./coolify-app.js";
import {
  type CoolifyDbReference,
  appShowsCrashSymptoms,
  connectToDockerNetworkRecipe,
  findCoolifyDbReferences,
  needsDockerNetwork,
} from "./coolify-db-network.js";
import { imageRefsForProject, provisionRoutedApp } from "./coolify.js";
import {
  type DeployedRefReport,
  checkDeployedRef,
  composePathAtRepoRoot,
  pinnedCommitOf,
  renderDeployedRef,
  summarizeDeployedRef,
} from "./deployed-ref.js";
import { resolveProductionEnv } from "./env-resolve.js";
import {
  type CoolifyDeployApp,
  repoSlugFromRemote,
  setCoolifyDeploySecrets,
} from "./gh-actions-secrets.js";
import {
  type HealthCheckSpec,
  healthCheckFor,
  healthCheckToConverge,
  resolveCoolifyRuntime,
} from "./image-runtime.js";
import {
  type RoutedApp,
  type Topology,
  collapseComposeDomains,
  computeRoutingPlan,
  inferTopology,
} from "./routing.js";
import {
  type NativeOriginsOutcome,
  TRUSTED_ORIGINS_KEY,
  mergePushedTrustedOrigins,
  pushNativeOriginsToServerApps,
  redeployNotice,
} from "./trusted-origins.js";

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
  /** Before creating, patching or deploying anything, verify that the
   *  commit Coolify will CLONE contains the compose file each app is
   *  configured to build from. Default ON and blocking, because an app
   *  whose `docker_compose_location` is absent at the deployed ref
   *  cannot deploy, and the error Coolify reports for it names a git
   *  authentication problem that does not exist (deploy/deployed-ref.ts
   *  has the full story). `--no-preflight` proceeds anyway. */
  preflight?: boolean;
  /** Merge the native clients' origins (mobile / desktop
   *  features) into TRUSTED_ORIGINS on the server app. Default ON; a
   *  no-op for projects without a native client. `--no-native-origins`
   *  skips it. */
  nativeOrigins?: boolean;
  /** Accept the TRUSTED_ORIGINS diff without a prompt. Without it the
   *  diff is confirmed interactively, and left unwritten when there is
   *  no terminal to ask on. */
  yes?: boolean;
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
  /** Desired `is_stripprefix_enabled`, or undefined when routing is
   *  all-`/` and hatchkit has no opinion — the field is then left out
   *  of the PATCH entirely. See {@link RoutedApp.stripPrefix}. */
  desiredStripPrefix?: boolean;
  /** Repo-relative build context root the manifest expects. Mirrors
   *  `manifest.projectSubdir`; `undefined` means "build from repo root"
   *  (the default). Sent to Coolify as `base_directory: <value>` —
   *  empty string resets back to `/`. */
  desiredBaseDirectory?: string;
  /** Push `connect_to_docker_network: true`? Set when this is a
   *  `dockercompose` app whose Coolify env points at a Coolify-managed
   *  database. Write-only in Coolify's API, so it is never diffed —
   *  see {@link dbNetworkRepair} for when it forces a PATCH. */
  desiredConnectToDockerNetwork?: boolean;
  /** Env var names on this app that point at a Coolify-managed database
   *  host, with the database each names. Values are never carried —
   *  they are connection strings with credentials in them. */
  coolifyDbReferences?: CoolifyDbReference[];
  /** True when this app both needs the network join AND is
   *  crash-restarting, i.e. we have evidence it is broken in exactly
   *  the way the missing setting breaks things. This is what makes the
   *  field drive `changed`: a write-only setting can't be diffed, so
   *  without an evidence gate sync would either PATCH every healthy app
   *  on every run or never repair a broken one. */
  dbNetworkRepair?: boolean;
  /** Health check to push on an image-runtime app whose check is off,
   *  or whose timing isn't hatchkit's. Off, Coolify's deploy removes the
   *  old container before the new one can serve; with pre-drain timing
   *  the old container is still routed when it exits — see
   *  deploy/image-runtime.ts. A path somebody chose is left alone. */
  desiredHealthCheck?: HealthCheckSpec;
  /** Snapshot of the same fields as Coolify currently reports them. */
  current: {
    /** Whether Coolify runs a health check on this app. */
    healthCheckEnabled?: boolean;
    /** Its probe spacing and failure count, when Coolify returned them. */
    healthCheckIntervalSeconds?: number;
    healthCheckRetries?: number;
    fqdn: string | null;
    dockerComposeDomains?: Array<{ name: string; domain: string }>;
    portsExposes?: string;
    stripPrefix?: boolean;
    /** Coolify's reported `base_directory`. Leading-slash form
     *  (`"/site"`) or `"/"` for repo root. */
    baseDirectory?: string;
    /** Coolify's status string. Read it with suspicion — it says
     *  `running:healthy` for a container that is crash-looping. */
    status?: string;
    /** Restart count and reason. The only signal in the API record
     *  that separates a healthy app from a crash loop. */
    restartCount?: number;
    lastRestartType?: string;
  };
  /** Whether a PATCH is needed to converge — false means everything
   *  already matches, sync skips the API call. */
  changed: boolean;
  /** Coolify-API fields this build refused, which sync dropped so the
   *  rest of the PATCH could land. Present only when something was
   *  actually dropped; the run still counts as a success, because every
   *  droppable field is one hatchkit can live without. */
  droppedFields?: string[];
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
  /** Env names still holding a scaffold placeholder value. */
  envPlaceholders: string[];
  /** Hostnames whose DNS records were upserted. */
  dnsUpserted: string[];
  /** GitHub Actions secret names pushed, and stale ones removed. */
  secretsPushed: string[];
  secretsRemoved: string[];
  /** Set when a pre-split app still claims the bare domain, which would
   *  make Coolify reject the new client half's domain. */
  legacyDomainHolder?: string;
  /** Deploy-ref preflight: one entry per distinct ref the apps deploy
   *  from (normally one). Empty under `--no-preflight`. */
  deployedRef: DeployedRefReport[];
  /** Apps whose routing PATCH failed. Non-empty means those apps still
   *  carry their previous domains — none, for an app this run created —
   *  no matter what the rest of the passes reported. */
  routingFailed: string[];
  /** TRUSTED_ORIGINS outcome per server app. Empty when the project has
   *  no native client or `--no-native-origins` was given. */
  nativeOrigins: NativeOriginsOutcome[];
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
  const runtime = resolveCoolifyRuntime(manifest.coolifyRuntime);
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
    runtime,
    ...(runtime === "image"
      ? {
          images: imageRefsForProject({
            projectDir: opts.projectDir,
            repoSlug: await detectRepoSlug(opts.projectDir),
          }),
          ...(manifest.containerPorts ? { containerPorts: manifest.containerPorts } : {}),
        }
      : {}),
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
  /** Apps whose routing PATCH threw. Kept apart from the flat `errors`
   *  list so the final summary can say "these apps have no domain"
   *  instead of printing a success headline above an error block. */
  const routingFailed: string[] = [];
  const errors: string[] = [];
  const notFound: string[] = [];
  const created: string[] = [];
  const wouldCreate: string[] = [];
  const envPushed: Record<string, number> = {};
  let envPlaceholders: string[] = [];
  const dnsUpserted: string[] = [];
  let secretsPushed: string[] = [];
  let secretsRemoved: string[] = [];
  let nativeOrigins: NativeOriginsOutcome[] = [];

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

  // ── Preflight: is each app's compose file actually IN the commit
  //    Coolify will clone?
  //
  // Placed after locate (so it can read each existing app's real
  // branch, pinned commit and compose location instead of assuming the
  // manifest's) and before create / patch / deploy, because all three
  // are wasted against a ref that cannot build — and `--deploy` would
  // queue a deploy already known to fail. deploy/deployed-ref.ts has
  // the failure this prevents, and why its Coolify error message sends
  // you looking at credentials that are fine.
  const deployedRef: DeployedRefReport[] = [];
  if (opts.preflight !== false) {
    deployedRef.push(
      ...(await preflightDeployedRefs({
        api,
        routed: routing.apps,
        locations,
        projectDir: opts.projectDir,
        projectSubdir: manifest.projectSubdir || undefined,
      })),
    );
    if (!opts.json) renderDeployedRefReports(deployedRef);
    const blocked = deployedRef.filter((r) => r.blocking);
    for (const r of blocked) errors.push(`preflight: ${summarizeDeployedRef(r)}`);
    // A dry run reports and carries on — it changes nothing, and the
    // rest of the plan is still what the user asked to see. A real run
    // stops here, since creating an application pointed at a path the
    // deployed ref doesn't have is precisely how this failure gets
    // built.
    if (blocked.length > 0 && !opts.dryRun) {
      if (!opts.json) {
        console.log(
          chalk.dim(
            "\n  Nothing was changed. Fix the ref above, or re-run with `--no-preflight` to sync anyway.",
          ),
        );
      }
      return {
        ...emptyResult(opts),
        topology: inference.topology,
        topologySource: inference.source,
        topologyReason: inference.reason,
        composeServices: compose?.services ?? null,
        deployedRef,
        error: errors.join("; "),
      };
    }
  }

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
        // Which advice is true depends on whether the clashing half
        // still has to be CREATED. Coolify honours
        // `force_domain_override` on the routing PATCH, but strips it
        // before the conflict check on a `dockercompose` create — so
        // telling someone to `--force` past a create-time 409 sends
        // them round the same loop with the same error. Say the one
        // thing that actually clears it: free the domain first.
        if (missing.length > 0) {
          console.log(
            chalk.dim(
              "    The apps that would carry this domain don't exist yet, and Coolify refuses to\n" +
                "    CREATE a resource on a claimed domain. `--force` cannot help here — it is\n" +
                "    honoured on the routing update, not on creation.\n" +
                `    Free the domain on "${manifest.name}" first: Coolify dashboard -> that app ->\n` +
                "    Configuration -> Domains, clear the domain(s), Save. Then stop or delete the\n" +
                "    app and re-run `hatchkit sync`.",
            ),
          );
        } else {
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
          force: opts.force,
        });
        for (const made of madeApps) {
          locations.set(made.appName, { uuid: made.uuid, name: made.name });
          if (made.created) created.push(made.name);
        }
      } catch (err) {
        const message = (err as Error).message;
        // Coolify's own 409 text says "Use force_domain_override=true
        // to proceed". On a create it is wrong: hatchkit already sends
        // that flag, and Coolify unsets it before the compose-domain
        // conflict check reads it. Don't relay advice we've verified
        // is a dead end.
        if (/409|conflict/i.test(message) && !opts.json) {
          console.log(
            chalk.dim(
              "    Coolify refused to create the app because another resource already claims the\n" +
                "    domain. This is not something `--force` can push through: the override is\n" +
                "    honoured when UPDATING an app's routing, but not when creating one.\n" +
                "    Free the domain on the resource holding it (Coolify dashboard -> that app ->\n" +
                "    Configuration -> Domains, clear it, Save), then re-run `hatchkit sync`.",
            ),
          );
        }
        errors.push(`create: ${message}`);
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

    // Read the app's Coolify env and the managed-database list so the
    // plan knows whether this app has to be joined to the shared
    // `coolify` network. Best-effort by construction — the helper
    // swallows API failures and returns [] — because a project that
    // uses no managed database must not have its routing sync blocked
    // by an env read it never needed.
    const dbReferences = await findCoolifyDbReferences(api, found.uuid);

    const plan = buildPlan(
      routed,
      current,
      composeForApp(opts.projectDir, routed, compose),
      manifest.projectSubdir || undefined,
      dbReferences,
    );
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
      const result = await api.updateApplication(plan.uuid, {
        // Skipped for compose apps — Coolify re-derives it from the
        // compose file and our value would be discarded anyway — and for
        // image apps, whose port is the container's own (see buildPlan).
        ...(plan.buildPack === "dockercompose" || plan.buildPack === "dockerimage"
          ? {}
          : { portsExposes: plan.desiredPortsExposes }),
        ...(plan.desiredHealthCheck ? { healthCheck: plan.desiredHealthCheck } : {}),
        ...(plan.desiredStripPrefix !== undefined
          ? { isStripprefixEnabled: plan.desiredStripPrefix }
          : {}),
        // Rides along on every PATCH for an app that needs it, and is
        // the reason for the PATCH when `dbNetworkRepair` forced one.
        // Never diffed: Coolify does not return the field on GET.
        ...(plan.desiredConnectToDockerNetwork
          ? { connectToDockerNetwork: plan.desiredConnectToDockerNetwork }
          : {}),
        // Push the manifest's `projectSubdir` onto Coolify's
        // `base_directory`. Empty string resets to repo root — the
        // case where a manifest drops `projectSubdir` after an earlier
        // adopt set one. Coolify's API treats `""` and `"/"` as
        // equivalent (both mean repo root).
        ...(plan.buildPack === "dockerimage"
          ? {}
          : { baseDirectory: plan.desiredBaseDirectory ?? "" }),
        ...(plan.desiredDockerComposeDomains
          ? { dockerComposeDomains: plan.desiredDockerComposeDomains }
          : {}),
        ...(plan.desiredDomains ? { domains: plan.desiredDomains } : {}),
        ...(opts.force ? { forceDomainOverride: true } : {}),
      });
      patch.succeed(`Coolify: updated "${plan.name}"`);
      // A field this Coolify build refuses is dropped so the domains
      // still land, but it is never silent: the user has to know the
      // setting didn't take, and what to do instead.
      if (result.droppedFields.length > 0) {
        plan.droppedFields = result.droppedFields;
        if (!opts.json) {
          for (const field of result.droppedFields) {
            console.log(
              chalk.yellow(`    · Coolify rejected \`${field}\` — pushed the rest without it.`),
            );
            const limit = describeCoolifyPatchLimit(field);
            if (limit) console.log(chalk.dim(`        ${limit}`));
          }
        }
      }
      patched.push(plan);
    } catch (err) {
      const message = (err as Error).message;
      patch.fail(`Coolify: PATCH failed: ${message}`);
      routingFailed.push(plan.name);
      // When this PATCH existed to repair the database network, saying
      // "routing failed" alone buries the thing the user came for. The
      // app is still crash-looping, and Coolify will still call it
      // healthy, so hand over the standalone repair.
      if (plan.dbNetworkRepair && !opts.json) {
        console.log(
          chalk.yellow(
            `    "${plan.name}" is still not on its database's network — it will keep crash-looping.`,
          ),
        );
        for (const line of connectToDockerNetworkRecipe(cfg.url, plan.uuid)) {
          console.log(chalk.dim(`      ${line}`));
        }
      }
      if (/409|conflict|already/i.test(message)) {
        console.log(
          chalk.dim(
            "    Coolify reports this domain as claimed by another resource. Re-run with `--force`\n" +
              "    once you've confirmed the other resource is a stale app for this same project.",
          ),
        );
      }
      // A rejected field hatchkit already understands reads as a known
      // API limit with a way forward, not as a raw validation error.
      // The compose-domains case is the one that matters most: an app
      // that has never deployed CANNOT be given a domain over the API,
      // and no amount of re-running sync will change that.
      const explained = parseRejectedFields(message)
        .map((field) => [field, describeCoolifyPatchLimit(field)] as const)
        .filter((pair): pair is readonly [string, string] => pair[1] !== undefined);
      for (const [field, limit] of explained) {
        if (!opts.json) console.log(chalk.yellow(`    ${field}: ${limit}`));
      }
      const suffix = explained.length > 0 ? ` — ${explained.map(([, l]) => l).join(" ")}` : "";
      errors.push(
        `PATCH ${plan.name}: ${message}${suffix}\n` +
          `      → "${plan.name}" still has the routing it had before this run.`,
      );
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
      // Placeholders are pushed, not blocked — several are optional and
      // a project can legitimately ship without them — but they are
      // called out, because a `CHANGE_ME…` in Coolify is a value-shaped
      // string that silently misconfigures the app.
      if (resolvedEnv.placeholders.length > 0 && !opts.json) {
        console.log(
          chalk.yellow(
            `\n  ${resolvedEnv.placeholders.length} value(s) in ${resolvedEnv.relPath} are still scaffold placeholders:`,
          ),
        );
        console.log(chalk.dim(`    ${resolvedEnv.placeholders.join(", ")}`));
        console.log(
          chalk.dim(
            "    The provision step that fills these never ran. Set them (`hatchkit add <project> …`,\n" +
              "    or `dotenvx set <KEY> <value> -f .env.production --encrypt`) before relying on them.",
          ),
        );
      }
      envPlaceholders = resolvedEnv.placeholders;
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
        // TRUSTED_ORIGINS is a list the dashboard adds to by hand (a
        // pinned browser-extension id, say). Pushing the file's value
        // verbatim would silently drop those, so merge it into the live
        // one instead: live entries keep their order, the file's missing
        // ones are appended, nothing is removed.
        if (TRUSTED_ORIGINS_KEY in values && !opts.dryRun) {
          try {
            const merged = await mergePushedTrustedOrigins(
              api,
              found.uuid,
              values[TRUSTED_ORIGINS_KEY],
            );
            if (merged === null) {
              delete values[TRUSTED_ORIGINS_KEY];
              if (!opts.json) {
                console.log(
                  chalk.yellow(
                    `    · env → ${found.name}: ${TRUSTED_ORIGINS_KEY} not pushed — this token can't read the live value to merge into.`,
                  ),
                );
              }
            } else {
              values[TRUSTED_ORIGINS_KEY] = merged;
            }
          } catch (err) {
            delete values[TRUSTED_ORIGINS_KEY];
            errors.push(
              `env ${found.name}: couldn't read live ${TRUSTED_ORIGINS_KEY} to merge — not pushed: ${(err as Error).message}`,
            );
          }
        }
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

  // ── Pass 4: native-client origins. A Capacitor / Electron
  //    shell loads the client from its own document origin, and
  //    better-auth answers 403 INVALID_ORIGIN for any origin not in
  //    TRUSTED_ORIGINS. Runs after the env pass so it merges into what
  //    that pass just wrote. Server app only, chosen by routing role.
  if (opts.nativeOrigins !== false && hasNativeClient(manifest.features)) {
    const serverCandidates = routing.apps
      .map((routed) => {
        const found = locations.get(routed.appName);
        return found
          ? { ...found, role: routed.role, created: created.includes(found.name) }
          : null;
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
    nativeOrigins = await pushNativeOriginsToServerApps({
      api,
      apps: serverCandidates,
      features: manifest.features,
      surfaces: manifest.surfaces,
      dryRun: opts.dryRun,
      yes: opts.yes,
      json: opts.json,
      // `--deploy` redeploys the changed server below; otherwise say so.
      printRedeployNotice: !opts.deploy,
    });
    for (const o of nativeOrigins) {
      if (o.status === "failed" || o.status === "unreadable") {
        errors.push(`${TRUSTED_ORIGINS_KEY} ${o.app}: ${o.detail ?? o.status}`);
      } else if (o.status === "needs-confirmation") {
        // Unattended run, nothing written. A script must not read this
        // as a converged project: native sign-in is still broken.
        errors.push(
          `${TRUSTED_ORIGINS_KEY} ${o.app}: missing ${o.added.join(", ")} — not written without confirmation; re-run with --yes to accept the diff`,
        );
      }
    }
  }

  // ── Pass 5: DNS. `split` needs a second record for api.<domain>;
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

  // ── Pass 6: GitHub Actions deploy secrets, paired under `split` so
  //    CI can trigger BOTH apps. See deploy/gh-actions-secrets.ts.
  if (opts.secrets !== false && locations.size > 0) {
    const deployApps: CoolifyDeployApp[] = routing.apps
      .map((routed) => {
        const found = locations.get(routed.appName);
        if (!found) return null;
        return {
          uuid: found.uuid,
          // The one app of a single-app deployment (compose or image)
          // carries no role in the secret names.
          ...(routed.role === "compose" || routed.role === "app" ? {} : { role: routed.role }),
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
    // A server whose TRUSTED_ORIGINS just changed still holds the list
    // it read at boot; only a redeploy makes the new one live.
    for (const o of nativeOrigins) {
      if (o.status !== "updated" || !o.needsRedeploy) continue;
      if (toDeploy.some((p) => p.uuid === o.uuid)) continue;
      const plan = apps.find((a) => a.uuid === o.uuid);
      if (plan) toDeploy.push(plan);
    }
    // What the deploy will actually build. Printed with the trigger
    // rather than left to be inferred, because the single most
    // expensive mistake around a Coolify deploy is assuming it ships
    // the working tree.
    const clonedCommit = describeClonedCommit(deployedRef);
    for (const plan of toDeploy) {
      const spinner = opts.json ? null : ora(`Coolify: redeploying "${plan.name}"`).start();
      try {
        const { deploymentUuid } = await api.deployApplication(plan.uuid);
        spinner?.succeed(
          `Coolify: redeploy triggered for "${plan.name}"` +
            (deploymentUuid ? ` (deployment ${deploymentUuid})` : ""),
        );
        if (clonedCommit && !opts.json) console.log(chalk.dim(`        building ${clonedCommit}`));
        deployed.push(plan.name);
      } catch (err) {
        spinner?.fail(`Coolify: redeploy failed: ${(err as Error).message}`);
        if (clonedCommit && !opts.json) {
          console.log(chalk.dim(`        the deploy would have built ${clonedCommit}`));
        }
        errors.push(`deploy ${plan.name}: ${(err as Error).message}`);
      }
    }
    // A changed server this run couldn't redeploy (its app record was
    // unreadable, or the trigger failed) still runs the old list.
    const deployedUuids = new Set(
      toDeploy.filter((p) => deployed.includes(p.name)).map((p) => p.uuid),
    );
    const stillStale = nativeOrigins.filter((o) => !deployedUuids.has(o.uuid));
    if (!opts.json) for (const line of redeployNotice(stillStale)) console.log(chalk.yellow(line));
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
    envPlaceholders,
    dnsUpserted,
    secretsPushed,
    secretsRemoved,
    deployedRef,
    ...(legacyDomainHolder ? { legacyDomainHolder } : {}),
    topologySource: inference.source,
    topologyReason: inference.reason,
    composeServices: compose?.services ?? null,
    apps,
    routingFailed,
    nativeOrigins,
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
    } else if (routingFailed.length > 0) {
      // The headline must never contradict the error block under it.
      // A routing PATCH that threw means that app kept whatever domains
      // it already had — which, for an app created by this same run, is
      // none at all. Saying "✓ Synced 2 app(s)" over that is how a
      // fully-undomained deployment got read as a success.
      const wanted = apps.filter((a) => a.changed && !a.blocked).length;
      console.log(
        chalk.red(
          `\n  ✗ Routing NOT synced for ${routingFailed.length} of ${wanted} app(s): ` +
            `${routingFailed.join(", ")}.`,
        ),
      );
      const freshlyCreated = routingFailed.filter((n) => created.includes(n));
      console.log(
        chalk.yellow(
          "  They keep whatever routing they already had. See Errors below for why each failed.",
        ),
      );
      if (freshlyCreated.length > 0) {
        console.log(
          chalk.yellow(
            `  ${freshlyCreated.join(", ")} — created by this run, so "whatever they had" is NO domain.\n` +
              "  Those apps will not answer on their domain at all until a routing sync succeeds.",
          ),
        );
      }
      if (patched.length > 0) {
        console.log(chalk.dim(`  ${patched.length} other app(s) did sync: ${names(patched)}.`));
      }
    } else if (blocked.length === 0) {
      // Count what actually landed, not what was planned.
      if (patched.length === 0) {
        console.log(chalk.green("\n  ✓ Coolify already in sync with manifest."));
      } else {
        console.log(
          chalk.green(`\n  ✓ Synced ${patched.length} app(s) to manifest state.`) +
            chalk.dim(
              "\n  Trigger a redeploy in Coolify (or push a commit) for Traefik to pick up the new labels.",
            ),
        );
      }
    }
    // An "in sync" headline above must not read as "native sign-in works"
    // when the origins it needs were left unwritten.
    const pendingOrigins = nativeOrigins.filter(
      (o) => o.status === "declined" || o.status === "needs-confirmation",
    );
    if (pendingOrigins.length > 0 && !opts.dryRun) {
      console.log(
        chalk.yellow(
          `\n  ⚠ ${TRUSTED_ORIGINS_KEY} NOT updated on ${pendingOrigins.map((o) => `"${o.app}"`).join(", ")} — ` +
            "native clients still get 403 INVALID_ORIGIN on sign-in.",
        ),
      );
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
    routingFailed: [],
    nativeOrigins: [],
    deployed: [],
    created: [],
    envPushed: {},
    envPlaceholders: [],
    dnsUpserted: [],
    secretsPushed: [],
    secretsRemoved: [],
    deployedRef: [],
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
  /** `--force`: take a domain Coolify reports as claimed. Threaded
   *  into the create body for contract correctness, but Coolify strips
   *  `force_domain_override` before the `dockercompose` create checks
   *  for conflicts, so this does NOT currently unblock a create-time
   *  409 — the caller's error path says so rather than looping the
   *  user through the flag again. */
  force?: boolean;
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
      forceDomainOverride: args.force,
    });
    out.push({ appName: routed.appName, uuid: made.uuid, name: made.name, created: made.created });
  }
  return out;
}

/** Run the deploy-ref preflight for a whole routing plan.
 *
 *  Reads the LIVE branch / pinned commit / compose location off every
 *  app Coolify already has, and falls back to what the manifest and
 *  routing plan imply for the ones this run would create. A hand-edited
 *  app in the dashboard is exactly the case where those two disagree,
 *  and the live value is the one that will be cloned.
 *
 *  Apps are grouped by the ref they deploy from, so the normal case
 *  (both halves of a `split` on `origin/main`) is one fetch and one
 *  report rather than two of each.
 *
 *  Never throws: a Coolify read that fails degrades to the manifest's
 *  assumption, and a git repo that can't answer produces a skipped
 *  report. A preflight is not worth failing a sync over — only what it
 *  positively finds is. */
async function preflightDeployedRefs(args: {
  api: CoolifyApi;
  routed: RoutedApp[];
  locations: Map<string, { uuid: string; name: string }>;
  projectDir: string;
  projectSubdir?: string;
}): Promise<DeployedRefReport[]> {
  const groups = new Map<
    string,
    { branch: string; pinnedCommit?: string; paths: Array<{ appName: string; path: string }> }
  >();

  for (const routed of args.routed) {
    const found = args.locations.get(routed.appName);
    let branch = DEFAULT_DEPLOY_BRANCH;
    let pinnedCommit: string | undefined;
    let composeLocation = routed.composeLocation;
    let subdir = args.projectSubdir;
    let appName = routed.appName;

    if (found) {
      appName = found.name;
      try {
        const live = await args.api.getApplication(found.uuid);
        // A non-compose build pack has no compose file to look for —
        // an adopted nixpacks/static app is a real deployment, just not
        // one this check has anything to say about.
        if (live.buildPack && live.buildPack !== "dockercompose") continue;
        branch = live.gitBranch?.trim() || branch;
        pinnedCommit = pinnedCommitOf(live.gitCommitSha);
        if (live.dockerComposeLocation) composeLocation = live.dockerComposeLocation;
        const liveBase = live.baseDirectory?.trim();
        if (liveBase) subdir = liveBase === "/" ? undefined : liveBase.replace(/^\/+/, "");
      } catch {
        // Couldn't read it — check against what the manifest implies.
        // A preflight built on the manifest is still worth far more
        // than no preflight.
      }
    }

    const key = `${branch}\u0000${pinnedCommit ?? ""}`;
    const group = groups.get(key) ?? {
      branch,
      ...(pinnedCommit ? { pinnedCommit } : {}),
      paths: [],
    };
    group.paths.push({ appName, path: composePathAtRepoRoot(composeLocation, subdir) });
    groups.set(key, group);
  }

  const reports: DeployedRefReport[] = [];
  for (const group of groups.values()) {
    reports.push(
      await checkDeployedRef({
        projectDir: args.projectDir,
        paths: group.paths,
        branch: group.branch,
        ...(group.pinnedCommit ? { pinnedCommit: group.pinnedCommit } : {}),
      }),
    );
  }
  return reports;
}

/** Branch every hatchkit-created Coolify application is configured
 *  with (see `provisionRoutedApp`). Used only as the fallback for an
 *  app that doesn't exist yet — an existing one is asked. */
const DEFAULT_DEPLOY_BRANCH = "main";

function renderDeployedRefReports(reports: DeployedRefReport[]): void {
  for (const report of reports) {
    if (!report.ran) {
      console.log(chalk.dim(`\n  Deploy preflight skipped — ${report.skipped}`));
      continue;
    }
    const lines = renderDeployedRef(report);
    const [head, ...rest] = lines;
    const paint = report.blocking ? chalk.red : report.ahead ? chalk.yellow : chalk.green;
    const mark = report.blocking ? "✗" : report.ahead ? "·" : "✓";
    console.log(paint(`\n  ${mark} Coolify deploys ${report.ref} — ${head}`));
    for (const line of rest) {
      console.log(report.blocking ? chalk.yellow(`      ${line}`) : chalk.dim(`      ${line}`));
    }
  }
}

/** One-line "what will this deploy build", or undefined when the
 *  preflight didn't run. */
function describeClonedCommit(reports: DeployedRefReport[]): string | undefined {
  const usable = reports.find((r) => r.ran && r.refSha);
  if (!usable?.refSha) return undefined;
  return `${usable.ref} @ ${usable.refSha.slice(0, 7)} "${usable.refSubject ?? "?"}"`;
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
  desiredBaseDirectory: string | undefined,
  /** Env vars on this app that name a Coolify-managed database host,
   *  read from Coolify before the plan is built (the lookup is async;
   *  everything else here is pure). Empty for apps that don't use one. */
  coolifyDbReferences: CoolifyDbReference[] = [],
): AppSyncPlan {
  const isCompose = current.buildPack === "dockercompose";
  // An image app has no git checkout, so `base_directory` means nothing
  // to it, and its `ports_exposes` is the port its container really
  // binds — set when the app was created (by `create` or
  // `migrate-runtime`, which read it off the image) and not something a
  // manifest default should overwrite.
  const isImage = current.buildPack === "dockerimage";
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
    !isImage &&
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
    routed.stripPrefix !== undefined &&
    current.isStripprefixEnabled !== undefined &&
    current.isStripprefixEnabled !== routed.stripPrefix;

  // `base_directory` diff. Coolify normalizes the field to a
  // leading-slash path (`"/site"`), so compare against the same shape
  // built from `desiredBaseDirectory` (`"/"` for the unset case).
  const desiredBaseDirCanonical = desiredBaseDirectory ? `/${desiredBaseDirectory}` : "/";
  const currentBaseDirCanonical = current.baseDirectory?.trim() || "/";
  const baseDirectoryChanged = !isImage && desiredBaseDirCanonical !== currentBaseDirCanonical;

  // A dockerimage app with its health check off gets no zero-downtime
  // deploy (Coolify stops the old container as soon as the new one
  // starts), and one with pre-drain timing ends every deploy in 502s
  // (its old container is still routed when docker stop ends it).
  // Turning the check on and converging its timing are the health-check
  // changes sync makes; the path stays whatever it is.
  const desiredHealthCheck = isImage
    ? healthCheckToConverge(
        current.healthCheck,
        routed.healthCheck ??
          healthCheckFor(
            routed.role === "server" ? "server" : routed.role === "client" ? "client" : "app",
          ),
      )
    : undefined;

  // `connect_to_docker_network`. Also write-only, so like strip_prefix
  // it cannot be diffed — but unlike strip_prefix, getting it wrong is
  // a total outage disguised as a healthy app, so it needs a way to
  // force a PATCH of its own rather than only riding along on one.
  //
  // The gate is EVIDENCE, not desire: crash restarts on an app that
  // uses a managed database. Forcing the PATCH whenever the app merely
  // uses a database would make every such project permanently
  // "out of sync" and every sync run a no-op write; never forcing it
  // would leave every app broken before this change unrepairable by
  // sync, which is the case this exists for.
  const wantsDbNetwork = needsDockerNetwork(current, coolifyDbReferences);
  const dbNetworkRepair = wantsDbNetwork && appShowsCrashSymptoms(current);

  return {
    uuid: current.uuid,
    name: current.name || routed.appName,
    role: routed.role,
    buildPack: current.buildPack,
    ...(desiredDockerComposeDomains ? { desiredDockerComposeDomains } : {}),
    ...(desiredDomains ? { desiredDomains } : {}),
    desiredPortsExposes: routed.portsExposes,
    ...(routed.stripPrefix !== undefined ? { desiredStripPrefix: routed.stripPrefix } : {}),
    ...(desiredBaseDirectory ? { desiredBaseDirectory } : {}),
    ...(desiredHealthCheck ? { desiredHealthCheck } : {}),
    current: {
      ...(current.healthCheck.enabled !== undefined
        ? { healthCheckEnabled: current.healthCheck.enabled }
        : {}),
      ...(current.healthCheck.intervalSeconds !== undefined
        ? { healthCheckIntervalSeconds: current.healthCheck.intervalSeconds }
        : {}),
      ...(current.healthCheck.retries !== undefined
        ? { healthCheckRetries: current.healthCheck.retries }
        : {}),
      fqdn: current.fqdn,
      ...(currentCollapsed ? { dockerComposeDomains: currentCollapsed } : {}),
      ...(current.portsExposes !== undefined ? { portsExposes: current.portsExposes } : {}),
      ...(current.isStripprefixEnabled !== undefined
        ? { stripPrefix: current.isStripprefixEnabled }
        : {}),
      ...(current.baseDirectory !== undefined ? { baseDirectory: current.baseDirectory } : {}),
      ...(current.status !== undefined ? { status: current.status } : {}),
      ...(current.restartCount !== undefined ? { restartCount: current.restartCount } : {}),
      ...(current.lastRestartType !== undefined
        ? { lastRestartType: current.lastRestartType }
        : {}),
    },
    ...(wantsDbNetwork ? { desiredConnectToDockerNetwork: true } : {}),
    ...(coolifyDbReferences.length > 0 ? { coolifyDbReferences } : {}),
    ...(dbNetworkRepair ? { dbNetworkRepair: true } : {}),
    changed:
      portsChanged ||
      domainsChanged ||
      stripChanged ||
      baseDirectoryChanged ||
      dbNetworkRepair ||
      desiredHealthCheck !== undefined,
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
  if (plan.buildPack === "dockercompose") {
    console.log(
      chalk.yellow(
        "    ! Docker Compose app: every deploy stops the site until the new container is up.\n" +
          "      Zero-downtime move: hatchkit migrate-runtime --dry-run",
      ),
    );
  }
  if (plan.desiredHealthCheck && plan.current.healthCheckEnabled !== true) {
    console.log(
      `    health check: ${chalk.red("off")} → ${chalk.green(`GET ${plan.desiredHealthCheck.path}`)}` +
        chalk.dim(" (needed for rolling deploys)"),
    );
  } else if (plan.desiredHealthCheck) {
    const { intervalSeconds, retries } = plan.desiredHealthCheck;
    const was =
      plan.current.healthCheckIntervalSeconds !== undefined &&
      plan.current.healthCheckRetries !== undefined
        ? `every ${plan.current.healthCheckIntervalSeconds}s × ${plan.current.healthCheckRetries}`
        : "custom timing";
    console.log(
      `    health check: ${chalk.red(was)} → ${chalk.green(`every ${intervalSeconds}s × ${retries}`)}` +
        chalk.dim(" (lets a stopping container leave Traefik before it exits)"),
    );
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

  if (plan.desiredStripPrefix === undefined) {
    // Nothing to say: every route sits at `/`, so Coolify attaches no
    // stripprefix middleware and the setting cannot affect anything.
    // Printing "strip_prefix → true" here was worse than silence — it
    // advertised a field sync was about to push and Coolify was about
    // to reject, taking the domains with it.
    console.log(
      chalk.dim("    · strip_prefix: not applicable (no path-scoped route) — not pushed"),
    );
  } else if (plan.current.stripPrefix === undefined) {
    console.log(
      chalk.dim(
        `    · strip_prefix → ${plan.desiredStripPrefix} (write-only in Coolify's API; pushed with this update)`,
      ),
    );
    console.log(
      chalk.dim(
        "        routing uses a path — with stripping ON Coolify delivers /api/health to Express as /health",
      ),
    );
  } else if (plan.current.stripPrefix === plan.desiredStripPrefix) {
    console.log(chalk.green(`    ✓ strip_prefix: ${plan.desiredStripPrefix}`));
  } else {
    console.log(chalk.yellow("    · strip_prefix:"));
    console.log(chalk.dim(`        before: ${plan.current.stripPrefix}`));
    console.log(chalk.dim(`        after:  ${plan.desiredStripPrefix}`));
  }

  renderDbNetwork(plan);
}

/** The `connect_to_docker_network` line of a plan.
 *
 *  There is no "before" to print — Coolify never returns the field —
 *  so this reports the app's DATABASE REFERENCES and its restart
 *  evidence instead, which is the only honest way to say what sync
 *  knows. Silent for apps that use no Coolify-managed database: they
 *  neither need the join nor benefit from being told about it. */
function renderDbNetwork(plan: AppSyncPlan): void {
  if (!plan.desiredConnectToDockerNetwork) return;
  const refs = plan.coolifyDbReferences ?? [];
  const keys = refs.map((r) => r.key).join(", ");
  const dbs = [...new Set(refs.map((r) => r.database))].join(", ");
  if (plan.dbNetworkRepair) {
    console.log(
      chalk.yellow(
        `    · connect_to_docker_network → true (REPAIR: ${plan.current.restartCount} crash restart(s))`,
      ),
    );
    console.log(
      chalk.dim(
        `        ${keys} points at Coolify-managed ${dbs}, which lives on the shared \`coolify\`\n` +
          "        network. This app is on a network named after its own uuid, so it cannot resolve\n" +
          "        that host — expect `getaddrinfo ENOTFOUND` in the container log.",
      ),
    );
  } else {
    console.log(
      chalk.dim(
        `    · connect_to_docker_network → true (write-only in Coolify's API; pushed with this update)`,
      ),
    );
    console.log(chalk.dim(`        ${keys} → Coolify-managed ${dbs}`));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Comma-joined app names, for a one-line summary of a plan list. */
function names(plans: AppSyncPlan[]): string {
  return plans.map((p) => p.name).join(", ");
}

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
  // Blocking by default. `--no-preflight` is for the case where the
  // user knows the ref is fine and git can't tell them so (a shallow
  // clone, a repo Coolify reaches and this machine doesn't), not for
  // pushing past a finding.
  const preflight = !args.includes("--no-preflight");
  const nativeOrigins = !args.includes("--no-native-origins");
  const yes = args.includes("--yes") || args.includes("-y");
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
    preflight,
    nativeOrigins,
    yes,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) process.exit(1);
}
