/*
 * Cloudflare Email Routing — access preflight and read-only state probe.
 *
 * The DNS token most hatchkit installs carry is scoped to Zone:DNS:Edit +
 * Zone:Zone:Read. Email Routing lives behind three further permission
 * groups, and a token without them does not get a 403 with a useful
 * message — Cloudflare answers `10000: Authentication error` on the very
 * first GET. Surfacing that raw string sends people looking for an
 * expired token when the token is fine and just lacks scopes.
 *
 * So everything that touches Email Routing (`email setup`, `email
 * status`, migrate-domain's email-routing step, `doctor`) goes through
 * the probe here first, and a missing scope becomes an
 * {@link EmailRoutingScopeError} naming the call that was refused and
 * the one permission group that call needs.
 *
 * Which group guards which call, measured 2026-10-19 with a token that
 * held Email Routing Rules + Email Routing Addresses + DNS on every zone:
 * rules and addresses answered 200, but the zone's routing settings
 * (`GET /zones/{id}/email/routing`) and its DNS view (`…/routing/dns`)
 * answered `10000`. Those two are Zone Settings, not Email Routing.
 *
 * Cloudflare offers no way for a token to list its own permissions
 * without a third scope (API Tokens:Read), so the probe is behavioural:
 * a GET against each permission group's cheapest endpoint. That proves
 * Read, not Edit. The full list names the Edit groups, because Edit is
 * what setup needs and the dashboard's Edit implies Read.
 */

import type {
  CfEmailRoutingSettings,
  CloudflareApi,
  CloudflareZone,
} from "../utils/cloudflare-api.js";

/** The permission groups `hatchkit email setup` needs on the DNS token,
 *  in the dashboard's own wording so they can be found in the token
 *  editor. Zone Settings carries the zone's routing settings, the enable
 *  call and Cloudflare's routing DNS view. */
export const EMAIL_ROUTING_TOKEN_PERMISSIONS = [
  "Zone → Zone Settings → Edit",
  "Zone → Email Routing Rules → Edit",
  "Account → Email Routing Addresses → Edit",
] as const;

/** The reads the probe makes, each with the call it is and the one
 *  permission group that guards it. */
export const EMAIL_ROUTING_PROBE_CALLS = {
  settings: {
    call: "GET /zones/{zone}/email/routing",
    what: "read the zone's Email Routing settings",
    permission: "Zone → Zone Settings → Read",
    edit: "Edit instead of Read only if `hatchkit email setup` should enable routing on the zone",
  },
  destinations: {
    call: "GET /accounts/{account}/email/routing/addresses",
    what: "read the account's forwarding destinations",
    permission: "Account → Email Routing Addresses → Edit",
    edit: "Edit, because `hatchkit email setup` adds and verifies destinations",
  },
} as const;

export type EmailRoutingProbeCall = keyof typeof EMAIL_ROUTING_PROBE_CALLS;

/** Cloudflare's "this token may not do that" responses. `10000` is what
 *  a scope-less token gets on the Email Routing endpoints; `9109` is the
 *  account-level equivalent; a bare 403 covers the rest. */
export function isCloudflareAuthError(message: string): boolean {
  return /\b(10000|9109)\b|authentication error|unauthorized to access|\b403\b|forbidden/i.test(
    message,
  );
}

/** Fix-it lines for a token without the Email Routing scopes. With the
 *  refused call, name that call and only the group it needs; without one,
 *  name every group setup needs. */
export function emailRoutingScopeHint(zoneName?: string, call?: EmailRoutingProbeCall): string[] {
  const on = zoneName ? ` on ${zoneName}` : "";
  const tail = [
    "(keep Zone → DNS → Edit + Zone → Zone → Read; scope the zone permissions to the zones you use)",
    "Then run `hatchkit config add cloudflare` if you created a new token instead of editing the old one.",
  ];
  if (call) {
    const c = EMAIL_ROUTING_PROBE_CALLS[call];
    return [
      `The Cloudflare token may not ${c.what}${on} (${c.call}) — it is missing a permission, not expired.`,
      `Edit the token at https://dash.cloudflare.com/profile/api-tokens and add: ${c.permission}`,
      `(${c.edit}.)`,
      ...tail,
    ];
  }
  return [
    `The Cloudflare token cannot read Email Routing${on} — it is missing permissions, not expired.`,
    `Edit the token at https://dash.cloudflare.com/profile/api-tokens and add: ${EMAIL_ROUTING_TOKEN_PERMISSIONS.join(" + ")}`,
    ...tail,
  ];
}

/** A missing-scope failure with its fix attached. Callers that print
 *  errors one line at a time should print `hint` too. */
export class EmailRoutingScopeError extends Error {
  readonly hint: string[];
  readonly zoneName?: string;
  /** The probe call Cloudflare refused, when known. */
  readonly call?: EmailRoutingProbeCall;

  constructor(zoneName: string | undefined, cause: string, call?: EmailRoutingProbeCall) {
    const answer = cause.replace(/^Cloudflare [A-Z]+ \S+ failed: /, "");
    const where = zoneName ? ` for ${zoneName}` : "";
    super(
      call
        ? `Cloudflare token lacks ${EMAIL_ROUTING_PROBE_CALLS[call].permission}${where}: ${EMAIL_ROUTING_PROBE_CALLS[call].call} answered ${answer}`
        : `Cloudflare token lacks Email Routing permissions${where} (${answer})`,
    );
    this.name = "EmailRoutingScopeError";
    this.zoneName = zoneName;
    this.call = call;
    this.hint = emailRoutingScopeHint(zoneName, call);
  }
}

/** The slice of {@link CloudflareApi} the probe uses — narrow so tests
 *  can hand in a fake without standing up the whole client. */
export type EmailRoutingReader = Pick<
  CloudflareApi,
  "resolveZoneForName" | "getEmailRouting" | "listEmailDestinations" | "findRecordsByName"
>;

export type EmailRoutingProbe =
  | { access: "no-zone"; domain: string }
  | {
      access: "unauthorized";
      domain: string;
      zone: Pick<CloudflareZone, "id" | "name">;
      error: EmailRoutingScopeError;
    }
  | {
      access: "ok";
      domain: string;
      zone: Pick<CloudflareZone, "id" | "name">;
      accountId?: string;
      /** Email Routing switched on for the zone. */
      enabled: boolean;
      settings: CfEmailRoutingSettings | null;
      /** MX targets published at `domain` itself (not the zone apex). */
      mxHosts: string[];
    };

/** True for the MX targets Cloudflare Email Routing publishes. */
export function isCloudflareRoutingMx(host: string): boolean {
  return /(^|\.)mx\.cloudflare\.net\.?$/i.test(host.trim());
}

/**
 * Read Email Routing state for the zone covering `domain`. Read-only.
 * Never throws for a missing scope — that comes back as
 * `access: "unauthorized"` so a planner can still render a row for it.
 * Other failures (network, 5xx) propagate.
 */
export async function probeEmailRouting(
  cf: EmailRoutingReader,
  domain: string,
  opts: { accountId?: string } = {},
): Promise<EmailRoutingProbe> {
  const name = domain.trim().toLowerCase();
  const zone = await cf.resolveZoneForName(name);
  if (!zone) return { access: "no-zone", domain: name };
  const zoneRef = { id: zone.id, name: zone.name };

  let settings: CfEmailRoutingSettings | null;
  try {
    settings = await cf.getEmailRouting(zone.id);
  } catch (err) {
    const msg = (err as Error).message;
    if (!isCloudflareAuthError(msg)) throw err;
    return {
      access: "unauthorized",
      domain: name,
      zone: zoneRef,
      error: new EmailRoutingScopeError(zone.name, msg, "settings"),
    };
  }

  // Destinations are account-scoped and guarded by a separate permission
  // group. A token can hold the zone group and not this one, and then
  // setup gets as far as enabling routing before it fails.
  const accountId = opts.accountId ?? zone.account?.id;
  if (accountId) {
    try {
      await cf.listEmailDestinations(accountId);
    } catch (err) {
      const msg = (err as Error).message;
      if (!isCloudflareAuthError(msg)) throw err;
      return {
        access: "unauthorized",
        domain: name,
        zone: zoneRef,
        error: new EmailRoutingScopeError(zone.name, msg, "destinations"),
      };
    }
  }

  const mx = await cf.findRecordsByName(zone.id, name, "MX");
  return {
    access: "ok",
    domain: name,
    zone: zoneRef,
    accountId,
    enabled: settings?.enabled === true,
    settings,
    mxHosts: mx.map((r) => r.content.replace(/\.$/, "").toLowerCase()),
  };
}

/** Throwing form of the probe, for executors: resolves the zone and
 *  proves the scopes, or throws something a human can act on. */
export async function assertEmailRoutingAccess(
  cf: EmailRoutingReader,
  domain: string,
  opts: { accountId?: string } = {},
): Promise<Extract<EmailRoutingProbe, { access: "ok" }>> {
  const probe = await probeEmailRouting(cf, domain, opts);
  if (probe.access === "unauthorized") throw probe.error;
  if (probe.access === "no-zone") {
    throw new Error(
      `No Cloudflare zone for "${domain}" or its parent domains. Add the zone to your CF account and re-run.`,
    );
  }
  return probe;
}

/** Pure summary of a probe for planners: what an Email Routing step on
 *  this domain would find. Kept as plain data so `migrate/plan.ts` stays
 *  free of network types. */
export type EmailRoutingFacts =
  /** Routing on, and Cloudflare's MX published at the domain. */
  | { state: "receiving"; zone: string }
  /** The domain's MX points somewhere else (Google, Fastmail, …). */
  | { state: "foreign-mx"; zone: string; mxHosts: string[] }
  /** Zone exists, routing on but no MX — or routing off. */
  | { state: "not-receiving"; zone: string; enabled: boolean }
  | { state: "unauthorized"; zone: string }
  | { state: "no-zone" }
  /** Not probed (no DNS token) or the probe errored. */
  | { state: "unknown"; reason: string };

export function summarizeEmailRoutingProbe(probe: EmailRoutingProbe): EmailRoutingFacts {
  if (probe.access === "no-zone") return { state: "no-zone" };
  if (probe.access === "unauthorized") return { state: "unauthorized", zone: probe.zone.name };
  const cfMx = probe.mxHosts.some(isCloudflareRoutingMx);
  const foreign = probe.mxHosts.filter((h) => !isCloudflareRoutingMx(h));
  if (foreign.length > 0 && !cfMx) {
    return { state: "foreign-mx", zone: probe.zone.name, mxHosts: foreign };
  }
  if (probe.enabled && cfMx) return { state: "receiving", zone: probe.zone.name };
  return { state: "not-receiving", zone: probe.zone.name, enabled: probe.enabled };
}
