/*
 * The Cloudflare half of a client served from Workers static assets
 * (`clientHost: "cloudflare"`): the zone's Workers routes and the
 * HTTP→HTTPS redirect for the hosts the Worker serves.
 *
 * deploy/routing.ts decides WHAT the routes are (pure, `edge` on the
 * routing plan). This module reads the zone, diffs, checks the
 * preconditions and makes or removes routes in the order that keeps the
 * site up:
 *
 *   create   no-Worker routes first (inert alone), `<host>/*` last — the
 *            last call is the whole cutover;
 *   remove   `<host>/*` first — Traefik answers again within seconds
 *            (8 s measured on the canary) — then the no-Worker routes.
 *
 * HTTPS. A Worker on a route answers plain HTTP with 200 (canary check
 * E6); Traefik used to redirect. The fix is ONE Single Redirect rule per
 * zone, owned by hatchkit, listing every Worker-served host:
 *
 *   not ssl and http.host in {…}
 *   and not starts_with(http.request.uri.path, "/.well-known/")
 *
 * Not the zone's Always Use HTTPS. That one redirects
 * `/.well-known/acme-challenge/*` too, so Traefik's HTTP-01 renewals
 * (and a Shopify-proxied host on trebeljahr.com) would break, and it
 * reaches every proxied host on the zone — including second-level names
 * like `api.<project>.trebeljahr.com` that Universal SSL does not cover,
 * which then redirect into a TLS handshake failure. Checked 2026-10-15.
 * Free zones get 10 Single Redirect rules; this takes one.
 */

import type {
  CfRedirectRule,
  CfRuleset,
  CfWorkerRoute,
  CloudflareApi,
} from "../utils/cloudflare-api.js";
import type { RunLedger } from "../utils/run-ledger.js";
import { type EdgePlan, type EdgeRoute, edgeRemovalOrder } from "./routing.js";

// ---------------------------------------------------------------------------
// Diff (pure)
// ---------------------------------------------------------------------------

export interface EdgeDiff {
  /** Plan routes that exist with the right Worker (or none). */
  present: Array<{ want: EdgeRoute; have: CfWorkerRoute }>;
  /** Plan routes the zone lacks, in creation order. */
  missing: EdgeRoute[];
  /** A route with the plan's pattern that names a different Worker. */
  wrongScript: Array<{ want: EdgeRoute; have: CfWorkerRoute }>;
  /** Other routes that match one of the plan's hosts. hatchkit never
   *  deletes these; they must be resolved by hand before a cutover. */
  foreign: CfWorkerRoute[];
}

/** Host part of a route pattern (`*.example.com/*` → `*.example.com`). */
export function patternHost(pattern: string): string {
  const slash = pattern.indexOf("/");
  return (slash === -1 ? pattern : pattern.slice(0, slash)).toLowerCase();
}

/** Does a route's host part (which may contain `*`) match `host`? */
export function routeHostMatches(patternHostPart: string, host: string): boolean {
  const escaped = patternHostPart
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(host);
}

const sameScript = (want: string | null, have: string | null | undefined): boolean =>
  (want ?? null) === (have || null);

export function diffEdge(edge: EdgePlan, zoneRoutes: CfWorkerRoute[]): EdgeDiff {
  const diff: EdgeDiff = { present: [], missing: [], wrongScript: [], foreign: [] };
  const byPattern = new Map(zoneRoutes.map((r) => [r.pattern, r]));
  for (const want of edge.routes) {
    const have = byPattern.get(want.pattern);
    if (!have) diff.missing.push(want);
    else if (sameScript(want.script, have.script)) diff.present.push({ want, have });
    else diff.wrongScript.push({ want, have });
  }
  const planned = new Set(edge.routes.map((r) => r.pattern));
  for (const route of zoneRoutes) {
    if (planned.has(route.pattern)) continue;
    const host = patternHost(route.pattern);
    if (edge.hosts.some((h) => routeHostMatches(host, h))) diff.foreign.push(route);
  }
  return diff;
}

// ---------------------------------------------------------------------------
// HTTPS redirect rule (pure)
// ---------------------------------------------------------------------------

/** `ref` of hatchkit's one HTTPS rule per zone. */
export const HTTPS_RULE_REF = "hatchkit_https_worker_hosts";
const HTTPS_RULE_DESCRIPTION = "hatchkit: HTTP to HTTPS for Worker-served hosts";

/** The rule for `hosts` (sorted, deduped). */
export function renderHttpsRedirectRule(hosts: string[]): CfRedirectRule {
  const set = [...new Set(hosts.map((h) => h.toLowerCase()))].sort();
  if (set.length === 0) throw new Error("renderHttpsRedirectRule needs at least one host");
  for (const h of set) {
    if (!/^[a-z0-9.-]+$/.test(h)) throw new Error(`Not a hostname: ${h}`);
  }
  return {
    ref: HTTPS_RULE_REF,
    description: HTTPS_RULE_DESCRIPTION,
    expression:
      // `not ssl`, not `http.request.scheme eq "http"`: a Free zone's rule
      // validator rejects that field as an unknown identifier
      // (trackyourtime.dev, 2026-10-18).
      `(not ssl and http.host in {${set.map((h) => `"${h}"`).join(" ")}}` +
      ` and not starts_with(http.request.uri.path, "/.well-known/"))`,
    action: "redirect",
    enabled: true,
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: { expression: 'concat("https://", http.host, http.request.uri.path)' },
        preserve_query_string: true,
      },
    },
  };
}

/** Hosts listed by hatchkit's rule, or null when `rule` is not in the
 *  shape {@link renderHttpsRedirectRule} writes (hand-edited). */
export function parseHttpsRuleHosts(rule: Pick<CfRedirectRule, "expression">): string[] | null {
  const m = rule.expression.match(
    /^\((?:not ssl|http\.request\.scheme eq "http") and http\.host in \{([^}]*)\} and not starts_with\(http\.request\.uri\.path, "\/\.well-known\/"\)\)$/,
  );
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

export function findHttpsRule(ruleset: CfRuleset | null): CfRedirectRule | undefined {
  return ruleset?.rules?.find(
    (r) => r.ref === HTTPS_RULE_REF || r.description === HTTPS_RULE_DESCRIPTION,
  );
}

/**
 * A hostname that only redirects to another site (a project that moved
 * to its own domain), served by the zone instead of a Coolify app:
 *
 *   http.host eq "<host>" and not starts_with(http.request.uri.path, "/.well-known/")
 *   → <status> to concat("<target origin>", http.request.uri.path), query kept
 *
 * `/.well-known/` stays on the origin so a certificate Traefik still holds
 * for the host keeps renewing until its app is retired.
 */
export function renderHostRedirectRule(
  host: string,
  targetOrigin: string,
  status: 301 | 302 | 307 | 308,
): CfRedirectRule {
  const h = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h)) throw new Error(`Not a hostname: ${host}`);
  const target = new URL(targetOrigin);
  if (target.protocol !== "https:" || target.pathname !== "/" || target.search || target.hash) {
    throw new Error(`Redirect target must be a bare https origin, got ${targetOrigin}`);
  }
  if (target.hostname === h) throw new Error(`${host} cannot redirect to itself`);
  return {
    ref: hostRedirectRef(h),
    description: `hatchkit: redirect ${h} to ${target.origin}`,
    expression: `(http.host eq "${h}" and not starts_with(http.request.uri.path, "/.well-known/"))`,
    action: "redirect",
    enabled: true,
    action_parameters: {
      from_value: {
        status_code: status,
        target_url: { expression: `concat("${target.origin}", http.request.uri.path)` },
        preserve_query_string: true,
      },
    },
  };
}

/** hatchkit's redirect rule for `host`: by `ref`, or — for one made in
 *  the dashboard from hatchkit's values, which gets no ref — by its
 *  description. */
function isHostRedirectRule(rule: CfRedirectRule, host: string): boolean {
  const h = host.toLowerCase();
  return (
    rule.ref === hostRedirectRef(h) || !!rule.description?.startsWith(`hatchkit: redirect ${h} to `)
  );
}

export function hostRedirectRef(host: string): string {
  return `hatchkit_redirect_${host.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface EdgeContext {
  api: CloudflareApi;
  accountId: string;
  zoneId: string;
  zoneName: string;
  /** Client for DNS reads: hatchkit's DNS token (`config add dns`), which
   *  reads every zone's records. The Workers provisioner may not hold
   *  Zone → DNS on a zone (trebeljahr.com, 2026-10-18). Falls back to
   *  `api`. */
  dnsApi?: Pick<CloudflareApi, "findRecordsByName">;
}

/** Resolve the zone of the primary host. Every host of one project must
 *  be in the same zone; a second zone is reported, not handled. */
export async function resolveEdgeContext(
  api: CloudflareApi,
  accountId: string,
  edge: EdgePlan,
): Promise<EdgeContext> {
  const zone = await api.resolveZoneForName(edge.hosts[0]);
  if (!zone) throw new Error(`No Cloudflare zone in this account manages ${edge.hosts[0]}.`);
  for (const host of edge.hosts.slice(1)) {
    const other = await api.resolveZoneForName(host);
    if (other?.id !== zone.id) {
      throw new Error(
        `${host} is not in zone ${zone.name}. hatchkit handles one zone per client; route it by hand.`,
      );
    }
  }
  return { api, accountId, zoneId: zone.id, zoneName: zone.name };
}

export interface EdgePreflight {
  diff: EdgeDiff;
  /** Problems that block a cutover. Each names what to fix. */
  blocking: string[];
  /** Hosts the HTTPS rule must still gain. */
  httpsMissing: string[];
  /** Newest deployment's version ids, empty when the Worker has none. */
  liveVersions: string[];
}

/**
 * Everything checked before the first write, read-only:
 *
 *   · every host has a PROXIED record (routes run only on proxied ones);
 *   · no route on these hosts that the plan does not name, and no plan
 *     pattern pointing at another Worker;
 *   · the Worker exists and has a deployed version (a route to an empty
 *     Worker serves nothing);
 *   · hatchkit's HTTPS rule, if present, is in hatchkit's shape.
 */
export async function preflightEdge(ctx: EdgeContext, edge: EdgePlan): Promise<EdgePreflight> {
  const blocking: string[] = [];
  const routes = await ctx.api.listWorkerRoutes(ctx.zoneId);
  const diff = diffEdge(edge, routes);
  for (const route of diff.foreign) {
    blocking.push(
      `Foreign Workers route ${route.pattern} → ${route.script || "(no Worker)"} (${route.id}) matches a client host. hatchkit does not delete routes it did not make; remove or change it in the dashboard.`,
    );
  }
  for (const { want, have } of diff.wrongScript) {
    blocking.push(
      `Route ${have.pattern} sends to ${have.script || "(no Worker)"}, expected ${want.script || "(no Worker)"} (${have.id}).`,
    );
  }

  for (const host of edge.hosts) {
    const records = await (ctx.dnsApi ?? ctx.api).findRecordsByName(ctx.zoneId, host);
    const web = records.filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME");
    if (web.length === 0) blocking.push(`${host} has no A/AAAA/CNAME record.`);
    else if (web.some((r) => !r.proxied)) {
      blocking.push(
        `${host} has a DNS-only record; Workers routes run only on proxied records. Turn the proxy on first (it changes nothing else for a site already on HTTPS).`,
      );
    }
  }

  let liveVersions: string[] = [];
  const worker = await ctx.api.getWorker(ctx.accountId, edge.worker);
  if (!worker) blocking.push(`Worker ${edge.worker} does not exist.`);
  else {
    const deployments = await ctx.api.listWorkerDeployments(ctx.accountId, edge.worker);
    liveVersions = deployments[0]?.versions.map((v) => v.version_id) ?? [];
    if (liveVersions.length === 0) {
      blocking.push(
        `Worker ${edge.worker} has no deployed version; deploy one (\`wrangler versions deploy\`) before routing traffic to it.`,
      );
    }
  }

  const ruleset = await ctx.api.getRedirectRuleset(ctx.zoneId);
  const rule = findHttpsRule(ruleset);
  let httpsMissing = [...edge.hosts];
  if (rule) {
    const hosts = parseHttpsRuleHosts(rule);
    if (!hosts) {
      blocking.push(
        `The zone's "${rule.description}" redirect rule was edited by hand; hatchkit will not rewrite it. Restore its expression or add the hosts yourself.`,
      );
    } else httpsMissing = edge.hosts.filter((h) => !hosts.includes(h));
  }
  return { diff, blocking, httpsMissing, liveVersions };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Add `hosts` to hatchkit's HTTPS rule, creating the rule (or the
 *  zone's redirect ruleset) when absent. Records the hosts it added. */
export async function addHttpsRedirectHosts(
  ctx: EdgeContext,
  hosts: string[],
  ledger?: RunLedger,
): Promise<{ added: string[]; ruleHosts: string[] }> {
  const ruleset = await ctx.api.getRedirectRuleset(ctx.zoneId);
  const rule = findHttpsRule(ruleset);
  const current = rule ? parseHttpsRuleHosts(rule) : [];
  if (current === null) throw new Error("hatchkit's HTTPS redirect rule was edited by hand.");
  const added = hosts.filter((h) => !current.includes(h));
  if (added.length === 0) return { added, ruleHosts: current };
  const next = renderHttpsRedirectRule([...current, ...added]);
  if (rule?.id && ruleset) await ctx.api.updateRedirectRule(ctx.zoneId, ruleset.id, rule.id, next);
  else await ctx.api.addRedirectRule(ctx.zoneId, next);
  ledger?.record({ kind: "cloudflareRedirectHosts", zoneId: ctx.zoneId, hosts: added });
  return { added, ruleHosts: [...current, ...added].sort() };
}

/** Remove `hosts` from hatchkit's HTTPS rule; deletes the rule when no
 *  host is left. Never touches another rule. */
export async function removeHttpsRedirectHosts(
  api: CloudflareApi,
  zoneId: string,
  hosts: string[],
): Promise<"updated" | "deleted" | "not-found"> {
  const ruleset = await api.getRedirectRuleset(zoneId);
  const rule = findHttpsRule(ruleset);
  if (!rule?.id || !ruleset) return "not-found";
  const current = parseHttpsRuleHosts(rule);
  if (current === null) throw new Error("hatchkit's HTTPS redirect rule was edited by hand.");
  const remaining = current.filter((h) => !hosts.includes(h));
  if (remaining.length === current.length) return "not-found";
  if (remaining.length === 0) {
    await api.deleteRedirectRule(zoneId, ruleset.id, rule.id);
    return "deleted";
  }
  await api.updateRedirectRule(zoneId, ruleset.id, rule.id, renderHttpsRedirectRule(remaining));
  return "updated";
}

/** Create or update hatchkit's redirect rule for `host`. Refuses when a
 *  rule not made by hatchkit already matches the host by equality. */
export async function upsertHostRedirect(
  ctx: Pick<EdgeContext, "api" | "zoneId">,
  host: string,
  targetOrigin: string,
  status: 301 | 302 | 307 | 308,
  ledger?: RunLedger,
): Promise<"created" | "updated" | "unchanged"> {
  const rule = renderHostRedirectRule(host, targetOrigin, status);
  const ruleset = await ctx.api.getRedirectRuleset(ctx.zoneId);
  const ours = ruleset?.rules?.find((r) => isHostRedirectRule(r, host));
  const foreign = ruleset?.rules?.find(
    (r) => r !== ours && r.expression.includes(`http.host eq "${host.toLowerCase()}"`),
  );
  if (foreign) {
    throw new Error(
      `Redirect rule "${foreign.description ?? foreign.id}" already matches ${host}; hatchkit leaves it alone.`,
    );
  }
  if (ours?.id && ruleset) {
    if (
      ours.expression === rule.expression &&
      JSON.stringify(ours.action_parameters) === JSON.stringify(rule.action_parameters)
    ) {
      return "unchanged";
    }
    await ctx.api.updateRedirectRule(ctx.zoneId, ruleset.id, ours.id, rule);
    return "updated";
  }
  await ctx.api.addRedirectRule(ctx.zoneId, rule);
  ledger?.record({ kind: "cloudflareHostRedirect", zoneId: ctx.zoneId, host: host.toLowerCase() });
  return "created";
}

/** Delete hatchkit's redirect rule for `host`. */
export async function removeHostRedirect(
  api: CloudflareApi,
  zoneId: string,
  host: string,
): Promise<"deleted" | "not-found"> {
  const ruleset = await api.getRedirectRuleset(zoneId);
  const ours = ruleset?.rules?.find((r) => isHostRedirectRule(r, host));
  if (!ours?.id || !ruleset) return "not-found";
  return api.deleteRedirectRule(zoneId, ruleset.id, ours.id);
}

export interface ApplyEdgeOptions {
  /** Stop before the Worker routes (`<host>/*`): makes only the inert
   *  no-Worker routes. */
  originRoutesOnly?: boolean;
  ledger?: RunLedger;
  /** Called after each route, for progress output. */
  onRoute?: (route: EdgeRoute, outcome: "created" | "present") => void;
}

/** Create the plan's missing routes in creation order. Refuses while the
 *  diff has foreign or wrong-script routes. Returns the routes created. */
export async function applyEdgeRoutes(
  ctx: EdgeContext,
  edge: EdgePlan,
  opts: ApplyEdgeOptions = {},
): Promise<EdgeRoute[]> {
  const diff = diffEdge(edge, await ctx.api.listWorkerRoutes(ctx.zoneId));
  if (diff.foreign.length || diff.wrongScript.length) {
    throw new Error(
      "The zone has routes on these hosts that hatchkit did not plan; see preflight.",
    );
  }
  const missing = new Set(diff.missing.map((r) => r.pattern));
  const created: EdgeRoute[] = [];
  for (const route of edge.routes) {
    if (opts.originRoutesOnly && route.script !== null) break;
    if (!missing.has(route.pattern)) {
      opts.onRoute?.(route, "present");
      continue;
    }
    const made = await ctx.api.createWorkerRoute(ctx.zoneId, route.pattern, route.script);
    opts.ledger?.record({
      kind: "cloudflareWorkerRoute",
      zoneId: ctx.zoneId,
      routeId: made.id,
      pattern: route.pattern,
      script: route.script,
    });
    created.push(route);
    opts.onRoute?.(route, "created");
  }
  return created;
}

/** Delete the plan's routes in removal order (`<host>/*` first). Only
 *  routes whose pattern AND Worker match the plan are touched. Pass
 *  `clientOnly` to stop after the Worker routes (a rollback that keeps
 *  the inert no-Worker routes). */
export async function removeEdgeRoutes(
  ctx: Pick<EdgeContext, "api" | "zoneId">,
  edge: EdgePlan,
  opts: { clientOnly?: boolean; onRoute?: (route: EdgeRoute, outcome: string) => void } = {},
): Promise<EdgeRoute[]> {
  const zoneRoutes = await ctx.api.listWorkerRoutes(ctx.zoneId);
  const removed: EdgeRoute[] = [];
  for (const route of edgeRemovalOrder(edge)) {
    if (opts.clientOnly && route.script === null) break;
    const have = zoneRoutes.find(
      (r) => r.pattern === route.pattern && sameScript(route.script, r.script),
    );
    if (!have) {
      opts.onRoute?.(route, "absent");
      continue;
    }
    const outcome = await ctx.api.deleteWorkerRoute(ctx.zoneId, have.id);
    removed.push(route);
    opts.onRoute?.(route, outcome);
  }
  return removed;
}
