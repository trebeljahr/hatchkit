/*
 * Each project's own local e2e stack: container names and ports.
 *
 * The starter's browser suite starts MongoDB, Redis and SeaweedFS containers
 * locally (`e2e/start-server.sh`) and serves the API and web client under test
 * on two more ports. With one global set — `starter-e2e-mongo` on 27018 and so
 * on — two projects on one machine meet in the same containers: a run reuses
 * another project's database and tests against its data, and a teardown by
 * name removes a container another run is still using. Several projects and
 * agent sessions run their suites at once, so that is the normal case.
 *
 * The starter keeps every name and port in `e2e/infra.ts`. `create` writes the
 * project's values there: the stack name comes from the project name (the
 * `starter-e2e` → `<name>-e2e` pass in `applyProjectName`), and the ports are
 * derived here from the dev ports the project was assigned. Those are unique
 * across scaffolds on this machine (the CLI's used-ports registry), so the
 * derived ports are too, without a registry of their own.
 *
 * The CI e2e job runs alone on its runner, so its service containers keep the
 * starter's fixed ports and the job hands the server their addresses. The one
 * exception is SeaweedFS: playwright.config.ts owns the S3 endpoint for that
 * job, so the CI step publishes the project's own S3 port.
 */

import { join } from "node:path";
import { PORT_RANGES, type ProjectPorts } from "../utils/ports.js";
import { rewriteFile } from "./starter-files.js";

export const E2E_INFRA_REL_PATH = "e2e/infra.ts";

export interface E2ePorts {
  server: number;
  client: number;
  mongo: number;
  redis: number;
  s3: number;
  postgres: number;
}

/** The starter's own values, which `e2e/infra.ts` ships with and the CI
 *  workflow publishes its service containers on. */
export const STARTER_E2E_PORTS: E2ePorts = {
  server: 5006,
  client: 3001,
  mongo: 27018,
  redis: 6380,
  s3: 9002,
  postgres: 5433,
};

/** Position of `port` in its 1000-wide range, 0–999. */
function slot(port: number, rangeStart: number): number {
  return (((port - rangeStart) % 1000) + 1000) % 1000;
}

/**
 * A project's e2e ports, from the dev ports `create` assigned it.
 *
 *   server    15000–15999   dev server port + 10000
 *   client    16000–16999   dev client port + 10000
 *   mongo     17000–17999   ┐
 *   redis     18000–18999   │ 1000 × n + the server port's slot
 *   s3        19000–19999   │
 *   postgres  20000–20999   ┘
 *
 * Every range sits below 32768, where Linux starts handing out ephemeral
 * source ports, so a CI runner's own outbound connections never hold one.
 */
export function e2ePortsFor(ports: Pick<ProjectPorts, "server" | "client">): E2ePorts {
  const server = slot(ports.server, PORT_RANGES.server[0]);
  const client = slot(ports.client, PORT_RANGES.client[0]);
  return {
    server: 15_000 + server,
    client: 16_000 + client,
    mongo: 17_000 + server,
    redis: 18_000 + server,
    s3: 19_000 + server,
    postgres: 20_000 + server,
  };
}

const PORT_ENV: Record<keyof E2ePorts, string> = {
  server: "E2E_SERVER_PORT",
  client: "E2E_CLIENT_PORT",
  mongo: "E2E_MONGO_PORT",
  redis: "E2E_REDIS_PORT",
  s3: "E2E_S3_PORT",
  postgres: "E2E_POSTGRES_PORT",
};

/** `e2e/infra.ts` with its default ports set to `e2e`. Idempotent. */
export function setE2eInfraPorts(content: string, e2e: E2ePorts): string {
  let out = content;
  for (const [key, env] of Object.entries(PORT_ENV) as Array<[keyof E2ePorts, string]>) {
    out = out.replace(new RegExp(`port\\("${env}", \\d+\\)`), `port("${env}", ${e2e[key]})`);
  }
  return out;
}

/** The default ports an `e2e/infra.ts` declares, or null for a file that is
 *  not the starter's shape. */
export function readE2eInfraPorts(content: string): E2ePorts | null {
  const out: Partial<E2ePorts> = {};
  for (const [key, env] of Object.entries(PORT_ENV) as Array<[keyof E2ePorts, string]>) {
    const m = new RegExp(`port\\("${env}", (\\d+)\\)`).exec(content);
    if (!m) return null;
    out[key] = Number(m[1]);
  }
  return out as E2ePorts;
}

/** The deploy workflow's e2e job, pointed at the project's ports where the
 *  job does not supply them: the SeaweedFS step (playwright.config.ts owns the
 *  S3 endpoint) and the two origins the job env names. Idempotent. */
export function setWorkflowE2ePorts(content: string, e2e: E2ePorts): string {
  return content
    .replace(/(docker run -d --name e2e-seaweedfs -p )\d+(:8333)/, `$1${e2e.s3}$2`)
    .replace(/(curl -sf -o \/dev\/null http:\/\/127\.0\.0\.1:)\d+(\/)/, `$1${e2e.s3}$2`)
    .replace(/^( +BETTER_AUTH_URL: http:\/\/127\.0\.0\.1:)\d+$/m, `$1${e2e.server}`)
    .replace(/^( +FRONTEND_URL: http:\/\/127\.0\.0\.1:)\d+$/m, `$1${e2e.client}`);
}

/** `hatchkit create`: write the project's e2e ports. The stack name is
 *  already the project's (applyProjectName). No-op for a surface whose prune
 *  removed the e2e suite. */
export function applyE2eStack(
  outputDir: string,
  ports: Pick<ProjectPorts, "server" | "client">,
  modifications: string[],
): E2ePorts {
  const e2e = e2ePortsFor(ports);
  rewriteFile(join(outputDir, E2E_INFRA_REL_PATH), (c) => setE2eInfraPorts(c, e2e));
  rewriteFile(join(outputDir, ".github/workflows/build-and-deploy.yml"), (c) =>
    setWorkflowE2ePorts(c, e2e),
  );
  modifications.push(
    `e2e ports: server=${e2e.server} client=${e2e.client} mongo=${e2e.mongo} redis=${e2e.redis} s3=${e2e.s3}`,
  );
  return e2e;
}
