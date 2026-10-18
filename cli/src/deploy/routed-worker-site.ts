/*
 * A site with no server, served by one assets-only Cloudflare Worker that
 * Workers routes attach to its hostnames:
 *
 *   "deploymentMode": "cloudflare"   nothing runs on Coolify
 *   "clientHost": "cloudflare"       the Worker is on routes `<host>/*`,
 *                                    not on a Custom Domain
 *   "clientRelease": "repo"          (usual) the repo's CI uploads and
 *                                    activates versions; hatchkit writes
 *                                    none of its Worker files
 *
 * `clientHost: "cloudflare"` means the same thing as on a fullstack
 * project whose client `hatchkit migrate-client` moved; `deploymentMode`
 * tells the two apart. Without `clientHost`, `deploymentMode: "cloudflare"`
 * is still the site `hatchkit cloudflare` sets up: a Custom Domain and
 * hatchkit's deploy workflow.
 *
 * First case: hydroxyl-app (manifest name chemistry-sketcher), whose
 * Coolify app retired on 2026-10-18. Its routes were made by hand on two
 * zones (hydroxyl.app, trebeljahr.com) and its release is its own
 * (scripts/worker-release.mjs). So nothing here writes: `sync`,
 * `regen-infra` and `dns publish` leave the project alone, and `doctor`
 * reads the zones.
 *
 * Routes: `<host>/*` → the Worker for the domain and every alias. A
 * no-Worker route only for an `originPaths` entry the manifest names, and
 * no ACME route: with no Coolify app, Traefik holds no certificate for
 * these hosts. A `<host>/.well-known/acme-challenge/*` route left from the
 * cutover is reported as a leftover, not as a foreign route.
 */

import { readWranglerConfig } from "../scaffold/cloudflare-mode.js";
import { type ProjectManifest, manifestHostnames } from "../scaffold/manifest.js";
import type { CfWorkerRoute, CloudflareApi } from "../utils/cloudflare-api.js";
import { type EdgeContext, preflightEdge } from "./client-host.js";
import {
  ACME_CHALLENGE_PATH,
  type EdgePlan,
  type EdgeRoute,
  computeEdgePlan,
  defaultClientWorkerName,
} from "./routing.js";

type SiteManifest = Pick<
  ProjectManifest,
  | "name"
  | "domain"
  | "aliases"
  | "deploymentMode"
  | "clientHost"
  | "clientWorker"
  | "clientRelease"
  | "originPaths"
>;

/** No server, the site on an assets-only Worker attached by routes. */
export function isRoutedWorkerSite(
  manifest: Pick<ProjectManifest, "deploymentMode" | "clientHost">,
): boolean {
  return manifest.deploymentMode === "cloudflare" && manifest.clientHost === "cloudflare";
}

/** The repo, not hatchkit, writes the Worker's wrangler config,
 *  `_headers`, carry script and release workflow. */
export function repoOwnsWorkerFiles(manifest: Pick<ProjectManifest, "clientRelease">): boolean {
  return manifest.clientRelease === "repo";
}

/** Top-level `name` of the root wrangler.jsonc, or null. */
export function wranglerWorkerName(projectDir: string): string | null {
  return readWranglerConfig(projectDir)?.match(/^\s*"name"\s*:\s*"([^"]+)"/m)?.[1] ?? null;
}

/** The Worker serving the client: manifest `clientWorker`, then the root
 *  wrangler.jsonc's `name`, then `<name>-client`. */
export function clientWorkerName(
  manifest: Pick<ProjectManifest, "name" | "clientWorker">,
  projectDir: string,
): string {
  return (
    manifest.clientWorker ||
    wranglerWorkerName(projectDir) ||
    defaultClientWorkerName(manifest.name)
  );
}

/** The routes a routed Worker site needs. Pure apart from reading the
 *  Worker name. */
export function routedWorkerSiteEdge(manifest: SiteManifest, projectDir: string): EdgePlan {
  return computeEdgePlan(
    {
      name: manifest.name,
      domain: manifest.domain,
      hostnameAliases: manifestHostnames(manifest).slice(1),
      // No API host to keep off the Worker: every alias is a site host.
      topology: "single-origin",
      // computeEdgePlan defaults single-origin to ["/api"]; there is no API.
      originPaths: manifest.originPaths ?? [],
      clientWorker: clientWorkerName(manifest, projectDir),
    },
    // No Coolify app, so no host on which Traefik still renews.
    [],
  );
}

/** One zone's share of an edge plan. */
export interface EdgeZone {
  ctx: EdgeContext;
  edge: EdgePlan;
}

/** Split an edge plan by the zone of each host. resolveEdgeContext takes
 *  one zone per client because it writes; a read can span several
 *  (hydroxyl.app and chemistry.trebeljahr.com). */
export async function resolveEdgeZones(
  api: CloudflareApi,
  accountId: string,
  edge: EdgePlan,
): Promise<EdgeZone[]> {
  const zones = new Map<string, EdgeZone>();
  for (const host of edge.hosts) {
    const zone = await api.resolveZoneForName(host);
    if (!zone) throw new Error(`No Cloudflare zone in this account manages ${host}.`);
    let entry = zones.get(zone.id);
    if (!entry) {
      entry = {
        ctx: { api, accountId, zoneId: zone.id, zoneName: zone.name },
        edge: { worker: edge.worker, hosts: [], routes: [] },
      };
      zones.set(zone.id, entry);
    }
    entry.edge.hosts.push(host);
  }
  for (const entry of zones.values()) {
    entry.edge.routes = edge.routes.filter((r) => entry.edge.hosts.includes(r.host));
  }
  return [...zones.values()];
}

/** No-Worker ACME routes on the plan's hosts that the plan does not name:
 *  what a cutover leaves once no Coolify app routes the host. */
export function leftoverAcmeRoutes(edge: EdgePlan, zoneRoutes: CfWorkerRoute[]): CfWorkerRoute[] {
  const planned = new Set(edge.routes.map((r) => r.pattern));
  const acme = new Set(edge.hosts.map((h) => `${h}${ACME_CHALLENGE_PATH}/*`));
  return zoneRoutes.filter((r) => !r.script && acme.has(r.pattern) && !planned.has(r.pattern));
}

/** Shape of a doctor check (doctor.ts keeps its type private). */
export interface SiteCheck {
  name: string;
  status: "ok" | "fail" | "warn" | "skip";
  detail?: string;
  hint?: string[];
}

export interface RoutedSiteCheckDeps {
  /** Read access to the zones; null skips the zone check. */
  cloudflare: {
    api: CloudflareApi;
    accountId: string;
    /** hatchkit's DNS token, which reads records the provisioner may not. */
    dnsApi?: EdgeContext["dnsApi"];
  } | null;
  fetch?: typeof fetch;
}

/**
 * doctor for a routed Worker site, read-only:
 *
 *   · routes — per zone, every host has a proxied record, `<host>/*`
 *     sends to the Worker, nothing foreign sits on the hosts, the Worker
 *     has a deployed version, hatchkit's HTTPS rule covers the hosts.
 *     Leftover ACME routes are a warning.
 *   · live — every host answers 200 on `/` through the edge.
 *
 * Never Coolify, never `/api/health`: the site has no server.
 */
export async function checkRoutedWorkerSite(
  projectDir: string,
  manifest: SiteManifest,
  deps: RoutedSiteCheckDeps,
): Promise<SiteCheck[]> {
  const out: SiteCheck[] = [];
  const name = `Project ${manifest.name} (Cloudflare client)`;
  const edge = routedWorkerSiteEdge(manifest, projectDir);

  if (!deps.cloudflare) {
    out.push({
      name: `${name}: routes`,
      status: "skip",
      detail: "no Cloudflare provisioner to read the zone",
    });
  } else {
    try {
      out.push(await checkZones(name, edge, deps.cloudflare));
    } catch (err) {
      out.push({ name: `${name}: routes`, status: "fail", detail: (err as Error).message });
    }
  }

  const doFetch = deps.fetch ?? fetch;
  const failures: string[] = [];
  let reached = 0;
  for (const host of edge.hosts) {
    try {
      const res = await doFetch(`https://${host}/?hatchkit_cb=${Date.now()}`, {
        signal: AbortSignal.timeout(10_000),
      });
      reached++;
      if (res.status !== 200) failures.push(`https://${host}/ answered ${res.status}`);
    } catch (err) {
      failures.push(`couldn't reach https://${host}/: ${(err as Error).message}`);
    }
  }
  out.push(
    failures.length === 0
      ? {
          name: `${name}: live`,
          status: "ok",
          detail: `${edge.hosts.join(", ")} answer 200`,
        }
      : {
          name: `${name}: live`,
          // Nothing answered at all: more likely this machine's network.
          status: reached === 0 ? "warn" : "fail",
          detail: failures[0],
          hint: failures,
        },
  );
  return out;
}

async function checkZones(
  name: string,
  edge: EdgePlan,
  cf: NonNullable<RoutedSiteCheckDeps["cloudflare"]>,
): Promise<SiteCheck> {
  const problems = new Set<string>();
  const leftovers: string[] = [];
  let live: string[] = [];
  const zones = await resolveEdgeZones(cf.api, cf.accountId, edge);
  for (const zone of zones) {
    const ctx = cf.dnsApi ? { ...zone.ctx, dnsApi: cf.dnsApi } : zone.ctx;
    const stale = leftoverAcmeRoutes(zone.edge, await cf.api.listWorkerRoutes(ctx.zoneId));
    leftovers.push(...stale.map((r) => `${r.pattern} (${r.id}) on ${ctx.zoneName}`));
    // Plan the leftovers so preflight sees them as present, not foreign.
    const asPlanned: EdgeRoute[] = stale.map((r) => ({
      pattern: r.pattern,
      host: r.pattern.slice(0, r.pattern.indexOf("/")),
      script: null,
      purpose: "acme",
    }));
    const pre = await preflightEdge(ctx, {
      ...zone.edge,
      routes: [...asPlanned, ...zone.edge.routes],
    });
    for (const b of pre.blocking) problems.add(b);
    for (const r of pre.diff.missing) problems.add(`route ${r.pattern} → ${r.script} is missing`);
    if (pre.httpsMissing.length) {
      problems.add(
        `HTTPS redirect on ${ctx.zoneName} does not cover ${pre.httpsMissing.join(", ")}: \`hatchkit cloudflare https add ${pre.httpsMissing.join(" ")}\``,
      );
    }
    if (pre.liveVersions.length) live = pre.liveVersions;
  }
  const zoneNames = zones.map((z) => z.ctx.zoneName).join(", ");
  if (problems.size) {
    return {
      name: `${name}: routes`,
      status: "fail",
      detail: [...problems][0],
      hint: [
        ...problems,
        "hatchkit makes no routes for a site with no server (clientHost + deploymentMode cloudflare); fix them in the dashboard.",
      ],
    };
  }
  if (leftovers.length) {
    return {
      name: `${name}: routes`,
      status: "warn",
      detail: `${leftovers.length} leftover ACME route(s); no Coolify app renews a certificate for these hosts`,
      hint: [
        ...leftovers.map((l) => `delete ${l}`),
        "They send the path to the old origin and do nothing else.",
      ],
    };
  }
  return {
    name: `${name}: routes`,
    status: "ok",
    detail: `${edge.routes.length} route(s) on ${zoneNames}, Worker ${edge.worker} live (${live.join(", ")})`,
  };
}

/** Refuse a `hatchkit cloudflare` setup or undo where its Custom Domain
 *  shape does not apply. Returns the reason, or null to go ahead. */
export function cloudflareSetupRefusal(
  manifest: SiteManifest | null,
  projectDir: string,
  action: "setup" | "undo",
): string | null {
  if (manifest?.clientHost !== "cloudflare") return null;
  const worker = clientWorkerName(manifest, projectDir);
  const what =
    action === "setup"
      ? "attaches a Custom Domain and writes wrangler.jsonc, _headers, next.config.ts and the deploy workflow"
      : "deletes wrangler.jsonc and the deploy workflow and revokes the Worker's deploy token";
  const instead =
    manifest.deploymentMode === "cloudflare"
      ? "Delete the routes in the dashboard to take the site off the Worker."
      : "`hatchkit migrate-client --rollback` takes the client off the Worker.";
  return action === "setup"
    ? `${manifest.name} is served by Worker ${worker} through Workers routes (clientHost "cloudflare"). ` +
        `\`hatchkit cloudflare\` ${what}, so it does not run here. ` +
        "Still available: `hatchkit cloudflare token`, `hatchkit cloudflare https add|remove`, `hatchkit cloudflare redirect add`."
    : `${manifest.name} is served by Worker ${worker} through Workers routes (clientHost "cloudflare"). ` +
        `\`hatchkit cloudflare --undo\` ${what}, so it does not run here. ${instead}`;
}
