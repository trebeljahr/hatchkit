/*
 * Deployment-topology checks — the four facts about splitting a
 * deployment across two applications, expressed as things a machine can
 * decide rather than prose a person has to remember.
 *
 * ---------------------------------------------------------------------
 * The failures these encode
 * ---------------------------------------------------------------------
 *
 * Every rule below was paid for by a production outage on a real
 * project, and each one is invisible until it is live:
 *
 *   1. **One application for both halves couples their restarts.** The
 *      unit of deployment is the application, so a client-only deploy
 *      restarts the server too and drops every connected socket. The
 *      fix is two applications — which is what pulls in 2, 3 and 4.
 *   2. **The service name inside a compose file is load-bearing.** The
 *      platform keys its domain routing by service name. A key naming a
 *      service the compose does not declare is accepted by the API with
 *      a success response, emits no proxy labels at all, and the site
 *      answers a gateway error. "The API said 200 and the site is
 *      broken" is the signature. → {@link serviceNameFindings}.
 *   3. **The proxy merges same-host site blocks and strips the matched
 *      path prefix.** So two applications cannot be split by path on
 *      one host: both write the same site, the merge picks one, and the
 *      winner swallows the other's traffic. Even ordered correctly, the
 *      strip removes the prefix the API mounts its routes at, so every
 *      request arrives one segment short. Each application needs a host
 *      of its own. → the `domain-carries-path` and `hosts-collide`
 *      findings.
 *   4. **A host of its own needs a certificate covering that host.** A
 *      wildcard certificate covers exactly ONE label below its zone. An
 *      API host two labels below the zone fails TLS before any HTTP
 *      happens, and no amount of correct routing is visible behind
 *      that. This is the constraint that decides where a project's
 *      domain can live. → {@link labelsBelowZone} and the
 *      `api-host-beyond-wildcard` finding.
 *
 * Everything here is pure: no I/O, no network, no filesystem. `hatchkit
 * doctor` calls {@link topologyAdvice} to report without writing
 * anything, and the docs in ./docs.ts render the same facts for a
 * person.
 *
 * ---------------------------------------------------------------------
 * The rule about what may be said
 * ---------------------------------------------------------------------
 *
 * A finding a project cannot act on is noise, and noise is what teaches
 * people to skip the output. A single-origin project has no API host,
 * so it never hears about wildcard coverage; a static project has no
 * server half, so it never hears about an API DNS record at all.
 */

import type { Topology } from "../../deploy/routing.js";
import type { Surface } from "../../prompts.js";
import { hasClientHalf, hasServerHalf } from "../operational-context.js";

// ---------------------------------------------------------------------------
// Hostname arithmetic
// ---------------------------------------------------------------------------

/** Public suffixes that are two labels long, so that the "registrable
 *  domain is the last two labels" heuristic would cut them in half.
 *
 *  Deliberately a handful, not a list: the real public-suffix list has
 *  thousands of entries, changes, and would need to be vendored and
 *  refreshed. Pretending to it would be worse than being honest — the
 *  zone is an input callers can pass explicitly ({@link inferZone}'s
 *  `opts.zone`), and the generated documentation says to pass it when
 *  the heuristic is wrong. */
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "com.mx",
  "com.sg",
  "co.za",
  "co.in",
  "co.kr",
]);

/** A hostname as the platform stores it: lowercase, no scheme, no path,
 *  no port, no trailing dot. Accepts the sloppy forms people actually
 *  type into a manifest (`https://Example.dev/`) so a check never fails
 *  for a reason the user cannot see. */
export function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split("/")[0] ?? "";
  host = host.split("?")[0] ?? "";
  host = host.replace(/:\d+$/, "");
  return host.replace(/\.$/, "");
}

/** The path a domain value carries, or "/" when it carries none.
 *
 *  This is fact 3 as a one-liner: a domain value with a path on it is
 *  what makes the platform emit a prefix-stripping route, and the
 *  stripped prefix is exactly the mount point the API serves its routes
 *  at. A value is either a bare host or a bug. */
export function pathInDomain(value: string): string {
  const withoutScheme = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) return "/";
  const path = withoutScheme.slice(slash);
  return path === "" ? "/" : path;
}

/** How many labels `host` sits below `zone`.
 *
 *  0 means the host IS the zone (the apex). 1 is what a wildcard
 *  certificate for the zone covers — `*.zone` matches exactly one
 *  label. Anything greater than 1 is the wildcard trap: TLS fails at
 *  the handshake, before a single HTTP byte, and every routing check
 *  downstream of it reports nothing useful.
 *
 *  -1 means the host is not under the zone at all, which is a caller
 *  error rather than a certificate problem — the checks treat it as
 *  "nothing to say" instead of inventing a finding. */
export function labelsBelowZone(host: string, zone: string): number {
  const h = normalizeHost(host);
  const z = normalizeHost(zone);
  if (!h || !z) return -1;
  if (h === z) return 0;
  if (!h.endsWith(`.${z}`)) return -1;
  const prefix = h.slice(0, -(z.length + 1));
  return prefix.split(".").filter(Boolean).length;
}

/** The registrable domain a host's certificates are issued for.
 *
 *  The heuristic is the last two labels, corrected by the small
 *  multi-part suffix set above. It is a heuristic and says so: callers
 *  that know better pass `opts.zone`, and it is returned untouched
 *  (beyond normalization) so an explicit zone always wins. */
export function inferZone(domain: string, opts?: { zone?: string }): string {
  if (opts?.zone) return normalizeHost(opts.zone);
  const host = normalizeHost(domain);
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Stable identifiers. They are what `hatchkit doctor` keys its output
 *  on and what a test asserts against, so they never change meaning —
 *  a new situation gets a new code rather than a widened old one. */
export type FindingCode =
  /** The split API host is two or more labels below its zone, so a
   *  wildcard certificate will not cover it (fact 4). */
  | "api-host-beyond-wildcard"
  /** A domain value carries a path, which is what produces a
   *  prefix-stripping route (fact 3). */
  | "domain-carries-path"
  /** Two applications would carry the same host, so the proxy merges
   *  their site blocks and one swallows the other (fact 3). */
  | "hosts-collide"
  /** A split deployment needs a DNS record for the API host before any
   *  of its routing can resolve. */
  | "split-needs-api-record"
  /** Informational: one application means a client deploy restarts the
   *  server half with it (fact 1). */
  | "single-origin-shares-restarts"
  /** A routing entry names a compose service that does not exist, so
   *  the platform accepts the write and emits no proxy labels
   *  (fact 2). */
  | "routed-service-not-declared";

/** `error` blocks a working deploy. `warning` is a deploy that works
 *  now and breaks on the next change. `info` is a consequence worth
 *  knowing that is not a defect. */
export type FindingSeverity = "error" | "warning" | "info";

/** One thing worth saying, in two lines: what is wrong, and what to do.
 *  Both are single lines with no trailing full stop, because callers
 *  print them into lists and tables. */
export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  /** What is wrong, in one line. */
  message: string;
  /** What to do about it, in one line. */
  fix: string;
}

/** Everything the checks need. A narrow projection of the manifest on
 *  purpose — see the note on `OperationalProject` in
 *  operational-context.ts. */
export interface TopologyAdviceInput {
  /** Production domain as the manifest records it. Passed raw so the
   *  path check can see a path that normalization would remove. */
  domain: string;
  /** Additional public hostnames served by the same deployment. */
  aliases?: readonly string[];
  topology: Topology;
  surfaces: Surface;
  /** The registrable domain, when the caller knows it. Overrides
   *  {@link inferZone}'s heuristic. */
  zone?: string;
}

export interface TopologyAdvice {
  /** True when nothing found blocks a working deploy. Warnings and
   *  info do not clear it — only `error` does. */
  ok: boolean;
  findings: Finding[];
}

/** The API host a split deployment gives its server half. Kept next to
 *  the checks so the host they reason about and the host
 *  `deploy/routing.ts` actually routes are derived the same way. */
export function splitApiHost(domain: string): string {
  return `api.${normalizeHost(domain)}`;
}

/** Run every check that applies to this project.
 *
 *  What "applies" means is the whole point: a single-origin project has
 *  no API host and hears nothing about certificates for one, a static
 *  project has no server half and hears nothing about an API DNS
 *  record, and a backend-only project hears nothing about a client
 *  deploy restarting anything. Findings a project cannot act on are
 *  never emitted. */
export function topologyAdvice(input: TopologyAdviceInput): TopologyAdvice {
  const findings: Finding[] = [];
  const serverHalf = hasServerHalf(input.surfaces);
  const clientHalf = hasClientHalf(input.surfaces);
  const domainHost = normalizeHost(input.domain);
  const zone = inferZone(input.domain, { zone: input.zone });

  // Fact 3, first half: a path in a domain value is a prefix-stripping
  // route waiting to happen. Checked on every hostname value, because
  // an alias with a path routes exactly as badly as the domain does.
  for (const value of [input.domain, ...(input.aliases ?? [])]) {
    const path = pathInDomain(value);
    if (path !== "/") {
      findings.push({
        code: "domain-carries-path",
        severity: "error",
        message: `"${value.trim()}" carries the path ${path}, so the proxy strips ${path} before the request reaches the container`,
        fix: `record the bare host "${normalizeHost(value)}" and give the other half a host of its own`,
      });
    }
  }

  if (input.topology === "split" && serverHalf) {
    const apiHost = splitApiHost(input.domain);
    const depth = labelsBelowZone(apiHost, zone);

    // Fact 4. Only ever said about a host this project really has:
    // depth -1 means the inferred zone does not contain the host, which
    // is an inference we do not trust enough to raise an error on.
    if (depth > 1) {
      findings.push({
        code: "api-host-beyond-wildcard",
        severity: "error",
        message: `${apiHost} is ${depth} labels below the zone ${zone}, and a wildcard certificate covers one — TLS fails before any HTTP`,
        fix: `move the project to an apex zone whose API host is one label below it, or buy a certificate that covers ${apiHost}`,
      });
    }

    findings.push({
      code: "split-needs-api-record",
      severity: "warning",
      message: `split topology serves the API from ${apiHost}, which needs a DNS record of its own`,
      fix: `add an A/AAAA record for "api" on the ${zone} zone, pointing at the same server as the apex`,
    });

    // Fact 3, second half. The manifest listing the API host as an
    // alias is the realistic way two applications end up claiming one
    // host: aliases ride the client application, and the API host
    // belongs to the server one.
    for (const alias of input.aliases ?? []) {
      if (normalizeHost(alias) === apiHost) {
        findings.push({
          code: "hosts-collide",
          severity: "error",
          message: `${apiHost} is listed as an alias of ${domainHost}, so the client and server applications would both claim it`,
          fix: `drop ${apiHost} from the aliases — the server application already carries it under split topology`,
        });
      }
    }
  }

  // Fact 1. Only worth saying to a project that has two halves to
  // couple: a backend-only or static project has one thing to restart
  // either way.
  if (input.topology === "single-origin" && serverHalf && clientHalf) {
    findings.push({
      code: "single-origin-shares-restarts",
      severity: "info",
      message:
        "one application runs both halves, so deploying a client change restarts the server and drops every open connection",
      fix: "switch to split topology when the server holds long-lived connections a client deploy must not break",
    });
  }

  return { ok: !findings.some((f) => f.severity === "error"), findings };
}

/** Fact 2 as a check rather than prose.
 *
 *  The routed service names are what goes into the platform's
 *  domain-routing payload; the compose services are what the project's
 *  compose file declares. A routed name the compose does not declare is
 *  accepted by the API with a success response and emits no proxy
 *  labels at all, so the site answers a gateway error while every
 *  status surface reports a healthy deploy.
 *
 *  An empty (or unreadable) `composeServices` produces nothing: we
 *  cannot tell a missing service from a compose file we failed to
 *  parse, and guessing here would fail a correct project. */
export function serviceNameFindings(args: {
  composeServices: readonly string[];
  routedServices: readonly string[];
}): Finding[] {
  const declared = args.composeServices.map((s) => s.trim()).filter(Boolean);
  if (declared.length === 0) return [];
  const findings: Finding[] = [];
  for (const routed of args.routedServices) {
    const name = routed.trim();
    if (!name || declared.includes(name)) continue;
    findings.push({
      code: "routed-service-not-declared",
      severity: "error",
      message: `routing names the service "${name}", which the compose file does not declare (it has ${declared.join(", ")})`,
      fix: `rename the routing entry to one of ${declared.join(", ")}, or declare "${name}" in the compose file`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The domain layout a project should have
// ---------------------------------------------------------------------------

/** One application and the hosts it should carry. `role` matches
 *  `RoutedApp.role` in deploy/routing.ts, so a caller can line the two
 *  up without a second mapping. */
export interface DomainLayoutApp {
  role: "compose" | "client" | "server";
  /** What this application serves, in a few words. */
  serves: string;
  /** Hosts this application should carry, and no other application
   *  may. */
  hosts: string[];
}

/** A way out of the wildcard trap, with its cost stated. */
export interface DomainAlternative {
  /** Short name of the option. */
  title: string;
  /** What to do, in one or two sentences. */
  detail: string;
  /** What it costs — money, or a property given up. */
  cost: string;
}

export interface DomainLayout {
  /** The zone the hosts live under, inferred or given. */
  zone: string;
  apps: DomainLayoutApp[];
  /** Hosts that need a DNS record before any of this resolves. */
  dnsHosts: string[];
  /** True when the API host is more than one label below the zone, so
   *  a wildcard certificate will not cover it. */
  wildcardTrap: boolean;
  /** Ordered cheapest-correct-first. Empty unless `wildcardTrap`. */
  alternatives: DomainAlternative[];
}

/** The hosts each application should carry, plus — when the wildcard
 *  trap applies — the concrete ways out, in the order worth trying.
 *
 *  The first alternative is a fresh apex zone because it is the only
 *  one that costs nothing per year and gives up nothing: on a new apex
 *  the API host is one label below the zone and every other fact in
 *  this module stops applying at once. */
export function recommendedDomainLayout(args: {
  domain: string;
  topology: Topology;
  zone?: string;
  /** Narrows the layout to the halves the project has. Defaults to a
   *  project with both. */
  surfaces?: Surface;
}): DomainLayout {
  const surfaces = args.surfaces ?? "fullstack";
  const host = normalizeHost(args.domain);
  const zone = inferZone(args.domain, { zone: args.zone });
  const serverHalf = hasServerHalf(surfaces);
  const clientHalf = hasClientHalf(surfaces);

  if (args.topology !== "split") {
    return {
      zone,
      apps: [
        {
          role: "compose",
          serves: serverHalf && clientHalf ? "both halves" : clientHalf ? "the site" : "the API",
          hosts: [host],
        },
      ],
      dnsHosts: [host],
      wildcardTrap: false,
      alternatives: [],
    };
  }

  const apiHost = splitApiHost(host);
  const apps: DomainLayoutApp[] = [];
  if (clientHalf) apps.push({ role: "client", serves: "the site", hosts: [host] });
  if (serverHalf) {
    apps.push({ role: "server", serves: "the API", hosts: [clientHalf ? apiHost : host] });
  }

  const apiHostInUse = apps.some((a) => a.role === "server" && a.hosts.includes(apiHost));
  const depth = apiHostInUse ? labelsBelowZone(apiHost, zone) : 0;
  const wildcardTrap = depth > 1;

  return {
    zone,
    apps,
    dnsHosts: [...new Set(apps.flatMap((a) => a.hosts))],
    wildcardTrap,
    alternatives: wildcardTrap ? wildcardAlternatives(apiHost, zone) : [],
  };
}

/** The three ways out of the wildcard trap, in the order worth trying,
 *  for a named host and zone.
 *
 *  Exported because the generated documentation states them for every
 *  project, trapped or not — a project that is fine today is exactly
 *  the project about to move its domain — and a second copy of the
 *  wording would be the one that goes stale. */
export function wildcardAlternatives(apiHost: string, zone: string): DomainAlternative[] {
  return [
    {
      title: "a fresh apex zone",
      detail: `Register a domain and serve the project from its apex, so the API host is "api.<the new zone>" — one label below it, which the zone's wildcard certificate covers.`,
      cost: "one domain registration per year, and every reference to the old hostnames has to move with it",
    },
    {
      title: "a certificate that covers the deeper host",
      detail: `Buy the CDN's advanced-certificate product, or issue a certificate naming ${apiHost} explicitly, and keep the project under ${zone}.`,
      cost: "a recurring fee, and a certificate whose name list has to be maintained by hand",
    },
    {
      title: "turn the CDN proxy off on that record",
      detail: `Set the ${apiHost} record to DNS-only so the platform issues its own certificate for it directly.`,
      cost: "the record then resolves to the server's own address, so the origin IP is public and the CDN's filtering no longer sits in front of the API",
    },
  ];
}
