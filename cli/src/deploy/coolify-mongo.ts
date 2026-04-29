/*
 * Provision a per-project MongoDB on Coolify and write the connection
 * URL into the project's prod env (encrypted via dotenvx).
 *
 * Why per-project: shared databases couple unrelated projects' failure
 * domains, name-collide on database names, and force coordinated
 * password rotations. Coolify Mongo containers idle cheap; the
 * isolation pays off the first time something goes wrong with one app
 * that you don't want spreading.
 *
 * Flow:
 *   1. Resolve the Coolify project_uuid (it was created by
 *      `runCoolifySetup` with the project name).
 *   2. Resolve the server_uuid by IP (Hetzner deploys carry the IP)
 *      or fall back to the first listed server.
 *   3. POST /databases/mongodb with `instant_deploy: true`.
 *   4. Read `internal_db_url` from the response (or follow up with
 *      GET /databases/{uuid} on older builds that omit it).
 *   5. Encrypt the URL into `<server-env-dir>/.env.production` via
 *      dotenvx, mirroring how the rest of `hatchkit add` writes prod
 *      values.
 */

import { join } from "node:path";
import { set as dotenvxSet } from "@dotenvx/dotenvx";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { CoolifyApi } from "../utils/coolify-api.js";

export interface MongoProvisionResult {
  /** Coolify uuid of the new database — useful for later teardown. */
  databaseUuid: string;
  /** Connection URL usable from inside Coolify's Docker network. */
  internalUrl: string;
}

/** Provision a MongoDB on Coolify and bake the URL into prod env.
 *  Throws on hard failures so the caller can fall back gracefully —
 *  the user already has a working app, MongoDB just isn't wired up. */
export async function provisionCoolifyMongo(
  config: ProjectConfig,
  serverEnvDir: string,
): Promise<MongoProvisionResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");

  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  const setup = ora("Locating Coolify project + server").start();
  let projectUuid: string;
  let serverUuid: string;
  try {
    const project = await api.findProjectByName(config.name);
    if (!project) {
      throw new Error(`Coolify project "${config.name}" not found — did the stack script run?`);
    }
    projectUuid = project.uuid;

    let server: { uuid: string; name: string; ip: string } | null = null;
    // Prefer the uuid we resolved up front during server selection
    // (`hatchkit create` populates `config.serverUuid` after picking
    // an existing Coolify server). Falls back to IP- / name-keyed
    // lookups for the new-Hetzner path, where the uuid only exists
    // after Terraform creates the server and we never re-prompt.
    if (config.serverUuid) {
      const servers = await api.listServers();
      const cached = servers.find((s) => s.id === config.serverId) ?? servers[0];
      server = cached
        ? { uuid: config.serverUuid, name: cached.name, ip: cached.ip }
        : { uuid: config.serverUuid, name: "(server)", ip: config.serverIp ?? "" };
    }
    if (!server && config.serverIp) {
      server = await api.findServer({ ip: config.serverIp });
    }
    if (!server) {
      // Fall back to the first server. Single-server Hetzner deploys
      // are the common case, and the alternative is the user picking
      // a uuid we have no good way to surface.
      const servers = await api.listServers();
      const first = servers[0];
      if (!first) throw new Error("No Coolify servers configured.");
      server = await api.findServer({ name: first.name });
      if (!server) throw new Error(`Couldn't resolve server uuid for "${first.name}".`);
    }
    serverUuid = server.uuid;
    setup.succeed(
      `Coolify project ${chalk.cyan(config.name)} on server ${chalk.cyan(server.name)}`,
    );
  } catch (err) {
    setup.fail();
    throw err;
  }

  const create = ora("Coolify: creating MongoDB container (this takes ~30s)").start();
  let databaseUuid: string;
  let internalUrl: string;
  try {
    const res = await api.createMongodbDatabase({
      serverUuid,
      projectUuid,
      // Use the project name as the db name — matches what the starter's
      // local docker-compose Mongo would call it, so dev↔prod schemas
      // line up with no surprises.
      name: `${config.name}-mongo`,
      initdbDatabase: config.name.replace(/-/g, "_"),
      instantDeploy: true,
    });
    databaseUuid = res.uuid;
    internalUrl = res.internal_db_url ?? "";
    if (!internalUrl) {
      // Older Coolify builds: follow up with GET to read the URL.
      const detail = await api.getDatabase(databaseUuid);
      internalUrl = detail.internal_db_url ?? "";
    }
    if (!internalUrl) {
      throw new Error(
        "Coolify created the database but didn't return an internal_db_url. Set MONGODB_URI manually from the dashboard.",
      );
    }
    create.succeed(`MongoDB ready (uuid: ${databaseUuid})`);
  } catch (err) {
    create.fail();
    throw err;
  }

  // Encrypt the URL into the project's prod env so it's commit-safe.
  // We don't push it onto the Coolify app's env directly — dotenvx +
  // DOTENV_PRIVATE_KEY_PRODUCTION (which `hatchkit keys push` already
  // sets) gives the runtime everything it needs and keeps prod secrets
  // out of Coolify's UI for everyone-but-the-keyholder.
  const prodEnvPath = join(serverEnvDir, ".env.production");
  dotenvxSet("MONGODB_URI", internalUrl, { path: prodEnvPath, encrypt: true });
  console.log(
    chalk.green(`  ✓ MONGODB_URI encrypted into ${prodEnvPath} ${chalk.dim("(dotenvx)")}`),
  );

  return { databaseUuid, internalUrl };
}
