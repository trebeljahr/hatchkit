/*
 * sync — push the .hatchkit.json manifest's view of the project onto
 * the Coolify resource(s) hatchkit created (or adopted) for it.
 *
 * Why this exists: Coolify's auto-generated Traefik labels are derived
 * from the application's Domain field (`docker_compose_domains` for
 * dockercompose build packs, `fqdn` / `domains` otherwise). When a
 * scaffold or adopt run created the app without that field populated —
 * either because of the pre-fix bug where `updateApplication` couldn't
 * push domains, or because the user changed the manifest after scaffold —
 * the container ends up with zero traefik labels and Traefik silently
 * drops the route. `hatchkit sync` reads the manifest, finds the matching
 * Coolify app(s), and PATCHes them so Coolify regenerates the labels on
 * the next deploy.
 *
 * Scope is deliberately narrow. Sync only pushes fields that are safe to
 * blast over the wire idempotently:
 *   · domain (`docker_compose_domains` for compose apps; `domains` for
 *     nixpacks / dockerfile / static)
 *   · ports_exposes (so the multi-host routing for the starter's split
 *     compose stays consistent with what runCoolifySetup creates)
 *
 * Out of scope (handled by other commands):
 *   · env vars              → `hatchkit keys push` + adopt's setAppEnv
 *   · DNS records           → adopt's wireDns + `rename-domain`
 *   · ML services / GPU     → `hatchkit add gpu`
 *   · S3 buckets / tokens   → `hatchkit provision s3`
 *
 * Idempotent by design: reads current state first, only PATCHes when the
 * desired domain set differs from what Coolify reports. `--dry-run`
 * shows the diff without touching anything.
 */

import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import { type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { CoolifyApi, type CoolifyApplication } from "../utils/coolify-api.js";

export interface SyncOptions {
  /** Project root containing `.hatchkit.json`. */
  projectDir: string;
  /** Print the desired changes without PATCHing Coolify. */
  dryRun?: boolean;
  /** Emit `{ ok, apps: [...] }` JSON to stdout. Suppresses the human
   *  rendering for scripts. */
  json?: boolean;
}

/** What sync intends to do for one Coolify application — surfaces both
 *  the desired payload and a diff against what Coolify currently reports.
 *  Renderable in either human-readable or JSON form. */
export interface AppSyncPlan {
  /** Coolify uuid. */
  uuid: string;
  /** Coolify app name (used to locate the resource). */
  name: string;
  /** Build pack reported by Coolify — drives which API field carries
   *  the domain payload. */
  buildPack?: CoolifyApplication["buildPack"];
  /** Per-service domains for dockercompose apps. Always populated when
   *  the build pack is dockercompose; undefined otherwise. */
  desiredDockerComposeDomains?: Array<{ name: string; domain: string }>;
  /** Comma-joined FQDN list for non-dockercompose apps. Always
   *  populated when the build pack is nixpacks / dockerfile / static;
   *  undefined for dockercompose. */
  desiredDomains?: string[];
  /** ports_exposes the manifest expects on this app. Always set —
   *  Coolify keeps it as a non-empty string. */
  desiredPortsExposes: string;
  /** Snapshot of the same fields as Coolify currently reports them.
   *  Used by the renderer to decide "already correct" vs. "will
   *  change", and by the JSON output as the before-state. */
  current: {
    fqdn: string | null;
    dockerComposeDomains?: Array<{ name: string; domain: string }>;
    portsExposes?: string;
  };
  /** Whether a PATCH is needed to converge — false means everything
   *  already matches, sync skips the API call. */
  changed: boolean;
}

export interface SyncResult {
  ok: boolean;
  /** Set when sync couldn't run at all (e.g. no manifest, no Coolify
   *  config, no matching apps). Either `apps` or `error` will be
   *  meaningful — never both. */
  error?: string;
  apps: AppSyncPlan[];
  /** When dryRun, no PATCH was made even if `changed` was true. */
  dryRun: boolean;
}

/** Top-level entrypoint. Reads the project manifest, finds the Coolify
 *  app(s) hatchkit knows about by name, and pushes the desired domain
 *  + ports payload — or just prints what it would push when `dryRun`. */
export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const manifest = readManifest(opts.projectDir);
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
    return { ok: false, error: err, apps: [], dryRun: !!opts.dryRun };
  }
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    const err = "Coolify is not configured. Run `hatchkit config add coolify` first.";
    if (!opts.json) console.log(chalk.red(`  ${err}`));
    return { ok: false, error: err, apps: [], dryRun: !!opts.dryRun };
  }
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  const desiredAll = computeDesiredAppStates(manifest);
  const apps: AppSyncPlan[] = [];
  const errors: string[] = [];

  // Match every desired-app entry against Coolify by name. We don't
  // pre-list /applications and intersect because sync should still work
  // when the user has hundreds of apps; a per-name lookup is cheaper.
  // Apps the manifest expects but that don't exist in Coolify are
  // logged as a hint (the user probably needs `hatchkit adopt` first)
  // but don't fail the whole run — partial sync of the apps that DO
  // exist is the most useful behavior.
  for (const desired of desiredAll) {
    const matchSpinner = opts.json ? null : ora(`Coolify: locating "${desired.appName}"`).start();
    const found = await api.findApplicationByName(desired.appName);
    if (!found) {
      matchSpinner?.warn(`Coolify: no app named "${desired.appName}" — skipping`);
      continue;
    }
    matchSpinner?.succeed(`Coolify: found "${desired.appName}" (${found.uuid})`);

    let current: CoolifyApplication;
    try {
      current = await api.getApplication(found.uuid);
    } catch (err) {
      errors.push(
        `Failed to read Coolify app "${desired.appName}" (${found.uuid}): ${(err as Error).message}`,
      );
      continue;
    }

    const plan = buildPlan(found.uuid, desired, current);
    apps.push(plan);

    if (!opts.json) renderPlan(plan);

    if (!plan.changed) continue;
    if (opts.dryRun) continue;

    const patch = ora(`Coolify: updating "${desired.appName}"`).start();
    try {
      await api.updateApplication(plan.uuid, {
        portsExposes: plan.desiredPortsExposes,
        ...(plan.desiredDockerComposeDomains
          ? { dockerComposeDomains: plan.desiredDockerComposeDomains }
          : {}),
        ...(plan.desiredDomains ? { domains: plan.desiredDomains } : {}),
      });
      patch.succeed(`Coolify: updated "${desired.appName}"`);
    } catch (err) {
      patch.fail(`Coolify: PATCH failed: ${(err as Error).message}`);
      errors.push(`PATCH ${desired.appName}: ${(err as Error).message}`);
    }
  }

  if (apps.length === 0 && errors.length === 0) {
    const err = `No Coolify apps matched manifest project "${manifest.name}".`;
    if (!opts.json) {
      console.log(chalk.yellow(`  ${err}`));
      console.log(
        chalk.dim(
          `  Looked for: ${desiredAll.map((d) => `"${d.appName}"`).join(", ")}.\n` +
            `  Run \`hatchkit adopt\` to create them, or rename the existing app(s) to match.`,
        ),
      );
    }
    return { ok: false, error: err, apps, dryRun: !!opts.dryRun };
  }

  if (!opts.json) {
    if (opts.dryRun) {
      console.log(chalk.dim("\n  --dry-run: no changes pushed."));
    } else {
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
    apps,
    dryRun: !!opts.dryRun,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

// ---------------------------------------------------------------------------
// Plan computation — manifest → desired Coolify state
// ---------------------------------------------------------------------------

/** Desired state for one Coolify application, derived from the manifest.
 *  Computed before any API calls so `--dry-run` never hits the network
 *  for plan generation. */
interface DesiredApp {
  /** Name to look up in Coolify. */
  appName: string;
  /** Build-pack-aware payload — only one of these is set per app. The
   *  CoolifyApi.updateApplication shape needs the right field for the
   *  build pack reported by Coolify; we resolve that at apply time, not
   *  here, since the manifest doesn't carry build pack. */
  domains: Array<{ name: string; domain: string }>;
  /** ports_exposes for this app. Comma-separated string Coolify
   *  stores verbatim. */
  portsExposes: string;
}

/** Map a manifest to the set of Coolify apps hatchkit owns for it. The
 *  shapes we cover (matching the layouts `findCoolifyAppsForProject`
 *  understands):
 *
 *    1. Single-app (current `create` + `adopt` output):  `<name>`
 *    2. Legacy single-app fallback:                      `<name>-web`
 *    3. Starter-split (legacy, currently unused):        `<name>-server` + `<name>-client`
 *
 *  All current surfaces use shape (1) — the surface affects which
 *  services live inside the compose file, not the outer Coolify app
 *  name. We synthesize a candidate list per layout. The actual lookup
 *  happens per-name; misses are skipped. This means a project that
 *  scaffolded as starter-split AND was later adopted as single-app
 *  would push twice — not a problem because each PATCH is independent
 *  and idempotent. */
export function computeDesiredAppStates(manifest: ProjectManifest): DesiredApp[] {
  const { name, domain, surfaces, ports } = manifest;
  const portServer = String(ports?.server ?? 3000);
  const portClient = String(ports?.client ?? 3001);

  // Routing recipes — see `runCoolifySetup` (cli/src/deploy/coolify.ts)
  // for the create-time source of truth. Sync mirrors that exactly so
  // re-running sync converges to the same labels Coolify generated at
  // create time.
  const apiDomain = `api.${domain}`;
  const frontendDomain = `https://${domain}`;
  const backendDomains = [
    `https://${apiDomain}`,
    `https://${domain}/api`,
    `https://${domain}/api/ws`,
    `https://${apiDomain}/ws`,
  ];
  const splitClientDomains = [{ name: "client", domain: frontendDomain }];
  const splitServerDomains = backendDomains.map((d) => ({ name: "server", domain: d }));

  // Single-app layout: one Coolify app named `<name>` with one compose
  // service `app`. ports_exposes is surface-aware:
  //   server-only / both → server port (the public listener)
  //   client-only        → 80 (matches adopt.ts's static-site default)
  const singleAppPort = surfaces === "client-only" ? "80" : portServer;
  const singleAppDomain =
    surfaces === "client-only" && (singleAppPort === "80" || singleAppPort === "443")
      ? `https://${domain}`
      : `https://${domain}:${singleAppPort}`;
  // Use bare `https://<domain>` when the listener is on the conventional
  // 80/443 — Coolify's Traefik handles the HTTPS termination and the
  // explicit port suffix would push the route through Traefik on a
  // non-standard port (which won't match the Coolify ingress). The
  // formatDockerComposeDomain helper in coolify-app.ts uses the same
  // rule; mirror it here so sync output matches what adopt creates.
  const singleAppCanonicalDomain =
    singleAppPort === "80" || singleAppPort === "443" ? `https://${domain}` : singleAppDomain;
  const singleApp: DesiredApp = {
    appName: name,
    domains: [{ name: "app", domain: singleAppCanonicalDomain }],
    portsExposes: singleAppPort,
  };

  // Starter-split layout: two apps. Each app's compose has its own
  // service named `client` or `server` respectively; routing splits
  // along the same lines as runCoolifySetup creates.
  const splitClient: DesiredApp = {
    appName: `${name}-client`,
    domains: splitClientDomains,
    portsExposes: portClient,
  };
  const splitServer: DesiredApp = {
    appName: `${name}-server`,
    domains: splitServerDomains,
    portsExposes: portServer,
  };

  // Legacy single-app fallbacks. `runCoolifySetup` used to create
  // `<name>-web` for every surface before settling on the bare `<name>`
  // matched by `singleApp` above; the others are speculative for
  // hand-written compose layouts that adopt previously matched.
  const fallbackWeb: DesiredApp = {
    ...singleApp,
    appName: `${name}-web`,
  };

  // Filter by surfaces so we don't ship a non-existent split shape
  // in JSON output. The actual Coolify lookup will skip non-existent
  // names anyway, but keeping the candidate list tight reduces noise.
  if (surfaces === "client-only") {
    return [singleApp, fallbackWeb, splitClient];
  }
  if (surfaces === "server-only") {
    return [singleApp, fallbackWeb, splitServer];
  }
  // both / undefined → server-of-truth is the split layout, but adopt
  // collapses to single-app for projects without a separate frontend.
  return [singleApp, fallbackWeb, splitServer, splitClient];
}

// ---------------------------------------------------------------------------
// Plan rendering
// ---------------------------------------------------------------------------

function buildPlan(uuid: string, desired: DesiredApp, current: CoolifyApplication): AppSyncPlan {
  const isCompose = current.buildPack === "dockercompose";
  // dockercompose apps use docker_compose_domains; everything else uses
  // the flat `domains` field. Coolify rejects a domain payload that
  // doesn't match the build pack with a 422.
  const desiredDockerComposeDomains = isCompose ? desired.domains : undefined;
  const desiredDomains = isCompose ? undefined : desired.domains.map((d) => d.domain);

  const portsChanged =
    current.portsExposes !== undefined && current.portsExposes !== desired.portsExposes;
  const domainsChanged = isCompose
    ? !sameDockerComposeDomains(current.dockerComposeDomains, desired.domains)
    : !sameStringList(
        splitFqdn(current.fqdn),
        desired.domains.map((d) => d.domain),
      );

  return {
    uuid,
    name: current.name || desired.appName,
    buildPack: current.buildPack,
    ...(desiredDockerComposeDomains ? { desiredDockerComposeDomains } : {}),
    ...(desiredDomains ? { desiredDomains } : {}),
    desiredPortsExposes: desired.portsExposes,
    current: {
      fqdn: current.fqdn,
      ...(current.dockerComposeDomains
        ? { dockerComposeDomains: current.dockerComposeDomains }
        : {}),
      ...(current.portsExposes !== undefined ? { portsExposes: current.portsExposes } : {}),
    },
    changed: portsChanged || domainsChanged,
  };
}

function renderPlan(plan: AppSyncPlan): void {
  console.log(chalk.bold(`\n  ${plan.name}`) + chalk.dim(` (${plan.uuid.slice(0, 8)}…)`));
  if (plan.buildPack) {
    console.log(chalk.dim(`    build pack: ${plan.buildPack}`));
  }
  if (plan.desiredDockerComposeDomains) {
    const before = plan.current.dockerComposeDomains ?? [];
    const after = plan.desiredDockerComposeDomains;
    const same = sameDockerComposeDomains(before, after);
    if (same) {
      console.log(chalk.green(`    ✓ docker_compose_domains: in sync`));
      console.log(chalk.dim(`        ${formatDockerComposeDomains(after)}`));
    } else {
      console.log(chalk.yellow(`    · docker_compose_domains:`));
      console.log(chalk.dim(`        before: ${formatDockerComposeDomains(before)}`));
      console.log(chalk.dim(`        after:  ${formatDockerComposeDomains(after)}`));
    }
  } else if (plan.desiredDomains) {
    const before = splitFqdn(plan.current.fqdn);
    const after = plan.desiredDomains;
    const same = sameStringList(before, after);
    if (same) {
      console.log(chalk.green(`    ✓ domains: in sync (${after.join(", ")})`));
    } else {
      console.log(chalk.yellow(`    · domains:`));
      console.log(chalk.dim(`        before: ${before.join(", ") || "(empty)"}`));
      console.log(chalk.dim(`        after:  ${after.join(", ")}`));
    }
  }
  if (
    plan.current.portsExposes !== undefined &&
    plan.current.portsExposes !== plan.desiredPortsExposes
  ) {
    console.log(chalk.yellow(`    · ports_exposes:`));
    console.log(chalk.dim(`        before: ${plan.current.portsExposes}`));
    console.log(chalk.dim(`        after:  ${plan.desiredPortsExposes}`));
  } else if (plan.current.portsExposes === plan.desiredPortsExposes) {
    console.log(chalk.green(`    ✓ ports_exposes: ${plan.desiredPortsExposes}`));
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
  // the array in the same order it was sent.
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
  const dirArg = ((): string | undefined => {
    const i = args.findIndex((a) => a === "--dir");
    if (i >= 0 && args[i + 1]) return args[i + 1];
    return undefined;
  })();

  const projectDir = dirArg ? dirArg : process.cwd();
  const result = await runSync({ projectDir, dryRun, json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) process.exit(1);
}
