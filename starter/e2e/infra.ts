import { randomUUID } from "node:crypto";

/*
 * This project's local e2e stack: the container names and every port the
 * browser suite uses, in one place.
 *
 * Several projects (and several agent sessions) run their e2e suites on one
 * machine at once. With one global set of names and ports, a run would reuse
 * another project's database container — and test against its data — or a
 * teardown would remove a container another run was still using. So
 * `hatchkit create` writes this project's own values here: the stack name from
 * the project name, the ports derived from the dev ports it assigned the
 * project. Every e2e file reads them from this module; playwright.config.ts
 * hands them to e2e/start-server.sh.
 *
 * A second checkout of the same project (a worktree) shares these values, so
 * two runs of one project at once still meet on the same ports. Give the
 * second one its own with the environment: E2E_STACK, E2E_SERVER_PORT,
 * E2E_CLIENT_PORT, E2E_MONGO_PORT, E2E_REDIS_PORT, E2E_S3_PORT,
 * E2E_POSTGRES_PORT.
 *
 * A port another program already holds makes `docker run` fail with "port is
 * already allocated", and the run stops there instead of testing against it.
 */

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a port number, got "${raw}"`);
  }
  return value;
}

/** Prefix of every container name: `<stack>-mongo`, `<stack>-redis`, … */
export const E2E_STACK = process.env.E2E_STACK || "starter-e2e";

export const E2E_PORTS = {
  /** The API under test. */
  server: port("E2E_SERVER_PORT", 5006),
  /** The web client under test. */
  client: port("E2E_CLIENT_PORT", 3001),
  mongo: port("E2E_MONGO_PORT", 27018),
  redis: port("E2E_REDIS_PORT", 6380),
  s3: port("E2E_S3_PORT", 9002),
  postgres: port("E2E_POSTGRES_PORT", 5433),
} as const;

/** Docker label on every container e2e/start-server.sh starts. Its value is
 *  the run's id, and e2e/global-teardown.ts removes exactly the containers
 *  carrying this run's value — never one an earlier or parallel run started. */
export const E2E_RUN_LABEL = "dev.hatchkit.e2e-run";

/** This run's id. Set once in the Playwright runner process; workers and the
 *  web servers inherit it through the environment, so every reader agrees. */
export const E2E_RUN_ID = (process.env.E2E_RUN_ID ||= randomUUID());

/** The environment e2e/start-server.sh reads its names and ports from. */
export function e2eStackEnv(): Record<string, string> {
  return {
    E2E_STACK,
    E2E_RUN_LABEL,
    E2E_RUN_ID,
    E2E_MONGO_PORT: String(E2E_PORTS.mongo),
    E2E_REDIS_PORT: String(E2E_PORTS.redis),
    E2E_S3_PORT: String(E2E_PORTS.s3),
    E2E_POSTGRES_PORT: String(E2E_PORTS.postgres),
  };
}
