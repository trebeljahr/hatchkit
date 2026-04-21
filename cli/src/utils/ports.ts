/*
 * Port picker.
 *
 * At scaffold time we assign each project a fixed set of ports so dev
 * servers across multiple scaffolded projects don't collide on
 * localhost. Ports come from three disjoint 1000-slot ranges:
 *
 *   server       5000 – 5999   Express API / backend
 *   client       6000 – 6999   Next.js web dev server
 *   nativeHmr    7000 – 7999   Next dev server for Capacitor + Electron
 *                              (only picked when desktop or mobile is
 *                               selected, so regular web + native can
 *                               run side-by-side without stomping)
 *
 * Two layers of collision avoidance:
 *   1. The CLI config tracks ports handed out to prior `devops-cli
 *      create` runs (usedPorts registry) — avoids picking the same
 *      port twice across scaffolds on this machine.
 *   2. Each candidate is tested by actually binding to it on
 *      127.0.0.1. If a non-scaffolded process holds the port (someone
 *      else's dev server, a system service, etc.) we skip it and try
 *      the next. This is the bit that makes the picked port "real"
 *      enough to commit to .env.development.
 *
 * The scan order is: pick a random starting point inside the range,
 * then step forward from there, wrapping at the end. That gives
 * decent distribution across the range while also feeling like
 * "auto-increment until free" at the low level.
 */

import { createServer } from "node:net";

export const PORT_RANGES = {
  server: [5000, 5999] as const,
  client: [6000, 6999] as const,
  nativeHmr: [7000, 7999] as const,
};

/** Test whether a port is free to bind on 127.0.0.1. Resolves with
 *  `true` if we could successfully open + immediately close a listener
 *  on it; `false` if the bind failed for any reason (EADDRINUSE,
 *  permission, etc.). Always resolves — never throws. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** Pick a port in [min, max] that is (a) not in the used-ports
 *  registry and (b) actually free to bind on 127.0.0.1. Scans
 *  sequentially from a random starting point, wrapping once. Throws
 *  if every port in the range is either registered or occupied. */
export async function pickPort(min: number, max: number, used: Set<number>): Promise<number> {
  const span = max - min + 1;
  const start = Math.floor(Math.random() * span);
  let registryCollisions = 0;
  let busyPorts = 0;
  for (let i = 0; i < span; i++) {
    const port = min + ((start + i) % span);
    if (used.has(port)) {
      registryCollisions++;
      continue;
    }
    if (await isPortFree(port)) return port;
    busyPorts++;
  }
  throw new Error(
    `No free port found in range ${min}-${max} — ${registryCollisions} registered to other scaffolds, ${busyPorts} held by other processes. Run \`devops-cli config reset\` to clear the registry if it's stale.`,
  );
}

export interface ProjectPorts {
  server: number;
  client: number;
  /** Only set when desktop or mobile is selected. */
  nativeHmr?: number;
}

/** Pick a coherent port set for a new project, avoiding ports already
 *  assigned to prior scaffolds AND ports that are actually busy on the
 *  host. Caller is responsible for persisting the returned ports into
 *  the used-ports registry. */
export async function pickProjectPorts(
  used: number[],
  options: { nativeHmr: boolean },
): Promise<ProjectPorts> {
  const usedSet = new Set(used);
  const server = await pickPort(PORT_RANGES.server[0], PORT_RANGES.server[1], usedSet);
  usedSet.add(server);
  const client = await pickPort(PORT_RANGES.client[0], PORT_RANGES.client[1], usedSet);
  usedSet.add(client);
  const ports: ProjectPorts = { server, client };
  if (options.nativeHmr) {
    ports.nativeHmr = await pickPort(PORT_RANGES.nativeHmr[0], PORT_RANGES.nativeHmr[1], usedSet);
  }
  return ports;
}
