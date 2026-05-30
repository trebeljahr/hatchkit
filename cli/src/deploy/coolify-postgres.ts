/*
 * Provision a per-project Postgres on Coolify and write the connection
 * URL into the project's prod env (encrypted via dotenvx).
 *
 * Why per-project: shared databases couple unrelated projects' failure
 * domains, name-collide on database names, and force coordinated
 * password rotations. Coolify Postgres containers idle cheap; the
 * isolation pays off the first time something goes wrong with one app
 * that you don't want spreading.
 *
 * Mirrors the Mongo path in `coolify-mongo.ts` — see comments there for
 * the project/server resolution and dotenvx encryption rationale.
 */

import { join } from "node:path";
import { set as dotenvxSet } from "@dotenvx/dotenvx";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { CoolifyApi } from "../utils/coolify-api.js";

export interface PostgresProvisionResult {
  /** Coolify uuid of the new database — useful for later teardown. */
  databaseUuid: string;
  /** Connection URL usable from inside Coolify's Docker network. */
  internalUrl: string;
}

/** Provision a Postgres on Coolify and bake the URL into prod env.
 *  Throws on hard failures so the caller can fall back gracefully —
 *  the user already has a working app, Postgres just isn't wired up. */
export async function provisionCoolifyPostgres(
  config: ProjectConfig,
  serverEnvDir: string,
): Promise<PostgresProvisionResult> {
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

  const create = ora("Coolify: creating Postgres container (this takes ~30s)").start();
  let databaseUuid: string;
  let internalUrl: string;
  try {
    const res = await api.createPostgresqlDatabase({
      serverUuid,
      projectUuid,
      // Use the project name as the db name — matches what the starter's
      // local docker-compose Postgres would call it, so dev↔prod schemas
      // line up with no surprises.
      name: `${config.name}-postgres`,
      postgresDb: config.name.replace(/-/g, "_"),
      instantDeploy: true,
    });
    databaseUuid = res.uuid;
    internalUrl = res.internal_db_url ?? "";
    if (!internalUrl) {
      const detail = await api.getDatabase(databaseUuid);
      internalUrl = detail.internal_db_url ?? "";
    }
    if (!internalUrl) {
      throw new Error(
        "Coolify created the database but didn't return an internal_db_url. Set POSTGRES_URL manually from the dashboard.",
      );
    }
    create.succeed(`Postgres ready (uuid: ${databaseUuid})`);
  } catch (err) {
    create.fail();
    throw err;
  }

  const prodEnvPath = join(serverEnvDir, ".env.production");
  dotenvxSet("POSTGRES_URL", internalUrl, { path: prodEnvPath, encrypt: true });
  console.log(
    chalk.green(`  ✓ POSTGRES_URL encrypted into ${prodEnvPath} ${chalk.dim("(dotenvx)")}`),
  );

  return { databaseUuid, internalUrl };
}
