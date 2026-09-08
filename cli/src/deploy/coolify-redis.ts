/*
 * Provision a per-project Redis on Coolify and write REDIS_URL into the
 * project's prod env (encrypted via dotenvx).
 *
 * Why this exists at all: under the `single-origin` topology redis is
 * just another service in the project's one compose file, reachable at
 * `redis://redis:6379` on that stack's own Docker network — nothing to
 * provision. Under `split` there are TWO Coolify applications on TWO
 * networks, so a redis declared in either half's compose is invisible
 * to the other. It has to become a Coolify-managed database, which puts
 * it on the shared network and gives both halves a URL that resolves.
 *
 * Mirrors `provisionCoolifyMongo` deliberately — same server/project
 * resolution chain, same dotenvx write-through — so the two read as one
 * pattern rather than two.
 */

import { join } from "node:path";
import { set as dotenvxSet } from "@dotenvx/dotenvx";
import chalk from "chalk";
import ora from "ora";
import { getCoolifyConfig } from "../config.js";
import type { ProjectConfig } from "../prompts.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { joinProjectAppsToDatabaseNetwork } from "./coolify-db-network.js";

export interface RedisProvisionResult {
  /** Coolify uuid of the new database — recorded in the run ledger so a
   *  partial-create rollback can delete it. */
  databaseUuid: string;
  /** Connection URL usable from inside Coolify's Docker network. */
  internalUrl: string;
}

/** Provision a Redis on Coolify and bake REDIS_URL into prod env.
 *  Throws on hard failures so the caller can fall back gracefully — the
 *  user already has a working app, redis just isn't wired up. */
export async function provisionCoolifyRedis(
  config: ProjectConfig,
  serverEnvDir: string,
): Promise<RedisProvisionResult> {
  const cfg = await getCoolifyConfig();
  if (!cfg) throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });

  const setup = ora("Locating Coolify project + server").start();
  let projectUuid: string;
  let serverUuid: string;
  try {
    const project = await api.findProjectByName(config.name);
    if (!project) {
      throw new Error(`Coolify project "${config.name}" not found — did the Coolify step run?`);
    }
    projectUuid = project.uuid;

    // Same resolution chain as coolify-mongo: prefer the uuid resolved
    // up front during server selection, then IP-keyed lookup, then the
    // first server (single-server installs are the common case).
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

  const create = ora("Coolify: creating Redis container").start();
  let databaseUuid: string;
  let internalUrl: string;
  try {
    const res = await api.createRedisDatabase({
      serverUuid,
      projectUuid,
      name: `${config.name}-redis`,
      instantDeploy: true,
    });
    databaseUuid = res.uuid;
    internalUrl = res.internal_db_url ?? "";
    if (!internalUrl) {
      // Older Coolify builds omit the URL on create — follow up with a GET.
      const detail = await api.getDatabase(databaseUuid);
      internalUrl = detail.internal_db_url ?? "";
    }
    if (!internalUrl) {
      throw new Error(
        "Coolify created the database but didn't return an internal_db_url. Set REDIS_URL manually from the dashboard.",
      );
    }
    create.succeed(`Redis ready (uuid: ${databaseUuid})`);
  } catch (err) {
    create.fail();
    throw err;
  }

  // Encrypt into the project's prod env rather than pushing onto the
  // Coolify app's env directly: dotenvx +
  // DOTENV_PRIVATE_KEY_PRODUCTION (which `hatchkit keys push` already
  // sets) gives the runtime everything it needs and keeps prod secrets
  // out of Coolify's UI for everyone but the keyholder.
  const prodEnvPath = join(serverEnvDir, ".env.production");
  dotenvxSet("REDIS_URL", internalUrl, { path: prodEnvPath, encrypt: true });
  console.log(chalk.green(`  ✓ REDIS_URL encrypted into ${prodEnvPath} ${chalk.dim("(dotenvx)")}`));

  // The URL we just wrote names the DATABASE CONTAINER's hostname, and
  // that hostname only resolves on Coolify's shared `coolify` network —
  // a dockercompose app is deployed onto a network named after its own
  // uuid instead. Join the app(s) to the shared one now, or the very
  // first deploy crash-loops with `getaddrinfo ENOTFOUND <db-uuid>`
  // while Coolify reports `running:healthy`. See deploy/coolify-db-network.ts.
  await joinProjectAppsToDatabaseNetwork({
    api,
    coolifyUrl: cfg.url,
    projectName: config.name,
    topology: config.topology,
  });

  return { databaseUuid, internalUrl };
}
