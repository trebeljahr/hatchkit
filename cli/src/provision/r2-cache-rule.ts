/**
 * Edge cache for an R2 bucket's custom domain.
 *
 * Why this exists: an R2 custom domain answers `cf-cache-status:
 * DYNAMIC` on every request, even for `.webp`/`.avif` objects with
 * `cache-control: public, max-age=31536000, immutable`. Every first
 * view of an object then travels to the bucket's single R2 location,
 * which is slow for readers far from it. A Cache Rule that marks the
 * hostname "eligible for cache" turns those into edge HITs.
 *
 * The rule hatchkit owns, one per hostname, found by its description:
 *
 *   description  "hatchkit: cache <host>"
 *   expression   (http.host eq "<host>")
 *   action       set_cache_settings
 *                cache: true
 *                edge_ttl: respect_origin   (the object's cache-control
 *                                            wins; Cloudflare's default
 *                                            TTLs apply without one)
 *                status_code_ttl: 400+ → no-store
 *
 * The status-code entry keeps error answers out of the cache: without
 * it Cloudflare keeps a 404 for 3 minutes, so a variant probed before
 * its upload would stay missing after it. Cloudflare documents
 * status-code TTLs in Cache Rules for every plan; should a zone refuse
 * the field anyway, the rule is written without it and the result says
 * so.
 *
 * Only hatchkit's own rule is ever written. Other rules in the phase
 * stay as they are, and an enabled bypass rule that may match the
 * hostname stops the write: it is the likely reason the host is
 * DYNAMIC, and someone put it there on purpose.
 */
import {
  type CfCacheRule,
  type CfCacheRuleset,
  type CloudflareApi,
  isCloudflareAuthError,
} from "../utils/cloudflare-api.js";

export type CacheRuleApi = Pick<
  CloudflareApi,
  "getCacheRuleset" | "addCacheRule" | "updateCacheRule"
>;

export function cacheRuleDescription(host: string): string {
  return `hatchkit: cache ${host}`;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** The rule hatchkit wants for `host`. `statusCodeTtl: false` is the
 *  fallback for a zone that refuses status-code TTLs. */
export function desiredCacheRule(host: string, opts: { statusCodeTtl: boolean }): CfCacheRule {
  if (!HOST_RE.test(host)) throw new Error(`Not a hostname: ${JSON.stringify(host)}`);
  return {
    description: cacheRuleDescription(host),
    expression: `(http.host eq "${host.toLowerCase()}")`,
    action: "set_cache_settings",
    enabled: true,
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "respect_origin",
        ...(opts.statusCodeTtl
          ? { status_code_ttl: [{ status_code_range: { from: 400 }, value: -1 }] }
          : {}),
      },
    },
  };
}

/** Whether an existing rule already does what `want` does. Compares only
 *  the fields hatchkit writes. */
export function cacheRuleMatches(have: CfCacheRule, want: CfCacheRule): boolean {
  const h = have.action_parameters ?? {};
  const w = want.action_parameters;
  return (
    have.expression === want.expression &&
    have.action === want.action &&
    have.enabled !== false &&
    h.cache === w.cache &&
    h.edge_ttl?.mode === w.edge_ttl?.mode &&
    JSON.stringify(h.edge_ttl?.status_code_ttl ?? []) ===
      JSON.stringify(w.edge_ttl?.status_code_ttl ?? [])
  );
}

/** Enabled rules, other than hatchkit's own for `host`, that bypass the
 *  cache and may match `host`. A bypass scoped to exactly one other
 *  hostname (`http.host eq "other"`) cannot match and is left out;
 *  every other bypass expression counts, since this code does not
 *  evaluate Cloudflare's rule language. */
export function bypassConflicts(ruleset: CfCacheRuleset | null, host: string): CfCacheRule[] {
  const own = cacheRuleDescription(host);
  return (ruleset?.rules ?? []).filter((r) => {
    if (r.description === own || r.enabled === false) return false;
    const p = r.action_parameters ?? {};
    const bypasses = p.cache === false || p.edge_ttl?.mode === "bypass_by_default";
    if (!bypasses) return false;
    const single = r.expression.match(/^\(?\s*http\.host\s+eq\s+"([^"]+)"\s*\)?$/);
    return !(single && single[1].toLowerCase() !== host.toLowerCase());
  });
}

/** A refusal of the status-code TTL field rather than of the request
 *  as a whole (plan entitlement). */
function isStatusCodeTtlRefusal(err: unknown): boolean {
  if (isCloudflareAuthError(err)) return false;
  return /status_code_ttl|status code ttl|entitle|not (available|allowed) (on|for) (your|this) plan/i.test(
    (err as Error).message ?? "",
  );
}

export interface EnsureCacheRuleResult {
  action: "created" | "updated" | "unchanged" | "would-create" | "would-update";
  /** False when the zone refused status-code TTLs and the rule went in
   *  without them (error answers then follow Cloudflare's defaults). */
  statusCodeTtl: boolean;
  /** Bypass rules that may match the host. Non-empty only on a dry run
   *  or with `overrideBypass`; otherwise the call throws. */
  conflicts: CfCacheRule[];
}

export class CacheRuleConflictError extends Error {
  constructor(
    readonly host: string,
    readonly conflicts: CfCacheRule[],
  ) {
    super(
      [
        `The zone already has ${conflicts.length === 1 ? "a Cache Rule" : "Cache Rules"} that bypass the cache and may match ${host}:`,
        ...conflicts.map(
          (r) =>
            `  • ${r.description || "(no description)"}${r.id ? ` [${r.id}]` : ""}: ${r.expression}`,
        ),
        "That is probably why the host answers cf-cache-status: DYNAMIC. hatchkit did not add its rule.",
        "Review the rule in the dashboard (Caching → Cache Rules). Re-run with --override-bypass to add hatchkit's rule after it anyway (the later rule wins).",
      ].join("\n"),
    );
  }
}

/** Make sure the zone caches `host` at the edge. Idempotent: an
 *  up-to-date rule is left alone, an outdated one is patched in place,
 *  a missing one is appended after every other rule. */
export async function ensureR2CacheRule(
  api: CacheRuleApi,
  zoneId: string,
  host: string,
  opts: { dryRun?: boolean; overrideBypass?: boolean } = {},
): Promise<EnsureCacheRuleResult> {
  const full = desiredCacheRule(host, { statusCodeTtl: true });
  const lite = desiredCacheRule(host, { statusCodeTtl: false });
  const ruleset = await api.getCacheRuleset(zoneId);
  const existing = ruleset?.rules?.find((r) => r.description === full.description);
  const conflicts = bypassConflicts(ruleset, host);

  if (existing && cacheRuleMatches(existing, full)) {
    return { action: "unchanged", statusCodeTtl: true, conflicts };
  }
  if (opts.dryRun) {
    return { action: existing ? "would-update" : "would-create", statusCodeTtl: true, conflicts };
  }
  if (conflicts.length > 0 && !opts.overrideBypass) {
    throw new CacheRuleConflictError(host, conflicts);
  }

  const write = (rule: CfCacheRule) =>
    existing?.id && ruleset
      ? api.updateCacheRule(zoneId, ruleset.id, existing.id, rule)
      : api.addCacheRule(zoneId, rule);
  const action = existing ? "updated" : "created";
  try {
    await write(full);
    return { action, statusCodeTtl: true, conflicts };
  } catch (err) {
    if (!isStatusCodeTtlRefusal(err)) throw err;
    if (existing && cacheRuleMatches(existing, lite)) {
      return { action: "unchanged", statusCodeTtl: false, conflicts };
    }
    await write(lite);
    return { action, statusCodeTtl: false, conflicts };
  }
}

export type CacheRuleHostApi = CacheRuleApi &
  Pick<CloudflareApi, "getZoneByName" | "purgeCacheByHosts">;

/** The registrable zone name of a hostname (last two labels). Same rule
 *  `provision s3` uses to find the zone for the custom domain. */
export function zoneNameForHost(host: string): string {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/** Find the zone for `host`, ensure its Cache Rule, then (only when
 *  asked, never on a dry run) purge the host's cached files. */
export async function applyR2CacheRule(
  api: CacheRuleHostApi,
  host: string,
  opts: { dryRun?: boolean; overrideBypass?: boolean; purge?: boolean } = {},
): Promise<EnsureCacheRuleResult & { zoneId: string; zoneName: string; purged: boolean }> {
  const zoneName = zoneNameForHost(host);
  const zone = await api.getZoneByName(zoneName);
  if (!zone) throw new Error(`No Cloudflare zone ${zoneName} visible to the token (for ${host}).`);
  const result = await ensureR2CacheRule(api, zone.id, host, opts);
  let purged = false;
  if (opts.purge && !opts.dryRun) {
    await api.purgeCacheByHosts(zone.id, [host]);
    purged = true;
  }
  return { ...result, zoneId: zone.id, zoneName: zone.name, purged };
}
