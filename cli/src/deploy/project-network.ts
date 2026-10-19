/*
 * One Docker network per project.
 *
 * Coolify puts every resource on the server's first destination, the
 * shared `coolify` network, unless it is told otherwise. On dedicated-vps
 * that meant every app container, every app database AND Coolify's own
 * dashboard, Postgres and Redis on one network: any compromised app could
 * open a connection to every other project's database and to Coolify's
 * login, from inside, past Cloudflare and the host firewall. (Audit of
 * 2026-10-19, after a cryptominer got into Plausible through an
 * unauthenticated RCE. Plausible had a network of its own, which is why
 * it got no further.)
 *
 * Placement rule: a new resource joins the network its project ALREADY
 * runs on. Only a project with nothing on the server yet gets a fresh
 * `hk-<project>` network. Never split a project across networks: an app
 * on `hk-x` cannot resolve a database on `coolify`, and that failure is
 * silent — see coolify-db-network.ts for how it looked the last time.
 *
 * Coolify runs `docker network create --attachable` and connects its
 * proxy when a destination is created, so a new one is routable at once.
 * `connect_to_docker_network` on a dockercompose app joins the app's
 * DESTINATION network, so that mechanism keeps working unchanged.
 *
 * ---------------------------------------------------------------------
 * Moving a project that already runs on `coolify`
 * ---------------------------------------------------------------------
 *
 * Coolify 4.4.6 has no API for it: an application cannot get a second
 * destination on the same server, and neither apps nor databases can
 * change destination. The only in-place move is editing the
 * `destination_id` of the app and its databases in Coolify's own
 * database. Container names, volumes, env and Traefik routes stay the
 * same, so nothing else changes. One project at a time, on the host:
 *
 *   1. Create the destination (Coolify makes the network and joins the
 *      proxy to it): `POST /servers/{uuid}/destinations {"network":
 *      "hk-<project>"}`.
 *   2. `docker network connect hk-<project> <db container>` for each of
 *      the project's databases — live, no restart, so the app can reach
 *      them on either network during the move.
 *   3. Set the app's `destination_id` to the new destination and deploy
 *      it. An image app rolls, so this costs no downtime.
 *   4. Set each database's `destination_id` and restart it through
 *      Coolify: a few seconds of database downtime, after which it is on
 *      `hk-<project>` only.
 *   5. Check: the app is healthy, `docker network inspect coolify` no
 *      longer lists any of the project's containers, `hatchkit backup
 *      sources` resolves, and `hatchkit doctor` shows the network row ok.
 *
 * Rollback at any step: put the old `destination_id` back and redeploy
 * or restart. The `coolify` network is never removed.
 */

import type { CoolifyApi, CoolifyDestinationRef } from "../utils/coolify-api.js";

/** The network every Coolify resource shares by default. */
export const SHARED_NETWORK = "coolify";

/** `hk-<project>`, within Docker's and Coolify's network-name rules
 *  (`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`). */
export function projectNetworkName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 50)
    .replace(/[^a-z0-9]+$/, "");
  if (!slug) throw new Error(`Can't derive a Docker network name from project "${projectName}"`);
  return `hk-${slug}`;
}

export interface ProjectPlacement {
  uuid: string;
  network: string;
  /** `followed`: where the project already runs. `existing`: its own
   *  network was there already. `created`: made just now. */
  source: "followed" | "existing" | "created";
}

type PlacementApi = Pick<CoolifyApi, "listServerDestinations" | "createServerDestination">;
type LookupApi = Pick<CoolifyApi, "getApplication" | "listDatabases" | "getDatabase">;

/** Where the project already runs on Coolify: the destination of its
 *  first app, else of a database named the way hatchkit names them
 *  (`<project>-mongo`, `-postgres`, `-redis`). Null for a new project.
 *  Read errors count as "nothing found" — the caller then places the
 *  resource on the project's own network, which is the safe default for
 *  a project with nothing reachable. */
export async function findProjectDestination(
  api: LookupApi,
  args: { projectName: string; appUuids: string[] },
): Promise<CoolifyDestinationRef | null> {
  for (const uuid of args.appUuids) {
    try {
      const dest = (await api.getApplication(uuid)).destination;
      if (dest) return dest;
    } catch {
      // try the next one
    }
  }
  let databases: Array<{ uuid: string; name: string }> = [];
  try {
    databases = await api.listDatabases();
  } catch {
    return null;
  }
  const prefix = `${args.projectName}-`;
  for (const db of databases.filter((d) => d.name.startsWith(prefix))) {
    try {
      const dest = (await api.getDatabase(db.uuid)).destination;
      if (dest) return dest;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The destination a new resource of `projectName` must be created in.
 *  `follow` is where the project already runs ({@link findProjectDestination});
 *  it wins whenever it names a destination on this server. */
export async function resolveProjectDestination(
  api: PlacementApi,
  args: { serverUuid: string; projectName: string; follow?: CoolifyDestinationRef | null },
): Promise<ProjectPlacement> {
  const { serverUuid, projectName, follow } = args;
  const destinations = await api.listServerDestinations(serverUuid);
  if (follow) {
    const match = destinations.find(
      (d) =>
        (follow.uuid && d.uuid === follow.uuid) || (follow.network && d.network === follow.network),
    );
    if (match) return { uuid: match.uuid, network: match.network, source: "followed" };
  }
  const network = projectNetworkName(projectName);
  const existing = destinations.find((d) => d.network === network);
  if (existing) return { uuid: existing.uuid, network, source: "existing" };
  const created = await api.createServerDestination(serverUuid, network, network);
  return { uuid: created.uuid, network: created.network, source: "created" };
}

/** {@link findProjectDestination} + {@link resolveProjectDestination},
 *  never throwing: a Coolify without the destinations API (before 4.x)
 *  gets `undefined`, which means "Coolify's default" — the old
 *  behaviour — and a line saying so. */
export async function placeProjectResource(
  api: PlacementApi & LookupApi,
  args: { serverUuid: string; projectName: string; appUuids: string[] },
): Promise<{ placement?: ProjectPlacement; note: string }> {
  try {
    const follow = await findProjectDestination(api, args);
    const placement = await resolveProjectDestination(api, { ...args, follow });
    return { placement, note: describePlacement(placement) };
  } catch (err) {
    return {
      note:
        `couldn't choose a project network (${(err as Error).message.split("\n")[0]}); ` +
        `Coolify puts it on its default network`,
    };
  }
}

export function describePlacement(p: ProjectPlacement): string {
  if (p.source === "followed" && p.network === SHARED_NETWORK) {
    return `on the shared \`${SHARED_NETWORK}\` network, where the rest of the project runs`;
  }
  if (p.source === "created") return `on its own network \`${p.network}\` (created)`;
  return `on the project's network \`${p.network}\``;
}
