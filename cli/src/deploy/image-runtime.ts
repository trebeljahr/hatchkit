/*
 * How a hatchkit project's containers are run on Coolify, and why that
 * decides whether a deploy takes the site down.
 *
 * ---------------------------------------------------------------------
 * The gap
 * ---------------------------------------------------------------------
 *
 * Until this module every hatchkit app was a Coolify `dockercompose`
 * application. Coolify deploys those with `docker compose up -d`, which
 * STOPS the running container and then starts its replacement. From the
 * stop until the new process listens and Traefik picks it up, every
 * request gets a 502/503/404. That was the outage on every push.
 *
 * Coolify's rolling update — start the new container, wait for its
 * health check, only then stop the old one — exists only for
 * Nixpacks / Dockerfile / Docker Image / Static applications
 * (`rolling_update()` in ApplicationDeploymentJob, verified at
 * v4.0.0-beta.469). The docs say it outright: "Rolling updates are not
 * supported for Docker Compose applications."
 *
 * So the fix is structural, not a flag: each routed service becomes its
 * own Coolify **Docker Image** application, pointed at the GHCR image
 * the GitHub Actions pipeline already builds. That is `image` runtime.
 * `compose` is the legacy shape, kept so already-deployed projects keep
 * working until `hatchkit migrate-runtime` moves them.
 *
 * ---------------------------------------------------------------------
 * What else has to be true for the rolling update to happen
 * ---------------------------------------------------------------------
 *
 * Coolify silently falls back to stop-then-start when any of these hold
 * (same function, same build):
 *
 *   · host port mappings (`ports_mappings`)
 *   · "consistent container name" or a custom internal name
 *   · `--ip` / `--ip6` in custom docker run options
 *
 * hatchkit sets none of them. `custom_network_aliases` is NOT on that
 * list, so a stable internal hostname stays available if one is needed.
 *
 * And the health check has to be ON. With it off, Coolify treats a
 * container that has merely STARTED as ready and removes the old one
 * immediately — the new Node process is still booting, so requests
 * fail anyway, just for a shorter window. With it on:
 *
 *   · Coolify waits for Docker to report the new container healthy
 *     before it stops the old one.
 *   · Traefik's Docker provider skips containers whose health is not
 *     `healthy`, so the new container gets no traffic while starting.
 *   · A new container that never turns healthy fails the deployment and
 *     is removed; the OLD container keeps serving. A broken build no
 *     longer takes the site down at all.
 *
 * Coolify's HTTP check runs INSIDE the container as
 * `curl -s -X GET -f <url> > /dev/null || wget -q -O- <url> > /dev/null || exit 1`
 * (`generate_healthcheck_commands`), and it REPLACES the image's own
 * HEALTHCHECK. So every runtime image must ship curl or wget: Alpine
 * images have busybox wget; `node:*-bookworm-slim` has neither, which is
 * why the scaffolded Debian runtime stages install curl. The `cmd` check
 * type is no way around it — Coolify only accepts `[a-zA-Z0-9 -_./:=@,+]`
 * there, so a `node -e "fetch(…)"` one-liner is rejected.
 */

/** How the project's services are placed on Coolify. Persisted in the
 *  manifest as `coolifyRuntime`. */
export type CoolifyRuntime = "image" | "compose";

export const COOLIFY_RUNTIMES: readonly CoolifyRuntime[] = ["image", "compose"] as const;

export function isCoolifyRuntime(v: unknown): v is CoolifyRuntime {
  return typeof v === "string" && (COOLIFY_RUNTIMES as readonly string[]).includes(v);
}

/** The runtime a NEW project gets. Existing manifests without the field
 *  stay on `compose` — see {@link resolveCoolifyRuntime}. */
export const DEFAULT_NEW_PROJECT_RUNTIME: CoolifyRuntime = "image";

/** Resolve the runtime for a manifest that may predate the field.
 *
 *  Absent means `compose`: every manifest written before this field came
 *  from a run that created a `dockercompose` app, and reading it as
 *  `image` would make `sync` look for applications that don't exist. */
export function resolveCoolifyRuntime(value: unknown): CoolifyRuntime {
  return isCoolifyRuntime(value) ? value : "compose";
}

/** A registry image split into the two fields Coolify stores
 *  (`docker_registry_image_name`, `docker_registry_image_tag`). */
export interface ImageRef {
  name: string;
  tag: string;
}

/** Parse `ghcr.io/o/r:main` / `ghcr.io/o/r` / `localhost:5000/r:tag`.
 *  A colon only separates a tag when it comes after the last `/`, so a
 *  registry port is never mistaken for one. Digests (`@sha256:…`) are
 *  returned with an empty tag — Coolify has its own spelling for them
 *  and hatchkit never produces one. */
export function parseImageRef(ref: string, defaultTag = "latest"): ImageRef {
  const trimmed = ref.trim();
  if (trimmed.includes("@")) return { name: trimmed, tag: "" };
  const slash = trimmed.lastIndexOf("/");
  const colon = trimmed.lastIndexOf(":");
  if (colon > slash) {
    return { name: trimmed.slice(0, colon), tag: trimmed.slice(colon + 1) || defaultTag };
  }
  return { name: trimmed, tag: defaultTag };
}

export function formatImageRef(ref: ImageRef): string {
  return ref.tag ? `${ref.name}:${ref.tag}` : ref.name;
}

/** Coolify health-check settings for one application. Field names match
 *  the API's `health_check_*` keys minus the prefix. */
export interface HealthCheckSpec {
  /** Request path, e.g. `/api/health`. */
  path: string;
  /** Container port to probe. Undefined = Coolify's default, the first
   *  `ports_exposes` entry — which is the right port for every app
   *  hatchkit creates, so this is left unset unless a caller knows
   *  better. */
  port?: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  retries: number;
  startPeriodSeconds: number;
}

/** Health-check timing for every hatchkit app.
 *
 *  Coolify waits `startPeriod`, then probes up to `retries` times,
 *  `interval` apart, before declaring the new container unhealthy and
 *  keeping the old one. 5 + 12 × 5 s gives a server a minute to connect
 *  to its database and listen — generous for a Node process, and a
 *  deploy that needs longer is one worth failing. The interval is also
 *  Docker's steady-state probe rate, and one local HTTP request every
 *  five seconds costs nothing. */
const HEALTH_TIMING = {
  intervalSeconds: 5,
  timeoutSeconds: 5,
  retries: 12,
  startPeriodSeconds: 5,
} as const;

/** Which half of a deployment an image app is. `app` is the single
 *  application of a one-service deployment (a static site, or a backend
 *  that owns the bare domain). */
export type ImageAppRole = "app" | "client" | "server";

/** The health check an image app should carry.
 *
 *  The server has a real readiness endpoint — `/api/health` in the
 *  starter, which is also what the deploy job polls for the commit sha.
 *  Everything else is probed at `/`: a static nginx or a Next.js server
 *  that answers `/` is ready to serve. `curl -f` treats a 3xx as success,
 *  so a root that redirects still passes. A backend-only project's single
 *  app IS the server, so it gets the server's endpoint. */
export function healthCheckFor(
  role: ImageAppRole,
  opts: { surfaces?: string; path?: string } = {},
): HealthCheckSpec {
  const serverish = role === "server" || (role === "app" && opts.surfaces === "backend");
  return {
    path: opts.path ?? (serverish ? "/api/health" : "/"),
    ...HEALTH_TIMING,
  };
}

/** Coolify's `health_check_*` payload for a spec. `enabled` is sent
 *  explicitly — a PATCH that only moved the path would otherwise leave a
 *  disabled check disabled. `health_check_type` is deliberately absent:
 *  HTTP is its default, and builds older than the field reject it as
 *  "not allowed", failing the whole request. */
export function healthCheckPayload(spec: HealthCheckSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    health_check_enabled: true,
    health_check_path: spec.path,
    health_check_method: "GET",
    health_check_scheme: "http",
    health_check_host: "localhost",
    health_check_return_code: 200,
    health_check_interval: spec.intervalSeconds,
    health_check_timeout: spec.timeoutSeconds,
    health_check_retries: spec.retries,
    health_check_start_period: spec.startPeriodSeconds,
  };
  if (spec.port !== undefined) body.health_check_port = String(spec.port);
  return body;
}

/** What Coolify currently holds for an app's health check, as far as
 *  the rolling-update decision cares. */
export interface LiveHealthCheck {
  enabled?: boolean;
  path?: string;
}

/** Why an application will NOT get a zero-downtime deploy, or `null`
 *  when it will. Pure, so `doctor` and `migrate-runtime` share it. */
export function rollingUpdateBlocker(app: {
  buildPack?: string;
  healthCheck?: LiveHealthCheck;
  portsMappings?: string | null;
  customDockerRunOptions?: string | null;
}): string | null {
  if (app.buildPack === "dockercompose") {
    return "Docker Compose app — Coolify stops the old container before starting the new one";
  }
  if (app.portsMappings && app.portsMappings.trim() !== "") {
    return `host port mapping (${app.portsMappings}) — two containers can't bind the same port, so Coolify stops the old one first`;
  }
  if (app.customDockerRunOptions && /--ip6?\b/.test(app.customDockerRunOptions)) {
    return "custom --ip in docker run options — Coolify stops the old container first";
  }
  if (app.healthCheck?.enabled !== true) {
    return "health check off — Coolify removes the old container the moment the new one starts, before it can serve";
  }
  return null;
}
