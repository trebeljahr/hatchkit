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
 *
 * ---------------------------------------------------------------------
 * The last second: removing the old container
 * ---------------------------------------------------------------------
 *
 * A rolling update keeps the site up, but measured on 2026-09-29 the
 * moment Coolify removes the old container (`docker stop -t 30`, then
 * `docker rm -f`) still cost ~1 s of 502s plus requests that hung for
 * 30 s and ended in 504. Traefik's Docker provider routes to a
 * container until it has EXITED — it refreshes on `start`, `die` and
 * `health_status` events, and nothing else — so requests written to it
 * while it shuts down fail, and ones in flight when its network endpoint
 * goes away are blackholed. Traefik's retry middleware does not help:
 * it gives up on any request that was already written upstream.
 *
 * The fix is to DRAIN: the old container has to leave Traefik before it
 * stops serving. Two levers do that: Docker health — Traefik skips every
 * container that is not `healthy` — and Traefik's own load-balancer
 * health check, which hatchkit adds to an app's labels once its image
 * answers it (deploy/traefik-drain.ts). So every hatchkit image, on
 * SIGTERM:
 *
 *   1. answers the health probes with 503 while still serving real
 *      traffic. Coolify's probe runs inside the container against
 *      127.0.0.1, Traefik's comes without X-Forwarded-For, and visitors
 *      arrive forwarded by Traefik, so only the probes get the 503;
 *   2. waits {@link SHUTDOWN_DRAIN_SECONDS} — long enough for Traefik's
 *      check, or Docker's `retries` failed probes, to drop it;
 *   3. only then closes its listener and exits.
 *
 * The images read the delay from `SHUTDOWN_DRAIN_SECONDS`, baked in as
 * an ENV line; unset or 0 turns draining off (dev, tests, and compose
 * apps, whose container is stopped before its replacement starts).
 *
 * That puts two budgets on the SAME three numbers, because Coolify's
 * deploy loop reuses Docker's settings: it sleeps `start_period`, then
 * polls the new container's health up to `retries` times, `interval`
 * apart, before giving up on it.
 *
 *   · Drain — Docker marks a container unhealthy after `retries`
 *     consecutive failed probes, spaced `interval` from the end of one
 *     to the start of the next. So `retries × interval` (plus probe time
 *     and Traefik's 2 s provider throttle) has to fit well inside the
 *     30 s `docker stop` grants, with room left to close.
 *   · Boot — a new container gets `start_period` plus `retries` polls to
 *     turn healthy. Failed probes inside the start period don't count.
 *
 * `retries × interval` can't serve both: 60 s gives a slow boot plenty
 * of polls and can never drain inside 30 s. `start_period` is the lever
 * that only the boot budget reads, so it carries the boot time and
 * `retries × interval` stays short. Its cost is latency, not downtime —
 * Coolify sleeps the whole start period before its first poll, and the
 * old container serves all the while.
 *
 * Once Traefik's own check drains the app, Docker's check carries the
 * boot budget alone and can probe far less often
 * ({@link TRAEFIK_DRAIN_TIMING} vs {@link DOCKER_DRAIN_TIMING}).
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
 *  encoded as Coolify's `sha256-<hex>` tag; its deployment renderer turns
 *  that back into `name@sha256:<hex>` instead of a mutable tag. */
export function parseImageRef(ref: string, defaultTag = "latest"): ImageRef {
  const trimmed = ref.trim();
  const digest = trimmed.match(/^(.+)@sha256:([a-f0-9]{64})$/);
  if (digest) return { name: digest[1], tag: `sha256-${digest[2]}` };
  if (trimmed.includes("@")) return { name: trimmed, tag: "" };
  const slash = trimmed.lastIndexOf("/");
  const colon = trimmed.lastIndexOf(":");
  if (colon > slash) {
    return { name: trimmed.slice(0, colon), tag: trimmed.slice(colon + 1) || defaultTag };
  }
  return { name: trimmed, tag: defaultTag };
}

export function formatImageRef(ref: ImageRef): string {
  if (/^sha256-[a-f0-9]{64}$/.test(ref.tag)) return `${ref.name}@sha256:${ref.tag.slice(7)}`;
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

/** Docker health-check timing for an app whose drain runs on Docker's
 *  check — every app until `hatchkit sync` gives it Traefik's own check
 *  ({@link TRAEFIK_DRAIN_TIMING}). See "The last second" at the top of
 *  this file for the two budgets these serve.
 *
 *  · Drain: 3 failed probes 4 s apart. A stopping container is
 *    unhealthy ~9–13.5 s after SIGTERM and out of Traefik ≤ 2 s later,
 *    15.5 s at worst ({@link worstCaseDrainDropSeconds}) — 4.5 s inside
 *    the 20 s drain.
 *  · Boot: Coolify sleeps 15 s, then polls 3 times ~5 s apart (4 s plus
 *    a round trip to the server). Docker's own count ends first: its
 *    third failed probe after the start period, ~24 s in, marks the
 *    container unhealthy. Measured 2026-09-29: an nginx image is healthy
 *    at Coolify's first poll; collection-of-beauty (Next.js standalone
 *    behind dotenvx) took 5–15 s. A deploy that needs longer fails and
 *    the old container keeps serving — safe, just not shipped.
 *
 *  The interval is Docker's probe rate for the container's whole life,
 *  not just a deploy: one `docker exec` of curl per probe, per container.
 *  Until 2026-10-15 this was 2 s × 5 — ~10 execs a second across 21
 *  containers on one VPS. 4 s × 3 halves that and still drains in time;
 *  5 s × 3 would leave 1.5 s of margin, too little for a busy host.
 *  Tripping it in steady state still takes failures spanning
 *  `(retries - 1) × interval` = 8 s, as before. */
export const DOCKER_DRAIN_TIMING = {
  intervalSeconds: 4,
  timeoutSeconds: 5,
  retries: 3,
  startPeriodSeconds: 15,
} as const;

/** Docker health-check timing for an app whose drain runs on Traefik's
 *  own check (deploy/traefik-drain.ts). Docker's check then only has to
 *  tell Coolify the new container is ready, so it probes every 10 s:
 *  a fifth of the execs of {@link DOCKER_DRAIN_TIMING}.
 *
 *  · Boot: Coolify sleeps 15 s and polls at ~15, ~26 and ~37 s; Docker
 *    probes every 10 s and marks the container unhealthy at its third
 *    failure after the start period, ~40 s in. So a new container that
 *    answers by ~30 s ships. One healthy by 10 s is seen at Coolify's
 *    first poll, as before — Coolify sleeps the start period anyway.
 *  · Steady state: a container whose health path fails leaves Traefik
 *    after ~20–30 s instead of ~8–12 s. Traefik's check doesn't cover
 *    that: the images answer it without asking the app. */
export const TRAEFIK_DRAIN_TIMING = {
  intervalSeconds: 10,
  timeoutSeconds: 5,
  retries: 3,
  startPeriodSeconds: 15,
} as const;

/** Traefik's load-balancer health check on an app's containers
 *  (deploy/traefik-drain.ts). One failed check takes a container out of
 *  the pool, one passing check puts it back, and it is a plain HTTP
 *  request from Traefik — no exec. The interval also bounds how long a
 *  draining container is routed again after any Traefik reload, which
 *  resets every check to "up". */
export const TRAEFIK_HEALTH = {
  intervalSeconds: 2,
  timeoutSeconds: 5,
} as const;

/** How long after SIGTERM a draining image keeps PASSING Traefik's check
 *  (capped at a quarter of the drain). Coolify stops the old container
 *  as soon as Docker calls the new one healthy, and Traefik can take its
 *  2 s throttle to add the new one; failing at once could leave Traefik
 *  no server at all, and it answers 503. Docker's probe fails at once.
 *  Hardcoded in each image (drain.cjs, the nginx entrypoint, the starter
 *  server's drain.ts) and pinned to this by test-shutdown-drain.ts. */
export const TRAEFIK_PROBE_GRACE_SECONDS = 4;

/** How long a stopping hatchkit container keeps serving while failing
 *  its health probe, before it closes. Baked into every image as
 *  `ENV SHUTDOWN_DRAIN_SECONDS=…` — the scaffolded Dockerfiles and the
 *  build-pipeline templates — and pinned to this value by
 *  test-image-runtime.ts.
 *
 *  Has to sit between two bounds (the same test checks both):
 *  above {@link worstCaseDrainDropSeconds} (and its Traefik twin) plus a
 *  margin, or requests
 *  still reach the container after it closes; and below Coolify's 30 s
 *  `docker stop` minus the time to close, or Docker SIGKILLs it
 *  mid-request. */
export const SHUTDOWN_DRAIN_SECONDS = 20;

/** Coolify's `docker stop -t` on the old container
 *  (`graceful_shutdown_container`, 4.0.0-beta.469). SIGKILL after. */
export const COOLIFY_STOP_TIMEOUT_SECONDS = 30;

/** Traefik's `providersThrottleDuration` default: after applying one
 *  configuration it waits this long before applying the next. */
export const TRAEFIK_PROVIDER_THROTTLE_SECONDS = 2;

/** Allowance per probe for Docker to exec curl in the container and get
 *  the 503 back. Usually ~0.1–0.3 s; doubled for a busy host. */
export const PROBE_OVERHEAD_SECONDS = 0.5;

/** Latest a draining container can still be in Traefik's routing
 *  table, counted from SIGTERM: the next probe starts within one
 *  interval, `retries` failures later Docker flips it to unhealthy, and
 *  Traefik applies that within its throttle. */
export function worstCaseDrainDropSeconds(
  timing: Pick<HealthCheckSpec, "intervalSeconds" | "retries"> = DOCKER_DRAIN_TIMING,
): number {
  return (
    timing.retries * (timing.intervalSeconds + PROBE_OVERHEAD_SECONDS) +
    TRAEFIK_PROVIDER_THROTTLE_SECONDS
  );
}

/** The same bound when Traefik's own check drains: the image passes it
 *  for the grace, the next check fails within one interval, and Traefik
 *  takes the container out at once — no provider reload involved. */
export function worstCaseTraefikDrainDropSeconds(): number {
  return TRAEFIK_PROBE_GRACE_SECONDS + TRAEFIK_HEALTH.intervalSeconds + PROBE_OVERHEAD_SECONDS;
}

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
 *  app IS the server, so it gets the server's endpoint.
 *
 *  `traefikDrain`: the app carries Traefik's own check, so Docker's can
 *  be slow ({@link TRAEFIK_DRAIN_TIMING}). */
export function healthCheckFor(
  role: ImageAppRole,
  opts: { surfaces?: string; path?: string; traefikDrain?: boolean } = {},
): HealthCheckSpec {
  const serverish = role === "server" || (role === "app" && opts.surfaces === "backend");
  return {
    path: opts.path ?? (serverish ? "/api/health" : "/"),
    ...(opts.traefikDrain ? TRAEFIK_DRAIN_TIMING : DOCKER_DRAIN_TIMING),
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
    // Not `localhost`: busybox wget (every Alpine image) resolves it to
    // ::1 first, and a server bound to 0.0.0.0 — Next.js standalone with
    // HOSTNAME=0.0.0.0 — refuses that, so the check fails on a healthy
    // container. 127.0.0.1 reaches IPv4-only and dual-stack listeners.
    health_check_host: "127.0.0.1",
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
 *  the rolling-update decision cares. A field Coolify didn't return is
 *  undefined. */
export interface LiveHealthCheck {
  enabled?: boolean;
  path?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  retries?: number;
  startPeriodSeconds?: number;
}

/** The health check `sync` should push onto a live image app, or
 *  `undefined` when there is nothing to change.
 *
 *  · Off → `fallback`, the role's full check. Without it there is no
 *    rolling update at all.
 *  · On, with timing other than `fallback`'s → the same check with
 *    `fallback`'s timing. An app created before draining has 5 s × 12:
 *    its old container stays routed for 60 s after SIGTERM, long after
 *    it has exited, so every deploy ends in 502s. One created before
 *    2026-10-15 has 2 s × 5: it drains, at twice the probes. The path is
 *    kept — one somebody chose is theirs.
 *  · Timing Coolify didn't return can't be compared, so it never forces
 *    a PATCH on its own. */
export function healthCheckToConverge(
  live: LiveHealthCheck,
  fallback: HealthCheckSpec,
): HealthCheckSpec | undefined {
  if (live.enabled !== true) return fallback;
  const drifted = (["intervalSeconds", "timeoutSeconds", "retries", "startPeriodSeconds"] as const)
    .filter((k) => live[k] !== undefined)
    .some((k) => live[k] !== fallback[k]);
  if (!drifted) return undefined;
  return { ...fallback, path: live.path || fallback.path };
}

/** Why an application will NOT get a zero-downtime deploy, or `null`
 *  when it will. Pure, so `doctor` and `migrate-runtime` share it. */
export function rollingUpdateBlocker(app: {
  buildPack?: string;
  healthCheck?: LiveHealthCheck;
  portsMappings?: string | null;
  customDockerRunOptions?: string | null;
  isConsistentContainerNameEnabled?: boolean;
  customInternalName?: string | null;
}): string | null {
  if (app.buildPack === "dockercompose") {
    return "Docker Compose app — Coolify stops the old container before starting the new one";
  }
  if (
    !app.buildPack ||
    !["dockerimage", "dockerfile", "nixpacks", "static"].includes(app.buildPack)
  ) {
    return `unsupported or unknown build pack (${app.buildPack ?? "not returned"}) — rolling updates cannot be verified`;
  }
  if (app.isConsistentContainerNameEnabled) {
    return "consistent container name enabled — Coolify stops the old container before starting its replacement";
  }
  if (app.customInternalName?.trim()) {
    return "custom internal container name set — Coolify stops the old container before starting its replacement";
  }
  if (app.portsMappings && app.portsMappings.trim() !== "") {
    return `host port mapping (${app.portsMappings}) — two containers can't bind the same port, so Coolify stops the old one first`;
  }
  if (app.customDockerRunOptions?.includes("--ip")) {
    // Match Coolify's substring check, which also catches e.g. --ipc.
    return "docker run option containing --ip — Coolify stops the old container first";
  }
  if (app.healthCheck?.enabled !== true) {
    return "health check off — Coolify removes the old container the moment the new one starts, before it can serve";
  }
  return null;
}

/** Some Coolify API builds omit application settings entirely. Missing
 * naming flags do not prove that rolling updates are enabled. */
export function rollingUpdateNamingUnknown(app: {
  isConsistentContainerNameEnabled?: boolean;
  customInternalName?: string | null;
}): boolean {
  return app.isConsistentContainerNameEnabled === undefined || app.customInternalName === undefined;
}
