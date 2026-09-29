/**
 * Shutdown drain — keeping a stopping container out of the proxy before it
 * stops serving.
 *
 * Coolify deploys by starting the new container, waiting for it to turn
 * healthy, then running `docker stop` on the old one. Traefik keeps routing
 * to the old container until it has EXITED, so a request sent to it while it
 * shuts down gets a 502, and one in flight when its network goes away hangs
 * into a 504. The one thing that makes Traefik drop a container early is its
 * Docker health leaving `healthy`.
 *
 * So on SIGTERM (index.ts) the server drains first: `/api/health` answers the
 * health probe with 503, every other request is served as usual, and the
 * server only closes after SHUTDOWN_DRAIN_SECONDS — by then Docker has
 * counted enough failed probes to mark the container unhealthy, and Traefik
 * has dropped it.
 *
 * Only the PROBE gets the 503. Coolify runs it inside the container against
 * 127.0.0.1; visitors arrive from Traefik, never over loopback. So a monitor
 * or the deploy job polling /api/health from outside is still answered.
 */

let draining = false;

export function startDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Whether a socket's peer is this container — the in-container health probe.
 * Takes `req.socket.remoteAddress`, not `req.ip`: with `trust proxy` set,
 * `req.ip` is the visitor address Traefik forwarded.
 */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
