/*
 * Deployment topology → Coolify routing. THE single source of truth
 * shared by `create` (deploy/coolify.ts), `adopt` (deploy/coolify-app.ts)
 * and `sync` (deploy/sync.ts).
 *
 * Before this module the three commands each open-coded their own idea
 * of "what Coolify apps exist and which domains hang off them", and they
 * disagreed:
 *
 *   · create  emitted ONE compose app with `client` → https://<domain>
 *             and FOUR separate `server` entries.
 *   · adopt   emitted ONE compose app with a single service picked by
 *             port-match, defaulting to the literal name `app`.
 *   · sync    hardcoded `[{ name: "app", … }]` — a service name that
 *             exists in no hatchkit-generated compose file.
 *
 * ---------------------------------------------------------------------
 * What Coolify actually does with `docker_compose_domains`
 * ---------------------------------------------------------------------
 *
 * Verified against Coolify 4.0.0-beta.469 source + a live install.
 *
 * 1. The API accepts `[{ name, domain }]` but STORES a map keyed by
 *    service name (`ApplicationsController`: `->put($name, $entry)`).
 *    Sending two entries with the same `name` is a silent last-wins
 *    collapse — which is why every hatchkit project ended up with only
 *    `https://api.<domain>/ws` on its `server` service, and nothing on
 *    `https://<domain>/api`.
 *
 * 2. Multiple domains per service ARE supported — as ONE comma-joined
 *    string. Coolify splits on commas both at validation time
 *    (`explode(',')` in the controller) and at label-generation time
 *    (`str($fqdns)->explode(',')` in `bootstrap/helpers/shared.php`),
 *    emitting one Traefik router per entry (`http-0-…`, `http-1-…`).
 *    So this module emits AT MOST ONE ENTRY PER SERVICE.
 *
 * 3. A URL path is honoured: `https://x.com/api` becomes
 *    ``Host(`x.com`) && PathPrefix(`/api`)``. Traefik's default rule
 *    priority is rule length, so the `/api` router outranks the bare
 *    ``Host(`x.com`) && PathPrefix(`/`)`` router on the same host — no
 *    explicit priority needed.
 *
 * 4. BUT for any path other than `/`, Coolify also attaches a
 *    `stripprefix` middleware (`fqdnLabelsForTraefik`, gated on the
 *    app-level `is_stripprefix_enabled` setting, default ON). With it
 *    on, `/api/health` reaches the Express server as `/health` → 404.
 *    Path-scoped routing therefore REQUIRES turning that setting off,
 *    which is why {@link RoutedApp.stripPrefix} exists.
 *
 *    It is pushed ONLY when a path route exists. Routes at `/` get no
 *    stripprefix middleware at all, so the setting is inert there — and
 *    some Coolify builds reject `is_stripprefix_enabled` on PATCH
 *    outright ("This field is not allowed."), taking the domains in the
 *    same request down with it. A field with nothing to say stays
 *    unsent.
 *
 * 5. A URL port (`https://x.com:6477`) becomes an explicit
 *    `loadbalancer.server.port` label. We omit it: the scaffolded
 *    Dockerfiles `EXPOSE` the same port they listen on, so Traefik
 *    resolves the target port from the image, and omitting it keeps the
 *    stored value stable across port changes.
 *
 * ---------------------------------------------------------------------
 * The two topologies
 * ---------------------------------------------------------------------
 *
 * single-origin (default, what `create` has always scaffolded):
 *   ONE Coolify app named `<name>`, dockercompose build pack, the
 *   starter's four-service compose (server / client / mongo / redis).
 *     client → https://<domain>
 *     server → https://<domain>/api        (stripprefix OFF)
 *   Everything is same-origin, so auth cookies and CORS never enter the
 *   picture, and `wss://<domain>/api/ws` rides the same `/api` router
 *   (Traefik proxies the upgrade transparently).
 *
 * split:
 *   TWO Coolify apps from the two prebuilt GHCR images.
 *     <name>-client → https://<domain>
 *     <name>-server → https://api.<domain>
 *   mongo/redis become Coolify-managed databases instead of compose
 *   services. Needs a second DNS record for `api.<domain>` and puts the
 *   API cross-origin (CORS + cookie config carry the weight).
 */

import type { Surface } from "../prompts.js";

/** How a project's runtime is spread across Coolify applications.
 *  Persisted in the manifest as `topology`; see
 *  {@link inferTopology} for what happens on manifests that predate
 *  the field. */
export type Topology = "single-origin" | "split";

export const TOPOLOGIES: readonly Topology[] = ["single-origin", "split"] as const;

export function isTopology(v: unknown): v is Topology {
  return typeof v === "string" && (TOPOLOGIES as readonly string[]).includes(v);
}

/** Compose file the single Coolify app of a `single-origin` project
 *  builds from — the four-service stack the starter ships. */
export const SINGLE_ORIGIN_COMPOSE = "/docker-compose.yml";
/** Per-half compose files for `split`. Each declares exactly one
 *  service, so the two Coolify apps don't each run the whole stack. */
export const SPLIT_CLIENT_COMPOSE = "/docker-compose.client.yml";
export const SPLIT_SERVER_COMPOSE = "/docker-compose.server.yml";

/** Compose services that are never a routing target — infrastructure
 *  containers with no public surface. Used when inferring which service
 *  should take the public domain on a compose file we didn't write. */
const INFRA_SERVICES = new Set([
  "mongo",
  "mongodb",
  "redis",
  "valkey",
  "postgres",
  "postgresql",
  "db",
  "database",
  "mysql",
  "mariadb",
  "minio",
  "meilisearch",
  "elasticsearch",
  "rabbitmq",
  "nats",
]);

/** Service names that plausibly mean "the browser-facing surface",
 *  most-specific first. */
const CLIENT_SERVICE_CANDIDATES = ["client", "web", "frontend", "www", "ui", "app"];
/** Service names that plausibly mean "the HTTP API", most-specific first. */
const SERVER_SERVICE_CANDIDATES = ["server", "api", "backend"];

/** Coolify application-name suffixes accepted when locating the client
 *  half of a split deployment. The first entry is what hatchkit
 *  creates; the rest exist because hand-rolled deployments used other
 *  words (tiao's working stack is `tiao-frontend` / `tiao-backend`) and
 *  refusing to match them would mean sync silently skipping a real app. */
const CLIENT_APP_SUFFIXES = ["-client", "-frontend", "-web"];
const SERVER_APP_SUFFIXES = ["-server", "-backend", "-api"];

/** Everything {@link computeRoutingPlan} needs. Deliberately a plain
 *  structural type rather than `ProjectManifest` so callers holding a
 *  half-built `ProjectConfig` (create's stepper) can use it too. */
export interface RoutingInput {
  /** Project name — the Coolify application name in single-origin, and
   *  the stem for `<name>-client` / `<name>-server` in split. */
  name: string;
  /** Bare production domain, no scheme. */
  domain: string;
  /** Extra public hostnames served by the same deployment (manifest
   *  `aliases[]`), bare and pre-normalized — callers pass
   *  `manifestHostnames(manifest).slice(1)` so normalization happens in
   *  one place. They ride whichever entry owns the bare domain (the
   *  public service in single-origin, the client app in split);
   *  API-facing entries stay primary-only — aliases are user-facing
   *  hostnames, not extra API endpoints. NOT the same thing as
   *  {@link RoutedApp.aliases}, which are app-NAME lookup aliases. */
  hostnameAliases?: string[];
  topology: Topology;
  surfaces?: Surface;
  ports?: { server?: number; client?: number };
  /** Manifest's pinned `publicService`, when set. */
  publicService?: string;
  /** Services actually declared in the project's compose file, when it
   *  could be read. Drives service-name resolution so we never propose
   *  a name the compose doesn't have. Undefined = "couldn't read the
   *  compose", which falls back to the surface-derived defaults. */
  composeServices?: string[];
}

/** One Coolify application the plan expects to exist, plus the exact
 *  routing payload it should carry. */
export interface RoutedApp {
  /** Canonical Coolify application name hatchkit creates. */
  appName: string;
  /** Additional names accepted when LOOKING UP an existing app (never
   *  used when creating one). Empty for single-origin. */
  aliases: string[];
  /** Which half of the deployment this app is. `compose` means the one
   *  multi-service app of a single-origin deployment. */
  role: "compose" | "client" | "server";
  /** Payload for `docker_compose_domains`. At most one entry per
   *  service name — multiple FQDNs for one service are comma-joined
   *  into that entry's `domain` (see module header, point 2). */
  composeDomains: Array<{ name: string; domain: string }>;
  /** Payload for the flat `domains` field, used when Coolify reports a
   *  non-dockercompose build pack. Same FQDNs, ungrouped. */
  flatDomains: string[];
  /** `ports_exposes` this app should carry. */
  portsExposes: string;
  /** Repo-relative path of the compose file this Coolify app builds
   *  from (`docker_compose_location`).
   *
   *  `single-origin` uses the root `docker-compose.yml` — one app, all
   *  four services. `split` CANNOT: pointing both apps at that file
   *  would run the whole stack twice (two clients, two servers, two
   *  mongos), so each half gets its own single-service compose. */
  composeLocation: string;
  /** Desired `is_stripprefix_enabled`, or `undefined` when hatchkit has
   *  NO OPINION and the field must not be pushed at all.
   *
   *  Only `false` is ever an opinion, and only when some routed domain
   *  carries a path other than `/`: Coolify attaches the `stripprefix`
   *  middleware for exactly those routers, so leaving the setting ON
   *  would deliver `/api/health` to Express as `/health` (module
   *  header, point 4).
   *
   *  When every routed domain sits at `/` — ALWAYS true under `split`,
   *  where each half owns its own host — Coolify attaches no such
   *  middleware and the setting is inert. Pushing the default value
   *  anyway bought nothing and cost everything: some Coolify builds
   *  reject `is_stripprefix_enabled` on PATCH with
   *  `422 {"errors":{"is_stripprefix_enabled":["This field is not
   *  allowed."]}}`, which aborted the entire routing PATCH and left
   *  both split apps with no domains at all. So say nothing unless we
   *  mean it. */
  stripPrefix?: boolean;
  /** Compose service names this app's routing references. `sync`
   *  validates these against the on-disk compose before PATCHing so a
   *  phantom name can never reach Coolify. Empty for non-compose apps. */
  requiredComposeServices: string[];
}

export interface RoutingPlan {
  topology: Topology;
  apps: RoutedApp[];
  /** Extra hostnames beyond the bare domain that need a DNS record for
   *  this plan to resolve. `api.<domain>` in split; empty otherwise. */
  extraDnsHostnames: string[];
}

// ---------------------------------------------------------------------------
// Service-name resolution
// ---------------------------------------------------------------------------

/** Default `publicService` for a surface — the compose service that
 *  should take the bare domain. Mirrors the starter's service names.
 *  Kept here (rather than in manifest.ts) so routing has one home; the
 *  manifest module re-exports it for back-compat. */
export function defaultPublicServiceForSurfaces(surfaces: Surface | undefined): string | undefined {
  switch (surfaces) {
    case "fullstack":
    case "split":
    case "static":
      return "client";
    case "backend":
      return "server";
    default:
      return undefined;
  }
}

/** Pick the compose service that should receive the bare domain.
 *  Precedence: explicit pin → surface default → inference from the
 *  compose file → "client". Every step is filtered through
 *  `composeServices` when we have it, so the result is always a name
 *  that exists. */
export function resolvePublicService(input: RoutingInput): string {
  const declared = input.composeServices;
  const exists = (n: string | undefined): n is string =>
    !!n && (declared === undefined || declared.includes(n));

  if (exists(input.publicService)) return input.publicService;
  const bySurface = defaultPublicServiceForSurfaces(input.surfaces);
  if (exists(bySurface)) return bySurface;

  if (declared && declared.length > 0) {
    // Backend-only projects route everything at the server; don't let
    // the client-candidate list win over an explicit surface choice.
    const preferred =
      input.surfaces === "backend"
        ? [...SERVER_SERVICE_CANDIDATES, ...CLIENT_SERVICE_CANDIDATES]
        : [...CLIENT_SERVICE_CANDIDATES, ...SERVER_SERVICE_CANDIDATES];
    for (const candidate of preferred) {
      if (declared.includes(candidate)) return candidate;
    }
    const firstAppish = declared.find((s) => !INFRA_SERVICES.has(s));
    if (firstAppish) return firstAppish;
    return declared[0];
  }
  return bySurface ?? input.publicService ?? "client";
}

/** Pick the compose service that serves the HTTP API, or undefined when
 *  the project has no separate backend (static sites, and backend-only
 *  projects where the server already owns the bare domain). */
export function resolveApiService(input: RoutingInput, publicService: string): string | undefined {
  if (input.surfaces === "static") return undefined;
  const declared = input.composeServices;
  const exists = (n: string): boolean => declared === undefined || declared.includes(n);
  for (const candidate of SERVER_SERVICE_CANDIDATES) {
    if (candidate !== publicService && exists(candidate)) return candidate;
  }
  // No dedicated backend service: the public service is the backend.
  return undefined;
}

// ---------------------------------------------------------------------------
// Plan computation
// ---------------------------------------------------------------------------

/** Build the full desired Coolify state for a project. Pure — no I/O,
 *  no network — so `--dry-run` never has to reach the API to render a
 *  plan, and the whole thing is unit-testable. */
export function computeRoutingPlan(input: RoutingInput): RoutingPlan {
  return input.topology === "split" ? splitPlan(input) : singleOriginPlan(input);
}

/** `https://<host>` for the primary domain plus every hostname alias,
 *  primary first, deduped. The full user-facing URL set one routed
 *  entry carries (comma-joined for compose payloads, element-wise for
 *  the flat `domains` field). */
function publicUrls(input: RoutingInput): string[] {
  const hosts = [input.domain];
  for (const h of input.hostnameAliases ?? []) {
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  return hosts.map((h) => `https://${h}`);
}

function singleOriginPlan(input: RoutingInput): RoutingPlan {
  const publicService = resolvePublicService(input);
  const apiService = resolveApiService(input, publicService);

  const bare = `https://${input.domain}`;
  const publics = publicUrls(input);
  // Multiple FQDNs for one service are ONE comma-joined entry — see
  // module header, point 2.
  const entries: Array<{ name: string; domain: string }> = [
    { name: publicService, domain: publics.join(",") },
  ];
  if (apiService) {
    // Path-scoped, same host. `/api` also covers `/api/ws`, so the
    // WebSocket upgrade rides this router without a second entry —
    // and a second entry would be a *duplicate URL prefix* Coolify
    // rejects with 422 anyway. Primary host only: aliases never gain
    // an API surface just by being aliases.
    entries.push({ name: apiService, domain: `${bare}/api` });
  }

  const flat = [...publics, ...(apiService ? [`${bare}/api`] : [])];
  const hasPathRoute = flat.some((u) => pathOf(u) !== "/");
  // `ports_exposes` is metadata once the compose file takes over
  // (Coolify normalises it to 80 on compose apps), but Coolify still
  // requires a value. Use the public service's own port so the field
  // at least describes reality.
  const publicPort =
    publicService === apiService || apiService === undefined
      ? (input.ports?.server ?? 3000)
      : (input.ports?.client ?? 3001);

  return {
    topology: "single-origin",
    apps: [
      {
        appName: input.name,
        aliases: [],
        role: "compose",
        composeDomains: entries,
        flatDomains: flat,
        portsExposes: String(input.surfaces === "static" ? 80 : publicPort),
        composeLocation: SINGLE_ORIGIN_COMPOSE,
        // Only an opinion when a path route exists; see RoutedApp.stripPrefix.
        ...(hasPathRoute ? { stripPrefix: false } : {}),
        requiredComposeServices: unique(entries.map((e) => e.name)),
      },
    ],
    extraDnsHostnames: [],
  };
}

function splitPlan(input: RoutingInput): RoutingPlan {
  const apiHost = `api.${input.domain}`;
  // Hostname aliases ride the user-facing app (client); the API app
  // stays primary-only.
  //
  // The API host is subtracted from the client's set. A manifest that
  // lists `api.<domain>` in `aliases[]` is describing a hostname the
  // project serves — which under `split` is served by the SERVER app,
  // not the client. Leaving it on both makes two applications claim one
  // FQDN: Coolify refuses the second (409), and if it didn't, Traefik
  // would have two routers for one host and the winner would be
  // whichever deployed last. Under single-origin there is only one app,
  // so the same alias is harmless there and stays.
  const apiUrl = `https://${apiHost}`;
  const publics = publicUrls(input).filter((u) => u !== apiUrl);
  const clientApp: RoutedApp = {
    appName: `${input.name}-client`,
    aliases: CLIENT_APP_SUFFIXES.slice(1).map((s) => `${input.name}${s}`),
    role: "client",
    composeDomains: [{ name: "client", domain: publics.join(",") }],
    flatDomains: publics,
    portsExposes: String(input.ports?.client ?? 3001),
    composeLocation: SPLIT_CLIENT_COMPOSE,
    // No stripPrefix opinion: every split route is a bare host at `/`,
    // so Coolify attaches no stripprefix middleware and the setting is
    // inert. See RoutedApp.stripPrefix.
    requiredComposeServices: ["client"],
  };
  const serverApp: RoutedApp = {
    appName: `${input.name}-server`,
    aliases: SERVER_APP_SUFFIXES.slice(1).map((s) => `${input.name}${s}`),
    role: "server",
    // One host, root path — no stripprefix hazard, and the client's
    // NEXT_PUBLIC_API_URL points straight at it. The bare domain is
    // owned by the client app, so nothing path-scoped is needed here.
    composeDomains: [{ name: "server", domain: `https://${apiHost}` }],
    flatDomains: [`https://${apiHost}`],
    portsExposes: String(input.ports?.server ?? 3000),
    composeLocation: SPLIT_SERVER_COMPOSE,
    requiredComposeServices: ["server"],
  };

  const apps: RoutedApp[] =
    input.surfaces === "static"
      ? [clientApp]
      : input.surfaces === "backend"
        ? [{ ...serverApp, flatDomains: [...publics, `https://${apiHost}`] }]
        : [clientApp, serverApp];

  return {
    topology: "split",
    apps,
    extraDnsHostnames: apps.some((a) => a.role === "server") ? [apiHost] : [],
  };
}

// ---------------------------------------------------------------------------
// Topology inference (manifests written before the field existed)
// ---------------------------------------------------------------------------

export interface TopologyInference {
  topology: Topology;
  /** Where the value came from — surfaced by `sync --dry-run` and
   *  `adopt` so the user can see (and correct) what we assumed. */
  source: "manifest" | "compose" | "default";
  /** One-line, user-facing explanation of `source`. */
  reason: string;
}

/** Resolve the topology for a project whose manifest may predate the
 *  `topology` field.
 *
 *  The rule that matters: every manifest written before this field
 *  existed came from a `create` (or `adopt`) run that produced ONE
 *  Coolify app running a multi-service compose. Defaulting those to
 *  `single-origin` is what preserves current behaviour — including for
 *  mood-magic, the one legacy project whose front page actually serves
 *  200s today. `split` is opt-in only: nothing on disk can distinguish
 *  "should be split" from "is single-origin", so we never guess it. */
export function inferTopology(args: {
  topology?: unknown;
  composeServices?: string[];
}): TopologyInference {
  if (isTopology(args.topology)) {
    return {
      topology: args.topology,
      source: "manifest",
      reason: `manifest declares topology "${args.topology}"`,
    };
  }
  const services = args.composeServices;
  if (services && services.length > 0) {
    return {
      topology: "single-origin",
      source: "compose",
      reason: `no topology in manifest; compose declares ${services.length} service(s) (${services.join(", ")}) in one app → single-origin`,
    };
  }
  return {
    topology: "single-origin",
    source: "default",
    reason:
      "no topology in manifest and no readable compose file — assuming single-origin (what every pre-topology hatchkit run produced)",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path component of a routing URL, normalised to "/" when absent. */
export function pathOf(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p === "" ? "/" : p;
  } catch {
    return "/";
  }
}

/** Split a Coolify-stored comma-joined domain string into its FQDNs. */
export function splitDomainString(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Collapse an array that may carry several entries for one service
 *  into the one-entry-per-service, comma-joined shape Coolify stores.
 *  Idempotent, and order-preserving within a service so the first
 *  domain listed stays the canonical one (Coolify's `COOLIFY_URL`). */
export function collapseComposeDomains(
  entries: Array<{ name: string; domain: string }>,
): Array<{ name: string; domain: string }> {
  const byService = new Map<string, string[]>();
  for (const entry of entries) {
    const list = byService.get(entry.name) ?? [];
    for (const d of splitDomainString(entry.domain)) {
      if (!list.includes(d)) list.push(d);
    }
    byService.set(entry.name, list);
  }
  return [...byService].map(([name, domains]) => ({ name, domain: domains.join(",") }));
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
