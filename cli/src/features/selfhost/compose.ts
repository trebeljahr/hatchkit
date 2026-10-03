/*
 * The self-host stack — one compose file a stranger can run on their own
 * machine, plus the two overrides that build it from a clone and boot it
 * in CI.
 *
 * ---------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------
 *
 * A hatchkit project ships a production deploy (Coolify, one or two
 * applications, Traefik in front, images built in CI) and a local dev
 * compose. Neither is something a stranger can run: the production
 * compose publishes no ports because Coolify's proxy owns routing, its
 * client image was built with the owner's domain compiled into the
 * bundle, and the dev compose builds from a checkout. So "can somebody
 * else run this?" had no answer, and every attempt discovered the same
 * three failures by hand.
 *
 * ---------------------------------------------------------------------
 * The three failures this file is shaped around
 * ---------------------------------------------------------------------
 *
 * 1. **A pulled service that also declares `build:` is not a pulled
 *    service.** Compose quietly builds a service it knows how to build
 *    when the pull fails, whatever `pull_policy` says. A mistyped tag, a
 *    release whose images were never published and a package that is
 *    still private then all turn into a `next build` that wants 4 GB of
 *    RAM, gets OOM-killed on the 1–2 GB box this stack is sized for, and
 *    prints nothing that names the real cause. With no `build:` section
 *    the same failure stops at the registry's own error message. Building
 *    from a clone is therefore a separate opt-in override file, never a
 *    fallback the base file can slide into.
 *
 * 2. **A client image that knows an API URL is bound to one host for
 *    ever.** Next.js inlines `NEXT_PUBLIC_*` into the browser bundle when
 *    the image is BUILT. The self-host client image is built with an
 *    EMPTY `NEXT_PUBLIC_API_URL` so the bundle calls relative paths and
 *    derives its socket URL from the page's own origin — which is what
 *    lets ONE published image work behind anybody's domain. The proxy in
 *    front is what makes the page and the API the same origin, and the
 *    app must therefore be served at the ROOT of the domain.
 *
 * 3. **A healthcheck with no `start_interval` makes a fast service look
 *    slow.** Without it the first probe runs only once `interval` has
 *    elapsed, so a server that is ready in three seconds is reported
 *    `starting` for thirty — and the proxy, gated on it, waits with it.
 *
 * Nothing here is project-specific: service names, ports, image
 * references and the datastore set all come from {@link OperationalProject}
 * and the project's features.
 */

import type { OperationalProject } from "../operational-context.js";
import { hasClientHalf, hasServerHalf } from "../operational-context.js";

/**
 * The header every file this feature generates opens with.
 *
 * These files are OWNED: the ledger writes them with `writeIfChanged`,
 * which regenerates them on every `hatchkit update` and therefore
 * discards whatever somebody edited into them. The only defence against
 * that is the file saying so in the place they are already reading, so
 * the notice travels with the content rather than living in the docs.
 *
 * `#` suits all of them — compose, the Caddyfile, the env example, the
 * workflow and the derived Dockerfile are all hash-commented.
 */
export function ownedFileHeader(): string[] {
  return [
    "# Generated and owned by hatchkit. It is rewritten on every `hatchkit",
    "# update`, so an edit made here is lost the next time one runs. To change",
    "# something, copy this file under a name hatchkit does not write and point",
    "# your stack at the copy.",
    "#",
  ];
}

export const SELFHOST_COMPOSE_REL = "docker-compose.selfhost.yml";
export const SELFHOST_BUILD_OVERRIDE_REL = "docker-compose.selfhost.build.yml";
export const SELFHOST_CI_OVERRIDE_REL = "docker-compose.selfhost.ci.yml";
export const SELFHOST_CLIENT_DOCKERFILE_REL = "packages/client/Dockerfile.selfhost";

/** Datastores the generated stack can run on the compose network. */
export type SelfHostDatastore = "mongo" | "redis";

/** What a service is there for. The renderer and the tests both key off
 *  this rather than off the service's name, so a project that renames a
 *  half keeps its invariants. */
export type SelfHostRole = "proxy" | "server" | "client" | "datastore";

export interface SelfHostHealthcheck {
  /** Docker `test` vector, `CMD` form — never `CMD-SHELL`, so no shell
   *  has to exist in the image. */
  test: readonly string[];
  interval: string;
  timeout: string;
  retries: number;
  /** Failures inside this window do not count against `retries`. */
  startPeriod: string;
  /** Probe cadence INSIDE `start_period`. See failure 3 in the module
   *  header. Needs Docker Engine 25.0+; an older engine ignores the
   *  field and falls back to `interval`, so the stack still starts.
   *  Compose refuses `start_interval` without `start_period`. */
  startInterval?: string;
}

export interface SelfHostService {
  /** Compose service name, and the hostname other services reach it on. */
  name: string;
  role: SelfHostRole;
  /** Image reference, including the `${VERSION}` interpolation for the
   *  project's own halves. */
  image: string;
  /** Host port mappings. Empty for everything except the proxy — see
   *  {@link selfHostServices}. */
  published: readonly string[];
  /** Container port other services on the compose network reach. */
  expose?: number;
  /** True when the image is pulled. A pulled service MUST NOT declare a
   *  `build:` section — failure 1 in the module header. */
  pulled: boolean;
  healthcheck: SelfHostHealthcheck;
  /** Services that must report healthy before this one starts. */
  dependsOnHealthy: readonly string[];
  /** `name:/container/path` entries; named volumes are collected into
   *  the file's top-level `volumes:` block. */
  volumes: readonly string[];
  /** Ordered environment pairs. Ordered, not a map, because the comments
   *  between them are part of the file's value. */
  environment: ReadonlyArray<readonly [string, string]>;
  command?: readonly string[];
  /** Comment lines emitted above the service, without the leading `#`. */
  comment: readonly string[];
}

/**
 * Everything a caller may override about the stack.
 *
 * Every field has a default derived from the project, so the operational
 * layer applies the feature with none of them set. They exist for the
 * tests, which have to be able to drive a shape the default project does
 * not produce, and for a later caller that knows something the manifest
 * does not — a published extension's id, say.
 *
 * There is no `force` here. Whether to overwrite is the caller's
 * decision and travels on `OperationalContext`, not in the options a
 * renderer reads.
 */
export interface SelfHostOptions {
  /** Container ports the two halves listen on. Defaults match
   *  deploy/routing.ts: server 3000, client 3001. */
  ports?: { server?: number; client?: number };
  /** Registry stem for the project's own images, with no `-server` /
   *  `-client` suffix and no tag. Defaults to the repo slug on ghcr. */
  imageStem?: string;
  /** Default tag the compose file pins when the version variable is
   *  unset. A moving tag here would make "which version am I running"
   *  unanswerable, so callers should pass a release tag. */
  version?: string;
  /** Datastores to run on the compose network. Derived from the
   *  project's features when omitted. */
  datastores?: readonly SelfHostDatastore[];
  /** Path prefix the API is mounted under, leading slash, no trailing
   *  slash. */
  apiPrefix?: string;
  /** Exact path the server's upgrade handler compares against. */
  socketPath?: string;
  /** The project's own client Dockerfile, which the self-host one is
   *  derived from. */
  clientDockerfile?: string;
  /** The project's server Dockerfile, built by the overrides. */
  serverDockerfile?: string;
  /** Pinned origin of the published browser extension, if the project
   *  has one. `chrome-extension://<id>`-style ids only. */
  extensionId?: string;
}

/** Everything the renderers need, with every default already applied.
 *  Resolved once so the compose file, the proxy config, the env example
 *  and the smoke workflow cannot disagree about a port or a name. */
export interface SelfHostPlan {
  project: OperationalProject;
  services: SelfHostService[];
  ports: { server: number; client: number };
  apiPrefix: string;
  socketPath: string;
  /** `MYAPP_VERSION` — the variable that pins the image tag. */
  versionKey: string;
  version: string;
  imageStem: string;
  datastores: SelfHostDatastore[];
  hasSocket: boolean;
  hasClient: boolean;
  clientDockerfile: string;
  serverDockerfile: string;
}

const DEFAULT_SERVER_PORT = 3000;
const DEFAULT_CLIENT_PORT = 3001;
const PROXY_SERVICE = "caddy";

/** Environment-variable name that pins the image tag, derived from the
 *  project name: `track-your-time` → `TRACK_YOUR_TIME_VERSION`. */
export function versionEnvKey(name: string): string {
  const stem = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${stem || "APP"}_VERSION`;
}

/** Registry stem for the project's images. `OWNER` stays literal when
 *  the repo slug is unknown: a wrong-but-plausible owner would pull
 *  somebody else's package, and a placeholder fails loudly instead. */
export function selfHostImageStem(project: OperationalProject): string {
  return `ghcr.io/${project.repoSlug ?? `OWNER/${project.name}`}`;
}

/** Datastores the project actually uses. Redis backs room sockets and
 *  the client-core account sync feed; the
 *  document store is always there for a project with a server half. */
export function selfHostDatastores(project: OperationalProject): SelfHostDatastore[] {
  if (!hasServerHalf(project.surfaces)) return [];
  const stores: SelfHostDatastore[] = ["mongo"];
  if (project.features.some((feature) => feature === "websocket" || feature === "client-core"))
    stores.push("redis");
  return stores;
}

/** Resolve options into the one plan every renderer reads. */
export function selfHostPlan(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): SelfHostPlan {
  const ports = {
    server: opts.ports?.server ?? DEFAULT_SERVER_PORT,
    client: opts.ports?.client ?? DEFAULT_CLIENT_PORT,
  };
  const apiPrefix = (opts.apiPrefix ?? "/api").replace(/\/+$/, "") || "/api";
  return {
    project,
    services: [],
    ports,
    apiPrefix,
    socketPath: opts.socketPath ?? `${apiPrefix}/ws`,
    versionKey: versionEnvKey(project.name),
    version: opts.version ?? "latest",
    imageStem: opts.imageStem ?? selfHostImageStem(project),
    datastores: [...(opts.datastores ?? selfHostDatastores(project))],
    hasSocket: project.features.includes("websocket") && hasServerHalf(project.surfaces),
    hasClient: hasClientHalf(project.surfaces),
    clientDockerfile: opts.clientDockerfile ?? "packages/client/Dockerfile",
    serverDockerfile: opts.serverDockerfile ?? "packages/server/Dockerfile",
  };
}

/**
 * Every service in the self-host stack, in file order.
 *
 * Two invariants live here rather than in the rendered text, so a test
 * can hold them without parsing YAML:
 *
 *   · `published` is non-empty ONLY on the proxy. Everything else is
 *     reachable on the compose network alone, which is what keeps a
 *     database with no password off the public internet.
 *   · `pulled` is true for every service the base file starts, and the
 *     renderer emits no `build:` for a pulled service — failure 1 in the
 *     module header.
 */
export function selfHostServices(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): SelfHostService[] {
  const plan = selfHostPlan(project, opts);
  if (!hasServerHalf(project.surfaces)) return [];

  const services: SelfHostService[] = [];
  const tag = `\${${plan.versionKey}:-${plan.version}}`;
  const appUrl = "${APP_URL:-https://${APP_DOMAIN}}";

  // ── The proxy ────────────────────────────────────────────────────────
  const gated: string[] = ["server"];
  if (plan.hasClient) gated.push("client");
  services.push({
    name: PROXY_SERVICE,
    role: "proxy",
    image: "caddy:2.11-alpine",
    // The only published ports in the stack. 80 is not decoration: the
    // ACME HTTP challenge is answered on it, and it serves the redirect
    // to HTTPS. 443/udp is HTTP/3.
    published: ["80:80", "443:443", "443:443/udp"],
    pulled: true,
    environment: [["APP_DOMAIN", "${APP_DOMAIN:?set APP_DOMAIN in .env, e.g. app.example.com}"]],
    volumes: [
      `./${PROXY_CONFIG_REL}:/etc/caddy/Caddyfile:ro`,
      "caddy-data:/data",
      "caddy-config:/config",
    ],
    dependsOnHealthy: gated,
    healthcheck: {
      // Caddy's admin API, on loopback inside the container. A request
      // to :80 would not do: the site block matches $APP_DOMAIN, so a
      // probe with any other Host header is answered with a 404 by
      // design. A GET, not `wget --spider`: --spider sends HEAD, and the
      // admin API answers anything outside GET/POST/PUT/PATCH/DELETE
      // with 405 — which would mark a proxy that is routing traffic
      // perfectly well as unhealthy for ever.
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"],
      interval: "30s",
      timeout: "5s",
      retries: 3,
      startPeriod: "10s",
      startInterval: "5s",
    },
    comment: [
      "── Reverse proxy and TLS ─────────────────────────────────────────",
      "",
      "The only service with published ports. It terminates TLS for",
      `$APP_DOMAIN and routes by path — see ./${PROXY_CONFIG_REL}.`,
      "",
      "Gated on the app halves being healthy, so the first request after",
      "`up` is answered by a server that is actually ready rather than by",
      "a 502 that looks like a routing bug.",
    ],
  });

  // ── The server half ──────────────────────────────────────────────────
  const serverEnv: Array<readonly [string, string]> = [
    ["NODE_ENV", "production"],
    ["PORT", `"${plan.ports.server}"`],
    ["APP_URL", appUrl],
    // The starter's server reads these two, not APP_URL. Both are
    // derived from the one knob so a self-hoster sets a single value and
    // cannot make the auth origin and the CORS origin disagree.
    ["BETTER_AUTH_URL", appUrl],
    ["FRONTEND_URL", appUrl],
    [
      "BETTER_AUTH_SECRET",
      "${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env — openssl rand -base64 32}",
    ],
  ];
  if (plan.datastores.includes("mongo")) {
    serverEnv.push(["MONGODB_URI", `\${MONGODB_URI:-mongodb://mongo:27017/${project.name}}`]);
  }
  if (plan.datastores.includes("redis")) {
    serverEnv.push(["REDIS_URL", "${REDIS_URL:-redis://redis:6379}"]);
  }
  services.push({
    name: "server",
    role: "server",
    image: `${plan.imageStem}-server:${tag}`,
    published: [],
    expose: plan.ports.server,
    pulled: true,
    environment: serverEnv,
    volumes: [],
    dependsOnHealthy: plan.datastores.map((d) => (d === "mongo" ? "mongo" : "redis")),
    healthcheck: {
      test: [
        "CMD",
        "node",
        "-e",
        `fetch('http://127.0.0.1:'+(process.env.PORT||'${plan.ports.server}')+'${plan.apiPrefix}/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`,
      ],
      interval: "30s",
      timeout: "10s",
      retries: 5,
      startPeriod: "20s",
      startInterval: "5s",
    },
    comment: [
      "── The API, and everything stateful ──────────────────────────────",
      "",
      "Exactly ONE replica. A second one would not error — it would",
      "silently serve half of a person's devices from a process that",
      "knows nothing about the other half.",
      "",
      "Published image only, and deliberately NO `build:` section: compose",
      "quietly builds a service it knows how to build when a pull fails,",
      "whatever `pull_policy` says, so a mistyped tag would turn into a",
      "memory-hungry build that is OOM-killed with nothing on screen",
      "saying why. Without `build:` the same failure stops with the",
      `registry's own error. To build from a clone instead, add`,
      `${SELFHOST_BUILD_OVERRIDE_REL} — see its header.`,
      "",
      "`missing` pulls on the first start and whenever the version",
      `variable changes (a new tag is a new image reference), then starts`,
      "from the local copy, so a restart does not need the registry.",
    ],
  });

  // ── The client half ──────────────────────────────────────────────────
  if (plan.hasClient) {
    services.push({
      name: "client",
      role: "client",
      image: `${plan.imageStem}-client-selfhost:${tag}`,
      published: [],
      expose: plan.ports.client,
      pulled: true,
      environment: [["PORT", `"${plan.ports.client}"`]],
      volumes: [],
      dependsOnHealthy: [],
      healthcheck: {
        test: ["CMD", "wget", "--spider", "-q", `http://127.0.0.1:${plan.ports.client}/`],
        interval: "30s",
        timeout: "5s",
        retries: 3,
        startPeriod: "10s",
        startInterval: "5s",
      },
      comment: [
        "── The web app ───────────────────────────────────────────────────",
        "",
        "A DIFFERENT image from the `-client` one the owner deploys: this",
        "is the build with an EMPTY NEXT_PUBLIC_API_URL, published under",
        "its own package name so the two cannot be confused at",
        "`docker pull` time. Pulling `-client` here would give you a login",
        "screen that posts to a domain you do not own.",
        "",
        "With no API URL compiled in, the bundle calls relative paths and",
        "derives its socket URL from the page's own origin, so this one",
        "image works behind anybody's domain. That is also why the app has",
        "to be served at the ROOT of the domain: a subpath would leave the",
        "socket URL pointing at the root.",
        "",
        "Pulled, never built here, for the same reason as `server` — and",
        "this is the image that makes the reason concrete, because the web",
        "build is the memory-hungry step.",
      ],
    });
  }

  // ── Datastores ───────────────────────────────────────────────────────
  if (plan.datastores.includes("mongo")) {
    services.push({
      name: "mongo",
      role: "datastore",
      image: "mongo:7",
      published: [],
      pulled: true,
      environment: [],
      volumes: ["mongo-data:/data/db", "mongo-config:/data/configdb"],
      dependsOnHealthy: [],
      healthcheck: {
        test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"],
        interval: "10s",
        timeout: "5s",
        retries: 10,
        startPeriod: "20s",
      },
      comment: [
        "── Database ──────────────────────────────────────────────────────",
        "",
        "No authentication and no published port: the only thing that can",
        "reach it is a container on this compose network. A password here",
        "would have to stay in sync with MONGODB_URI for no gain over",
        "that. To use a managed database instead, set MONGODB_URI (with",
        "its own credentials) and drop this service and its depends_on.",
      ],
    });
  }
  if (plan.datastores.includes("redis")) {
    services.push({
      name: "redis",
      role: "datastore",
      image: "redis:7-alpine",
      published: [],
      pulled: true,
      environment: [],
      volumes: ["redis-data:/data"],
      dependsOnHealthy: [],
      command: ["redis-server", "--appendonly", "yes"],
      healthcheck: {
        test: ["CMD", "redis-cli", "ping"],
        interval: "10s",
        timeout: "3s",
        retries: 5,
        startPeriod: "5s",
      },
      comment: [
        "── Cache ─────────────────────────────────────────────────────────",
        "",
        "Here because the server connects to it when REDIS_URL is set.",
        "Appendonly persistence, so the named volume below means",
        "something. Unset REDIS_URL and drop this service for the smallest",
        "possible stack — drop the depends_on entry with it.",
      ],
    });
  }

  return services;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Imported late to keep the module graph a tree: proxy.ts reads ports and
// routes from here, so the constant it needs lives here too.
/** Proxy config path, relative to the project root. Not the bare name
 *  `Caddyfile`: a project may already have one for something else, and
 *  clobbering it would be the exact surprise rule 1 of the feature
 *  contract forbids. */
export const PROXY_CONFIG_REL = "Caddyfile.selfhost";

/** Quote a YAML scalar only when it needs it. Values here carry compose
 *  interpolation (`${VAR:-default}`), which survives double quotes, so
 *  quoting when in doubt is safe. */
function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (/^".*"$/.test(value)) return value;
  if (/:\s/.test(value) || /^[\s>|&*!%@`{[#-]/.test(value) || /\s#/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function renderTestVector(test: readonly string[], indent: string): string[] {
  const inline = `[${test.map((t) => JSON.stringify(t)).join(", ")}]`;
  if (`${indent}test: ${inline}`.length <= 100) return [`${indent}test: ${inline}`];
  return [
    `${indent}test:`,
    `${indent}  [`,
    ...test.map((t) => `${indent}    ${JSON.stringify(t)},`),
    `${indent}  ]`,
  ];
}

/** Render one service. `extraEnvLines` is appended INSIDE the
 *  `environment:` block — not after the service, where the six-space
 *  indent would quietly land it inside whatever key came last and
 *  `docker compose config` would reject the file. */
function renderService(service: SelfHostService, extraEnvLines: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const line of service.comment) out.push(line ? `  # ${line}` : "  #");
  out.push(`  ${service.name}:`);
  out.push(`    image: ${service.image}`);
  if (service.pulled) {
    // Deliberately no `build:` for a pulled service — see failure 1 in
    // the module header. `missing` keeps a restart working offline.
    out.push("    pull_policy: missing");
  }
  out.push("    restart: unless-stopped");
  if (service.command) {
    out.push(`    command: [${service.command.map((c) => JSON.stringify(c)).join(", ")}]`);
  }
  if (service.published.length > 0) {
    out.push("    ports:");
    for (const p of service.published) out.push(`      - "${p}"`);
  }
  if (service.expose !== undefined) {
    out.push("    # No `ports:` — the proxy reaches it over the compose network.");
    out.push("    expose:");
    out.push(`      - "${service.expose}"`);
  }
  if (service.environment.length > 0 || extraEnvLines.length > 0) {
    out.push("    environment:");
    for (const [key, value] of service.environment) {
      out.push(`      ${key}: ${yamlScalar(value)}`);
    }
    for (const line of extraEnvLines) out.push(line ? `      ${line}` : "");
  }
  if (service.volumes.length > 0) {
    out.push("    volumes:");
    for (const v of service.volumes) out.push(`      - ${v}`);
  }
  if (service.dependsOnHealthy.length > 0) {
    out.push("    depends_on:");
    for (const dep of service.dependsOnHealthy) {
      out.push(`      ${dep}:`);
      out.push("        condition: service_healthy");
    }
  }
  out.push("    healthcheck:");
  out.push(...renderTestVector(service.healthcheck.test, "      "));
  out.push(`      interval: ${service.healthcheck.interval}`);
  out.push(`      timeout: ${service.healthcheck.timeout}`);
  out.push(`      retries: ${service.healthcheck.retries}`);
  out.push(`      start_period: ${service.healthcheck.startPeriod}`);
  if (service.healthcheck.startInterval) {
    out.push("      # Probe this often INSIDE start_period. Without it the first");
    out.push("      # probe waits a whole `interval`, so a service that is ready in");
    out.push("      # three seconds is reported `starting` for thirty — and the");
    out.push("      # proxy, gated on it, waits with it. Docker Engine 25.0+; an");
    out.push("      # older engine ignores the field and the stack still starts.");
    out.push(`      start_interval: ${service.healthcheck.startInterval}`);
  }
  return out;
}

/** The self-host compose file. Extra environment entries (the trust
 *  switches, mail, error reporting) are appended to the `server` service
 *  by the caller through `serverExtras`, so trust.ts owns their comments
 *  and this module owns the file's shape. */
export function renderSelfHostCompose(
  project: OperationalProject,
  opts: SelfHostOptions = {},
  serverExtras: readonly string[] = [],
): string {
  const plan = selfHostPlan(project, opts);
  const services = selfHostServices(project, opts);
  const lines: string[] = [];
  const routeSummary = plan.hasClient
    ? `${plan.apiPrefix}/* to the server, everything else to the web app`
    : `${plan.apiPrefix}/* and everything else to the server`;

  lines.push(
    ...ownedFileHeader(),
    `# One-command self-host stack for ${project.name}.`,
    "#",
    "#   cp .env.selfhost.example .env     # then edit APP_DOMAIN and the secret",
    `#   docker compose -f ${SELFHOST_COMPOSE_REL} up -d`,
    "#",
    `# \`up\` pulls the published images for \${${plan.versionKey}} and never builds.`,
    `# Building from a clone is opt-in: ${SELFHOST_BUILD_OVERRIDE_REL}.`,
    "#",
    "# ── Topology ─────────────────────────────────────────────────────────",
    "#",
    `# ONE domain. ${services[0].name} terminates TLS for $APP_DOMAIN and is the only`,
    `# container with published ports; everything else is reachable on the`,
    `# compose network alone. It sends ${routeSummary}.`,
    `# The routing rules live in ./${PROXY_CONFIG_REL}.`,
    "#",
    "# ── Why one domain instead of a baked-in API URL ─────────────────────",
    "#",
    "# The web bundle gets its API URL when the image is BUILT, so a client",
    "# image that knows an API URL is bound to that host for ever — every",
    "# self-hoster would have to build their own image before signing in",
    "# once. Built EMPTY instead, the bundle calls relative paths and derives",
    "# its socket URL from the page's own origin, so one published image",
    "# works behind anybody's domain and the proxy in front is what makes",
    "# them the same origin. It costs one DNS record instead of two, one",
    "# certificate instead of two, and it removes the cross-origin cookie and",
    "# CORS surface entirely.",
    "#",
    "# The app must therefore be served at the ROOT of the domain. Hosting it",
    `# under https://host/${project.name}/ breaks the socket, whose URL is`,
    "# derived from the page origin and would still resolve to the root.",
    "#",
    "# ── This is NOT the owner's production deploy ────────────────────────",
    "#",
    "# That one is the Coolify deployment described in the project's deploy",
    "# docs, where the platform's own proxy does the routing. Those files are",
    "# untouched by this one; nothing here interacts with them.",
    "",
    `name: ${project.name}`,
    "",
    "services:",
  );

  for (const [i, service] of services.entries()) {
    if (i > 0) lines.push("");
    lines.push(...renderService(service, service.role === "server" ? serverExtras : []));
  }

  const named = services
    .flatMap((s) => s.volumes)
    .map((v) => v.split(":")[0])
    .filter((v) => !v.startsWith("."));
  const unique = [...new Set(named)];
  if (unique.length > 0) {
    lines.push("", "volumes:");
    for (const v of unique) lines.push(`  ${v}:`);
  }
  return `${lines.join("\n")}\n`;
}

/** The opt-in override that builds both images from a clone.
 *
 *  The local tags are not cosmetic: a build tagged with the registry name
 *  would sit under a release tag it did not come from, and
 *  `pull_policy: missing` in the base file would then find it locally and
 *  never pull the real one — so a machine that built once before a
 *  release existed would keep running its own build as that release for
 *  good. `pull_policy: build` makes every `up` rebuild from cache, so an
 *  edited checkout cannot keep running a stale local image. */
export function renderSelfHostBuildOverride(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): string {
  const plan = selfHostPlan(project, opts);
  const lines: string[] = [
    ...ownedFileHeader(),
    "# Opt-in: build the app images from this clone instead of pulling them.",
    "#",
    `#   docker compose -f ${SELFHOST_COMPOSE_REL} \\`,
    `#                  -f ${SELFHOST_BUILD_OVERRIDE_REL} up -d --build`,
    "#",
    "# Give the machine 4 GB of RAM or more. The web build is the",
    "# memory-hungry step and is killed on the 1–2 GB box that pulling is",
    "# sized for.",
    "#",
    "# Use it when you changed the source, when the registry is unreachable",
    "# from the machine, or when you want a version that has no published",
    "# images. Everyone else runs the base file on its own, which pulls and",
    "# never builds — see the comment on its `server` service for why that",
    "# file carries no `build:` section of its own.",
    "#",
    "# ── Why the images get their own local names ─────────────────────────",
    "#",
    "# A build tagged with the registry name would sit under a release tag it",
    "# did not come from. `pull_policy: missing` in the base file then finds",
    "# that image locally and never pulls the real one, so a machine that",
    "# built once before a release existed would keep running the local build",
    "# as that release for good. A `:local` tag cannot be mistaken for a",
    "# release, and `docker image inspect` shows it with no RepoDigests,",
    "# which is how a pulled image is told apart from a built one.",
    "#",
    "# Both files must stay in the repository root: relative paths in an",
    "# override resolve against the directory of the FIRST `-f` file.",
    "",
    "services:",
    "  server:",
    `    image: ${project.name}-server:local`,
    "    pull_policy: build",
    "    build:",
    "      context: .",
    `      dockerfile: ${plan.serverDockerfile}`,
  ];
  if (plan.hasClient) {
    lines.push(
      "",
      "  client:",
      `    image: ${project.name}-client-selfhost:local`,
      "    pull_policy: build",
      "    build:",
      "      context: .",
      `      dockerfile: ${SELFHOST_CLIENT_DOCKERFILE_REL}`,
      "      args:",
      "        # Empty on purpose — this is the whole point of the self-host",
      "        # client image. With no API URL compiled in, the bundle calls",
      "        # relative paths and the proxy makes them the same origin as the",
      "        # page. A value here would bind the build to one host for ever.",
      '        NEXT_PUBLIC_API_URL: ""',
      "        # Same reasoning: the socket URL is derived from the page origin.",
      '        NEXT_PUBLIC_WS_URL: ""',
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The CI override the smoke workflow merges on top of the base file.
 *
 *  It changes two things and nothing else, so a boot that passes in CI is
 *  a boot of the file self-hosters actually run: the app images are the
 *  ones this run built (never pulled), and the healthchecks poll every
 *  five seconds so `--wait` returns in about a minute. The probes stay
 *  the base file's own.
 *
 *  Values the base file REQUIRES (`APP_DOMAIN`, the session secret) are
 *  deliberately absent: compose interpolates `${VAR:?}` from the
 *  environment before merging files, so an override cannot supply them.
 *  The workflow exports both. */
export function renderSelfHostCiOverride(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): string {
  const services = selfHostServices(project, opts);
  const lines: string[] = [
    ...ownedFileHeader(),
    "# CI override for the self-host stack. Used only by the smoke workflow:",
    "#",
    `#   docker compose -f ${SELFHOST_COMPOSE_REL} \\`,
    `#                  -f ${SELFHOST_CI_OVERRIDE_REL} up -d --wait`,
    "#",
    "# It changes two things about the base file and nothing else, so a boot",
    "# that passes here is a boot of the file self-hosters run:",
    "#",
    "#   1. The app images are the ones the workflow just built from this",
    "#      checkout, under local tags, and are never pulled. Without this",
    "#      the base file's `image:` keys would pull the last published",
    "#      release and the smoke test would prove that an OLD image boots.",
    "#   2. Healthchecks poll every 5 seconds instead of every 30, so",
    "#      `--wait` returns in about a minute. Intervals only; the probes",
    "#      are the base file's own.",
    "#",
    "# The site address comes from APP_DOMAIN=localhost in the workflow's",
    "# environment. The proxy never asks a public CA for `localhost` and",
    "# serves it from its internal CA instead, so the stack runs with TLS and",
    "# with no DNS, no public IP and no rate limit to hit.",
    "#",
    "# Values the base file requires (APP_DOMAIN, the session secret) are NOT",
    "# set here: compose interpolates `${VAR:?}` from the environment before",
    "# merging files, so an override cannot provide them. The workflow",
    "# exports both.",
    "",
    "services:",
  ];
  for (const [i, service] of services.entries()) {
    if (i > 0) lines.push("");
    lines.push(`  ${service.name}:`);
    if (service.role === "server" || service.role === "client") {
      lines.push(`    image: ${ciImageTag(project, service.role)}`);
      lines.push("    pull_policy: never");
    }
    lines.push("    healthcheck:");
    lines.push("      interval: 5s");
    if (service.role !== "datastore") {
      lines.push(`      start_period: ${service.role === "server" ? "60s" : "30s"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Local tag the smoke workflow builds a half under, and the CI override
 *  pins. One function so the workflow and the override cannot drift. */
export function ciImageTag(project: OperationalProject, role: "server" | "client"): string {
  return role === "server"
    ? `${project.name}-server:selfhost-ci`
    : `${project.name}-client-selfhost:selfhost-ci`;
}

/**
 * Derive the self-host client Dockerfile from the project's own.
 *
 * The ordinary client Dockerfile sets `HATCHKIT_IMAGE_BUILD=1`, which
 * makes the web build fail loudly when `NEXT_PUBLIC_API_URL` is missing
 * — exactly right for a production image, and exactly wrong here, where
 * an EMPTY API URL is the point. So the derived file is the project's
 * own with that one guard removed and a header saying why.
 *
 * Returns the input UNCHANGED when the guard is absent: a hand-rolled
 * Dockerfile that already knows what it is doing is safer left alone
 * than half-rewritten. Idempotent — a file that already carries the
 * header comes back untouched.
 */
export function selfHostClientDockerfile(base: string): string {
  if (base.includes(SELFHOST_DOCKERFILE_MARKER)) return base;
  if (!/HATCHKIT_IMAGE_BUILD\s*=\s*1/.test(base)) return base;
  const stripped = stripDocsBuild(
    base
      // Last entry of a multi-line `ENV a=b \` chain: the continuation
      // backslash on the previous line has to go with it.
      .replace(/[ \t]*\\\r?\n[ \t]*HATCHKIT_IMAGE_BUILD=1[ \t]*(?=\r?\n|$)/g, "")
      // A line of its own.
      .replace(/^[ \t]*(?:ENV[ \t]+)?HATCHKIT_IMAGE_BUILD=1[ \t]*\r?\n/gm, ""),
  );
  const header = [
    ...ownedFileHeader(),
    `# ${SELFHOST_DOCKERFILE_MARKER}`,
    "#",
    "# Generated from the project's own client Dockerfile, with one change:",
    "# the HATCHKIT_IMAGE_BUILD guard is gone.",
    "#",
    "# That guard fails the build when NEXT_PUBLIC_API_URL is empty, which is",
    "# right for the production image and wrong for this one. Here the API URL",
    "# is empty ON PURPOSE: with no URL compiled in, the bundle calls relative",
    "# paths and derives its socket URL from the page's own origin, so ONE",
    "# published image works behind anybody's domain. Baking a URL in would",
    "# bind the image to one host for ever and force every self-hoster to",
    "# build their own before they could sign in once.",
    "#",
    "# The app must therefore be served at the ROOT of its domain.",
    "",
  ].join("\n");
  return header + stripped;
}

/**
 * Remove the docs-into-the-client-image steps, if the project has them.
 *
 * Two reasons, and either alone is enough.
 *
 * **The self-host image must not carry the docs.** They are published at
 * one address, on the project's own domain. A self-hosted instance runs
 * on somebody else's domain and links to the published copy; building a
 * second copy into every self-host image would put the same pages on
 * every instance's hostname, which is the duplicate-content problem the
 * docs feature exists to avoid, multiplied by the number of installs.
 *
 * **And without this, the derivation is not idempotent.** This file is
 * derived from the project's own client Dockerfile, and the docs module
 * retrofits that Dockerfile AFTER this module runs. So the first apply
 * derives from a Dockerfile with no docs step and the second derives
 * from one with it, and `hatchkit update` rewrites this file on the run
 * after the docs land — a diff nobody asked for, in a file nobody
 * edited. Stripping the steps makes the output the same whichever order
 * the two modules run in, which is the property the ledger's
 * `unchanged` depends on.
 *
 * Matched on the docs build script's path, which is what the docs
 * module keys its own idempotence on, so the two agree on what "has the
 * docs step" means.
 */
function stripDocsBuild(content: string): string {
  if (!content.includes(DOCS_BUILD_SCRIPT_PATH)) return content;
  return (
    content
      // The build step, inserted after the client build as a blank line
      // followed by its comment paragraph. Removing exactly that —
      // blank line included — is what leaves the surrounding spacing
      // byte-identical to a Dockerfile the docs step never touched.
      .replace(/\n\n(?:#[^\n]*\n)*RUN node [^\n]*build-into-client\.mjs[^\n]*/g, "")
      // Its sources, and the one comment line introducing them.
      .replace(
        /\n# The docs site and the step that builds it into[^\n]*\nCOPY [^\n]*\nCOPY [^\n]*/g,
        "",
      )
      // Its manifest, in the dependency stage.
      .replace(/\nCOPY \S+\/package\.json \S*docs\S*\//g, "")
  );
}

/** The docs module's build script, by path. Kept as a literal rather
 *  than imported so this module does not depend on that one — they are
 *  independent, and only the generated artefact connects them. */
const DOCS_BUILD_SCRIPT_PATH = "scripts/docs/build-into-client.mjs";

/** Marker line that makes {@link selfHostClientDockerfile} idempotent. */
export const SELFHOST_DOCKERFILE_MARKER = "Self-host client image — EMPTY NEXT_PUBLIC_API_URL.";
