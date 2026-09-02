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
 * Scope is deliberately narrow. Sync only pushes fields that are safe to
 * blast over the wire idempotently:
 *   · domain (`docker_compose_domains` for compose apps; `domains` for
 *     nixpacks / dockerfile / static)
 *   · ports_exposes — only on non-compose build packs; Coolify
 *     re-derives it from the compose file otherwise and discards ours
 *   · is_stripprefix_enabled — required to be false whenever routing
 *     uses a path (`https://<domain>/api`), or Coolify's Traefik
 *     middleware strips `/api` and Express 404s every API call.
 *
 * Out of scope (handled by other commands):
 *   · env vars              → `hatchkit keys push` + adopt's setAppEnv
 *   · DNS records           → adopt's wireDns + `rename-domain`
 *   · ML services / GPU     → `hatchkit add gpu`
 *   · S3 buckets / tokens   → `hatchkit provision s3`
 *
 * Idempotent by design: reads current state first, only PATCHes when the
 * desired state differs from what Coolify reports. `--dry-run` shows the
 * diff without touching anything.
 */

import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { readManifestWithMigrationInfo } from "../scaffold/manifest.js";
import { readComposeFile } from "../utils/compose.js";
import { CoolifyApi, type CoolifyApplication } from "../utils/coolify-api.js";
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

  for (const routed of routing.apps) {
    const found = await locateApp(api, routed, opts);
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

    const plan = buildPlan(routed, current, compose);
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

  // Redeploy AFTER every PATCH has landed. Coolify only regenerates
  // Traefik labels on deploy, so a routing change that isn't followed
  // by one is invisible to the running containers.
  const deployed: string[] = [];
  if (opts.deploy && !opts.dryRun) {
    for (const plan of patched) {
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
    topologySource: inference.source,
    topologyReason: inference.reason,
    composeServices: compose?.services ?? null,
    apps,
    dryRun: !!opts.dryRun,
  };

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
    dryRun: !!opts.dryRun,
  };
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
  const left = a ?? [];
  if (left.length !== b.length) return false;
  // Order-insensitive comparison — Coolify doesn't promise to round-trip
  // the array in the same order it was sent. Both sides are collapsed
  // before this runs, so one entry per service.
  const key = (e: { name: string; domain: string }) => `${e.name}::${e.domain}`;
  const setA = new Set(left.map(key));
  return b.every((e) => setA.has(key(e)));
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
  const dirArg = ((): string | undefined => {
    const i = args.findIndex((a) => a === "--dir");
    if (i >= 0 && args[i + 1]) return args[i + 1];
    return undefined;
  })();

  const projectDir = dirArg ? dirArg : process.cwd();
  const result = await runSync({ projectDir, dryRun, json, force, deploy });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) process.exit(1);
}
