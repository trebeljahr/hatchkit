/**
 * Shutdown drain — keeping a stopping container out of the proxy before it
 * stops serving.
 *
 * Coolify deploys by starting the new container, waiting for it to turn
 * healthy, then running `docker stop` on the old one. Traefik keeps routing
 * to the old container until it has EXITED, so a request sent to it while it
 * shuts down gets a 502, and one in flight when its network goes away hangs
 * into a 504. Two things make Traefik drop a container early: a failed check
 * of Traefik's own load-balancer health check, and the container's Docker
 * health leaving `healthy`.
 *
 * So on SIGTERM (index.ts) the server drains first: both probes get a 503,
 * every other request is served as usual, and the server only closes after
 * SHUTDOWN_DRAIN_SECONDS — by then Traefik has dropped it.
 *
 * Only the PROBES get the 503, so a monitor or the deploy job polling
 * /api/health from outside is still answered:
 *  - Docker's (`/api/health`, app.ts) — Coolify runs it inside the container
 *    against 127.0.0.1; visitors never arrive over loopback.
 *  - Traefik's (any path, app.ts) — sent straight from Traefik with an
 *    `X-Hatchkit-Drain` header. A visitor's request is FORWARDED by Traefik,
 *    which always adds X-Forwarded-For, so a visitor sending the header is
 *    not mistaken for the probe.
 *
 * Docker's probe fails at once; Traefik's only after a grace — a quarter of
 * the drain, at most 4 s. Traefik drops a container on ONE failed check, and
 * Coolify stops this one as soon as Docker calls the new one healthy, which
 * Traefik can take 2 s more to add. Failing at once could empty the pool.
 */
import type { IncomingHttpHeaders } from "node:http";

let draining = false;
let proxyDrainsAt = 0;

/** Start draining; `drainSeconds` is the whole drain, which sets the grace. */
export function startDraining(drainSeconds = 0): void {
  draining = true;
  proxyDrainsAt = Date.now() + Math.min(4000, (drainSeconds * 1000) / 4);
}

export function isDraining(): boolean {
  return draining;
}

/** Whether Traefik's probe should fail yet (see the grace above). */
export function isProxyDraining(): boolean {
  return draining && Date.now() >= proxyDrainsAt;
}

/**
 * Whether a socket's peer is this container — the in-container health probe.
 * Takes `req.socket.remoteAddress`, not `req.ip`: with `trust proxy` set,
 * `req.ip` is the visitor address Traefik forwarded.
 */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Whether a request is Traefik's load-balancer health check (see above). */
export function isTraefikProbe(headers: IncomingHttpHeaders): boolean {
  return headers["x-hatchkit-drain"] !== undefined && headers["x-forwarded-for"] === undefined;
}
