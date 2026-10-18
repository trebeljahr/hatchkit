/*
 * A site with no server, served by assets-only Cloudflare Workers that
 * Workers routes attach to its hostnames:
 *
 *   "deploymentMode": "cloudflare"   nothing runs on Coolify
 *   "clientHost": "cloudflare"       the Worker is on routes `<host>/*`,
 *                                    not on a Custom Domain
 *   "clientRelease": "repo"          (usual) the repo's CI uploads and
 *                                    activates versions; hatchkit writes
 *                                    none of its Worker files
 *   "clientWorkers": { … }           (optional) a Worker per host, extra
 *                                    routes to other Workers, hosts the
 *                                    zone redirects
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
 * Several Workers: mesozoic-protocol. An assets-only Worker cannot
 * branch on the host, so the apex and `play.` are two Workers, each with
 * its own copy of the build; two API Workers with code sit on more
 * specific routes (`/api/newsletter/*`, `/api/feedback*`); `www.` and a
 * retired host only redirect, by hatchkit's redirect rules. One
 * `clientWorker` cannot say that, so doctor reported the play route as
 * a wrong-Worker route and the API routes as foreign. `clientWorkers`
 * names each.
 *
 * Routes: `<host>/*` → the host's Worker for the domain and every alias
 * not redirected; each `clientWorkers` pattern → its Worker. A no-Worker
 * route only for an `originPaths` entry the manifest names, and no ACME
 * route: with no Coolify app, Traefik holds no certificate for these
 * hosts. A `<host>/.well-known/acme-challenge/*` route left from the
 * cutover is reported as a leftover, not as a foreign route.
 */

import { readWranglerConfig } from "../scaffold/cloudflare-mode.js";
import { type ProjectManifest, manifestHostnames } from "../scaffold/manifest.js";
import type { CfWorkerRoute, CloudflareApi } from "../utils/cloudflare-api.js";
import {
  type EdgeContext,
  diffEdge,
  findHostRedirectRule,
  patternHost,
  preflightEdge,
} from "./client-host.js";
import {
  ACME_CHALLENGE_PATH,
  type EdgePlan,
  type EdgeRoute,
  defaultClientWorkerName,
  normaliseOriginPaths,
  originRoutePattern,
} from "./routing.js";

type SiteManifest = Pick<
  ProjectManifest,
  | "name"
  | "domain"
  | "aliases"
  | "deploymentMode"
  | "clientHost"
  | "clientWorker"
  | "clientWorkers"
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
 *  wrangler.jsonc's `name`, then `<name>-client`. For a site with
 *  `clientWorkers`, the Worker of every host the map does not name. */
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

/** `clientWorkers` resolved against the manifest's hosts. */
interface SiteWorkers {
  /** Every host, manifest order: its Worker, or null when the zone
   *  redirects it. */
  hosts: Map<string, string | null>;
  /** Extra routes, map order. */
  routes: Array<{ pattern: string; host: string; worker: string }>;
}

/** Read `clientWorkers`. Throws naming the entry that does not fit. */
function readSiteWorkers(manifest: SiteManifest, fallback: string): SiteWorkers {
  const hosts = new Map<string, string | null>(
    manifestHostnames(manifest).map((h) => [h, fallback]),
  );
  const routes: SiteWorkers["routes"] = [];
  const bad = (key: string, why: string) =>
    new Error(`.hatchkit.json clientWorkers ${JSON.stringify(key)}: ${why}`);
  for (const [raw, worker] of Object.entries(manifest.clientWorkers ?? {})) {
    const key = raw.trim();
    if (worker !== null && (typeof worker !== "string" || !worker.trim())) {
      throw bad(raw, "the value is a Worker name, or null for a host the zone redirects.");
    }
    const slash = key.indexOf("/");
    const host = patternHost(key);
    if (!hosts.has(host)) throw bad(raw, `${host} is not the domain or an alias.`);
    if (slash === -1) {
      hosts.set(host, worker);
      continue;
    }
    const pattern = `${host}${key.slice(slash)}`;
    if (pattern === `${host}/*`)
      throw bad(raw, `name the host ("${host}") for its <host>/* route.`);
    if (worker === null) throw bad(raw, "a route needs a Worker; null is for a host only.");
    routes.push({ pattern, host, worker });
  }
  for (const r of routes) {
    if (hosts.get(r.host) === null) {
      throw bad(
        r.pattern,
        `${r.host} is redirected by the zone (null); no route on it is reached.`,
      );
    }
  }
  if (![...hosts.values()].some((w) => w !== null)) {
    throw new Error(".hatchkit.json clientWorkers redirects every host; one needs a Worker.");
  }
  return { hosts, routes };
}

/** The routes a routed Worker site needs: `originPaths`, then the
 *  `clientWorkers` patterns, then `<host>/*` per host on a Worker (the
 *  specific routes before the catch-all, as they would be created).
 *  `worker` is the default Worker; `hosts` leaves out redirected hosts.
 *  Pure apart from reading the Worker name; throws on a bad map. */
export function routedWorkerSiteEdge(manifest: SiteManifest, projectDir: string): EdgePlan {
  const worker = clientWorkerName(manifest, projectDir);
  const site = readSiteWorkers(manifest, worker);
  const [domain] = manifestHostnames(manifest);
  // No API to keep off the Worker; only the paths the manifest names.
  const originPaths = normaliseOriginPaths(manifest.originPaths ?? []);
  if (originPaths.length && site.hosts.get(domain) === null) {
    throw new Error(".hatchkit.json originPaths are on the domain, which clientWorkers redirects.");
  }
  const served = [...site.hosts].flatMap(([host, w]) => (w === null ? [] : [{ host, w }]));
  const routes: EdgeRoute[] = [
    ...originPaths.map((path) => ({
      pattern: originRoutePattern(domain, path),
      host: domain,
      script: null,
      purpose: "origin" as const,
    })),
    ...site.routes.map((r) => ({
      pattern: r.pattern,
      host: r.host,
      script: r.worker,
      purpose: "worker" as const,
    })),
    ...served.map(({ host, w }) => ({
      pattern: `${host}/*`,
      host,
      script: w,
      purpose: "client" as const,
    })),
  ];
  return { worker, hosts: served.map((s) => s.host), routes };
}

/** Hosts `clientWorkers` marks null: no route, hatchkit's redirect rule
 *  answers them. Throws on a bad map. */
export function redirectedSiteHosts(manifest: SiteManifest): string[] {
  const site = readSiteWorkers(manifest, "-");
  return [...site.hosts].flatMap(([host, w]) => (w === null ? [host] : []));
}

/** Every host and extra route → its Worker, null for a redirected host:
 *  what `status --json` prints as `project.deployment.workers`. */
export function siteWorkerMap(
  manifest: SiteManifest,
  projectDir: string,
): Record<string, string | null> {
  const site = readSiteWorkers(manifest, clientWorkerName(manifest, projectDir));
  return Object.fromEntries([
    ...site.hosts,
    ...site.routes.map((r) => [r.pattern, r.worker] as const),
  ]);
}

/** The Workers on the plan's `<host>/*` routes, host order. */
export function siteWorkers(edge: EdgePlan): string[] {
  const out: string[] = [];
  for (const r of edge.routes) {
    if (r.purpose === "client" && r.script && !out.includes(r.script)) out.push(r.script);
  }
  return out;
}

/** `Worker a` or `Workers a, b`, for messages. */
export function workersPhrase(edge: EdgePlan): string {
  const workers = siteWorkers(edge);
  return workers.length > 1
    ? `Workers ${workers.join(", ")}`
    : `Worker ${workers[0] ?? edge.worker}`;
}

/** One part of the plan per Worker, because preflightEdge checks one.
 *  Each part holds the hosts its Worker has a route on and EVERY planned
 *  route on those hosts, so the diff sees a sibling Worker's route as
 *  planned instead of foreign. Missing routes on a shared host come back
 *  once per part; callers dedupe. */
export function edgeByWorker(edge: EdgePlan): EdgePlan[] {
  const workers = siteWorkers(edge);
  for (const r of edge.routes) {
    if (r.script && !workers.includes(r.script)) workers.push(r.script);
  }
  return workers.map((worker) => {
    const hosts = edge.hosts.filter((h) =>
      edge.routes.some((r) => r.host === h && r.script === worker),
    );
    return { worker, hosts, routes: edge.routes.filter((r) => hosts.includes(r.host)) };
  });
}

/** One zone's share of an edge plan. */
export interface EdgeZone {
  ctx: EdgeContext;
  /** The zone's Worker-served hosts and their routes. */
  edge: EdgePlan;
  /** The zone's hosts that only its redirect rules answer. */
  redirectHosts: string[];
}

/** Split an edge plan, and the hosts the zone redirects, by the zone of
 *  each host. resolveEdgeContext takes one zone per client because it
 *  writes; a read can span several (hydroxyl.app and
 *  chemistry.trebeljahr.com). */
export async function resolveEdgeZones(
  api: CloudflareApi,
  accountId: string,
  edge: EdgePlan,
  redirectHosts: string[] = [],
): Promise<EdgeZone[]> {
  const zones = new Map<string, EdgeZone>();
  const zoneOf = async (host: string): Promise<EdgeZone> => {
    const zone = await api.resolveZoneForName(host);
    if (!zone) throw new Error(`No Cloudflare zone in this account manages ${host}.`);
    let entry = zones.get(zone.id);
    if (!entry) {
      entry = {
        ctx: { api, accountId, zoneId: zone.id, zoneName: zone.name },
        edge: { worker: edge.worker, hosts: [], routes: [] },
        redirectHosts: [],
      };
      zones.set(zone.id, entry);
    }
    return entry;
  };
  for (const host of edge.hosts) (await zoneOf(host)).edge.hosts.push(host);
  for (const host of redirectHosts) (await zoneOf(host)).redirectHosts.push(host);
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
 *   · routes — per zone and Worker, every host has a proxied record, each
 *     planned route sends to its Worker, nothing foreign sits on the
 *     hosts, every Worker has a deployed version, hatchkit's HTTPS rule
 *     covers the Worker hosts; each redirected host has hatchkit's
 *     redirect rule and no route. Leftover ACME routes are a warning.
 *   · live — every host answers 200 on `/` through the edge (a redirected
 *     host after its redirect).
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
  let edge: EdgePlan;
  let redirected: string[];
  try {
    edge = routedWorkerSiteEdge(manifest, projectDir);
    redirected = redirectedSiteHosts(manifest);
  } catch (err) {
    return [{ name: `${name}: routes`, status: "fail", detail: (err as Error).message }];
  }

  if (!deps.cloudflare) {
    out.push({
      name: `${name}: routes`,
      status: "skip",
      detail: "no Cloudflare provisioner to read the zone",
    });
  } else {
    try {
      out.push(await checkZones(name, edge, redirected, deps.cloudflare));
    } catch (err) {
      out.push({ name: `${name}: routes`, status: "fail", detail: (err as Error).message });
    }
  }

  const doFetch = deps.fetch ?? fetch;
  const failures: string[] = [];
  const hosts = [...edge.hosts, ...redirected];
  let reached = 0;
  for (const host of hosts) {
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
          detail: `${hosts.join(", ")} answer 200`,
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
  redirected: string[],
  cf: NonNullable<RoutedSiteCheckDeps["cloudflare"]>,
): Promise<SiteCheck> {
  const problems = new Set<string>();
  const leftovers: string[] = [];
  const live = new Map<string, string[]>();
  const zones = await resolveEdgeZones(cf.api, cf.accountId, edge, redirected);
  for (const zone of zones) {
    const ctx = cf.dnsApi ? { ...zone.ctx, dnsApi: cf.dnsApi } : zone.ctx;
    const zoneRoutes = await cf.api.listWorkerRoutes(ctx.zoneId);
    const stale = leftoverAcmeRoutes(zone.edge, zoneRoutes);
    leftovers.push(...stale.map((r) => `${r.pattern} (${r.id}) on ${ctx.zoneName}`));
    // Plan the leftovers so preflight sees them as present, not foreign.
    const asPlanned: EdgeRoute[] = stale.map((r) => ({
      pattern: r.pattern,
      host: r.pattern.slice(0, r.pattern.indexOf("/")),
      script: null,
      purpose: "acme",
    }));
    const planned = { ...zone.edge, routes: [...asPlanned, ...zone.edge.routes] };
    const httpsMissing = new Set<string>();
    for (const part of edgeByWorker(planned)) {
      const pre = await preflightEdge(ctx, part);
      for (const b of pre.blocking) problems.add(b);
      for (const r of pre.diff.missing) {
        problems.add(`route ${r.pattern} → ${r.script ?? "(no Worker)"} is missing`);
      }
      for (const h of pre.httpsMissing) httpsMissing.add(h);
      if (pre.liveVersions.length) live.set(part.worker, pre.liveVersions);
    }
    if (httpsMissing.size) {
      // One line per zone, hosts in plan order, whichever Worker they are on.
      const hosts = zone.edge.hosts.filter((h) => httpsMissing.has(h));
      problems.add(
        `HTTPS redirect on ${ctx.zoneName} does not cover ${hosts.join(", ")}: \`hatchkit cloudflare https add ${hosts.join(" ")}\``,
      );
    }
    for (const p of await redirectedHostProblems(ctx, zone.redirectHosts, zoneRoutes)) {
      problems.add(p);
    }
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
  const workers = [...live].map(([w, versions]) => `Worker ${w} live (${versions.join(", ")})`);
  const redirects = redirected.length ? `; ${redirected.join(", ")} redirected by the zone` : "";
  return {
    name: `${name}: routes`,
    status: "ok",
    detail: `${edge.routes.length} route(s) on ${zoneNames}, ${workers.join(", ")}${redirects}`,
  };
}

/** A redirected host needs a proxied record (redirect rules run only on
 *  proxied traffic), hatchkit's enabled redirect rule, and no route: the
 *  rule answers first, so a route there serves only `/.well-known/`. */
async function redirectedHostProblems(
  ctx: EdgeContext,
  hosts: string[],
  zoneRoutes: CfWorkerRoute[],
): Promise<string[]> {
  if (hosts.length === 0) return [];
  const problems: string[] = [];
  for (const route of diffEdge({ worker: "", hosts, routes: [] }, zoneRoutes).foreign) {
    problems.push(
      `Route ${route.pattern} → ${route.script || "(no Worker)"} (${route.id}) is on a host clientWorkers marks as redirected (null). Name its Worker there, or delete the route.`,
    );
  }
  const ruleset = await ctx.api.getRedirectRuleset(ctx.zoneId);
  for (const host of hosts) {
    const records = await (ctx.dnsApi ?? ctx.api).findRecordsByName(ctx.zoneId, host);
    const web = records.filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME");
    if (web.length === 0) problems.push(`${host} has no A/AAAA/CNAME record.`);
    else if (web.some((r) => !r.proxied)) {
      problems.push(`${host} has a DNS-only record; redirect rules run only on proxied records.`);
    }
    const rule = findHostRedirectRule(ruleset, host);
    if (!rule) {
      problems.push(
        `${host} has no hatchkit redirect rule on ${ctx.zoneName}: \`hatchkit cloudflare redirect add ${host} <https-origin>\``,
      );
    } else if (rule.enabled === false) {
      problems.push(`hatchkit's redirect rule for ${host} on ${ctx.zoneName} is disabled.`);
    }
  }
  return problems;
}

/** Refuse a `hatchkit cloudflare` setup or undo where its Custom Domain
 *  shape does not apply. Returns the reason, or null to go ahead. */
export function cloudflareSetupRefusal(
  manifest: SiteManifest | null,
  projectDir: string,
  action: "setup" | "undo",
): string | null {
  if (manifest?.clientHost !== "cloudflare") return null;
  let workers = `Worker ${clientWorkerName(manifest, projectDir)}`;
  if (isRoutedWorkerSite(manifest)) {
    try {
      workers = workersPhrase(routedWorkerSiteEdge(manifest, projectDir));
    } catch {
      // A bad clientWorkers map is doctor's to report; refuse all the same.
    }
  }
  const what =
    action === "setup"
      ? "attaches a Custom Domain and writes wrangler.jsonc, _headers, next.config.ts and the deploy workflow"
      : "deletes wrangler.jsonc and the deploy workflow and revokes the Worker's deploy token";
  const instead =
    manifest.deploymentMode === "cloudflare"
      ? "Delete the routes in the dashboard to take the site off the Worker."
      : "`hatchkit migrate-client --rollback` takes the client off the Worker.";
  return action === "setup"
    ? `${manifest.name} is served by ${workers} through Workers routes (clientHost "cloudflare"). ` +
        `\`hatchkit cloudflare\` ${what}, so it does not run here. ` +
        "Still available: `hatchkit cloudflare token`, `hatchkit cloudflare https add|remove`, `hatchkit cloudflare redirect add`."
    : `${manifest.name} is served by ${workers} through Workers routes (clientHost "cloudflare"). ` +
        `\`hatchkit cloudflare --undo\` ${what}, so it does not run here. ${instead}`;
}
